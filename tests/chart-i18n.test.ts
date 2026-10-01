import {afterEach,describe,expect,it} from 'vitest';
import {getLocale,locale,translateCanonical} from '../src/lib/i18n';
import {drawPatterns,type PatternPaintOptions} from '../src/lib/render/patterns';
import {drawPatternCandidates} from '../src/lib/render/pattern-candidates';
import {drawAnalysis} from '../src/lib/render/analysis';
import {drawTradeMarkers,layoutTradeMarkers,markerCaption} from '../src/lib/render/trade-markers';
import {drawOverlayShapes,layoutOverlayShapes,type OverlayShapeCandidate} from '../src/lib/render/overlay-shapes';
import {drawOverlayDrawings} from '../src/lib/render/overlay-drawings';
import {fmtDateTime,fmtTime,fmtPrice} from '../src/lib/render/axes';
import {formatMarketPrice} from '../src/lib/core/market-format';
import type {PatternMatch,PatternCandidate} from '../src/lib/patterns/types';
import type {AnalysisObservation} from '../src/lib/analysis/types';
import type {OverlayDrawingSpec} from '../src/lib/core/types';

const originalLocale=getLocale();afterEach(()=>locale.set(originalLocale));
const box={left:0,top:0,right:800,bottom:400};
function canvas(){
  const paints:{operation:string;args:unknown[]}[]=[],state:Record<string,unknown>={globalAlpha:1},stack:Record<string,unknown>[]=[];
  const ctx=new Proxy(state,{get(target,key){if(key in target)return target[String(key)];if(key==='measureText')return(text:string)=>({width:[...text].length*7});
    return(...args:unknown[])=>{if(key==='save')stack.push({...state});if(key==='restore')Object.assign(state,stack.pop());paints.push({operation:String(key),args});};}}) as unknown as CanvasRenderingContext2D;
  return{ctx,paints,text:()=>paints.filter(p=>p.operation==='fillText').map(p=>String(p.args[0]))};
}
const options=(extra:Partial<PatternPaintOptions>={}):PatternPaintOptions=>({instanceId:'native',color:'#45c7ae',width:1,labels:true,zones:true,targets:false,project:(time,value)=>({x:time,y:300-value}),bounds:box,barWidth:8,occupied:[],...extra});
const pattern=():PatternMatch=>({id:'huzi:fixture',family:'huzi-head-shoulders',name:'头肩底',direction:'bullish',status:'confirmed',stage:'failed-breakout',
  points:[{label:'L',time:50,value:100},{label:'N1',time:150,value:140},{label:'H',time:250,value:70},{label:'N2',time:350,value:140},{label:'R',time:450,value:100}],confirmedAt:500,zone:{low:139,high:141},invalidation:60,targets:[180],ratios:[],description:'平台证据',
  events:[{kind:'breakout',time:500,knownAt:501,value:142,boundary:140},{kind:'failed-breakout',time:650,knownAt:651,value:130,boundary:140}]});

