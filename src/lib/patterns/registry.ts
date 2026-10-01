import type {ColumnName,ColumnView,DerivedSeries,IncrementalCalculator,IndicatorDef,ParamSchema,ParamValues} from '../core/types';
import type {PatternCandidate,PatternMatch,PatternScan} from './types';
import {detectHuzi} from './huzi';
import {MIN_STRUCTURE_BARS,EARLY_MIN_BARS,FLAG_POLE_RATIO} from './huzi-defaults';
import {detectHarmonics,HARMONIC_FAMILIES} from './harmonic';
import {detectConfluence,detectConfluenceCandidates,CONFLUENCE_FAMILIES} from './confluence';
import {PATTERN_POOL_LIMIT} from './selection';
import {detectHuziCandidates} from './huzi-candidates';
import {detectHarmonicCandidates} from './harmonic-candidates';
import {ClosedRangeIndex} from '../analysis/closed-range-index';
import {evidenceBarCount,evidenceView,planEvidenceWindows,type EvidenceWindow} from '../analysis/evidence-window';
import {DEFAULT_OBSERVATION_RATIO,refreshPatternKnowledge} from './knowledge-lifecycle';

type Detector=(cols:ColumnView,params:ParamValues)=>PatternMatch[];
type CandidateDetector=(cols:ColumnView,params:ParamValues,confirmed:readonly PatternMatch[])=>PatternCandidate[];
export {MIN_STRUCTURE_BARS,EARLY_MIN_BARS,FLAG_POLE_RATIO} from './huzi-defaults';
/** Harmonic ratio tolerance default; saved legacy 0.04 values migrate once. */
export const HARMONIC_TOLERANCE=.06;
const integer=(value:unknown,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value))):fallback;

/** Work is bounded by scan depth and runs once per closed bar in the indicator
 * worker. Price ticks reuse immutable results; they never scan a million bars. */
