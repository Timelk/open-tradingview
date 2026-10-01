import type { SceneSnapshot } from '../scene/types';
/** Drawing core is framework independent. Data anchors survive pan/zoom/resize. */
export interface Anchor { time: number; value: number }
export interface Pixel { x: number; y: number }
export interface DrawingStyle {
  color: string; width: number; dash: 'solid'|'dashed'|'dotted'; fillOpacity: number;
  /** CSS-pixel label size. Optional so saved v1/v2 drawings remain compatible. */
  fontSize?: number;
}
export type DrawingProps = Record<string, string|number|boolean>;
export interface Drawing {
  id: string; toolId: string; paneId: string; points: Anchor[];
  style: DrawingStyle; props: DrawingProps; locked: boolean; hidden: boolean;
}
export interface DrawingPane { id: string; top: number; height: number; width: number }
export interface Projection {
  pane: DrawingPane;
  project(anchor: Anchor): Pixel;
  indexAt(time: number): number;
}
export type Primitive =
  | {kind:'path'; points:Pixel[]; closed?:boolean; fill?:string; color?:string; dash?:DrawingStyle['dash']}
  | {kind:'rect'|'ellipse'; a:Pixel; b:Pixel; fill?:string; color?:string}
  | {kind:'text'; at:Pixel; text:string; color?:string; align?:'left'|'center'|'right'; size?:number; background?:boolean; maxWidth?:number};
export interface ToolField { key:string; label:string; type:'text'|'number'|'select'; default:string|number; min?:number; max?:number; options?:string[] }
export interface GestureInput { anchor:Anchor; pixel:Pixel }
export interface GestureResult { points:Anchor[]; complete?:boolean }
export interface ToolGesture { pointer(phase:'down'|'move'|'up', input:GestureInput):GestureResult; cancel?():void }
export interface ToolServices { zoomTo(drawing:Drawing):void }
export interface DrawingTool {
  id:string; name:string; group:string; icon:string; order?:number; shortcut?:string;
  mode?:'draw'|'cursor'|'eraser'; cursor?:'crosshair'|'default';
  points?:number; freehand?:boolean; supportsFill?:boolean; supportsLabels?:boolean; fields?:ToolField[]; defaultStyle?:Partial<DrawingStyle>;
  /** Replace only the gesture if a tool needs a different placement interaction. */
  createGesture?():ToolGesture;
  build(drawing:Drawing, projection:Projection):Primitive[];
  handles?(drawing:Drawing):number[];
  hitTest?(pixel:Pixel, drawing:Drawing, projection:Projection):boolean;
  /** Transient tools (e.g. zoom) may consume placement without storing an object. */
  onComplete?(drawing:Drawing, services:ToolServices):'store'|'discard';
}
export interface ToolGroup { id:string; name:string; order:number }
export type MagnetStrength='weak'|'strong';
export interface DrawingHost extends ToolServices {
  paneAt(pixel:Pixel):string|null;
  projection(paneId:string):Projection|null;
  anchorAt(pixel:Pixel,paneId:string,snap:boolean,strength?:MagnetStrength):Anchor|null;
}
export interface DrawingState {
  scene: SceneSnapshot;
  inheritedLocked: boolean;
  activeTool:string; selected:Drawing|null; drawings:Drawing[];
  magnet:boolean; stayDrawing:boolean; locked:boolean; hidden:boolean;
  magnetStrength:MagnetStrength;magnetModifier:boolean;effectiveMagnet:boolean;effectiveMagnetStrength:MagnetStrength;
  canUndo:boolean; canRedo:boolean; placing:boolean; error:string;
}
export const MIN_DRAWING_FONT_SIZE=12,MAX_DRAWING_FONT_SIZE=32;
export const DEFAULT_STYLE:DrawingStyle={color:'#4d91ff',width:2,dash:'solid',fillOpacity:.12,fontSize:13};
