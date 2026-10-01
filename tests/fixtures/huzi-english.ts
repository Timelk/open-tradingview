import {translateCanonical} from '../../src/lib/i18n';
import type {PatternMatch} from '../../src/lib/patterns/types';
import {patternChartLabel} from '../../src/lib/patterns/presentation';

const han=/[㐀-鿿]/;
/** Everything the panel shows for a match, in English. Returns the strings that are still Chinese. */
export function untranslated(match:PatternMatch):string[] {
  // The chart label is built from the translated name, exactly as the canvas does it.
  const labels=[false,true].map(selected=>{const name=translateCanonical(match.name,undefined,'en-US');return patternChartLabel({...match,name},selected);});
  const shown=[match.name,match.description,...match.ratios.flatMap(r=>[r.label,r.expected]),...match.points.map(p=>p.label),...labels];
  const left:string[]=[];
  for(const text of shown){
    const english=translateCanonical(text,undefined,'en-US');
    if(han.test(english))left.push(`${text} → ${english}`);
  }
  return left;
}
