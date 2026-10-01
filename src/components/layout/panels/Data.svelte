<script lang="ts">
  import WorkspacePanel from '../../workspace/WorkspacePanel.svelte';
  import type { WorkspacePanelProps } from '../panel-context';
  let {context,density,onClose}:WorkspacePanelProps=$props();
</script>
<WorkspacePanel embedded {density} controller={context.controller} chartState={context.chartState} tab="data" onTab={id=>context.onOpenPanel(id)} {onClose} onOpenLibrary={context.onOpenLibrary} onOpenProperties={context.onOpenProperties} onTreeSelection={context.onTreeSelection}/>
