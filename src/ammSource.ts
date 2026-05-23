/**
 * Pluggable AMM price source.
 *
 * The reference implementation here is a MOCK that returns a fixed price.
 * Production integrators MUST replace it with a real source — Minswap V2
 * SDK, SundaeSwap SDK, WingRiders REST API, or the DexHunter
 * /swap/estimate endpoint (which aggregates across all of them).
 *
 * Why pluggable? Different fillers will arb against different venues;
 * baking in a single AMM choice would force everyone onto the same
 * counter-side and create wasteful competition. The CONTRACT is "given a
 * pair, give me the current mid-price"; the implementation is yours.
 *
 * The bot consumes the price as a display-unit decimal string in
 * `quote per base` direction (matching the v1 order book's `price` field).
 */
export type AmmMidPrice = {
  pair: {baseAssetId: string; quoteAssetId: string};
  midPrice: string; // decimal string, quote per base
  source: string; // "minswap-v2" | "sundaeswap-v3" | "dexhunter" | "mock"
  timestamp: string; // ISO-8601 UTC when this quote was sampled
};

export interface AmmSource {
  /**
   * Fetch the current mid-price for the given pair. Throws on failure.
   * Implementations should cache for ~5-10s if their backend is rate-limited.
   */
  getMidPrice(
    baseAssetId: string,
    quoteAssetId: string
  ): Promise<AmmMidPrice>;
}

/**
 * MOCK implementation. Replace before production use.
 *
 * Two ways to replace:
 *   1. Inline: import a real SDK in this file and emit a real price.
 *   2. Separate file: implement `AmmSource` in `src/myMinswapSource.ts`
 *      and wire it in `index.ts`.
 */
export class MockAmmSource implements AmmSource {
  constructor(private readonly fixedPrice: string) {}

  async getMidPrice(
    baseAssetId: string,
    quoteAssetId: string
  ): Promise<AmmMidPrice> {
    return {
      pair: {baseAssetId, quoteAssetId},
      midPrice: this.fixedPrice,
      source: 'mock',
      timestamp: new Date().toISOString(),
    };
  }
}
