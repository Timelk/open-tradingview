<script lang="ts">
  import {t,canonicalT,locale} from '../../lib/i18n';
  import type {WorkspacePanelContext} from '../layout/panel-context';
  import type {ReviewDecision} from '../../lib/analysis/reviews';
  let {context,kind,instanceId,sourceId}:{context:WorkspacePanelContext;kind:'pattern'|'analysis';instanceId:string;sourceId:string}=$props();
  let decision=$state<ReviewDecision>('pending'),note=$state(''),message=$state(''),revision=$state(0);
  const review=$derived.by(()=>{context.chartState;revision;return context.controller.getObservationReview(kind,instanceId,sourceId);});
  const hasManualCopy=$derived(!!review?.drawingIds?.some(id=>context.controller.drawing.document.drawings.some(d=>d.id===id)));
  let identity='',reviewVersion=-1;
  $effect(()=>{const next=`${kind}:${instanceId}:${sourceId}`,version=review?.updatedAt??0;if(next!==identity||version!==reviewVersion){if(next!==identity)message='';identity=next;reviewVersion=version;decision=review?.decision??'pending';note=review?.note??'';}});
  const locked=$derived.by(()=>{context.chartState;return context.controller.layerStatus(instanceId).locked;});
  function save(){try{message=context.controller.setObservationReview(kind,instanceId,sourceId,decision,note)||'复核已保存；原始自动证据保持不变。';revision++;}catch(error){message=String(error);}}
  function restore(){try{const warning=context.controller.restoreObservation(kind,instanceId,sourceId);decision='pending';note='';revision++;message=warning||'已恢复自动标注；已有手绘保留在对象树，可单独删除或撤销。';}catch(error){message=String(error);}}
  function manual(){try{context.controller.copyObservationToDrawing(kind,instanceId,sourceId);decision='manual';revision++;message=context.controller.analysisPersistenceWarning()||'已生成独立手绘并隐藏原标注。可拖动端点、整体移动、锁定；自动证据未改。';}catch(error){message=String(error);}}
</script>
<details class="review-controls"><summary>{$t("人工复核与校正")} <span>{review?({accepted:$t("接受"),rejected:$t("驳回"),pending:$t("待定"),manual:hasManualCopy?$t("手绘覆盖"):$t("副本已移除")}[review.decision]):$t("未复核")}</span></summary>
  <label>{$t("复核结论")}<select bind:value={decision} disabled={locked}><option value="pending">{$t("待定 / 有分歧")}</option><option value="accepted">{$t("接受这条识别")}</option><option value="rejected">{$t("驳回并隐藏标注")}</option>{#if decision==='manual'}<option value="manual">{$t("手绘覆盖")}</option>{/if}</select></label>
  <label>{$t("备注")}<textarea bind:value={note} maxlength="4000" rows="3" placeholder={$t("例如：右肩不属于同一结构级别")} disabled={locked}></textarea></label>
  <div class="buttons"><button onclick={save} disabled={locked}>{$t("保存复核")}</button><button onclick={manual} disabled={locked} title={$t("复制为可拖动、可撤销的独立绘图；原自动结果保留")}>{$t("转为手动校正")}</button><button onclick={restore} disabled={locked||!review}>{$t("恢复自动")}</button></div>
  {#if review}<small>{new Date(review.updatedAt).toLocaleString($locale)} · {review.ruleVersion??$t("当前规则")}</small>{/if}
  {#if message}<p role="status" class="feedback">{$canonicalT(message)}</p>{/if}
</details>
<style>.review-controls{margin-top:13px;border-block:1px solid var(--line-strong);padding:10px 0;font-size:11px;color:var(--text)}.review-controls summary{cursor:pointer;line-height:1.5}.review-controls summary span{float:right;font-size:10px;color:var(--accent-strong)}.review-controls p{font-size:10px;color:var(--text-dim);line-height:1.7;margin:8px 0}.review-controls label{display:flex;flex-direction:column;gap:5px;margin-top:8px;font-size:10px}.review-controls select,.review-controls textarea{background:var(--bg-panel);border:1px solid var(--line-strong);border-radius:1px;color:var(--text);font:11px var(--font);padding:5px;min-width:0;resize:vertical}.buttons{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.buttons button{font-size:10px;padding:5px 6px;border:1px solid var(--line-strong);color:var(--accent-strong)}.buttons button:hover{background:var(--bg-active)}.buttons button:disabled{opacity:.4;cursor:default}.review-controls small{display:block;margin-top:8px;color:var(--text-dim);font-size:10px}.review-controls .feedback{color:var(--text)}.review-controls :is(button,select,textarea):focus-visible{outline:1px solid var(--accent);outline-offset:1px}</style>
