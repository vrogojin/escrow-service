import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import type { IncomingTransfer, Token } from '@unicitylabs/sphere-sdk';
import { PaymentProcessor } from '../payment-processor.js';
import { SwapState } from '../state-machine.js';
import type { SwapCaseRow } from '../../storage/repositories/swap.repository.js';
import { SwapRepository } from '../../storage/repositories/swap.repository.js';
import { DepositRepository } from '../../storage/repositories/deposit.repository.js';
import { TransactionRepository } from '../../storage/repositories/transaction.repository.js';
import type { PaymentSender } from '../../sphere/payment-sender.js';

// Mock the redis module to capture acquireLock
vi.mock('../../storage/redis.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
}));

import { acquireLock } from '../../storage/redis.js';

// Ensure vi is in global scope for globals: true
declare global {
  namespace Vi {
    interface Matchers<R> {
      toEqual(expected: any): R;
      toBeCalled(): R;
      toHaveBeenCalled(): R;
      toHaveBeenCalledWith(...args: any[]): R;
      toHaveBeenCalledTimes(count: number): R;
    }
  }
}

const mockAcquireLock = acquireLock as ReturnType<typeof vi.fn>;

describe('PaymentProcessor', () => {
  let mockPool: Pool;
  let mockClient: PoolClient;
  let mockRedis: Redis;
  let mockSwapRepo: SwapRepository;
  let mockDepositRepo: DepositRepository;
  let mockTxRepo: TransactionRepository;
  let mockPaymentSender: PaymentSender;
  let onReadyToConclude: ReturnType<typeof vi.fn>;
  let onFirstDeposit: ReturnType<typeof vi.fn>;
  let processor: PaymentProcessor;

  const createMockClient = () => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  });

  const createMockPool = () => {
    const client = createMockClient();
    return {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;
  };

  const createSwapManifest = (overrides = {}) => ({
    swap_id: 'a'.repeat(64),
    party_a_address: '@alice',
    party_b_address: '@bob',
    party_a_currency_to_change: 'USD',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'EUR',
    party_b_value_to_change: '900',
    timeout: 3600,
    ...overrides,
  });

  const createSwapRow = (overrides = {}): SwapCaseRow => ({
    id: 'uuid-1',
    swap_id: 'a'.repeat(64),
    manifest: createSwapManifest(),
    state: SwapState.ANNOUNCED,
    party_a_deposited: '0',
    party_b_deposited: '0',
    party_a_coin_id: null,
    party_b_coin_id: null,
    created_at: new Date(),
    first_deposit_at: null,
    timeout_at: null,
    completed_at: null,
    error_message: null,
    version: 1,
    ...overrides,
  });

  const createIncomingTransfer = (overrides: Partial<IncomingTransfer> = {}): IncomingTransfer => ({
    id: 'transfer-1',
    senderPubkey: 'pubkey-alice',
    senderNametag: 'alice',
    tokens: [
      {
        id: 'token-1',
        coinId: 'USD',
        amount: '1000',
        status: 'pending',
      } as Token,
    ],
    memo: 'a'.repeat(64),
    receivedAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    mockRedis = {} as Redis;
    mockSwapRepo = {
      findBySwapIdForUpdate: vi.fn(),
      updateState: vi.fn(),
      updateDeposits: vi.fn(),
    } as any;

    mockDepositRepo = {
      findByTransactionId: vi.fn(),
      create: vi.fn(),
    } as any;

    mockTxRepo = {
      create: vi.fn(),
    } as any;

    mockPaymentSender = {
      send: vi.fn(),
    };

    onReadyToConclude = vi.fn();
    onFirstDeposit = vi.fn();

    mockClient = createMockClient();
    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as Pool;

    mockAcquireLock.mockResolvedValue(vi.fn().mockResolvedValue(undefined));

    processor = new PaymentProcessor({
      pool: mockPool,
      redis: mockRedis,
      swapRepo: mockSwapRepo,
      depositRepo: mockDepositRepo,
      txRepo: mockTxRepo,
      paymentSender: mockPaymentSender,
      escrowAddress: '@escrow',
      onReadyToConclude,
      onFirstDeposit,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Valid deposit flow', () => {
    it('should record a valid deposit and update state to PARTIAL_DEPOSIT', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockDepositRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          swap_id: 'a'.repeat(64),
          transaction_id: 'transfer-1_USD',
          sender: '@alice',
          amount: '1000',
          coin_id: 'USD',
          matched_party: 'A',
        }),
        mockClient,
      );

      expect(mockSwapRepo.updateState).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(onFirstDeposit).toHaveBeenCalledWith('a'.repeat(64), 3600);
    });

    it('should transition to READY_TO_CONCLUDE when both parties deposit', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({
        manifest,
        party_a_deposited: '1000',
        party_b_deposited: '0',
      });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'bob',
        tokens: [{ id: 'token-1', coinId: 'EUR', amount: '900', status: 'pending' } as Token],
        memo: 'a'.repeat(64),
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.updateState).toHaveBeenCalledWith(
        'a'.repeat(64),
        SwapState.READY_TO_CONCLUDE,
        expect.any(Number),
        expect.any(Object),
        mockClient,
      );

      expect(onReadyToConclude).toHaveBeenCalledWith('a'.repeat(64));
    });

    it('should transition to READY_TO_CONCLUDE when both deposits arrive in same batch', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn()
        .mockResolvedValueOnce(swapRow)
        .mockResolvedValueOnce({
          ...swapRow,
          party_a_deposited: '1000',
        });
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      // First transfer from Alice
      const transferA = createIncomingTransfer({
        id: 'transfer-1',
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '1000', status: 'pending' } as Token],
      });
      await processor.processIncomingTransfer(transferA);

      // Second transfer from Bob
      const transferB = createIncomingTransfer({
        id: 'transfer-2',
        senderNametag: 'bob',
        tokens: [{ id: 'token-2', coinId: 'EUR', amount: '900', status: 'pending' } as Token],
      });
      await processor.processIncomingTransfer(transferB);

      expect(onReadyToConclude).toHaveBeenCalled();
    });
  });

  describe('Invalid memo handling', () => {
    it('should bounce back payment with INVALID_MEMO when memo is empty', async () => {
      const transfer = createIncomingTransfer({
        memo: '',
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockTxRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'BOUNCEBACK',
          direction: 'OUTGOING',
          swap_id: 'UNMATCHED',
          memo: expect.stringContaining('INVALID_MEMO'),
        }),
      );

      expect(mockPaymentSender.send).toHaveBeenCalledWith({
        recipient: '@alice',
        amount: '1000',
        coinId: 'USD',
        memo: expect.stringContaining('INVALID_MEMO'),
      });

      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    });

    it('should bounce back payment with INVALID_MEMO when memo has no 64-hex substring', async () => {
      const transfer = createIncomingTransfer({
        memo: 'not-a-valid-swap-id',
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: expect.stringContaining('INVALID_MEMO'),
        }),
      );
    });

    it('should extract swap_id from memo containing 64-hex characters', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        memo: `please process swap ${('a'.repeat(64))} thanks`,
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.findBySwapIdForUpdate).toHaveBeenCalledWith(
        'a'.repeat(64),
        mockClient,
      );
    });
  });

  describe('Swap not found', () => {
    it('should bounce back payment with SWAP_NOT_FOUND', async () => {
      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(null);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: expect.stringContaining('SWAP_NOT_FOUND'),
        }),
      );
    });
  });

  describe('Swap closed states', () => {
    it('should bounce back payment with SWAP_CLOSED when swap is COMPLETED', async () => {
      const swapRow = createSwapRow({ state: SwapState.COMPLETED });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: expect.stringContaining('SWAP_CLOSED'),
        }),
      );
    });

    it('should bounce back payment with SWAP_CLOSED when swap is REFUNDED', async () => {
      const swapRow = createSwapRow({ state: SwapState.REFUNDED });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: expect.stringContaining('SWAP_CLOSED'),
        }),
      );
    });

    it('should accept deposits when swap is in PARTIAL_DEPOSIT state', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({
        manifest,
        state: SwapState.PARTIAL_DEPOSIT,
        party_a_deposited: '500',
      });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateDeposits = vi.fn();

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '500', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.updateDeposits).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
  });

  describe('Unknown sender handling', () => {
    it('should bounce back payment when sender is neither party A nor B', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'charlie',
        senderPubkey: 'pubkey-charlie',
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: expect.stringContaining('UNKNOWN_SENDER'),
        }),
      );
    });

    it('should match sender by nametag when senderNametag is provided', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockDepositRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          matched_party: 'A',
        }),
        mockClient,
      );
    });

    it('should match sender by DIRECT pubkey when senderNametag is not provided', async () => {
      const manifest = createSwapManifest({
        party_a_address: 'DIRECT://pubkey-alice',
      });
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderPubkey: 'pubkey-alice',
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockDepositRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          matched_party: 'A',
        }),
        mockClient,
      );
    });
  });

  describe('Wrong currency handling', () => {
    it('should bounce back payment with WRONG_CURRENCY', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'EUR', amount: '1000', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: expect.stringContaining('WRONG_CURRENCY'),
        }),
      );
    });
  });

  describe('Already covered handling', () => {
    it('should bounce back payment with ALREADY_COVERED when party A has fully deposited', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({
        manifest,
        party_a_deposited: '1000',
      });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '500', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: expect.stringContaining('ALREADY_COVERED'),
        }),
      );
    });

    it('should bounce back payment with ALREADY_COVERED when party B has fully deposited', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({
        manifest,
        party_b_deposited: '900',
      });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'bob',
        tokens: [{ id: 'token-1', coinId: 'EUR', amount: '500', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: expect.stringContaining('ALREADY_COVERED'),
        }),
      );
    });
  });

  describe('Duplicate transaction handling', () => {
    it('should skip processing duplicate transaction without error or bounceback', async () => {
      const existingDeposit = {
        id: 'deposit-1',
        swap_id: 'a'.repeat(64),
        transaction_id: 'transfer-1_USD',
        sender: '@alice',
        amount: '1000',
        coin_id: 'USD',
        memo: 'a'.repeat(64),
        matched_party: 'A' as const,
        status: 'processed',
        received_at: new Date(),
        processed_at: new Date(),
      };

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(existingDeposit);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockPaymentSender.send).not.toHaveBeenCalled();
      expect(onFirstDeposit).not.toHaveBeenCalled();
      expect(onReadyToConclude).not.toHaveBeenCalled();
    });
  });

  describe('Overpayment handling', () => {
    it('should record surplus return when party overpays', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '1500', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      // Surplus should be calculated and sent
      expect(mockPaymentSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: '500',
          memo: expect.stringContaining('Surplus return'),
        }),
      );
    });

    it('should store surplus return transaction', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '1500', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      const surplusCreateCall = mockTxRepo.create.mock.calls.find((call) =>
        call[0].type === 'SURPLUS_RETURN',
      );

      expect(surplusCreateCall).toBeTruthy();
      expect(surplusCreateCall[0]).toMatchObject({
        type: 'SURPLUS_RETURN',
        direction: 'OUTGOING',
        amount: '500',
        coin_id: 'USD',
      });
    });

    it('should not trigger callbacks when deposit does not complete swap due to overpayment', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({
        manifest,
        state: SwapState.PARTIAL_DEPOSIT,
        party_a_deposited: '500',
      });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateDeposits = vi.fn();

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '1000', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.updateDeposits).toHaveBeenCalled();
      expect(onFirstDeposit).not.toHaveBeenCalled();
      expect(onReadyToConclude).not.toHaveBeenCalled();
    });
  });

  describe('Lock acquisition', () => {
    it('should return without processing if lock cannot be acquired', async () => {
      mockAcquireLock.mockResolvedValue(null);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(mockPaymentSender.send).not.toHaveBeenCalled();
      expect(onFirstDeposit).not.toHaveBeenCalled();
    });

    it('should acquire lock with swap-specific key', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockAcquireLock).toHaveBeenCalledWith(
        mockRedis,
        `deposit:${('a'.repeat(64))}`,
        5000,
      );
    });

    it('should release lock after processing', async () => {
      const mockReleaseLock = vi.fn().mockResolvedValue(undefined);
      mockAcquireLock.mockResolvedValue(mockReleaseLock);

      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockReleaseLock).toHaveBeenCalled();
    });
  });

  describe('Multiple tokens aggregation', () => {
    it('should aggregate multiple tokens by coinId', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        id: 'transfer-1',
        tokens: [
          { id: 'token-1', coinId: 'USD', amount: '600', status: 'pending' } as Token,
          { id: 'token-2', coinId: 'USD', amount: '400', status: 'pending' } as Token,
        ],
      });

      await processor.processIncomingTransfer(transfer);

      // Should process as single 1000 USD deposit, not two separate deposits
      expect(mockDepositRepo.create).toHaveBeenCalledTimes(1);
      expect(mockDepositRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: '1000',
          coin_id: 'USD',
        }),
        mockClient,
      );
    });

    it('should process different coinId tokens as separate processDeposit calls', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        id: 'transfer-1',
        tokens: [
          { id: 'token-1', coinId: 'USD', amount: '600', status: 'pending' } as Token,
          { id: 'token-2', coinId: 'EUR', amount: '100', status: 'pending' } as Token,
        ],
      });

      await processor.processIncomingTransfer(transfer);

      // USD matches party A's currency → deposit created
      // EUR does NOT match party A's currency → bounced back (WRONG_CURRENCY)
      expect(mockDepositRepo.create).toHaveBeenCalledTimes(1);

      const usdCall = mockDepositRepo.create.mock.calls.find((call) => call[0].coin_id === 'USD');
      expect(usdCall).toBeTruthy();
      expect(usdCall![0].amount).toBe('600');
    });
  });

  describe('Transaction logging', () => {
    it('should log deposit transaction', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      const depositLog = mockTxRepo.create.mock.calls.find((call) => call[0].type === 'DEPOSIT');

      expect(depositLog).toBeTruthy();
      expect(depositLog[0]).toMatchObject({
        type: 'DEPOSIT',
        direction: 'INCOMING',
        sender: '@alice',
        recipient: '@escrow',
        amount: '1000',
        coin_id: 'USD',
        status: 'CONFIRMED',
      });
    });

    it('should log bounceback transaction with reason', async () => {
      const transfer = createIncomingTransfer({
        memo: 'invalid',
      });

      await processor.processIncomingTransfer(transfer);

      const bounceLog = mockTxRepo.create.mock.calls.find((call) => call[0].type === 'BOUNCEBACK');

      expect(bounceLog).toBeTruthy();
      expect(bounceLog[0]).toMatchObject({
        type: 'BOUNCEBACK',
        direction: 'OUTGOING',
        memo: expect.stringContaining('INVALID_MEMO'),
        status: 'PENDING',
      });
    });
  });

  describe('Database transaction handling', () => {
    it('should rollback transaction on swap not found', async () => {
      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(null);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should rollback transaction on wrong currency', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'EUR', amount: '1000', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should commit transaction on successful deposit', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should release client after processing', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('State transitions', () => {
    it('should set first_deposit_at and timeout_at when transitioning to PARTIAL_DEPOSIT', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.updateState).toHaveBeenCalledWith(
        'a'.repeat(64),
        SwapState.PARTIAL_DEPOSIT,
        1,
        expect.objectContaining({
          first_deposit_at: expect.any(Date),
          timeout_at: expect.any(Date),
        }),
        mockClient,
      );
    });

    it('should calculate timeout_at relative to manifest timeout', async () => {
      const manifest = createSwapManifest({ timeout: 7200 });
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const before = Date.now();
      const transfer = createIncomingTransfer();
      await processor.processIncomingTransfer(transfer);
      const after = Date.now();

      const updateCall = mockSwapRepo.updateState.mock.calls[0];
      const timeoutAt = updateCall[3].timeout_at.getTime();

      expect(timeoutAt).toBeGreaterThanOrEqual(before + 7200 * 1000);
      expect(timeoutAt).toBeLessThanOrEqual(after + 7200 * 1000);
    });

    it('should update party_a_coin_id when party A deposits', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '1000', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.updateState).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({
          party_a_coin_id: 'USD',
        }),
        mockClient,
      );
    });

    it('should update party_b_coin_id when party B deposits', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'bob',
        tokens: [{ id: 'token-1', coinId: 'EUR', amount: '900', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.updateState).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({
          party_b_coin_id: 'EUR',
        }),
        mockClient,
      );
    });
  });

  describe('Partial deposit state continuation', () => {
    it('should not trigger callbacks when adding deposit to existing PARTIAL_DEPOSIT', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({
        manifest,
        state: SwapState.PARTIAL_DEPOSIT,
        party_a_deposited: '500',
      });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateDeposits = vi.fn();

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '500', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(onFirstDeposit).not.toHaveBeenCalled();
      expect(onReadyToConclude).not.toHaveBeenCalled();
    });

    it('should use updateDeposits instead of updateState for additional PARTIAL_DEPOSIT deposits', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({
        manifest,
        state: SwapState.PARTIAL_DEPOSIT,
        party_a_deposited: '500',
      });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateDeposits = vi.fn();

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '500', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.updateDeposits).toHaveBeenCalledWith(
        'a'.repeat(64),
        expect.objectContaining({
          party_a_deposited: '1000',
        }),
        1,
        mockClient,
      );
    });
  });

  describe('Address format variations', () => {
    it('should match party A by nametag with @ prefix', async () => {
      const manifest = createSwapManifest({
        party_a_address: '@alice',
      });
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        senderNametag: 'alice',
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockDepositRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ matched_party: 'A' }),
        mockClient,
      );
    });

    it('should handle memo trimming and case normalization', async () => {
      const manifest = createSwapManifest();
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        memo: `  ${('A'.repeat(64))}  `,
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockSwapRepo.findBySwapIdForUpdate).toHaveBeenCalledWith(
        'a'.repeat(64),
        mockClient,
      );
    });
  });

  describe('Edge cases', () => {
    it('should bounce back deposit when party expected amount is zero (already covered)', async () => {
      const manifest = createSwapManifest({
        party_a_value_to_change: '0',
      });
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);

      const transfer = createIncomingTransfer({
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '1', status: 'pending' } as Token],
      });

      await processor.processIncomingTransfer(transfer);

      // Party A's expected amount is 0, current deposited is 0, so 0 >= 0 → ALREADY_COVERED
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockPaymentSender.send).toHaveBeenCalled();
      expect(mockDepositRepo.create).not.toHaveBeenCalled();
    });

    it('should handle large amounts without overflow', async () => {
      const largeAmount = '999999999999999999999999999999';
      const manifest = createSwapManifest({
        party_a_value_to_change: largeAmount,
      });
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateDeposits = vi.fn();

      const transfer = createIncomingTransfer({
        tokens: [
          {
            id: 'token-1',
            coinId: 'USD',
            amount: '999999999999999999999999999998',
            status: 'pending',
          } as Token,
        ],
      });

      await processor.processIncomingTransfer(transfer);

      expect(mockDepositRepo.create).toHaveBeenCalled();
    });

    it('should process transfer with undefined senderNametag', async () => {
      const manifest = createSwapManifest({
        party_a_address: 'DIRECT://pubkey-alice',
      });
      const swapRow = createSwapRow({ manifest });

      mockDepositRepo.findByTransactionId = vi.fn().mockResolvedValue(null);
      mockSwapRepo.findBySwapIdForUpdate = vi.fn().mockResolvedValue(swapRow);
      mockSwapRepo.updateState = vi.fn().mockResolvedValue(swapRow);

      const transfer: IncomingTransfer = {
        id: 'transfer-1',
        senderPubkey: 'pubkey-alice',
        tokens: [{ id: 'token-1', coinId: 'USD', amount: '1000', status: 'pending' } as Token],
        memo: 'a'.repeat(64),
        receivedAt: Date.now(),
      };

      await processor.processIncomingTransfer(transfer);

      expect(mockDepositRepo.create).toHaveBeenCalled();
    });
  });
});
