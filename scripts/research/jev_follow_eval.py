#!/usr/bin/env python3
from __future__ import annotations
import argparse,csv,hashlib,json,math,statistics,subprocess,sys,time
from collections import Counter
from pathlib import Path
from datetime import datetime

from jev_eval import ROOT,MINUTE,DAY,MODEL,DECISIONS,MAX_REQUESTS,MAX_COST,get,request,private_settings,APIError,redact,read_json,write_json,digest,canonical,load_rows,contract_info,iso
from jev_backtest import atr,classification
from jev_follow_backtest import reference_trade,replay

OUT=ROOT/'docs/research/jev-follow-2026-09-22/run'
REASONS={'TREND_SUPPORT':'The observed segment has directional structure supporting the new signal.',
    'CHOP':'Repeated oscillation or congestion makes a whipsaw plausible.', 'COUNTERTREND':'The signal is opposed by the broader observed segment movement.',
    'EXTENDED':'The entry is late relative to the preceding move.', 'COST':'Expected move appears small relative to stated round-trip costs.',
    'UNCLEAR':'The supplied segment does not discriminate the trade quality.', 'NO_OBJECTION':'No particular adverse feature stands out in the observed segment.'}


def questions():
    common='Evaluate the CURRENT, already-triggered EMA10/SMA60 strategy signal, following its stated LONG or SHORT direction and the execution/exit rules in state.execution. Use only state.segment and state.features. The signal arithmetic has been verified by code; do NOT merely check whether a crossover exists. Forecast whether following this particular signal has a favorable expected NET outcome, including costs, until the original strategy exit. Future candles and the next opposite signal are unknown.'
    return {
      'follow_neutral':{'type':'choice','instructions':common+' Make your best probabilistic decision. Certainty is not required. Ordinary forecasting uncertainty alone is not a reason to skip; compare the expected directional opportunity with whipsaw and cost risks.',
        'criteria':{'FOLLOW':'On balance, follow the existing strategy signal and open in its stated direction.','SKIP':'On balance, decline this entry because the observed context makes the expected net outcome unfavorable.'}},
      'follow_conservative':{'type':'choice','instructions':common+' Do not assume a trade is required. Require sufficiently clear supporting evidence.',
        'criteria':{'FOLLOW':'The trade has a favorable expected net outcome after costs and sufficient supporting evidence.','SKIP':'The evidence does not justify entering now, or its expected outcome after costs is unfavorable or uncertain.'}},
      'profitable':{'type':'noul','instructions':'Under state.execution, would a trade following state.current_signal.direction finish with strictly positive net P&L when the original strategy exits on its next opposite eligible signal? Predict from the observed state only.',
        'criteria':{'true':'Positive net P&L after all stated costs.','false':'Zero or negative net P&L after costs.'}},
      'reason':{'type':'choice','instructions':'Which single contextual category is most salient for this already-triggered strategy signal, using the observed segment and features? This is an independent context label, not an explanation of another answer.', 'criteria':REASONS},
      'signal_readback':{'type':'choice','instructions':'Read the explicit direction in state.current_signal.direction. Which side did the source strategy trigger?', 'criteria':{'LONG':'state.current_signal.direction is LONG.','SHORT':'state.current_signal.direction is SHORT.'}}
    }


def features(market,previous,current):
    a,b=previous['index'],current['index'];bars=market['bars'];fast=market['fast'];slow=market['slow'];segment=bars[a:b+1]
    close=bars[b][4];volatility=atr(bars[max(0,b-100):b+1]);denom=max(volatility,1e-12)
    past=max(a,b-5);spread=fast[b]-slow[b]
    crosses=sum((fast[i-1]-slow[i-1])*(fast[i]-slow[i])<0 for i in range(a+1,b+1))
    avg_volume=statistics.mean(row[5] for row in segment)
    return {'bars_since_previous_signal':b-a,'segment_return_pct':(close/bars[a][4]-1)*100,
      'segment_range_pct':(max(row[2] for row in segment)-min(row[3] for row in segment))/bars[a][4]*100,
      'last_close':close,'ema10':fast[b],'sma60':slow[b],'ema_minus_sma_atr':spread/denom,
      'ema_slope_last_up_to_5_bars_atr':(fast[b]-fast[past])/denom,'sma_slope_last_up_to_5_bars_atr':(slow[b]-slow[past])/denom,
      'ema_slope_direction':'rising' if fast[b]>fast[past] else 'falling' if fast[b]<fast[past] else 'flat',
      'sma_slope_direction':'rising' if slow[b]>slow[past] else 'falling' if slow[b]<slow[past] else 'flat',
      'close_distance_from_ema_atr':(close-fast[b])/denom,'crossings_in_supplied_segment':crosses,
      'last_volume_div_segment_mean':bars[b][5]/avg_volume if avg_volume else 0,'atr14_from_known_history':volatility,
      'approx_roundtrip_friction_atr':close*.0012/denom}


