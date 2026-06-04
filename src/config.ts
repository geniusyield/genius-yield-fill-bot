import 'dotenv/config';

/**
 * Strongly-typed config loaded from environment. Throws at startup if anything
 * required is missing — fail loudly rather than discover at first request.
 */
export type AmmSourceKind = 'mock' | 'dexhunter';
export type Config = {
  gyApiUrl: string;
  gyApiKey: string | undefined;
  baseAssetId: string;
  quoteAssetId: string;
  walletSeed: string;
  blockfrostApiKey: string;
  network: 'Mainnet' | 'Preview' | 'Preprod';
  pollIntervalMs: number;
  minProfitBps: number;
  maxFillBase: bigint;
  dryRun: boolean;
  ammSource: AmmSourceKind;
  dexhunterApiKey: string | undefined;
  metricsPort: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;
  tradingWalletId: string | undefined;
  operatorPrivateKeyHex: string | undefined;
  botVersion: string;
};

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

const optional = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
};

export const loadConfig = (): Config => {
  const network = required('NETWORK');
  if (network !== 'Mainnet' && network !== 'Preview' && network !== 'Preprod') {
    throw new Error(`Invalid NETWORK: ${network} (must be Mainnet|Preview|Preprod)`);
  }
  const ammSource = (process.env.AMM_SOURCE ?? 'dexhunter').toLowerCase();
  if (ammSource !== 'mock' && ammSource !== 'dexhunter') {
    throw new Error(`Invalid AMM_SOURCE: ${ammSource} (must be mock|dexhunter)`);
  }
  if (ammSource === 'dexhunter' && !process.env.DEXHUNTER_API_KEY) {
    throw new Error('AMM_SOURCE=dexhunter requires DEXHUNTER_API_KEY');
  }
  // Refuse to run live with the mock source. The mock returns price "0",
  // which makes every order look infinitely profitable and the bot would
  // fill the book until the wallet is empty. Mock is only safe in
  // dry-run mode where no submission happens.
  if (ammSource === 'mock' && process.env.DRY_RUN !== 'true') {
    throw new Error(
      'AMM_SOURCE=mock is only allowed with DRY_RUN=true. ' +
        'Set AMM_SOURCE=dexhunter (with DEXHUNTER_API_KEY) for live trading.'
    );
  }

  const heartbeatEnabled = process.env.HEARTBEAT_ENABLED !== 'false';
  if (heartbeatEnabled) {
    const id = optional('TRADING_WALLET_ID');
    const key = optional('OPERATOR_PRIVATE_KEY_HEX');
    if (!id || !key) {
      throw new Error(
        'HEARTBEAT_ENABLED=true (default) requires TRADING_WALLET_ID and OPERATOR_PRIVATE_KEY_HEX. ' +
          'Generate a key with: node -e "import(\\"./dist/keygen.js\\").then(m => m.printNew())". ' +
          'Set HEARTBEAT_ENABLED=false to disable heartbeat reporting.'
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('OPERATOR_PRIVATE_KEY_HEX must be a 32-byte (64 hex chars) Ed25519 seed');
    }
  }

  return {
    gyApiUrl: required('GY_API_URL').replace(/\/$/, ''),
    gyApiKey: optional('GY_API_KEY'),
    baseAssetId: required('BASE_ASSET_ID'),
    quoteAssetId: required('QUOTE_ASSET_ID'),
    walletSeed: required('WALLET_SEED'),
    blockfrostApiKey: required('BLOCKFROST_API_KEY'),
    network,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? '8000'),
    minProfitBps: Number(process.env.MIN_PROFIT_BPS ?? '50'),
    maxFillBase: BigInt(process.env.MAX_FILL_BASE ?? '200000000'),
    dryRun: process.env.DRY_RUN === 'true',
    ammSource: ammSource as AmmSourceKind,
    dexhunterApiKey: optional('DEXHUNTER_API_KEY'),
    metricsPort: Number(process.env.METRICS_PORT ?? '9100'),
    heartbeatEnabled,
    heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? '60000'),
    tradingWalletId: optional('TRADING_WALLET_ID'),
    operatorPrivateKeyHex: optional('OPERATOR_PRIVATE_KEY_HEX'),
    botVersion: process.env.BOT_VERSION ?? '0.1.0',
  };
};
