import {it,expect} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {selectPatterns} from '../src/lib/patterns/selection';
import type {ColumnView} from '../src/lib/core/types';
import type {PatternMatch} from '../src/lib/patterns/types';

function fixture(){
  const turns=[[0,100],[10,110],[20,90],[30,110],[40,98],[50,110],[55,106],[63,115],[70,115]],store=new ColumnStore();let leg=0;
  for(let i=0;i<=70;i++){while(leg+1<turns.length-1&&i>turns[leg+1][0])leg++;const a=turns[leg],b=turns[leg+1],v=a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0]);store.appendBar({time:i*60000,open:v,close:v,high:v+.1,low:v-.1,volume:1});}
  return store;
}
it('processes the actual exchange closing packet without inventing a chart candle or waiting for the next one',()=>{
  const reg=new IndicatorRegistry();registerBuiltins(reg);
  const def=reg.get('pattern-huzi'),params={...reg.defaults(def.id),pivotStrength:2,family:'三角形'};
  const whole=fixture(),known=def.calc({cols:whole,from:0,to:whole.length},params).flatMap(s=>s.patterns??[]).find(p=>p.name==='上升三角形')!;
  const store=new ColumnStore();for(let i=0;i<known.confirmedAt/60000;i++)store.appendBar({time:whole.timeAt(i),open:whole.col('open')[i],high:whole.col('high')[i],low:whole.col('low')[i],close:whole.col('close')[i],volume:whole.col('volume')[i]});
  const runner=def.createIncremental!(params),forming=runner.update(store,0);
  expect(forming.flatMap(s=>s.patterns??[]).some(p=>p.id===known.id)).toBe(false);
  const view:ColumnView={length:store.length,closedLength:store.length,col:name=>store.col(name)};
  const confirmed=runner.update(view,store.length-1),match=confirmed.flatMap(s=>s.patterns??[]).find(p=>p.id===known.id)!;
  expect(match.confirmedAt).toBe(known.confirmedAt);expect(confirmed[0].patternScan?.throughTime).toBe(store.timeAt(store.length-1));
  const patterns=confirmed[0].patterns,scan=confirmed[0].patternScan;
  const next=whole.col('close')[store.length];store.appendBar({time:known.confirmedAt,open:next,close:next,high:next+.1,low:next-.1,volume:1});
  const nextOpen=runner.update(store,store.length-1);
  expect(nextOpen[0].patterns).toBe(patterns);expect(nextOpen[0].patternScan).toBe(scan);
});
it('filters display limits independently without changing historical detection results',()=>{
  const values=Array.from({length:20},(_,i)=>({id:String(i),confirmedAt:i,status:i%2?'invalidated':'confirmed'} as PatternMatch));
  expect(selectPatterns(values,{maxPatterns:3,historyDisplay:'active'}).map(p=>p.id)).toEqual(['18','10','0']);
  expect(selectPatterns(values,{maxPatterns:3,historyDisplay:'all'}).map(p=>p.id)).toEqual(['19','10','0']);
  expect(values).toHaveLength(20);expect(values[0].id).toBe('0');
});
