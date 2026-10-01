import {describe,expect,it} from 'vitest';
import {migratePatternDisplayParams,patternHistoryMode,patternIntersectsWindow,selectPatterns} from '../src/lib/patterns/selection';
import type {PatternMatch} from '../src/lib/patterns/types';

const hour=3_600_000,day=24*hour;
function pattern(time:number,extra:Partial<PatternMatch>={}):PatternMatch {
  return {id:String(time),family:'huzi-double',name:'W 双底',direction:'bullish',
    points:[{label:'B1',time:time-3*hour,value:90},{label:'N',time:time-2*hour,value:100},{label:'B2',time:time-hour,value:91}],
    confirmedAt:time,zone:{low:99,high:101},invalidation:89,targets:[110],ratios:[],description:'',status:'confirmed',...extra};
}

describe('viewport history selection',()=>{
  it('does not pull an offscreen old shape into view for an auxiliary target touch unless references are enabled',()=>{
    const value=pattern(10*hour,{resolution:{kind:'target-reached',time:30*hour,knownAt:31*hour,price:110,targetIndex:0}});
    const window={fromTime:29*hour,toTime:32*hour};
    expect(selectPatterns([value],{},window)).toEqual([]);
    expect(selectPatterns([value],{showTargets:true},window)).toEqual([value]);
    expect(selectPatterns([value],{},{fromTime:6*hour,toTime:11*hour})).toEqual([value]);
  });
  it('hides invalidated structures by default and only shows them with an explicit opt-in',()=>{
    const old=pattern(Date.UTC(2026,0,10),{status:'invalidated',invalidatedAt:Date.UTC(2026,5,10)});
    const current=pattern(Date.UTC(2026,5,10));
    expect(selectPatterns([old,current],{})).toEqual([current]);
    expect(selectPatterns([old,current],{historyDisplay:'all'})).toEqual([current,old]);
    expect(selectPatterns([old,current],{showInvalidated:false})).toEqual([current]);
    expect(selectPatterns([old,current],{historyDisplay:'active',showInvalidated:true})).toEqual([current]);
    expect(patternHistoryMode({})).toBe('active');
    expect(patternHistoryMode({historyDisplay:'active'})).toBe('active');
  });

  it('retains every month of a half-year view despite a dense most recent month',()=>{
    const sparse=Array.from({length:5},(_,month)=>pattern(Date.UTC(2026,month,15)));
    const dense=Array.from({length:500},(_,i)=>pattern(Date.UTC(2026,5,1)+i*hour));
    const source=[...sparse,...dense],before=source.map(match=>match.id);
    const selected=selectPatterns(source,{}, {fromTime:Date.UTC(2026,0,1),toTime:Date.UTC(2026,6,1)});
    expect(selected).toHaveLength(50);
    expect(new Set(selected.map(match=>new Date(match.confirmedAt).getUTCMonth()))).toEqual(new Set([0,1,2,3,4,5]));
    expect(selected[0]).toBe(dense.at(-1));
    expect(selected.at(-1)).toBe(sparse[0]);
    expect(source.map(match=>match.id)).toEqual(before);
    expect(new Set(selected.map(match=>match.id)).size).toBe(selected.length);
  });

  it('applies the drawing budget after viewport filtering so earlier months remain accessible',()=>{
    const january=Array.from({length:12},(_,i)=>pattern(Date.UTC(2026,0,i+1)));
    const june=Array.from({length:100},(_,i)=>pattern(Date.UTC(2026,5,1)+i*hour));
    const window={fromTime:Date.UTC(2026,0,1),toTime:Date.UTC(2026,1,1)};
    const selected=selectPatterns([...january,...june],{maxPatterns:6},window);
    expect(selected).toHaveLength(6);
    expect(selected.every(match=>january.includes(match))).toBe(true);
    expect(selected).toContain(january[0]);
    expect(selected).toContain(january.at(-1));
  });

  it('intersects true geometry even when confirmation lies just outside the viewport',()=>{
    const value=pattern(Date.UTC(2026,0,10));
    const inside={fromTime:value.confirmedAt-2.5*hour,toTime:value.confirmedAt-1.5*hour};
    expect(patternIntersectsWindow(value,inside)).toBe(true);
    expect(selectPatterns([value],{},inside)).toEqual([value]);
    expect(patternIntersectsWindow(value,{fromTime:value.confirmedAt+day,toTime:value.confirmedAt+2*day})).toBe(false);
  });

  it('does not stretch an old structure through six months because a later event invalidated it',()=>{
    const confirmedAt=Date.UTC(2026,0,10),failedAt=Date.UTC(2026,5,10);
    const value=pattern(confirmedAt,{status:'invalidated',invalidatedAt:failedAt,events:[
      {kind:'breakout',time:confirmedAt-hour,knownAt:confirmedAt,value:101,boundary:100},
      {kind:'invalidation',time:failedAt-hour,knownAt:failedAt,value:88,boundary:89},
    ]});
    expect(patternIntersectsWindow(value,{fromTime:confirmedAt-4*hour,toTime:confirmedAt+hour})).toBe(true);
    expect(patternIntersectsWindow(value,{fromTime:Date.UTC(2026,2,1),toTime:Date.UTC(2026,3,1)})).toBe(false);
    expect(patternIntersectsWindow(value,{fromTime:failedAt-hour/2,toTime:failedAt+hour})).toBe(true);
    const noDrawnEvent=pattern(confirmedAt,{status:'invalidated',invalidatedAt:failedAt});
    expect(patternIntersectsWindow(noDrawnEvent,{fromTime:failedAt-hour,toTime:failedAt+hour})).toBe(false);
  });

  it('has deterministic newest-first output, supports custom budgets through 200, and handles tied dates',()=>{
    const values=Array.from({length:300},(_,i)=>pattern(1000,{id:String(i).padStart(3,'0')}));
    expect(selectPatterns(values,{maxPatterns:200})).toHaveLength(200);
    expect(selectPatterns(values,{maxPatterns:1000})).toHaveLength(200);
    expect(selectPatterns(values,{maxPatterns:NaN})).toHaveLength(50);
    expect(selectPatterns(values,{maxPatterns:1})).toHaveLength(1);
    expect(selectPatterns([...values].reverse(),{maxPatterns:25})).toEqual(selectPatterns(values,{maxPatterns:25}));
    expect(selectPatterns([],{maxPatterns:50})).toEqual([]);
  });
});

