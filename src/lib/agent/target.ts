import type {ChartState} from '../chart/controller';
import type {ChartAppearance} from '../chart/appearance';
import type {ColumnView,DerivedSeries,OverlayPlot,ParamValues} from '../core/types';
import type {Viewport} from '../core/viewport';
import type {DrawingEngine} from '../drawing/engine';
import type {Anchor,Pixel} from '../drawing/types';
import type {IndicatorRegistry} from '../indicators/registry';
import type {SceneLayer} from '../scene/types';
import type {PatternCandidateRow,PatternRow} from '../patterns/types';
import type {AnalysisRow} from '../analysis/types';

/** The slice of ChartController the agent bridge depends on. Keeping it an
 * interface lets tests drive the bridge with a real DrawingEngine and column
 * store but without canvases, and keeps controller internals private. */
export interface ChartAgentTarget {
  readonly drawing:DrawingEngine;
  readonly registry:IndicatorRegistry;
  readonly viewport:Viewport;
  readonly data:ColumnView;
  readonly derivedSeries:readonly DerivedSeries[];
  readonly overlayPlots:readonly OverlayPlot[];
  readonly chartState:ChartState;
  readonly chartSize:{width:number;height:number;plotWidth:number;axisWidth:number;axisHeight:number;dpr:number};
  readonly maximizedPaneId:string|null;
  paneGeometry():{id:string;name:string;top:number;height:number;min:number;max:number;manual:boolean}[];
  layerStatus(id:string):{visible:boolean;locked:boolean;opacity:number;reason:string;dataReason:string};
  layerName(layer:SceneLayer):string;
  anchorToPixel(paneId:string,anchor:Anchor):Pixel|null;
  pixelToAnchor(pixel:Pixel):{paneId:string;anchor:Anchor}|null;
  captureImage(maxWidth?:number):HTMLCanvasElement;
  setOverlayGroup(owner:string,plots:OverlayPlot[]):void;
  getPatternRows():PatternRow[];
  getAnalysisRows():AnalysisRow[];
  getPatternCandidates():PatternCandidateRow[];
  getAppearance():ChartAppearance;
  addIndicator(id:string,timeframe?:string,paneId?:string,options?:{params?:ParamValues;name?:string}):string|null;
  setMarket(source:string,symbol:string,interval:string):Promise<void>;
  focusTimeRange(from:number,to:number):void;
  followLatest():void;
  showAll():void;
  zoom(factor:number):void;
  toggleMaximize(id:string):void;
  resetPaneScale(id:string):void;
  /** Synchronously apply pending layout/readings before a read (optional in tests). */
  settle?():void;
}
/** App-level hooks (panels, dialogs) the chart itself does not own. */
export interface AgentUiHooks {
  revealObjects?(ids:string[]):void;
  openProperties?(ids:string[]):void;
}
