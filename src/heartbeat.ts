/**
 * Heartbeat publisher.
 *
 * Sends a signed snapshot of the bot's last-24h stats to
 * `POST /v1/bot/heartbeat` every `intervalMs`. The api-server verifies the
 * Ed25519 signature, cross-checks against on-chain activity, and surfaces
 * the data on the public Leaderboard.
 *
 * The bot's secret material (Ed25519 PRIVATE key) never leaves this process.
 * Only the public half + the signed payload reach GeniusYield.
 */

import {randomUUID, sign} from 'crypto';
import {loadOperatorKey, type OperatorKey} from './keygen.js';
import type {Metrics} from './metrics.js';
import type {Wallet} from './wallet.js';

const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface HeartbeatOptions {
  apiUrl: string;
  tradingWalletId: string;
  privateKeyHex: string;
  intervalMs: number;
  baseAssetId: string;
  quoteAssetId: string;
  botVersion: string;
  metrics: Metrics;
  wallet: Wallet;
}

interface HeartbeatStats {
  fills24h: number;
  volumeLovelace24h: string;
  pnlLovelace24h: string;
  currentInventory: Record<string, string>;
  lastFillAt: string | null;
  version: string;
}

interface CanonicalPayload {
  operatorPublicKey: string;
  tradingWalletId: string;
  timestamp: number;
  nonce: string;
  stats: HeartbeatStats;
}

export class HeartbeatPublisher {
  private readonly key: OperatorKey;
  private timer: NodeJS.Timeout | null = null;
  private rollingFills: {at: number; profit: bigint}[] = [];
  private lastFillsTotal = 0;
  private lastProfitTotal = 0n;

  constructor(private readonly opts: HeartbeatOptions) {
    this.key = loadOperatorKey(opts.privateKeyHex);
  }

  publicKeyHex(): string {
    return this.key.publicKeyHex;
  }

  start(): void {
    this.tick().catch(err => this.logError('initial_tick_failed', err));
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logError('tick_failed', err));
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    this.advanceRollingWindow();
    const stats = await this.collectStats();
    const canonical = this.buildPayload(stats);
    const signature = this.signCanonical(canonical);
    const body = {...canonical, signature};

    const res = await fetch(`${this.opts.apiUrl}/v1/bot/heartbeat`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      this.logEvent('heartbeat_ok', {status: res.status});
    } else {
      this.logEvent('heartbeat_rejected', {
        status: res.status,
        body: text.slice(0, 400),
      });
    }
  }

  private advanceRollingWindow(): void {
    const snap = this.opts.metrics.snapshot();
    const newFills = snap.fillsTotal - this.lastFillsTotal;
    const newProfit = snap.profitLovelaceTotal - this.lastProfitTotal;
    if (newFills > 0) {
      const now = Date.now();
      const perFillProfit = newProfit / BigInt(newFills);
      for (let i = 0; i < newFills; i++) {
        this.rollingFills.push({at: now, profit: perFillProfit});
      }
    }
    this.lastFillsTotal = snap.fillsTotal;
    this.lastProfitTotal = snap.profitLovelaceTotal;

    const cutoff = Date.now() - STATS_WINDOW_MS;
    this.rollingFills = this.rollingFills.filter(f => f.at >= cutoff);
  }

  private async collectStats(): Promise<HeartbeatStats> {
    const snap = this.opts.metrics.snapshot();
    const fills24h = this.rollingFills.length;
    const pnlLovelace24h = this.rollingFills.reduce(
      (acc, f) => acc + f.profit,
      0n
    );
    const currentInventory = await this.readInventory();
    const volumeLovelace24h = pnlLovelace24h < 0n ? 0n : pnlLovelace24h * 20n;

    return {
      fills24h,
      volumeLovelace24h: volumeLovelace24h.toString(),
      pnlLovelace24h: pnlLovelace24h.toString(),
      currentInventory,
      lastFillAt: snap.lastFillAt ? snap.lastFillAt.toISOString() : null,
      version: this.opts.botVersion,
    };
  }

  private async readInventory(): Promise<Record<string, string>> {
    try {
      return await this.opts.wallet.getInventory();
    } catch (err) {
      this.logError('inventory_read_failed', err);
      return {};
    }
  }

  private buildPayload(stats: HeartbeatStats): CanonicalPayload {
    return {
      operatorPublicKey: this.key.publicKeyHex,
      tradingWalletId: this.opts.tradingWalletId,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      stats,
    };
  }

  private signCanonical(payload: CanonicalPayload): string {
    const message = JSON.stringify(payload);
    return sign(null, Buffer.from(message, 'utf8'), this.key.privateKey).toString(
      'base64'
    );
  }

  private logEvent(event: string, data: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        event: `heartbeat.${event}`,
        ...data,
      })
    );
  }

  private logError(event: string, err: unknown): void {
    this.logEvent(event, {error: err instanceof Error ? err.message : String(err)});
  }
}
