/**
 * Main bot loop. Single trading pair, single AMM source. Production fillers
 * typically run one loop per pair as separate processes.
 */

import type {Config} from './config.js';
import type {AmmSource} from './ammSource.js';
import type {Wallet} from './wallet.js';
import type {Metrics} from './metrics.js';
import {GyClient, GyApiError} from './gyClient.js';
import {decideAskFill, decideBidFill, type ArbDecision} from './arb.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export const runLoop = async (
  cfg: Config,
  gy: GyClient,
  amm: AmmSource,
  wallet: Wallet,
  metrics: Metrics
): Promise<void> => {
  log('startup', {
    pair: `${cfg.baseAssetId}/${cfg.quoteAssetId}`,
    pollIntervalMs: cfg.pollIntervalMs,
    minProfitBps: cfg.minProfitBps,
    maxFillBase: cfg.maxFillBase.toString(),
    ammSource: cfg.ammSource,
    metricsPort: cfg.metricsPort,
    dryRun: cfg.dryRun,
  });

  while (true) {
    try {
      await iterate(cfg, gy, amm, wallet, metrics);
    } catch (err) {
      log('iteration_error', {error: String(err)});
    }
    await sleep(cfg.pollIntervalMs);
  }
};

const iterate = async (
  cfg: Config,
  gy: GyClient,
  amm: AmmSource,
  wallet: Wallet,
  metrics: Metrics
): Promise<void> => {
  const [book, mid] = await Promise.all([
    gy.getOrderBook(cfg.baseAssetId, cfg.quoteAssetId),
    amm.getMidPrice(cfg.baseAssetId, cfg.quoteAssetId),
  ]);

  log('snapshot', {
    asks: book.asks.length,
    bids: book.bids.length,
    ammMid: mid.midPrice,
    ammSource: mid.source,
    asOfTime: book.asOfTime,
  });

  // Find the best profitable opportunity across both sides. Take the first
  // hit per iteration; the next loop will pick up the next-best.
  for (const ask of book.asks) {
    const d = decideAskFill(ask, mid, cfg.minProfitBps, cfg.maxFillBase);
    if (d.kind === 'fill') {
      await tryFill(cfg, gy, wallet, d, 'ask', metrics);
      return;
    }
  }
  for (const bid of book.bids) {
    const d = decideBidFill(bid, mid, cfg.minProfitBps, cfg.maxFillBase);
    if (d.kind === 'fill') {
      await tryFill(cfg, gy, wallet, d, 'bid', metrics);
      return;
    }
  }

  log('no_opportunity', {});
};

const tryFill = async (
  cfg: Config,
  gy: GyClient,
  wallet: Wallet,
  decision: Extract<ArbDecision, {kind: 'fill'}>,
  side: 'ask' | 'bid',
  metrics: Metrics
): Promise<void> => {
  log('opportunity', {
    side,
    orderId: decision.orderId,
    fillBaseAmount: decision.fillBaseAmount.toString(),
    spreadBps: decision.spreadBps,
    gyPrice: decision.gyPrice,
    ammMid: decision.ammMidPrice,
  });

  if (cfg.dryRun) {
    log('dry_run_skip', {});
    return;
  }

  const ctx = await wallet.getContext();

  metrics.recordQuoteAttempt();
  let quote;
  try {
    quote = await gy.fillQuote({
      orderId: decision.orderId,
      fillAmount: {base: decision.fillBaseAmount.toString()},
      taker: ctx,
    });
  } catch (err) {
    if (err instanceof GyApiError && err.status === 409) {
      log('quote_409', {code: err.code});
      metrics.record409();
      return; // next iteration re-polls
    }
    log('quote_error', {error: String(err)});
    return;
  }
  log('quote_ok', {
    quoteId: quote.quoteId,
    expiresAt: quote.expiresAt,
    expectedBase: quote.expectedOutput.base,
    expectedQuote: quote.expectedOutput.quote,
    fees: quote.feeBreakdown,
  });

  let witness: string;
  try {
    witness = await wallet.signWitness(quote.unsignedTxCbor);
  } catch (err) {
    log('sign_error', {error: String(err)});
    return;
  }

  try {
    const submit = await gy.fillSubmit({
      unsignedTxCbor: quote.unsignedTxCbor,
      walletWitness: witness,
      quoteId: quote.quoteId,
      taker: {changeAddress: ctx.changeAddress},
    });
    // Captured profit (lovelace) estimate: gross spread × fill notional in
    // base ADA units. The on-chain reality may differ once protocol fees
    // settle; this is the bot's accounting view for monitoring.
    const profitLovelace = estimateProfitLovelace(decision);
    metrics.recordFill(profitLovelace);
    log('submit_ok', {
      txId: submit.transactionId,
      estProfitLovelace: profitLovelace.toString(),
    });
  } catch (err) {
    if (err instanceof GyApiError && err.status === 409) {
      log('submit_409', {code: err.code});
      metrics.record409();
      return;
    }
    log('submit_error', {error: String(err)});
  }
};

/**
 * Estimate the lovelace profit captured by a fill at decision-time prices.
 * Convention: `fillBaseAmount * spreadBps / 10_000` interpreted in lovelace.
 * Coarse — production strategies track realized PnL from the chain after
 * settlement; this is just for monitoring.
 */
const estimateProfitLovelace = (
  decision: Extract<ArbDecision, {kind: 'fill'}>
): bigint => {
  const spreadFraction = decision.spreadBps / 10_000;
  const base = Number(decision.fillBaseAmount);
  const profitNum = base * spreadFraction;
  if (!isFinite(profitNum) || profitNum <= 0) return 0n;
  return BigInt(Math.floor(profitNum));
};

const log = (event: string, data: Record<string, unknown>): void => {
  const line = {
    t: new Date().toISOString(),
    event,
    ...data,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
};
