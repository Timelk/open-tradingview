import { PanelRegistry } from '../lib/workspace/registry';
import { BUILTIN_PANELS } from '../lib/workspace/panel-catalog';
import type { WorkspacePanelComponent } from '../components/layout/panel-context';
import Watchlist from '../components/layout/panels/Watchlist.svelte';
import Objects from '../components/layout/panels/Objects.svelte';
import Data from '../components/layout/panels/Data.svelte';
import AnalysisWorkspace from '../components/layout/panels/AnalysisWorkspace.svelte';
import OrderBookTerminal from '../components/orderbook/OrderBookTerminal.svelte';

/** New panels are ordinary Svelte components with the same service contract.
 * Register here (or from a loaded plugin) without changing the workspace shell. */
export {PANEL_GROUPS} from '../lib/workspace/panel-catalog';
const components:Record<string,WorkspacePanelComponent>={watchlist:Watchlist,orderbook:OrderBookTerminal,objects:Objects,data:Data,patterns:AnalysisWorkspace};
export const workspacePanels=new PanelRegistry<WorkspacePanelComponent>();
for(const panel of BUILTIN_PANELS)workspacePanels.register({...panel,component:components[panel.id]});
