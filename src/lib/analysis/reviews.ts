export type ReviewDecision='accepted'|'rejected'|'pending'|'manual';
export interface ReviewTarget {market:string;instanceId:string;sourceId:string;kind:'pattern'|'analysis';name:string;ruleVersion?:string}
export interface AnalysisReview extends ReviewTarget {decision:ReviewDecision;note:string;updatedAt:number;drawingIds?:string[]}
interface StorageLike {getItem(key:string):string|null;setItem(key:string,value:string):void}
export const REVIEW_STORAGE_KEY='tvchart.analysis-reviews.v1';
const key=(t:ReviewTarget)=>JSON.stringify([t.market,t.instanceId,t.kind,t.sourceId]);
const valid=(v:unknown):v is AnalysisReview=>{
  if(!v||typeof v!=='object')return false;const r=v as AnalysisReview;
  return ['market','instanceId','sourceId','name','note'].every(field=>typeof r[field as keyof AnalysisReview]==='string'&&String(r[field as keyof AnalysisReview]).length<5000)&&['pattern','analysis'].includes(r.kind)&&['accepted','rejected','pending','manual'].includes(r.decision)&&Number.isFinite(r.updatedAt)&&r.updatedAt>=0&&(!r.drawingIds||Array.isArray(r.drawingIds)&&r.drawingIds.length<=100&&r.drawingIds.every(id=>typeof id==='string'&&id.length<128));
};
/** User judgements are a separate, exportable layer, never model truth. */
export class AnalysisReviewStore {
  private entries=new Map<string,AnalysisReview>();error='';
  constructor(private storage:StorageLike|undefined=defaultStorage()){
    try{const raw=storage?.getItem(REVIEW_STORAGE_KEY);if(raw)this.read(raw);}catch{this.error='复核记录读取失败；原始识别未受影响。';}
  }
  get(target:ReviewTarget):AnalysisReview|undefined {const r=this.entries.get(key(target));return r?structuredClone(r):undefined;}
  list(market?:string):AnalysisReview[]{return [...this.entries.values()].filter(r=>!market||r.market===market).sort((a,b)=>b.updatedAt-a.updatedAt).map(r=>structuredClone(r));}
  set(target:ReviewTarget,decision:ReviewDecision,note='',drawingIds?:string[]):AnalysisReview {
    const retainedIds=drawingIds??(decision==='manual'?this.entries.get(key(target))?.drawingIds:undefined);
    const record={...target,decision,note:note.slice(0,4000),updatedAt:Date.now(),...(retainedIds?{drawingIds:[...retainedIds]}:{})};if(!valid(record))throw Error('复核记录无效');
    if(!this.entries.has(key(target))&&this.entries.size>=5000)throw Error('复核记录已达5000条，请先导出备份并清理不需要的条目。');
    this.entries.set(key(target),record);this.save();return structuredClone(record);
  }
  remove(target:ReviewTarget):void {this.entries.delete(key(target));this.save();}
  export():string{return JSON.stringify({version:1,kind:'manual-analysis-reviews',entries:this.list()},null,2);}
  import(raw:string):void {const parsed=this.parse(raw);const next=new Map(this.entries);for(const r of parsed)next.set(key(r),r);if(next.size>5000)throw Error('导入后复核记录超过5000条');this.entries=next;this.save();}
  private parse(raw:string):AnalysisReview[]{if(raw.length>4_000_000)throw Error('复核文件过大');const data=JSON.parse(raw);if(data?.version!==1||!Array.isArray(data.entries)||data.entries.length>5000||!data.entries.every(valid))throw Error('复核文件格式无效');return data.entries;}
  private read(raw:string){for(const r of this.parse(raw))this.entries.set(key(r),r);}
  private save(){try{this.storage?.setItem(REVIEW_STORAGE_KEY,this.export());this.error=this.storage?'':'当前环境不支持持久保存，请导出复核记录。';}catch{this.error='复核已保留在本次会话；浏览器存储失败，请导出备份。';}}
}
function defaultStorage():StorageLike|undefined {try{return typeof localStorage==='undefined'?undefined:localStorage;}catch{return undefined;}}
