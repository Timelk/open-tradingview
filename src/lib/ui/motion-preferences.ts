export type MotionPreference='system'|'reduced'|'off';
export const MOTION_KEY='tvchart.motion.v1';
export function readMotionPreference():MotionPreference{try{const value=localStorage.getItem(MOTION_KEY);return value==='off'||value==='reduced'?value:'system';}catch{return 'system';}}
export function applyMotionPreference(value:MotionPreference){if(typeof document==='undefined')return;document.documentElement.dataset.uiMotion=value;try{localStorage.setItem(MOTION_KEY,value);}catch{}window.dispatchEvent(new Event('ui-motion-change'));}
export function motionReduced():boolean{return typeof window!=='undefined'&&(window.matchMedia('(prefers-reduced-motion: reduce)').matches||document.documentElement.dataset.uiMotion==='off'||document.documentElement.dataset.uiMotion==='reduced');}
