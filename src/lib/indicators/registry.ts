import type {
  CalcContext,
  DerivedSeries,
  IndicatorDef,
  ParamValues,
  ParamSchema,
} from '../core/types';
import { BuiltinCalculator } from './incremental';
import { boll, ema, kdj, macd, rsi, sma } from './calc';
import { builtinStrategies } from './strategies';
import { patternStrategies } from '../patterns/registry';
import {analysisIndicators} from '../analysis/registry';
import {flowIndicators} from '../analysis/flow';

const closeOf = (ctx: CalcContext): Float64Array => ctx.cols.col('close').subarray(0, ctx.cols.length);

function line(name: string, values: Float64Array, color: string, pane: 'main' | 'sub' | 'volume'): DerivedSeries {
  return { name, values, color, pane, plot: 'line' };
}

/** 统一注册表：新增指标只需 register，不改 UI、不改渲染（参数面板由 inputs schema 驱动）。 */
export class IndicatorRegistry {
  private defs = new Map<string, IndicatorDef>();

  register(def: IndicatorDef): void {
    if (this.defs.has(def.id)) throw new Error(`indicator already registered: ${def.id}`);
    this.defs.set(def.id, def);
  }

  get(id: string): IndicatorDef {
    const d = this.defs.get(id);
    if (!d) throw new Error(`unknown indicator: ${id}`);
    return d;
  }

  list(): IndicatorDef[] {
    return [...this.defs.values()];
  }

  defaults(id: string): ParamValues {
    const out: ParamValues = {};
    for (const p of this.get(id).inputs) out[p.key] = p.def;
    return out;
  }
}

