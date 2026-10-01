<script lang="ts">
  import {t,canonicalT,locale} from '../../lib/i18n';
  import {flowGuideMessages} from '../../lib/i18n/messages-flow-guide';
  import {onMount} from 'svelte';
  import {formatFlowNumber,formatFlowTime,depthDisplayAmount,depthMarkerHeight,FlowHitIndex,type FlowCanvasHit} from '../../lib/flow/canvas-presentation';
  import {footprintPage} from '../../lib/flow/history-view';
  import {footprintImbalances,type TpoStatistics,type InitialBalance} from '../../lib/flow/studies';
  import type {TradeFlowSnapshot,FlowPriceLevel} from '../../lib/flow/types';
  import type {DepthHeatmap,HistoricalFlowAggregate} from '../../lib/flow/persistence-client';
  let {data,mode='footprint',unit='base',heatmap,tpo,tpoStudy,balance,onSeek}:{data?:TradeFlowSnapshot;mode?:'footprint'|'profile'|'tpo'|'heatmap';unit?:'base'|'quote';heatmap?:DepthHeatmap;tpo?:HistoricalFlowAggregate['tpo'];tpoStudy?:TpoStatistics;balance?:InitialBalance;onSeek?:(time:number)=>void}=$props();
  let canvas:HTMLCanvasElement,host:HTMLDivElement,width=$state(320),height=$state(340),columns=$state(6),offset=$state(0),detail=$state('移动指针查看真实价位、时间和数量。');
  let imbalanceMode=$state<'off'|'same'|'diagonal'>('diagonal'),imbalanceRatio=$state(3),minimumVolume=$state(.1),allowZero=$state(false);
  let hitCells:FlowCanvasHit[]=[],hitIndex=new FlowHitIndex(),lastHit:FlowCanvasHit|undefined;
  let hoverFrame=0,hoverPoint:{x:number;y:number}|undefined,canvasRect:DOMRect|undefined;
  const amount=(row:FlowPriceLevel,kind:'buy'|'sell'|'volume'|'delta')=>row[`${kind}${unit==='base'?'Base':'Quote'}` as 'buyBase'];
  const fmt=(v:number|undefined,d=4)=>formatFlowNumber(v,$locale,d);
  const date=(time:number)=>formatFlowTime(time,$locale);
  const guideT=(message:string)=>$locale==='en-US'?(flowGuideMessages[message]??message):message;
  type GuideMark='sell'|'buy'|'delta'|'imbalance'|'off'|'partial'|'volume'|'visits'|'poc'|'value-area'|'single-print'|'balance'|'balance-partial'|'depth-buy'|'depth-sell'|'intensity'|'gap';
  const guideItems=$derived.by(()=>{
    const items:{mark:GuideMark;label:string}[]=[];
    if(mode==='footprint')return [
      {mark:'sell' as const,label:'左侧数字：主动卖量'},{mark:'buy' as const,label:'右侧数字：主动买量'},
      {mark:'delta' as const,label:'底色：绿为净买，红为净卖'},
      {mark:imbalanceMode==='off'?'off' as const:'imbalance' as const,label:imbalanceMode==='off'?'失衡描边已关闭':'描边：达到所设失衡倍率'},
      {mark:'partial' as const,label:'虚线列框：成交覆盖不全'},
    ];
    if(mode==='profile')return [
      {mark:'buy' as const,label:'绿色部分：主动买量'},{mark:'sell' as const,label:'红色部分：主动卖量'},
      {mark:'volume' as const,label:'整条长度：该价档总成交量'},
    ];
    if(mode==='heatmap')return [
      {mark:'depth-buy' as const,label:'绿色横条：买方挂单档位'},{mark:'depth-sell' as const,label:'红色横条：卖方挂单档位'},
      {mark:'intensity' as const,label:unit==='quote'?($locale==='en-US'?'Brighter color: larger resting quote amount':'颜色越亮：该档挂单金额越多'):'颜色越亮：该档挂单数量越多'},
      {mark:'gap' as const,label:'棕色缺口：深度不可重建，不是无成交'},
    ];
    items.push({mark:'visits',label:'蓝条长度：访问该价档的时间块数'});
    if(tpoStudy?.poc!==undefined)items.push({mark:'poc',label:'POC 虚线：访问次数最多的价档'});
    if(tpoStudy?.valueLow!==undefined&&tpoStudy.valueHigh!==undefined)items.push({mark:'value-area',label:'VA 底色：设定比例的时间访问区间'});
    if(tpoStudy?.singlePrints.length)items.push({mark:'single-print',label:'黄色描边：区间内部仅访问一次'});
    if(balance?.low!==undefined&&balance.high!==undefined)items.push(balance.status==='complete'
      ?{mark:'balance',label:'IB 侧括号：初始时段高低点'}
      :{mark:'balance-partial',label:'IB 虚线：初始区间尚未完整覆盖'});
    return items;
  });
  onMount(()=>{const invalidateRect=()=>{canvasRect=undefined;};const observer=new ResizeObserver(([entry])=>{invalidateRect();width=Math.max(1,entry.contentRect.width);height=Math.max(1,entry.contentRect.height);});observer.observe(host);window.addEventListener('scroll',invalidateRect,true);return ()=>{observer.disconnect();window.removeEventListener('scroll',invalidateRect,true);if(hoverFrame)cancelAnimationFrame(hoverFrame);};});
  $effect(()=>{if(data){const page=footprintPage(data.footprint.length,offset,columns);if(offset!==page.offset)offset=page.offset;}});
  $effect(()=>{$locale;data;mode;unit;heatmap;tpo;imbalanceMode;imbalanceRatio;minimumVolume;allowZero;detail='移动指针查看真实价位、时间和数量。';});
  $effect(()=>{$locale;data;mode;unit;heatmap;tpo;tpoStudy;balance;width;height;columns;offset;imbalanceMode;imbalanceRatio;minimumVolume;allowZero;if(canvas)draw();});
  function draw(){
    const ratio=Math.min(2,window.devicePixelRatio||1);if(canvas.width!==Math.round(width*ratio))canvas.width=Math.round(width*ratio);if(canvas.height!==Math.round(height*ratio))canvas.height=Math.round(height*ratio);
    const ctx=canvas.getContext('2d')!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);ctx.fillStyle='#141b22';ctx.fillRect(0,0,width,height);ctx.font='10px ui-monospace,monospace';ctx.textBaseline='middle';hitCells=[];hitIndex=new FlowHitIndex();lastHit=undefined;canvasRect=undefined;
    const left=72,right=width-7,top=12,bottom=height-26,w=right-left,h=bottom-top;if(w<=0||h<=0)return;
    const empty=(text:string)=>{ctx.fillStyle='#9aaec6';ctx.textAlign='center';ctx.fillText($canonicalT(text),width/2,height/2);};
    let low=Infinity,high=-Infinity;
    const page=footprintPage(data?.footprint.length??0,offset,columns),bars=data?.footprint.slice(page.start,page.end)??[];
    const levels=mode==='footprint'?bars.flatMap(bar=>bar.levels):data?.profile??[];
    if(mode==='heatmap'){for(const sample of heatmap?.samples??[])if(sample.book.status==='available')for(const level of [...sample.book.bids,...sample.book.asks]){low=Math.min(low,level.price);high=Math.max(high,level.price);}}
    else {for(const level of levels){low=Math.min(low,level.price);high=Math.max(high,level.priceEnd);}}
    if(!Number.isFinite(low)||!Number.isFinite(high)){empty(mode==='heatmap'?'该区间没有连续、可重建的真实深度':'所选区间暂无成交数据');return;}
    const priceDigits=Math.min(8,Math.max(0,Math.ceil(-Math.log10(data?.aggregation.tickSize??.01))));
    const span=Math.max(high-low,data?.effectivePriceStep??.01),y=(price:number)=>bottom-(price-low)/span*h;
    ctx.strokeStyle='#2c3947';ctx.lineWidth=.6;const ticks=Math.max(1,Math.min(6,Math.floor(h/28)));for(let i=0;i<=ticks;i++){const price=low+span*i/ticks,yy=y(price);ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.textAlign='right';ctx.fillStyle='#94a8c0';ctx.fillText($canonicalT(fmt(price,priceDigits)),left-6,yy);}
    if(mode==='heatmap'){
      const samples=heatmap?.samples??[],cellW=w/Math.max(1,samples.length);let max=0,observedStep=Infinity;
      for(const sample of samples)if(sample.book.status==='available')for(const side of ['bids','asks'] as const){const levels=sample.book[side];for(let i=0;i<levels.length;i++){const level=levels[i],value=depthDisplayAmount(level,unit);if(Number.isFinite(value))max=Math.max(max,value);if(i){const gap=Math.abs(level.price-levels[i-1].price);if(gap>0)observedStep=Math.min(observedStep,gap);}}}
      const markerHeight=depthMarkerHeight(data?.aggregation.tickSize??(Number.isFinite(observedStep)?observedStep:undefined),span,h);
      samples.forEach((sample,i)=>{
        const x=left+i*cellW;if(sample.book.status!=='available'){ctx.fillStyle='#312b26';ctx.fillRect(x,top,cellW,h);if(cellW>22){ctx.fillStyle='#bcaa91';ctx.textAlign='center';ctx.fillText($t("缺口"),x+cellW/2,top+10);}return;}
        for(const side of ['bids','asks'] as const)for(const level of sample.book[side]){const value=depthDisplayAmount(level,unit);if(!Number.isFinite(level.price)||!Number.isFinite(value)||value<=0)continue;const yy=y(level.price),alpha=.15+.8*Math.sqrt(value/Math.max(Number.EPSILON,max));ctx.fillStyle=side==='bids'?`rgba(82,185,166,${alpha})`:`rgba(213,120,134,${alpha})`;ctx.fillRect(x,yy-markerHeight/2,cellW+1,markerHeight);hitCells.push({kind:'depth',left:x,right:x+cellW,top:yy-Math.max(2,markerHeight/2),bottom:yy+Math.max(2,markerHeight/2),time:sample.time,side,price:level.price,quantity:level.quantity});}
      });
      ctx.textAlign='left';ctx.fillStyle='#a2b7d2';if(samples.length){ctx.fillText($canonicalT(date(samples[0].time)),left,bottom+14);ctx.textAlign='right';ctx.fillText($canonicalT(date(samples.at(-1)!.time)),right,bottom+14);}
    }else if(mode==='footprint'){
      if(!bars.length){empty('暂无时间块');return;}const cellW=w/bars.length,max=Math.max(1,...levels.map(l=>Math.abs(amount(l,'delta')))),step=data!.effectivePriceStep;
      bars.forEach((bar,i)=>{const x=left+i*cellW,imbalances=new Map((imbalanceMode==='off'?[]:footprintImbalances(bar.levels,data!.effectivePriceStepTicks,{mode:imbalanceMode,ratio:imbalanceRatio,minVolume:minimumVolume,unit,allowZero})).map(value=>[value.tick,value]));ctx.strokeStyle=bar.partial?'#8b785b':'#334150';ctx.setLineDash(bar.partial?[3,4]:[]);ctx.strokeRect(x,top,cellW,h);ctx.setLineDash([]);
        for(const level of bar.levels){const y0=y(level.priceEnd),rh=Math.max(1,y(level.price)-y0),delta=amount(level,'delta'),alpha=.12+.7*Math.sqrt(Math.abs(delta)/max);ctx.fillStyle=delta>=0?`rgba(76,181,161,${alpha})`:`rgba(207,113,128,${alpha})`;ctx.fillRect(x+1,y0,cellW-2,rh);
          const imbalance=imbalances.get(level.tick);if(imbalance){ctx.lineWidth=1.5;ctx.setLineDash([]);if(imbalance.buyRatio!==undefined){ctx.strokeStyle='#93e4ca';ctx.strokeRect(x+cellW/2,y0+.5,Math.max(1,cellW/2-1),Math.max(1,rh-1));}if(imbalance.sellRatio!==undefined){ctx.strokeStyle='#f5a7b0';ctx.strokeRect(x+1,y0+.5,Math.max(1,cellW/2-1),Math.max(1,rh-1));}ctx.lineWidth=.6;}
          if(rh>=13&&cellW>=70){ctx.fillStyle='#e0e8f0';ctx.textAlign='right';ctx.fillText($canonicalT(fmt(amount(level,'sell'),2)),x+cellW*.47,y0+rh/2);ctx.textAlign='left';ctx.fillText($canonicalT(fmt(amount(level,'buy'),2)),x+cellW*.53,y0+rh/2);}
          hitCells.push({kind:'footprint',left:x,right:x+cellW,top:y0,bottom:y0+Math.max(3,rh),time:bar.endTime-1,bar,level,imbalance});
        }
        ctx.fillStyle='#9fb4cf';ctx.textAlign='center';ctx.fillText($canonicalT(date(bar.time).slice(0,5)),x+cellW/2,bottom+13);
      });
    }else{
      const tpoCounts=new Map((tpo?.rows??[]).map(row=>[row.tick,row.blocks]));
      const counts=levels.map(level=>mode==='tpo'?(tpoCounts.get(level.tick)??data!.footprint.filter(bar=>bar.levels.some(l=>l.tick===level.tick)).length):amount(level,'volume')),max=Math.max(1,...counts);
      if(mode==='tpo'&&tpoStudy?.valueLow!==undefined&&tpoStudy.valueHigh!==undefined){ctx.fillStyle='#314e6c55';ctx.fillRect(left,y(tpoStudy.valueHigh),w,y(tpoStudy.valueLow)-y(tpoStudy.valueHigh));}
      levels.forEach((level,i)=>{const y0=y(level.priceEnd),rh=Math.max(1,y(level.price)-y0),rw=counts[i]/max*w;ctx.fillStyle=mode==='tpo'?'#627fa7':'#aa6572';ctx.fillRect(left,y0,rw,rh);if(mode==='profile'){ctx.fillStyle='#459888';ctx.fillRect(left,y0,rw*amount(level,'buy')/Math.max(Number.EPSILON,amount(level,'volume')),rh);}if(mode==='tpo'&&tpoStudy?.singlePrints.some(range=>level.price>=range.price&&level.price<range.priceEnd)){ctx.strokeStyle='#e4c584';ctx.strokeRect(left+.5,y0+.5,Math.max(1,rw-1),Math.max(1,rh-1));}hitCells.push({kind:'distribution',left,right:left+Math.max(6,rw),top:y0,bottom:y0+Math.max(3,rh),level,count:counts[i],tpo:mode==='tpo'});});
      if(mode==='tpo'&&tpoStudy?.poc!==undefined){ctx.strokeStyle='#bacbe3';ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(left,y(tpoStudy.poc));ctx.lineTo(right,y(tpoStudy.poc));ctx.stroke();ctx.setLineDash([]);}
      if(mode==='tpo'&&balance?.low!==undefined&&balance.high!==undefined){ctx.strokeStyle=balance.status==='complete'?'#95d4c3':'#ae926c';const bx=right-3,yh=y(balance.high),yl=y(balance.low);ctx.setLineDash(balance.status==='complete'?[]:[3,3]);ctx.beginPath();ctx.moveTo(bx-5,yh);ctx.lineTo(bx,yh);ctx.lineTo(bx,yl);ctx.lineTo(bx-5,yl);ctx.stroke();ctx.setLineDash([]);}
      ctx.fillStyle='#9fb4cf';ctx.textAlign='left';ctx.fillText(mode==='tpo'?$t("实际成交访问 · {0}m块", {"0": String(tpo?.blockMs?Math.round(tpo.blockMs/60000):Math.round((data?.aggregation.timeframeMs??60000)/60000))}):$t("主动卖 / 主动买 · {0}", {"0": String(unit==='quote'?'USDT':$t("基础资产"))}),left,bottom+13);
    }
    hitIndex=new FlowHitIndex(hitCells);
  }
  function describeHit(hit:FlowCanvasHit):string {
    if(hit.kind==='depth')return `${$t('{0} UTC · {1} {2} · 数量 {3}',{'0':date(hit.time!), '1':hit.side==='bids'?$t('买档'):$t('卖档'),'2':fmt(hit.price,10),'3':fmt(depthDisplayAmount(hit,unit))})} ${unit==='quote'?'USDT':$t('基础资产')}`;
    if(hit.kind==='distribution')return `${fmt(hit.level.price,10)}–${fmt(hit.level.priceEnd,10)} · ${hit.tpo?$t('已访问时间块'):$t('成交量')} ${fmt(hit.count)}`;
    const {bar,level,imbalance}=hit;
    return $t('{0} UTC{1} · {2}–{3} · 主动卖 {4} / 主动买 {5} / 净量 {6}{7}{8}',{
      '0':date(bar.time),'1':bar.partial?$t(' · 部分覆盖'):'','2':fmt(level.price,10),'3':fmt(level.priceEnd,10),
      '4':fmt(amount(level,'sell')),'5':fmt(amount(level,'buy')),'6':fmt(amount(level,'delta')),
      '7':imbalance?.buyRatio!==undefined?$t(' · 买侧{0}失衡 {1}×',{'0':imbalanceMode==='diagonal'?$t('对角'):$t('同档'),'1':imbalance.buyRatio===Infinity?'∞':fmt(imbalance.buyRatio,1)}):'',
      '8':imbalance?.sellRatio!==undefined?$t(' · 卖侧{0}失衡 {1}×',{'0':imbalanceMode==='diagonal'?$t('对角'):$t('同档'),'1':imbalance.sellRatio===Infinity?'∞':fmt(imbalance.sellRatio,1)}):'',
    });
  }
  function hover(event:PointerEvent){
    hoverPoint={x:event.clientX,y:event.clientY};if(hoverFrame)return;
    hoverFrame=requestAnimationFrame(()=>{hoverFrame=0;if(!hoverPoint)return;canvasRect??=canvas.getBoundingClientRect();const hit=hitIndex.hit(hoverPoint.x-canvasRect.left,hoverPoint.y-canvasRect.top);if(hit===lastHit)return;lastHit=hit;detail=hit?describeHit(hit):'移动指针查看真实价位、时间和数量。';});
  }
  function leave(){hoverPoint=undefined;lastHit=undefined;canvasRect=undefined;if(hoverFrame){cancelAnimationFrame(hoverFrame);hoverFrame=0;}detail='移动指针查看真实价位、时间和数量。';}

