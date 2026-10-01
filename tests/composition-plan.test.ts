import { describe, expect, it } from 'vitest';
import { sceneComposition } from '../src/lib/render/composition-plan';
import type { LayerKind } from '../src/lib/scene/types';

const layer=(kind:LayerKind,paneId='main')=>({kind,paneId});

describe('visible scene composition planning',()=>{
  it('keeps Canvas trade labels on the direct GPU path unless a later same-pane GPU output covers them',()=>{
    const marker={...layer('overlay'),canvas:true,gpu:false};
    expect(sceneComposition([layer('series'),layer('overlay'),marker,layer('indicator','macd')])).toEqual({needsComposition:false,overlayVisible:true});
    expect(sceneComposition([layer('series'),marker,layer('drawing')])).toEqual({needsComposition:false,overlayVisible:true});
    expect(sceneComposition([layer('series'),marker,layer('overlay')])).toEqual({needsComposition:true,overlayVisible:true});
    expect(sceneComposition([layer('series'),layer('indicator'),{...marker,kind:'indicator'}])).toEqual({needsComposition:false,overlayVisible:true});
  });
  it('accounts for ordered mixed study output steps',()=>{
    const label={...layer('indicator'),canvas:true,gpu:false},line={...layer('indicator'),canvas:false,gpu:true};
    expect(sceneComposition([line,label])).toEqual({needsComposition:false,overlayVisible:true});
    expect(sceneComposition([label,line])).toEqual({needsComposition:true,overlayVisible:true});
  });
  it('keeps chart-only and drawings-above-chart scenes on the direct GPU path',()=>{
    expect(sceneComposition([])).toEqual({needsComposition:false,overlayVisible:false});
    expect(sceneComposition([layer('series'),layer('indicator')])).toEqual({needsComposition:false,overlayVisible:false});
    expect(sceneComposition([layer('series'),layer('indicator'),layer('drawing'),layer('drawing')])).toEqual({needsComposition:false,overlayVisible:true});
    expect(sceneComposition([layer('drawing')])).toEqual({needsComposition:false,overlayVisible:true});
  });
  it.each(['series','indicator','overlay'] as const)('preserves a %s drawn above a drawing in its own pane',kind=>{
    expect(sceneComposition([layer('series'),layer('drawing'),layer(kind)])).toEqual({needsComposition:true,overlayVisible:true});
  });
  it('does not composite unrelated panes or structural group entries',()=>{
    const layers=[layer('series'),layer('drawing'),layer('group'),layer('indicator','macd'),layer('drawing','macd'),layer('overlay','volume')];
    expect(sceneComposition(layers)).toEqual({needsComposition:false,overlayVisible:true});
    expect(sceneComposition([...layers,layer('indicator','macd')])).toEqual({needsComposition:true,overlayVisible:true});
  });
  it('detects a drawing below its chart even when another pane interrupts the paint list',()=>{
    expect(sceneComposition([layer('drawing','macd'),layer('series'),layer('drawing'),layer('indicator','macd')])).toEqual({needsComposition:true,overlayVisible:true});
  });
});
