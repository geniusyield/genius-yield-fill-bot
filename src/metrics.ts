/**
 * Tiny Prometheus exporter — no external deps, plain HTTP server.
 *
 * Exposes 4 metrics that are enough to graph the bot's behavior in Grafana
 * without setting up the full prom-client SDK:
 *
 *   fills_total            Counter — successful /fill-submit responses
 *   quote_attempts_total   Counter — /fill-quote requests sent (success + 409)
 *   quote_409_total        Counter — 409 responses from quote OR submit
 *   profit_lovelace_total  Counter — cumulative captured arb spread (lovelace)
 *
 * Each counter has a `pair="base/quote"` label so multi-pair bots aggregate
 * cleanly.
 *
 * Endpoint: GET /metrics on METRICS_PORT (default 9100).
 */

import {createServer, type Server} from 'node:http';

type Counters = {
  fillsTotal: number;
  quoteAttemptsTotal: number;
  quote409Total: number;
  profitLovelaceTotal: bigint;
};

export class Metrics {
  private readonly counters: Counters = {
    fillsTotal: 0,
    quoteAttemptsTotal: 0,
    quote409Total: 0,
    profitLovelaceTotal: 0n,
  };
  private server: Server | null = null;

  constructor(private readonly pair: string) {}

  start(port: number): void {
    this.server = createServer((req, res) => {
      if (req.url === '/metrics' && req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        res.end(this.format());
        return;
      }
      if (req.url === '/healthz' && req.method === 'GET') {
        res.statusCode = 200;
        res.end('ok');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    this.server.listen(port);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  recordFill(profitLovelace: bigint): void {
    this.counters.fillsTotal += 1;
    this.counters.profitLovelaceTotal += profitLovelace;
    this.lastFillAt = new Date();
  }

  recordQuoteAttempt(): void {
    this.counters.quoteAttemptsTotal += 1;
  }

  record409(): void {
    this.counters.quote409Total += 1;
  }

  /**
   * Snapshot the in-memory counters. Used by the heartbeat publisher to
   * report progress to the api-server every minute.
   */
  snapshot(): {
    fillsTotal: number;
    quoteAttemptsTotal: number;
    quote409Total: number;
    profitLovelaceTotal: bigint;
    lastFillAt: Date | null;
  } {
    return {...this.counters, lastFillAt: this.lastFillAt};
  }

  private lastFillAt: Date | null = null;

  private format(): string {
    const labels = `{pair="${this.pair}"}`;
    return [
      '# HELP fills_total Number of successful /v1/orderbook/fill-submit responses',
      '# TYPE fills_total counter',
      `fills_total${labels} ${this.counters.fillsTotal}`,
      '# HELP quote_attempts_total Number of /v1/orderbook/fill-quote requests sent',
      '# TYPE quote_attempts_total counter',
      `quote_attempts_total${labels} ${this.counters.quoteAttemptsTotal}`,
      '# HELP quote_409_total Number of 409 responses (UTXO consumed / quote stale)',
      '# TYPE quote_409_total counter',
      `quote_409_total${labels} ${this.counters.quote409Total}`,
      '# HELP profit_lovelace_total Cumulative captured arb spread in lovelace',
      '# TYPE profit_lovelace_total counter',
      `profit_lovelace_total${labels} ${this.counters.profitLovelaceTotal.toString()}`,
      '',
    ].join('\n');
  }
}
