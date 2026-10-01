#!/usr/bin/env python3
"""Predeclared temporal expansion. New cache and budget; old runs stay frozen."""
from __future__ import annotations
import argparse,bisect,csv,hashlib,json,statistics,subprocess,sys,threading,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import datetime
from pathlib import Path
from jev_eval import ROOT,MINUTE,DAY,MODEL,DECISIONS,get,request,private_settings,APIError,redact,read_json,write_json,digest,canonical,contract_info,iso
from jev_follow_eval import features,payload_for,questions,valid_answer
from jev_follow_backtest import reference_trade,replay
from jev_backtest import classification,trading_metrics

OUT=ROOT/'docs/research/jev-expanded-2026-09-22/run'
PREVIOUS=ROOT/'docs/research/jev-follow-2026-09-22/run'
OFFSETS=[26,20,14,8,2]
ATTEMPT_LIMIT=250
COST_LIMIT=.50
_public_lock=threading.Lock();_public_next=0.0


def public_get(path,**query):
    global _public_next
    with _public_lock:
        delay=max(0,_public_next-time.monotonic());_public_next=max(_public_next,time.monotonic())+.34
    if delay:time.sleep(delay)
    return get(path,**query)


def history(endpoint,symbol,interval,period,start,end,cache):
    if cache.exists():
        rows=read_json(cache)
        if rows[0][0]!=start or rows[-1][0]+period!=end:raise RuntimeError('Cache time bounds changed')
        return rows
    rows=[];cursor=start
    while cursor<end:
        page=public_get(endpoint,symbol=symbol,interval=interval,startTime=cursor,endTime=end-1,limit=1000)
        if not isinstance(page,list) or not page:raise RuntimeError('Missing data page '+symbol+' '+interval)
        batch=[[int(r[0]),*map(float,r[1:6])] for r in page if cursor<=int(r[0])<end and int(r[6])<end]
        if not batch or batch[0][0]!=cursor:raise RuntimeError('Data gap at page boundary')
        rows.extend(batch);cursor=batch[-1][0]+period
    for i,b in enumerate(rows):
        if b[2]<max(b[1],b[4]) or b[3]>min(b[1],b[4]) or b[3]<=0 or b[5]<0 or i and b[0]-rows[i-1][0]!=period:raise RuntimeError('Invalid or non-contiguous history')
    if rows[-1][0]+period!=end:raise RuntimeError('Incomplete history tail')
    write_json(cache,rows)
    return rows


def funding_history(symbol,start,end,path):
    if path.exists():return read_json(path)
    rows=[];cursor=start
    while cursor<end:
        page=public_get('/fapi/v1/fundingRate',symbol=symbol,startTime=cursor,endTime=end-1,limit=1000)
        if not isinstance(page,list):raise RuntimeError('Invalid funding response')
        if not page:break
        rows.extend(page);cursor=int(page[-1]['fundingTime'])+1
        if len(page)<1000:break
    if not rows or any(not r.get('markPrice') or float(r['markPrice'])<=0 for r in rows):raise RuntimeError('Missing funding event marks')
    if int(rows[0]['fundingTime'])>start+DAY or end-int(rows[-1]['fundingTime'])>DAY:raise RuntimeError('Incomplete funding coverage')
    write_json(path,rows);return rows


def previous_events():
    events=set()
    for path in [PREVIOUS/'cases.json',ROOT/'docs/research/jev-evaluation-2026-09-21/run/cases.json']:
        for c in read_json(path):events.add((c['symbol'],c.get('interval','1m'),c['decision_time']))
    return events


