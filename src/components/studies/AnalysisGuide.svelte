<script lang="ts">
  import {t} from '../../lib/i18n';
</script>

<details class="analysis-guide">
  <summary>
    <span class="guide-preview" aria-hidden="true"><i class="sample-line"></i><i class="sample-line dashed"></i><i class="marker diamond"></i></span>
    <strong>{$t("读图图例")}</strong>
    <span class="summary-hint">{$t("线、区域与事件标记")}</span>
  </summary>
  <div class="guide-body">
    <div class="legend-block">
      <h4>{$t("先看状态，再看方向")}</h4>
      <p>{$t("OB 与方向事件默认用青绿 / 粉红区分向上 / 向下；FVG 用蓝紫斜纹，VSA 用金色短柱。自选颜色可覆盖默认配色，请同时看名称与状态。")}</p>
      <dl class="line-legend">
        <div><dt><i class="sample-line" aria-hidden="true"></i>{$t("实线")}</dt><dd>{$t("已经形成的结构或区域边界")}</dd></div>
        <div><dt><i class="sample-line dashed" aria-hidden="true"></i>{$t("虚线")}</dt><dd>{$t("观察中、基底参考或投射；结合文字状态阅读")}</dd></div>
        <div><dt><i class="sample-dot limited" aria-hidden="true"></i>{$t("覆盖受限")}</dt><dd>{$t("后续数据或核验范围不足")}</dd></div>
        <div><dt><i class="sample-dot ended" aria-hidden="true"></i>{$t("历史记录")}</dt><dd>{$t("停止持续跟踪，保留用于复盘")}</dd></div>
      </dl>
    </div>
    <div class="legend-block">
      <h4>{$t("区域不是同一种信号")}</h4>
      <div class="zone-legend"><span><i class="sample-zone ob" aria-hidden="true"></i><strong>OB</strong>{$t("推进前的反向基底")}</span><span><i class="sample-zone fvg" aria-hidden="true"></i><strong>FVG</strong>{$t("三柱价格价差")}</span></div>
      <p>{$t("区域来自价格规则；框的起点和首次可知时间可能不同。")}</p>
    </div>
    <div class="legend-block">
      <h4>{$t("事件标记与详情时间线对应")}</h4>
      <div class="event-legend"><span><i class="marker diamond" aria-hidden="true"></i>{$t("建立 / 破位")}</span><span><i class="marker circle" aria-hidden="true"></i>{$t("回访 / 观察事件")}</span><span><i class="marker square" aria-hidden="true"></i>{$t("达到回访深度")}</span><span><i class="marker cross" aria-hidden="true"></i>{$t("失效 / 回补")}</span></div>
      <p>{$t("点击图上标注或下方记录，查看该事件的规则、时间和后续条件。")}</p>
    </div>
  </div>
</details>

<style>
  /* Hallmark · pre-emit critique: P4 H4 E4 S5 R4 V4 */
  .analysis-guide{--guide-pending:var(--warn);--guide-ended:var(--text-dim);--guide-ob:var(--up);--guide-ob-fill:color-mix(in srgb, var(--up) 10%, transparent);--guide-fvg:var(--accent-strong);--guide-fvg-fill:color-mix(in srgb, var(--accent-strong) 18%, transparent);--guide-invalid:var(--text-dim);flex-shrink:0;min-width:0;border-bottom:1px solid var(--line);background:var(--bg-panel);color:var(--text-dim);font-size:11px}
  summary{display:flex;align-items:center;gap:7px;min-height:32px;padding:6px 10px;cursor:pointer;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::after{content:'+';margin-left:auto;color:var(--accent);font:14px var(--mono)}
  .analysis-guide[open] summary::after{content:'−'}
  summary:hover{background:var(--bg-hover)}
  summary:focus-visible{outline:2px solid var(--focus,var(--accent));outline-offset:-2px}
  summary strong{font-size:11px;font-weight:500;color:var(--text)}
  .summary-hint{font-size:10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .guide-preview{display:flex;align-items:center;gap:5px;color:var(--accent);flex-shrink:0}
  .guide-preview .sample-line{width:12px}.guide-preview .marker{width:6px;height:6px;margin-inline:2px}
  .guide-body{padding:0 10px 10px;max-height:min(330px,43vh);overflow:auto;overscroll-behavior:contain}
  .legend-block{padding:10px 0 0}.legend-block+.legend-block{margin-top:9px;border-top:1px solid var(--line)}
  h4{margin:0 0 7px;font-size:11px;font-weight:550;color:var(--text)}
  p{margin:6px 0 0;font-size:11px;line-height:1.7;color:var(--text-dim)}
  .line-legend{display:grid;gap:7px;margin:9px 0 0}.line-legend>div{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px;align-items:start}
  dt{display:flex;align-items:center;gap:7px;color:var(--text);line-height:1.6}dd{margin:0;line-height:1.6}
  .sample-line{display:inline-block;width:20px;border-top:1.5px solid currentColor;color:var(--accent);flex-shrink:0}
  .sample-line.dashed{border-top-style:dashed;color:var(--guide-pending)}
  .sample-dot{display:inline-block;width:7px;height:7px;margin-inline:6px;border-radius:50%;background:currentColor;flex-shrink:0}
  .sample-dot.limited{color:var(--guide-pending)}.sample-dot.ended{color:var(--guide-ended)}
  .zone-legend{display:flex;gap:9px 14px;flex-wrap:wrap}.zone-legend>span{display:flex;align-items:center;gap:6px;line-height:1.6}.zone-legend strong{font:11px var(--mono);color:var(--text)}
  .sample-zone{display:inline-block;flex-shrink:0;width:24px;height:14px;border:1px solid var(--guide-ob);background:var(--guide-ob-fill)}
  .sample-zone.ob{border-left-width:3px}.sample-zone.fvg{border-color:var(--guide-fvg);background:repeating-linear-gradient(135deg,var(--guide-fvg-fill) 0px,var(--guide-fvg-fill) 1px,transparent 1px,transparent 4px)}
  .event-legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}.event-legend>span{display:flex;align-items:center;gap:9px;line-height:1.6}
  .marker{display:inline-block;position:relative;width:9px;height:9px;flex-shrink:0;color:var(--accent);border:1.5px solid currentColor;background:var(--bg-panel)}
  .marker.diamond{transform:rotate(45deg)}.marker.circle{border-radius:50%}.marker.square{background:currentColor}.marker.cross{border:0;color:var(--guide-invalid)}
  .marker.cross::before,.marker.cross::after{content:'';position:absolute;left:4px;top:-1px;width:1.5px;height:11px;background:currentColor;transform:rotate(45deg)}.marker.cross::after{transform:rotate(-45deg)}
  @media(pointer:coarse){summary{min-height:44px}}
  @media(max-width:360px){.summary-hint{display:none}.line-legend>div{grid-template-columns:80px minmax(0,1fr)}.event-legend{column-gap:8px}}
</style>
