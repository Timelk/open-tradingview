import {describe,expect,it} from 'vitest';
import {detectHuzi,envelope,headShoulders} from '../src/lib/patterns/huzi';
import {shoulderSetups,shouldersMessages} from '../src/lib/patterns/huzi-shoulders';
import type {Pivot} from '../src/lib/patterns/pivots';
import type {PatternMatch} from '../src/lib/patterns/types';
import {STEP_MS,viewOf} from './fixtures/huzi-synthetic';
import {plantShoulders,wickThroughHead,type PlantedShoulders,type ShoulderPlan,type SubStructure} from './fixtures/huzi-shoulders-planted';
import {untranslated} from './fixtures/huzi-english';

const params={pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true,minStructureBars:0,multiScale:false,family:'头肩形'};
const detect=(p:PlantedShoulders,extra:Record<string,unknown>={},cut=p.bars.length)=>detectHuzi(viewOf(p.bars,cut),{...params,...extra});
const headName=(top:boolean)=>top?'头肩顶':'头肩底';
const complexOf=(matches:PatternMatch[])=>matches.filter(m=>m.points.length>5&&!m.name.includes('+')&&!m.name.includes('中继'));
const compositeOf=(matches:PatternMatch[])=>matches.filter(m=>m.name.includes('+'));
const spanBars=(m:PatternMatch)=>(m.points.at(-1)!.time-m.points[0].time)/STEP_MS;
const SUB_NAMES:Record<SubStructure,[string,string]>={ // [as a top, as a bottom]
  wedge:['上升楔形','下降楔形'],'up-channel':['上升通道','下降通道'],'down-channel':['下降通道','上升通道'],triangle:['对称三角形','对称三角形'],
};

