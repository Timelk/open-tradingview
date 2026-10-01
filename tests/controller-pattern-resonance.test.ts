import {describe,expect,it,vi} from 'vitest';
import {ChartController,initialState} from '../src/lib/chart/controller';
import {resonanceKey,type ResonanceTag} from '../src/lib/patterns/resonance';
import {emptyScene,layerOf} from '../src/lib/scene/types';
import type {DerivedSeries} from '../src/lib/core/types';
import type {PatternMatch} from '../src/lib/patterns/types';

const H=3_600_000,T0=1_700_000_000_000,D=T0+100*H;
const harmonic=(id:string,dir:'bullish'|'bearish',low=100,high=110,d=D):PatternMatch=>({id:`harmonic:Crab:${id}`,family:'Crab',name:'螃蟹 · Crab',direction:dir,
  points:[-4,-3,-2,-1,0].map((k,i)=>({label:'XABCD'[i],time:d+k*H,value:100+i})),confirmedAt:d+3*H,zone:{low,high},invalidation:90,targets:[120],ratios:[],description:'',status:'confirmed'});
const structure=(id:string,start:number,dir:'bullish'|'bearish'):PatternMatch=>({id:`huzi-triangle:${id}`,family:'huzi-triangle',name:'对称三角形',direction:dir,
  points:[0,1,2,3,4].map(k=>({label:'ABCDE',time:start+k*H/2,value:100+k})),confirmedAt:start+5*H,zone:{low:105,high:106},invalidation:95,targets:[115],ratios:[],description:'',status:'confirmed'});

function harness(options:{pending?:boolean;loading?:boolean}={}){
  const doc=emptyScene();
  doc.indicators=[
    {id:'pattern-harmonic',instanceId:'harm:chart',params:{},timeframe:'chart',hiddenPlots:[]},
    {id:'pattern-harmonic',instanceId:'harm:4h',params:{},timeframe:'4h',hiddenPlots:[]},
    {id:'pattern-huzi',instanceId:'huzi:chart',params:{},timeframe:'chart',hiddenPlots:[]},
    {id:'ema',instanceId:'ema:1',params:{},timeframe:'chart',hiddenPlots:[]},
  ];
  doc.layers=doc.indicators.map(i=>layerOf(i.instanceId,'indicator',i.id));
  // The hidden layer is still analysis.
  doc.layers.find(l=>l.id==='harm:4h')!.visible=false;
  const series=(indicatorId:string,name:string,patterns:PatternMatch[]):DerivedSeries=>({name,indicatorId,plotIndex:0,plot:'patterns',pane:'main',color:'#abc',values:new Float64Array(8),patterns});
  const pools={
    chartUp:[harmonic('up',  'bullish')],chartDown:[harmonic('down','bearish',100,110,D+50*H)],
    fourH:[harmonic('four','bullish',104,114,D+H)],huzi:[structure('s',D+2*H,'bullish')],
  };
  const derived:DerivedSeries[]=[
    series('harm:chart','看涨形态',pools.chartUp),series('harm:chart','看跌形态',pools.chartDown),
    series('harm:4h','看涨形态',pools.fourH),series('harm:4h','看跌形态',[]),
    series('huzi:chart','看涨形态',pools.huzi),series('ema:1','EMA',[]),
  ];
  derived[5].patterns=undefined;
  const controller=Object.assign(Object.create(ChartController.prototype),{
    engine:{pending:options.pending??false,derived},drawing:{document:doc},patternWindowPending:false,
    state:{...initialState,source:'binance',symbol:'BTCUSDT',interval:'1h',loading:options.loading??false,status:'ok'},publish:vi.fn(),
  });
  return {controller,derived,pools};
}

describe('controller pattern resonance',()=>{
  it('joins the full pools of every pattern layer, the two direction series of a layer as one and hidden layers too',()=>{
    const {controller,pools}=harness();
    const map:Map<string,ResonanceTag[]>=controller.getPatternResonance();
    const up=map.get(resonanceKey('harm:chart',pools.chartUp[0].id))!;
    // The 4h harmonic (a hidden layer) overlaps the 1h one; the triangle starts 2 bars after D on the same timeframe.
    expect(up.map(tag=>tag.kind)).toEqual(['multi-tf','terminal']);
    expect(up[0]).toMatchObject({label:'4h Crab',target:{instanceId:'harm:4h',patternId:pools.fourH[0].id}});
    expect(up[1]).toMatchObject({label:'末端 对称三角形',target:{instanceId:'huzi:chart'}});
    expect(map.get(resonanceKey('harm:4h',pools.fourH[0].id))!.map(tag=>tag.label)).toEqual(['1h Crab','1h 对称三角形 切入']);
    // The bearish one (another direction, far away) has nothing; the triangle and the indicator are not tagged.
    expect(map.has(resonanceKey('harm:chart',pools.chartDown[0].id))).toBe(false);
    expect([...map.keys()].every(key=>key.startsWith('harm:'))).toBe(true);
  });

  it('is read-only and memoised on the identity of the pools',()=>{
    const {controller,derived,pools}=harness();
    const before=structuredClone(pools);
    const first:Map<string,ResonanceTag[]>=controller.getPatternResonance();
    expect(controller.getPatternResonance()).toBe(first);
    expect(pools).toEqual(before);
    derived[4].patterns=[...derived[4].patterns!];
    const second:Map<string,ResonanceTag[]>=controller.getPatternResonance();
    expect(second).not.toBe(first);expect([...second]).toEqual([...first]);
    derived[4].patterns=[];
    expect((controller.getPatternResonance() as Map<string,ResonanceTag[]>).get(resonanceKey('harm:chart',pools.chartUp[0].id))!.map(tag=>tag.kind)).toEqual(['multi-tf']);
  });

  it('answers nothing while the engine is recalculating or the chart is loading',()=>{
    expect(harness({pending:true}).controller.getPatternResonance().size).toBe(0);
    expect(harness({loading:true}).controller.getPatternResonance().size).toBe(0);
  });
});
