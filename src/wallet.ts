/**
 * Wallet abstraction built on Lucid Evolution.
 *
 * Responsibilities:
 *   - Enumerate the wallet's used addresses (for tx-input lookup).
 *   - Provide a change address.
 *   - Pick a collateral UTxO (Plutus script consumption requires it).
 *   - Sign an unsigned tx CBOR and emit just the witness set (the v1
 *     fill-submit endpoint expects only the witness — the api-server
 *     re-attaches it to the original CBOR before submitting).
 *
 * Lucid Evolution is the modern Cardano TS library. We rely on its built-in
 * Blockfrost provider; integrators using Maestro / Koios / their own node
 * can swap providers in this single file.
 */

import {Lucid, Blockfrost, type LucidEvolution, type UTxO} from '@lucid-evolution/lucid';

export type Network = 'Mainnet' | 'Preview' | 'Preprod';

export type WalletContext = {
  changeAddress: string;
  usedAddresses: string[];
  collateralUtxoRefs: string[];
};

export class Wallet {
  private constructor(private readonly lucid: LucidEvolution) {}

  static async fromSeed(
    seed: string,
    blockfrostApiKey: string,
    network: Network
  ): Promise<Wallet> {
    const blockfrostUrl = (() => {
      switch (network) {
        case 'Mainnet':
          return 'https://cardano-mainnet.blockfrost.io/api/v0';
        case 'Preview':
          return 'https://cardano-preview.blockfrost.io/api/v0';
        case 'Preprod':
          return 'https://cardano-preprod.blockfrost.io/api/v0';
      }
    })();
    const lucid = await Lucid(
      new Blockfrost(blockfrostUrl, blockfrostApiKey),
      network
    );
    lucid.selectWallet.fromSeed(seed);
    return new Wallet(lucid);
  }

  async getContext(): Promise<WalletContext> {
    const changeAddress = await this.lucid.wallet().address();
    // For most use cases the change address IS the only used address.
    // Filler bots can have multiple if they've made transfers; we read
    // them from the UTxO set's payment credentials below.
    const allUtxos = await this.lucid.wallet().getUtxos();
    const usedAddresses = unique(allUtxos.map((u: UTxO) => u.address));

    const collateralUtxoRefs = pickCollateralUtxoRefs(allUtxos);
    if (collateralUtxoRefs.length === 0) {
      throw new Error(
        'Wallet has no usable collateral UTxO. Plutus fills require a pure-ADA UTxO ≥ 5 ADA. ' +
          'Send 5+ ADA to the wallet as a standalone UTxO and retry.'
      );
    }

    return {changeAddress, usedAddresses, collateralUtxoRefs};
  }

  /**
   * Sign the unsigned tx CBOR and return just the witness set as a hex
   * string. The v1 fill-submit endpoint re-attaches this to the original
   * CBOR before submitting on-chain — mirrors the SOR pattern.
   */
  async signWitness(unsignedTxCbor: string): Promise<string> {
    const tx = this.lucid.fromTx(unsignedTxCbor);
    const witness = await tx.partialSign.withWallet();
    // partialSign returns the full witness set hex (CIP-8 / CIP-30 style).
    return witness;
  }

  /**
   * Sum per-asset balances across all wallet UTxOs.
   * Returns a flat `{ assetId: amount }` map with amounts as numeric strings
   * (lovelace for ADA, raw indivisible units for native assets) so the map
   * is safe to JSON.stringify without BigInt loss.
   *
   * Native asset keys are returned in Lucid's `policyId + assetNameHex`
   * concatenation form, matching the api-server's asset identifier.
   * `lovelace` is special-cased.
   */
  async getInventory(): Promise<Record<string, string>> {
    const utxos = await this.lucid.wallet().getUtxos();
    const totals = new Map<string, bigint>();
    for (const u of utxos) {
      for (const [unit, amount] of Object.entries(u.assets)) {
        if (typeof amount !== 'bigint') continue;
        totals.set(unit, (totals.get(unit) ?? 0n) + amount);
      }
    }
    const out: Record<string, string> = {};
    for (const [unit, amt] of totals.entries()) {
      out[unit] = amt.toString();
    }
    return out;
  }
}

const unique = (xs: string[]): string[] => Array.from(new Set(xs));

/**
 * Pick UTxOs that are eligible to serve as collateral:
 *   - Single ADA-only output (no native assets attached).
 *   - At least 5 ADA (Cardano protocol min for collateral on most networks).
 *
 * Returns refs in canonical "txHash#index" form.
 */
const pickCollateralUtxoRefs = (utxos: UTxO[]): string[] =>
  utxos
    .filter(u => {
      const assets = u.assets;
      const keys = Object.keys(assets);
      const adaOnly = keys.length === 1 && keys[0] === 'lovelace';
      const enoughAda = typeof assets.lovelace === 'bigint' && assets.lovelace >= 5_000_000n;
      return adaOnly && enoughAda;
    })
    .map(u => `${u.txHash}#${u.outputIndex}`);
