import { DrawingPluginRegistry } from '../components/drawing/plugin-registry';
import { registerDrawingBuiltins } from '../lib/drawing/builtins';
import { priceZoneTool } from './price-zone/definition';
import PriceZoneEditor from './price-zone/PriceZoneEditor.svelte';

export const drawingPlugins=new DrawingPluginRegistry();
registerDrawingBuiltins(drawingPlugins.core);
drawingPlugins.register({definition:priceZoneTool,Editor:PriceZoneEditor});
