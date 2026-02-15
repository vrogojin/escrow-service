import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { RefundProcessor } from '../refund-processor.js';
import { SwapState } from '../state-machine.js';
import type { SwapRepository, SwapCaseRow } from '../../storage/repositories/swap.repository.js';
import type { TransactionRepository } from '../../storage/repositories/transaction.repository.js';
import type { PaymentSender } from '../../sphere/payment-sender.js';
import type { Config } from '../../config.js';
import type { SwapManifest } from '../manifest-validator.js';

// Sample test manifest and data
const createManifest = (): SwapManifest => ({
  swap_id: 'a'.repeat(64),
  party_a_address: '@alice',
  party_b_address: '@bob',
  party_a_currency_to_change: 'USD',
  party_a_value_to_change: '1000',
  party_b_currency_to_change: 'EUR',
  party_b_value_to_change: '900',
  timeout: 3600,
});

const createSwapRow = (overrides?: Partial<SwapCaseRow>): SwapCaseRow => ({
  id: '1',
  swap_id: 'a'.repeat(64),
  manifest: createManifest(),
  state: SwapState.PARTIAL_DEPOSIT,
  party_a_deposited: '1000',
  party_b_deposited: '0',
  party_a_coin_id: 'USD',
  party_b_coin_id: null,
  created_at: new Date(),
  first_deposit_at: new Date(),
  timeout_at: new Date(Date.now() - 1000), // Already timed out
  completed_at: null,
  error_message: null,
  version: 1,
  ...overrides,
});

