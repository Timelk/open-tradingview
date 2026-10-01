/** English for the D-point reading aids of the harmonic layer. Sentences that end in a full stop are registered in
 * both spellings by `withStops` (messages-huzi-extra.ts). */
export const harmonicSignalsMessages:Record<string,string>={
  // The fixed sentences every harmonic description is made of. The original description matches one whole-string
  // template; once a tail sentence is appended it no longer does, so each fixed sentence needs its own entry.
  '{0} 点右侧闭合 K 柱确认后识别；图形锚定实际完成点，确认时间独立记录。':'Recognition follows closed-bar confirmation to the right of {0}; geometry uses the actual completion point and confirmation time is recorded separately. ',
  'PRZ 由结构投影与所设容差构成。':'The PRZ is made of structural projections and the configured tolerance. ',
  '失效参考为 PRZ 远端外扩结构高度的 5%。':'The invalidation reference is the far edge of the PRZ extended by 5% of the structure height. ',
  '失效参考为起点 X。':'The invalidation reference is the start point X. ',
  '辅助参考为最后一腿的 38.2% / 61.8% 回撤，是工程默认测量，不是该家族完整交易管理法，不代表已成交或获利概率。':'Supporting references are 38.2% / 61.8% retracements of the final leg: default measurements, not the family’s complete trade management, and not a filled or probable profit. ',
  // The reference source that opens a description ("卷一 · Gartley" …) is translated whole while the description
  // is a single template; split into its sentences it needs each piece.
  '卷一':'Volume One','卷二':'Volume Two',
  'Alternate AB=CD（延伸腿与 BC 投影共振）':'Alternate AB=CD (extension and BC projection confluence)',
  '5-0（50% BC 与 Reciprocal AB=CD）':'5-0 (50% BC and Reciprocal AB=CD)',
  'TradingView Cypher 工具口径：C 延伸超过 A；D 以 XC 的 78.6% 回撤测量，非 XA。':'TradingView Cypher convention: C extends past A; D is measured as a 78.6% retracement of XC, not XA. ',
  'Carney Shark：0-X-A-B-C，C 为完成点；0X 的 0.886–1.13 与 AB 的 1.618–2.24 投影共振。':'Carney Shark: 0-X-A-B-C, with C as the completion point. The 0.886–1.13 0X and 1.618–2.24 AB projections converge. ',
  '后续 5-0 另行识别。':'A later 5-0 is recognized separately. ',
  'Carney Three Drives 的六点对称识别子集：连续 {0} 扩展；回撤 0.618–0.786；推动与回撤分别检查耗时，最长/最短不超过 {1}。':'A six-point symmetric subset of Carney Three Drives: consecutive {0} extensions, 0.618–0.786 retracements, and separate timing checks for drives and retracements, with longest/shortest at most {1}. ',
  // Inputs and the compact chart label.
  '显示谐波共振信号（MACD 背离 / ATR / 针形 K）':'Show harmonic reading aids (MACD divergence / ATR / pin bar)',
  'ATR 周期':'ATR period',
  'ATR 止损倍数（“2ATR未扎”）':'ATR stop multiple ("2 ATR not pierced")',
  '仅保留带 MACD 背离的谐波':'Keep only harmonics with a MACD divergence',
  '背离':'Divergence',
  // Ratio row.
  'DIF 差 / DIF 极差':'DIF gap / DIF range',
  // Description sentences.
  'D 点具备 MACD(12,26,9) DIF 底背离：价格 {0} 对 {1}，DIF {2} 对 {3}。':'D shows a MACD(12,26,9) DIF bullish divergence: price {0} against {1}, DIF {2} against {3}. ',
  'D 点具备 MACD(12,26,9) DIF 底背离（等高型）：价格 {0} 对 {1}，DIF {2} 对 {3}。':'D shows a MACD(12,26,9) DIF bullish divergence (equal lows): price {0} against {1}, DIF {2} against {3}. ',
  'D 点具备 MACD(12,26,9) DIF 顶背离：价格 {0} 对 {1}，DIF {2} 对 {3}。':'D shows a MACD(12,26,9) DIF bearish divergence: price {0} against {1}, DIF {2} against {3}. ',
  'D 点具备 MACD(12,26,9) DIF 顶背离（等高型）：价格 {0} 对 {1}，DIF {2} 对 {3}。':'D shows a MACD(12,26,9) DIF bearish divergence (equal highs): price {0} against {1}, DIF {2} against {3}. ',
  '背离参照的前一极值取自形态自身的锚点。':"The earlier extreme used for the divergence is one of the pattern's own anchors. ",
  '背离参照的前一极值是 D 之前最近的同侧摆动（不是形态锚点）。':'The earlier extreme used for the divergence is the nearest same-side swing before D (not a pattern anchor). ',
  'ATR({0}) = {1}，D 外侧 {2} ATR 的参考位为 {3}；是否被影线刺穿以后续已收盘 K 线判断。':'ATR({0}) = {1}; the reference {2} ATR beyond D is {3}. Whether a wick has pierced it is judged on later closed candles. ',
  'D 点 K 线为针形（影线占 {0}%，实体占 {1}%）。':'The D candle is a pin bar (wick {0}% of the range, body {1}%). ',
};
