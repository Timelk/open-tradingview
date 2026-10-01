import {expect,it} from 'vitest';
import {AnalysisReviewStore,REVIEW_STORAGE_KEY,type ReviewTarget} from '../src/lib/analysis/reviews';
const target:ReviewTarget={market:'binance:BTCUSDT:15m',instanceId:'i',sourceId:'o',kind:'analysis',name:'区间'};
function storage(){const data=new Map<string,string>();return {data,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>void data.set(k,v)};}
it('persists review provenance without changing another market or detector instance',()=>{
  const s=storage(),store=new AnalysisReviewStore(s);store.set(target,'rejected','不是同一级别');
  expect(new AnalysisReviewStore(s).get(target)?.decision).toBe('rejected');
  expect(store.get({...target,market:'binance:ETHUSDT:15m'})).toBeUndefined();
  expect(store.get({...target,instanceId:'j'})).toBeUndefined();
  const record=store.get(target)!;record.note='external mutation';expect(store.get(target)?.note).toBe('不是同一级别');
  store.remove(target);expect(store.list()).toEqual([]);
});
it('imports atomically and preserves other review records and manual drawing origins',()=>{
  const store=new AnalysisReviewStore(storage());store.set(target,'manual','人工边界',['manual-1']);
  const other=new AnalysisReviewStore(storage());other.set({...target,sourceId:'b'},'accepted');store.import(other.export());
  expect(store.list()).toHaveLength(2);expect(store.get(target)?.drawingIds).toEqual(['manual-1']);
  expect(()=>store.import('{"version":1,"entries":[{}]}')).toThrow();expect(store.list()).toHaveLength(2);
});
it('keeps malformed stored data and records a persistence failure without pretending it saved',()=>{
  const s=storage();s.data.set(REVIEW_STORAGE_KEY,'bad');const store=new AnalysisReviewStore(s);expect(store.error).toContain('读取失败');expect(s.getItem(REVIEW_STORAGE_KEY)).toBe('bad');
  const broken=new AnalysisReviewStore({getItem:()=>null,setItem:()=>{throw Error('quota')}});broken.set(target,'pending','notes');expect(broken.error).toContain('存储失败');expect(broken.get(target)?.note).toBe('notes');
});

it('editing manual review notes preserves the independent drawing association across reload',()=>{
  const saved=storage(),store=new AnalysisReviewStore(saved);store.set(target,'manual','初始标注',['manual-1']);
  store.set(target,'manual','校正了右肩');
  const loaded=new AnalysisReviewStore(saved);expect(loaded.get(target)?.drawingIds).toEqual(['manual-1']);expect(loaded.get(target)?.note).toBe('校正了右肩');
  loaded.set(target,'accepted','恢复自动');expect(loaded.get(target)?.drawingIds).toBeUndefined();
});
