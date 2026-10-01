// Builds src/lib/ui/icons/catalog.ts: a Lucide subset (ISC) plus project-authored
// trading glyphs on the same 24px grid. Run: node scripts/design/build-icons.mjs <lucide-static>/icon-nodes.json src/lib/ui/icons/catalog.ts
import {readFileSync,writeFileSync} from 'node:fs';
const [nodesPath,out]=process.argv.slice(2);
const lucide=JSON.parse(readFileSync(nodesPath,'utf8'));

// Our semantic name → Lucide icon.
const FROM_LUCIDE={
  star:'star',code:'code-xml',save:'save',plus:'plus',maximize:'maximize-2',fit:'locate-fixed',layout:'layout-dashboard',
  keyboard:'keyboard',search:'search',grip:'grip-vertical',gear:'settings',more:'ellipsis',layers:'layers',
  folder:'folder','folder-add':'folder-plus',copy:'copy',up:'chevron-up',down:'chevron-down',chevron:'chevron-right',
  clock:'clock',candles:'chart-candlestick',settings:'sliders-horizontal',report:'chart-column-increasing',data:'table-2',
  pointer:'mouse-pointer-2',eraser:'eraser',ruler:'ruler',brush:'brush',arrow:'move-up-right',text:'type',
  'mark-up':'arrow-big-up','mark-down':'arrow-big-down',zoom:'zoom-in',magnet:'magnet',lock:'lock',unlock:'lock-open',
  eye:'eye',hidden:'eye-off',trash:'trash',undo:'undo-2',redo:'redo-2',objects:'list-tree',close:'x',
  download:'download',upload:'upload',
};

const dot=(cx,cy,r=1.75)=>({tag:'circle',attrs:{cx:String(cx),cy:String(cy),r:String(r),fill:'currentColor',stroke:'none'}});
const path=(d,extra={})=>({tag:'path',attrs:{d,...extra}});
const tint=(d,opacity='.2')=>path(d,{fill:'currentColor',stroke:'none',opacity});
const pencil=lucide.pencil.map(([tag,attrs])=>({tag,attrs:{...attrs}}));

// Trading glyphs: 1.5px line language shared with Lucide; a filled anchor dot
// marks every point the user places, so drawing tools read as "handles + geometry".
const CUSTOM={
  cross:[path('M12 3v5.5M12 15.5V21M3 12h5.5M15.5 12H21'),dot(12,12,1.25)],
  trend:[path('M5 19 19 5'),dot(5,19),dot(19,5)],
  ray:[path('M5 19 21 3'),dot(5,19),dot(12,12)],
  extended:[path('M3 21 21 3'),dot(8.5,15.5),dot(15.5,8.5)],
  horizontal:[path('M3 12h18'),dot(12,12)],
  vertical:[path('M12 3v18'),dot(12,12)],
  channel:[path('M3.5 12.5 16.5 4'),path('M7.5 20 20.5 11.5'),path('M5.5 16.25 18.5 7.75',{opacity:'.45','stroke-dasharray':'1.5 2.5'}),dot(3.5,12.5),dot(16.5,4),dot(7.5,20)],
  fib:[path('M3 4.5h18'),path('M3 9.5h18',{opacity:'.5'}),path('M3 14.5h18',{opacity:'.5'}),path('M3 19.5h18'),path('M6 19.5 18 4.5',{opacity:'.7'}),dot(6,19.5),dot(18,4.5)],
  pattern:[path('M3 17.5 8.5 7.5 14 14.5 21 5'),dot(3,17.5),dot(8.5,7.5),dot(14,14.5),dot(21,5)],
  triangle:[path('M4 18.5 11.5 5 20 15Z'),dot(4,18.5),dot(11.5,5),dot(20,15)],
  position:[tint('M4 13.5h16v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z'),{tag:'rect',attrs:{x:'4',y:'3.5',width:'16',height:'17',rx:'2'}},path('M4 13.5h16'),path('M12 10.5V6M9.5 8.5 12 6l2.5 2.5')],
  'position-short':[tint('M4 10.5h16v-5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Z'),{tag:'rect',attrs:{x:'4',y:'3.5',width:'16',height:'17',rx:'2'}},path('M4 10.5h16'),path('M12 13.5V18M9.5 15.5 12 18l2.5-2.5')],
  zone:[tint('M3 8h18v8H3Z','.16'),path('M3 8h18M3 16h18'),path('M7 12h10',{opacity:'.45','stroke-dasharray':'1.5 2.5'})],
  rectangle:[{tag:'rect',attrs:{x:'4',y:'6',width:'16',height:'12',rx:'1.5'}},dot(4,6),dot(20,18)],
  ellipse:[{tag:'ellipse',attrs:{cx:'12',cy:'12',rx:'8.5',ry:'6'}},dot(20.5,12)],
  indicator:[path('M3 15.5c2.5 0 3.5-8 6-8s3.5 9 6 9 3.2-5.5 6-5.5'),dot(21,11)],
  stay:[...pencil.map(n=>({...n,attrs:{...n.attrs,transform:'translate(-1.5 -1.5) scale(.86)'}})),path('M18.5 15v6M15.5 18h6')],
  orderbook:[path('M12 3v18M3.5 6H9M5.5 10H9M3.5 14H9M6.5 18H9M15 6h3M15 10h5.5M15 14h4M15 18h5.5')],
  watchlist:[path('M4 6h9M4 12h9M4 18h6'),path('m17.5 4.2 1.1 2.3 2.5.35-1.8 1.75.42 2.5-2.22-1.18-2.22 1.18.42-2.5-1.8-1.75 2.5-.35Z',{'stroke-linejoin':'round'})],
};

const icons={};
for(const [name,source] of Object.entries(FROM_LUCIDE)){
  if(!lucide[source])throw Error(`missing lucide icon ${source}`);
  icons[name]=lucide[source].map(([tag,attrs])=>({tag,attrs:{...attrs}}));
}
for(const [name,nodes] of Object.entries(CUSTOM))icons[name]=nodes;

const header=`/** Icon catalog: Lucide subset (ISC, see LUCIDE-LICENSE.txt) plus project-authored
 * trading glyphs on the same 24px grid and 1.5px line. Drawing tools share one
 * motif: a filled anchor dot at every point the user places. Generated; edit the
 * glyph table in the generator rather than individual paths. */
export type IconNode={tag:"path"|"circle"|"rect"|"line"|"polyline"|"polygon"|"ellipse";attrs:Record<string,string>};
`;
writeFileSync(out,header+`export const icons:Record<string,IconNode[]>=${JSON.stringify(icons)};\n`);
console.log(Object.keys(icons).length,'icons');
