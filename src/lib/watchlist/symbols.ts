import type { MarketSymbol } from './types';
import {fetchBinancePerpetualSymbols} from '../market/binance-contracts';

export const DEFAULT_SYMBOLS: MarketSymbol[] = [
  {symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', name: 'Bitcoin',contractType:'PERPETUAL'},
  {symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', name: 'Ethereum',contractType:'PERPETUAL'},
  {symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', name: 'Solana',contractType:'PERPETUAL'},
];

/** Generic syntax normalization for simulation/imports. Live availability is verified by the directory. */
export function normalizeSymbol(input: string): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim().toUpperCase();
  if (/(?:PERP|PERPETUAL|SWAP)$/.test(text)) return null;
  if (/^[\p{L}\p{N}]{1,20}[/\-][\p{L}\p{N}]{1,20}$/u.test(text)) {
    const symbol = text.replace(/[/\-]/, '');
    return /^[\p{L}\p{N}]{2,40}$/u.test(symbol) ? symbol : null;
  }
  return /^[\p{L}\p{N}]{2,40}$/u.test(text) ? text : null;
}

/** TV's .P notation refers to the same perpetual contract, never a spot alias. */
export function normalizePerpetualSymbol(input:string):string|null {
  if(typeof input!=='string')return null;
  const text=input.trim().toUpperCase().replace(/^BINANCE:/,'').replace(/\.P$/,'');
  const symbol=normalizeSymbol(text);
  return symbol&&/^[\p{L}\p{N}]+USDT$/u.test(symbol)&&symbol.length>4?symbol:null;
}
export async function fetchPerpetualSymbols(signal?:AbortSignal):Promise<MarketSymbol[]>{return fetchBinancePerpetualSymbols(signal);}
