import { loadConfig } from './config.js';
import { getPool, closePool, migrate } from './storage/database.js';
import { connectRedis, closeRedis } from './storage/redis.js';
import { initializeWallet } from './sphere/wallet-manager.js';
import { createPaymentSender } from './sphere/payment-sender.js';
import { createPaymentListener } from './sphere/payment-listener.js';
import { SwapRepository } from './storage/repositories/swap.repository.js';
import { DepositRepository } from './storage/repositories/deposit.repository.js';
import { TransactionRepository } from './storage/repositories/transaction.repository.js';
import { SwapManager } from './core/swap-manager.js';
import { PaymentProcessor } from './core/payment-processor.js';
import { ConclusionProcessor } from './core/conclusion-processor.js';
import { RefundProcessor } from './core/refund-processor.js';
import { TimeoutManager } from './core/timeout-manager.js';
import { createApp, startServer } from './api/server.js';
import { SwapState } from './core/state-machine.js';
import { logger } from './utils/logger.js';
import type { Server } from 'http';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ nodeEnv: config.nodeEnv, port: config.port }, 'Starting escrow service');

  // 1. Initialize PostgreSQL pool + run migration
  const pool = getPool(config.databaseUrl);
  await migrate(config.databaseUrl);
  logger.info('Database initialized');

  // 2. Initialize Redis client
  const redis = await connectRedis(config.redisUrl);
  logger.info('Redis connected');

  // 3. Initialize Sphere wallet
  const walletManager = await initializeWallet(config);
  const sphere = walletManager.getSphere();
  const escrowAddress = walletManager.getEscrowAddress();
  logger.info({ escrowAddress }, 'Sphere wallet ready');

  // 4. Create repositories
  const swapRepo = new SwapRepository(pool);
  const depositRepo = new DepositRepository(pool);
  const txRepo = new TransactionRepository(pool);

  // 5. Create payment infrastructure
  const paymentSender = createPaymentSender(sphere);
  const paymentListener = createPaymentListener(sphere);

  // 6. Create processors
  const conclusionProcessor = new ConclusionProcessor({
    pool,
    swapRepo,
    txRepo,
    paymentSender,
    escrowAddress,
    config,
  });

  const refundProcessor = new RefundProcessor({
    pool,
    swapRepo,
    txRepo,
    paymentSender,
    escrowAddress,
    config,
  });

  const timeoutManager = new TimeoutManager({
    pool,
    swapRepo,
    redis,
    onTimeout: (swapId: string) => refundProcessor.processTimeout(swapId),
  });

  const paymentProcessor = new PaymentProcessor({
    pool,
    redis,
    swapRepo,
    depositRepo,
    txRepo,
    paymentSender,
    escrowAddress,
    onReadyToConclude: (swapId: string) => {
      conclusionProcessor.conclude(swapId).catch((err) => {
        logger.error({ err, swap_id: swapId }, 'Conclusion failed');
      });
    },
    onFirstDeposit: (swapId: string, timeoutSeconds: number) => {
      timeoutManager.scheduleTimeout(swapId, timeoutSeconds).catch((err) => {
        logger.error({ err, swap_id: swapId }, 'Failed to schedule timeout');
      });
    },
    sphere,
    depositConfirmationTimeoutMs: config.depositConfirmationTimeoutMs,
  });

  // 7. Create swap manager
  const swapManager = new SwapManager({
    pool,
    swapRepo,
    depositRepo,
    config,
  });

  // 8. Start payment listener
  paymentListener.start((transfer) => paymentProcessor.processIncomingTransfer(transfer));

  // 9. Start timeout manager with recovery
  await timeoutManager.recover();
  timeoutManager.start();

  // 10. Startup recovery: retry stuck swaps
  await recoverStuckSwaps(swapRepo, conclusionProcessor, refundProcessor);

  // 11. Start HTTP server
  const app = createApp({
    config,
    swapManager,
    depositRepo,
    txRepo,
    pool,
    redis,
    walletManager,
  });
  const server = startServer(app, config.port);

  // 12. Graceful shutdown
  setupGracefulShutdown(server, paymentListener, timeoutManager, walletManager);

  logger.info('Escrow service started successfully');
}

async function recoverStuckSwaps(
  swapRepo: SwapRepository,
  conclusionProcessor: ConclusionProcessor,
  refundProcessor: RefundProcessor,
): Promise<void> {
  // Retry swaps stuck in CONCLUDING
  const concludingResult = await swapRepo.findByState(SwapState.CONCLUDING);
  for (const swap of concludingResult) {
    logger.warn({ swap_id: swap.swap_id }, 'Retrying stuck CONCLUDING swap');
    conclusionProcessor.conclude(swap.swap_id).catch((err) => {
      logger.error({ err, swap_id: swap.swap_id }, 'Recovery conclusion failed');
    });
  }

  // Retry swaps stuck in REFUNDING
  const refundingResult = await swapRepo.findByState(SwapState.REFUNDING);
  for (const swap of refundingResult) {
    logger.warn({ swap_id: swap.swap_id }, 'Retrying stuck REFUNDING swap');
    refundProcessor.retryRefund(swap.swap_id).catch((err) => {
      logger.error({ err, swap_id: swap.swap_id }, 'Recovery refund failed');
    });
  }

  // Log FAILED swaps for manual review
  const failedCount = await swapRepo.countByState(SwapState.FAILED);
  if (failedCount > 0) {
    logger.warn({ count: failedCount }, 'FAILED swaps require manual review');
  }
}

function setupGracefulShutdown(
  server: Server,
  paymentListener: { stop(): void },
  timeoutManager: TimeoutManager,
  walletManager: { destroy(): Promise<void> },
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    // Stop accepting new HTTP connections
    server.close();

    // Stop payment listener and timeout manager
    paymentListener.stop();
    timeoutManager.stop();

    // Wait for in-flight operations
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Close connections
    await walletManager.destroy().catch((err) => {
      logger.error({ err }, 'Error destroying wallet');
    });
    await closeRedis().catch((err) => {
      logger.error({ err }, 'Error closing Redis');
    });
    await closePool().catch((err) => {
      logger.error({ err }, 'Error closing database pool');
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
