import type { DrawingTool } from '../../lib/drawing/types';
import { drawingFontSize, labelHeight } from '../../lib/drawing/labels';
import {translate} from '../../lib/i18n';
/** A real custom tool: no edits to controller, hit testing, sidebar, or history. */
export const priceZoneTool:DrawingTool={
  id:'price-zone',supportsFill:true,supportsLabels:true,name:'价格区域',group:'custom',icon:'zone',points:2,
  fields:[{key:'label',label:'区域名称',type:'text',default:'关注区域'},{key:'intent',label:'用途',type:'select',default:'观察',options:['观察','支撑','阻力']}],
  defaultStyle:{color:'#bb91e2',fillOpacity:.15},
  build(d,p){
    if(d.points.length<2)return [];
    const [a,b]=d.points.map(p.project),high=Math.max(d.points[0].value,d.points[1].value),low=Math.min(d.points[0].value,d.points[1].value);
    const size=drawingFontSize(d),offset=labelHeight(size)/2+3;
    const intent=String(d.props.intent),caption=['观察','支撑','阻力'].includes(intent)?translate(intent):intent;
    // The annotation is user-authored text, even when it equals a UI term.
    return [{kind:'rect',a,b,fill:d.style.color},{kind:'text',at:{x:Math.min(a.x,b.x)+8,y:Math.min(a.y,b.y)+offset},text:`${d.props.label} · ${caption}`,size,background:true},{kind:'text',at:{x:Math.min(a.x,b.x)+8,y:Math.max(a.y,b.y)-offset},text:`${low.toFixed(2)} — ${high.toFixed(2)}`,size,background:true}];
  },
};
