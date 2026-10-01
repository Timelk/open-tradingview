/** Shared identification profiles. A measured match is not a trade strategy. */
export const HARMONIC_FAMILIES = ['AB=CD', 'Gartley', 'Bat', 'Butterfly', 'Crab', 'Deep Crab', 'Alternate Bat', '5-0', 'Shark', 'Cypher', 'Three Drives'] as const;
export type HarmonicFamily = typeof HARMONIC_FAMILIES[number];
export type Range = readonly [number, number];
export interface HarmonicRule {
  family:HarmonicFamily;name:string;b:Range;c:Range;d:number;bc:Range;abcd?:Range;retracement?:boolean;reference:string;
}
// Existing eight-family profile retained for saved studies. Extras use their
// own point topology; in particular neither Shark nor Cypher has an inside C.
export const HARMONIC_RULES:readonly HarmonicRule[]=[
  {family:'Gartley',name:'加特利',b:[.618,.618],c:[.382,.886],d:.786,bc:[1.13,1.618],abcd:[1,1],retracement:true,reference:'卷一 · Gartley'},
  {family:'Bat',name:'蝙蝠',b:[.382,.618],c:[.382,.886],d:.886,bc:[1.618,2.618],abcd:[1,Infinity],retracement:true,reference:'卷一 · Bat'},
  {family:'Butterfly',name:'蝴蝶',b:[.786,.786],c:[.382,.886],d:1.27,bc:[1.618,2.618],abcd:[1,1.27],reference:'卷一 · Ideal Butterfly'},
  {family:'Crab',name:'螃蟹',b:[.382,.618],c:[.382,.886],d:1.618,bc:[2.618,3.618],abcd:[1,Infinity],reference:'卷一 · Crab'},
  {family:'Deep Crab',name:'深蟹',b:[.886,1],c:[.382,.886],d:1.618,bc:[2,3.618],abcd:[1,Infinity],reference:'卷一 · Deep Crab'},
  {family:'Alternate Bat',name:'替代蝙蝠',b:[0,.382],c:[.382,.886],d:1.13,bc:[2,3.618],reference:'卷二 · Alternate Bat'},
];
export const inHarmonicRange=(value:number,[min,max]:Range,tolerance:number)=>Number.isFinite(value)&&value>=min*(1-tolerance)-1e-10&&value<=max*(1+tolerance)+1e-10;
export const harmonicNumber=(value:unknown,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
