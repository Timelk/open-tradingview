export interface PatternDateCoverage {
  scanFrom?:number;scanThrough?:number;latestBarTime?:number;latestConfirmedTime?:number;
  latestMatchTime?:number;latestDisplayedMatchTime?:number;
  historicalSnapshot:boolean;following:boolean;intervalMs:number;chartIntervalMs?:number;
  scope?:'viewport'|'latest';
  knowledgeThroughTime?:number;
}
export interface PatternCoverageDiagnosis {
  code:'snapshot'|'stale-scan'|'filtered-latest'|'older-viewport'|'current';
  message:string;action?:'latest'|'history';
}
const finite=(n:number|undefined):n is number=>typeof n==='number'&&Number.isFinite(n);
/** Distinguish source cutoff, calculation lag and display filtering. These are
 * observations of current state, never guesses based on a missing shape. */
export function describePatternCoverage(input:PatternDateCoverage):PatternCoverageDiagnosis {
  if(input.historicalSnapshot)return {code:'snapshot',message:'当前是历史快照，行情与识别停在快照末尾。',action:'latest'};
  const duration=input.intervalMs,base=input.chartIntervalMs??duration;
  if(finite(input.knowledgeThroughTime)&&finite(input.latestConfirmedTime)&&duration>0&&base>0){
    const expected=Math.floor((input.latestConfirmedTime+base)/duration)*duration;
    if(expected-input.knowledgeThroughTime>=duration)return {code:'stale-scan',message:'状态计算尚未追上最新已收盘数据；请检查行情与计算状态。',action:'latest'};
  }else if(input.scope!=='viewport'&&finite(input.latestConfirmedTime)&&finite(input.scanThrough)&&duration>0&&base>0){
    const expected=Math.floor((input.latestConfirmedTime+base)/duration)*duration-duration;
    if(expected-input.scanThrough>=duration)return {code:'stale-scan',message:'扫描尚未追上最新已收盘数据；请检查行情与计算状态。',action:'latest'};
  }
  if(input.scope!=='viewport'&&finite(input.latestMatchTime)&&(!finite(input.latestDisplayedMatchTime)||input.latestMatchTime>input.latestDisplayedMatchTime))
    return {code:'filtered-latest',message:'已有更晚的确认结果，被失效、可见范围或列表筛选隐藏。',action:'history'};
  if(!input.following)return {code:'older-viewport',message:input.knowledgeThroughTime!==undefined?'图表正在浏览历史位置；缩放只改变显示范围，状态按已知闭柱计算。':input.scope==='viewport'?'正在识别当前历史视图；观察中结构仍跟随最新行情。':'图表正在浏览历史位置；识别仍跟随最新数据计算。',action:'latest'};
  return {code:'current',message:finite(input.latestMatchTime)?'扫描范围已更新；最近识别时间不等于行情截止时间。':'扫描范围内暂无满足规则的已确认形态。'};
}