class PatternCalculator implements IncrementalCalculator {
  private output:DerivedSeries[]=[];
  private lastTime=-1;private lastClose=NaN;private firstTime=NaN;
  private buffer:ArrayBufferLike|undefined;private previousClosed=-1;
  private matches:PatternMatch[]=[];private candidateKey='';private candidateGeometry='';private planKey='';
  private index?:ClosedRangeIndex;
  private cache=new Map<string,{window:EvidenceWindow;matches:PatternMatch[];capped:boolean}>();
  constructor(private detect:Detector,private params:ParamValues,private detectCandidates?:CandidateDetector){}
  update(cols:ColumnView,from:number):DerivedSeries[] {
    const n=Math.max(0,Math.min(cols.length,cols.closedLength??cols.length-1)),closed=n-1,times=cols.col('time'),time=times[closed],close=cols.col('close')[closed];
    const reset=this.buffer!==times.buffer||this.firstTime!==times[0]||n<this.previousClosed;
    const changed=!this.output.length||reset||n!==this.previousClosed||time!==this.lastTime||close!==this.lastClose||from<=closed;
    const depth=integer(this.params.lookback,1500,100,10000),strength=integer(this.params.pivotStrength,3,1,30),started=performance.now();
    const plan=planEvidenceWindows(cols,n),key=plan.windows.map(w=>w.key).join('|');
    if(changed){
      if(!this.index||reset){this.index=new ClosedRangeIndex(cols,n);this.cache.clear();}
      else{this.index.update(cols,n,from);for(const [id,value] of this.cache)if(from<value.window.end)this.cache.delete(id);}
    }
    if(changed||key!==this.planKey||!this.output.length){
      if(changed&&plan.mode==='full')this.cache.clear();
      const found=new Map<string,PatternMatch>();let capped=false;
      for(const window of plan.windows){
        let cached=this.cache.get(window.key);
        if(!cached){
          const source=evidenceView(cols,window),all=this.detect(confirmedPatternView(source,source.closedLength!,10000),{...this.params,lookback:Math.max(50,window.end-window.start),pivotStrength:strength,maxPatterns:PATTERN_POOL_LIMIT,showInvalidated:true});
          const ownerFrom=times[window.coreStart],ownerTo=window.coreEnd<n?times[window.coreEnd]:Infinity;
          cached={window,matches:plan.mode==='full'?all:all.filter(p=>p.confirmedAt>=ownerFrom&&p.confirmedAt<ownerTo),capped:all.length>=PATTERN_POOL_LIMIT};
        }
        this.cache.delete(window.key);this.cache.set(window.key,cached);capped ||= cached.capped;
      }
      while(this.cache.size>16)this.cache.delete(this.cache.keys().next().value!);
      capped ||= [...this.cache.values()].some(value=>value.capped);
      // Archive formation facts only. Every published status is recomputed
      // against current closed knowledge, never inherited from a cached tile.
      for(const cached of this.cache.values())for(const match of cached.matches){
        if(match.confirmedAt>this.index!.knownAt(n-1))continue;
        const existing=found.get(match.id);if(!existing||existing.confirmedAt>match.confirmedAt)found.set(match.id,match);
      }
      const windows=[...this.cache.values()].map(cached=>cached.window);
      const matches=[...found.values()].map(match=>refreshPatternKnowledge(match,this.index!,{retestWindow:Number(this.params.retestWindow??30),observationRatio:Number(this.params.observationRatio??DEFAULT_OBSERVATION_RATIO)}));
      if(plan.mode==='full')this.matches=matches;
      const scan:PatternScan={fromTime:times[Math.min(...windows.map(w=>w.start))]??0,throughTime:times[Math.max(...windows.map(w=>w.end))-1]??0,knowledgeThroughTime:this.index!.knownAt(closed),evidenceRanges:windows.map(w=>({fromTime:times[w.start],throughTime:times[w.end-1]})),scanTruncated:plan.truncated,tileCount:windows.length,bars:evidenceBarCount(windows),requestedBars:plan.requestedBars,confirmationBars:strength,
        matched:matches.length,invalidated:matches.filter(p=>p.status==='invalidated').length,poolLimit:PATTERN_POOL_LIMIT*windows.length,poolCapped:capped,
        durationMs:performance.now()-started,computedAt:Date.now(),scope:plan.mode==='full'?'latest':'viewport',
        ...(plan.mode==='tiles'&&cols.patternWindow?{requestedFromTime:cols.patternWindow.fromTime,requestedThroughTime:cols.patternWindow.toTime}:{}),
        note:plan.mode==='full'?'已加载闭柱使用固定证据窗；缩放仅裁剪图形，结构状态截至当前知识边界。':`按稳定证据分块识别，生命周期按全部已知闭柱核验；缩放不是历史回放。${plan.truncated?'当前范围超过分块预算，仅返回已扫描分块。':''}`};
      const preview=this.output[2];
      this.output=(['bullish','bearish'] as const).map((direction,i)=>{
        let values=this.output[i]?.values;if(!values||values.length<cols.length)values=new Float64Array(Math.max(cols.length,values?.length??0)+1024).fill(NaN);
        return {name:direction==='bullish'?'看涨形态':'看跌形态',values,pane:'main',plot:'patterns',color:direction==='bullish'?'#45c7ae':'#e78a94',patterns:matches.filter(p=>p.direction===direction),patternScan:scan};
      });
      if(preview)this.output.push(preview);this.planKey=key;
    }
    if(changed){
      if(plan.mode==='tiles')this.matches=this.detect(confirmedPatternView(cols,n,depth),{...this.params,lookback:depth,pivotStrength:strength,maxPatterns:PATTERN_POOL_LIMIT,showInvalidated:true});
      this.previousClosed=n;this.lastTime=time;this.lastClose=close;this.firstTime=times[0];this.buffer=times.buffer;
    }
    const candidateKey=[cols.length,n,...(['time','open','high','low','close','volume'] as ColumnName[]).map(name=>cols.col(name)[cols.length-1])].join(':');
    if(this.detectCandidates&&(changed||candidateKey!==this.candidateKey)){
      const previewDepth=Math.min(depth,600),start=Math.max(0,cols.length-previewDepth-62),tail:ColumnView={length:cols.length-start,closedLength:Math.max(0,n-start),intervalMs:cols.intervalMs,col:name=>cols.col(name).subarray(start,cols.length)};
      const candidates=this.detectCandidates(confirmedPatternView(tail,tail.closedLength!,previewDepth),{...this.params,lookback:previewDepth,pivotStrength:strength},this.matches),geometry=JSON.stringify(candidates);
      if(geometry!==this.candidateGeometry||!this.output[2]){
        let values=this.output[2]?.values;if(!values||values.length<cols.length)values=new Float64Array(cols.length+1024).fill(NaN);
        this.output[2]={name:'观察中结构',values,pane:'main',plot:'patterns',color:'#98b7d8',candidates};this.candidateGeometry=geometry;
      }
      this.candidateKey=candidateKey;
    }
    return this.output;
  }
}

