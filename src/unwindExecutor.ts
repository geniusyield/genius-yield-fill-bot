/**
 * AMM-side unwind executor.
 *
 * The fill bot's primary loop captures one side of an arb: it fills a GY
 * order at a price that diverges from the AMM aggregate. Without an
 * unwind on the AMM side, the bot accumulates one-sided inventory and
 * the "captured spread" is paper, not realized PnL.
 *
 * This module defines the `UnwindExecutor` contract that the loop will
 * call after a successful GY fill, and a reference implementation that
 * routes through DexHunter's `/swap/build` endpoint to find the best
 * counter-side AMM execution across all aggregated Cardano DEXes
 * (Minswap V2, SundaeSwap V3, WingRiders V2, MuesliSwap, VyFinance,
 * Splash, CSwap).
 *
 * STATUS: scaffold only. NOT wired into `loop.ts` yet — wiring +
 * end-to-end testing against DexHunter mainnet is a follow-up PR.
 * Shipping this file early so the audit's design + the integration
 * point are reviewable in isolation.
 *
 * Design notes:
 *  - Unwind happens AFTER the GY fill tx hits the chain. Building it
 *    pre-fill races the chain (the captured inventory doesn't exist
 *    yet) and locks UTxOs that could be used by the GY tx.
 *  - Slippage cap is mandatory. If the AMM has moved between the
 *    decision and the unwind submit, refuse to take a worse fill than
 *    `UNWIND_MAX_SLIPPAGE_BPS` of the originally-quoted spread.
 *  - Failure of the unwind is a soft error: log it, increment a counter,
 *    keep the inventory. Operators get an alert and can unwind manually.
 *    DO NOT retry blindly — a stuck unwind that retries forever is how
 *    bots leak money.
 */

import type {Wallet} from './wallet.js';

export type UnwindDirection = 'sellBase' | 'sellQuote';

export interface UnwindRequest {
  /** What the bot received from the GY fill — the side it now needs to dispose of. */
  direction: UnwindDirection;
  /** Asset to sell on the AMM (policyId+assetName hex). For ADA: empty string. */
  sellAssetIdHex: string;
  /** Asset to receive on the AMM. */
  buyAssetIdHex: string;
  /** Amount of `sellAsset` to dispose of, in raw on-chain units (lovelace for ADA). */
  sellAmount: bigint;
  /** Decision-time fair price (quote per base) used to bound acceptable slippage. */
  decisionPrice: number;
  /** Max acceptable slippage from `decisionPrice`. Default 50 bps. */
  maxSlippageBps: number;
}

export type UnwindResult =
  | {
      kind: 'ok';
      transactionHash: string;
      realizedPrice: number;
      sourceDex: string;
    }
  | {
      kind: 'skipped';
      reason: string;
    }
  | {
      kind: 'failed';
      reason: string;
    };

export interface UnwindExecutor {
  /**
   * Build, sign, and submit an AMM-side unwind tx. Must be idempotent on
   * the caller — repeated calls with the same `UnwindRequest` after a
   * successful submit MUST NOT double-submit. Implementations achieve
   * this with a local dedup cache keyed by request fingerprint.
   */
  unwind(req: UnwindRequest): Promise<UnwindResult>;
}

/**
 * Reference implementation: routes the unwind through DexHunter's
 * `/swap/build` endpoint. DexHunter picks the best AMM execution
 * automatically; the bot only signs + submits.
 *
 * Not yet wired into `loop.ts`. See module-level comment.
 */
export class DexHunterUnwindExecutor implements UnwindExecutor {
  private readonly recentSubmits = new Map<string, UnwindResult>();
  private readonly DEDUP_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly opts: {
      apiKey: string;
      wallet: Wallet;
      apiBaseUrl?: string;
    }
  ) {}

  async unwind(req: UnwindRequest): Promise<UnwindResult> {
    const fingerprint = this.fingerprintOf(req);
    const cached = this.recentSubmits.get(fingerprint);
    if (cached) return cached;

    // Hard-stop guard: refuse to attempt an unwind we know we can't model.
    if (req.sellAmount <= 0n) {
      return {kind: 'skipped', reason: 'sellAmount is zero or negative'};
    }
    if (!isFinite(req.decisionPrice) || req.decisionPrice <= 0) {
      return {kind: 'skipped', reason: 'decisionPrice is non-positive'};
    }

    // Real implementation (next PR):
    //   1. POST {opts.apiBaseUrl}/swap/build with token_in / token_out /
    //      amount_in / slippage / buyer_address (from opts.wallet).
    //   2. Validate response.expected_output gives a price within
    //      maxSlippageBps of decisionPrice.
    //   3. Sign the unsigned CBOR with opts.wallet.signWitness.
    //   4. POST {opts.apiBaseUrl}/swap/submit with the signed witness.
    //   5. Cache the result under fingerprint with DEDUP_TTL_MS.
    //   6. Return UnwindResult.
    void this.opts;

    const stub: UnwindResult = {
      kind: 'skipped',
      reason: 'DexHunterUnwindExecutor not yet wired — scaffold only',
    };
    this.recentSubmits.set(fingerprint, stub);
    setTimeout(() => this.recentSubmits.delete(fingerprint), this.DEDUP_TTL_MS);
    return stub;
  }

  private fingerprintOf(req: UnwindRequest): string {
    return [
      req.direction,
      req.sellAssetIdHex,
      req.buyAssetIdHex,
      req.sellAmount.toString(),
      req.decisionPrice.toFixed(8),
    ].join('|');
  }
}

/**
 * No-op executor for environments where unwind is intentionally disabled
 * (single-sided strategies, paper-trading, dry-run). Returns `skipped`
 * with a clear reason so logs stay informative.
 */
export class NoopUnwindExecutor implements UnwindExecutor {
  async unwind(_req: UnwindRequest): Promise<UnwindResult> {
    return {
      kind: 'skipped',
      reason: 'UNWIND_ENABLED=false — operator hedges externally',
    };
  }
}
