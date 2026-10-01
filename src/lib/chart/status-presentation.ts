import type {ChartState} from './controller';
import type {ConnectorRunMode} from '../market/connector-config';
export function chartConnectionPresentation(state:Pick<ChartState,'source'|'loading'|'status'|'paused'|'historicalSnapshot'|'analysisReplay'>,mode?:ConnectorRunMode){
  if(state.historicalSnapshot)return {label:state.analysisReplay?'分析历史回放':'历史快照',badge:'历史',tone:'history'};
  if(state.status==='error')return {label:'连接失败',badge:'未连接',tone:'error'};
  if(state.loading||state.status==='reconnecting')return {label:state.loading?'加载行情':'正在连接 / 补齐行情',badge:'连接中',tone:'waiting'};
  if(state.paused)return {label:'行情已暂停',badge:'已暂停',tone:'waiting'};
  if(state.source==='mock'||mode==='simulation')return {label:'模拟行情',badge:'模拟',tone:'simulation'};
  // ChartState does not disclose whether an auto feed fell back to simulation.
  if(mode==='auto')return {label:'行情已连接',badge:'自动模式',tone:'waiting'};
  return {label:'行情已连接',badge:'实时',tone:'live'};
}
