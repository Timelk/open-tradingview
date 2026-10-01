import type { Drawing } from '../drawing/types';
import type { ParamValues } from '../core/types';

export const TIMEFRAMES: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '7d': 604_800_000, '30d': 2_592_000_000,
};
export type LayerKind = 'series' | 'indicator' | 'drawing' | 'group' | 'overlay';
export interface SceneLayer {
  id: string;
  kind: LayerKind;
  name: string;
  paneId: string;
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  opacity: number;
  /** null = every chart interval; [] = no intervals. Independent of calculation timeframe. */
  intervals: string[] | null;
  createdInterval: string;
}
export interface IndicatorInstance {
  instanceId: string;
  id: string;
  params: ParamValues;
  timeframe: string;
  hiddenPlots: number[];
  /** Per-output display overrides. Missing fields inherit the study defaults. */
  plotStyles?: Record<string,IndicatorPlotStyle>;
}
export interface IndicatorPlotStyle { color?:string;width?:number }
export interface SceneDocument {
  version: 2;
  layers: SceneLayer[];
  drawings: Drawing[];
  indicators: IndicatorInstance[];
}
export interface EffectiveLayer {
  visible: boolean;
  locked: boolean;
  opacity: number;
  reason: string;
}
export interface SceneSnapshot {
  document: SceneDocument;
  selectedIds: string[];
  activeGroupId: string | null;
  interval: string;
  revision: number;
}
export interface DataReading {
  id: string; name: string; paneId: string; timeframe: string;
  visible: boolean; status: string;
  values: { name: string; value: number; color?: string; plotIndex?: number; plot?: 'line'|'hist'|'markers'|'patterns'|'analysis'; hidden?: boolean; unit?: 'price'|'count' }[];
}
export function emptyScene(): SceneDocument {
  return { version: 2, layers: [], drawings: [], indicators: [] };
}
export function layerOf(id: string, kind: LayerKind, name: string, paneId = 'main', extra: Partial<SceneLayer> = {}): SceneLayer {
  return { id, kind, name, paneId, parentId: null, visible: true, locked: false,
    opacity: 1, intervals: null, createdInterval: '1m', ...extra };
}
