import { parseDrawingDocument } from '../drawing/store';
import type { ToolRegistry } from '../drawing/registry';
import { reconcileDrawings, validateStructure, normalizeDocument } from './model';
import { emptyScene, type SceneDocument } from './types';

export function parseSceneDocument(text:string, registry:ToolRegistry, defaults:SceneDocument=emptyScene()):SceneDocument {
  const raw=JSON.parse(text);
  if(!raw || ![1,2].includes(raw.version))throw Error('不支持的工作区版本');
  const drawings=parseDrawingDocument(JSON.stringify({version:1,drawings:raw.drawings}),registry);
  const doc:SceneDocument=raw.version===1?reconcileDrawings(structuredClone(defaults),drawings):{version:2,layers:raw.layers,drawings,indicators:raw.indicators};
  validateStructure(doc); return normalizeDocument(doc);
}
