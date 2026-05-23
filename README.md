# GeniusYield Fill Bot

Run your own non-custodial market-maker bot on Cardano. Fill GeniusYield
SLV orders by arbing against DexHunter and other external AMMs.

You hold the wallet seed. GeniusYield never sees your key.

License: MIT.

## One-click deploy

The fastest path from "zero" to a running bot — pick a cloud and click.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fgeniusyield%2Fgenius-yield-fill-bot&envs=NETWORK,GY_API_URL,BASE_ASSET_ID,QUOTE_ASSET_ID,WALLET_SEED,BLOCKFROST_API_KEY,AMM_SOURCE,DEXHUNTER_API_KEY,MIN_PROFIT_BPS,MAX_FILL_BASE)

| Host | Setup time | Monthly cost |
|---|---|---|
| **Railway** (button above) | 2 min | $5–10 (free trial) |
| **Fly.io** (`fly launch`) | 5 min | $0–5 |
| **DigitalOcean App Platform** | 5 min | $5+ |
| **Self-hosted Docker** | bring your own | bring your own |

Full deploy instructions for each: **[deploy/README.md](deploy/README.md)**.

You'll need:
- A fresh Cardano wallet (generate via the [GY Bot Console](https://prod.geniusyield.co/bot) or any wallet app)
- A free [Blockfrost](https://blockfrost.io) API key
- A [DexHunter Partner](https://dexhunter.gitbook.io/dexhunter-partners) API key
- A small amount of ADA + your trading-pair token to start (~$50 minimum recommended)

---

## What this bot does

1. Polls `GET /v1/orderbook/:base/:quote` every N seconds.
2. Polls a pluggable AMM source for the current mid-price (Minswap V2 / SundaeSwap / WingRiders / DexHunter aggregate — your choice).
3. For each order in the book, computes the spread vs the AMM mid.
4. If any spread exceeds `MIN_PROFIT_BPS` AND the size is above the order's `minFillAmount`:
   - Calls `POST /v1/orderbook/fill-quote` with the wallet context + fill size.
   - Signs the returned unsigned tx CBOR with the local wallet.
   - Calls `POST /v1/orderbook/fill-submit` with the signed witness + quote ID.
5. On 409 `ORDER_UTXO_CONSUMED`, drops the order and re-polls on the next iteration.

That's the whole arb. The complexity is in the AMM-side execution (which you also need to do, separately).

---

## 5-step quick-start

```bash
# 1. Clone + install
git clone <repo-url> genius-yield-fill-bot
cd genius-yield-fill-bot
yarn install

# 2. Copy and fill .env
cp .env.example .env
# Set WALLET_SEED, BLOCKFROST_API_KEY, BASE_ASSET_ID, QUOTE_ASSET_ID

# 3. Swap the AMM source for a real one
# Edit src/index.ts — replace MockAmmSource with your implementation.

# 4. Smoke-test (no on-chain submissions, just logs)
yarn build && yarn smoke

# 5. Go live
yarn build && yarn start
```

---

## Wiring a real AMM source

`src/ammSource.ts` defines a 1-method interface:

```typescript
export interface AmmSource {
  getMidPrice(baseAssetId: string, quoteAssetId: string): Promise<AmmMidPrice>;
}
```

You return `{ midPrice, source, timestamp }`, where `midPrice` is a decimal string in `quote per base` direction (same as the v1 order-book `price` field). Three common ways to implement:

### A) DexHunter aggregator (easiest — single API)

```typescript
import type {AmmSource, AmmMidPrice} from './ammSource.js';
export class DexHunterAmmSource implements AmmSource {
  constructor(private apiKey: string) {}
  async getMidPrice(base: string, quote: string): Promise<AmmMidPrice> {
    const res = await fetch('https://api-us.dexhunterv3.app/swap/estimate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Partner-Id': this.apiKey},
      body: JSON.stringify({token_in: '' /* ADA */, token_out: assetIdToHex(quote), amount_in: 1, slippage: 1}),
    });
    const data = await res.json();
    return {pair: {baseAssetId: base, quoteAssetId: quote}, midPrice: String(data.net_price), source: 'dexhunter', timestamp: new Date().toISOString()};
  }
}
```

### B) Minswap V2 SDK (direct)

```typescript
import {MinswapAdapter} from '@minswap/sdk';
// Pull pool reserves, compute mid = reserveB / reserveA.
```

### C) Multi-source average

```typescript
class AvgAmmSource implements AmmSource {
  constructor(private sources: AmmSource[]) {}
  async getMidPrice(base: string, quote: string) {
    const ps = await Promise.all(this.sources.map(s => s.getMidPrice(base, quote)));
    const avg = ps.reduce((a, p) => a + Number(p.midPrice), 0) / ps.length;
    return {pair: {baseAssetId: base, quoteAssetId: quote}, midPrice: String(avg), source: 'avg', timestamp: new Date().toISOString()};
  }
}
```

---

## Risk notes (read before going live)

- **Hot wallet only.** Never put treasury funds or signing keys for serious capital in this bot. Use a wallet that holds only working capital you can afford to lose to bugs, RPC issues, or operator error.
- **Cardano block time is ~20 s.** Arb opportunities live for blocks, not seconds. Polling tighter than `POLL_INTERVAL_MS=5000` mostly wastes API calls.
- **Slippage on the AMM side wipes out spreads.** Always quote the AMM round-trip BEFORE quoting GY. Sample size matters: the AMM mid for `1 ADA` is not the AMM mid for `100 ADA`. Production strategies model both sides.
- **Cancellations are common during volatile markets.** Bot is built to handle 409 from both `fill-quote` and `fill-submit` — they're not errors, they're race signals.
- **Quote expires in 30 s.** Wallet-signature latency must stay well under that. If you use a hardware wallet, expect quote expirations and code defensively.
- **Per-fill costs are real.** ~3–5 ADA fixed per fill across network fee, min-UTxO bonds, GY protocol fee, AMM batcher fee. Below ~4 ADA notional spread, no fill is profitable on Cardano regardless of pair.
- **Same-block UTxO consumption is possible.** Multiple takers race for the same order — Cardano's eUTxO model means only one wins per block. The loser gets a clean 409 and refunds the AMM side of their arb leg (if they sequenced correctly).
- **Front-running.** Cardano's mempool model is harder to front-run than EVM, but not impossible. If you see consistent 409s on your best opportunities, suspect a competing bot and consider a faster polling cadence + a smaller spread floor.

---

## Project structure

```
genius-yield-fill-bot/
├── src/
│   ├── index.ts         # Entry: load config, wire deps, run loop
│   ├── config.ts        # Env loading + validation
│   ├── gyClient.ts      # v1 API client (orderbook + fill-quote + fill-submit)
│   ├── wallet.ts        # Lucid Evolution wallet wrapper
│   ├── ammSource.ts     # Pluggable AMM-mid-price interface + mock impl
│   ├── arb.ts           # Arb math: decideAskFill / decideBidFill
│   └── loop.ts          # Main poll → decide → fill loop
├── .env.example
├── package.json
├── tsconfig.json
├── LICENSE              # MIT
└── README.md
```

---

## What this bot does NOT do

- **Doesn't manage the AMM side.** Your bot needs to actually source the counter-asset on Minswap/SundaeSwap/etc. before submitting the GY fill. The example above only shows the GY-side mechanics.
- **Doesn't include a strategy.** The reference logic is "if spread > N bps, take maximum cap." Real fillers tier their size with profit curves, account for slippage, watch for cancellation cascades, etc.
- **Doesn't include MEV protection.** Standard Cardano caveats apply — see notes.
- **Doesn't handle multiple pairs.** Run one bot per pair as separate processes. Or fork and add a pair-router.

---

## See also

- The full architectural audit lives in [`../AUDIT-autonomous-limit-order-crossfill.md`](../AUDIT-autonomous-limit-order-crossfill.md).
- v1 API contract: [`../docs/limit-order-crossfill/v1-api-contract.md`](../docs/limit-order-crossfill/v1-api-contract.md).
- Min-fill economics: [`../docs/limit-order-crossfill/min-fill-economics.md`](../docs/limit-order-crossfill/min-fill-economics.md).
