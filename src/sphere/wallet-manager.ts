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

  // --- Init or load (NEVER auto-generate for existing wallets) ---
  // CRITICAL: We must distinguish "first-time setup" from "loading existing
  // wallet". Using autoGenerate:true on an existing-but-corrupt wallet silently
  // creates a NEW identity (new mnemonic, new address), which is catastrophic:
  // all funds, nametags, and swap state become orphaned.
  //
  // Strategy:
  //   - Check if wallet exists BEFORE calling Sphere.init()
  //   - If it exists → Sphere.load() (fails hard on corruption, never generates)
  //   - If it doesn't → Sphere.init({ autoGenerate: true }) for first-time setup
  const walletExists = await Sphere.exists(providers.storage);

  let sphere: Awaited<ReturnType<typeof Sphere.load>>;
  let created = false;
  let generatedMnemonic: string | undefined;

  if (walletExists) {
    // Load existing wallet. If wallet.json is corrupt, Sphere.load() throws.
    // This is the correct behavior — a corrupt wallet must NOT be silently replaced.
    logger.info({ walletPath }, 'Loading existing escrow wallet...');
    sphere = await Sphere.load({
      storage: providers.storage,
      transport: providers.transport,
      oracle: providers.oracle,
      tokenStorage: providers.tokenStorage,
      accounting: true,
    });
  } else {
    // No wallet in storage. Check for artifacts indicating a prior wallet existed
    // (prevents silent identity replacement after storage corruption).
    const backupPath = path.join(walletPath, 'mnemonic.backup');
    const identityPath = path.join(walletPath, '.escrow-identity');
    const savedMnemonic = fs.existsSync(backupPath)
      ? fs.readFileSync(backupPath, 'utf-8').trim()
      : null;
    const savedIdentity = fs.existsSync(identityPath)
      ? fs.readFileSync(identityPath, 'utf-8').trim()
      : null;

    if (savedMnemonic) {
      // Validate mnemonic format (12 or 24 BIP39 words)
      const wordCount = savedMnemonic.split(/\s+/).length;
      if (wordCount !== 12 && wordCount !== 24) {
        throw new Error(
          `Mnemonic backup at "${backupPath}" is corrupt (${wordCount} words, expected 12 or 24). ` +
          `Manual recovery required.`,
        );
      }

      // Restore from backup — do NOT pass nametag here. The SDK will recover
      // the nametag from the Nostr relay identity binding (published during
      // the original registration). Passing nametag would cause Sphere.create()
      // to re-register, which fails because the relay already has the binding.
      logger.info({ walletPath }, 'Wallet missing but mnemonic backup found — restoring...');
      const result = await Sphere.init({
        ...providers,
        mnemonic: savedMnemonic,
        accounting: true,
      });
      sphere = result.sphere;
      created = result.created;

      // Verify restored identity matches the expected address (if persisted)
      if (savedIdentity && sphere.identity?.directAddress !== savedIdentity) {
        const actual = sphere.identity?.directAddress ?? 'null';
        await sphere.destroy();
        throw new Error(
          `Identity mismatch after mnemonic restoration: expected address ${savedIdentity} ` +
          `but got ${actual}. The mnemonic backup may belong to a different wallet.`,
        );
      }

      logger.info(
        { walletPath, nametag: sphere.getNametag() ?? null, address: sphere.identity?.directAddress },
        'Wallet restored from mnemonic backup',
      );
    } else if (savedIdentity) {
      // Identity file exists but no mnemonic backup and no wallet.json — the wallet
      // was set up before but is now unrecoverable. Hard fail.
      throw new Error(
        `Wallet at "${walletPath}" was previously initialized (identity: ${savedIdentity}) ` +
        `but wallet.json and mnemonic.backup are both missing. Manual recovery required.`,
      );
    } else {
      // True first-time setup — no artifacts from prior wallet.
      logger.info({ walletPath }, 'No existing wallet — creating new escrow wallet...');
      const result = await Sphere.init({
        ...providers,
        autoGenerate: true,
        accounting: true,
        ...(nametag ? { nametag } : {}),
      });
      sphere = result.sphere;
      created = result.created;
      generatedMnemonic = result.generatedMnemonic;
    }
  }

  // --- Validate identity ---
  const identity = sphere.identity;
  if (!identity?.directAddress) {
    await sphere.destroy();
    throw new Error('Sphere wallet has no directAddress — initialization failed');
  }

  // --- On first create: persist mnemonic backup + identity file ---
  if (created && generatedMnemonic) {
    fs.mkdirSync(walletPath, { recursive: true, mode: 0o700 });

    // Atomic mnemonic backup write (temp + fsync + rename)
    const backupPath = path.join(walletPath, 'mnemonic.backup');
    const backupTmp = backupPath + '.tmp';
    try {
      const fd = fs.openSync(backupTmp, 'w', 0o600);
      try {
        fs.writeSync(fd, generatedMnemonic + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(backupTmp, backupPath);
      logger.info({ path: backupPath }, 'Mnemonic backup saved (atomic)');
    } catch (err) {
      logger.warn({ err }, 'Failed to save mnemonic backup');
    }

    // Persist the expected DIRECT address as an identity sentinel.
    // Used during mnemonic restoration to verify the restored identity
    // matches the original (prevents wrong-mnemonic restoration).
    const identityPath = path.join(walletPath, '.escrow-identity');
    try {
      fs.writeFileSync(identityPath, identity.directAddress, { mode: 0o600 });
    } catch (err) {
      logger.warn({ err }, 'Failed to save identity sentinel');
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

  // --- Verify nametag ---
  if (nametag && !sphere.hasNametag()) {
    // Nametag token not found. With atomic writes in the SDK's FileStorageProvider,
    // this should only happen if: (1) the nametag was never registered, or
    // (2) the token storage was manually deleted.
    await sphere.destroy();
    throw new Error(
      `FATAL: Nametag token for @${nametag} is not found in wallet at "${walletPath}". ` +
      `The escrow cannot operate without its nametag token. ` +
      `Recovery: re-initialize with "npm run setup" or restore the wallet from backup.`,
    );
  }

  if (nametag && sphere.hasNametag() && sphere.getNametag() !== nametag) {
    const actual = sphere.getNametag();
    await sphere.destroy();
    throw new Error(
      `Nametag mismatch: wallet has @${actual} but SPHERE_NAMETAG=${nametag}. ` +
      `Update SPHERE_NAMETAG in .env to match, or re-initialize the wallet.`,
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
