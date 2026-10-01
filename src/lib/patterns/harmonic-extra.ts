import type {ParamValues} from '../core/types';
import type {Pivot} from './pivots';
import type {PatternRatio} from './types';
import {harmonicNumber,inHarmonicRange as inside,type HarmonicFamily,type Range} from './harmonic-rules';

export interface HarmonicSetup {
  family:HarmonicFamily;name:string;points:Pivot[];labels:string[];terminalLabel:string;
  side:number;zone:{low:number;high:number};ratios:PatternRatio[];reference:string;
  invalidation?:number;expiresIndex?:number;
  complete:(terminal:Pivot)=>PatternRatio[]|undefined;
}
const ratio=(label:string,value:number,expected:string):PatternRatio=>({label,value,expected});
const band=(anchor:number,leg:number,range:Range,side:number,tolerance:number)=>{
  const a=anchor-side*leg*range[0]*(1-tolerance),b=anchor-side*leg*range[1]*(1+tolerance);
  return {low:Math.min(a,b),high:Math.max(a,b)};
};
const intersect=(a:{low:number;high:number},b:{low:number;high:number})=>{const low=Math.max(a.low,b.low),high=Math.min(a.high,b.high);return low<high?{low,high}:undefined;};
const symmetry=(durations:number[],max:number)=>durations.every(v=>v>0)&&Math.max(...durations)/Math.min(...durations)<=max+1e-10;

/** Each family owns both its unfinished scaffold and terminal validation.
 * Cypher uses TradingView's documented 1.13–1.414 XC/XA profile (2026-09).
 * Three Drives is the explicit conservative six-point profile: corrections
 * 0.618–0.786, repeated 1.13/1.27/1.618 extensions, comparable bar durations. */
