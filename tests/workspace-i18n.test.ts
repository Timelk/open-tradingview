import {describe,expect,it} from 'vitest';
import {translate,translateCanonical,translateError,locale,getLocale} from '../src/lib/i18n';
import {messages} from '../src/lib/i18n/messages-workspace';
import {defaultDisplayName,workspaceLayerName,workspacePlotName} from '../src/components/workspace/names';
import {ToolRegistry} from '../src/lib/drawing/registry';
import {registerDrawingBuiltins} from '../src/lib/drawing/builtins';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {emptyScene,layerOf} from '../src/lib/scene/types';
import type {ChartController} from '../src/lib/chart/controller';
import {priceZoneTool} from '../src/plugins/price-zone/definition';
import type {Drawing,Projection} from '../src/lib/drawing/types';

const english=(value:unknown)=>translate(value,undefined,'en-US');
const chinese=(value:unknown)=>translate(value,undefined,'zh-CN');
describe('workspace localization boundaries',()=>{
  it('localizes canonical defaults and generated copies, preserving user names verbatim',()=>{
    expect(defaultDisplayName('趋势线','趋势线',english)).toBe('Trend line');
    expect(defaultDisplayName('趋势线 副本','趋势线',english)).toBe('Trend line Copy');
    expect(defaultDisplayName('趋势线 副本','趋势线',chinese)).toBe('趋势线 副本');
    for(const userName of ['对象树','我的趋势线','主图','趋势线 - 手工备注','中文 / English ✓'])expect(defaultDisplayName(userName,'趋势线',english)).toBe(userName);
    expect(defaultDisplayName('对象树',undefined,english)).toBe('对象树');
  });

  it('never writes translated layer names, source text, or parameter values back to the document',()=>{
    const tools=new ToolRegistry();registerDrawingBuiltins(tools);const registry=new IndicatorRegistry();registerBuiltins(registry);
    const controller={registry,drawing:{registry:tools}} as unknown as ChartController,doc=emptyScene();
    doc.drawings.push({id:'line',toolId:'trend-line',paneId:'main',points:[],props:{text:'对象树'},style:{color:'#ffffff',width:1,dash:'solid',fillOpacity:.2},locked:false,hidden:false});
    doc.indicators.push({id:'analysis-wyckoff',instanceId:'study',params:{family:'全部'},timeframe:'chart',hiddenPlots:[]});
    doc.layers.push(layerOf('line','drawing','趋势线'),layerOf('study','indicator','威科夫区间与事件'),layerOf('custom','group','对象树'),layerOf('series:candles','series','K 线'));
    const before=JSON.stringify(doc);
    expect(doc.layers.map(layer=>workspaceLayerName(controller,doc,layer,english))).toEqual(['Trend line','Wyckoff ranges and events','对象树','Candlesticks']);
    expect(JSON.stringify(doc)).toBe(before);
    expect(doc.layers.map(layer=>workspaceLayerName(controller,doc,layer,chinese))).toEqual(doc.layers.map(layer=>layer.name));
  });

  it('covers shipped drawing names, groups, field labels and option captions without changing option tokens',()=>{
    const tools=new ToolRegistry();registerDrawingBuiltins(tools);
    for(const label of [...tools.listGroups().map(g=>g.name),...tools.list().flatMap(tool=>[tool.name,...(tool.fields??[]).flatMap(field=>[field.label,...field.options??[]])])]){
      if(/[\u3400-\u9fff]/.test(label)){expect(messages[label],label).toBeTruthy();expect(english(label),label).not.toMatch(/[\u3400-\u9fff]/);}
    }
    const registry=new IndicatorRegistry();registerBuiltins(registry);
    const definition=registry.get('analysis-wyckoff'),source=JSON.stringify(definition.inputs);
    for(const field of definition.inputs){expect(english(field.label),field.label).not.toMatch(/[\u3400-\u9fff]/);for(const token of field.options??[])english(field.optionLabels?.[token]??token);}
    expect(JSON.stringify(definition.inputs)).toBe(source);
  });

  it('covers every runtime builtin metadata leaf and option caption, preserving all canonical values',()=>{
    const registry=new IndicatorRegistry();registerBuiltins(registry);const tools=new ToolRegistry();registerDrawingBuiltins(tools);tools.register(priceZoneTool);
    const definitions=registry.list().filter(definition=>definition.source==='builtin'),drawings=tools.list();
    const before=JSON.stringify({definitions,drawings,groups:tools.listGroups()}),missing:string[]=[];
    const check=(owner:string,key:string,value:unknown)=>{if(typeof value==='string'&&/[\u3400-\u9fff]/.test(value)&&/[\u3400-\u9fff]/.test(english(value)))missing.push(`${owner}.${key}: ${value}`);};
    const fields=(owner:string,inputs:readonly {key:string;label:string;description?:string;group?:string;options?:string[];optionLabels?:Record<string,string>}[])=>{
      for(const input of inputs){for(const key of ['label','description','group'] as const)check(owner,`${input.key}.${key}`,input[key]);
        for(const option of input.options??[])check(owner,`${input.key}.option:${option}`,input.optionLabels?.[option]??option);
        for(const [option,caption] of Object.entries(input.optionLabels??{}))check(owner,`${input.key}.optionLabels:${option}`,caption);
      }
    };
    for(const definition of definitions){for(const key of ['name','title','description'] as const)check(definition.id,key,definition[key]);fields(definition.id,definition.inputs);}
    for(const drawing of drawings){check(drawing.id,'name',drawing.name);fields(drawing.id,drawing.fields??[]);}
    for(const group of tools.listGroups())check(group.id,'group.name',group.name);
    expect(definitions.length).toBeGreaterThan(20);expect(drawings.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);expect(JSON.stringify({definitions,drawings,groups:tools.listGroups()})).toBe(before);
    expect(registry.get('pattern-huzi').inputs.find(input=>input.key==='historyDisplay')?.options).toEqual(['active','all']);
    expect(registry.get('pattern-harmonic').inputs.find(input=>input.key==='family')?.options?.[0]).toBe('全部');
  });

  it('preserves user-supplied interpolation text while localizing canonical feedback',()=>{
    expect(translate('移入 {0}',{0:'对象树'},'en-US')).toBe('Move into 对象树');
    expect(translate('已创建 {0}',{0:'我的列表'},'en-US')).toBe('Created 我的列表');
    expect(translate('已删除 {0}，可撤销',{0:'保存'},'en-US')).toBe('Deleted 保存; undo is available');
  });

  it('localizes price-zone controls and intent captions while leaving the drawn user annotation untouched',()=>{
    const language=getLocale(),drawing:Drawing={id:'zone',toolId:'price-zone',paneId:'main',points:[{time:1,value:90},{time:2,value:100}],props:{label:'对象树',intent:'支撑'},style:{color:'#ffffff',width:1,dash:'solid',fillOpacity:.2},locked:false,hidden:false};
    const projection={project:(point:{time:number;value:number})=>({x:point.time*100,y:point.value})} as Projection;
    const before=JSON.stringify(drawing);
    try{locale.set('en-US');expect(priceZoneTool.build(drawing,projection).find(p=>p.kind==='text')).toMatchObject({text:'对象树 · Support'});
      locale.set('zh-CN');expect(priceZoneTool.build(drawing,projection).find(p=>p.kind==='text')).toMatchObject({text:'对象树 · 支撑'});
      expect(JSON.stringify(drawing)).toBe(before);expect(priceZoneTool.fields?.find(f=>f.key==='intent')?.options).toEqual(['观察','支撑','阻力']);
    }finally{locale.set(language);}
  });

  it('localizes canonical readout states and builtin output names while preserving external and custom series names',()=>{
    const registry=new IndicatorRegistry();registerBuiltins(registry);registry.register({id:'user-study',name:'对象树',source:'custom',target:'main',inputs:[],calc:()=>[]});
    const controller={registry} as ChartController,doc=emptyScene();
    doc.indicators.push({id:'analysis-wyckoff',instanceId:'native',params:{},timeframe:'chart',hiddenPlots:[]},{id:'user-study',instanceId:'custom',params:{},timeframe:'chart',hiddenPlots:[]});
    const canonical=(value:unknown)=>translateCanonical(value,undefined,'en-US');
    expect(workspacePlotName(controller,doc,'native','看涨形态',canonical)).not.toMatch(/[\u3400-\u9fff]/);
    expect(workspacePlotName(controller,doc,'custom','看涨形态',canonical)).toBe('看涨形态');
    expect(workspacePlotName(controller,doc,'external:series:plot','对象树',canonical)).toBe('对象树');
    expect(workspaceLayerName(controller,doc,layerOf('custom','indicator','对象树'),canonical)).toBe('对象树');
    for(const status of ['正在计算','分析证据 · 见分析面板','已确认形态 · 见分析面板','历史不足 / 指标预热中','按收盘规则确认','实时 · 当前周期','实时 · 固定周期','末端实时预览 · 历史已确认','外部数据源','当前周期不显示','分组已隐藏'])expect(canonical(status),status).not.toMatch(/[\u3400-\u9fff]/);
    expect(translateError('绘图工具出错：自定义工具返回了无效坐标','en-US')).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('localizes owned measurement/position captions without translating editable drawing text or manual anchor labels',()=>{
    const language=getLocale(),tools=new ToolRegistry();registerDrawingBuiltins(tools);
    const drawing:Drawing={id:'owned',toolId:'long-position',paneId:'main',points:[{time:60000,value:100},{time:120000,value:120},{time:180000,value:90}],props:{},style:{color:'#ffffff',width:1,dash:'solid',fillOpacity:.2},locked:false,hidden:false};
    const p={project:(point:{time:number;value:number})=>({x:point.time/1000,y:point.value}),indexAt:(time:number)=>time/60000,pane:{width:800}} as Projection;
    const texts=(toolId:string,value:Drawing)=>tools.get(toolId)!.build(value,p).filter(x=>x.kind==='text').map(x=>x.text);
    const before=structuredClone(drawing);
    try{locale.set('en-US');expect(texts('long-position',drawing)).toEqual(['Target 120.00','Stop 90.00','Long · Risk/reward 2.00']);
      expect(texts('date-price-range',drawing)[0]).toContain('bars');
      expect(texts('text',{...drawing,props:{text:'目标 120 · 对象树'}})).toEqual(['目标 120 · 对象树']);
      expect(texts('analysis-path',{...drawing,props:{labels:'目标,止损,买入'}})).toEqual(['目标','止损','买入']);
      expect(drawing).toEqual(before);locale.set('zh-CN');expect(texts('long-position',drawing)).toEqual(['目标 120.00','止损 90.00','多头 · 盈亏比 2.00']);
    }finally{locale.set(language);}
  });
});
