import type { Pool } from 'pg';
import { SwapState, assertTransition } from './state-machine.js';
import { SwapRepository, type SwapCaseRow } from '../storage/repositories/swap.repository.js';
import { TransactionRepository } from '../storage/repositories/transaction.repository.js';
import type { PaymentSender } from '../sphere/payment-sender.js';
import { logger } from '../utils/logger.js';
import type { Config } from '../config.js';

export interface RefundProcessorDeps {
  pool: Pool;
  swapRepo: SwapRepository;
  txRepo: TransactionRepository;
  paymentSender: PaymentSender;
  escrowAddress: string;
  config: Config;
}

export class RefundProcessor {
  private pool: Pool;
  private swapRepo: SwapRepository;
  private txRepo: TransactionRepository;
  private paymentSender: PaymentSender;
  private escrowAddress: string;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(deps: RefundProcessorDeps) {
    this.pool = deps.pool;
    this.swapRepo = deps.swapRepo;
    this.txRepo = deps.txRepo;
    this.paymentSender = deps.paymentSender;
    this.escrowAddress = deps.escrowAddress;
    this.maxRetries = deps.config.paymentRetryMaxAttempts;
    this.retryDelayMs = deps.config.paymentRetryDelayMs;
  }

  /**
   * Process a timeout refund. Called when the timeout timer fires.
   */
  async processTimeout(swapId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const swap = await this.swapRepo.findBySwapIdForUpdate(swapId, client);

      if (!swap) {
        logger.warn({ swap_id: swapId }, 'Swap not found for timeout');
        await client.query('ROLLBACK');
        return;
      }

      if (swap.state !== SwapState.PARTIAL_DEPOSIT) {
        logger.info({ swap_id: swapId, state: swap.state }, 'Swap no longer in PARTIAL_DEPOSIT, skipping timeout');
        await client.query('ROLLBACK');
        return;
      }

      // Transition PARTIAL_DEPOSIT → TIMED_OUT
      assertTransition(swap.state, SwapState.TIMED_OUT);
      let updated = await this.swapRepo.updateState(
        swapId,
        SwapState.TIMED_OUT,
        swap.version,
        {},
        client,
      );

      if (!updated) {
        logger.warn({ swap_id: swapId }, 'Optimistic lock conflict during timeout');
        await client.query('ROLLBACK');
        return;
      }

      // Transition TIMED_OUT → CANCELLING
      assertTransition(SwapState.TIMED_OUT, SwapState.CANCELLING);
      updated = await this.swapRepo.updateState(
        swapId,
        SwapState.CANCELLING,
        updated.version,
        {},
        client,
      );

      if (!updated) {
        await client.query('ROLLBACK');
        return;
      }

      await client.query('COMMIT');

      // Execute refunds outside the DB transaction
      await this.executeRefunds(swapId, swap);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, swap_id: swapId }, 'Error processing timeout');
      await this.markFailed(swapId, `Timeout processing error: ${err}`);
    } finally {
      client.release();
    }
  }

  /**
   * Retry refund for a swap already in CANCELLING state (e.g. on startup recovery).
   */
  async retryRefund(swapId: string): Promise<void> {
    const swap = await this.swapRepo.findBySwapId(swapId);
    if (!swap || swap.state !== SwapState.CANCELLING) {
      logger.info({ swap_id: swapId, state: swap?.state }, 'Swap not in CANCELLING state for retry');
      return;
    }
    await this.executeRefunds(swapId, swap);
  }

  private async executeRefunds(swapId: string, swap: SwapCaseRow): Promise<void> {
    const manifest = swap.manifest;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Refund Party A if they deposited
        if (BigInt(swap.party_a_deposited) > 0n) {
          await this.refundParty(swapId, {
            recipient: manifest.party_a_address,
            amount: swap.party_a_deposited,
            coinId: manifest.party_a_currency_to_change,
          });
        }

        // Refund Party B if they deposited
        if (BigInt(swap.party_b_deposited) > 0n) {
          await this.refundParty(swapId, {
            recipient: manifest.party_b_address,
            amount: swap.party_b_deposited,
            coinId: manifest.party_b_currency_to_change,
          });
        }

        // Transition CANCELLING → CANCELLED
        const freshSwap = await this.swapRepo.findBySwapId(swapId);
        if (freshSwap && freshSwap.state === SwapState.CANCELLING) {
          assertTransition(SwapState.CANCELLING, SwapState.CANCELLED);
          await this.swapRepo.updateState(
            swapId,
            SwapState.CANCELLED,
            freshSwap.version,
            { completed_at: new Date() },
          );
          logger.info({ swap_id: swapId }, 'Swap refunded successfully');
        }
        return; // Success
      } catch (err) {
        logger.error({ err, swap_id: swapId, attempt, maxRetries: this.maxRetries }, 'Refund attempt failed');
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
          logger.info({ swap_id: swapId, delay_ms: delay }, 'Retrying refund');
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error({ swap_id: swapId }, 'All refund retries exhausted');
          await this.markFailed(swapId, `Refund failed after ${this.maxRetries} attempts: ${err}`);
        }
      }
    }
  }

  private async refundParty(
    swapId: string,
    params: { recipient: string; amount: string; coinId: string },
  ): Promise<void> {
    const alreadyRefunded = await this.txRepo.existsSuccessful(swapId, 'REFUND', params.recipient);
    if (alreadyRefunded) {
      logger.info({ swap_id: swapId, recipient: params.recipient }, 'Refund already sent, skipping');
      return;
    }

    const log = await this.txRepo.create({
      swap_id: swapId,
      type: 'REFUND',
      direction: 'OUTGOING',
      sender: this.escrowAddress,
      recipient: params.recipient,
      amount: params.amount,
      coin_id: params.coinId,
      memo: `Refund for timed-out swap ${swapId}`,
      status: 'PENDING',
    });

    await this.paymentSender.send({
      recipient: params.recipient,
      amount: params.amount,
      coinId: params.coinId,
      memo: `Refund for timed-out swap ${swapId}`,
    });

    await this.txRepo.updateStatus(log.id, 'SENT');
    logger.info({ swap_id: swapId, recipient: params.recipient, amount: params.amount }, 'Refund sent');
  }

  private async markFailed(swapId: string, errorMessage: string): Promise<void> {
    try {
      const swap = await this.swapRepo.findBySwapId(swapId);
      if (swap && swap.state !== SwapState.FAILED) {
        await this.swapRepo.updateState(swapId, SwapState.FAILED, swap.version, {
          error_message: errorMessage,
        });
      }
    } catch (err) {
      logger.error({ err, swap_id: swapId }, 'Failed to mark swap as FAILED');
    }
  }
}
