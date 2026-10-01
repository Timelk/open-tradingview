import type { SceneLayer } from '../scene/types';

/** Input is the effective visible paint list, ordered back to front. Canvas
 * drawings can sit above a directly displayed GPU surface unless a later GPU
 * layer covers a drawing in the same pane. Separate panes never overlap. */
export function sceneComposition(layers:readonly (Pick<SceneLayer,'kind'|'paneId'>&{canvas?:boolean;gpu?:boolean})[]):{needsComposition:boolean;overlayVisible:boolean} {
  const drawingPanes=new Set<string>();
  let needsComposition=false,overlayVisible=false;
  for(const layer of layers){
    const canvas=layer.canvas??layer.kind==='drawing';
    const gpu=layer.gpu??(!canvas&&(layer.kind==='series'||layer.kind==='indicator'||layer.kind==='overlay'));
    // Mixed layers submit their GPU primitives before their Canvas labels.
    if(gpu&&drawingPanes.has(layer.paneId))needsComposition=true;
    if(canvas){drawingPanes.add(layer.paneId);overlayVisible=true;}
  }
  return {needsComposition,overlayVisible};
}
