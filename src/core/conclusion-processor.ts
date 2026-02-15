import type { Pool } from 'pg';
import { SwapState, assertTransition } from './state-machine.js';
import { SwapRepository, type SwapCaseRow } from '../storage/repositories/swap.repository.js';
import { TransactionRepository } from '../storage/repositories/transaction.repository.js';
import type { PaymentSender } from '../sphere/payment-sender.js';
import { logger } from '../utils/logger.js';
import type { Config } from '../config.js';

export interface ConclusionProcessorDeps {
  pool: Pool;
  swapRepo: SwapRepository;
  txRepo: TransactionRepository;
  paymentSender: PaymentSender;
  escrowAddress: string;
  config: Config;
}

export class ConclusionProcessor {
  private pool: Pool;
  private swapRepo: SwapRepository;
  private txRepo: TransactionRepository;
  private paymentSender: PaymentSender;
  private escrowAddress: string;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(deps: ConclusionProcessorDeps) {
    this.pool = deps.pool;
    this.swapRepo = deps.swapRepo;
    this.txRepo = deps.txRepo;
    this.paymentSender = deps.paymentSender;
    this.escrowAddress = deps.escrowAddress;
    this.maxRetries = deps.config.paymentRetryMaxAttempts;
    this.retryDelayMs = deps.config.paymentRetryDelayMs;
  }

  /**
   * Execute conclusion for a swap that has both deposits.
   * Cross-pays each party their expected counter-currency.
   */
  async conclude(swapId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const swap = await this.swapRepo.findBySwapIdForUpdate(swapId, client);

      if (!swap) {
        logger.warn({ swap_id: swapId }, 'Swap not found for conclusion');
        await client.query('ROLLBACK');
        return;
      }

      if (swap.state !== SwapState.READY_TO_CONCLUDE) {
        logger.warn({ swap_id: swapId, state: swap.state }, 'Swap not in READY_TO_CONCLUDE state');
        await client.query('ROLLBACK');
        return;
      }

      // Transition to CONCLUDING
      assertTransition(swap.state, SwapState.CONCLUDING);
      const updated = await this.swapRepo.updateState(
        swapId,
        SwapState.CONCLUDING,
        swap.version,
        {},
        client,
      );

      if (!updated) {
        logger.warn({ swap_id: swapId }, 'Optimistic lock conflict during conclusion');
        await client.query('ROLLBACK');
        return;
      }

      await client.query('COMMIT');

      // Execute cross-payments outside the DB transaction
      await this.executeCrossPayments(swapId, swap);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, swap_id: swapId }, 'Error starting conclusion');
      await this.markFailed(swapId, `Conclusion error: ${err}`);
      throw err;
    } finally {
      client.release();
    }
  }

  private async executeCrossPayments(swapId: string, swap: SwapCaseRow): Promise<void> {
    const manifest = swap.manifest;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Cross-pay Party A: send Party B's currency/value to Party A's address
        await this.sendCrossPayment(swapId, {
          recipient: manifest.party_a_address,
          amount: manifest.party_b_value_to_change,
          coinId: manifest.party_b_currency_to_change,
        });

        // Cross-pay Party B: send Party A's currency/value to Party B's address
        await this.sendCrossPayment(swapId, {
          recipient: manifest.party_b_address,
          amount: manifest.party_a_value_to_change,
          coinId: manifest.party_a_currency_to_change,
        });

        // Return any surplus deposits
        await this.returnSurplus(swapId, swap, 'A');
        await this.returnSurplus(swapId, swap, 'B');

        // Transition to COMPLETED
        const freshSwap = await this.swapRepo.findBySwapId(swapId);
        if (freshSwap && freshSwap.state === SwapState.CONCLUDING) {
          assertTransition(SwapState.CONCLUDING, SwapState.COMPLETED);
          await this.swapRepo.updateState(
            swapId,
            SwapState.COMPLETED,
            freshSwap.version,
            { completed_at: new Date() },
          );
          logger.info({ swap_id: swapId }, 'Swap completed successfully');
        }
        return; // Success - exit retry loop
      } catch (err) {
        logger.error({ err, swap_id: swapId, attempt, maxRetries: this.maxRetries }, 'Cross-payment attempt failed');
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
          logger.info({ swap_id: swapId, delay_ms: delay }, 'Retrying cross-payment');
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error({ swap_id: swapId }, 'All cross-payment retries exhausted');
          await this.markFailed(swapId, `Cross-payment failed after ${this.maxRetries} attempts: ${err}`);
        }
      }
    }
  }

  private async sendCrossPayment(
    swapId: string,
    params: { recipient: string; amount: string; coinId: string },
  ): Promise<void> {
    const exists = await this.txRepo.existsSuccessful(swapId, 'CROSS_PAYMENT', params.recipient);
    if (exists) return;

    const log = await this.txRepo.create({
      swap_id: swapId,
      type: 'CROSS_PAYMENT',
      direction: 'OUTGOING',
      sender: this.escrowAddress,
      recipient: params.recipient,
      amount: params.amount,
      coin_id: params.coinId,
      memo: `Swap ${swapId} payout`,
      status: 'PENDING',
    });

    await this.paymentSender.send({
      recipient: params.recipient,
      amount: params.amount,
      coinId: params.coinId,
      memo: `Swap ${swapId} payout`,
    });

    await this.txRepo.updateStatus(log.id, 'SENT');
  }

  private async returnSurplus(swapId: string, swap: SwapCaseRow, party: 'A' | 'B'): Promise<void> {
    const manifest = swap.manifest;
    const deposited = BigInt(party === 'A' ? swap.party_a_deposited : swap.party_b_deposited);
    const expected = BigInt(
      party === 'A' ? manifest.party_a_value_to_change : manifest.party_b_value_to_change,
    );

    if (deposited <= expected) return;

    const surplus = (deposited - expected).toString();
    const recipient = party === 'A' ? manifest.party_a_address : manifest.party_b_address;
    const coinId = party === 'A'
      ? manifest.party_a_currency_to_change
      : manifest.party_b_currency_to_change;

    const existingSurplus = await this.txRepo.existsSuccessful(swapId, 'SURPLUS_RETURN', recipient);
    if (existingSurplus) return;

    logger.info({ swap_id: swapId, party, surplus, recipient }, 'Returning surplus deposit');

    const log = await this.txRepo.create({
      swap_id: swapId,
      type: 'SURPLUS_RETURN',
      direction: 'OUTGOING',
      sender: this.escrowAddress,
      recipient,
      amount: surplus,
      coin_id: coinId,
      memo: `Surplus return for swap ${swapId}`,
      status: 'PENDING',
    });

    await this.paymentSender.send({
      recipient,
      amount: surplus,
      coinId,
      memo: `Surplus return for swap ${swapId}`,
    });

    await this.txRepo.updateStatus(log.id, 'SENT');
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
