#!/usr/bin/env python3
"""Reproducible, bounded Jev experiment. No trading/order endpoints are used.

prepare freezes samples before inference; run caches each successful answer;
score evaluates only after predictions have been written to disk.
"""
from __future__ import annotations

import argparse
import bisect
import csv
import hashlib
import json
import os
from pathlib import Path
import random
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from jev_backtest import PLANS, FEE, SLIPPAGE, NOTIONAL, CAPITAL, HOLD, ENTRY_DELAY, atr, ema, exit_candidates, simulate, classification, trading_metrics

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / 'docs/research/jev-evaluation-2026-09-21/run'
BINANCE = 'https://fapi.binance.com'
DECISIONS = 'https://openrouter.ai/api/alpha/decisions'
MODEL = '~typesafe/jev-latest'
SEED = 20260921
MAX_REQUESTS = 50
MAX_COST = 0.25
MINUTE = 60000
DAY = 86400000


def iso(ms):
    return datetime.fromtimestamp(ms/1000, timezone.utc).isoformat().replace('+00:00','Z')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n')
    temp.replace(path)


def read_json(path):
    return json.loads(path.read_text())


def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                name,value = line.split('=',1)
                values[name.strip()] = value.strip().strip('\"\'')
    return values


def private_settings():
    values = read_env(ROOT/'.env.openrouter.local')
    return {**values, **{k:v for k,v in os.environ.items() if k in ('OPENROUTER_API_KEY','JEV_MODEL')}}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Unexpected redirect refused')


def opener():
    # Existing project proxy only. Binance credentials are never used here.
    env = {**read_env(ROOT/'.env.local'), **os.environ}
    proxies = {scheme: env.get(scheme+'_proxy') or env.get(scheme.upper()+'_PROXY') for scheme in ('http','https')}
    return urllib.request.build_opener(urllib.request.ProxyHandler({k:v for k,v in proxies.items() if v}), NoRedirect())


def redact(message):
    message = re.sub(r'sk-or-v1-[A-Za-z0-9_-]+','[REDACTED]',str(message))
    secret = private_settings().get('OPENROUTER_API_KEY')
    return message.replace(secret,'[REDACTED]') if secret else message


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(redact(message)[:600])


