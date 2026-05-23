/**
 * GeniusYield Fill Bot — entry point.
 *
 * Run with: `yarn build && yarn start`
 * Dry-run:  `yarn build && yarn smoke`   (or set DRY_RUN=true in .env)
 *
 * AMM source is selectable via the `AMM_SOURCE` env var:
 *   AMM_SOURCE=mock        Reference mock (no real prices) — first-run only
 *   AMM_SOURCE=dexhunter   Real DexHunter aggregator (requires DEXHUNTER_API_KEY)
 *
 * Phase 4 (seed MMB) deployments must set `AMM_SOURCE=dexhunter`.
 */

import {loadConfig} from './config.js';
import {GyClient} from './gyClient.js';
import {Wallet} from './wallet.js';
import {MockAmmSource, type AmmSource} from './ammSource.js';
import {DexHunterAmmSource} from './dexhunterSource.js';
import {Metrics} from './metrics.js';
import {runLoop} from './loop.js';
import {HeartbeatPublisher} from './heartbeat.js';

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  const gy = new GyClient(cfg.gyApiUrl, cfg.gyApiKey);

  let amm: AmmSource;
  switch (cfg.ammSource) {
    case 'dexhunter':
      if (!cfg.dexhunterApiKey) {
        throw new Error('AMM_SOURCE=dexhunter requires DEXHUNTER_API_KEY');
      }
      amm = new DexHunterAmmSource(cfg.dexhunterApiKey);
      break;
    case 'mock':
    default:
      amm = new MockAmmSource('0');
      break;
  }

  const wallet = await Wallet.fromSeed(
    cfg.walletSeed,
    cfg.blockfrostApiKey,
    cfg.network
  );

  // Prometheus metrics on a separate port. Lets ops graph fills/hour,
  // PnL/hour, 409 rate without touching the bot's stdout logs.
  // Also exposes /healthz so Railway/Fly/DO health checks pass.
  const metrics = new Metrics(`${cfg.baseAssetId}/${cfg.quoteAssetId}`);
  metrics.start(cfg.metricsPort);

  // Heartbeat publisher reports the bot's 24h stats (fills, PnL, inventory)
  // to GeniusYield's leaderboard every minute. Signed with the operator's
  // Ed25519 key — the api-server verifies the signature and cross-checks
  // against on-chain activity before promoting numbers to the leaderboard.
  let heartbeat: HeartbeatPublisher | null = null;
  if (
    cfg.heartbeatEnabled &&
    cfg.tradingWalletId &&
    cfg.operatorPrivateKeyHex
  ) {
    heartbeat = new HeartbeatPublisher({
      apiUrl: cfg.gyApiUrl,
      tradingWalletId: cfg.tradingWalletId,
      privateKeyHex: cfg.operatorPrivateKeyHex,
      intervalMs: cfg.heartbeatIntervalMs,
      baseAssetId: cfg.baseAssetId,
      quoteAssetId: cfg.quoteAssetId,
      botVersion: cfg.botVersion,
      metrics,
      wallet,
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        event: 'heartbeat_starting',
        operatorPublicKey: heartbeat.publicKeyHex(),
        tradingWalletId: cfg.tradingWalletId,
        intervalMs: cfg.heartbeatIntervalMs,
      })
    );
    heartbeat.start();
  }

  // Graceful shutdown — Railway, Fly, and Kubernetes send SIGTERM on stop
  // and give us ~30s before SIGKILL. Stop the metrics HTTP server so the
  // port is released cleanly. The arb loop polls every few seconds; it'll
  // exit naturally on the next iteration after the process is killed.
  // Wallet.fromSeed holds no long-lived resources to clean up.
  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        event: 'shutdown',
        signal,
      })
    );
    heartbeat?.stop();
    metrics.stop();
    // Give in-flight HTTP responses ~2s to finish before exiting.
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runLoop(cfg, gy, amm, wallet, metrics);
};

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      t: new Date().toISOString(),
      event: 'fatal',
      error: String(err),
    })
  );
  process.exit(1);
});
