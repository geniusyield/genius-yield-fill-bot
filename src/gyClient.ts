/**
 * Thin client for the GeniusYield v1 public APIs.
 *
 * Three endpoints:
 *   - GET  /v1/orderbook/:base/:quote       (Phase 1)
 *   - POST /v1/orderbook/fill-quote         (Phase 2)
 *   - POST /v1/orderbook/fill-submit        (Phase 2)
 *
 * Response shapes match the api-server types verbatim — see
 * AUDIT-autonomous-limit-order-crossfill.md §4.1-4.3 and the public contract
 * doc at docs/limit-order-crossfill/v1-api-contract.md.
 */

export type OrderBookV1Pair = {
  baseAssetId: string;
  baseShortName: string;
  quoteAssetId: string;
  quoteShortName: string;
};

export type OrderBookV1Entry = {
  orderId: string;
  price: string;
  remaining: {base: string; quote: string};
  minFillAmount: {base: string; quote: string};
  externalFillability: 'ok' | 'gy-only-v1';
  orderType: string;
  createdAt: string;
  utxoRef: string | null;
};

export type OrderBookV1Response = {
  version: 'v1';
  pair: OrderBookV1Pair;
  asks: OrderBookV1Entry[];
  bids: OrderBookV1Entry[];
  asOfTime: string;
};

export type FillQuoteRequest = {
  orderId: string;
  fillAmount: {base?: string; quote?: string};
  taker: {
    changeAddress: string;
    usedAddresses: string[];
    collateralUtxoRefs: string[];
  };
  minOutput?: string;
  deadlineSlot?: number;
};

export type FillQuoteResponse = {
  version: 'v1';
  unsignedTxCbor: string;
  expectedOutput: {base: string; quote: string};
  quoteId: string;
  expiresAt: string;
  feeBreakdown: {
    networkFeeLovelace: string;
    protocolFeeLovelace: string;
    minUtxoBondLovelace: string;
  };
};

export type FillSubmitRequest = {
  unsignedTxCbor: string;
  walletWitness: string;
  quoteId: string;
  /**
   * Caller-side identity binding. Must equal the `taker.changeAddress`
   * supplied to fillQuote. Server rejects mismatches with
   * `409 QUOTE_TAKER_MISMATCH`. Optional on the wire today for v1.x
   * backwards-compat; required from v2. Always pass it from this client.
   */
  taker?: {
    changeAddress: string;
  };
};

export type FillSubmitResponse = {
  version: 'v1';
  transactionId: string;
};

export class GyApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'GyApiError';
  }
}

export class GyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined
  ) {}

  async getOrderBook(
    baseAssetId: string,
    quoteAssetId: string
  ): Promise<OrderBookV1Response> {
    const url = `${this.baseUrl}/v1/orderbook/${baseAssetId}/${quoteAssetId}`;
    return this.getJson(url);
  }

  async fillQuote(req: FillQuoteRequest): Promise<FillQuoteResponse> {
    return this.postJson(`${this.baseUrl}/v1/orderbook/fill-quote`, req);
  }

  async fillSubmit(req: FillSubmitRequest): Promise<FillSubmitResponse> {
    return this.postJson(`${this.baseUrl}/v1/orderbook/fill-submit`, req);
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey) {
      h['X-API-Key'] = this.apiKey;
    }
    return h;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {method: 'GET', headers: this.headers});
    return this.parse<T>(res);
  }

  private async postJson<TReq, TRes>(url: string, body: TReq): Promise<TRes> {
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.parse<TRes>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (res.ok) {
      return JSON.parse(text) as T;
    }
    let code: string | undefined;
    let message = res.statusText;
    try {
      const parsed = JSON.parse(text);
      code = parsed.error ?? parsed.errorCode;
      message = parsed.message ?? message;
    } catch {
      message = text || message;
    }
    throw new GyApiError(res.status, code, message);
  }
}
