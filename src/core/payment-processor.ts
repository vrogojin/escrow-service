import type { Pool, PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import type { IncomingTransfer, Token } from '@unicitylabs/sphere-sdk';
import { SwapState, canAcceptDeposit, assertTransition } from './state-machine.js';
import { isValidSwapId } from '../utils/hash.js';
import { addressesMatch } from '../utils/address.js';
import { SwapRepository, type SwapCaseRow } from '../storage/repositories/swap.repository.js';
import { DepositRepository } from '../storage/repositories/deposit.repository.js';
import { TransactionRepository } from '../storage/repositories/transaction.repository.js';
import type { PaymentSender, SendPaymentRequest } from '../sphere/payment-sender.js';
import { acquireLock } from '../storage/redis.js';
import { logger } from '../utils/logger.js';

export interface PaymentProcessorDeps {
  pool: Pool;
  redis: Redis;
  swapRepo: SwapRepository;
  depositRepo: DepositRepository;
  txRepo: TransactionRepository;
  paymentSender: PaymentSender;
  escrowAddress: string;
  onReadyToConclude: (swapId: string) => void;
  onFirstDeposit: (swapId: string, timeoutSeconds: number) => void;
}

type BounceReason =
  | 'INVALID_MEMO'
  | 'SWAP_NOT_FOUND'
  | 'SWAP_CLOSED'
  | 'UNKNOWN_SENDER'
  | 'WRONG_CURRENCY'
  | 'ALREADY_COVERED'
  | 'DUPLICATE_TRANSACTION';

export class PaymentProcessor {
  private pool: Pool;
  private redis: Redis;
  private swapRepo: SwapRepository;
  private depositRepo: DepositRepository;
  private txRepo: TransactionRepository;
  private paymentSender: PaymentSender;
  private escrowAddress: string;
  private onReadyToConclude: (swapId: string) => void;
  private onFirstDeposit: (swapId: string, timeoutSeconds: number) => void;

  constructor(deps: PaymentProcessorDeps) {
    this.pool = deps.pool;
    this.redis = deps.redis;
    this.swapRepo = deps.swapRepo;
    this.depositRepo = deps.depositRepo;
    this.txRepo = deps.txRepo;
    this.paymentSender = deps.paymentSender;
    this.escrowAddress = deps.escrowAddress;
    this.onReadyToConclude = deps.onReadyToConclude;
    this.onFirstDeposit = deps.onFirstDeposit;
  }

  /**
   * Process an incoming transfer from the Sphere payment listener.
   */
  async processIncomingTransfer(transfer: IncomingTransfer): Promise<void> {
    const memo = transfer.memo?.trim() ?? '';
    const senderAddress = transfer.senderNametag
      ? `@${transfer.senderNametag}`
      : `DIRECT://${transfer.senderPubkey}`;

    // Aggregate token amounts by coinId
    const tokensByCoin = this.aggregateTokens(transfer.tokens);

    for (const [coinId, amount] of tokensByCoin) {
      const transactionId = `${transfer.id}_${coinId}`;
      await this.processDeposit({
        transactionId,
        memo,
        senderAddress,
        senderPubkey: transfer.senderPubkey,
        senderNametag: transfer.senderNametag,
        coinId,
        amount,
      });
    }
  }

  private async processDeposit(params: {
    transactionId: string;
    memo: string;
    senderAddress: string;
    senderPubkey: string;
    senderNametag?: string;
    coinId: string;
    amount: string;
  }): Promise<void> {
    const { transactionId, memo, senderAddress, senderPubkey, senderNametag, coinId, amount } = params;

    // Step 1: Validate memo contains a valid swap_id
    const swapId = this.extractSwapId(memo);
    if (!swapId) {
      await this.bounceback(senderAddress, amount, coinId, 'INVALID_MEMO', transactionId);
      return;
    }

    // Step 2-8: Acquire distributed lock, then process within a database transaction
    const releaseLock = await acquireLock(this.redis, `deposit:${swapId}`, 5000);
    if (!releaseLock) {
      logger.warn({ swapId, transactionId }, 'Could not acquire deposit lock, retrying may be needed');
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Check idempotency
      const existingDeposit = await this.depositRepo.findByTransactionId(transactionId, client);
      if (existingDeposit) {
        logger.warn({ transactionId }, 'Duplicate transaction, skipping');
        await client.query('COMMIT');
        return;
      }

      // Lock and fetch the swap
      const swap = await this.swapRepo.findBySwapIdForUpdate(swapId, client);
      if (!swap) {
        await client.query('ROLLBACK');
        await this.bounceback(senderAddress, amount, coinId, 'SWAP_NOT_FOUND', transactionId, swapId);
        return;
      }

      // Check swap is in a state that accepts deposits
      if (!canAcceptDeposit(swap.state)) {
        await client.query('ROLLBACK');
        await this.bounceback(senderAddress, amount, coinId, 'SWAP_CLOSED', transactionId, swapId);
        return;
      }

      // Identify which party this sender is
      const party = this.identifySender(swap, senderAddress, senderPubkey, senderNametag);
      if (!party) {
        await client.query('ROLLBACK');
        await this.bounceback(senderAddress, amount, coinId, 'UNKNOWN_SENDER', transactionId, swapId);
        return;
      }

      // Verify currency matches
      const expectedCurrency = party === 'A'
        ? swap.manifest.party_a_currency_to_change
        : swap.manifest.party_b_currency_to_change;
      if (coinId !== expectedCurrency) {
        await client.query('ROLLBACK');
        await this.bounceback(senderAddress, amount, coinId, 'WRONG_CURRENCY', transactionId, swapId);
        return;
      }

      // Check if party already fully covered
      const expectedAmount = party === 'A'
        ? BigInt(swap.manifest.party_a_value_to_change)
        : BigInt(swap.manifest.party_b_value_to_change);
      const currentDeposited = party === 'A'
        ? BigInt(swap.party_a_deposited)
        : BigInt(swap.party_b_deposited);

      if (currentDeposited >= expectedAmount) {
        await client.query('ROLLBACK');
        await this.bounceback(senderAddress, amount, coinId, 'ALREADY_COVERED', transactionId, swapId);
        return;
      }

      // Record the deposit
      const depositAmount = BigInt(amount);
      const newTotal = currentDeposited + depositAmount;

      await this.depositRepo.create(
        {
          swap_id: swapId,
          transaction_id: transactionId,
          sender: senderAddress,
          amount,
          coin_id: coinId,
          memo,
          matched_party: party,
        },
        client,
      );

      // Log the deposit transaction
      await this.txRepo.create(
        {
          swap_id: swapId,
          type: 'DEPOSIT',
          direction: 'INCOMING',
          sender: senderAddress,
          recipient: this.escrowAddress,
          amount,
          coin_id: coinId,
          memo,
          transaction_id: transactionId,
          status: 'CONFIRMED',
        },
        client,
      );

      // Handle overpayment: schedule surplus return
      let effectiveDeposit = depositAmount;
      let surplus = 0n;
      if (newTotal > expectedAmount) {
        surplus = newTotal - expectedAmount;
        effectiveDeposit = depositAmount - surplus;
      }

      // Update swap deposit amounts
      const updateFields: Record<string, string> = {};
      if (party === 'A') {
        updateFields.party_a_deposited = (currentDeposited + effectiveDeposit).toString();
        updateFields.party_a_coin_id = coinId;
      } else {
        updateFields.party_b_deposited = (currentDeposited + effectiveDeposit).toString();
        updateFields.party_b_coin_id = coinId;
      }

      // Determine new state
      const otherPartyDeposited = party === 'A'
        ? BigInt(swap.party_b_deposited)
        : BigInt(swap.party_a_deposited);
      const otherExpected = party === 'A'
        ? BigInt(swap.manifest.party_b_value_to_change)
        : BigInt(swap.manifest.party_a_value_to_change);

      const thisPartyCovered = (currentDeposited + effectiveDeposit) >= expectedAmount;
      const otherPartyCovered = otherPartyDeposited >= otherExpected;
      const bothCovered = thisPartyCovered && otherPartyCovered;

      let newState: SwapState;
      const stateUpdates: Record<string, unknown> = { ...updateFields };

      if (bothCovered) {
        newState = SwapState.READY_TO_CONCLUDE;
      } else if (swap.state === SwapState.ANNOUNCED) {
        newState = SwapState.PARTIAL_DEPOSIT;
        stateUpdates.first_deposit_at = new Date();
        const timeoutAt = new Date(Date.now() + swap.manifest.timeout * 1000);
        stateUpdates.timeout_at = timeoutAt;
      } else {
        // Already PARTIAL_DEPOSIT, stays PARTIAL_DEPOSIT (deposit added but not enough)
        // Just update deposit amounts without state change
        await this.swapRepo.updateDeposits(
          swapId,
          updateFields as Record<string, string>,
          swap.version,
          client,
        );
        await client.query('COMMIT');

        // Handle surplus outside transaction
        if (surplus > 0n) {
          await this.returnSurplus(senderAddress, surplus.toString(), coinId, swapId);
        }
        return;
      }

      assertTransition(swap.state, newState);
      await this.swapRepo.updateState(swapId, newState, swap.version, stateUpdates as any, client);
      await client.query('COMMIT');

      // Handle surplus outside transaction
      if (surplus > 0n) {
        await this.returnSurplus(senderAddress, surplus.toString(), coinId, swapId);
      }

      // Trigger follow-up actions
      if (newState === SwapState.READY_TO_CONCLUDE) {
        this.onReadyToConclude(swapId);
      } else if (newState === SwapState.PARTIAL_DEPOSIT) {
        this.onFirstDeposit(swapId, swap.manifest.timeout);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, transactionId }, 'Error processing deposit');
      throw err;
    } finally {
      client.release();
      await releaseLock();
    }
  }

  /**
   * Extract exactly 64 hex char swap_id from memo.
   */
  private extractSwapId(memo: string): string | null {
    const trimmed = memo.trim().toLowerCase();
    if (isValidSwapId(trimmed)) return trimmed;

    // Try to find a 64 hex char substring
    const match = /\b([0-9a-f]{64})\b/.exec(trimmed);
    return match ? match[1] : null;
  }

  /**
   * Identify which party (A or B) the sender is.
   */
  private identifySender(
    swap: SwapCaseRow,
    senderAddress: string,
    senderPubkey: string,
    senderNametag?: string,
  ): 'A' | 'B' | null {
    const manifest = swap.manifest;

    // Try matching against party_a_address
    if (
      addressesMatch(senderAddress, manifest.party_a_address) ||
      addressesMatch(`DIRECT://${senderPubkey}`, manifest.party_a_address) ||
      (senderNametag && addressesMatch(`@${senderNametag}`, manifest.party_a_address))
    ) {
      return 'A';
    }

    // Try matching against party_b_address
    if (
      addressesMatch(senderAddress, manifest.party_b_address) ||
      addressesMatch(`DIRECT://${senderPubkey}`, manifest.party_b_address) ||
      (senderNametag && addressesMatch(`@${senderNametag}`, manifest.party_b_address))
    ) {
      return 'B';
    }

    return null;
  }

  private aggregateTokens(tokens: Token[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const token of tokens) {
      const current = BigInt(result.get(token.coinId) ?? '0');
      result.set(token.coinId, (current + BigInt(token.amount)).toString());
    }
    return result;
  }

  private async bounceback(
    recipient: string,
    amount: string,
    coinId: string,
    reason: BounceReason,
    transactionId: string,
    swapId?: string,
  ): Promise<void> {
    logger.info({ recipient, amount, coinId, reason, swapId }, 'Bouncing back payment');

    try {
      await this.txRepo.create({
        swap_id: swapId ?? 'UNMATCHED',
        type: 'BOUNCEBACK',
        direction: 'OUTGOING',
        sender: this.escrowAddress,
        recipient,
        amount,
        coin_id: coinId,
        memo: `Bounceback: ${reason}`,
        transaction_id: `bounce_${transactionId}`,
        status: 'PENDING',
      });

      await this.paymentSender.send({
        recipient,
        amount,
        coinId,
        memo: `Bounceback: ${reason}`,
      });
    } catch (err) {
      logger.error({ err, recipient, reason }, 'Failed to bounceback payment');
    }
  }

  private async returnSurplus(
    recipient: string,
    amount: string,
    coinId: string,
    swapId: string,
  ): Promise<void> {
    logger.info({ recipient, amount, coinId, swapId }, 'Returning surplus');

    try {
      await this.txRepo.create({
        swap_id: swapId,
        type: 'SURPLUS_RETURN',
        direction: 'OUTGOING',
        sender: this.escrowAddress,
        recipient,
        amount,
        coin_id: coinId,
        memo: `Surplus return for swap ${swapId}`,
      });

      await this.paymentSender.send({
        recipient,
        amount,
        coinId,
        memo: `Surplus return for swap ${swapId}`,
      });
    } catch (err) {
      logger.error({ err, swapId, recipient }, 'Failed to return surplus');
    }
  }
}
