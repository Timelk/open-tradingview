import {describe,expect,it} from 'vitest';
import {drawAnalysis,hitAnalysis,type AnalysisPaintOptions} from '../src/lib/render/analysis';
import {hitPattern,type PatternPaintOptions} from '../src/lib/render/patterns';
import type {AnalysisObservation} from '../src/lib/analysis/types';

function canvas(){
  const paints:{op:string;args:unknown[];alpha:number;stroke:unknown;width:unknown;dash:unknown}[]=[],states:Record<string,unknown>[]=[],state:Record<string,unknown>={globalAlpha:1};
  const ctx=new Proxy(state,{get(target,key){
    if(key in target)return target[String(key)];if(key==='measureText')return (s:string)=>({width:s.length*7});
    return(...args:unknown[])=>{if(key==='save')states.push({...state});if(key==='restore')Object.assign(state,states.pop());if(key==='setLineDash')state.dash=args[0];paints.push({op:String(key),args,alpha:Number(state.globalAlpha),stroke:state.strokeStyle,width:state.lineWidth,dash:state.dash});};
  }}) as unknown as CanvasRenderingContext2D;
  return{ctx,paints};
}
function item(patch:Partial<AnalysisObservation>={}):AnalysisObservation{
  return{id:'zone',family:'supply-demand',name:'需求',ruleVersion:'test',direction:'bullish',state:'confirmed',time:-40,availableAt:-39,throughTime:81,
    points:[{label:'起点',time:-45,value:70},{label:'创建',time:-40,value:70}],zone:{fromTime:-45,toTime:80,low:70,high:80},
    events:[],evidence:[],counterEvidence:[],waitingFor:[],...patch};
}
function options(patch:Partial<AnalysisPaintOptions>={}):AnalysisPaintOptions{return{instanceId:'analysis',color:'#98b7d8',width:1,labels:true,zones:true,targets:false,
  project:(time,value)=>({x:time,y:100-value}),bounds:{left:0,right:100,top:0,bottom:100},barWidth:5,occupied:[],...patch};}

describe('analysis visible sparse geometry',()=>{
  it('keeps an extended zone painted and selectable after every creation point is offscreen',()=>{
    const{ctx,paints}=canvas(),observation=item(),hits=drawAnalysis(ctx,[observation],options());
    expect(hits).toHaveLength(1);
    expect(paints.some(p=>p.op==='fillRect'&&JSON.stringify(p.args)===JSON.stringify([0,20,80,10]))).toBe(true);
    expect(hitPattern(hits,{x:45,y:20})?.observation.id).toBe(observation.id);
    const title=paints.find(p=>p.op==='fillText'&&p.args[0]==='需求')!;
    expect(title).toBeDefined();expect(Number(title.args[1])).toBeGreaterThan(0);
    expect(hits[0].labelBounds[0].right).toBeLessThanOrEqual(100);
    expect(paints.some(p=>p.op==='moveTo'&&p.args[0]===80&&p.args[1]===30)).toBe(true);
  });

  it('includes a later visible event even when its base geometry has left the screen',()=>{
    const{ctx,paints}=canvas(),observation=item({zone:undefined,events:[{id:'return',kind:'retest',label:'回访',time:60,availableAt:61,price:75,explanation:'实际回访'}]});
    const hits=drawAnalysis(ctx,[observation],options());
    expect(hits).toHaveLength(1);
    expect(paints.some(p=>p.op==='arc'&&p.args[0]===60&&p.args[1]===25)).toBe(true);
    expect(hitPattern(hits,{x:60,y:25})?.observation.id).toBe(observation.id);
  });

  it('does not create a hidden-zone hit or an edge-clamped label for offscreen creation points',()=>{
    const{ctx,paints}=canvas();
    expect(drawAnalysis(ctx,[item()],options({zones:false}))).toEqual([]);
    expect(paints.filter(p=>['fillRect','strokeRect','fillText'].includes(p.op))).toEqual([]);
  });

  it('clips extended-zone picking, restores inherited opacity and safely ignores an empty pane',()=>{
    const{ctx,paints}=canvas();ctx.globalAlpha=.5;
    const hits=drawAnalysis(ctx,[item()],options({labels:false,opacity:.4}));
    expect(hitPattern(hits,{x:-1,y:20})).toBeUndefined();expect(hitPattern(hits,{x:101,y:20})).toBeUndefined();
    expect(paints.find(p=>p.op==='fillRect')?.alpha).toBeCloseTo(.011);expect(ctx.globalAlpha).toBe(.5);
    const empty=canvas();expect(drawAnalysis(empty.ctx,[item()],options({bounds:{left:0,right:0,top:0,bottom:100}}))).toEqual([]);
    expect(empty.paints).toEqual([]);
  });
});

