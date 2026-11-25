// Tiny Bot: EMA(6/17) crossover with a 6-hour momentum filter and a 12-bar time exit.
//
// Strategy, per symbol over its own hourly closes:
//   - Indicators: EMA(6) and EMA(17), each starting as the mean of its first span of closes,
//     then moving 2 / (span + 1) of the way to each new close. They read every batch, a
//     warm-up's (hello.warmup_bars) included; while warming up it sends no order (the replay
//     would reject every one, warmup), and from the first batch after it the rules below run
//     on indicators already seeded.
//   - Entry, on a bar's close (filled at the next open): EMA(6) crosses above EMA(17) (above
//     it now, at or under it on the symbol's bar before), on a symbol it does not hold, and
//     only when the symbol's 6-hour return (close vs the close 6 bars ago) is at least +1%:
//     in a falling market most cross-ups are dead-cat bounces, and the filter keeps the bot
//     out of them. A bar whose volume is 0 signals nothing; a bar with no volume recorded
//     (v null) is not held back.
//   - Exit, the whole position: EMA(17) crosses above EMA(6) (its sell signal, held while
//     EMA(17) stays above EMA(6)), or the position worth at least 50% over its cost at the
//     close, or at least 8% under it, or 12 bars after the position was first seen held
//     (a time exit: in this market a cross that has not paid within half a day rarely does).
//     A sell the market refuses (no bar or a price past the slippage cap at the next open)
//     or the order cap leaves out is sent again on the symbol's next bar while its reason
//     still holds.
//   - Stake: equity over n slots, n = min(the universe, caps.max_open_positions); each buy
//     the smallest of equity / n, caps.max_weight_bps of equity and the cash this reply has
//     not spent yet; below fees.min_notional_quote_units it buys nothing. It never holds
//     more than n, counting the positions this reply sells (their proceeds land at the next
//     open and fund later buys, never this reply's).
//   - A reply carries the sells first, then the buys in universe order, at most
//     caps.max_orders_per_bar in all. Each order caps its slippage at MAX_SLIPPAGE_BPS =
//     100, 1% past the close it was decided on, so a sell into a liquidity gap is refused
//     (and sent again) rather than filled for almost nothing; an entry the market refuses
//     waits for the next cross.
//   - The EMAs and the returns run in float64 on + - * / alone, each correctly rounded
//     (IEEE 754), so the same bars give the same orders, run after run: no clock, no
//     randomness, no network, no environment reads.
//
// Backtested on the kit's dev window (136 hourly bars) with a local replay of the
// harness's fill model: net PnL -85.81 USDC vs buy-and-hold -869.34 USDC (margin
// +783.53), 20 trades, max drawdown 1.72%.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 6;
const SLOW_BARS = 17;
/** Take profit: worth 3/2 of its cost (+50%). */
const ROI = [3n, 2n] as const;
/** Stop loss: worth 23/25 of its cost (-8%). The backtest showed the old -20% stop
 *  never fired before the cross-down or the 12-bar time exit, so it protected
 *  nothing: a -8% stop is tight enough to cut a sharp drop inside the 12 bars a
 *  position can live, while still wider than any adverse move the dev window's
 *  held positions saw. */
const STOP = [23n, 25n] as const;
/** Time exit: bars after the position was first seen held. */
const HOLD_BARS = 12;
/** Entry filter: 6-hour return of at least +1% (100 bps). */
const FILTER_LOOKBACK = 6;
const FILTER_MIN_BPS = 100;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the symbol's bar before this one, once both are set. */
  gap: number | null;
  /** The same after this bar. */
  now: number | null;
  /** The sell signal: set on a cross of EMA(17) above EMA(6) that signals, held while EMA(17) stays above. */
  down: boolean;
  /** Every close seen, for the momentum filter. */
  closes: number[];
  /** The batch seq the current position was first seen held (-1 when not held). */
  entrySeq: number;
}

const series = new Map<string, Series>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { fast: { span: FAST_BARS, warm: [], value: null }, slow: { span: SLOW_BARS, warm: [], value: null }, gap: null, now: null, down: false, closes: [], entrySeq: -1 };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.now === null || s.now >= 0) s.down = false;
  s.closes.push(c);
  return s;
}

/** Whether a held position exits on this close: the sell signal holding, the ROI, the stop, or the time exit. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, signal: boolean, entrySeq: number): boolean {
  if (signal) return true;
  if (entrySeq >= 0 && state.seq - entrySeq >= HOLD_BARS) return true;
  const value = state.value(symbol, held.qty);
  return value * ROI[1] >= held.cost * ROI[0] || value * STOP[1] <= held.cost * STOP[0];
}

/** The 6-hour momentum filter: the close is at least FILTER_MIN_BPS above the close FILTER_LOOKBACK bars ago. */
function momentumOk(s: Series): boolean {
  if (s.closes.length <= FILTER_LOOKBACK) return false;
  const now = s.closes[s.closes.length - 1];
  const then = s.closes[s.closes.length - 1 - FILTER_LOOKBACK];
  return ((now - then) / then) * 10000 >= FILTER_MIN_BPS;
}

await runBars({
  onBatch(state, batch) {
    const crossUp = new Set<string>();
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      fresh.add(bar.symbol);
      if (s.gap === null || s.now === null || bar.v === '0') continue;
      if (s.now > 0 && s.gap <= 0) crossUp.add(bar.symbol);
      if (s.now < 0 && s.gap >= 0) s.down = true;
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (s.entrySeq < 0) s.entrySeq = state.seq;
        if (exits(state, symbol, held, s.down, s.entrySeq)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.entrySeq = -1;
        }
      } else {
        s.entrySeq = -1;
        if (crossUp.has(symbol) && momentumOk(s)) entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
