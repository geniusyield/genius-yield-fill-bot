/**
 * Ed25519 keypair helper.
 *
 * Bot operators need a stable Ed25519 keypair to sign heartbeat payloads
 * sent to GeniusYield's `POST /v1/bot/heartbeat`. The PRIVATE key (32-byte
 * seed) stays in the operator's secret store; the PUBLIC key is registered
 * on the TradingWallet record so the api-server can verify each heartbeat.
 *
 * Usage:
 *   - First-time setup: `node dist/keygen.js`  prints a fresh keypair.
 *   - Programmatic load: see loadOperatorKey().
 *
 * Both halves are emitted as raw 32-byte hex — the GeniusYield API expects
 * the public half in that exact form.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'crypto';

const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex'
);

export interface OperatorKey {
  privateKey: KeyObject;
  publicKeyHex: string;
}

export function loadOperatorKey(privateKeyHex: string): OperatorKey {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('OPERATOR_PRIVATE_KEY_HEX must be 64 hex chars (32 bytes)');
  }
  const seed = Buffer.from(privateKeyHex, 'hex');
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = createPrivateKey({
    key: pkcs8,
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyObj = createPublicKey(privateKey);
  const spki = publicKeyObj.export({format: 'der', type: 'spki'});
  const publicKey = Buffer.from(spki).slice(-32);
  return {privateKey, publicKeyHex: publicKey.toString('hex')};
}

export function printNew(): void {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const seed = Buffer.from(
    privateKey.export({format: 'der', type: 'pkcs8'})
  ).slice(-32);
  const pub = Buffer.from(
    publicKey.export({format: 'der', type: 'spki'})
  ).slice(-32);
  // eslint-disable-next-line no-console
  console.log(
    [
      '# Fresh operator keypair — keep PRIVATE secret, register PUBLIC with GY.',
      `OPERATOR_PRIVATE_KEY_HEX=${seed.toString('hex')}`,
      `OPERATOR_PUBLIC_KEY_HEX=${pub.toString('hex')}`,
    ].join('\n')
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printNew();
}