</script>
<div class="flow-canvas">
  {#if mode==='footprint'}<div class="canvas-controls"><label>{$t("显示列数")}<select bind:value={columns}>{#each [2,4,6,8,12,20] as n}<option value={n}>{n}</option>{/each}</select></label><button onclick={()=>offset=Math.min(Math.max(0,(data?.footprint.length??0)-1),offset+columns)} disabled={offset+columns>=(data?.footprint.length??0)}>{$t("较早")}</button><button onclick={()=>offset=Math.max(0,offset-columns)} disabled={!offset}>{$t("较近")}</button><button onclick={()=>offset=0} disabled={!offset}>{$t("最新")}</button></div>{/if}
  {#if mode==='footprint'}<details class="imbalance-config"><summary>{$t("失衡 ·")} {imbalanceMode==='off'?$t("关闭"):`${imbalanceMode==='diagonal'?$t("对角"):$t("同档")} ${imbalanceRatio}×`}</summary><div><label>{$t("比较")}<select bind:value={imbalanceMode}><option value="off">{$t("关闭")}</option><option value="same">{$t("同档")}</option><option value="diagonal">{$t("对角")}</option></select></label><label>{$t("倍率")}<input type="number" min="1.1" max="100" step=".1" bind:value={imbalanceRatio}/></label><label>{$t("最小数量（{0}）", {"0":unit==='base'?$t("基础量"):'USDT'})}<input type="number" min="0" step=".1" bind:value={minimumVolume}/></label><label><input type="checkbox" bind:checked={allowZero}/>{$t("允许零对手量")}</label></div><p>{$t("对角：本档主动买 ÷ 下一低档主动卖；主动卖 ÷ 上一高档主动买。缺少相邻档不按零处理。描边仅表示量比，无买卖指令。")}</p></details>{/if}
  {#if mode==='tpo'&&tpoStudy}<div class="study-legend"><span>POC {fmt(tpoStudy.poc??NaN,8)}</span><span>VA {tpoStudy.valueAreaPercent}% {fmt(tpoStudy.valueLow??NaN,8)}–{fmt(tpoStudy.valueHigh??NaN,8)}</span><span>{$t("单印")} {tpoStudy.singlePrints.length} {$t("段")}</span>{#if balance}<span title={$canonicalT((balance.reason)??'')}>IB {balance.status==='complete'?$t("完整"):balance.status==='forming'?$t("形成中"):balance.status==='loading'?$t("查询中"):balance.status==='empty'?$t("无成交"):$t("覆盖不足")} · {fmt(balance.low,8)}–{fmt(balance.high,8)}</span>{/if}</div>{/if}
  <div class="chart-guide" role="group" aria-label={guideT('当前视图图例')} data-flow-guide={mode}>
    <span class="guide-heading">{guideT('读图')}</span>
    <ul>{#each guideItems as item}<li><span class="guide-mark {item.mark}" aria-hidden="true"></span><span>{guideT(item.label)}</span></li>{/each}</ul>
  </div>
  <div class="surface" bind:this={host}><canvas bind:this={canvas} onpointermove={hover} onpointerleave={leave} aria-label={mode==='heatmap'?$t("真实历史深度热图，缺口保留空白"):mode==='footprint'?$t("多柱逐价成交画布，左侧卖量右侧买量"):mode==='tpo'?$t("价格时间访问分布"):$t("逐价成交量分布")}></canvas></div>
  <output>{$canonicalT(detail)}</output><p>{mode==='heatmap'?$t("只展示可由真实快照与连续差分重建的L2；不补画断档。"):mode==='footprint'?$t("每列一个真实时间块，左卖右买；空间不足时显示净量色阶，悬停读取数值。"):$t("统计范围与上方数据覆盖一致；没有按OHLCV均分虚构逐价量。")}{#if mode!=='heatmap'&&data} {$t("当前价格档")} {fmt(data.effectivePriceStep,10)}{$locale==='zh-CN'?"。":"."}{/if}</p>
</div>
<style>.flow-canvas{display:flex;flex-direction:column;min-width:0;min-height:260px;flex:1}.imbalance-config{padding:5px 9px;border-top:1px solid var(--line-strong);font-size:10px;color:var(--text)}.imbalance-config summary{cursor:pointer}.imbalance-config>div{display:flex;flex-wrap:wrap;gap:6px;padding-top:6px}.imbalance-config label{display:flex;align-items:center;gap:4px}.imbalance-config input[type=number]{width:56px}.imbalance-config input,.imbalance-config select{background:var(--surface-raised);border:1px solid var(--line-strong);border-radius:1px;color:var(--accent-strong);padding:3px;font-size:10px}.imbalance-config p{padding:6px 0 0}.study-legend{display:flex;flex-wrap:wrap;gap:5px 10px;padding:6px 9px;font:10px/1.6 var(--mono);color:var(--text);border-bottom:1px solid var(--line-strong)}.surface{position:relative;min-height:220px;flex:1}.surface canvas{display:block;position:absolute;width:100%;height:100%;inset:0}.canvas-controls{display:flex;flex-wrap:wrap;gap:5px;padding:6px 9px;align-items:center}.canvas-controls label{display:flex;gap:5px;align-items:center;font-size:10px;color:var(--text-dim)}.canvas-controls button,.canvas-controls select{background:var(--surface-raised);border:1px solid var(--line-strong);border-radius:1px;color:var(--accent-strong);padding:3px 5px;font-size:10px}.canvas-controls button:disabled{opacity:.4}output{padding:6px 9px;min-height:35px;font:10px/1.6 var(--mono);color:var(--accent-strong);overflow-wrap:anywhere;border-top:1px solid var(--line-strong)}.flow-canvas p{margin:0;padding:0 9px 8px;color:var(--text-dim);font-size:10px;line-height:1.7}
  .chart-guide{--guide-buy:var(--up);--guide-sell:var(--down);--guide-depth-buy:var(--up);--guide-depth-sell:var(--down);--guide-visits:var(--text-muted);--guide-poc:var(--text);--guide-value-area:color-mix(in srgb, var(--bg-active) 33%, transparent);--guide-single:var(--warn);--guide-balance:var(--up);--guide-partial:var(--warn);--guide-gap:var(--bg-hover);display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-bottom:1px solid var(--line-strong);background:var(--bg-panel);flex-shrink:0;min-width:0;color:var(--text);font-size:10px;line-height:1.5}
  .guide-heading{flex-shrink:0;color:var(--text-strong);line-height:17px}.chart-guide ul{display:flex;flex:1;flex-wrap:wrap;column-gap:14px;row-gap:4px;margin:0;padding:0;list-style:none;min-width:0}.chart-guide li{display:flex;align-items:flex-start;gap:5px;min-width:0;max-width:100%;text-wrap:pretty}.chart-guide li>span:last-child{min-width:0;overflow-wrap:anywhere}
  .guide-mark{position:relative;display:inline-block;flex:0 0 15px;width:15px;height:10px;margin-top:3px;box-sizing:border-box}.guide-mark.buy{background:var(--guide-buy)}.guide-mark.sell{background:var(--guide-sell)}.guide-mark.delta,.guide-mark.volume{background:linear-gradient(to right,var(--guide-buy) 0 50%,var(--guide-sell) 50%)}.guide-mark.imbalance{border:1px solid var(--up);border-left-color:var(--down)}.guide-mark.off{border-top:1px solid var(--text-dim);height:1px;margin-top:8px}.guide-mark.partial{border:1px dashed var(--guide-partial)}.guide-mark.visits{background:var(--guide-visits)}.guide-mark.poc{border-top:1px dashed var(--guide-poc);height:1px;margin-top:8px}.guide-mark.value-area{background:var(--guide-value-area);border:1px solid var(--line-strong)}.guide-mark.single-print{border:1px solid var(--guide-single)}.guide-mark.balance,.guide-mark.balance-partial{width:7px;flex-basis:7px;margin-left:8px;border:1px solid var(--guide-balance);border-left:0}.guide-mark.balance-partial{border-color:var(--guide-partial);border-style:dashed}.guide-mark.depth-buy,.guide-mark.depth-sell{height:4px;margin-top:6px;background:var(--guide-depth-buy)}.guide-mark.depth-sell{background:var(--guide-depth-sell)}.guide-mark.intensity{background:linear-gradient(to right,var(--up-soft),var(--guide-depth-buy))}.guide-mark.gap{background:var(--guide-gap);border:1px solid var(--line-strong)}
</style>
