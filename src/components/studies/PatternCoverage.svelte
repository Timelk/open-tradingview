<script lang="ts">
  import {t,canonicalT,locale} from '../../lib/i18n';
  import type {PatternStudy} from '../../lib/patterns/types';
  import type {ChartState} from '../../lib/chart/controller';
  import {TIMEFRAMES} from '../../lib/scene/types';
  import {describePatternCoverage} from '../../lib/patterns/coverage';
  let {studies,chartState,loading=false,error='',onHistory,onSettings,onShowHistory,onLatest,onRescan}:{studies:PatternStudy[];chartState:ChartState;loading?:boolean;error?:string;onHistory:()=>void;onSettings:(id:string)=>void;onShowHistory:(id:string)=>void;onLatest:()=>void;onRescan:()=>void}=$props();
  const date=(time?:number)=>typeof time==='number'&&Number.isFinite(time)?new Date(time).toLocaleString($locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}):$t('暂无');
</script>
<div class="scan-coverage" aria-label={$t("形态扫描与显示统计")}>
  {#if chartState.historicalSnapshot}<div class="date-status" role="status"><span>{$t("历史快照 · 行情止于")} {date(chartState.latestQuote?.time)}</span><button onclick={onLatest}>{$t("返回实时")}</button></div>
  {:else if !chartState.following}<div class="date-status"><span>{$t("当前正在浏览历史位置")}</span><button onclick={onLatest}>{$t("回到最新行情")}</button></div>{/if}
  {#each studies as study (study.instanceId)}
    {#if study.scan}
      {@const scan=study.scan}
      {@const diagnosis=describePatternCoverage({scope:scan.scope,knowledgeThroughTime:scan.knowledgeThroughTime,scanFrom:scan.fromTime,scanThrough:scan.throughTime,latestBarTime:chartState.latestQuote?.time,latestConfirmedTime:chartState.confirmedBarTime??undefined,latestMatchTime:study.latestMatchTime,latestDisplayedMatchTime:study.latestDisplayedMatchTime,historicalSnapshot:!!chartState.historicalSnapshot,following:chartState.following,intervalMs:TIMEFRAMES[study.timeframe]??TIMEFRAMES[chartState.interval],chartIntervalMs:TIMEFRAMES[chartState.interval]})}
      <details>
        <summary title={$t("展开查看识别数与展示数为何不同")}>{study.name}<span>{$t("匹配")} {scan.poolCapped?'≥':''}{scan.matched??study.count} {$t("· 展示")} {study.count}</span></summary>
        <p class="date-diagnosis" data-diagnosis={diagnosis.code}>{$canonicalT((diagnosis.message)??'')}</p>
        <dl>
          <div><dt>{$t("最新图表K线")}</dt><dd>{date(chartState.latestQuote?.time)}</dd></div>
          <div><dt>{$t("证据开始 · UTC")}</dt><dd>{scan.bars?date(scan.fromTime):$t("暂无已收盘数据")}</dd></div>
          <div><dt>{$t("证据末柱 · UTC")}</dt><dd>{scan.bars?date(scan.throughTime):$t("暂无已收盘数据")}</dd></div>
          {#if scan.knowledgeThroughTime!==undefined}<div><dt>{$t("计算截至 · UTC")}</dt><dd>{date(scan.knowledgeThroughTime)}</dd></div>{/if}
          {#if scan.tileCount!==undefined}<div><dt>{$t("固定证据块")}</dt><dd>{scan.tileCount}</dd></div>{/if}
          <div><dt>{$t("最近识别确认")}</dt><dd>{date(study.latestMatchTime)}</dd></div>
          <div><dt>{$t("最近可见确认")}</dt><dd>{date(study.latestDisplayedMatchTime)}</dd></div>
          <div><dt>{$t("证据扫描量")}</dt><dd>{scan.bars.toLocaleString($locale)} {$t("根")}{(scan.tileCount??0)>1?$t("（含重叠预热）"):''}</dd></div>
          <div><dt>{$t("失效历史过滤")}</dt><dd>{study.filteredInvalidated??0} {$t("个")}</dd></div>
          <div><dt>{$t("当前视口之外")}</dt><dd>{study.outsideViewport??0} {$t("个")}</dd></div>
          <div><dt>{$t("展示上限之外")}</dt><dd>{study.limited??0} {$t("个")}</dd></div>
          {#if scan.durationMs!==undefined}<div><dt>{$t("最近扫描耗时")}</dt><dd>{scan.durationMs.toFixed(1)} ms</dd></div>{/if}
        </dl>
        {#if scan.scanTruncated}<p>{$t("当前可见范围超出单次证据块预算，尚未全部覆盖。请缩小时间范围分段查看；已有结果的确认与失效时间不随缩放改写。")}</p>{/if}
        {#if scan.poolCapped}<p>{$t("当前计算窗口最多保留")} {scan.poolLimit} {$t("个历史匹配，此计数为下限。")}</p>{/if}
        <p>{$t("失效结构默认隐藏，历史记录不计入当前成立数量。缩放仅裁剪图形；确认和失效按计算截至时间判断。观察中结构跟随最新报价。")}</p>
        {#if diagnosis.code==='stale-scan'}<button onclick={onRescan}>{$t("重新识别当前数据")}</button>{/if}
        {#if study.filteredInvalidated}<button disabled={study.locked} onclick={()=>onShowHistory(study.instanceId)} title={$t("显示之前已识别但后来失效的结构；不重新计算")}>{$t("手动查看失效历史（")}{study.filteredInvalidated}{$locale==='zh-CN'?"）":")"}</button>{/if}
        <button onclick={()=>onSettings(study.instanceId)} title={$t("调整结构参考深度、每视口上限或历史模式")}>{$t("调整识别与展示设置")}</button>
      </details>
    {/if}
  {/each}
  {#if loading}<p class="loading" role="status">{$t("正在补足扫描历史 · 实时行情继续更新")}</p>{/if}
  {#if error}<div class="error" role="status"><p>{$canonicalT(error)}</p><button onclick={onHistory}>{$t("重试补充历史")}</button></div>{/if}
</div>
<style>
  .date-status{display:flex;align-items:center;gap:7px;padding:6px 9px;background:var(--bg-hover);border-bottom:1px solid var(--line-strong)}.date-status>span{flex:1;font-size:10px;line-height:1.6}.scan-coverage .date-status button{margin:0;white-space:nowrap;padding:4px 6px}.scan-coverage .date-diagnosis{color:var(--text);padding-left:7px;border-left:2px solid var(--line-strong)}.scan-coverage .date-diagnosis[data-diagnosis='snapshot'],.scan-coverage .date-diagnosis[data-diagnosis='stale-scan']{border-color:var(--warn);color:var(--warn)}
  .scan-coverage{flex:0 0 auto;max-height:160px;overflow:auto;border-top:1px solid var(--line);font-size:10px;color:var(--text-dim)}.scan-coverage details{padding:6px 10px;border-bottom:1px solid var(--line)}.scan-coverage summary{cursor:pointer;line-height:1.6;color:var(--text)}.scan-coverage summary span{float:right;font:10px var(--mono);padding-top:2px;color:var(--text-dim)}.scan-coverage dl{margin:8px 0 0;display:flex;flex-direction:column;gap:7px}.scan-coverage dl>div{display:flex;justify-content:space-between;gap:8px}.scan-coverage dd{margin:0;font:10px var(--mono);text-align:right;color:var(--text)}.scan-coverage p{font-size:10px;line-height:1.7;margin:8px 0 0;color:var(--text-dim)}.scan-coverage button{font-size:10px;padding:5px 7px;margin-top:7px;background:var(--bg-active);color:var(--accent-strong);border:1px solid var(--line-strong)}.scan-coverage button:hover{background:var(--bg-active)}.scan-coverage .loading{padding:6px 10px;margin:0;color:var(--text)}.scan-coverage .error{padding:5px 10px 9px}.scan-coverage .error p{color:var(--warn);margin:0}
</style>
