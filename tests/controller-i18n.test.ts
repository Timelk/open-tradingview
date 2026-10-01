import {describe,it,expect,vi} from 'vitest';
import {locale} from '../src/lib/i18n';
import {ChartController} from '../src/lib/chart/controller';

describe('chart language presentation lifecycle',()=>{
 it('translates only unchanged builtin pane and signal source names',()=>{
  const chart=Object.assign(Object.create(ChartController.prototype),{drawing:{document:{indicators:[{id:'builtin',instanceId:'a'},{id:'custom',instanceId:'b'}]}},registry:{list:()=>[{id:'builtin',source:'builtin',name:'成交量'},{id:'custom',source:'custom',name:'保存'}]}});
  locale.set('en-US');try{
   expect(chart.layerDisplayName({id:'a',kind:'indicator',name:'成交量'})).toBe('Volume');
   expect(chart.layerDisplayName({id:'a',kind:'indicator',name:'保存'})).toBe('保存');
   expect(chart.layerDisplayName({id:'b',kind:'indicator',name:'保存'})).toBe('保存');
   expect(chart.layerDisplayName({id:'external:label',kind:'overlay',name:'成交量'})).toBe('成交量');
  }finally{locale.set('zh-CN');}
 });
 it('invalidates native text and paint without resetting view, data, studies or drawings',()=>{
  const viewport={from:150,to:250},store={length:400},document={layers:[{id:'user',name:'保存'}]},engine={init:vi.fn(),setReqs:vi.fn()},publish=vi.fn();
  const chart=Object.assign(Object.create(ChartController.prototype),{
   viewport,store,drawing:{document},engine,publish,projectionCache:new Map([['main',{locale:'zh-CN'}]]),
   markerTooltipKey:'old-tooltip',controlsKey:'old-controls',controlsLayoutKey:'old-layout',readingKey:'old-readings',
   dirty:false,overlayDirty:false,state:{marketRevision:8},generation:3,
  });
  chart.refreshLocale();
  expect(chart.projectionCache.size).toBe(0);expect(chart.dirty).toBe(true);expect(chart.overlayDirty).toBe(true);
  expect([chart.markerTooltipKey,chart.controlsLayoutKey,chart.readingKey]).toEqual(['','','']);expect(chart.controlsKey).toBe('old-controls');
  expect(chart.viewport).toBe(viewport);expect(viewport).toEqual({from:150,to:250});expect(chart.store).toBe(store);expect(chart.drawing.document).toBe(document);
  expect(engine.init).not.toHaveBeenCalled();expect(engine.setReqs).not.toHaveBeenCalled();
  expect(chart.state.marketRevision).toBe(8);expect(chart.generation).toBe(3);expect(publish).toHaveBeenCalledOnce();
 });
});
