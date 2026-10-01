import type {ColumnView,DerivedSeries,IncrementalCalculator,IndicatorDef,ParamValues,ParamSchema} from '../core/types';
import {continuous} from './features';

/** Taker volume is an exchange cumulative candle snapshot. Replacements
 * replace one delta contribution rather than accumulating that snapshot twice. */
export class FlowCalculator implements IncrementalCalculator {
  private output:DerivedSeries[]=[];private previousLength=0;private missing=new Uint8Array(0);private missingCount=0;
  constructor(private id:'delta'|'cvd',private params:ParamValues){}
  update(cols:ColumnView,from:number):DerivedSeries[]{
    const quote=this.params.unit==='quote',total=quote?cols.flow?.('quoteVolume'):cols.col('volume'),buy=cols.flow?.(quote?'takerBuyQuote':'takerBuyBase');
    const n=cols.length,capacity=Math.max(n+1024,this.output[0]?.values.length??0),full=from===0||n<this.previousLength||!this.output.length;
    if(!this.output.length)this.output=this.id==='delta'?
      [{name:'主动买入净量',values:new Float64Array(0),color:'#4bbca6',pane:'sub',plot:'hist'},{name:'主动卖出净量',values:new Float64Array(0),color:'#df7c86',pane:'sub',plot:'hist'}]:
      [{name:'CVD',values:new Float64Array(0),color:'#81b2dc',pane:'sub',plot:'line'}];
    for(const line of this.output)if(line.values.length<n){const next=new Float64Array(capacity).fill(NaN);next.set(line.values);line.values=next;}
    if(this.missing.length<n){const next=new Uint8Array(capacity);next.set(this.missing);this.missing=next;}
    const start=full?0:Math.max(0,Math.min(from,this.previousLength-1));if(full){this.missingCount=0;this.missing.fill(0);}
    for(let i=start;i<n;i++){
      this.missingCount-=this.missing[i];
      const v=total?.[i]??NaN,b=buy?.[i]??NaN,valid=Number.isFinite(v)&&Number.isFinite(b)&&v>=0&&b>=0&&b<=v+Math.max(1,v)*1e-9;
      const delta=valid?2*Math.min(b,v)-v:NaN;this.missing[i]=valid?0:1;this.missingCount+=this.missing[i];
      if(this.id==='delta'){this.output[0].values[i]=delta>=0?delta:NaN;this.output[1].values[i]=delta<0?delta:NaN;continue;}
      const times=cols.col('time'),day=Math.floor(times[i]/86400000),newDay=i>0&&day!==Math.floor(times[i-1]/86400000);
      const reset=this.params.reset!=='loaded';
      const startKnown=i===0?(!reset||times[i]%86400000===0):reset&&newDay&&times[i]%86400000===0;
      const previous=startKnown?0:i>0&&continuous(cols,i)&&(!reset||!newDay)?this.output[0].values[i-1]:NaN;
      this.output[0].values[i]=Number.isFinite(previous)&&valid?previous+delta:NaN;
    }
    this.previousLength=n;
    const unit=quote?'USDT 成交额':'基础资产成交量';
    const warning=this.missingCount?`有 ${this.missingCount} 根缺少可靠主动买入量；缺失段不填零或按蜡烛颜色估算。`:this.id==='cvd'&&n&&!Number.isFinite(this.output[0].values[n-1])?'累计起点或中途覆盖不完整，等待完整 UTC 日或选择从已加载起点累计。':undefined;
    this.output.forEach((line,i)=>{line.name=this.id==='cvd'?`CVD · ${unit} · ${this.params.reset==='loaded'?'已加载起点':'UTC 日'}`:`Delta ${i===0?'+':'−'} · ${unit}`;line.dataWarning=warning;});
    return this.output;
  }
}
const unitInput:ParamSchema={key:'unit',label:'数量口径',type:'select',def:'base',options:['base','quote'],optionLabels:{base:'基础资产成交量',quote:'USDT 成交额'}};
const resetInput:ParamSchema={key:'reset',label:'累计起点',type:'select',def:'utc-day',options:['utc-day','loaded'],optionLabels:{'utc-day':'每日 UTC 00:00 重置',loaded:'从已加载的首根开始'}};
export function flowIndicators():IndicatorDef[]{return (['delta','cvd'] as const).map<IndicatorDef>(id=>({
  id:`flow-${id}`,name:id==='delta'?'Delta':'CVD',title:id==='delta'?'主动成交净量 Delta':'累积主动成交净量 CVD',kind:'indicator',analysisFamily:'flow',target:'sub',source:'builtin',
  description:id==='delta'?'使用 Binance 主动买入量计算柱级净量；不以红绿K线猜测方向。':'固定起点累计主动成交净量；当前柱更新替换贡献，数据缺口不连线。',tags:['成交分析','订单流','主动买入','Delta','CVD'],
  inputs:[{...unitInput},...(id==='cvd'?[{...resetInput}]:[])],
  calc:(ctx,p)=>new FlowCalculator(id,p).update(ctx.cols,0),createIncremental:p=>new FlowCalculator(id,p),
}));}
