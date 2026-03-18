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
 * Initialize a real Sphere instance from Node.js providers.
 * Call this at startup with the proper config.
 */
export async function initializeWallet(config: Config): Promise<WalletManager> {
  // Dynamic imports to avoid issues in test environments
  const { Sphere } = await import('@unicitylabs/sphere-sdk');
  const { createNodeProviders } = await import('@unicitylabs/sphere-sdk/impl/nodejs');

  const providers = createNodeProviders({
    network: config.sphereNetwork as 'mainnet' | 'testnet' | 'dev',
    dataDir: config.sphereWalletPath,
    tokensDir: `${config.sphereWalletPath}/tokens`,
  });

  const { sphere, created } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    accounting: true,
  });

  // Production startup should never silently create a new wallet — that means
  // the existing wallet was lost and all in-flight swaps are unrecoverable.
  if (created) {
    await sphere.destroy();
    throw new Error(
      'Wallet was unexpectedly created at runtime. This indicates the wallet ' +
      'directory was deleted or corrupted. Run "npm run init-wallet" to set up ' +
      'a new wallet, then recover funds from the old wallet manually.',
    );
  }

  const identity = sphere.identity;
  if (!identity) {
    await sphere.destroy();
    throw new Error('Sphere initialized but identity is null — wallet may be corrupt');
  }
  const escrowAddress = identity.directAddress ?? `DIRECT://${identity.chainPubkey}`;

  // Verify nametag is recovered from transport (SDK calls recoverNametagFromTransport
  // during init). Warn if it doesn't match config so the operator can investigate.
  if (config.sphereNametag) {
    if (!sphere.hasNametag()) {
      logger.warn(
        { expected: config.sphereNametag },
        'SPHERE_NAMETAG is configured but wallet has no registered nametag. Run "npm run init-wallet" to register.',
      );
    } else if (sphere.getNametag() !== config.sphereNametag.replace(/^@/, '').toLowerCase()) {
      logger.warn(
        { expected: config.sphereNametag, actual: sphere.getNametag() },
        'SPHERE_NAMETAG does not match registered nametag',
      );
    }
  }

  logger.info({ escrowAddress, nametag: sphere.getNametag() ?? null }, 'Escrow wallet initialized');
  return createWalletManager(sphere, escrowAddress);
}
