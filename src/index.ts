import * as fs from 'node:fs';
import { loadConfig } from './config.js';
import { initializeWallet } from './sphere/wallet-manager.js';
import { createMessageHandler } from './sphere/message-handler.js';
import { SwapOrchestrator } from './core/swap-orchestrator.js';
import { InvoiceManager } from './core/invoice-manager.js';
import type { InvoiceManagerDeps } from './core/invoice-manager.js';
import { DurableSwapStateStore } from './core/durable-swap-state-store.js';
import { DurableNpubRoleMap } from './core/durable-npub-role-map.js';
import { TimeoutManager } from './core/timeout-manager.js';
import { logger } from './utils/logger.js';
import type {
  SwapOrchestrator as ISwapOrchestrator,
} from './sphere/orchestrator-interfaces.js';

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
  // The SDK's main export type does not expose the accounting property in all
  // configurations, so we use a type-safe property existence check instead of
  // a blanket `as any` cast.
  if (!sphere.accounting) {
    throw new Error('AccountingModule not available — ensure Sphere is initialized with accounting enabled');
  }
  const invoiceManager = new InvoiceManager({
    accounting: sphere.accounting as unknown as InvoiceManagerDeps['accounting'],
    escrowAddress,
    getToken: (id) => sphere.payments.getToken(id),
    eventSource: sphere,
    receiveAndFinalize: async () => { await sphere.payments.receive({ finalize: true }); },
  });

  // Create durable data directory for WAL files
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const stateStore = new DurableSwapStateStore(config.dataDir);
  const npubRoleStore = new DurableNpubRoleMap(config.dataDir);

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
        const npub = npubRoleStore.findNpub(swapId, party);
        if (!npub) {
          logger.warn({ swapId, party }, 'No npub found for party — DM not sent');
          return;
        }
        try {
          await sphere.communications.sendDM(npub, JSON.stringify(message));
        } catch (err) {
          logger.warn({ err, swapId, party }, 'Failed to send DM to party');
        }
      },
      sendToAddress: async (address, message) => {
        // Primary: look up npub from the address-to-npub index (populated during announce)
        const npub = npubRoleStore.findNpubByAddress(address);
        if (npub) {
          try {
            await sphere.communications.sendDM(npub, JSON.stringify(message));
            return;
          } catch (err) {
            logger.warn({ err, address }, 'Failed to send DM via cached npub');
          }
        }
        // Fallback: third-party depositor — not in our role map. Bounce notifications
        // are undeliverable. Escalate to WARN for operator visibility.
        logger.warn({ address, type: (message as Record<string, unknown>).type }, 'Bounce DM undeliverable — sender not in role map');
      },
    },
    addressResolver: {
      resolve: async (address) => {
        if (address.startsWith('DIRECT://')) return address;
        if (address.startsWith('PROXY://')) {
          logger.warn({ address }, 'PROXY:// address resolution not yet supported');
          return null;
        }
        try {
          const peer = await sphere.resolve(address);
          return peer?.directAddress ?? null;
        } catch (err) {
          logger.warn({ err, address }, 'Address resolution failed');
          return null;
        }
      },
    },
    maxPendingSwaps: config.maxPendingSwaps,
  });

  // 4. Start orchestrator (subscribes to invoice events)
  orchestratorRef = orchestrator;
  orchestrator.start();

  // 5. Crash recovery: reconcile non-terminal swaps
  await orchestrator.recoverSwaps();

  // Compact WAL after crash recovery to rewrite clean state
  stateStore.compact();

  // 6. Start DM message handler with durable NpubRoleMap
  const messageHandler = createMessageHandler({
    sphere,
    orchestrator: orchestrator as ISwapOrchestrator,
    stateStore,
    invoiceManager,
    npubRoleMap: npubRoleStore,
    escrowAddress,
  });
  messageHandler.start();

  // 8. Catch-up: replay any DMs that arrived while the service was offline.
  // NIP-17 gift wraps have created_at randomized ±2 days; the sphere-sdk transport
  // now widens the since filter by 172800 s, so this call retrieves DMs that
  // would otherwise be invisible due to timestamp drift.
  await sphere.fetchPendingEvents().catch((err) => {
    logger.warn({ err }, 'fetchPendingEvents failed on startup — missed DMs may not be replayed');
  });

  // 8. Periodic token receive loop.
  // Uses payments.receive() which fetches pending Nostr events AND finalizes
  // unconfirmed tokens (triggers transfer:confirmed → invoice:covered with confirmed=true).
  // The receive() → load() cycle reloads tokens from disk, which is safe as long
  // as addToken() → save() completes before the next receive() call.
  const RECEIVE_INTERVAL_MS = 15_000;
  const receiveLoop = setInterval(async () => {
    try {
      await sphere.payments.receive({ finalize: true });
    } catch (err) {
      logger.debug({ err }, 'Receive loop error (tolerated)');
    }
  }, RECEIVE_INTERVAL_MS);

  // 7. Graceful shutdown
  setupGracefulShutdown(messageHandler, orchestrator, walletManager, receiveLoop, stateStore, npubRoleStore);

  logger.info('Escrow service started successfully');
}

function setupGracefulShutdown(
  messageHandler: { stop(): Promise<void> },
  orchestrator: SwapOrchestrator,
  walletManager: { destroy(): Promise<void> },
  receiveLoop: ReturnType<typeof setInterval>,
  stateStore: DurableSwapStateStore,
  npubRoleStore: DurableNpubRoleMap,
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

    clearInterval(receiveLoop);
    await messageHandler.stop().catch((err) => {
      logger.error({ err }, 'Error stopping message handler');
    });
    await orchestrator.stop();

    // Compact WAL files on clean shutdown
    try {
      stateStore.compact();
      npubRoleStore.compact((swapId) => {
        const swap = stateStore.findBySwapId(swapId);
        if (!swap) return true; // unknown swap = treat as terminal
        return swap.state === 'COMPLETED' || swap.state === 'CANCELLED' || swap.state === 'FAILED';
      });
      logger.info('WAL files compacted');
    } catch (err) {
      logger.error({ err }, 'Error compacting WAL files during shutdown');
    }

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
