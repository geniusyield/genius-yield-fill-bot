/**
 * AmmSource backed by DexHunter's /swap/estimate endpoint.
 *
 * DexHunter aggregates Minswap V2, SundaeSwap V3, WingRiders V2, MuesliSwap,
 * VyFinance, Splash, CSwap, etc. behind a single REST API. Their estimate
 * returns the best AMM price for a notional trade size; we use that as our
 * AMM mid.
 *
 * Caveat: the "mid" returned is size-dependent (price impact). The bot
 * passes a small notional (1 ADA) to approximate the touch price. Real arb
 * bots model slippage per trade size — Phase 5+ territory.
 *
 * To use, set in .env:
 *   AMM_SOURCE=dexhunter
 *   DEXHUNTER_API_KEY=<your partner key>
 *
 * DexHunter partner keys are issued via their developer portal; treat them
 * as secrets (rate-limit / billing implications).
 */

import type {AmmSource, AmmMidPrice} from './ammSource.js';

const DEXHUNTER_ESTIMATE_URL = 'https://api-us.dexhunterv3.app/swap/estimate';
const DEFAULT_PROBE_AMOUNT_ADA = 1;
const ADA_FINGERPRINT_HEX = ''; // DexHunter uses empty string for ADA

const fingerprintToHex = (fingerprint: string): string => {
  // DexHunter expects policyId+assetName (hex concat), NOT the bech32 fingerprint.
  // ADA is the empty string.
  // For other tokens, callers must supply hex form. This source therefore
  // works seamlessly only for ADA-quoted pairs; cross-pair (token/token)
  // arb requires an explicit policy+name mapping.
  if (
    !fingerprint ||
    fingerprint === 'lovelace' ||
    fingerprint === 'asset1xdz4yj4ldwlpsz2yjgjtt9evg9uskm8jrzjwhj' // bech32 of ADA empty assetId
  ) {
    return ADA_FINGERPRINT_HEX;
  }
  // Token resolution: real production fillers maintain a fingerprint→hex
  // table or query the GY asset API. This reference falls back to a
  // descriptive error so misconfiguration is caught at startup, not in
  // the middle of trading.
  throw new Error(
    `DexHunter source needs policyId+assetName hex for ${fingerprint}. ` +
      `Either set up a fingerprint→hex lookup in dexhunterSource.ts, ` +
      `or use ADA as one side of the pair.`
  );
};

type DexHunterEstimateResponse = {
  total_input: number;
  total_output: number;
  net_price?: number;
  total_fee?: number;
  splits?: {dex: string; amount_in: number; expected_output: number}[];
};

export class DexHunterAmmSource implements AmmSource {
  private cache: {key: string; value: AmmMidPrice; expiresAt: number} | null = null;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly apiKey: string,
    cacheTtlMs = 5_000
  ) {
    this.cacheTtlMs = cacheTtlMs;
  }

  async getMidPrice(
    baseAssetId: string,
    quoteAssetId: string
  ): Promise<AmmMidPrice> {
    const cacheKey = `${baseAssetId}|${quoteAssetId}`;
    if (this.cache && this.cache.key === cacheKey && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }

    const tokenIn = fingerprintToHex(baseAssetId);
    const tokenOut = fingerprintToHex(quoteAssetId);

    const res = await fetch(DEXHUNTER_ESTIMATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Id': this.apiKey,
      },
      body: JSON.stringify({
        token_in: tokenIn,
        token_out: tokenOut,
        amount_in: DEFAULT_PROBE_AMOUNT_ADA,
        slippage: 1,
      }),
    });

    if (!res.ok) {
      throw new Error(
        `DexHunter /swap/estimate returned ${res.status}: ${await res.text()}`
      );
    }

    const data = (await res.json()) as DexHunterEstimateResponse;
    if (typeof data.total_output !== 'number' || data.total_output <= 0) {
      throw new Error(`DexHunter returned non-positive total_output: ${JSON.stringify(data)}`);
    }
    if (typeof data.total_input !== 'number' || data.total_input <= 0) {
      throw new Error(`DexHunter returned non-positive total_input: ${JSON.stringify(data)}`);
    }

    // mid = quote per base = output / input (DexHunter expresses both in
    // display units, so the ratio is already in display-unit terms).
    const mid = (data.total_output / data.total_input).toString();
    const value: AmmMidPrice = {
      pair: {baseAssetId, quoteAssetId},
      midPrice: mid,
      source: 'dexhunter',
      timestamp: new Date().toISOString(),
    };

    this.cache = {key: cacheKey, value, expiresAt: Date.now() + this.cacheTtlMs};
    return value;
  }
}