describe('complex shoulders',()=>{
  it.each([true,false])('finds a double-peak right shoulder the five-point template cannot see (top=%s)',top=>
    [false,true].forEach(structuralSwings=>{
      const p=plantShoulders({top,right:'double-peak'});
      // Without the extension nothing is found: the newer, higher peak also kills the shoulder R1 as a plain R.
      expect(complexOf(detect(p,{structuralSwings,extraStructures:false}))).toEqual([]);
      expect(detect(p,{structuralSwings,extraStructures:false}).filter(m=>m.name===headName(top))).toEqual([]);
      // Independent of the amplitude level: the interior swing is deeper than 38.2% of its leg.
      const [match]=complexOf(detect(p,{structuralSwings}));
      expect(match).toBeDefined();
      expect(match.name).toBe(headName(top));
      expect(match.direction).toBe(top?'bearish':'bullish');
      expect(match.points.map(x=>x.label)).toEqual(['L','N1','H','N2','s1','s2','R']);
      expect(match.ratios.find(r=>r.label==='肩部内部拐点数')?.value).toBe(2);
      expect(match.description).toContain('复杂肩部：左肩区 0 个、右肩区 2 个内部拐点');
      // The right shoulder is the newest, highest pivot; the stop is that peak.
      expect(top?match.invalidation>match.points[6].value:match.invalidation<match.points[6].value).toBe(true);
    }));

  it('finds a double-peak left shoulder, and both shoulders complex',()=>{
    const left=complexOf(detect(plantShoulders({left:'double-peak'})));
    expect(left).toHaveLength(1);
    expect(left[0].points.map(x=>x.label)).toEqual(['L','s1','s2','N1','H','N2','R']);
    expect(left[0].description).toContain('左肩区 2 个、右肩区 0 个');
    const both=complexOf(detect(plantShoulders({left:'double-peak',right:'double-peak'})));
    expect(both).toHaveLength(1);
    expect(both[0].points).toHaveLength(9);
    expect(both[0].description).toContain('左肩区 2 个、右肩区 2 个');
    expect(complexOf(detect(plantShoulders({left:'double-peak'}),{extraStructures:false}))).toEqual([]);
  });

  it('also offers the continuation reading: the head has to be reclaimed, and then the classic top is void',()=>{
    for(const top of [true,false]){
      const p=plantShoulders({top,left:'double-peak',breakout:'head'});
      const matches=detect(p).filter(m=>m.points.length===7);
      expect(matches.map(m=>m.name)).toEqual([top?'头肩中继上破':'头肩中继下破']);
      const [cont]=matches;
      expect(cont.direction).toBe(top?'bullish':'bearish');
      expect(cont.id.endsWith(':continuation')).toBe(true);
      expect(cont.points.map(x=>x.label)).toEqual(['L','s1','s2','N1','H','N2','R']);
      expect(detect(p,{extraStructures:false}).filter(m=>m.points.length===7)).toEqual([]);
      // The classic reading of the same anchors does not survive a close beyond the head.
      expect(detect(p).filter(m=>m.name===headName(top))).toEqual([]);
    }
  });

  it('does not repeat a plain five-point structure as a complex one',()=>{
    const p=plantShoulders({});
    const on=detect(p),off=detect(p,{extraStructures:false});
    expect(on).toEqual(off);
    expect(on.length).toBeGreaterThan(0);
    expect(on.every(m=>m.points.length===5)).toBe(true);
  });

  it('rejects a shoulder whose interior pullback already broke the neckline',()=>{
    // Same shape, same neckline; only the left dip differs: 101.5 stays above the (falling) neckline, 100.4 does not.
    const ok=complexOf(detect(plantShoulders({left:'double-peak',neck2:97,leftDip:101.5})));
    expect(ok).toHaveLength(1);
    expect(complexOf(detect(plantShoulders({left:'double-peak',neck2:97,leftDip:100.4})))).toEqual([]);
  });

  it('is voided when a wick goes beyond the head before the breakout, and never when the right shoulder is above the head',()=>{
    const wicked=plantShoulders({right:'double-peak'});wickThroughHead(wicked);
    expect(detect(wicked).filter(m=>m.name===headName(true))).toEqual([]);
    const above=plantShoulders({right:'double-peak',shoulderAboveHead:true});
    expect(detect(above)).toEqual(detect(above,{extraStructures:false}));
    expect(complexOf(detect(above))).toEqual([]);
  });

  it('is found on noisy price, with the seeded noise fixed',()=>{
    let found=0;
    for(let seed=1;seed<=8;seed++){
      const p=plantShoulders({right:'double-peak',seed,noise:.25});
      const [match]=complexOf(detect(p));
      if(match){found++;expect(match.points[2].value).toBeGreaterThan(match.points[6].value);}
    }
    expect(found).toBeGreaterThanOrEqual(7);
  });
});

