import type {ColumnName,ColumnView,DerivedSeries,IncrementalCalculator,IndicatorDef,ParamSchema,ParamValues} from '../core/types';
import type {AnalysisObservation,AnalysisFamily} from './types';
import {closedBars,numberParam} from './features';
import {evidenceView,planEvidenceWindows,MAX_EVIDENCE_BARS,type EvidenceWindow} from './evidence-window';
import {ClosedRangeIndex} from './closed-range-index';
import {detectCandlesticks} from './candlesticks';
import {detectMarketStructure,detectSupplyDemand,detectVsa} from './structure';
import {detectWyckoff} from './wyckoff';
import {detectOrderBlocks,detectIctSetups} from './smart-money';
import {detectPointFigure} from './point-figure';
import {detectWolfeWaves,detectElliottWaves} from './waves';
import {detectHurstCycles} from './cycles';
import {detectGann} from './gann';
type Detector=(cols:ColumnView,p:ParamValues)=>AnalysisObservation[];

interface CachedEvidence {window:EvidenceWindow;observations:AnalysisObservation[]}
const CACHE_TILES=16;
/** A viewport chooses evidence tiles, not the clock at which an observation
 * is evaluated. Replay supplies its own closedLength prefix. Quotes and zooms
 * inside the same evidence tiles preserve the existing geometry by identity. */
