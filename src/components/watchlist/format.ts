import { formatMarketPrice } from '../../lib/core/market-format';
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

export function quotePrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return formatMarketPrice(value);
}

export function quoteChange(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${formatMarketPrice(value)}`;
}

export function quotePercent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function quoteVolume(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '—' : compactFormat.format(value);
}