describe('head and shoulders with a structure in the right shoulder',()=>{
  const cases:Array<[SubStructure,'down'|'up',boolean]>=[];
  for(const kind of ['wedge','up-channel','down-channel','triangle'] as const)for(const breakout of ['down','up'] as const)for(const top of [true,false])cases.push([kind,breakout,top]);
  it.each(cases)('names %s broken %s (top=%s) after its sub-structure and follows the closing breakout',(kind,breakout,top)=>{
    const p=plantShoulders({top,right:kind,breakout});
    expect(compositeOf(detect(p,{extraStructures:false}))).toEqual([]);
    const found=compositeOf(detect(p));
    expect(found).toHaveLength(1);
    const [match]=found;
    expect(match.name).toBe(`${headName(top)} + ${SUB_NAMES[kind][top?0:1]}`);
    expect(match.family).toBe('huzi-head-shoulders');
    // A top whose shoulder breaks down (or a bottom whose shoulder breaks up) completes the formation.
    expect(match.direction).toBe((breakout==='down')===top?'bearish':'bullish');
    expect(match.points[2].label).toBe('H');
    expect(match.guides?.map(g=>g.role).sort()).toEqual(['lower','upper']);
    expect(match.description).toContain('突破方向由该子结构的收盘突破决定');
    expect(match.ratios.some(r=>r.label==='子结构高度 / 头部高度')).toBe(true);
  });

  it('gives no composite when a wick passes the head before the sub-structure breaks',()=>{
    for(const kind of ['wedge','up-channel','triangle'] as const){
      const p=plantShoulders({right:kind});wickThroughHead(p,4);
      expect(compositeOf(detect(p))).toEqual([]);
    }
  });

  it('is found on noisy price',()=>{
    let found=0;
    for(let seed=1;seed<=8;seed++)if(compositeOf(detect(plantShoulders({right:'wedge',seed,noise:.25}))).length>0)found++;
    expect(found).toBeGreaterThanOrEqual(7);
  });

  it('needs the right-shoulder peak inside the sub-structure',()=>{
    // R stands beside the head; the small triangle after the long fall sits at the neckline, far under it.
    const pivot=(index:number,value:number,kind:Pivot['kind']):Pivot=>({index,time:index*STEP_MS,value,kind,confirmedAt:(index+4)*STEP_MS});
    const stack=[pivot(0,90,'low'),pivot(10,112,'high'),pivot(24,100,'low'),pivot(44,125,'high'),pivot(60,100.5,'low'),pivot(72,112,'high'),
      pivot(82,101,'low'),pivot(90,104,'high'),pivot(98,101,'low'),pivot(106,104,'high'),pivot(114,101,'low')];
    const rows=Array.from({length:120},(_,i)=>{const next=stack.findIndex(q=>q.index>=i),a=stack[Math.max(0,next-1)],b=stack[next<0?stack.length-1:next];
      return a===b||b.index===a.index?a.value:a.value+(b.value-a.value)*(i-a.index)/(b.index-a.index);});
    const price={open:Float64Array.from(rows),close:Float64Array.from(rows),high:Float64Array.from(rows),low:Float64Array.from(rows)};
    // The pieces are individually valid...
    expect(headShoulders([stack[1],stack[2],stack[3],stack[4],stack[5]],3,.04)).toBeDefined();
    expect(envelope(stack.slice(-5),3,.04)).toBeDefined();
    // ...but a triangle that does not contain the shoulder is not the shoulder.
    expect(shoulderSetups(stack,3,.04,price).filter(s=>s.name.includes('+'))).toEqual([]);
  });
});

describe('shoulderSetups on a hand-built stack',()=>{
  const pivot=(index:number,value:number,kind:Pivot['kind']):Pivot=>({index,time:index*STEP_MS,value,kind,confirmedAt:(index+4)*STEP_MS});
  const flatPrice=(length:number,stack:Pivot[])=>{
    const rows=Array.from({length},(_,i)=>{const next=stack.findIndex(q=>q.index>=i),a=stack[Math.max(0,next-1)],b=stack[next<0?stack.length-1:next];
      return b.index===a.index?a.value:a.value+(b.value-a.value)*(i-a.index)/(b.index-a.index);});
    return {open:Float64Array.from(rows),close:Float64Array.from(rows),high:Float64Array.from(rows),low:Float64Array.from(rows)};
  };
  const complex=(right=113)=>[pivot(0,90,'low'),pivot(10,112,'high'),pivot(24,100,'low'),pivot(44,125,'high'),pivot(62,100,'low'),pivot(76,111,'high'),pivot(84,104.5,'low'),pivot(94,right,'high')];

  it('builds the complex reading: full pivot path, the head marked, the stop at the right shoulder',()=>{
    const stack=complex();
    const setups=shoulderSetups(stack,3,.04,flatPrice(100,stack));
    expect(setups.map(s=>s.name)).toEqual(['头肩顶','头肩中继上破']);
    const [classic]=setups;
    expect(classic.pivots.map(p=>p.index)).toEqual([10,24,44,62,76,84,94]);
    expect(classic.headAt).toBe(2);
    expect(classic.stop).toBe(113);
    expect(classic.labels).toEqual(['L','N1','H','N2','s1','s2','R']);
    expect(classic.neckline).toBeDefined();
  });

  it('needs the newest pivot to be the highest one right of the head',()=>{
    for(const right of [110,111])expect(shoulderSetups(complex(right),3,.04,flatPrice(100,complex(right)))).toEqual([]);
  });

  it('leaves exactly five anchors in a row to the ordinary template',()=>{
    const stack=[pivot(0,90,'low'),pivot(1,91,'high'),pivot(10,112,'high'),pivot(24,100,'low'),pivot(44,125,'high'),pivot(62,100,'low'),pivot(90,112,'high')].filter((_,i)=>i!==1);
    expect(shoulderSetups(stack,3,.04,flatPrice(100,stack))).toEqual([]);
  });

  it('is causal: nothing after the newest pivot is read',()=>{
    const stack=complex(),price=flatPrice(100,stack),plain=shoulderSetups(stack,3,.04,price);
    const future={...price,high:Float64Array.from(price.high,(v,i)=>i>94?999:v),low:Float64Array.from(price.low,(v,i)=>i>94?-999:v)};
    expect(shoulderSetups(stack,3,.04,future)).toEqual(plain);
    // A bar before the newest pivot that goes beyond the head does count.
    const spiked={...price,high:Float64Array.from(price.high,(v,i)=>i===80?130:v)};
    expect(shoulderSetups(stack,3,.04,spiked)).toEqual([]);
  });
});