describe('Canvas display language boundaries',()=>{
  it('changes platform pattern captions and selected anchor names without changing detection geometry, IDs, or status',()=>{
    const data=pattern(),before=structuredClone(data),zh=canvas();locale.set('zh-CN');
    const original=drawPatterns(zh.ctx,[data],options({selectedId:data.id}));expect(zh.text()).toContain('左肩');
    locale.set('en-US');const en=canvas(),translated=drawPatterns(en.ctx,[data],options({selectedId:data.id}));
    expect(en.text()).toEqual(expect.arrayContaining(['Left shoulder','Head','Right shoulder','Reclaim']));
    expect(en.text().some(text=>text.includes(translateCanonical(data.name)))).toBe(true);
    expect(en.text().join(' ')).not.toMatch(/[\u3400-\u9fff]/);
    expect(translated[0].segments).toEqual(original[0].segments);expect(translated[0].pattern).toBe(data);expect(data).toEqual(before);
  });

  it('localizes a developing pattern prefix and analytical events, preserving source observations',()=>{
    locale.set('en-US');
    const candidate:PatternCandidate={id:'forming',family:'AB=CD',name:'等幅形态 · AB=CD',direction:'bullish',points:pattern().points.slice(0,3),observedAt:400,ratios:[],description:'未确认',zone:{low:90,high:100}};
    const c=canvas(),before=structuredClone(candidate);drawPatternCandidates(c.ctx,[candidate],options());
    expect(c.text().some(text=>text.startsWith('Developing · '))).toBe(true);expect(c.text().join(' ')).not.toMatch(/[\u3400-\u9fff]/);expect(candidate).toEqual(before);
    const observation:AnalysisObservation={id:'zone',family:'supply-demand',name:'需求',ruleVersion:'test',direction:'bullish',state:'invalidated',time:80,availableAt:81,throughTime:401,
      points:[{label:'创建',time:80,value:100}],events:[{id:'created',kind:'activation',label:'创建',time:80,availableAt:81,price:100,explanation:'创建'},
        {id:'visit',kind:'revisit',label:'首次回访',time:200,availableAt:201,price:110,explanation:'回访'}],evidence:[],counterEvidence:[],waitingFor:[]};
    const a=canvas(),snapshot=structuredClone(observation);drawAnalysis(a.ctx,[observation],options({selectedId:observation.id}));
    expect(a.text().join(' ')).toContain('Invalidated');expect(a.text().join(' ')).not.toMatch(/[\u3400-\u9fff]/);expect(observation).toEqual(snapshot);
  });

  it('localizes system Buy/Sell and finite provenance only; descriptive overlay labels remain opaque',()=>{
    locale.set('en-US');const source=[{x:100,y:100,side:'buy' as const,sourceTag:'均线',label:'买入 · 保留我的原文'},
      {x:400,y:100,side:'sell' as const,sourceTag:'成交',label:'我的分析标签'}],before=structuredClone(source),c=canvas();
    const layouts=layoutTradeMarkers(source,box);drawTradeMarkers(c.ctx,layouts);
    expect(c.text()).toEqual(['MA · Buy','Fill · Sell']);expect(source).toEqual(before);expect(layouts.map(l=>l.anchor)).toEqual([{x:100,y:100},{x:400,y:100}]);
    expect(markerCaption({x:0,y:0,side:'buy',sourceTag:'对象树'})).toBe('对象树 · Buy');
    locale.set('zh-CN');expect(source.map(markerCaption)).toEqual(['均线 · 买入','成交 · 卖出']);
  });

  it('keeps overlay shape text and label/box text byte-for-byte across language switches',()=>{
    const text='买入\n对象树 · 自定义原文',shape:OverlayShapeCandidate={x:100,y:100,shape:'labelup',location:'belowbar',color:'#00ff00',textColor:'#ffffff',text};
    const drawing:OverlayDrawingSpec={id:'overlay-label',kind:'label',x1:1,y1:100,x2:1,y2:100,xloc:'bar_time',yloc:'price',style:'label_up',stroke:'#ffffff',fill:'#222222',width:1,lineStyle:'solid',text,textColor:'#ffffff',fontSize:12,textAlign:'center',textValign:'center',tooltip:'不要翻译'};
    const before=structuredClone({shape,drawing});
    for(const language of ['zh-CN','en-US'] as const){locale.set(language);const shapes=canvas(),labels=canvas();drawOverlayShapes(shapes.ctx,layoutOverlayShapes([shape],box));
      drawOverlayDrawings(labels.ctx,[{drawing,x1:350,y1:150,x2:350,y2:150}],box);
      expect(shapes.text()).toEqual(text.split('\n'));expect(labels.text()).toEqual(text.split('\n'));expect({shape,drawing}).toEqual(before);}
  });

  it('invalidates locale-keyed axis date caches at the same timestamp without changing timezone or price precision',()=>{
    const time=new Date(2026,8,24,13,7,9).getTime();
    for(const language of ['zh-CN','en-US','zh-CN'] as const){locale.set(language);
      expect(fmtDateTime(time)).toBe(new Date(time).toLocaleString(language,{hour12:false}));
      expect(fmtTime(time,true)).toBe(new Intl.DateTimeFormat(language,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(time));
      expect(fmtTime(time,false)).toBe(new Intl.DateTimeFormat(language,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(time));
      expect(fmtPrice(12345.1234,4)).toBe(new Intl.NumberFormat(language,{minimumFractionDigits:4,maximumFractionDigits:4}).format(12345.1234));
      expect(formatMarketPrice(.000003617)).toBe('0.000003617');expect(formatMarketPrice(NaN)).toBe('—');
    }
  });
});