describe('RefundProcessor', () => {
  let mockPool: Pool;
  let mockClient: PoolClient;
  let mockSwapRepo: SwapRepository;
  let mockTxRepo: TransactionRepository;
  let mockPaymentSender: PaymentSender;
  let mockConfig: Config;
  let processor: RefundProcessor;

  beforeEach(() => {
    // Setup mocks
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    } as unknown as PoolClient;

    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as Pool;

    mockSwapRepo = {
      findBySwapId: vi.fn(),
      findBySwapIdForUpdate: vi.fn(),
      updateState: vi.fn(),
    } as unknown as SwapRepository;

    mockTxRepo = {
      create: vi.fn(),
      existsSuccessful: vi.fn(),
      updateStatus: vi.fn(),
    } as unknown as TransactionRepository;

    mockPaymentSender = {
      send: vi.fn(),
    } as unknown as PaymentSender;

    mockConfig = {
      paymentRetryMaxAttempts: 3,
      paymentRetryDelayMs: 10,
    } as unknown as Config;

    processor = new RefundProcessor({
      pool: mockPool,
      swapRepo: mockSwapRepo,
      txRepo: mockTxRepo,
      paymentSender: mockPaymentSender,
      escrowAddress: '@escrow',
      config: mockConfig,
    });
  });

  describe('processTimeout()', () => {
    it('should successfully process timeout refund when swap in PARTIAL_DEPOSIT state', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.PARTIAL_DEPOSIT });
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap) // PARTIAL_DEPOSIT → TIMED_OUT
        .mockResolvedValueOnce(refundingSwap) // TIMED_OUT → REFUNDING
        .mockResolvedValueOnce(refundedSwap); // REFUNDING → REFUNDED
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockSwapRepo.findBySwapIdForUpdate).toHaveBeenCalledWith(swapId, mockClient);
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should log warning and return when swap not found', async () => {
      const swapId = 'a'.repeat(64);

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(null);

      await processor.processTimeout(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
      expect(mockSwapRepo.updateState).not.toHaveBeenCalled();
    });

    it('should skip when swap not in PARTIAL_DEPOSIT state', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.ANNOUNCED });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);

      await processor.processTimeout(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockSwapRepo.updateState).not.toHaveBeenCalled();
    });

    it('should skip when optimistic lock conflict during PARTIAL_DEPOSIT → TIMED_OUT transition', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.PARTIAL_DEPOSIT });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(null); // Lock conflict

      await processor.processTimeout(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });

    it('should skip when optimistic lock conflict during TIMED_OUT → REFUNDING transition', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.PARTIAL_DEPOSIT });
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap) // PARTIAL_DEPOSIT → TIMED_OUT succeeds
        .mockResolvedValueOnce(null); // TIMED_OUT → REFUNDING fails

      await processor.processTimeout(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });

    it('should refund only Party A when only Party A deposited', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({
        state: SwapState.PARTIAL_DEPOSIT,
        party_a_deposited: '1000',
        party_b_deposited: '0',
      });
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      // Verify refund to Party A
      const paymentCalls = vi.mocked(mockPaymentSender.send).mock.calls;
      expect(paymentCalls).toContainEqual(
        [expect.objectContaining({
          recipient: '@alice',
          amount: '1000',
          coinId: 'USD',
        })],
      );

      // Verify no refund to Party B
      const bobPayments = paymentCalls.filter(call => call[0].recipient === '@bob');
      expect(bobPayments).toHaveLength(0);
    });

    it('should refund only Party B when only Party B deposited', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({
        state: SwapState.PARTIAL_DEPOSIT,
        party_a_deposited: '0',
        party_b_deposited: '900',
      });
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      // Verify refund to Party B
      const paymentCalls = vi.mocked(mockPaymentSender.send).mock.calls;
      expect(paymentCalls).toContainEqual(
        [expect.objectContaining({
          recipient: '@bob',
          amount: '900',
          coinId: 'EUR',
        })],
      );

      // Verify no refund to Party A
      const alicePayments = paymentCalls.filter(call => call[0].recipient === '@alice');
      expect(alicePayments).toHaveLength(0);
    });

    it('should refund both parties when both deposited', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({
        state: SwapState.PARTIAL_DEPOSIT,
        party_a_deposited: '1000',
        party_b_deposited: '900',
      });
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      // Verify refunds to both parties
      const paymentCalls = vi.mocked(mockPaymentSender.send).mock.calls;
      expect(paymentCalls).toContainEqual(
        [expect.objectContaining({
          recipient: '@alice',
          amount: '1000',
          coinId: 'USD',
        })],
      );
      expect(paymentCalls).toContainEqual(
        [expect.objectContaining({
          recipient: '@bob',
          amount: '900',
          coinId: 'EUR',
        })],
      );
    });

    it('should be idempotent when refund already sent', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({
        state: SwapState.PARTIAL_DEPOSIT,
        party_a_deposited: '1000',
        party_b_deposited: '0',
      });
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(true); // Already refunded
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      // Payment sender should not be called if refund already exists
      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });

    it('should retry refund on first failure', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send)
        .mockRejectedValueOnce(new Error('Payment failed'))
        .mockResolvedValueOnce(undefined); // Retry succeeds

      await processor.processTimeout(swapId);

      // Should succeed after retry
      expect(mockPaymentSender.send).toHaveBeenCalled();
    });

    it('should use exponential backoff for retries', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockRejectedValue(new Error('Payment failed'));

      const startTime = Date.now();
      await processor.processTimeout(swapId);
      const duration = Date.now() - startTime;

      // With delayMs=10 and maxRetries=3:
      // attempt 1: fail, delay = 10 * 2^0 = 10ms
      // attempt 2: fail, delay = 10 * 2^1 = 20ms
      // attempt 3: fail, no delay
      // Total minimum delay: ~30ms
      expect(duration).toBeGreaterThanOrEqual(20);
    });

    it('should mark swap as FAILED after all retries exhausted', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValue(null as any);
      // markFailed calls findBySwapId — return REFUNDING so it can transition to FAILED
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(refundingSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockRejectedValue(new Error('Payment failed'));

      await processor.processTimeout(swapId);

      // After all retries, should call updateState to mark as FAILED
      const failedCalls = vi.mocked(mockSwapRepo.updateState).mock.calls.filter(call =>
        call[1] === SwapState.FAILED,
      );
      expect(failedCalls.length).toBeGreaterThan(0);
    });

    it('should handle markFailed gracefully when swap not found', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null); // Not found
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockRejectedValue(new Error('Payment failed'));

      // Should not throw
      await expect(processor.processTimeout(swapId)).resolves.not.toThrow();
    });

    it('should transition to REFUNDED after successful refunds', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      // Should transition to REFUNDED
      const refundedCalls = vi.mocked(mockSwapRepo.updateState).mock.calls.filter(call =>
        call[1] === SwapState.REFUNDED,
      );
      expect(refundedCalls.length).toBeGreaterThan(0);
    });

    it('should include completed_at timestamp when transitioning to REFUNDED', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      // Check that updateState was called with completed_at
      const refundedCalls = vi.mocked(mockSwapRepo.updateState).mock.calls.filter(call =>
        call[1] === SwapState.REFUNDED,
      );
      expect(refundedCalls.length).toBeGreaterThan(0);
      expect(refundedCalls[0][3]).toHaveProperty('completed_at');
    });

    it('should release database client on success', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should release database client on failure', async () => {
      const swapId = 'a'.repeat(64);

      vi.mocked(mockClient.query).mockRejectedValue(new Error('DB error'));
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockRejectedValue(new Error('DB error'));

      try {
        await processor.processTimeout(swapId);
      } catch {
        // Expected error
      }

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should use transaction with BEGIN and COMMIT for state changes', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const timedOutSwap = createSwapRow({ state: SwapState.TIMED_OUT, version: 2 });
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const freshSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(timedOutSwap)
        .mockResolvedValueOnce(refundingSwap)
        .mockResolvedValueOnce(refundedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.processTimeout(swapId);

      const queryCallArgs = vi.mocked(mockClient.query).mock.calls.map(call => call[0]);
      expect(queryCallArgs).toContain('BEGIN');
      expect(queryCallArgs).toContain('COMMIT');
    });
  });

  describe('retryRefund()', () => {
    it('should refund swap in REFUNDING state', async () => {
      const swapId = 'a'.repeat(64);
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(refundingSwap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(refundedSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.retryRefund(swapId);

      // Should transition to REFUNDED
      const refundedCalls = vi.mocked(mockSwapRepo.updateState).mock.calls.filter(call =>
        call[1] === SwapState.REFUNDED,
      );
      expect(refundedCalls.length).toBeGreaterThan(0);
    });

    it('should skip when swap not in REFUNDING state', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.ANNOUNCED });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swap);

      await processor.retryRefund(swapId);

      expect(mockPaymentSender.send).not.toHaveBeenCalled();
      expect(mockSwapRepo.updateState).not.toHaveBeenCalled();
    });

    it('should skip when swap not found', async () => {
      const swapId = 'a'.repeat(64);

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);

      await processor.retryRefund(swapId);

      expect(mockPaymentSender.send).not.toHaveBeenCalled();
      expect(mockSwapRepo.updateState).not.toHaveBeenCalled();
    });

    it('should perform refund retry for REFUNDING state', async () => {
      const swapId = 'a'.repeat(64);
      const refundingSwap = createSwapRow({
        state: SwapState.REFUNDING,
        version: 3,
        party_a_deposited: '1000',
        party_b_deposited: '900',
      });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(refundingSwap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(refundedSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send)
        .mockRejectedValueOnce(new Error('First attempt failed'))
        .mockResolvedValue(undefined); // Retry succeeds

      await processor.retryRefund(swapId);

      // Should still succeed after retry
      expect(mockPaymentSender.send).toHaveBeenCalled();
    });

    it('should mark as FAILED when retry retries exhausted', async () => {
      const swapId = 'a'.repeat(64);
      const refundingSwap = createSwapRow({ state: SwapState.REFUNDING, version: 3 });

      // First call from retryRefund, subsequent calls from markFailed — always return REFUNDING
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(refundingSwap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(null as any);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockRejectedValue(new Error('Payment failed'));

      await processor.retryRefund(swapId);

      // Should mark as FAILED after all retries exhausted
      const failedCalls = vi.mocked(mockSwapRepo.updateState).mock.calls.filter(call =>
        call[1] === SwapState.FAILED,
      );
      expect(failedCalls.length).toBeGreaterThan(0);
    });

    it('should skip COMPLETED state on retry', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.COMPLETED });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swap);

      await processor.retryRefund(swapId);

      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });

    it('should skip PARTIAL_DEPOSIT state on retry', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.PARTIAL_DEPOSIT });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swap);

      await processor.retryRefund(swapId);

      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });

    it('should skip TIMED_OUT state on retry', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.TIMED_OUT });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swap);

      await processor.retryRefund(swapId);

      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });

    it('should refund both parties on retry', async () => {
      const swapId = 'a'.repeat(64);
      const refundingSwap = createSwapRow({
        state: SwapState.REFUNDING,
        party_a_deposited: '1000',
        party_b_deposited: '900',
      });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(refundingSwap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(refundedSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.retryRefund(swapId);

      // Verify refunds to both parties
      const paymentCalls = vi.mocked(mockPaymentSender.send).mock.calls;
      expect(paymentCalls).toContainEqual(
        [expect.objectContaining({
          recipient: '@alice',
          amount: '1000',
          coinId: 'USD',
        })],
      );
      expect(paymentCalls).toContainEqual(
        [expect.objectContaining({
          recipient: '@bob',
          amount: '900',
          coinId: 'EUR',
        })],
      );
    });

    it('should be idempotent on retry when refund already sent', async () => {
      const swapId = 'a'.repeat(64);
      const refundingSwap = createSwapRow({
        state: SwapState.REFUNDING,
        party_a_deposited: '1000',
      });
      const refundedSwap = createSwapRow({ state: SwapState.REFUNDED, version: 4 });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(refundingSwap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(refundedSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(true); // Already refunded
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.retryRefund(swapId);

      // Payment sender should not be called if refund already exists
      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });
  });
});