describe('the shoulder readings inside the detector',()=>{
  const plans:ShoulderPlan[]=[{right:'double-peak'},{left:'double-peak'},{right:'wedge'},{right:'triangle',breakout:'up'}];

  it('is deterministic',()=>{
    for(const plan of plans){const p=plantShoulders({...plan,seed:3,noise:.2});expect(detect(p)).toEqual(detect(p));}
  });

  it('reads only closed candles: each confirmation exists from its own candle on, and later data cannot change it',()=>{
    for(const plan of plans){
      const p=plantShoulders(plan);
      const target=detect(p).find(m=>m.points.length>5||m.name.includes('+'))!;
      expect(target).toBeDefined();
      const at=target.confirmedAt/STEP_MS;
      // The breakout candle is `at - 1`: it is closed once candle `at` (the next one) exists.
      const seen=(cut:number)=>detect(p,{},cut).some(m=>m.id===target.id&&m.confirmedAt===target.confirmedAt);
      expect(seen(at+1)).toBe(true);
      expect(seen(at)).toBe(false);
      // Garbage after the closed prefix is invisible.
      const noisy={...p,bars:p.bars.map((row,i)=>i>at?[row[0],1,999,-999,500,100] as PlantedShoulders['bars'][number]:row)};
      const view={...(viewOf(noisy.bars) as object),closedLength:at} as never;
      expect(detectHuzi(view,{...params}).some(m=>m.id===target.id&&m.confirmedAt===target.confirmedAt)).toBe(true);
    }
  });

  it('honours the minimum structure span',()=>{
    for(const plan of plans){
      const p=plantShoulders(plan),target=detect(p).find(m=>m.points.length>5||m.name.includes('+'))!;
      const span=Math.round(spanBars(target));
      expect(detect(p,{minStructureBars:span}).some(m=>m.id===target.id)).toBe(true);
      expect(detect(p,{minStructureBars:span+1}).some(m=>m.id===target.id)).toBe(false);
    }
  });

  it('is off with the extended-structures switch and untouched by the other families',()=>{
    for(const plan of plans){
      const p=plantShoulders(plan);
      expect(detect(p,{extraStructures:false}).filter(m=>m.points.length>5||m.name.includes('+'))).toEqual([]);
      expect(detect(p,{family:'三角形'})).toEqual(detect(p,{family:'三角形',extraStructures:false}));
    }
  });

  it('is fully translated (names, ratios, labels and the sentences it adds)',()=>{
    for(const plan of [...plans,{right:'down-channel'},{right:'up-channel',top:false},{left:'double-peak',right:'double-peak',top:false}] as ShoulderPlan[]){
      const shown=detect(plantShoulders(plan)).filter(m=>m.points.length>5||m.name.includes('+'));
      expect(shown.length).toBeGreaterThan(0);
      for(const match of shown)expect(untranslated(match)).toEqual([]);
    }
    expect(Object.keys(shouldersMessages).filter(key=>key.includes(' + '))).toHaveLength(16);
  });
});
