import {zoneMessages} from '../patterns/huzi-zone';
import {cupMessages} from '../patterns/huzi-cup';
import {accelMessages} from '../patterns/huzi-accel';
import {shouldersMessages} from '../patterns/huzi-shoulders';
import {harmonicSignalsMessages} from './messages-harmonic-signals';
import {resonanceMessages} from './messages-resonance';

/** English for the Huzi structures' tail sentences and the newer families (zone, cup / arc, acceleration,
 * shoulder composites). Every note the detector appends to a description is a separate sentence ending in a
 * full stop, so the translator can render it on its own even when the fixed template around it matches. */
const sentences:Record<string,string>={
  // Tail sentences shared by every family.
  '四点提前突破（无 E 点），未等待第五触点。':'Early four-point breakout (no E point): the fifth touch was not awaited. ',
  '{0} 个连续边界触点。':'{0} consecutive boundary touches. ',
  '边界取自贴边触点并包住其间价格（不要求内部小拐点落在线上）。':'The boundaries run through the touches that lie on them and contain the price in between (interior wiggles need not sit on the lines). ',
  '幅度层级过滤：仅压缩前腿 {0}% 以内且随后已确认延伸的小回撤。':'Amplitude-level filter: only pullbacks within {0}% of the previous leg that were later followed by a confirmed extension are compressed. ',
  '先行走势上行，向上突破，判为中继。':'The approach was up and the breakout is up: a continuation. ',
  '先行走势上行，向下突破，判为反转。':'The approach was up and the breakout is down: a reversal. ',
  '先行走势下行，向上突破，判为反转。':'The approach was down and the breakout is up: a reversal. ',
  '先行走势下行，向下突破，判为中继。':'The approach was down and the breakout is down: a continuation. ',
  '后续存在无效行情，生命周期停在缺口之前，不能视为最新状态。':'Later market data is invalid. The lifecycle stops before the gap and is not the latest state. ',
};

/** A description that carries several tail sentences is split at each full stop before translation, and the
 * parts arrive without it: register both spellings of every sentence. */
export const withStops=(messages:Record<string,string>)=>Object.fromEntries(Object.entries(messages).flatMap(([source,target])=>
  source.endsWith('。')?[[source,target],[source.slice(0,-1),target.replace(/\.\s*$/,'')]]:[[source,target]]));

const familyLabels:Record<string,string>={
  '加速曲线':'Acceleration curve',
  '无E点':'No E point','中继':'Continuation','反转':'Reversal','最小提前突破跨度（柱，0=不限）':'Minimum early-breakout span (bars, 0 = none)',
  '画门 / 水平带':'Zone ("door") / horizontal band','杯柄 / 圆弧':'Cup and handle / rounded base','通道加速':'Channel acceleration',
  '扩展结构（画门 / 杯柄圆弧 / 通道加速 / 头肩复合）':'Extended structures (zones, cups / arcs, acceleration, shoulder composites)',
  '旗杆 / 旗形高度（最小倍数）':'Pole / flag height (minimum multiple)',
};
export const huziExtraMessages:Record<string,string>={...familyLabels,...withStops({...sentences,...zoneMessages,...cupMessages,...accelMessages,...shouldersMessages,...harmonicSignalsMessages}),...resonanceMessages};
