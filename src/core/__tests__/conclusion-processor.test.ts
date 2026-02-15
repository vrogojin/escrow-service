import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { ConclusionProcessor } from '../conclusion-processor.js';
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
  state: SwapState.READY_TO_CONCLUDE,
  party_a_deposited: '1000',
  party_b_deposited: '900',
  party_a_coin_id: 'USD',
  party_b_coin_id: 'EUR',
  created_at: new Date(),
  first_deposit_at: new Date(),
  timeout_at: new Date(Date.now() + 3600000),
  completed_at: null,
  error_message: null,
  version: 1,
  ...overrides,
});

describe('ConclusionProcessor', () => {
  let mockPool: Pool;
  let mockClient: PoolClient;
  let mockSwapRepo: SwapRepository;
  let mockTxRepo: TransactionRepository;
  let mockPaymentSender: PaymentSender;
  let mockConfig: Config;
  let processor: ConclusionProcessor;

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

    processor = new ConclusionProcessor({
      pool: mockPool,
      swapRepo: mockSwapRepo,
      txRepo: mockTxRepo,
      paymentSender: mockPaymentSender,
      escrowAddress: '@escrow',
      config: mockConfig,
    });
  });

  describe('conclude()', () => {
    it('should successfully conclude a swap in READY_TO_CONCLUDE state', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3, completed_at: new Date() });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockSwapRepo.findBySwapIdForUpdate).toHaveBeenCalledWith(swapId, mockClient);
      expect(mockSwapRepo.updateState).toHaveBeenCalledWith(
        swapId,
        SwapState.CONCLUDING,
        swap.version,
        {},
        mockClient,
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should log warning and return when swap not found', async () => {
      const swapId = 'a'.repeat(64);

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(null);

      await processor.conclude(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
      expect(mockSwapRepo.updateState).not.toHaveBeenCalled();
    });

    it('should skip when swap not in READY_TO_CONCLUDE state', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ state: SwapState.ANNOUNCED });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);

      await processor.conclude(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockSwapRepo.updateState).not.toHaveBeenCalled();
    });

    it('should skip when optimistic lock conflict during state transition', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(null); // Lock conflict

      await processor.conclude(swapId);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });

    it('should perform cross-payment to Party A with Party B\'s currency and value', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      // Verify cross-payment to Party A (Party B's currency/value)
      const paymentCalls = vi.mocked(mockPaymentSender.send).mock.calls;
      expect(paymentCalls).toContainEqual(
        [expect.objectContaining({
          recipient: '@alice',
          amount: '900', // Party B's value
          coinId: 'EUR', // Party B's currency
        })],
      );
    });

    it('should perform cross-payment to Party B with Party A\'s currency and value', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      // Verify cross-payment to Party B (Party A's currency/value)
      const paymentCalls = vi.mocked(mockPaymentSender.send).mock.calls;
      expect(paymentCalls).toContainEqual(
        [expect.objectContaining({
          recipient: '@bob',
          amount: '1000', // Party A's value
          coinId: 'USD', // Party A's currency
        })],
      );
    });

    it('should be idempotent when cross-payment already sent', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(true); // Already sent
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      // Payment sender should not be called if payment already exists
      expect(mockPaymentSender.send).not.toHaveBeenCalled();
    });

    it('should return surplus when party A overpaid', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ party_a_deposited: '1500' }); // Overpaid by 500
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      // Should send surplus return to Party A
      const surplusCall = vi.mocked(mockPaymentSender.send).mock.calls.find(call =>
        call[0].amount === '500' && call[0].recipient === '@alice',
      );
      expect(surplusCall).toBeDefined();
    });

    it('should return surplus when party B overpaid', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({ party_b_deposited: '1200' }); // Overpaid by 300
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      // Should send surplus return to Party B
      const surplusCall = vi.mocked(mockPaymentSender.send).mock.calls.find(call =>
        call[0].amount === '300' && call[0].recipient === '@bob',
      );
      expect(surplusCall).toBeDefined();
    });

    it('should not return surplus when exact amount deposited', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow({
        party_a_deposited: '1000',
        party_b_deposited: '900',
      });
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      // Should only have cross-payments, no surplus returns
      const calls = vi.mocked(mockTxRepo.create).mock.calls;
      const surplusTransactions = calls.filter(call => call[0].type === 'SURPLUS_RETURN');
      expect(surplusTransactions).toHaveLength(0);
    });

    it('should retry cross-payment on first failure', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send)
        .mockRejectedValueOnce(new Error('Payment failed'))
        .mockResolvedValueOnce(undefined); // Retry succeeds

      await processor.conclude(swapId);

      // Should succeed after retry
      expect(mockPaymentSender.send).toHaveBeenCalled();
    });

    it('should use exponential backoff for retries', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockRejectedValue(new Error('Payment failed'));

      const startTime = Date.now();
      await processor.conclude(swapId);
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
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const concludingSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValue(null as any);
      // markFailed calls findBySwapId — return CONCLUDING so it can transition to FAILED
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(concludingSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockRejectedValue(new Error('Payment failed'));

      await processor.conclude(swapId);

      // After all retries, should call updateState to mark as FAILED
      const failedCalls = vi.mocked(mockSwapRepo.updateState).mock.calls.filter(call =>
        call[1] === SwapState.FAILED,
      );
      expect(failedCalls.length).toBeGreaterThan(0);
    });

    it('should handle markFailed gracefully when swap not found', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null); // Not found
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockRejectedValue(new Error('Payment failed'));

      // Should not throw
      await expect(processor.conclude(swapId)).resolves.not.toThrow();
    });

    it('should transition to COMPLETED after successful cross-payments', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(updatedSwap) // READY_TO_CONCLUDE → CONCLUDING
        .mockResolvedValueOnce(completedSwap); // CONCLUDING → COMPLETED
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      // Should transition to COMPLETED
      const completedCalls = vi.mocked(mockSwapRepo.updateState).mock.calls.filter(call =>
        call[1] === SwapState.COMPLETED,
      );
      expect(completedCalls.length).toBeGreaterThan(0);
    });

    it('should release database client on success', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should release database client on failure', async () => {
      const swapId = 'a'.repeat(64);

      vi.mocked(mockClient.query).mockRejectedValue(new Error('DB error'));
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockRejectedValue(new Error('DB error'));

      try {
        await processor.conclude(swapId);
      } catch {
        // Expected error
      }

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should use transaction with BEGIN and COMMIT for state changes', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValueOnce(updatedSwap).mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      const queryCallArgs = vi.mocked(mockClient.query).mock.calls.map(call => call[0]);
      expect(queryCallArgs).toContain('BEGIN');
      expect(queryCallArgs).toContain('COMMIT');
    });

    it('should include completed_at timestamp when transitioning to COMPLETED', async () => {
      const swapId = 'a'.repeat(64);
      const swap = createSwapRow();
      const updatedSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const freshSwap = createSwapRow({ state: SwapState.CONCLUDING, version: 2 });
      const completedSwap = createSwapRow({ state: SwapState.COMPLETED, version: 3 });

      vi.mocked(mockClient.query).mockResolvedValue({} as any);
      vi.mocked(mockSwapRepo.findBySwapIdForUpdate).mockResolvedValue(swap);
      vi.mocked(mockSwapRepo.updateState)
        .mockResolvedValueOnce(updatedSwap)
        .mockResolvedValueOnce(completedSwap);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(freshSwap);
      vi.mocked(mockTxRepo.existsSuccessful).mockResolvedValue(false);
      vi.mocked(mockTxRepo.create).mockResolvedValue({ id: 'tx-1' } as any);
      vi.mocked(mockPaymentSender.send).mockResolvedValue(undefined);

      await processor.conclude(swapId);

      // Check that updateState was called with completed_at
      const completedCalls = vi.mocked(mockSwapRepo.updateState).mock.calls.filter(call =>
        call[1] === SwapState.COMPLETED,
      );
      expect(completedCalls.length).toBeGreaterThan(0);
      expect(completedCalls[0][3]).toHaveProperty('completed_at');
    });
  });
});