describe('analysis visual language and ownership',()=>{
  const wide=(patch:Partial<AnalysisPaintOptions>={})=>options({bounds:{left:0,right:800,top:0,bottom:600},project:(time,value)=>({x:time,y:value}),...patch});
  it('names an unconfirmed state instead of using an unexplained question mark and preserves detector facts',()=>{
    const observation=item({family:'wave',name:'Wolfe 1–4 候选',state:'observing',zone:undefined,points:[{label:'4',time:250,value:250}]}),before=structuredClone(observation);
    const {ctx,paints}=canvas();drawAnalysis(ctx,[observation],wide());
    const texts=paints.filter(p=>p.op==='fillText').map(p=>p.args[0]);
    expect(texts).toContain('观察中');expect(texts.some(value=>String(value).startsWith('?'))).toBe(false);
    expect(observation).toEqual(before);
  });
  it('honors explicit colors and widths on directional, limited and invalidated geometry',()=>{
    for(const patch of [{direction:'bullish'},{direction:'bearish'},{state:'invalidated'},{dataWarning:'缺口'}] as Partial<AnalysisObservation>[]){
      const {ctx,paints}=canvas();drawAnalysis(ctx,[item({...patch,lines:[{role:'boundary',points:[{label:'',time:5,value:40},{label:'',time:70,value:40}]}]})],options({colorOverride:'#123456',width:6,labels:false}));
      const strokes=paints.filter(p=>p.op==='stroke'||p.op==='strokeRect');
      expect(strokes.length).toBeGreaterThan(0);expect(strokes.every(p=>p.stroke==='#123456'&&p.width===6)).toBe(true);
    }
  });
  it('draws the OB base separately from its established region using the actual activation candle',()=>{
    const observation=item({id:'order-block:bull:10',family:'smc',zone:{fromTime:10,toTime:90,high:80,low:70},
      events:[{id:'activation',kind:'activation',label:'建立',time:40,availableAt:41,price:85,explanation:''}]});
    const {ctx,paints}=canvas();drawAnalysis(ctx,[observation],options({labels:false}));
    const boxes=paints.filter(p=>p.op==='strokeRect');
    expect(boxes.map(p=>p.args)).toEqual([[10,20,30,10],[40,20,50,10]]);
    expect(boxes[0].dash).toEqual([3,3]);expect(boxes[1].dash).toEqual([]);
    expect(paints.some(p=>p.op==='arc'&&p.args[0]===40)).toBe(false);
  });
  it('keeps suppressed records selectable and makes label density a presentation choice',()=>{
    const records=Array.from({length:10},(_,i)=>item({id:String(i),family:'vsa',zone:undefined,availableAt:i,points:[{label:'量价',time:200,value:35+i*53}]}));
    const compact=drawAnalysis(canvas().ctx,records,wide({bounds:{left:0,right:400,top:0,bottom:600}}));
    expect(compact).toHaveLength(10);expect(compact.filter(hit=>hit.labelBounds.length)).toHaveLength(3);
    expect(hitAnalysis(compact,{x:200,y:35})?.observation.id).toBe('0');
    const selected=drawAnalysis(canvas().ctx,records,wide({labelMode:'selected',selectedId:'0'}));
    expect(selected.filter(hit=>hit.labelBounds.length).map(hit=>hit.observation.id)).toEqual(['0']);
    expect(drawAnalysis(canvas().ctx,records,wide({labelMode:'all'})).filter(hit=>hit.labelBounds.length)).toHaveLength(10);
  });
  it('picks painted titles and selected event captions before a different record’s underlying line',()=>{
    const primary=item({id:'primary',name:'主记录',family:'structure',zone:undefined,points:[{label:'',time:250,value:100}]}),older=item({id:'older',zone:undefined,points:[],lines:[{role:'boundary',points:[{label:'',time:0,value:130},{label:'',time:800,value:130}]}]});
    const hits=drawAnalysis(canvas().ctx,[primary,older],wide({selectedId:'primary',labelMode:'selected'}));
    const label=hits[0].labelBounds[0];expect(hitAnalysis(hits,{x:(label.left+label.right)/2,y:130})?.observation.id).toBe('primary');
    const eventOwner=item({...primary,events:[{id:'e',kind:'revisit',label:'首次回访的价格事件',time:400,availableAt:401,price:300,explanation:''}]});
    const eventHits=drawAnalysis(canvas().ctx,[eventOwner],wide({selectedId:'primary'}));
    expect(eventHits[0].labelBounds).toHaveLength(2);
    const caption=eventHits[0].labelBounds[1];
    expect(hitAnalysis(eventHits,{x:caption.left+2,y:caption.top+9})?.observation.id).toBe('primary');
  });
  it('renders selected wave anchor labels once, with or without later lifecycle events',()=>{
    for(const events of [[],[{id:'end',kind:'invalidation',label:'失效',time:600,availableAt:601,price:400,explanation:''}]]){
      const {ctx,paints}=canvas();drawAnalysis(ctx,[item({id:'wave',family:'wave',zone:undefined,points:[{label:'1',time:100,value:200},{label:'2',time:300,value:300}],events})],wide({selectedId:'wave'}));
      for(const label of ['1','2'])expect(paints.filter(p=>p.op==='fillText'&&p.args[0]===label)).toHaveLength(1);
    }
  });
  it('keeps long state badges within a narrow title card',()=>{
    const {ctx,paints}=canvas(),hits=drawAnalysis(ctx,[item({name:'FVG 看涨价差区'})],options({bounds:{left:0,right:60,top:0,bottom:100}}));
    for(const paint of paints.filter(p=>p.op==='fillText')){
      const x=Number(paint.args[1]),right=x+String(paint.args[0]).length*7,card=hits[0].labelBounds[0];
      expect(x).toBeGreaterThanOrEqual(card.left);expect(right).toBeLessThanOrEqual(card.right);
    }
  });
});