/** Detectors exclude a forming tail. On the exchange's closing packet, supply
 * only a time sentinel after confirmed data, never a synthetic plotted candle.
 * Copy at most the bounded scan window, not the million-row chart store. */
function confirmedPatternView(cols:ColumnView,closedLength:number,depth:number):ColumnView {
  if(closedLength<cols.length)return {length:closedLength+1,col:name=>cols.col(name)};
  const from=Math.max(0,closedLength-depth-62),length=closedLength-from;
  const columns={} as Record<ColumnName,Float64Array>;
  for(const name of ['time','open','high','low','close','volume'] as ColumnName[]){
    columns[name]=new Float64Array(length+1).fill(NaN);columns[name].set(cols.col(name).subarray(from,closedLength));
  }
  const interval=length>1?columns.time[length-1]-columns.time[length-2]:60000;
  columns.time[length]=length?columns.time[length-1]+interval:0;
  return {length:length+1,col:name=>columns[name]};
}

const commonInputs:ParamSchema[]=[
  {key:'pivotStrength',label:'拐点左右确认柱数',type:'int',def:3,min:1,max:30,step:1},
  {key:'lookback',label:'历史参考 / 观察态柱数',type:'int',def:1500,min:100,max:10000,step:100},
  {key:'multiScale',label:'多尺度识别（保留大结构）',type:'bool',def:true},
  {key:'tolerance',label:'比率 / 结构容差（0.04 = 4%）',type:'float',def:.04,min:.005,max:.15,step:.005},
  {key:'observationRatio',label:'失效观察期 / 结构跨度（至少24柱）',type:'float',def:DEFAULT_OBSERVATION_RATIO,min:.5,max:20,step:.5},
  {key:'maxPatterns',label:'视口最多展示形态',type:'int',def:50,min:1,max:200,step:1},
  {key:'historyDisplay',label:'历史结构展示',type:'select',def:'active',options:['active','all'],optionLabels:{all:'全部确认历史（含失效）',active:'不展示失效结构'}},
  {key:'showLabels',label:'显示形态名称',type:'bool',def:true},
  {key:'showZones',label:'显示结构 / PRZ 区域',type:'bool',def:true},
  {key:'showTargets',label:'显示全部目标参考线',type:'bool',def:false},
  {key:'showCandidates',label:'显示观察中结构（尚未确认）',type:'bool',def:true},
];