def payload_for(case):
    return {'model':MODEL,'state':{
      'instrument':'anonymous USDT perpetual','timeframe':case.get('interval','1m'),
      'source_strategy':{'ema_length':10,'sma_length':60,'range_limit_quote_units':100,'pyramiding':0,
         'entry_rule':'Upward EMA/SMA cross yields LONG; downward cross yields SHORT. The source range check has passed. Its original state resets and range logic are retained.'},
      'previous_signal':{'direction':case['previous_signal']['side'].upper(),'bars_ago':case['signal']['index']-case['previous_signal']['index']},
      'current_signal':{'direction':case['signal']['side'].upper(),'source_condition_verified':True,'at_segment_bar':len(case['segment'])-1},
      'segment':{'columns':['relative_bar','open','high','low','close','volume','ema10','sma60'],'rows':case['segment']},
      'features':case['features'],
      'execution':{'task':'Filter only the NEW entry in the supplied signal direction. An opposite signal still exits an existing position even if you decline the new entry.',
        'entry':f"Wait one complete {case.get('period_ms',MINUTE)//MINUTE}-minute candle after the signal close, then enter at the next open; cancel if an opposite signal arrives before entry.",
        'exit':'Exit at the open immediately after the next opposite eligible SOURCE signal. No fixed ATR target, stop or 12-bar timeout is imposed.',
        'same_direction':'No additional entry when already holding the same direction (pyramiding=0).',
        'notional_usdt':1000,'leverage':1,'fee_each_side_bps':5,'adverse_slippage_each_side_bps':1,'funding':'Realized historic funding is included in scoring; its future values are not supplied.'}},'questions':questions()}