def prepare(out):
    if (out/'manifest.json').exists():print('Frozen expansion exists; no resampling.',flush=True);return
    out.mkdir(parents=True,exist_ok=True)
    clock=out/'preparation-clock.json'
    if clock.exists():end=read_json(clock)['data_end']
    else:
        end=int(public_get('/fapi/v1/time')['serverTime'])//(5*MINUTE)*(5*MINUTE)
        write_json(clock,{'data_end':end,'frozen_at':iso(int(time.time()*1000))})
    start=end-(max(OFFSETS)+8)*DAY
    info_path=out/'exchange-info.json'
    if not info_path.exists():write_json(info_path,public_get('/fapi/v1/exchangeInfo'))
    info=read_json(info_path);contracts={s:contract_info(info,s) for s in ('BTCUSDT','ETHUSDT')}
    funding={s:funding_history(s,start,end,out/'shared-data'/f'{s}-funding.json') for s in contracts}
    shared={}
    def fetch_pair(symbol,interval):
        period=int(interval[:-1])*MINUTE
        bars=history('/fapi/v1/klines',symbol,interval,period,start,end,out/'shared-data'/f'{symbol}-{interval}-bars.json')
        marks=history('/fapi/v1/markPriceKlines',symbol,interval,period,start,end,out/'shared-data'/f'{symbol}-{interval}-marks.json')
        print(f'Cached {symbol} {interval}: {len(bars)} closed candles',flush=True)
        return symbol,interval,bars,marks
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(fetch_pair,s,tf) for s in contracts for tf in ('1m','5m')]
        for future in as_completed(futures):
            symbol,interval,bars,marks=future.result();shared[(symbol,interval)]=(bars,marks)
    seen=previous_events();prior_count=len(seen);cases=[];groups=[];excluded=[];market_hashes={}
    scratch=ROOT/'.jev-research.local/expanded-sources';scratch.mkdir(parents=True,exist_ok=True)
    for offset in OFFSETS:
        anchor=end-offset*DAY;block=f'b{offset:02d}'
        for symbol in contracts:
            for interval in ('1m','5m'):
                period=int(interval[:-1])*MINUTE;group_id=f'{block}-{symbol}-{interval}';full_bars,full_marks=shared[(symbol,interval)]
                lo=(anchor-8*DAY-start)//period;hi=(anchor+2*DAY-start)//period;bars=full_bars[lo:hi];marks=full_marks[lo:hi]
                native_input=scratch/f'{group_id}-input.json';native_output=scratch/f'{group_id}-signals.json'
                write_json(native_input,{'symbol':symbol,'interval':interval,'bars':bars,'tickSize':contracts[symbol]['tick_size']})
                subprocess.run(['node',str(ROOT/'.jev-research.local/pine-signal-export.mjs'),str(native_input),str(native_output)],cwd=ROOT,check=True,capture_output=True,text=True)
                native=read_json(native_output)
                market={'symbol':symbol,'interval':interval,'period_ms':period,'bars':bars,'marks':{str(b[0]):b[4] for b in marks},'contract':contracts[symbol],
                        'funding':[r for r in funding[symbol] if bars[0][0]<=int(r['fundingTime'])<bars[-1][0]+period],**native}
                write_json(out/'market-data'/f'{group_id}.json',market);market_hashes[group_id]=digest(market)
                signals=market['signals'];eligible=[(i,s) for i,s in enumerate(signals) if i>0 and s['index']>=300 and s['time']+period<=anchor and (symbol,interval,s['time']+period-1) not in seen]
                selected=eligible[-10:];count=0
                if len(selected)<10:excluded.append({'group_id':group_id,'reason':'insufficient_new_source_signals','available':len(selected)})
                for ordinal,signal in selected:
                    previous=signals[ordinal-1];a,b=previous['index'],signal['index'];key=(symbol,interval,signal['time']+period-1)
                    if key in seen:raise RuntimeError('Duplicate signal')
                    seen.add(key)
                    case={'id':f'{group_id}-s{signal["time"]}','group_id':group_id,'block':block,'symbol':symbol,'interval':interval,'period_ms':period,'signal':signal,'previous_signal':previous,
                          'decision_time':signal['time']+period-1,'segment':[[j-a,*bars[j][1:],native['fast'][j],native['slow'][j]] for j in range(a,b+1)],'features':features(market,previous,signal)}
                    if len(case['segment'])>500:
                        excluded.append({'id':case['id'],'group_id':group_id,'reason':'context_over_500_bars','bars':len(case['segment'])});continue
                    case['request_sha256']=digest(payload_for(case));cases.append(case);count+=1
                groups.append({'id':group_id,'block':block,'symbol':symbol,'interval':interval,'anchor':anchor,'count':count,'source_signals':len(signals)})
                print(f'Frozen group {group_id}: {count} new signals',flush=True)
    cases.sort(key=lambda c:(c['decision_time'],c['id']))
    write_json(out/'cases.json',cases)
    for c in cases:write_json(out/'requests'/f'{c["id"]}.json',payload_for(c))
    source=(ROOT/'public/scripts/ema-price-range-script-visuals.pine').read_bytes()
    previous_summary=read_json(PREVIOUS/'summary.json')
    manifest={'prepared_at':iso(int(time.time()*1000)),'data_start':iso(start),'data_end':iso(end),'case_count':len(cases),'groups':groups,'excluded':excluded,
              'prior_events_excluded':prior_count,'new_event_duplicates':0,'cases_sha256':digest(cases),'questions_sha256':digest(questions()),'market_sha256':market_hashes,
              'source_sha256':hashlib.sha256(source).hexdigest(),'protocol_sha256':hashlib.sha256((out.parent/'protocol.md').read_bytes()).hexdigest(),
              'expected_model':previous_summary['model_versions'][0],'requested_model':MODEL,'limits':{'attempts':ATTEMPT_LIMIT,'cost_usd':COST_LIMIT,'concurrency':3},
              'directions':dict(Counter(c['signal']['side'] for c in cases)),'segment_bars_range':[min(len(c['segment']) for c in cases),max(len(c['segment']) for c in cases)]}
    write_json(out/'manifest.json',manifest)
    print(json.dumps({k:manifest[k] for k in ('case_count','directions','segment_bars_range','excluded')},ensure_ascii=False),flush=True)


