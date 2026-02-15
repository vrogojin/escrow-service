import { Router, type Request, type Response, type NextFunction } from 'express';
import type { SwapManager } from '../../core/swap-manager.js';
import type { DepositRepository } from '../../storage/repositories/deposit.repository.js';
import type { TransactionRepository } from '../../storage/repositories/transaction.repository.js';
import { validateSwapIdParam, validateManifestBody } from '../middleware/validation.js';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { WalletManager } from '../../sphere/wallet-manager.js';

export interface SwapRoutesDeps {
  swapManager: SwapManager;
  depositRepo: DepositRepository;
  txRepo: TransactionRepository;
  pool: Pool;
  redis: Redis;
  walletManager: WalletManager;
}

export function createSwapRoutes(deps: SwapRoutesDeps): Router {
  const router = Router();
  const { swapManager, depositRepo, txRepo, pool, redis, walletManager } = deps;

  /**
   * POST /api/v1/swaps - Submit a swap manifest
   */
  router.post('/swaps', validateManifestBody, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await swapManager.announceSwap(req.body.manifest);
      const status = result.isNew ? 201 : 200;
      res.status(status).json({
        swap_id: result.swapCase.swap_id,
        state: result.swapCase.state,
        created_at: result.swapCase.created_at,
        is_new: result.isNew,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/swaps/:swap_id - Get swap status
   */
  router.get('/swaps/:swap_id', validateSwapIdParam, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const swap = await swapManager.getSwap(req.params.swap_id as string);
      if (!swap) {
        res.status(404).json({ error: 'Swap not found' });
        return;
      }

      const deposits = await depositRepo.findBySwapId(swap.swap_id);
      const transactions = await txRepo.findBySwapId(swap.swap_id);

      res.json({
        swap_id: swap.swap_id,
        state: swap.state,
        manifest: swap.manifest,
        party_a_deposited: swap.party_a_deposited,
        party_b_deposited: swap.party_b_deposited,
        created_at: swap.created_at,
        first_deposit_at: swap.first_deposit_at,
        timeout_at: swap.timeout_at,
        completed_at: swap.completed_at,
        error_message: swap.error_message,
        deposits: deposits.map((d) => ({
          transaction_id: d.transaction_id,
          sender: d.sender,
          amount: d.amount,
          coin_id: d.coin_id,
          matched_party: d.matched_party,
          status: d.status,
          received_at: d.received_at,
        })),
        transactions: transactions.map((t) => ({
          type: t.type,
          direction: t.direction,
          recipient: t.recipient,
          amount: t.amount,
          coin_id: t.coin_id,
          status: t.status,
          created_at: t.created_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/swaps/:swap_id/deposit-instructions - Return deposit instructions
   */
  router.get('/swaps/:swap_id/deposit-instructions', validateSwapIdParam, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const swap = await swapManager.getSwap(req.params.swap_id as string);
      if (!swap) {
        res.status(404).json({ error: 'Swap not found' });
        return;
      }

      res.json({
        swap_id: swap.swap_id,
        escrow_address: walletManager.getEscrowAddress(),
        memo: swap.swap_id,
        party_a: {
          address: swap.manifest.party_a_address,
          currency: swap.manifest.party_a_currency_to_change,
          amount: swap.manifest.party_a_value_to_change,
          deposited: swap.party_a_deposited,
        },
        party_b: {
          address: swap.manifest.party_b_address,
          currency: swap.manifest.party_b_currency_to_change,
          amount: swap.manifest.party_b_value_to_change,
          deposited: swap.party_b_deposited,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/health - Health check
   */
  router.get('/health', async (_req: Request, res: Response) => {
    const checks: Record<string, { status: string; error?: string }> = {};

    // Database health
    try {
      await pool.query('SELECT 1');
      checks.database = { status: 'ok' };
    } catch (err) {
      checks.database = { status: 'error', error: (err as Error).message };
    }

    // Redis health
    try {
      await redis.ping();
      checks.redis = { status: 'ok' };
    } catch (err) {
      checks.redis = { status: 'error', error: (err as Error).message };
    }

    // Sphere wallet health
    try {
      const address = walletManager.getEscrowAddress();
      checks.sphere = { status: address ? 'ok' : 'error' };
    } catch (err) {
      checks.sphere = { status: 'error', error: (err as Error).message };
    }

    const allOk = Object.values(checks).every((c) => c.status === 'ok');
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'healthy' : 'degraded',
      checks,
    });
  });

  return router;
}