describe('legacy pattern display migration',()=>{
  it('upgrades the old twelve-result hidden-history default and is idempotent',()=>{
    const old={maxPatterns:12,showInvalidated:false,pivotStrength:6};
    const next=migratePatternDisplayParams(old);
    expect(next).toEqual({maxPatterns:50,historyDisplay:'active',patternDisplayVersion:3,pivotStrength:6});
    expect(old).toEqual({maxPatterns:12,showInvalidated:false,pivotStrength:6});
    expect(migratePatternDisplayParams(next)).toBe(next);
  });
  it('preserves custom limits and explicitly saved new modes',()=>{
    expect(migratePatternDisplayParams({maxPatterns:7,showInvalidated:true})).toEqual({maxPatterns:7,historyDisplay:'active',patternDisplayVersion:3});
    const active={maxPatterns:12,historyDisplay:'active',patternDisplayVersion:2};
    const all={maxPatterns:12,historyDisplay:'all',patternDisplayVersion:2};
    expect(migratePatternDisplayParams(active)).toEqual({...active,patternDisplayVersion:3});
    expect(migratePatternDisplayParams(all)).toEqual({...all,patternDisplayVersion:3});
    expect(migratePatternDisplayParams({pivotStrength:3})).toEqual({pivotStrength:3,historyDisplay:'active',patternDisplayVersion:3});
  });
  it('fills the scale, boundary-search and extended-structure inputs of a classic-pattern layer saved before they existed',()=>{
    const old={pivotStrength:3,tolerance:.04,allowEarly:false,patternDisplayVersion:3};
    const next=migratePatternDisplayParams(old,'pattern-huzi');
    // The four-point option is a choice the migration never makes for the user.
    expect(next).toMatchObject({minStructureBars:20,earlyMinBars:80,flagPoleRatio:1.5,boundarySearch:true,largeScales:true,extraStructures:true,allowEarly:false,pivotStrength:3,tolerance:.04});
    expect(old).toEqual({pivotStrength:3,tolerance:.04,allowEarly:false,patternDisplayVersion:3});
    expect(migratePatternDisplayParams(next,'pattern-huzi')).toBe(next);
  });
  it('never overwrites what a classic-pattern layer already has, and leaves other studies alone',()=>{
    // A layer created after the inputs exist carries every default; the user's later choices survive.
    const current={minStructureBars:60,allowEarly:false,boundarySearch:false,patternDisplayVersion:3};
    expect(migratePatternDisplayParams(current,'pattern-huzi')).toBe(current);
    const partial=migratePatternDisplayParams({boundarySearch:false,largeScales:false,patternDisplayVersion:3},'pattern-huzi');
    expect(partial).toMatchObject({boundarySearch:false,largeScales:false,minStructureBars:20});
    // The confluence study has neither set of inputs and is never rewritten.
    const confluence={pivotStrength:3,patternDisplayVersion:3};
    expect(migratePatternDisplayParams(confluence,'pattern-confluence')).toBe(confluence);
  });
  it('fills the D-point reading-aid inputs of a harmonic layer saved before they existed, once and without overwriting',()=>{
    const old={pivotStrength:3,tolerance:.06,patternDisplayVersion:3};
    const next=migratePatternDisplayParams(old,'pattern-harmonic');
    expect(next).toMatchObject({harmonicSignals:true,atrPeriod:14,atrStopMultiple:2,requireDivergence:false,pivotStrength:3,tolerance:.06});
    expect(old).toEqual({pivotStrength:3,tolerance:.06,patternDisplayVersion:3});
    expect(migratePatternDisplayParams(next,'pattern-harmonic')).toBe(next);
    // A layer that already carries the inputs keeps the user's choices.
    const chosen={harmonicSignals:false,atrStopMultiple:1,requireDivergence:true,patternDisplayVersion:3};
    expect(migratePatternDisplayParams(chosen,'pattern-harmonic')).toBe(chosen);
    // A partially filled layer only gets what is missing.
    const partial={atrStopMultiple:3,patternDisplayVersion:3,tolerance:.06};
    expect(migratePatternDisplayParams(partial,'pattern-harmonic')).toMatchObject({harmonicSignals:true,atrStopMultiple:3,atrPeriod:14,requireDivergence:false});
  });
  it('moves only the untouched legacy harmonic tolerance to the new 6% default',()=>{
    expect(migratePatternDisplayParams({tolerance:.04,patternDisplayVersion:2},'pattern-harmonic')).toMatchObject({tolerance:.06,patternDisplayVersion:3});
    expect(migratePatternDisplayParams({tolerance:.05,patternDisplayVersion:2},'pattern-harmonic').tolerance).toBe(.05);
    expect(migratePatternDisplayParams({tolerance:.04,patternDisplayVersion:2},'pattern-huzi').tolerance).toBe(.04);
    const current={tolerance:.04,patternDisplayVersion:3,harmonicSignals:true};
    expect(migratePatternDisplayParams(current,'pattern-harmonic')).toBe(current);
  });
});
