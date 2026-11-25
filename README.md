# Tiny Bot: Beat Buy-and-Hold on Solana

[![Tiny Bot, Easy $2](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Nadanese93/tiny-bot-beat-buy-hold-sol/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Nadanese93/tiny-bot-beat-buy-hold-sol/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for the make.fun bounty
"u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1".
It trades hourly Solana bars (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF)
against the buy-and-hold baseline, long only, no leverage, no shorts.

## Strategy

EMA(6/17) crossover with a momentum filter and a 12-bar time exit:

- **Entry:** EMA(6) crosses above EMA(17) on a bar's close, and only when the
  symbol's 6-hour return is at least +1%. In a falling market most cross-ups
  are dead-cat bounces; the filter keeps the bot out of them.
- **Exit:** the whole position when EMA(17) crosses back above EMA(6), or the
  position is worth +50% over its cost, or -20% under it, or 12 bars after
  the position was first seen held.
- **Sizing:** equity over 7 slots, capped at 25% of equity per position and by
  available cash. Sells go first in each reply, then buys in universe order.
- **Slippage:** every order caps slippage at 100 bps past the close it was
  decided on.

The bot speaks the `agent-fun/bars-replay/v1` protocol over stdin/stdout via
the vendored SDK in `vendor/makefun-bars.ts`. It is fully deterministic:
float64 math only, no clock, no randomness, no network, no environment reads.
Orders decided on a bar fill at the next bar's open; while warming up it
sends no orders.

## Backtest (dev window, 136 hourly bars)

Local replay of the harness fill model (1 bar latency, 10 bps fee plus
5 bps slippage, 25% weight cap, flatten at end):

| Entry | Net PnL (USDC) | Trades | Max drawdown |
| --- | --- | --- | --- |
| This bot | -85.81 | 20 | 1.72% |
| Buy-and-hold baseline | -869.34 | 7 | 10.92% |
| EMA(8/21) kit baseline | -173.04 | 28 | 2.51% |

Margin over buy-and-hold: +783.53 USDC on the dev window. The dev window is
a down market, so the bot's edge is staying mostly in cash and only buying
confirmed up-moves. Trade counts on each 72-bar half of the dev window are
10 and 10, comfortably above the 8-trade guardrail for the 72-bar final
window.

## Run

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`.
To grade locally against the kit (process driver, no docker needed):

    node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver process

## Layout

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK
- `.makefun/owner.json` — claim file for the entry wallet
- `LICENSE` — MIT
