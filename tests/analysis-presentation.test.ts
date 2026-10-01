import {describe,expect,it} from 'vitest';
import {analysisBrief,analysisChartName,analysisGuide,analysisStatus,meaningfulCounterEvidence,meaningfulWaitingFor} from '../src/lib/analysis/presentation';
import type {AnalysisObservation} from '../src/lib/analysis/types';
import {translateCanonical} from '../src/lib/i18n';
import {analysisPresentationMessages} from '../src/lib/i18n/messages-analysis-presentation';
import {analysisGuideMessages} from '../src/lib/i18n/messages-analysis-guide';

const ob=(patch:Partial<AnalysisObservation>={}):AnalysisObservation=>({id:'order-block:bull:1',family:'smc',name:'看涨 Order Block',ruleVersion:'smc-ict/observable-1',direction:'bullish',state:'confirmed',time:1,availableAt:5,throughTime:20,points:[],events:[{id:'born',kind:'activation',label:'建立',time:4,availableAt:5,price:100,explanation:''}],zone:{fromTime:1,toTime:20,low:95,high:100},evidence:[],counterEvidence:[],waitingFor:[],...patch});
const event=(kind:string)=>({id:kind,kind,label:kind,time:10,availableAt:11,price:98,explanation:''});

describe('state descriptions represent recorded evidence',()=>{
  it('distinguishes established, visited, depth-reached and invalidated order blocks',()=>{
    expect(analysisStatus(ob()).label).toBe('等待回访');
    expect(analysisStatus(ob({events:[event('revisit')]})).label).toBe('已回访');
    expect(analysisStatus(ob({events:[event('revisit'),event('mitigation')]})).label).toBe('达到回访深度');
    expect(analysisStatus(ob({events:[event('mitigation'),event('invalidation')],state:'invalidated'})).label).toBe('已失效');
  });
  it('never calls incomplete coverage or stopped tracking a current unvisited zone',()=>{
    expect(analysisStatus(ob({dataWarning:'未核验后续',trackingEndedAt:15})).key).toBe('limited');
    expect(analysisStatus(ob({trackingEndedAt:15,trackingEndReason:'expired'})).key).toBe('ended');
    expect(analysisStatus(ob({state:'observing'})).key).toBe('observing');
  });
  it('does not call a manually supplied scale, a cycle estimate, or an unqualified count a confirmed signal',()=>{
    expect(analysisStatus(ob({ruleVersion:'gann-explicit-arithmetic/1.0',state:'observing'})).label).toBe('手动标尺');
    expect(analysisStatus(ob({ruleVersion:'hurst-trailing-regression/1.0',state:'observing'})).label).toBe('周期估计');
    const columns=ob({id:'point-figure:1',ruleVersion:'point-figure/close-fixed-1',family:'structure',state:'observing',zone:undefined});
    expect(analysisStatus(columns).label).toBe('已构列 · 待计数');
    expect(analysisStatus({...columns,zone:{fromTime:1,toTime:2,low:95,high:100},lines:[{role:'projection',points:[]}]}).label).toBe('计数测量');
    expect(analysisGuide(columns).title).toBe('点数图计数怎样读？');
  });
  it('calls a fully filled FVG filled and keeps its facts unchanged through bilingual presentation',()=>{
    const item=ob({id:'supply-demand:FVG:1',name:'FVG 看涨价差区',family:'supply-demand',state:'invalidated'}),before=structuredClone(item);
    expect(analysisStatus(item).label).toBe('已回补');
    for(const language of ['zh-CN','en-US'] as const){
      for(const value of [analysisChartName(item),...Object.values(analysisGuide(item)),...Object.values(analysisBrief(item)),analysisStatus(item).label,analysisStatus(item).description]){
        const translated=translateCanonical(value,undefined,language);if(language==='en-US')expect(translated).not.toMatch(/[\u3400-\u9fff]/);
      }
    }
    expect(item).toEqual(before);
  });
  it('provides item-specific pattern definitions, price action and projections across all observation names and strips boilerplate',()=>{
    const names=['Pin Bar 下影','Pin Bar 上影','Engulfing 看涨吞没','Engulfing 看跌吞没','Morning Star 晨星','Evening Star 暮星','Doji 十字星','BOS 收盘破位','CHoCH 结构转向','扫过前高后回收','扫过前低后收复','HH','HL','LH','LL','EQH 等高','EQL 等低','看涨 Order Block','看跌 Order Block','FVG 看涨价差区','FVG 看跌价差区','Demand 需求区','Supply 供给区','ICT 向上事件组合','ICT 向下事件组合','高量窄幅','高量宽幅','低量测试候选','威科夫 · 吸筹假设','威科夫 · 派发假设','P&F 水平计数 · 独立测量','Wolfe 五点几何','Wolfe 1–4 候选','Elliott 五浪计数','Elliott ABC 修正','Elliott 推进计数中','Hurst 周期估计','Gann 显式价时标尺'];
    for(const name of names){
      for(const direction of ['bullish','bearish'] as const){
        const brief=analysisBrief(ob({name,direction}));
        expect(brief.summary.length,name).toBeGreaterThan(15);
        expect(brief.action.length,name).toBeGreaterThan(15);
        expect(brief.projection.length,name).toBeGreaterThan(15);
        for(const text of [brief.summary,brief.action,brief.projection]){
          expect(translateCanonical(text,undefined,'en-US'),`${name}: ${text}`).not.toMatch(/[\u3400-\u9fff]/);
        }
      }
    }
    const sample=ob({counterEvidence:['不推断未公开订单簿、成交明细或机构意图。','相对成交量偏低。'],waitingFor:['已收盘确认，无待未来 K 线补齐条件。','后续首次回访进入区域']});
    expect(meaningfulCounterEvidence(sample)).toEqual(['相对成交量偏低。']);
    expect(meaningfulWaitingFor(sample)).toEqual(['后续首次回访进入区域']);
  });
  it('translates the new guide and settings copy without dropping template values',()=>{
    for(const [source,target] of Object.entries({...analysisPresentationMessages,...analysisGuideMessages})){
      expect(translateCanonical(source,undefined,'en-US'),source).not.toMatch(/[\u3400-\u9fff]/);
      expect([...target.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),source).toEqual([...source.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort());
    }
  });
});
