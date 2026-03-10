import { loadConfig } from './config.js';
import { initializeWallet } from './sphere/wallet-manager.js';
import { createMessageHandler } from './sphere/message-handler.js';
import { SwapOrchestrator } from './core/swap-orchestrator.js';
import { InvoiceManager } from './core/invoice-manager.js';
import { InMemorySwapStateStore } from './core/swap-state-store.js';
import { TimeoutManager } from './core/timeout-manager.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ nodeEnv: config.nodeEnv }, 'Starting escrow service');

  // 1. Initialize Sphere wallet
  const walletManager = await initializeWallet(config);
  const sphere = walletManager.getSphere();
  const escrowAddress = walletManager.getEscrowAddress();
  logger.info({ escrowAddress }, 'Sphere wallet ready');

  // 2. Create invoice-based infrastructure
  // Access the AccountingModule via the Sphere instance.
  // The type assertion is needed because the SDK's main export type
  // doesn't expose the accounting property in all configurations.
  const accounting = (sphere as any).accounting;
  if (!accounting) {
    throw new Error('AccountingModule not available — ensure Sphere is initialized with accounting enabled');
  }
  const invoiceManager = new InvoiceManager({ accounting, escrowAddress });
  const stateStore = new InMemorySwapStateStore();

  // 3. Create orchestrator with timeout manager
  // Use a late-bound callback to break the circular dependency between
  // timeoutManager and orchestrator (same pattern as tests).
  let orchestratorRef: SwapOrchestrator;
  const timeoutManager = new TimeoutManager({
    onTimeout: async (swapId: string) => orchestratorRef._handleTimeout(swapId),
  });

  const orchestrator = new SwapOrchestrator({
    invoiceManager,
    stateStore,
    timeoutManager,
    messageSender: {
      sendToParty: async (swapId, party, message) => {
        // TODO: Implement Nostr DM routing via npubRoleMap
        logger.debug({ swapId, party, type: message.type }, 'DM to party (not wired yet)');
      },
      sendToAddress: async (address, message) => {
        // TODO: Implement Nostr DM routing by address
        logger.debug({ address, type: message.type }, 'DM to address (not wired yet)');
      },
    },
    addressResolver: {
      resolve: async (address) => {
        // TODO: Implement nametag/proxy resolution via Sphere
        // For now, pass through DIRECT:// addresses unchanged
        if (address.startsWith('DIRECT://')) return address;
        logger.warn({ address }, 'Address resolution not yet implemented for non-DIRECT addresses');
        return null;
      },
    },
  });

  // 4. Start orchestrator (subscribes to invoice events)
  orchestratorRef = orchestrator;
  orchestrator.start();

  // 5. Crash recovery: reconcile non-terminal swaps
  await orchestrator.recoverSwaps();

  // 6. Start DM message handler
  // TODO: Wire up NpubRoleMap for full DM protocol support
  const messageHandler = createMessageHandler({
    sphere,
    orchestrator: orchestrator as any,
    stateStore,
    invoiceManager: invoiceManager as any,
    npubRoleMap: { register: () => {}, getRole: () => null, getSwapIds: () => [] } as any,
  });
  messageHandler.start();

  // 7. Graceful shutdown
  setupGracefulShutdown(messageHandler, orchestrator, timeoutManager, walletManager);

  logger.info('Escrow service started successfully');
}

function setupGracefulShutdown(
  messageHandler: { stop(): Promise<void> },
  orchestrator: SwapOrchestrator,
  timeoutManager: TimeoutManager,
  walletManager: { destroy(): Promise<void> },
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    const hardKill = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000);
    hardKill.unref();

    await messageHandler.stop();
    await orchestrator.stop();
    timeoutManager.destroy();

    await walletManager.destroy().catch((err) => {
      logger.error({ err }, 'Error destroying wallet');
    });

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start escrow service');
  process.exit(1);
});
