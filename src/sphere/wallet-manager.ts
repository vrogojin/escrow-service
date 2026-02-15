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

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  const identity = sphere.identity!;
  const escrowAddress = identity.directAddress ?? `DIRECT://${identity.chainPubkey}`;

  logger.info({ escrowAddress }, 'Escrow wallet initialized');
  return createWalletManager(sphere, escrowAddress);
}