def read_lines(path):return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def run(out):
    manifest=read_json(out/'manifest.json');cases=read_json(out/'cases.json')
    if digest(cases)!=manifest['cases_sha256'] or digest(questions())!=manifest['questions_sha256']:raise RuntimeError('Frozen inputs changed')
    if hashlib.sha256((out.parent/'protocol.md').read_bytes()).hexdigest()!=manifest['protocol_sha256']:raise RuntimeError('Protocol changed')
    key=private_settings().get('OPENROUTER_API_KEY')
    if not key:raise RuntimeError('OpenRouter credential unavailable')
    lock=threading.Lock();stop=threading.Event();log=out/'api-attempts.jsonl';reserved=out/'attempt-reservations.jsonl'
    finished=read_lines(log);reservations=read_lines(reserved);stats={'attempts':len(reservations),'cost':sum(a.get('cost',0) for a in finished),'done':0};pending=[]
    for c in cases:
        path=out/'responses'/f'{c["id"]}.json'
        if path.exists():
            cached=read_json(path)
            if cached['request_sha256']!=c['request_sha256'] or not valid_answer(cached['response']) or cached['response']['model']!=manifest['expected_model']:raise RuntimeError('Cached response is not comparable')
            stats['done']+=1
        else:pending.append(c)
    print(f'Resume: {stats["done"]}/{len(cases)} already cached; {len(pending)} pending',flush=True)
    def worker(case):
        target=out/'responses'/f'{case["id"]}.json';payload=read_json(out/'requests'/f'{case["id"]}.json')
        if digest(payload)!=case['request_sha256']:raise RuntimeError('Request changed')
        for retry in range(3):
            with lock:
                if stop.is_set():return
                if stats['attempts']>=ATTEMPT_LIMIT or stats['cost']>=COST_LIMIT:stop.set();raise RuntimeError('Predeclared budget exhausted')
                stats['attempts']+=1
                attempt={'case_id':case['id'],'attempt':stats['attempts'],'started_at':iso(int(time.time()*1000)),'request_sha256':case['request_sha256']}
                with reserved.open('a') as file:file.write(canonical(attempt)+'\n')
            start=time.monotonic();fatal=False
            try:
                response=request(DECISIONS,payload,key);latency=time.monotonic()-start
                if not valid_answer(response):write_json(out/'invalid'/f'{case["id"]}.json',response);raise APIError(422,'Invalid typed answer')
                write_json(target,{'case_id':case['id'],'request_sha256':case['request_sha256'],'latency_seconds':latency,'response':response})
                attempt.update(status=200,latency_seconds=latency,cost=float(response.get('usage',{}).get('cost') or 0),model=response['model'])
                if response['model']!=manifest['expected_model']:raise APIError(409,'Actual model version differs from the frozen comparator')
            except APIError as error:
                attempt.update(status=error.status,latency_seconds=time.monotonic()-start,error=str(error))
                fatal=error.status not in (0,429,500,502,503,504,524,529)
                print(f'API {error.status} on {case["id"]}: {str(error)[:120]}',flush=True)
            finally:
                with lock:
                    finished.append(attempt);stats['cost']+=attempt.get('cost',0)
                    with log.open('a') as file:file.write(canonical(attempt)+'\n')
                    if attempt['status']==200:
                        stats['done']+=1
                        if stats['done']%10==0 or stats['done']==len(cases):print(f'{stats["done"]}/{len(cases)} successful, {stats["attempts"]} attempts, ${stats["cost"]:.5f}',flush=True)
                    write_json(out/'progress.json',{**stats,'target':len(cases),'updated_at':iso(int(time.time()*1000))})
            if attempt['status']==200:return
            if fatal:stop.set();raise RuntimeError(attempt['error'])
            if retry==2:return  # Record failure; other groups must still complete.
            time.sleep(2**retry)
    errors=[]
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures=[pool.submit(worker,c) for c in pending]
        for future in as_completed(futures):
            try:future.result()
            except Exception as error:errors.append(redact(error));stop.set()
    if errors:raise RuntimeError('; '.join(errors))
    if stats['done']<len(cases):raise RuntimeError(f'Incomplete run: {stats["done"]}/{len(cases)}. Failed cases remain visible; do not resample.')