export function patternStrategies():IndicatorDef[] {
  const create=(id:string,name:string,description:string,tags:string[],families:readonly string[],detect:Detector,extraInputs:ParamSchema[]=[],detectCandidates?:CandidateDetector,defaults:Record<string,number>={}):IndicatorDef=>({
    id,name,title:name,description,tags:['形态策略',...tags],kind:'strategy',category:'pattern',source:'builtin',target:'main',
    inputs:[{key:'family',label:'识别形态',type:'select',def:'全部',options:['全部',...families]},...extraInputs,...commonInputs.map(i=>i.key in defaults?{...i,def:defaults[i.key],...(i.key==='tolerance'?{label:`比率 / 结构容差（${defaults[i.key]} = ${Math.round(defaults[i.key]*100)}%）`}:{})}:{...i})],
    calc:(ctx,params)=>new PatternCalculator(detect,params,detectCandidates).update(ctx.cols,0),createIncremental:params=>new PatternCalculator(detect,params,detectCandidates),
  });
  return [
    create('pattern-huzi','胡子形态','三角、楔形、头肩、双底顶与通道旗形；追踪收盘突破、回踩、重返框架与失效。',['胡子观币','三角形','楔形','头肩','W底','M顶','双底','双顶','旗形','通道','突破','回踩','反抽'],['三角形','楔形','头肩形','双底 / 双顶','通道 / 旗形','画门 / 水平带','杯柄 / 圆弧','通道加速'],detectHuzi,[
      {key:'breakoutCloses',label:'突破连续收盘确认柱数',type:'int',def:1,min:1,max:3,step:1},
      {key:'retestWindow',label:'突破后回踩观察柱数',type:'int',def:30,min:3,max:200,step:1},
      {key:'minDoubleSpan',label:'双顶底最小结构跨度（柱）',type:'int',def:6,min:4,max:200,step:1},
      {key:'minDoubleLeg',label:'双顶底单侧最短摆动（柱）',type:'int',def:2,min:1,max:100,step:1},
      {key:'breakoutWaitBars',label:'锚点可知后等待破位（0=自动）',type:'int',def:0,min:0,max:2000,step:1},
      {key:'breakoutWaitRatio',label:'自动等待 / 结构跨度（至少24柱）',type:'float',def:2,min:.5,max:6,step:.25},
      {key:'includeFinerScale',label:'多尺度额外包含较小级别（半径减半）',type:'bool',def:false},
      {key:'allowEarly',label:'包含四点提前突破（无 E 点）',type:'bool',def:false},
      {key:'earlyMinBars',label:'最小提前突破跨度（柱，0=不限）',type:'int',def:EARLY_MIN_BARS,min:0,max:400,step:5},
      {key:'structuralSwings',label:'结构摆动去噪（保留原始尺度）',type:'bool',def:true},
      {key:'minStructureBars',label:'最小结构跨度（柱，0=不限）',type:'int',def:MIN_STRUCTURE_BARS,min:0,max:400,step:5},
      {key:'boundarySearch',label:'贴边触点搜索（像手画：挑触点、线包住价格）',type:'bool',def:true},
      {key:'largeScales',label:'大尺度识别（半径最大 32 倍）',type:'bool',def:true},
      {key:'extraStructures',label:'扩展结构（画门 / 杯柄圆弧 / 通道加速 / 头肩复合）',type:'bool',def:true},
      {key:'flagPoleRatio',label:'旗杆 / 旗形高度（最小倍数）',type:'float',def:FLAG_POLE_RATIO,min:.5,max:6,step:.1},
    ],detectHuziCandidates),
    create('pattern-harmonic','谐波形态','11 家族的多空结构与实时投影：含 Shark、Cypher、Three Drives；标注比例、PRZ 与实际可知时点。',['Harmonic','Gartley','Bat','Butterfly','Crab','Shark','Cypher','Three Drives','ABCD','5-0','斐波那契'],HARMONIC_FAMILIES,detectHarmonics,[{key:'includeAlternateABCD',label:'包含 1.27 / 1.618 延伸 AB=CD',type:'bool',def:true},{key:'structuralSwings',label:'结构摆动去噪（保留原始尺度）',type:'bool',def:true},{key:'driveTimeTolerance',label:'三推动耗时偏差（0.5 = 最长不超过最短1.5倍）',type:'float',def:.5,min:.1,max:1,step:.05},
      {key:'harmonicSignals',label:'显示谐波共振信号（MACD 背离 / ATR / 针形 K）',type:'bool',def:true},
      {key:'atrPeriod',label:'ATR 周期',type:'int',def:14,min:5,max:50,step:1},
      {key:'atrStopMultiple',label:'ATR 止损倍数（“2ATR未扎”）',type:'float',def:2,min:.5,max:6,step:.5},
      {key:'requireDivergence',label:'仅保留带 MACD 背离的谐波',type:'bool',def:false}],detectHarmonicCandidates,{tolerance:HARMONIC_TOLERANCE}),
    create('pattern-confluence','量价共振形态','HSCP 谐波-结构量价共振：融合顺势收敛突破与双背离极值反转，内置量能点火、EMA 顺势与初始盈亏比 R:R 门控。',['HSCP','共振','量价共振','背离','RSI','MACD','放量','突破','反转','收敛'],CONFLUENCE_FAMILIES,detectConfluence,[
      {key:'minVolumeRatio',label:'量能点火阈值（×SMA20）',type:'float',def:1.2,min:.8,max:3,step:.05},
      {key:'minRiskReward',label:'最低初始盈亏比 R:R(T1)',type:'float',def:.45,min:.2,max:2,step:.05},
      {key:'emaPeriod',label:'顺势参考均线周期（EMA）',type:'int',def:50,min:10,max:200,step:5},
      {key:'rsiDivergenceMin',label:'RSI 拐点背离最小差值',type:'float',def:1,min:.5,max:10,step:.5},
      {key:'requireDualDivergence',label:'反转结构要求 RSI+MACD 双背离',type:'bool',def:true},
      {key:'breakoutCloses',label:'突破连续收盘确认柱数',type:'int',def:1,min:1,max:3,step:1},
      {key:'retestWindow',label:'突破后回踩观察柱数',type:'int',def:30,min:3,max:200,step:1},
      {key:'structuralSwings',label:'结构摆动去噪（保留原始尺度）',type:'bool',def:true},
    ],detectConfluenceCandidates),
  ];
}
