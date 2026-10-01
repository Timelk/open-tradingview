<script lang="ts">
  import {canonicalT} from '../../lib/i18n';
  import type {SignalTag} from '../../lib/patterns/signal-tags';
  let {tag}:{tag:SignalTag}=$props();
</script>

<em class="signal-tag" data-tone={tag.tone} data-kind={tag.kind} title={$canonicalT(tag.detail)}>{$canonicalT(tag.label)}</em>

<style>
  .signal-tag{display:inline-block;max-width:100%;padding:1px 5px;border-radius:var(--radius-xs);font:500 10px/1.3 var(--font);font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:1px;color:var(--text-dim);background:var(--bg-hover)}
  .signal-tag[data-tone="good"]{color:var(--accent-strong);background:var(--accent-soft)}
  .signal-tag[data-tone="warn"]{color:var(--warn);background:var(--warn-soft)}
</style>