def prepare(out):
    if (out/'manifest.json').exists():print('Frozen experiment exists; no resampling.',flush=True);return
    out.mkdir(parents=True,exist_ok=True)
    clock_path=out/'preparation-clock.json'
    if clock_path.exists():end=read_json(clock_path)['data_end']
    else:
        captured=out/'market-data/ETHUSDT-native-input.json'
        end=read_json(captured)['bars'][-1][0]+MINUTE if captured.exists() else int(get('/fapi/v1/time')['serverTime'])//MINUTE*MINUTE
        write_json(clock_path,{'data_end':end,'frozen_at':iso(int(time.time()*1000))})
    start=end-8*DAY;cutoff=end-6*60*MINUTE
    info=get('/fapi/v1/exchangeInfo');markets={};cases=[];excluded=[]
    for symbol in ('ETHUSDT','BTCUSDT'):
        market_path=out/'market-data'/f'{symbol}.json';market_path.parent.mkdir(parents=True,exist_ok=True)
        print(f'Loading {symbol} 1m and evaluating original Pine signal conditions',flush=True)
        native_input=out/'market-data'/f'{symbol}-native-input.json';native_output=out/'market-data'/f'{symbol}-native-signals.json'
        bars=read_json(native_input)['bars'] if native_input.exists() else load_rows('/fapi/v1/klines',symbol,'1m',MINUTE,start,end)
        if bars[0][0]!=start or bars[-1][0]+MINUTE!=end:raise RuntimeError('Cached preparation uses a different time range')
        marks=load_rows('/fapi/v1/markPriceKlines',symbol,'1m',MINUTE,start,end)
        contract=contract_info(info,symbol)
        funding=get('/fapi/v1/fundingRate',symbol=symbol,startTime=start,endTime=end-1,limit=1000)
        if not funding or any(not row.get('markPrice') for row in funding):raise RuntimeError('Funding history unavailable')
        write_json(native_input,{'symbol':symbol,'bars':bars,'tickSize':contract['tick_size']})
        subprocess.run(['node',str(ROOT/'.jev-research.local/pine-signal-export.mjs'),str(native_input),str(native_output)],cwd=ROOT,check=True)
        native=read_json(native_output)
        market={'symbol':symbol,'bars':bars,'marks':{str(b[0]):b[4] for b in marks},'contract':contract,'funding':funding,**native}
        write_json(market_path,market);markets[symbol]=market
        signals=market['signals'];eligible=[(i,s) for i,s in enumerate(signals) if i>0 and s['index']>=300 and s['time']+MINUTE<=cutoff]
        if len(eligible)<20:raise RuntimeError('Insufficient source signals')
        for sequence,(ordinal,signal) in enumerate(eligible[-20:],1):
            previous=signals[ordinal-1];a,b=previous['index'],signal['index']
            case={'id':f'{symbol}-1m-signal-{sequence:02d}','symbol':symbol,'signal':signal,'previous_signal':previous,
              'decision_time':signal['time']+MINUTE-1,'segment':[[j-a,*bars[j][1:],native['fast'][j],native['slow'][j]] for j in range(a,b+1)],'features':features(market,previous,signal)}
            if len(case['segment'])>500:
                excluded.append({'id':case['id'],'reason':'context_over_500_bars','bars':len(case['segment'])});continue
            case['request_sha256']=digest(payload_for(case));cases.append(case)
    cases.sort(key=lambda c:c['decision_time']);write_json(out/'cases.json',cases)
    for case in cases:write_json(out/'requests'/f"{case['id']}.json",payload_for(case))
    source=(ROOT/'public/scripts/ema-price-range-script-visuals.pine').read_bytes();protocol=(out.parent/'protocol.md').read_bytes()
    manifest={'prepared_at':iso(int(time.time()*1000)),'data_start':iso(start),'data_end':iso(end),'signal_cutoff':iso(cutoff),'model':MODEL,
      'case_count':len(cases),'excluded':excluded,'source_sha256':hashlib.sha256(source).hexdigest(),'protocol_sha256':hashlib.sha256(protocol).hexdigest(),
      'questions_sha256':digest(questions()),'cases_sha256':digest(cases),'market_sha256':{symbol:digest(m) for symbol,m in markets.items()},
      'source_inputs':{'emaLength':10,'maLength':60,'rangeLimit':100},'samples':[{k:c[k] for k in ('id','symbol','decision_time','request_sha256')} for c in cases]}
    write_json(out/'manifest.json',manifest)
    print(json.dumps({'frozen_cases':len(cases),'directions':dict(Counter(c['signal']['side'] for c in cases)),'segment_bars_range':[min(len(c['segment']) for c in cases),max(len(c['segment']) for c in cases)],'excluded':excluded}),flush=True)


def valid_answer(response):
    try:
        a=response['answers']
        return bool(response['model']) and a['follow_neutral']['choice'] in ('FOLLOW','SKIP') and a['follow_conservative']['choice'] in ('FOLLOW','SKIP') and a['reason']['choice'] in REASONS and a['signal_readback']['choice'] in ('LONG','SHORT') and 0<=a['profitable']['noul']<=1
    except (KeyError,TypeError):return False