METHODS=['source_next_open','source_delayed','availability_matched','jev_neutral','jev_conservative','always_skip','long_only','short_only']


def pooled_metrics(ledgers):
    trades=[t for ledger in ledgers for t in ledger['trades']];closed=[t for t in trades if t['status']=='closed'];opened=[t for t in trades if t['status']=='open']
    positives=sum(t['net_pnl'] for t in closed if t['net_pnl']>0);losses=-sum(t['net_pnl'] for t in closed if t['net_pnl']<0)
    return {'trades':len(closed),'wins':sum(t['net_pnl']>0 for t in closed),'win_rate':sum(t['net_pnl']>0 for t in closed)/len(closed) if closed else None,
            'closed_net_pnl':sum(t['net_pnl'] for t in closed),'open_positions':len(opened),'open_net_pnl':sum(t['net_pnl'] for t in opened),
            'total_net_pnl':sum(t['net_pnl'] for t in trades),'fees':sum(t['fees'] for t in trades),'funding_cost':sum(t['funding_cost'] for t in trades),
            'profit_factor':positives/losses if losses else None,'worst_group_closed_drawdown':max((x['metrics']['closed_trade_drawdown'] for x in ledgers),default=0)}


def score(out):
    manifest=read_json(out/'manifest.json');cases=read_json(out/'cases.json');attempts=read_lines(out/'api-attempts.jsonl')
    if digest(cases)!=manifest['cases_sha256']:raise RuntimeError('Frozen cases changed')
    markets={g['id']:read_json(out/'market-data'/f'{g["id"]}.json') for g in manifest['groups']}
    if any(digest(m)!=manifest['market_sha256'][gid] for gid,m in markets.items()):raise RuntimeError('Market cache changed')
    rows=[];missing=[];accepted={'neutral':{},'conservative':{}};late=set()
    for c in cases:
        path=out/'responses'/f'{c["id"]}.json'
        if not path.exists():missing.append(c['id']);continue
        cached=read_json(path);response=cached['response']
        if not valid_answer(response) or response['model']!=manifest['expected_model'] or cached['request_sha256']!=c['request_sha256']:raise RuntimeError('Noncomparable result')
        a=response['answers'];calls=sorted([r for r in attempts if r['case_id']==c['id']],key=lambda r:r['attempt'])
        start=datetime.fromisoformat(calls[0]['started_at'].replace('Z','+00:00')).timestamp()
        end=datetime.fromisoformat(calls[-1]['started_at'].replace('Z','+00:00')).timestamp()+calls[-1]['latency_seconds'];elapsed=end-start
        if elapsed*1000>c['period_ms']:late.add(c['id'])
        for arm in accepted:accepted[arm][c['id']]=a['follow_'+arm]['choice']=='FOLLOW'
        ref=reference_trade(c,markets[c['group_id']],1)
        rows.append({'case_id':c['id'],'group_id':c['group_id'],'block':c['block'],'symbol':c['symbol'],'interval':c['interval'],'side':c['signal']['side'],
                     'decision_time':c['decision_time'],'previous_signal_time':c['previous_signal']['time'],'segment_bars':len(c['segment']),
                     'neutral_follow':accepted['neutral'][c['id']],'conservative_follow':accepted['conservative'][c['id']],
                     'probability':a['profitable']['noul'],'reason':a['reason']['choice'],'readback_correct':a['signal_readback']['choice']==c['signal']['side'].upper(),
                     'late':c['id'] in late,'available_after_seconds':elapsed,'latency_seconds':cached['latency_seconds'],'reference':ref,
                     'actual_profitable':ref['net_pnl']>0 if ref['valid'] and ref['status']=='closed' else None,
                     'model':response['model'],'cost':response.get('usage',{}).get('cost',0),'input_tokens':response.get('usage',{}).get('input_tokens',0)})
    if missing:write_json(out/'missing.json',missing);raise RuntimeError(f'{len(missing)} missing responses; no complete-study conclusion is allowed')
    group_ledgers={};group_results=[]
    for group in manifest['groups']:
        gid=group['id'];sub=[c for c in cases if c['group_id']==gid];market=markets[gid];all_follow={c['id']:True for c in sub}
        ledgers={'source_next_open':replay(sub,{market['symbol']:market},all_follow,0),'source_delayed':replay(sub,{market['symbol']:market},all_follow,1),
          'availability_matched':replay(sub,{market['symbol']:market},all_follow,1,late),'jev_neutral':replay(sub,{market['symbol']:market},accepted['neutral'],1,late),
          'jev_conservative':replay(sub,{market['symbol']:market},accepted['conservative'],1,late),'always_skip':replay(sub,{market['symbol']:market},{},1),
          'long_only':replay(sub,{market['symbol']:market},{c['id']:c['signal']['side']=='long' for c in sub},1),
          'short_only':replay(sub,{market['symbol']:market},{c['id']:c['signal']['side']=='short' for c in sub},1)}
        group_ledgers[gid]=ledgers;grows=[r for r in rows if r['group_id']==gid];valid=[r for r in grows if r['actual_profitable'] is not None]
        group_results.append({**group,'follow':sum(r['neutral_follow'] for r in grows),'conservative_follow':sum(r['conservative_follow'] for r in grows),
          'classification':classification([r['neutral_follow'] for r in valid],[r['actual_profitable'] for r in valid]),
          'ledgers':{k:v['metrics'] for k,v in ledgers.items()},'delta_vs_delayed':ledgers['jev_neutral']['metrics']['total_net_pnl']-ledgers['source_delayed']['metrics']['total_net_pnl'],
          'delta_vs_long_only':ledgers['jev_neutral']['metrics']['total_net_pnl']-ledgers['long_only']['metrics']['total_net_pnl']})
    valid=[r for r in rows if r['actual_profitable'] is not None];actual=[r['actual_profitable'] for r in valid]
    classifiers={arm:classification([r[arm+'_follow'] for r in valid],actual) for arm in ('neutral','conservative')}
    classifiers['always_follow']=classification([True]*len(valid),actual);classifiers['always_skip']=classification([False]*len(valid),actual)
    positive=[r for r in valid if r['actual_profitable']];negative=[r for r in valid if not r['actual_profitable']]
    auc=sum((a['probability']>b['probability'])+.5*(a['probability']==b['probability']) for a in positive for b in negative)/(len(positive)*len(negative)) if positive and negative else None
    totals={method:pooled_metrics([g[method] for g in group_ledgers.values()]) for method in METHODS}
    aggregates=[]
    for field in ('symbol','interval','block'):
        for value in sorted(set(g[field] for g in group_results)):
            selected=[g['id'] for g in group_results if g[field]==value]
            aggregates.append({'field':field,'value':value,'groups':len(selected),'methods':{method:pooled_metrics([group_ledgers[gid][method] for gid in selected]) for method in METHODS}})
    best=max(group_results,key=lambda g:g['ledgers']['jev_neutral']['total_net_pnl'])
    summary={'count':len(rows),'target':200,'groups':len(group_results),'excluded':manifest['excluded'],'model_versions':sorted(set(r['model'] for r in rows)),
      'neutral_follow':sum(r['neutral_follow'] for r in rows),'conservative_follow':sum(r['conservative_follow'] for r in rows),
      'by_side':{side:{'n':sum(r['side']==side for r in rows),'follow':sum(r['neutral_follow'] for r in rows if r['side']==side)} for side in ('long','short')},
      'readback_correct':sum(r['readback_correct'] for r in rows),'late_responses':len(late),'classification':classifiers,'probability_auc':auc,
      'paired_disagreements':sum(r['neutral_follow']!=r['conservative_follow'] for r in rows),'reason_counts':dict(Counter(r['reason'] for r in rows)),
      'methods':totals,'group_results':group_results,'aggregates':aggregates,'groups_improved_vs_delayed':sum(g['delta_vs_delayed']>0 for g in group_results),
      'groups_improved_vs_long_only':sum(g['delta_vs_long_only']>0 for g in group_results),'positive_jev_groups':sum(g['ledgers']['jev_neutral']['total_net_pnl']>0 for g in group_results),
      'largest_jev_group':best['id'],'net_without_best_group':totals['jev_neutral']['total_net_pnl']-best['ledgers']['jev_neutral']['total_net_pnl'],
      'cost_usd':sum(r['cost'] or 0 for r in rows),'input_tokens':sum(r['input_tokens'] or 0 for r in rows),'attempts':len(read_lines(out/'attempt-reservations.jsonl')),
      'failures':sum(a['status']!=200 for a in attempts),'latency_median_seconds':statistics.median(r['latency_seconds'] for r in rows),
      'latency_p95_seconds':sorted(r['latency_seconds'] for r in rows)[max(0,int(.95*len(rows))-1)],'max_available_after_seconds':max(r['available_after_seconds'] for r in rows)}
    write_json(out/'summary.json',summary);write_json(out/'scored-cases.json',rows);write_json(out/'group-ledgers.json',group_ledgers)
    fields=['case_id','group_id','block','symbol','interval','side','decision_time_utc','previous_signal_time_utc','segment_bars','neutral_follow','conservative_follow','probability','reason','readback_correct','late','available_after_seconds','reference_status','if_follow_entry_price','if_follow_exit_price','if_follow_net_pnl','actual_profitable']
    with (out/'signals.csv').open('w',newline='') as file:
        writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
        for r in rows:
            ref=r['reference'];flat={k:r.get(k) for k in fields};flat.update(decision_time_utc=iso(r['decision_time']),previous_signal_time_utc=iso(r['previous_signal_time']),reference_status=ref.get('status',ref.get('reason')))
            flat.update({f'if_follow_{k}':ref.get(k) for k in ('entry_price','exit_price','net_pnl')});writer.writerow(flat)
    fields=['group_id','method','case_id','symbol','side','status','entry_time_utc','exit_time_utc','quantity','entry_price','exit_price','fees','funding_cost','net_pnl']
    with (out/'trades.csv').open('w',newline='') as file:
        writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
        for gid,ledgers in group_ledgers.items():
            for method,ledger in ledgers.items():
                for t in ledger['trades']:
                    row={k:t.get(k) for k in fields};row.update(group_id=gid,method=method,entry_time_utc=iso(t['entry_time']),exit_time_utc=iso(t['exit_time']));writer.writerow(row)
    print(json.dumps({k:summary[k] for k in ('count','neutral_follow','conservative_follow','by_side','classification','groups_improved_vs_delayed','groups_improved_vs_long_only','cost_usd')},ensure_ascii=False,indent=2))
    for method,m in totals.items():print(method,{k:m[k] for k in ('trades','win_rate','total_net_pnl','open_positions')})


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['prepare','run','score']);p.add_argument('--out',type=Path,default=OUT);a=p.parse_args()
    try:globals()[a.command](a.out)
    except Exception as error:print('STOP: '+redact(error),file=sys.stderr);sys.exit(1)
