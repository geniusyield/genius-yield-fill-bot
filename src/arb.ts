/**
 * Arb decision math.
 *
 * Given a GY order book entry and the current AMM mid-price, decide:
 *   - Is filling profitable?
 *   - At what size?
 *
 * The reference logic is deliberately simple: profit only when the absolute
 * GY-vs-AMM price gap exceeds a configured minimum spread (in basis points)
 * AFTER accounting for the per-fill fixed costs. Cap at `maxFillBase`.
 *
 * Production fillers will want fancier strategies (size-tiered profit
 * curves, slippage modeling, MEV protection). This file is the integration
 * EXAMPLE, not the optimal strategy.
 */

import type {OrderBookV1Entry} from './gyClient.js';
import type {AmmMidPrice} from './ammSource.js';

export type ArbDecision =
  | {
      kind: 'skip';
      reason: string;
    }
  | {
      kind: 'fill';
      orderId: string;
      fillBaseAmount: bigint;
      // The decision-time prices for log + audit.
      gyPrice: number;
      ammMidPrice: number;
      spreadBps: number;
    };

const BPS_DENOMINATOR = 10_000;

/**
 * Decide whether to fill an ASK entry (maker sells base, taker buys base).
 *
 * Profit condition: AMM mid > GY ask × (1 + minProfitBps).
 * In words: we can buy base on the AMM cheaper than the maker is selling it,
 * by enough margin to cover all per-fill costs after a buffer.
 */
export const decideAskFill = (
  ask: OrderBookV1Entry,
  ammMid: AmmMidPrice,
  minProfitBps: number,
  maxFillBase: bigint
): ArbDecision => {
  if (ask.externalFillability !== 'ok') {
    return {kind: 'skip', reason: `externalFillability=${ask.externalFillability}`};
  }

  const gyPrice = Number(ask.price);
  const amm = Number(ammMid.midPrice);
  if (!isFinite(gyPrice) || gyPrice <= 0) {
    return {kind: 'skip', reason: 'GY price is zero / unparseable'};
  }
  if (!isFinite(amm) || amm <= 0) {
    return {kind: 'skip', reason: 'AMM mid is zero / unparseable'};
  }

  // We want AMM_mid - GY_ask > GY_ask * (minProfitBps / 10_000) for an ask fill,
  // i.e. AMM_mid >= GY_ask * (1 + minProfitBps/10_000).
  const requiredAmm = gyPrice * (1 + minProfitBps / BPS_DENOMINATOR);
  if (amm < requiredAmm) {
    const spreadBps = ((amm / gyPrice - 1) * BPS_DENOMINATOR).toFixed(1);
    return {
      kind: 'skip',
      reason: `spread ${spreadBps} bps < required ${minProfitBps} bps`,
    };
  }

  const spreadBps = (amm / gyPrice - 1) * BPS_DENOMINATOR;
  const orderRemainingBase = BigInt(ask.remaining.base);
  const minFillBase = BigInt(ask.minFillAmount.base);
  const cappedSize = orderRemainingBase < maxFillBase ? orderRemainingBase : maxFillBase;

  if (cappedSize < minFillBase) {
    return {kind: 'skip', reason: 'cap below minFillAmount'};
  }

  return {
    kind: 'fill',
    orderId: ask.orderId,
    fillBaseAmount: cappedSize,
    gyPrice,
    ammMidPrice: amm,
    spreadBps: Number(spreadBps.toFixed(1)),
  };
};

/**
 * Symmetric for BID entries (maker buys base, taker sells base).
 * Profit when AMM mid < GY bid × (1 - minProfitBps).
 */
export const decideBidFill = (
  bid: OrderBookV1Entry,
  ammMid: AmmMidPrice,
  minProfitBps: number,
  maxFillBase: bigint
): ArbDecision => {
  if (bid.externalFillability !== 'ok') {
    return {kind: 'skip', reason: `externalFillability=${bid.externalFillability}`};
  }

  const gyPrice = Number(bid.price);
  const amm = Number(ammMid.midPrice);
  if (!isFinite(gyPrice) || gyPrice <= 0) {
    return {kind: 'skip', reason: 'GY price is zero / unparseable'};
  }
  if (!isFinite(amm) || amm <= 0) {
    return {kind: 'skip', reason: 'AMM mid is zero / unparseable'};
  }

  const requiredAmm = gyPrice * (1 - minProfitBps / BPS_DENOMINATOR);
  if (amm > requiredAmm) {
    const spreadBps = ((1 - amm / gyPrice) * BPS_DENOMINATOR).toFixed(1);
    return {
      kind: 'skip',
      reason: `spread ${spreadBps} bps < required ${minProfitBps} bps`,
    };
  }

  const spreadBps = (1 - amm / gyPrice) * BPS_DENOMINATOR;
  const orderRemainingBase = BigInt(bid.remaining.base);
  const minFillBase = BigInt(bid.minFillAmount.base);
  const cappedSize = orderRemainingBase < maxFillBase ? orderRemainingBase : maxFillBase;

  if (cappedSize < minFillBase) {
    return {kind: 'skip', reason: 'cap below minFillAmount'};
  }

  return {
    kind: 'fill',
    orderId: bid.orderId,
    fillBaseAmount: cappedSize,
    gyPrice,
    ammMidPrice: amm,
    spreadBps: Number(spreadBps.toFixed(1)),
  };
};