class AnalysisCalculator implements IncrementalCalculator {
  private output:DerivedSeries[]=[];private length=-1;private firstTime=NaN;private lastTime=NaN;private lastBar='';private windowKey='';
  private buffer:ArrayBufferLike|undefined;private interval:number|undefined;private mode='';
  private cache=new Map<string,CachedEvidence>();private range:ClosedRangeIndex|undefined;
  constructor(private name:string,private detector:Detector,private params:ParamValues){}
  update(cols:ColumnView,from:number):DerivedSeries[]{
    const n=closedBars(cols),times=cols.col('time'),begun=performance.now();
    const lastBar=(['open','high','low','close','volume'] as ColumnName[]).map(name=>cols.col(name)[n-1]).join(':');
    const reset=this.buffer!==times.buffer||this.firstTime!==times[0]||this.interval!==cols.intervalMs||n<this.length;
    const changed=!this.output.length||reset||n!==this.length||times[n-1]!==this.lastTime||lastBar!==this.lastBar||from<n;
    // Hurst is a current trailing model. P&F follows an explicit range; Gann
    // follows its explicit anchor. None may silently rebase on screen zoom.
    const anchored=this.detector===detectGann||this.detector===detectPointFigure||this.detector===detectHurstCycles;
    const rightContext=Math.max(1800,Math.round(numberParam(this.params,'maxLifeBars',300,10,1500))+100,Math.round(numberParam(this.params,'maxRangeBars',240,30,1500))+64);
    const planning=anchored?{...cols,patternWindow:undefined,col:(name:ColumnName)=>cols.col(name)}:cols;
    const plan=planEvidenceWindows(planning,n,planning.patternWindow,{rightContext,maxTiles:8});
    let windows=plan.windows;
    if(anchored&&n){
      let end=n;
      const until=Number(this.params.rangeTo);
      if(this.detector===detectPointFigure&&Number.isFinite(until)&&until>0){let low=0,high=n;while(low<high){const mid=(low+high)>>>1;if(times[mid]<=until)low=mid+1;else high=mid;}end=low;}
      const start=Math.max(0,end-MAX_EVIDENCE_BARS);windows=end?[{key:`anchored:${times[start]}:${end}`,start,end,coreStart:start,coreEnd:end}]:[];
    }
    const key=windows.map(w=>w.key).join('|');
    if(!changed&&key===this.windowKey)return this.output;
    if(reset||this.mode!==plan.mode||anchored||plan.mode==='full')this.cache.clear();
    else if(changed){
      // Recompute a corrected source window; do not merge an old confirmed
      // observation into new evidence after it was removed or invalidated.
      const dirty=Math.min(from,this.length,n,lastBar!==this.lastBar?n-1:n);
      for(const [key,cached] of this.cache)if(dirty<cached.window.end)this.cache.delete(key);
    }
    if(!this.range)this.range=new ClosedRangeIndex(cols,n);
    else if(changed)this.range.update(cols,n,reset?0:Math.min(from,this.length,n,lastBar!==this.lastBar?n-1:n));
    const merged=new Map<string,AnalysisObservation>(),coverage:Array<{start:number;end:number}>=[];
    let sparseAnchor=false;
    for(const window of windows){
      const anchor=Number(this.params.anchorTime),sparse=this.detector===detectGann&&anchor>=times[0]&&anchor<times[window.start];
      const anchorIndex=sparse?Math.max(0,this.range.lowerBound(anchor)-(times[this.range.lowerBound(anchor)]===anchor?0:1)):0;
      const anchorTail=sparse?Math.max(window.start+2,n-(MAX_EVIDENCE_BARS-2)):window.start;
      if(sparse){sparseAnchor=true;coverage.push({start:anchorIndex,end:anchorIndex+2},{start:anchorTail,end:n});}
      else coverage.push(window);
      let cached=this.cache.get(window.key);
      if(!cached){
        let view=evidenceView(cols,window);
        // A manual Gann anchor may be older than the bounded current tail.
        // Keep its real source candles and the current tail, with a real gap
        // between them. The detector then warns that crossings in that gap
        // cannot be inferred, while absolute price/time projection is intact.
        if(sparse){
          const indices=[anchorIndex,anchorIndex+1,...Array.from({length:Math.max(0,n-anchorTail)},(_,i)=>anchorTail+i)];
          const arrays=Object.fromEntries((['time','open','high','low','close','volume'] as ColumnName[]).map(name=>{const source=cols.col(name);return [name,Float64Array.from(indices,i=>source[i])];})) as Record<ColumnName,Float64Array>;
          view={length:indices.length,closedLength:indices.length,intervalMs:cols.intervalMs,col:name=>arrays[name]};
        }
        cached={window,observations:this.detector(view,{...this.params,lookback:Math.min(MAX_EVIDENCE_BARS,view.closedLength??view.length),maxObservations:300})};
        this.cache.set(window.key,cached);
      }else{this.cache.delete(window.key);this.cache.set(window.key,cached);}
    }
    while(this.cache.size>CACHE_TILES)this.cache.delete(this.cache.keys().next().value!);
    // Retain canonical facts from the finite set of already scanned tiles.
    // History edits evict affected source windows above; state is refreshed
    // against the real knowledge boundary below, never unioned as stale state.
    const archive=anchored?windows.map(w=>this.cache.get(w.key)!).filter(Boolean):[...this.cache.values()];
    if(!anchored){coverage.length=0;coverage.push(...archive.map(c=>c.window));}
    for(const {window,observations:known} of archive){
      for(const original of known){
        if(!anchored&&plan.mode==='tiles'){
          // One canonical owner for a fact, independent from how neighbouring
          // viewports happened to include it as warm-up evidence.
          const owner=this.range.lowerBound(original.availableAt);
          if(owner<window.coreStart||owner>=window.coreEnd&&!(window.coreEnd===n&&owner===n))continue;
        }
        const observation=this.detector===detectSupplyDemand?this.currentZone(original,n):this.boundedState(original,window,n);
        const prior=merged.get(observation.id);
        if(!prior||observation.throughTime>prior.throughTime||observation.throughTime===prior.throughTime&&observation.availableAt<prior.availableAt)merged.set(observation.id,observation);
      }
    }
    const observations=[...merged.values()].sort((a,b)=>b.availableAt-a.availableAt||a.id.localeCompare(b.id));
    const missingAnchor=this.detector===detectGann&&(!Number(this.params.anchorTime)||!Number(this.params.anchorPrice));
    const dataWarning=missingAnchor?'Gann 需要明确的时间、价格锚点。在「研究 → 锚点」选择手绘对象，或在模块设置填写。':plan.truncated?'可视范围超过本轮有界证据块覆盖；缩小时间范围可查看其余历史记录。':sparseAnchor?'手动锚点早于当前一万根闭柱；价时标尺保持不变，中间未加载进本轮计算的穿越事件不推断。':undefined;
    const values=this.output[0]?.values?.length>=cols.length?this.output[0].values:new Float64Array(cols.length+1024).fill(NaN);
    const ranges:Array<{start:number;end:number}>=[];for(const range of coverage.sort((a,b)=>a.start-b.start)){const prior=ranges.at(-1);if(prior&&range.start<=prior.end)prior.end=Math.max(prior.end,range.end);else ranges.push({start:range.start,end:range.end});}
    this.output=[{name:this.name,values,pane:'main',plot:'analysis',color:'#88aecb',observations,dataWarning,patternScan:{fromTime:ranges.length?times[ranges[0].start]:0,throughTime:times[(ranges.at(-1)?.end??0)-1]??0,knowledgeThroughTime:n?this.range.knownAt(n-1):0,evidenceRanges:ranges.map(r=>({fromTime:times[r.start],throughTime:times[r.end-1]})),tileCount:archive.length,scanTruncated:plan.truncated||sparseAnchor,bars:ranges.reduce((sum,w)=>sum+w.end-w.start,0),requestedBars:plan.requestedBars,confirmationBars:Number(this.params.pivotStrength??1),scope:'latest',matched:observations.length,invalidated:observations.filter(o=>o.state==='invalidated').length,durationMs:performance.now()-begun,note:plan.mode==='full'?'固定已闭柱证据范围；缩放只裁剪展示，历史回放仅使用回放闭柱前缀。':'有界已扫描证据块；未扫描历史不推断。状态按真实闭柱截止核验，观察期届满或数据缺口独立标记。'}}];
    this.length=n;this.firstTime=times[0];this.lastTime=times[n-1];this.lastBar=lastBar;this.buffer=times.buffer;this.interval=cols.intervalMs;this.windowKey=key;this.mode=plan.mode;return this.output;
  }
  private boundedState(observation:AnalysisObservation,window:EvidenceWindow,n:number):AnalysisObservation{
    if(window.end>=n||observation.state==='invalidated'||observation.trackingEndedAt||observation.dataWarning)return observation;
    // Instantaneous facts need no future lifecycle. A stateful hypothesis whose
    // observation period did not end inside the evidence tile remains limited,
    // rather than being mislabeled as a setup verified through today's candle.
    if(['candlestick','structure','vsa'].includes(observation.family)||this.detector===detectHurstCycles||this.detector===detectPointFigure)return observation;
    return {...observation,dataWarning:'后续状态仅核验到此记录的评估时间；超出本轮证据范围，不代表当前仍有效。'};
  }
  private currentZone(original:AnalysisObservation,n:number):AnalysisObservation{
    if(!original.zone||!this.range)return original;
    const index=this.range,cols=index.cols,bull=original.direction==='bullish',fvg=original.name.startsWith('FVG');
    const from=index.lowerBound(original.time)+1,gap=index.firstInvalid(from,n);
    const invalid=index.firstCross(fvg?bull?'low':'high':'close',from,n,fvg?bull?'lte':'gte':bull?'lt':'gt',bull?original.zone.low:original.zone.high);
    const crossed=invalid>=0&&(gap<0||invalid<gap),last=crossed?invalid:gap>=0?Math.max(0,gap-1):n-1;
    const item:AnalysisObservation={...original,zone:{...original.zone,toTime:cols.col('time')[last]},events:original.events.filter(e=>e.kind!=='invalidation'),state:crossed?'invalidated':'confirmed',throughTime:index.knownAt(last)};
    delete item.invalidatedAt;
    if(crossed){item.invalidatedAt=index.knownAt(invalid);item.events.push({id:`${item.id}:closed`,kind:'invalidation',label:fvg?'已回补':'区域穿越',time:cols.col('time')[invalid],availableAt:item.invalidatedAt,price:cols.col('close')[invalid],explanation:'实际行情达到该区域的撤销条件。'});}
    if(gap>=0&&!crossed)item.dataWarning='后续行情缺口，区域状态暂停。';
    return item;
  }
}
const base:ParamSchema[]=[{key:'lookback',label:'至少补充历史柱数',type:'int',def:1800,min:100,max:10000,step:100},{key:'maxObservations',label:'最多保留观察记录',type:'int',def:60,min:5,max:300,step:5},{key:'showInvalidated',label:'显示已失效记录',type:'bool',def:false},{key:'showLabels',label:'显示事件名称',type:'bool',def:true},{key:'labelMode',label:'图表文字密度',type:'select',def:'compact',options:['compact','all','selected'],optionLabels:{compact:'精简 · 优先选中与近期记录',all:'全部 · 自动避让',selected:'仅选中记录'}},{key:'showZones',label:'显示区间边界',type:'bool',def:true}];
export function analysisIndicators():IndicatorDef[]{
  const create=(id:string,name:string,family:AnalysisFamily,description:string,tags:string[],detector:Detector,inputs:ParamSchema[]):IndicatorDef=>({id,name,title:name,kind:'indicator',category:'analysis',analysisFamily:family,source:'builtin',target:'main',description,tags:['技术分析',...tags],inputs:[...inputs,...base.map(p=>({...p,...(id==='analysis-ict'&&p.key==='lookback'?{def:4000}:{})}))],calc:(ctx,p)=>new AnalysisCalculator(name,detector,p).update(ctx.cols,0),createIncremental:p=>new AnalysisCalculator(name,detector,p)});
  const waveInputs:ParamSchema[]=[{key:'pivotStrength',label:'波段确认柱数',type:'int',def:3,min:1,max:20,step:1},{key:'multiScale',label:'多级别波段',type:'bool',def:true},{key:'showDeveloping',label:'展示尚未完成的计数',type:'bool',def:true}];
  const obInputs:ParamSchema[]=[{key:'pivotStrength',label:'结构确认柱数',type:'int',def:2,min:1,max:10,step:1},{key:'displacementAtr',label:'推进实体 / ATR',type:'float',def:1,min:.25,max:5,step:.1},{key:'breakoutAtr',label:'结构突破距离 / ATR',type:'float',def:.1,min:0,max:2,step:.05},{key:'baseLookback',label:'基底回看柱数',type:'int',def:12,min:2,max:100,step:1},{key:'baseMode',label:'基底选择',type:'select',def:'last-opposite',options:['last-opposite','opposite-cluster'],optionLabels:{'last-opposite':'最后反向柱','opposite-cluster':'反向柱簇'}},{key:'zoneMode',label:'区域边界',type:'select',def:'wick',options:['wick','body','open-to-extreme'],optionLabels:{wick:'全部影线',body:'实体','open-to-extreme':'开盘至极值'}},{key:'requireFvg',label:'要求同次推进产生FVG',type:'bool',def:false},{key:'mitigationDepth',label:'回访深度比例',type:'float',def:.5,min:0,max:1,step:.1},{key:'invalidationMode',label:'失效判定',type:'select',def:'close',options:['close','wick'],optionLabels:{close:'收盘穿越',wick:'影线触及'}},{key:'maxLifeBars',label:'最长观察柱数',type:'int',def:300,min:20,max:3000,step:20}];
  return [
    create('analysis-order-blocks','Order Block 订单块','smc','先出现真实推进和结构突破，再定位已知反向基底；跟踪回访与失效。本平台价格定义，非挂单身份。',['SMC','Order Block','OB','订单块'],detectOrderBlocks,obInputs),
    create('analysis-ict','ICT 会话与事件组合','smc','完整前日/会话参考、扫过后回收、推进与MSS、FVG/OB组合；使用IANA时区与DST。',['ICT','Killzone','MSS','Session','扫流动性'],detectIctSetups,[...obInputs,{key:'timeZone',label:'会话时区',type:'select',def:'America/New_York',options:['America/New_York','Europe/London','UTC','Asia/Shanghai']},{key:'reference',label:'参考区间',type:'select',def:'either',options:['either','day','session'],optionLabels:{either:'前日或前会话',day:'完整前日',session:'完整前会话'}},{key:'sessionStart',label:'参考会话开始（当地分钟）',type:'int',def:1200,min:0,max:1439,step:30},{key:'sessionEnd',label:'参考会话结束（当地分钟）',type:'int',def:0,min:0,max:1439,step:30},{key:'killzoneStart',label:'观察时段开始（当地分钟）',type:'int',def:420,min:0,max:1439,step:30},{key:'killzoneEnd',label:'观察时段结束（当地分钟）',type:'int',def:600,min:0,max:1439,step:30},{key:'killzoneOnly',label:'仅在观察时段产生组合',type:'bool',def:true},{key:'weekdaysOnly',label:'仅当地工作日',type:'bool',def:false},{key:'entryModel',label:'组合区域要求',type:'select',def:'either',options:['fvg','ob','either','both'],optionLabels:{fvg:'FVG',ob:'OB',either:'FVG或OB',both:'同时FVG与OB'}},{key:'maxSetupBars',label:'扫过后组合观察柱数',type:'int',def:18,min:3,max:100,step:1}]),
    create('analysis-point-figure','点数图与区间计数','wyckoff','从闭柱价格构建X/O列，明确格值与反转格数；水平计数是独立测量，不替代威科夫状态。',['Point Figure','P&F','点数图','水平计数'],detectPointFigure,[{key:'boxMode',label:'格值口径',type:'select',def:'price',options:['price','ticks'],optionLabels:{price:'绝对价格',ticks:'最小跳动倍数'}},{key:'boxSize',label:'每格价格',type:'float',def:10,min:.00000001,max:100000,step:1},{key:'tickSize',label:'最小价格跳动（ticks模式）',type:'float',def:0,min:0,max:10000,step:.01},{key:'boxTicks',label:'每格ticks',type:'int',def:10,min:1,max:100000,step:1},{key:'reversal',label:'反转格数',type:'int',def:3,min:1,max:10,step:1},{key:'countColumns',label:'水平计数最多列数',type:'int',def:9,min:5,max:60,step:1},{key:'countPrice',label:'计数价格（0为自动共同行）',type:'float',def:0,min:0,max:10000000,step:1},{key:'rangeFrom',label:'计数起始时间 ms（0为加载起点）',type:'float',def:0,min:0,max:9999999999999,step:60000},{key:'rangeTo',label:'计数截止时间 ms（0为当前闭柱）',type:'float',def:0,min:0,max:9999999999999,step:60000},{key:'includeDeveloping',label:'包含未完成的计数测量',type:'bool',def:false},{key:'measureDirection',label:'测量方向',type:'select',def:'both',options:['both','bullish','bearish'],optionLabels:{both:'双向',bullish:'向上',bearish:'向下'}}]),
    create('analysis-wolfe','Wolfe 五点几何','wave','真实五点、收敛边界与1–4投射；四点候选不伪造第5点。',['Wolfe','沃尔夫','波浪'],detectWolfeWaves,[...waveInputs,{key:'maxOvershootAtr',label:'第五点超越 / ATR 上限',type:'float',def:2,min:.25,max:6,step:.25},{key:'timeSymmetry',label:'同侧耗时最长/最短',type:'float',def:2,min:1,max:4,step:.1},{key:'projectionBars',label:'投射柱数',type:'int',def:40,min:5,max:300,step:5}]),
    create('analysis-elliott','Elliott 主备选计数','wave','普通推进硬规则、实际小一级细分、ABC与备选；未满足细分只作为观察计数。',['Elliott','艾略特','ABC','波浪'],detectElliottWaves,[...waveInputs,{key:'showABC',label:'展示ABC修正',type:'bool',def:true},{key:'requireSubwaves',label:'确认必须满足实际小级别细分',type:'bool',def:true},{key:'allowTruncated',label:'允许第五浪截短备选',type:'bool',def:false},{key:'maxAlternatives',label:'最多备选计数',type:'int',def:3,min:1,max:6,step:1}]),
    create('analysis-hurst','Hurst 因果周期估计','cycle','仅历史尾窗的多周期分量、稳定性与相位范围；解释方差不是预测概率。',['Hurst','赫斯特','周期','相位'],detectHurstCycles,[{key:'windowBars',label:'拟合闭柱窗口',type:'int',def:600,min:60,max:2048,step:20},{key:'minPeriod',label:'最短周期（柱）',type:'int',def:10,min:6,max:150,step:1},{key:'maxPeriod',label:'最长周期（柱）',type:'int',def:120,min:10,max:300,step:5},{key:'minFit',label:'最低解释方差',type:'float',def:.18,min:.05,max:.8,step:.01},{key:'maxCycles',label:'最多周期分量',type:'int',def:3,min:1,max:4,step:1}]),
    create('analysis-gann','Gann 价格时间投射','cycle','先指定锚点与价时单位，屏幕缩放不改变投射；在研究页可用选定手绘填入参数。',['Gann','江恩','角度','时间价格'],detectGann,[{key:'anchorTime',label:'锚点 UTC 时间 ms（研究页可填入）',type:'float',def:0,min:0,max:9999999999999,step:60000},{key:'anchorPrice',label:'锚点价格',type:'float',def:0,min:0,max:10000000,step:.01},{key:'priceUnit',label:'每单位价格',type:'float',def:1,min:.00000001,max:1000000,step:.1},{key:'timeUnitBars',label:'每时间单位柱数',type:'float',def:1,min:.01,max:1000,step:.1},{key:'timeUnitMs',label:'固定时间单位ms（0使用柱时长）',type:'float',def:0,min:0,max:31536000000,step:60000},{key:'direction',label:'投射方向',type:'select',def:'both',options:['both','up','down'],optionLabels:{both:'双向',up:'向上',down:'向下'}},{key:'projectionBars',label:'投射柱数',type:'int',def:60,min:1,max:500,step:5}]),
    create('analysis-candles','K线形态','candlestick','Pin Bar、吞没、十字星和晨暮星；闭柱几何与背景分开，不自动下单。',['Pin Bar','Engulfing','Doji','Morning Star','蜡烛','K线'],detectCandlesticks,[{key:'family',label:'形态',type:'select',def:'全部',options:['全部','Pin Bar','Engulfing','Doji','Morning Star','Evening Star']},{key:'requireTrend',label:'方向形态要求先行趋势',type:'bool',def:true},{key:'requireGap',label:'晨暮星要求实体跳空',type:'bool',def:false},{key:'pinWick',label:'Pin Bar 影线 / 实体下限',type:'float',def:2.5,min:1.5,max:6,step:.1},{key:'dojiBody',label:'Doji 实体 / 振幅上限',type:'float',def:.1,min:.02,max:.25,step:.01}]),
    create('analysis-structure','市场结构','structure','已知高低点、BOS/CHoCH 与扫过后回收；展示本平台的确定规则。',['Dow','Price Action','BOS','CHoCH','HH','HL','市场结构'],detectMarketStructure,[{key:'pivotStrength',label:'拐点左右确认柱数',type:'int',def:3,min:1,max:20,step:1},{key:'breakoutAtr',label:'破位距离 / ATR',type:'float',def:.1,min:0,max:1,step:.05},{key:'showSwings',label:'记录 HH/HL/LH/LL',type:'bool',def:false}]),
    create('analysis-zones','供需与价差区域','supply-demand','推进前基底与三柱 FVG；跟踪回补或区域穿越，不推断真实挂单。',['Supply','Demand','SMC','FVG','供需','价差'],detectSupplyDemand,[{key:'family',label:'区域类型',type:'select',def:'全部',options:['全部','Supply / Demand','FVG']},{key:'minGapAtr',label:'最小价差 / ATR',type:'float',def:.15,min:.02,max:2,step:.05},{key:'displacementAtr',label:'推进实体 / ATR',type:'float',def:1.3,min:.5,max:5,step:.1}]),
    create('analysis-vsa','量价观察 VSA','vsa','相对量能、振幅和收盘位置，保留现象与待验证条件。',['VSA','量价','成交量'],detectVsa,[{key:'volumeRatio',label:'高量 / 前20柱中位量',type:'float',def:1.8,min:1.2,max:5,step:.1}]),
    create('analysis-wyckoff','威科夫区间与事件','wyckoff','区间、反复测试、Spring/UT、SOS/SOW 与 LPS；阶段为可解释假设。',['Wyckoff','威科夫','Spring','SOS','LPS','吸筹','派发'],detectWyckoff,[{key:'pivotStrength',label:'拐点确认柱数',type:'int',def:2,min:1,max:6,step:1},{key:'minRangeBars',label:'最少区间柱数',type:'int',def:12,min:6,max:120,step:1},{key:'maxRangeBars',label:'最长区间观察柱数',type:'int',def:240,min:30,max:1500,step:10},{key:'rangeMinAtr',label:'区间高度 / ATR 下限',type:'float',def:2,min:1,max:10,step:.25},{key:'boundaryToleranceAtr',label:'边界容差 / ATR',type:'float',def:.3,min:.05,max:1,step:.05},{key:'breakoutAtr',label:'突破确认距离 / ATR',type:'float',def:.3,min:.05,max:1.5,step:.05},{key:'volumeRatio',label:'相对量能参考',type:'float',def:1.35,min:1,max:3,step:.05}]),
  ];
}
