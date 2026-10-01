/** English for the harmonic resonance tags (signal-tags.ts, resonance.ts) and their panel controls. The tag text is
 * built from filled-in templates, so each sentence has one key with the same placeholders. */
export const resonanceMessages:Record<string,string>={
  // Tags
  'MACD 底背离':'MACD bullish divergence','MACD 顶背离':'MACD bearish divergence',
  'MACD 等高底背离':'MACD equal-low divergence','MACD 等高顶背离':'MACD equal-high divergence',
  '{0}ATR未扎':'{0} ATR held','{0}ATR已扎':'{0} ATR pierced',
  'D 针形K':'Pin bar at D',
  '末端 {0}':'Terminal {0}','{0} {1} 切入':'{0} {1} entry',
  // Details
  'D 点与前一低点几乎等高（{0} → {1}），MACD 的 DIF 由 {2} 升至 {3}：等高底背离。':'D is almost level with the previous low ({0} → {1}) while the MACD DIF rises from {2} to {3}: an equal-low divergence.',
  'D 点低于前一低点（{0} → {1}），MACD 的 DIF 却由 {2} 升至 {3}：动能没有跟随价格创新低（底背离）。':'D is below the previous low ({0} → {1}) but the MACD DIF rises from {2} to {3}: momentum did not follow price to a new low (bullish divergence).',
  'D 点与前一高点几乎等高（{0} → {1}），MACD 的 DIF 由 {2} 降至 {3}：等高顶背离。':'D is almost level with the previous high ({0} → {1}) while the MACD DIF falls from {2} to {3}: an equal-high divergence.',
  'D 点高于前一高点（{0} → {1}），MACD 的 DIF 却由 {2} 降至 {3}：动能没有跟随价格创新高（顶背离）。':'D is above the previous high ({0} → {1}) but the MACD DIF falls from {2} to {3}: momentum did not follow price to a new high (bearish divergence).',
  'ATR({0}) = {1}；D 点外侧 {2} 倍 ATR 位于 {3}，此后闭合 K 线的影线尚未刺穿它。':'ATR({0}) = {1}; {2} ATRs beyond D is {3}, and no wick of a closed candle has pierced it since.',
  'ATR({0}) = {1}；D 点外侧 {2} 倍 ATR 位于 {3}，已被影线刺穿（价格 {4}）。':'ATR({0}) = {1}; {2} ATRs beyond D is {3}, and a wick has pierced it (price {4}).',
  'D 点 K 线的长影线占振幅 {0}%，实体仅占 {1}%：向 PRZ 外侧拒绝价格的针形 K。':'The D candle has a long wick ({0}% of its range) and a small body ({1}%): a pin bar rejecting price beyond the PRZ.',
  '{0} 周期的 {1} 同向完成，PRZ 与本形态重叠 {2}%，D 点相隔 {3} 根 {4} K 线。':'A {1} on the {0} timeframe completed in the same direction; its PRZ overlaps this one by {2}%, and the D points are {3} {4} bars apart.',
  '{0} 起于 D 点前 {1} 根 {2} K 线，方向与谐波一致：末端结构。':'{0} starts {1} {2} bars before D, in the harmonic\'s direction: a structure at the end of the leg.',
  '{0} 起于 D 点后 {1} 根 {2} K 线，方向与谐波一致：末端结构。':'{0} starts {1} {2} bars after D, in the harmonic\'s direction: a structure at the end of the leg.',
  '{0} 周期的 {1} 起于 D 点前 {2} 根 {3} K 线，方向与谐波一致：更小周期切入参考。':'A {1} on the {0} timeframe starts {2} {3} bars before D, in the harmonic\'s direction: a smaller-timeframe entry reference.',
  '{0} 周期的 {1} 起于 D 点后 {2} 根 {3} K 线，方向与谐波一致：更小周期切入参考。':'A {1} on the {0} timeframe starts {2} {3} bars after D, in the harmonic\'s direction: a smaller-timeframe entry reference.',
  // Panel
  '共振':'Resonance','有 MACD 背离':'With MACD divergence','2ATR 未扎':'2 ATR held','有末端结构':'With end structure','有多周期共振':'With multi-timeframe',
  '筛选谐波共振信号':'Filter harmonic resonance signals',
  '只对谐波形态有意义；选择后其他形态会被隐藏':'Only meaningful for harmonics; other patterns are hidden while a filter is chosen',
  '共振信号':'Resonance signals','这些标签是阅读辅助，不是交易信号，也不代表成交或获利概率。':'These tags are reading aids, not trade signals, and say nothing about fills or profit probability.',
  '定位到该形态':'Go to that pattern','信号标签：{0}':'Signal tags: {0}','另有 {0} 个信号标签':'{0} more signal tags',
};
