import {describe,it,expect} from 'vitest';
import {layerOf,emptyScene} from '../src/lib/scene/types';
import {contextSelection,layerActionState,paneDrawingIds,visibilityIntervals} from '../src/lib/drawing/context-actions';

const scene=()=>({...emptyScene(),layers:[layerOf('g','group','组'),layerOf('a','drawing','线','main',{parentId:'g'}),layerOf('b','drawing','线'),layerOf('r','drawing','副图线','rsi'),layerOf('i','indicator','RSI','rsi')]});
describe('context actions use the clicked object and real permissions',()=>{
  it('does not reuse stale selection when right-clicking empty space',()=>{expect(contextSelection(['a'],null,scene())).toEqual([]);expect(contextSelection(['a'],'b',scene())).toEqual(['b']);});
  it('preserves a live multi-selection only when its member was clicked',()=>{expect(contextSelection(['a','b','missing'],'a',scene())).toEqual(['a','b']);expect(contextSelection(['a'],'missing',scene())).toEqual([]);});
  it('protects inherited and global locks, while allowing unlocking own lock',()=>{
    const doc=scene();doc.layers[0].locked=true;
    expect(layerActionState(doc,['a'],'1m')).toMatchObject({locked:true,inherited:true,canUnlock:false,canRemove:false});
    expect(layerActionState(doc,['g'],'1m')).toMatchObject({locked:true,inherited:false,canUnlock:true});
    expect(layerActionState(doc,['b'],'1m',true)).toMatchObject({locked:true,inherited:true,canUnlock:false});
  });
  it('does not let a group menu remove or move a locked descendant',()=>{const doc=scene();doc.layers[1].locked=true;expect(layerActionState(doc,['g'],'1m')).toMatchObject({locked:true,canRemove:false,canGroup:false});});
  it('excludes own descendants and wrong panes as grouping destinations',()=>{const doc=scene();doc.layers.push(layerOf('nested','group','子组','main',{parentId:'g'}),layerOf('other','group','另一组'),layerOf('wrong','group','其他窗格','rsi'));expect(layerActionState(doc,['g'],'1m').groups.map(layer=>layer.id)).toEqual(['other']);});
  it('prevents series-containing group clone and deletion',()=>{const doc=scene();doc.layers.push(layerOf('candles','series','K线','main',{parentId:'g'}));expect(layerActionState(doc,['g'],'1m')).toMatchObject({canClone:false,canRemove:false});});
  it('never clears drawings from another pane and preserves locks',()=>{const doc=scene();doc.layers[1].locked=true;expect(paneDrawingIds(doc,'main','1m',true)).toEqual(['b']);expect(paneDrawingIds(doc,'rsi','1m')).toEqual(['r']);});
  it('sets interval visibility without changing calculation timeframe',()=>{expect(visibilityIntervals('1h','all')).toBeNull();expect(visibilityIntervals('1h','current')).toEqual(['1h']);expect(visibilityIntervals('1h','below')).toEqual(['1m','3m','5m','15m','30m','1h']);expect(visibilityIntervals('1h','above')).toEqual(['1h','2h','4h','6h','12h','1d','3d','7d','30d']);});
});
