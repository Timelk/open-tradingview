import type {SceneLayer} from '../scene/types';

/** Hide retired execution output in read-only views of saved workspaces.
 * The stored scene, user drawings (including old sub-pane drawings), and
 * unrelated overlay metadata are preserved for later export or recovery. */
export function visibleSceneLayers<T extends Pick<SceneLayer,'id'|'kind'>>(layers:readonly T[]):T[] {
  return layers.filter(layer=>layer.kind!=='overlay'||!layer.id.startsWith('pine:'));
}