def run(out,max_cases=None):
    manifest=read_json(out/'manifest.json');cases=read_json(out/'cases.json')
    if digest(cases)!=manifest['cases_sha256'] or digest(questions())!=manifest['questions_sha256']:raise RuntimeError('Frozen experiment modified')
    key=private_settings().get('OPENROUTER_API_KEY')
    if not key:raise RuntimeError('OpenRouter key is not configured')
    log=out/'api-attempts.jsonl';attempts=[json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    version=None;completed=0
    for path in (out/'responses').glob('*.json') if (out/'responses').exists() else []:
        actual=read_json(path)['response']['model']
        if version and actual!=version:raise RuntimeError('Mixed model versions')
        version=actual
    for case in cases:
        path=out/'responses'/f"{case['id']}.json"
        if path.exists():
            cached=read_json(path)
            if cached['request_sha256']!=case['request_sha256'] or not valid_answer(cached['response']):raise RuntimeError('Invalid cache, no selective rerun allowed')
            continue
        if max_cases is not None and completed>=max_cases:break
        payload=read_json(out/'requests'/f"{case['id']}.json")
        if digest(payload)!=case['request_sha256']:raise RuntimeError('Request changed')
        for retry in range(3):
            if len(attempts)>=MAX_REQUESTS or sum(a.get('cost',0) for a in attempts)>=MAX_COST:raise RuntimeError('API budget exhausted')
            t=time.monotonic();attempt={'case_id':case['id'],'started_at':iso(int(time.time()*1000)),'request_sha256':case['request_sha256'],'attempt':len(attempts)+1}
            try:
                response=request(DECISIONS,payload,key);latency=time.monotonic()-t
                if not valid_answer(response):write_json(out/'invalid'/f"{case['id']}.json",response);raise APIError(422,'Unexpected response contract')
                write_json(path,{'request_sha256':case['request_sha256'],'latency_seconds':latency,'response':response})
                actual=response['model'];attempt.update(status=200,model=actual,cost=float(response.get('usage',{}).get('cost') or 0),latency_seconds=latency)
                if version and version!=actual:raise APIError(409,'Model version changed')
                version=actual;completed+=1;a=response['answers']
                print(f"[{len(list((out/'responses').glob('*.json')))}/{len(cases)}] {case['id']} {case['signal']['side']}: neutral={a['follow_neutral']['choice']} conservative={a['follow_conservative']['choice']} p={a['profitable']['noul']:.2f} {latency:.2f}s",flush=True)
            except APIError as error:
                attempt.update(status=error.status,latency_seconds=time.monotonic()-t,error=str(error));print(f'API {error.status}: {str(error)[:180]}',flush=True)
                if retry==2 or error.status not in (0,429,500,502,503,504,524,529):raise
            finally:
                attempts.append(attempt)
                with log.open('a') as file:file.write(canonical(attempt)+'\n')
            if attempt['status']==200:break
            time.sleep(2**retry)


def score(out):
    manifest=read_json(out/'manifest.json');cases=read_json(out/'cases.json');markets={symbol:read_json(out/'market-data'/f'{symbol}.json') for symbol in ('ETHUSDT','BTCUSDT')}
    if digest(cases)!=manifest['cases_sha256'] or any(digest(m)!=manifest['market_sha256'][symbol] for symbol,m in markets.items()):raise RuntimeError('Data hash changed')
    attempts=[json.loads(line) for line in (out/'api-attempts.jsonl').read_text().splitlines()];rows=[];late=set();accepted={'neutral':{},'conservative':{}}
    for case in cases:
        path=out/'responses'/f"{case['id']}.json"
        if not path.exists():raise RuntimeError('Experiment incomplete: '+case['id'])
        cached=read_json(path);answers=cached['response']['answers'];calls=[a for a in attempts if a['case_id']==case['id']]
        first=datetime.fromisoformat(calls[0]['started_at'].replace('Z','+00:00')).timestamp();end=datetime.fromisoformat(calls[-1]['started_at'].replace('Z','+00:00')).timestamp()+calls[-1]['latency_seconds'];elapsed=end-first
        if elapsed>60:late.add(case['id'])
        for arm in accepted:accepted[arm][case['id']]=answers['follow_'+arm]['choice']=='FOLLOW'
        reference=reference_trade(case,markets[case['symbol']],1)
        rows.append({'case_id':case['id'],'symbol':case['symbol'],'side':case['signal']['side'],'decision_time':case['decision_time'],'previous_signal_time':case['previous_signal']['time'],
          'segment_bars':len(case['segment']),'neutral_follow':accepted['neutral'][case['id']],'conservative_follow':accepted['conservative'][case['id']],
          'neutral_confidence':answers['follow_neutral'].get('confidence'),'conservative_confidence':answers['follow_conservative'].get('confidence'),
          'probability':answers['profitable']['noul'],'reason':answers['reason']['choice'],'readback_correct':answers['signal_readback']['choice']==case['signal']['side'].upper(),
          'late':case['id'] in late,'available_after_seconds':elapsed,'latency_seconds':cached['latency_seconds'],'reference':reference,
          'actual_profitable':reference['net_pnl']>0 if reference['valid'] and reference['status']=='closed' else None,
          'model':cached['response']['model'],'cost':cached['response'].get('usage',{}).get('cost',0),'input_tokens':cached['response'].get('usage',{}).get('input_tokens',0)})
    valid=[r for r in rows if r['actual_profitable'] is not None]
    classifiers={arm:classification([r[arm+'_follow'] for r in valid],[r['actual_profitable'] for r in valid]) for arm in ('neutral','conservative')}
    classifiers['always_follow']=classification([True]*len(valid),[r['actual_profitable'] for r in valid]);classifiers['always_skip']=classification([False]*len(valid),[r['actual_profitable'] for r in valid])
    all_follow={c['id']:True for c in cases}
    ledgers={'source_next_open':replay(cases,markets,all_follow,0),'source_delayed':replay(cases,markets,all_follow,1),
      'jev_neutral':replay(cases,markets,accepted['neutral'],1,late),'jev_conservative':replay(cases,markets,accepted['conservative'],1,late), 'always_skip':replay(cases,markets,{},1)}
    positive=[r for r in valid if r['actual_profitable']];negative=[r for r in valid if not r['actual_profitable']]
    auc=sum((a['probability']>b['probability'])+.5*(a['probability']==b['probability']) for a in positive for b in negative)/(len(positive)*len(negative)) if positive and negative else None
    groups=[]
    for field in ('symbol','side'):
        for value in sorted(set(r[field] for r in rows)):
            group=[r for r in valid if r[field]==value]
            groups.append({'field':field,'value':value,'neutral':classification([r['neutral_follow'] for r in group],[r['actual_profitable'] for r in group]),'conservative':classification([r['conservative_follow'] for r in group],[r['actual_profitable'] for r in group])})
    summary={'count':len(rows),'neutral_follow':sum(r['neutral_follow'] for r in rows),'conservative_follow':sum(r['conservative_follow'] for r in rows),
      'paired_disagreements':sum(r['neutral_follow']!=r['conservative_follow'] for r in rows),'readback_correct':sum(r['readback_correct'] for r in rows),'late_responses':len(late),
      'classification':classifiers,'groups':groups,'probability_auc':auc,'brier':statistics.mean((r['probability']-int(r['actual_profitable']))**2 for r in valid) if valid else None,
      'reason_counts':dict(Counter(r['reason'] for r in rows)),'model_versions':sorted(set(r['model'] for r in rows)),
      'cost_usd':sum(r['cost'] or 0 for r in rows),'input_tokens':sum(r['input_tokens'] or 0 for r in rows),'attempts':len(attempts),'failures':sum(a['status']!=200 for a in attempts),
      'latency_median_seconds':statistics.median(r['latency_seconds'] for r in rows),'max_available_after_seconds':max(r['available_after_seconds'] for r in rows),
      'segment_bars_range':[min(r['segment_bars'] for r in rows),max(r['segment_bars'] for r in rows)], 'ledgers':{k:v['metrics'] for k,v in ledgers.items()}}
    write_json(out/'scored-cases.json',rows);write_json(out/'ledgers.json',ledgers);write_json(out/'summary.json',summary)
    fields=['case_id','symbol','side','decision_time_utc','previous_signal_time_utc','segment_bars','neutral_follow','conservative_follow','probability','reason','readback_correct','late','available_after_seconds','reference_status','if_follow_entry_price','if_follow_exit_price','if_follow_net_pnl','actual_profitable']
    with (out/'signals.csv').open('w',newline='') as file:
        writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
        for r in rows:
            ref=r['reference'];flat={k:r.get(k) for k in fields};flat.update(decision_time_utc=iso(r['decision_time']),previous_signal_time_utc=iso(r['previous_signal_time']),reference_status=ref.get('status',ref.get('reason')))
            flat.update({f'if_follow_{k}':ref.get(k) for k in ('entry_price','exit_price','net_pnl')});writer.writerow(flat)
    trade_fields=['method','case_id','symbol','side','status','entry_time_utc','exit_time_utc','quantity','entry_price','exit_price','gross_pnl_after_slippage','fees','funding_cost','net_pnl']
    with (out/'trades.csv').open('w',newline='') as file:
        writer=csv.DictWriter(file,fieldnames=trade_fields);writer.writeheader()
        for method,ledger in ledgers.items():
            for trade in ledger['trades']:
                row={k:trade.get(k) for k in trade_fields};row.update(method=method,entry_time_utc=iso(trade['entry_time']),exit_time_utc=iso(trade['exit_time']));writer.writerow(row)
    print(json.dumps({k:summary[k] for k in ('count','neutral_follow','conservative_follow','paired_disagreements','readback_correct','classification','cost_usd')},ensure_ascii=False,indent=2),flush=True)
    for name,ledger in ledgers.items():print(name, {k:ledger['metrics'][k] for k in ('trades','wins','net_pnl','total_net_pnl','open_positions')},flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['prepare','run','score']);parser.add_argument('--out',type=Path,default=OUT);parser.add_argument('--max-cases',type=int);args=parser.parse_args()
    try:
        if args.command=='prepare':prepare(args.out)
        elif args.command=='run':run(args.out,args.max_cases)
        else:score(args.out)
    except Exception as error:
        print('STOP: '+redact(error),file=sys.stderr);sys.exit(1)