def request(url, payload=None, key=None):
    headers = {'Accept':'application/json','User-Agent':'TVCHART-Research/1.0'}
    if key:
        if url != DECISIONS:
            raise RuntimeError('Credential destination rejected')
        headers['Authorization'] = 'Bearer '+key
    body = canonical(payload).encode() if payload is not None else None
    if body is not None:
        headers['Content-Type'] = 'application/json'
    try:
        with opener().open(urllib.request.Request(url,data=body,headers=headers),timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        message = error.read(4000).decode(errors='replace')
        raise APIError(error.code,message) from None
    except Exception as error:
        raise APIError(0,type(error).__name__+': '+redact(error)) from None


def get(path, **query):
    url = BINANCE+path+('?' + urllib.parse.urlencode(query) if query else '')
    for attempt in range(3):
        try:
            return request(url)
        except APIError as error:
            if attempt==2 or error.status not in (0,429,500,502,503,504):
                raise
            time.sleep(1+attempt)


def load_rows(endpoint, symbol, interval, period, start, end):
    output, cursor = [], start
    while cursor < end:
        rows = get(endpoint,symbol=symbol,interval=interval,startTime=cursor,endTime=end-1,limit=1000)
        if not isinstance(rows,list) or not rows:
            raise RuntimeError(f'{symbol} {interval}: missing historical page')
        batch = [[int(r[0]),*map(float,r[1:6])] for r in rows if start<=int(r[0])<end and int(r[6])<end]
        if not batch or batch[0][0]!=cursor:
            raise RuntimeError(f'{symbol} {interval}: first candle missing')
        output.extend(batch)
        cursor = batch[-1][0]+period
    for i,b in enumerate(output):
        if b[2]<max(b[1],b[4]) or b[3]>min(b[1],b[4]) or b[3]<=0 or b[5]<0 or i and b[0]-output[i-1][0]!=period:
            raise RuntimeError('Invalid OHLCV or history gap')
    if output[-1][0]+period!=end:
        raise RuntimeError('Incomplete history tail')
    return output


def contract_info(info, symbol):
    row = next(item for item in info['symbols'] if item['symbol']==symbol)
    if row['contractType']!='PERPETUAL' or row['quoteAsset']!='USDT' or row['status']!='TRADING':
        raise RuntimeError('Not a tradable USDT perpetual')
    filters = {f['filterType']:f for f in row['filters']}
    lot, market = filters['LOT_SIZE'],filters['MARKET_LOT_SIZE']
    return {'symbol':symbol,'tick_size':float(filters['PRICE_FILTER']['tickSize']), 'min_qty':float(lot['minQty']), 'max_qty':float(lot['maxQty']), 'step_size':float(lot['stepSize']),
            'market_min':float(market['minQty']),'market_max':float(market['maxQty']),'market_step':float(market['stepSize']),
            'min_notional':float(filters['MIN_NOTIONAL']['notional'])}


def questions():
    return {
        'buy_now': {'type':'choice','instructions': 'Using ONLY state.ohlcv, decide whether to open a LONG trade under state.exit_plans.B and state.execution. This is a prediction made before any future candle is known. Account for the stated costs. Do not assume a long is required. Evaluate the available price/volume structure and whether its expected net outcome is favorable.',
                    'criteria': {'BUY':'A long using reference plan B has a favorable expected net outcome after costs; enter after the specified delay.', 'WAIT':'The evidence does not justify entering the reference long now, or its expected outcome after costs is unfavorable or uncertain.'}},
        'exit_plan': {'type':'choice','instructions': 'Conditional on opening a LONG after the specified delay, which exact candidate in state.exit_plans best fits the observed OHLCV price structure, target reachability, stop protection and 12-bar holding horizon? Select one plan without seeing future bars. This question does not require a BUY answer to any other question.',
                      'criteria': {k:f'Use the exact take_profit and stop_loss prices in state.exit_plans.{k}; target distance {tp:g} ATR and stop distance {sl:g} ATR.' for k,(tp,sl) in PLANS.items()}},
        'reference_profitable': {'type':'noul','instructions': 'Will a LONG executed according to state.execution with state.exit_plans.B finish with strictly positive net P&L after fees, adverse slippage and any funding, within the 12 held candles? Infer from the observed OHLCV only; the future is unobserved.',
                                'criteria': {'true':'Reference plan B finishes with positive net P&L.', 'false':'Reference plan B finishes flat or with negative net P&L.'}}
    }


def payload_for(case):
    # Explicit allowlist. No case ID, symbol, UTC date, mark/funding future or
    # evaluation outcome can flow into a model request.
    return {'model':MODEL,'state':{
        'instrument':'anonymous USDT-margined perpetual','timeframe_minutes':case['period_ms']//MINUTE,'window_bars':case['window'],
        'ohlcv':{'columns':['relative_bar','open','high','low','close','volume'],'rows':[[i,*bar[1:]] for i,bar in enumerate(case['history'])]},
        'last_observed_close':case['history'][-1][4],'atr14':case['atr14'],'exit_plans':case['plans'],
        'execution':{'side':'LONG only','entry':'Skip one full future candle, then enter at the next candle open, plus adverse slippage. Future entry price is not yet known.',
            'max_holding_bars':HOLD,'fee_each_side_bps':FEE*10000,'adverse_slippage_each_side_bps':SLIPPAGE*10000,'funding':'Future funding is unknown; realized funding will be charged in evaluation.',
            'gap_policy':'Do not enter if entry price is not strictly between the chosen stop and target.', 'same_bar_target_and_stop':'Assume stop is hit first.','timeout_exit':'Exit at the last held candle close, less adverse slippage.'}},'questions':questions()}


def prepare(out):
    if (out/'manifest.json').exists():
        print('Using frozen manifest; no resampling.',flush=True)
        return
    out.mkdir(parents=True,exist_ok=True)
    clock=get('/fapi/v1/time')['serverTime']
    end=int(clock)//(15*MINUTE)*(15*MINUTE)
    info=get('/fapi/v1/exchangeInfo')
    data, contracts, funding = {},{},{}
    for symbol in ('BTCUSDT','ETHUSDT'):
        contracts[symbol]=contract_info(info,symbol)
        rates=get('/fapi/v1/fundingRate',symbol=symbol,startTime=end-17*DAY,endTime=end-1,limit=1000)
        if not isinstance(rates,list) or not rates or any(not r.get('markPrice') or float(r['markPrice'])<=0 for r in rates):
            raise RuntimeError('Funding history or event mark prices unavailable')
        if int(rates[0]['fundingTime'])>end-16*DAY or end-int(rates[-1]['fundingTime'])>DAY:
            raise RuntimeError('Funding history coverage incomplete')
        funding[symbol]=rates
        write_json(out/'market-data'/f'{symbol}-funding.json',rates)
        for interval,period in [('5m',5*MINUTE),('15m',15*MINUTE)]:
            start=(end-14*DAY-122*period)//period*period
            print(f'Fetching {symbol} {interval}: OHLCV and mark candles',flush=True)
            bars=load_rows('/fapi/v1/klines',symbol,interval,period,start,end)
            marks=load_rows('/fapi/v1/markPriceKlines',symbol,interval,period,start,end)
            data[(symbol,interval)]={'bars':bars,'marks':{b[0]:b[4] for b in marks}}
            write_json(out/'market-data'/f'{symbol}-{interval}.json',{'bars':bars,'mark_closes':[[b[0],b[4]] for b in marks],'sha256':digest(bars)})
    cases=[]
    first=end-14*DAY
    last=end-(HOLD+ENTRY_DELAY+2)*15*MINUTE
    for sindex,symbol in enumerate(('BTCUSDT','ETHUSDT')):
        rng=random.Random(SEED+sindex)
        modes=[(tf,n) for tf in ('5m','15m') for n in (60,120) for _ in range(5)]
        rng.shuffle(modes)
        span=(last-first)/len(modes)
        for index,(interval,window) in enumerate(modes):
            period=int(interval[:-1])*MINUTE
            anchor=int(first+(index+rng.uniform(.2,.8))*span)//period*period
            rows=data[(symbol,interval)]['bars']
            at=bisect.bisect_left([r[0] for r in rows],anchor)
            if rows[at][0]!=anchor:raise RuntimeError('Anchor missing')
            history=rows[at-window+1:at+1]
            future=rows[at+1:at+1+HOLD+ENTRY_DELAY]
            if len(history)!=window or len(future)!=HOLD+ENTRY_DELAY:raise RuntimeError('Case coverage incomplete')
            case={'id':f'{symbol}-{interval}-w{window}-{index+1:02d}','symbol':symbol,'interval':interval,'window':window,'period_ms':period,
                  'decision_time':anchor+period-1,'history':history,'future':future,'contract':contracts[symbol], 'decision_mark':data[(symbol,interval)]['marks'][anchor],
                  'funding':[r for r in funding[symbol] if anchor<int(r['fundingTime'])<=future[-1][0]+period-1], 'atr14':atr(history),
                  'plans':exit_candidates(history,contracts[symbol]['tick_size'])}
            case['history_sha256']=digest(history)
            case['request_sha256']=digest(payload_for(case))
            cases.append(case)
    cases.sort(key=lambda c:c['decision_time'])
    for symbol in contracts:
        previous_end=-1
        for case in [c for c in cases if c['symbol']==symbol]:
            if case['future'][ENTRY_DELAY][0]<=previous_end:raise RuntimeError('Overlapping trade horizons')
            previous_end=case['future'][-1][0]+case['period_ms']-1
    write_json(out/'cases.json',cases)
    for case in cases:write_json(out/'requests'/f"{case['id']}.json",payload_for(case))
    protocol=(out.parent/'protocol.md').read_text()
    manifest={'protocol_version':1,'prepared_at':iso(int(time.time()*1000)),'exchange_time':iso(clock),'closed_data_end':iso(end),'seed':SEED,'model_requested':MODEL,
              'case_count':len(cases),'cases_sha256':digest(cases),'questions_sha256':digest(questions()),'protocol_sha256':hashlib.sha256(protocol.encode()).hexdigest(),
              'periods':['5m','15m'],'windows':[60,120],'contracts':contracts,'limits':{'max_requests':MAX_REQUESTS,'max_cost_usd':MAX_COST},
              'samples':[{k:c[k] for k in ('id','symbol','interval','window','decision_time','history_sha256','request_sha256')} for c in cases]}
    write_json(out/'manifest.json',manifest)
    print(f"Frozen {len(cases)} samples, {iso(cases[0]['decision_time'])} to {iso(cases[-1]['decision_time'])}; hash {manifest['cases_sha256'][:16]}",flush=True)


def valid_answer(value):
    if not isinstance(value,dict) or not isinstance(value.get('answers'),dict):return False
    answers=value['answers']
    if answers.get('buy_now',{}).get('choice') not in ('BUY','WAIT') or answers.get('exit_plan',{}).get('choice') not in PLANS:return False
    probability=answers.get('reference_profitable',{}).get('noul')
    return isinstance(probability,(int,float)) and not isinstance(probability,bool) and 0<=probability<=1 and bool(value.get('model'))


def run(out, max_cases=None):
    cases=read_json(out/'cases.json');manifest=read_json(out/'manifest.json')
    if digest(cases)!=manifest['cases_sha256']:raise RuntimeError('Frozen cases changed')
    if digest(questions())!=manifest['questions_sha256']:raise RuntimeError('Frozen prompt changed')
    key=private_settings().get('OPENROUTER_API_KEY')
    if not key:raise RuntimeError('OPENROUTER_API_KEY is not configured')
    ledger_path=out/'api-attempts.jsonl'
    ledger=[json.loads(line) for line in ledger_path.read_text().splitlines()] if ledger_path.exists() else []
    model_pin=None;completed=0
    for path in sorted((out/'responses').glob('*.json')) if (out/'responses').exists() else []:
        cached=read_json(path)
        if valid_answer(cached['response']):
            actual=cached['response']['model']
            if model_pin and actual!=model_pin:raise RuntimeError('Mixed model versions')
            model_pin=actual
    for case in cases:
        target=out/'responses'/f"{case['id']}.json"
        if target.exists():
            cached=read_json(target)
            if cached['request_sha256']!=case['request_sha256'] or not valid_answer(cached['response']):raise RuntimeError('Invalid cached answer; refusing selective rerun')
            continue
        if max_cases is not None and completed>=max_cases:break
        payload=read_json(out/'requests'/f"{case['id']}.json")
        if digest(payload)!=case['request_sha256']:raise RuntimeError('Request changed')
        for retry in range(3):
            if len(ledger)>=MAX_REQUESTS or sum(a.get('cost',0) for a in ledger)>=MAX_COST:raise RuntimeError('Predeclared API budget exhausted')
            start=time.monotonic();attempt={'case_id':case['id'],'started_at':iso(int(time.time()*1000)),'request_sha256':case['request_sha256'],'attempt':len(ledger)+1}
            try:
                response=request(DECISIONS,payload,key)
                elapsed=time.monotonic()-start
                if not valid_answer(response):
                    write_json(out/'invalid-responses'/f"{case['id']}.json",response)
                    raise APIError(422,'Response does not match the required typed contract; saved for inspection')
                actual=response['model'];cost=float(response.get('usage',{}).get('cost') or 0)
                attempt.update(status=200,latency_seconds=elapsed,cost=cost,model=actual)
                write_json(target,{'case_id':case['id'],'request_sha256':case['request_sha256'],'latency_seconds':elapsed,'response':response})
                if model_pin is not None and actual!=model_pin:raise APIError(409,'Resolved model version changed; stop comparing mixed versions')
                model_pin=actual;completed+=1
                print(f"[{sum(1 for _ in (out/'responses').glob('*.json'))}/40] {case['id']}: {response['answers']['buy_now']['choice']}, exit {response['answers']['exit_plan']['choice']}, {elapsed:.2f}s, ${cost:.6f}",flush=True)
            except APIError as error:
                attempt.update(status=error.status,latency_seconds=time.monotonic()-start,error=str(error))
                print(f"API {error.status}: {str(error)[:200]}",flush=True)
                if retry==2 or error.status not in (0,429,500,502,503,504,524,529):raise
            finally:
                ledger.append(attempt)
                with ledger_path.open('a') as file:file.write(canonical(attempt)+'\n')
            if attempt['status']==200:break
            time.sleep(2**retry)


def score(out):
    cases=read_json(out/'cases.json');rows=[];skipped=[]
    attempts=[json.loads(line) for line in (out/'api-attempts.jsonl').read_text().splitlines()]
    for case in cases:
        path=out/'responses'/f"{case['id']}.json"
        if not path.exists():
            skipped.append({'id':case['id'],'reason':'no_valid_model_response'});continue
        cached=read_json(path);answers=cached['response']['answers']
        calls=[a for a in attempts if a['case_id']==case['id']]
        first=datetime.fromisoformat(calls[0]['started_at'].replace('Z','+00:00')).timestamp()
        last=datetime.fromisoformat(calls[-1]['started_at'].replace('Z','+00:00')).timestamp()+calls[-1]['latency_seconds']
        available_after=last-first
        if available_after*1000>case['period_ms']:
            skipped.append({'id':case['id'],'reason':'latency_exceeds_execution_allowance'});continue
        reference=simulate(case,'B');chosen=simulate(case,answers['exit_plan']['choice'])
        optimistic=simulate(case,answers['exit_plan']['choice'],target_first=True)
        closes=[b[4] for b in case['history']]
        rows.append({'case_id':case['id'],'symbol':case['symbol'],'interval':case['interval'],'window':case['window'],'decision_time':case['decision_time'],
                     'buy':answers['buy_now']['choice']=='BUY','buy_confidence':answers['buy_now'].get('confidence'), 'p_profitable':answers['reference_profitable']['noul'],
                     'exit_plan':answers['exit_plan']['choice'],'planned_exit':case['plans'][answers['exit_plan']['choice']],'ema_buy':ema(closes,10)>sum(closes[-60:])/60,'actual_profitable':reference.get('net_pnl',0)>0 if reference['valid'] else None,
                     'reference':reference,'chosen':chosen,'chosen_target_first':optimistic,'model':cached['response']['model'],'latency_seconds':cached['latency_seconds'],
                     'available_after_seconds':available_after,'input_tokens':cached['response'].get('usage',{}).get('input_tokens'),'api_cost':cached['response'].get('usage',{}).get('cost',0)})
    valid=[r for r in rows if r['actual_profitable'] is not None]
    actual=[r['actual_profitable'] for r in valid]
    metrics={k:classification(pred,actual) for k,pred in {'jev':[r['buy'] for r in valid],'always_wait':[False]*len(valid),'always_buy':[True]*len(valid),'ema_rule':[r['ema_buy'] for r in valid]}.items()}
    brier=statistics.mean((r['p_profitable']-int(r['actual_profitable']))**2 for r in valid) if valid else None
    strategies={
        'Jev + selected exit':[r['chosen'] for r in rows if r['buy']],
        'Jev + fixed B':[r['reference'] for r in rows if r['buy']],
        'Always buy + fixed B':[r['reference'] for r in rows],
        'EMA10 > SMA60 + fixed B':[r['reference'] for r in rows if r['ema_buy']],
        'Always buy + selected exit':[r['chosen'] for r in rows],
        'Always wait':[],
        'Jev + target-first sensitivity':[r['chosen_target_first'] for r in rows if r['buy']]}
    trade_metrics={k:trading_metrics(value) for k,value in strategies.items()}
    groups=[]
    for key in ('symbol','interval','window'):
        for value in sorted(set(r[key] for r in rows)):
            group=[r for r in rows if r[key]==value];group_valid=[r for r in group if r['actual_profitable'] is not None]
            groups.append({'dimension':key,'value':value,'classification':classification([r['buy'] for r in group_valid],[r['actual_profitable'] for r in group_valid]),
                           'trading':trading_metrics([r['chosen'] for r in group if r['buy']])})
    cells=[]
    for symbol in ('BTCUSDT','ETHUSDT'):
        for interval in ('5m','15m'):
            for window in (60,120):
                group=[r for r in rows if (r['symbol'],r['interval'],r['window'])==(symbol,interval,window)]
                group_valid=[r for r in group if r['actual_profitable'] is not None]
                cells.append({'symbol':symbol,'interval':interval,'window':window,'classification':classification([r['buy'] for r in group_valid],[r['actual_profitable'] for r in group_valid]),'trading':trading_metrics([r['chosen'] for r in group if r['buy']])})
    random_stats=None
    buy_count=sum(r['buy'] for r in valid)
    if valid and buy_count:
        rng=random.Random(SEED);pnls=[r['reference']['net_pnl'] for r in valid]
        sampled=sorted(sum(rng.sample(pnls,buy_count)) for _ in range(10000))
        observed=sum(r['reference']['net_pnl'] for r in valid if r['buy'])
        random_stats={'draws':len(sampled),'matched_buy_count':buy_count,'mean':statistics.mean(sampled),'p05':sampled[499],'p50':sampled[4999],'p95':sampled[9499],
                      'jev_fixed_exit_net':observed,'fraction_random_at_least_as_good':(1+sum(v>=observed for v in sampled))/(1+len(sampled))}
    costs=[r['api_cost'] or 0 for r in rows];latencies=sorted(r['latency_seconds'] for r in rows)
    summary={'requested_samples':len(cases),'valid_responses':len(rows),'skipped':skipped,'classification':metrics,'brier_score':brier,
             'brier_constant_half':.25,'brier_in_sample_base_rate':statistics.mean((statistics.mean(actual)-int(y))**2 for y in actual) if actual else None,
             'strategies':trade_metrics,'groups':groups,'cells':cells,'buy_decisions':sum(r['buy'] for r in rows),'invalid_selected_plans':[r['case_id'] for r in rows if not r['chosen']['valid']],
             'invalid_reference_plans':[r['case_id'] for r in rows if not r['reference']['valid']],'matched_random':random_stats,'model_versions':sorted(set(r['model'] for r in rows)),
             'api_cost_usd':sum(costs),'input_tokens':sum(r['input_tokens'] or 0 for r in rows),'latency_median_seconds':statistics.median(latencies) if latencies else None,
             'latency_p95_seconds':latencies[min(len(latencies)-1,math_ceil(.95*len(latencies))-1)] if latencies else None}
    write_json(out/'scored-cases.json',rows);write_json(out/'summary.json',summary)
    fields=['case_id','symbol','interval','window','decision_time_utc','buy','buy_confidence','p_profitable','actual_profitable','exit_plan','take_profit','stop_loss','if_buy_entry_price','if_buy_exit_price','if_buy_exit_reason','model_executed','model_net_pnl','selected_plan_if_buy_pnl','reference_if_buy_pnl','model_fees','model_funding_cost','dual_touch','latency_seconds','available_after_seconds','api_cost']
    with (out/'cases.csv').open('w',newline='') as file:
        writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
        for row in rows:
            trade=row['chosen'];executed=row['buy'] and trade['valid'];flat={k:row.get(k) for k in fields}
            flat.update(decision_time_utc=iso(row['decision_time']),reference_if_buy_pnl=row['reference'].get('net_pnl'),selected_plan_if_buy_pnl=trade.get('net_pnl'),model_executed=executed,
                        model_net_pnl=trade.get('net_pnl',0) if executed else 0,model_fees=trade.get('fees',0) if executed else 0,model_funding_cost=trade.get('funding_cost',0) if executed else 0)
            flat.update({k:row['planned_exit'][k] for k in ('take_profit','stop_loss')});flat['dual_touch']=trade.get('dual_touch')
            flat.update({f'if_buy_{k}':trade.get(k) for k in ('entry_price','exit_price','exit_reason')});writer.writerow(flat)
    print(json.dumps({'responses':len(rows),'classification':metrics['jev'],'model_strategy':trade_metrics['Jev + selected exit'],'cost_usd':sum(costs)},ensure_ascii=False,indent=2),flush=True)
    return summary,rows


def math_ceil(value):
    import math
    return math.ceil(value)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['prepare','run','score']);parser.add_argument('--out',type=Path,default=DEFAULT_OUT);parser.add_argument('--max-cases',type=int)
    args=parser.parse_args()
    if args.command=='prepare':prepare(args.out)
    elif args.command=='run':run(args.out,args.max_cases)
    else:score(args.out)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('STOP: '+redact(error),file=sys.stderr)
        sys.exit(1)