export function registerBuiltins(reg: IndicatorRegistry): void {
  const divergenceInputs = ():ParamSchema[] => [
    {key:'showDivergences',label:'显示指标背离',type:'bool',def:true},
    {key:'showDivergenceLabels',label:'显示背离文字',type:'bool',def:true},
    {key:'divergenceStrength',label:'背离拐点左右确认柱数',type:'int',def:3,min:1,max:30,step:1},
  ];
  reg.register({
    id: 'ma',
    createIncremental: (params) => new BuiltinCalculator('ma', params),
    name: 'MA',
    target: 'main',
    inputs: [{ key: 'period', label: '周期', type: 'int', def: 20, min: 1, max: 500, step: 1 }],
    calc: (ctx, p) => {
      const period = p.period as number;
      return [line(`MA(${period})`, sma(closeOf(ctx), period), '#f5c518', 'main')];
    },
  });

  reg.register({
    id: 'ema',
    createIncremental: (params) => new BuiltinCalculator('ema', params),
    name: 'EMA',
    target: 'main',
    inputs: [{ key: 'period', label: '周期', type: 'int', def: 20, min: 1, max: 500, step: 1 }],
    calc: (ctx, p) => {
      const period = p.period as number;
      return [line(`EMA(${period})`, ema(closeOf(ctx), period), '#ff6d00', 'main')];
    },
  });

  reg.register({
    id: 'boll',
    createIncremental: (params) => new BuiltinCalculator('boll', params),
    name: 'BOLL',
    target: 'main',
    inputs: [
      { key: 'period', label: '周期', type: 'int', def: 20, min: 2, max: 500, step: 1 },
      { key: 'mult', label: '倍数', type: 'float', def: 2, min: 0.5, max: 5, step: 0.1 },
    ],
    calc: (ctx, p) => {
      const b = boll(closeOf(ctx), p.period as number, p.mult as number);
      return [
        line('MID', b.mid, '#26a69a', 'main'),
        line('UPPER', b.upper, '#787b86', 'main'),
        line('LOWER', b.lower, '#787b86', 'main'),
      ];
    },
  });

  reg.register({
    id: 'vol',
    createIncremental: (params) => new BuiltinCalculator('vol', params),
    name: 'VOL',
    target: 'volume',
    inputs: [{ key: 'period', label: '均量周期', type: 'int', def: 5, min: 1, max: 200, step: 1 }],
    calc: (ctx, p) => {
      const v = ctx.cols.col('volume').subarray(0, ctx.cols.length);
      return [line(`VOL-MA(${p.period})`, sma(v, p.period as number), '#e8b10c', 'volume')];
    },
  });

  reg.register({
    id: 'macd',
    createIncremental: (params) => new BuiltinCalculator('macd', params),
    name: 'MACD',
    target: 'sub',
    inputs: [
      { key: 'fast', label: '快线', type: 'int', def: 12, min: 1, max: 100, step: 1 },
      { key: 'slow', label: '慢线', type: 'int', def: 26, min: 2, max: 200, step: 1 },
      { key: 'signal', label: '信号', type: 'int', def: 9, min: 1, max: 100, step: 1 },
      ...divergenceInputs(),
    ],
    calc: (ctx, p) => {
      const m = macd(
        closeOf(ctx),
        p.fast as number,
        p.slow as number,
        p.signal as number,
      );
      return [
        line('DIF', m.dif, '#26a69a', 'sub'),
        line('DEA', m.dea, '#ff5252', 'sub'),
        { name: 'MACD', values: m.hist, color: '#787b86', pane: 'sub', plot: 'hist' },
      ];
    },
  });

  reg.register({
    id: 'kdj',
    createIncremental: (params) => new BuiltinCalculator('kdj', params),
    name: 'KDJ',
    target: 'sub',
    inputs: [
      { key: 'n', label: 'N', type: 'int', def: 9, min: 2, max: 100, step: 1 },
      { key: 'm1', label: 'M1', type: 'int', def: 3, min: 1, max: 50, step: 1 },
      { key: 'm2', label: 'M2', type: 'int', def: 3, min: 1, max: 50, step: 1 },
      ...divergenceInputs(),
    ],
    calc: (ctx, p) => {
      const n = ctx.cols.length;
      const r = kdj(
        ctx.cols.col('high').subarray(0, n),
        ctx.cols.col('low').subarray(0, n),
        ctx.cols.col('close').subarray(0, n),
        p.n as number,
        p.m1 as number,
        p.m2 as number,
      );
      return [
        line('K', r.k, '#2962ff', 'sub'),
        line('D', r.d, '#ff6d00', 'sub'),
        line('J', r.j, '#c2185b', 'sub'),
      ];
    },
  });

  reg.register({
    id: 'rsi',
    createIncremental: (params) => new BuiltinCalculator('rsi', params),
    name: 'RSI',
    target: 'sub',
    inputs: [{ key: 'period', label: '周期', type: 'int', def: 14, min: 1, max: 200, step: 1 }, ...divergenceInputs()],
    calc: (ctx, p) => {
      const period = p.period as number;
      return [line(`RSI(${period})`, rsi(closeOf(ctx), period), '#7b1fa2', 'sub')];
    },
  });

  const descriptions: Record<string, {title:string;description:string;tags:string[]}> = {
    ma: {title:'简单移动平均线', description:'对收盘价取等权平均，观察价格趋势与动态支撑阻力。', tags:['趋势','均线','主图']},
    ema: {title:'指数移动平均线', description:'近期价格占更高权重，比简单均线更快反映趋势变化。', tags:['趋势','均线','主图']},
    boll: {title:'布林带', description:'使用均线和标准差绘制价格通道，观察波动收缩与扩张。', tags:['波动率','通道','主图']},
    vol: {title:'成交量均线', description:'显示成交量的移动平均，辅助观察交易活跃程度及量价变化。', tags:['成交量','均线','量价']},
    macd: {title:'指数平滑异同移动平均线', description:'显示快慢均线差、信号线和柱状差值，观察趋势与动量。', tags:['趋势','动量','交叉']},
    kdj: {title:'随机指标', description:'衡量收盘价在近期高低区间的位置，显示 K、D、J 三条平滑序列。', tags:['震荡','超买超卖','动量']},
    rsi: {title:'相对强弱指标', description:'比较平滑上涨与下跌幅度，在 0–100 区间观察相对强弱。', tags:['震荡','超买超卖','动量']},
  };
  for (const [id, metadata] of Object.entries(descriptions)) Object.assign(reg.get(id), {kind:'indicator',source:'builtin',...metadata});
  for (const strategy of [...builtinStrategies(),...patternStrategies(),...analysisIndicators(),...flowIndicators()]) reg.register(strategy);
}
