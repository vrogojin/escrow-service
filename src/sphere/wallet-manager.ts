import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sphere } from '@unicitylabs/sphere-sdk';
import type { Config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Manages the Sphere wallet instance for the escrow service.
 * In production this wraps a real Sphere SDK instance.
 * For testing, a mock can be injected.
 */
export interface WalletManager {
  getSphere(): Sphere;
  getEscrowAddress(): string;
  destroy(): Promise<void>;
}

/**
 * Create a WalletManager that wraps an already-initialized Sphere instance.
 */
export function createWalletManager(sphere: Sphere, escrowAddress: string): WalletManager {
  return {
    getSphere() {
      return sphere;
    },
    getEscrowAddress() {
      return escrowAddress;
    },
    async destroy() {
      logger.info('Destroying Sphere wallet');
      await sphere.destroy();
    },
  };
}

/**
 * Initialize the escrow's Sphere wallet. Handles ALL identity lifecycle:
 *
 * 1. If no wallet exists → create one, register nametag, persist mnemonic backup
 * 2. If wallet exists → load it
 * 3. If SPHERE_NAMETAG is set but nametag not registered → register it
 * 4. Verify identity is consistent (DIRECT address, nametag, relay binding)
 *
 * No separate `init-wallet` script needed. The escrow service is the single
 * owner of its wallet identity.
 */
export async function initializeWallet(config: Config): Promise<WalletManager> {
  const { Sphere } = await import('@unicitylabs/sphere-sdk');
  const { createNodeProviders } = await import('@unicitylabs/sphere-sdk/impl/nodejs');

  const walletPath = path.resolve(config.sphereWalletPath);
  const tokensPath = path.join(walletPath, 'tokens');
  const nametag = config.sphereNametag?.replace(/^@/, '').toLowerCase() || undefined;

  const providers = createNodeProviders({
    network: config.sphereNetwork as 'mainnet' | 'testnet' | 'dev',
    dataDir: walletPath,
    tokensDir: tokensPath,
  });

  // --- Init or load ---
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    accounting: true,
    l1: undefined, // Escrow doesn't need ALPHA blockchain
    ...(nametag ? { nametag } : {}), // Register nametag on first create
  });

  // --- Validate identity ---
  const identity = sphere.identity;
  if (!identity?.directAddress) {
    await sphere.destroy();
    throw new Error('Sphere wallet has no directAddress — initialization failed');
  }

  // --- On first create: persist mnemonic backup ---
  if (created && generatedMnemonic) {
    const backupPath = path.join(walletPath, 'mnemonic.backup');
    try {
      fs.mkdirSync(walletPath, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(backupPath, 'w', 0o600);
      fs.writeSync(fd, generatedMnemonic + '\n');
      fs.closeSync(fd);
      logger.info({ path: backupPath }, 'Mnemonic backup saved');
    } catch (err) {
      logger.warn({ err }, 'Failed to save mnemonic backup — wallet will still work but mnemonic may not be recoverable from disk');
    }

    logger.info(
      {
        directAddress: identity.directAddress,
        nametag: sphere.getNametag() ?? null,
        chainPubkey: identity.chainPubkey,
      },
      'NEW escrow wallet created',
    );
  }

  // --- Ensure nametag is registered (handles restart after partial init) ---
  if (nametag && !sphere.hasNametag()) {
    logger.info({ nametag }, 'Registering nametag (not found in wallet)...');
    try {
      await sphere.registerNametag(nametag);
      logger.info({ nametag }, 'Nametag registered successfully');
    } catch (err) {
      // Nametag may already be claimed by another wallet — fatal
      await sphere.destroy();
      throw new Error(
        `Failed to register nametag @${nametag}: ${err instanceof Error ? err.message : String(err)}. ` +
        `If the nametag is already taken, choose a different one in .env (SPHERE_NAMETAG).`,
      );
    }
  }

  // --- Verify nametag matches config ---
  if (nametag && sphere.hasNametag() && sphere.getNametag() !== nametag) {
    const actual = sphere.getNametag();
    await sphere.destroy();
    throw new Error(
      `Nametag mismatch: wallet has @${actual} but SPHERE_NAMETAG=${nametag}. ` +
      `Either update .env to match, or delete the wallet directory to start fresh.`,
    );
  }

  const escrowAddress = identity.directAddress;

  logger.info(
    {
      escrowAddress,
      nametag: sphere.getNametag() ?? null,
      chainPubkey: identity.chainPubkey,
      created,
    },
    'Escrow wallet initialized',
  );

  return createWalletManager(sphere, escrowAddress);
}
