<script lang="ts">
  import {icons} from '../../lib/ui/icons/catalog';
  /** 1.5px on the 24px grid keeps strokes near 1px at rail sizes (16–20px). */
  let {name,size=20,stroke=1.5}:{name:string;size?:number;stroke?:number}=$props();
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon={name}>
  {#each icons[name]??icons.zone as node}<svelte:element this={node.tag} {...node.attrs}/>{/each}
</svg>