export function extraHarmonicSetups(pivots:readonly Pivot[],params:ParamValues):HarmonicSetup[] {
  const tolerance=harmonicNumber(params.tolerance,.04,.001,.15),family=String(params.family??'全部'),out:HarmonicSetup[]=[];
  if(pivots.length>=4){
    const points=pivots.slice(-4),[p0,p1,p2,p3]=points,side=p3.kind==='high'?1:-1;
    if(family==='全部'||family==='Cypher'){
      const xa=side*(p1.value-p0.value),ab=side*(p1.value-p2.value),xc=side*(p3.value-p0.value);
      if(xa>0&&ab>0&&side*(p2.value-p0.value)>0&&side*(p3.value-p1.value)>0&&inside(ab/xa,[.382,.618],tolerance)&&inside(xc/xa,[1.13,1.414],tolerance)){
        const zone=band(p3.value,xc,[.786,.786],side,tolerance);
        if(side>0){zone.low=Math.max(zone.low,p0.value);zone.high=Math.min(zone.high,p2.value);}else{zone.high=Math.min(zone.high,p0.value);zone.low=Math.max(zone.low,p2.value);}
        if(zone.low<zone.high)out.push({family:'Cypher',name:'赛福',points,labels:['X','A','B','C'],terminalLabel:'D',side,zone,
          ratios:[ratio('AB / XA',ab/xa,'0.382–0.618'),ratio('XC / XA',xc/xa,'1.130–1.414')],invalidation:p0.value,
          reference:'TradingView Cypher 工具口径：C 延伸超过 A；D 以 XC 的 78.6% 回撤测量，非 XA。',
          complete:d=>{const r=side*(p3.value-d.value)/xc;return side*(d.value-p0.value)>0&&side*(p2.value-d.value)>0&&inside(r,[.786,.786],tolerance)?[ratio('CD / XC',r,'0.786')]:undefined;}});
      }
    }
    if(family==='全部'||family==='Shark'){
      const ox=side*(p1.value-p0.value),xa=side*(p1.value-p2.value),ab=side*(p3.value-p2.value);
      // OXABC: B is beyond X, while A is inside OX. The C completion reverses
      // the extreme BC impulse. A later 50% BC reaction belongs to 5-0.
      if(ox>0&&xa>0&&ab>0&&side*(p2.value-p0.value)>0&&side*(p3.value-p1.value)>0&&inside(ab/xa,[1.13,1.618],tolerance)){
        const zone=intersect(band(p1.value,ox,[.886,1.13],side,tolerance),band(p3.value,ab,[1.618,2.24],side,tolerance));
        if(zone)out.push({family:'Shark',name:'鲨鱼',points,labels:['0','X','A','B'],terminalLabel:'C',side,zone,
          ratios:[ratio('AB / XA',ab/xa,'1.130–1.618')],
          reference:'Carney Shark：0-X-A-B-C，C 为完成点；0X 的 0.886–1.13 与 AB 的 1.618–2.24 投影共振。后续 5-0 另行识别。',
          complete:c=>{const bc=side*(p3.value-c.value),xc=side*(p1.value-c.value);return bc>0&&side*(p2.value-c.value)>0&&inside(bc/ab,[1.618,2.24],tolerance)&&inside(xc/ox,[.886,1.13],tolerance)?[ratio('BC / AB',bc/ab,'1.618–2.240'),ratio('XC / 0X',xc/ox,'0.886–1.130')]:undefined;}});
      }
    }
  }
  if(pivots.length>=5&&(family==='全部'||family==='Three Drives')){
    const points=pivots.slice(-5),[origin,one,a,two,b]=points,side=b.kind==='high'?1:-1;
    const drive1=side*(origin.value-one.value),retr1=side*(a.value-one.value),drive2=side*(a.value-two.value),retr2=side*(b.value-two.value);
    const duration1=one.index-origin.index,duration2=two.index-a.index,correction1=a.index-one.index,correction2=b.index-two.index;
    const maxTime=1+harmonicNumber(params.driveTimeTolerance,.5,0,1);
    const multiple=[1.13,1.27,1.618].find(v=>inside(drive2/retr1,[v,v],tolerance));
    if(Math.min(drive1,retr1,drive2,retr2)>0&&side*(one.value-two.value)>0&&side*(origin.value-a.value)>0&&side*(a.value-b.value)>0&&
      inside(retr1/drive1,[.618,.786],tolerance)&&inside(retr2/drive2,[.618,.786],tolerance)&&multiple!==undefined&&
      symmetry([duration1,duration2],maxTime)&&symmetry([correction1,correction2],maxTime)){
      const zone=band(b.value,retr2,[multiple,multiple],side,tolerance);
      if(side>0)zone.high=Math.min(zone.high,two.value);else zone.low=Math.max(zone.low,two.value);
      if(zone.low<zone.high)out.push({family:'Three Drives',name:'三推动',points,labels:['0','1','A','2','B'],terminalLabel:'3',side,zone,
        ratios:[ratio('回撤 A / 推动 1',retr1/drive1,'0.618–0.786'),ratio('回撤 B / 推动 2',retr2/drive2,'0.618–0.786'),ratio('推动 2 / 回撤 A',drive2/retr1,multiple.toFixed(3)),ratio('前两推动耗时比',Math.max(duration1,duration2)/Math.min(duration1,duration2),`≤ ${maxTime.toFixed(2)}`)],
        expiresIndex:b.index+Math.min(duration1,duration2)*maxTime,
        reference:`Carney Three Drives 的六点对称识别子集：连续 ${multiple} 扩展；回撤 0.618–0.786；推动与回撤分别检查耗时，最长/最短不超过 ${maxTime.toFixed(2)}。`,
        complete:three=>{const r=side*(b.value-three.value)/retr2,duration3=three.index-b.index;return side*(two.value-three.value)>0&&inside(r,[multiple,multiple],tolerance)&&symmetry([duration1,duration2,duration3],maxTime)?[ratio('推动 3 / 回撤 B',r,multiple.toFixed(3)),ratio('三推动耗时比',Math.max(duration1,duration2,duration3)/Math.min(duration1,duration2,duration3),`≤ ${maxTime.toFixed(2)}`)]:undefined;}});
    }
  }
  return out;
}
