import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { SwapManager, ManifestValidationError, SwapLimitError, type AnnounceResult } from '../swap-manager.js';
import type { SwapRepository, SwapCaseRow } from '../../storage/repositories/swap.repository.js';
import type { DepositRepository } from '../../storage/repositories/deposit.repository.js';
import { SwapState } from '../state-machine.js';
import { computeSwapId } from '../../utils/hash.js';
import type { Config } from '../../config.js';
import type { SwapManifest } from '../manifest-validator.js';

/**
 * Creates a minimal valid config for testing
 */
function makeConfig(overrides?: Partial<Config>): Config {
  return {
    port: 3000,
    nodeEnv: 'test',
    logLevel: 'silent',
    databaseUrl: 'postgresql://localhost:5432/test',
    redisUrl: 'redis://localhost:6379',
    sphereWalletPath: './.sphere-escrow',
    sphereAddressIndex: 0,
    sphereNetwork: 'testnet',
    swapTimeoutMin: 60,
    swapTimeoutMax: 86400,
    swapTimeoutDefault: 3600,
    paymentRetryMaxAttempts: 3,
    paymentRetryDelayMs: 100,
    rateLimitManifestPerMinute: 10,
    maxPendingSwaps: 10000,
    ...overrides,
  };
}

/**
 * Creates a valid swap manifest for testing
 */
function makeValidManifest(): SwapManifest {
  const fields = {
    party_a_address: 'DIRECT://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    party_b_address: '@bob',
    party_a_currency_to_change: 'USD',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'EUR',
    party_b_value_to_change: '900',
    timeout: 3600,
  };
  return {
    ...fields,
    swap_id: computeSwapId(fields),
  };
}

/**
 * Creates a mock swap case row for testing
 */
function makeSwapCaseRow(manifest: SwapManifest, overrides?: Partial<SwapCaseRow>): SwapCaseRow {
  return {
    id: 'uuid-123',
    swap_id: manifest.swap_id,
    manifest,
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
    version: 0,
    ...overrides,
  };
}

/**
 * Creates a mock swap repository with all methods
 */
function makeSwapRepo(): SwapRepository {
  return {
    create: vi.fn(),
    findBySwapId: vi.fn(),
    findBySwapIdForUpdate: vi.fn(),
    updateState: vi.fn(),
    updateDeposits: vi.fn(),
    updateStateWithLock: vi.fn(),
    findTimedOut: vi.fn(),
    findByState: vi.fn(),
    countByState: vi.fn(),
    countPending: vi.fn(),
  } as unknown as SwapRepository;
}

/**
 * Creates a mock deposit repository with all methods
 */
function makeDepositRepo(): DepositRepository {
  return {
    create: vi.fn(),
    findBySwapId: vi.fn(),
    findBySwapIdForUpdate: vi.fn(),
    findByTransactionId: vi.fn(),
    updateState: vi.fn(),
    updateStateWithLock: vi.fn(),
    findByState: vi.fn(),
  } as unknown as DepositRepository;
}

/**
 * Creates a mock pool
 */
function makePool(): Pool {
  return {} as unknown as Pool;
}

describe('SwapManager', () => {
  let manager: SwapManager;
  let mockSwapRepo: SwapRepository;
  let mockDepositRepo: DepositRepository;
  let mockPool: Pool;
  let config: Config;

  beforeEach(() => {
    mockSwapRepo = makeSwapRepo();
    mockDepositRepo = makeDepositRepo();
    mockPool = makePool();
    config = makeConfig();

    manager = new SwapManager({
      pool: mockPool,
      swapRepo: mockSwapRepo,
      depositRepo: mockDepositRepo,
      config,
    });
  });

  describe('announceSwap', () => {
    it('should create a new swap case with valid manifest', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);
      vi.mocked(mockSwapRepo.create).mockResolvedValue(swapCase);

      const result = await manager.announceSwap(manifest);

      expect(result.swapCase).toEqual(swapCase);
      expect(result.isNew).toBe(true);
      expect(vi.mocked(mockSwapRepo.create)).toHaveBeenCalledWith(manifest);
    });

    it('should return isNew: true for new swap', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);
      vi.mocked(mockSwapRepo.create).mockResolvedValue(swapCase);

      const result = await manager.announceSwap(manifest);

      expect(result.isNew).toBe(true);
    });

    it('should return isNew: false for duplicate swap_id', async () => {
      const manifest = makeValidManifest();
      const existingSwapCase = makeSwapCaseRow(manifest);

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(existingSwapCase);

      const result = await manager.announceSwap(manifest);

      expect(result.isNew).toBe(false);
      expect(result.swapCase).toEqual(existingSwapCase);
    });

    it('should return existing swap case without creating new one', async () => {
      const manifest = makeValidManifest();
      const existingSwapCase = makeSwapCaseRow(manifest);

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(existingSwapCase);

      await manager.announceSwap(manifest);

      expect(vi.mocked(mockSwapRepo.create)).not.toHaveBeenCalled();
    });

    it('should throw ManifestValidationError for invalid manifest', async () => {
      const invalidManifest = {
        swap_id: 'invalid',
        party_a_address: 'invalid',
        party_b_address: 'invalid',
        party_a_currency_to_change: 'USD',
        party_a_value_to_change: '1000',
        party_b_currency_to_change: 'EUR',
        party_b_value_to_change: '900',
        timeout: 3600,
      } as unknown as SwapManifest;

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);

      await expect(manager.announceSwap(invalidManifest)).rejects.toThrow(ManifestValidationError);
    });

    it('should include validation errors in ManifestValidationError', async () => {
      const invalidManifest = {
        swap_id: 'invalid',
        party_a_address: 'invalid',
        party_b_address: '@bob',
        party_a_currency_to_change: 'USD',
        party_a_value_to_change: '1000',
        party_b_currency_to_change: 'EUR',
        party_b_value_to_change: '900',
        timeout: 3600,
      } as unknown as SwapManifest;

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);

      try {
        await manager.announceSwap(invalidManifest);
        expect.fail('Should have thrown ManifestValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ManifestValidationError);
        if (error instanceof ManifestValidationError) {
          expect(error.errors).toBeDefined();
          expect(error.errors.length).toBeGreaterThan(0);
        }
      }
    });

    it('should throw SwapLimitError when maxPendingSwaps reached', async () => {
      const manifest = makeValidManifest();
      const maxPending = 10;
      const configWithLimit = makeConfig({ maxPendingSwaps: maxPending });

      const limitedManager = new SwapManager({
        pool: mockPool,
        swapRepo: mockSwapRepo,
        depositRepo: mockDepositRepo,
        config: configWithLimit,
      });

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(maxPending);

      await expect(limitedManager.announceSwap(manifest)).rejects.toThrow(SwapLimitError);
    });

    it('should include max pending swaps count in SwapLimitError message', async () => {
      const manifest = makeValidManifest();
      const maxPending = 100;
      const configWithLimit = makeConfig({ maxPendingSwaps: maxPending });

      const limitedManager = new SwapManager({
        pool: mockPool,
        swapRepo: mockSwapRepo,
        depositRepo: mockDepositRepo,
        config: configWithLimit,
      });

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(maxPending);

      try {
        await limitedManager.announceSwap(manifest);
        expect.fail('Should have thrown SwapLimitError');
      } catch (error) {
        expect(error).toBeInstanceOf(SwapLimitError);
        if (error instanceof SwapLimitError) {
          expect(error.message).toContain('100');
        }
      }
    });

    it('should allow announcement when pending count is below limit', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);
      const maxPending = 100;
      const configWithLimit = makeConfig({ maxPendingSwaps: maxPending });

      const limitedManager = new SwapManager({
        pool: mockPool,
        swapRepo: mockSwapRepo,
        depositRepo: mockDepositRepo,
        config: configWithLimit,
      });

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(maxPending - 1);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);
      vi.mocked(mockSwapRepo.create).mockResolvedValue(swapCase);

      const result = await limitedManager.announceSwap(manifest);

      expect(result.isNew).toBe(true);
    });

    it('should check for existing swap after validating and checking limit', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);
      vi.mocked(mockSwapRepo.create).mockResolvedValue(swapCase);

      await manager.announceSwap(manifest);

      expect(vi.mocked(mockSwapRepo.findBySwapId)).toHaveBeenCalledWith(manifest.swap_id);
    });

    it('should call countPending before checking for duplicate', async () => {
      const manifest = makeValidManifest();

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);
      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);
      vi.mocked(mockSwapRepo.create).mockResolvedValue(makeSwapCaseRow(manifest));

      await manager.announceSwap(manifest);

      expect(vi.mocked(mockSwapRepo.countPending)).toHaveBeenCalled();
    });

    it('should reject manifest with invalid timeout below minimum', async () => {
      const manifest = makeValidManifest();
      manifest.timeout = 30; // Below swapTimeoutMin of 60

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);

      await expect(manager.announceSwap(manifest)).rejects.toThrow(ManifestValidationError);
    });

    it('should reject manifest with invalid timeout above maximum', async () => {
      const manifest = makeValidManifest();
      manifest.timeout = 100000; // Above swapTimeoutMax of 86400

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);

      await expect(manager.announceSwap(manifest)).rejects.toThrow(ManifestValidationError);
    });
  });

  describe('getSwap', () => {
    it('should return swap case when found', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swapCase);

      const result = await manager.getSwap(manifest.swap_id);

      expect(result).toEqual(swapCase);
    });

    it('should call findBySwapId with correct swap_id', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swapCase);

      await manager.getSwap(manifest.swap_id);

      expect(vi.mocked(mockSwapRepo.findBySwapId)).toHaveBeenCalledWith(manifest.swap_id);
    });

    it('should return null when swap not found', async () => {
      const swapId = computeSwapId({
        party_a_address: 'DIRECT://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        party_b_address: '@bob',
        party_a_currency_to_change: 'USD',
        party_a_value_to_change: '1000',
        party_b_currency_to_change: 'EUR',
        party_b_value_to_change: '900',
        timeout: 3600,
      });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);

      const result = await manager.getSwap(swapId);

      expect(result).toBeNull();
    });

    it('should not throw when swap not found', async () => {
      const swapId = 'nonexistent-swap-id';

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);

      await expect(manager.getSwap(swapId)).resolves.toBeNull();
    });
  });

  describe('markFailed', () => {
    it('should call updateState with FAILED state', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);
      const errorMessage = 'Test error';

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swapCase);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(null);

      await manager.markFailed(manifest.swap_id, errorMessage);

      expect(vi.mocked(mockSwapRepo.updateState)).toHaveBeenCalledWith(
        manifest.swap_id,
        SwapState.FAILED,
        swapCase.version,
        { error_message: errorMessage },
      );
    });

    it('should pass error message to updateState', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);
      const errorMessage = 'Payment processing failed';

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swapCase);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(null);

      await manager.markFailed(manifest.swap_id, errorMessage);

      expect(vi.mocked(mockSwapRepo.updateState)).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        { error_message: errorMessage },
      );
    });

    it('should use current version from swap case', async () => {
      const manifest = makeValidManifest();
      const version = 5;
      const swapCase = makeSwapCaseRow(manifest, { version });

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swapCase);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(null);

      await manager.markFailed(manifest.swap_id, 'error');

      expect(vi.mocked(mockSwapRepo.updateState)).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        version,
        expect.any(Object),
      );
    });

    it('should do nothing when swap not found', async () => {
      const swapId = 'nonexistent-swap-id';

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);

      await manager.markFailed(swapId, 'error');

      expect(vi.mocked(mockSwapRepo.updateState)).not.toHaveBeenCalled();
    });

    it('should not throw when swap not found', async () => {
      const swapId = 'nonexistent-swap-id';

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(null);

      await expect(manager.markFailed(swapId, 'error')).resolves.toBeUndefined();
    });

    it('should handle empty error message', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swapCase);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(null);

      await manager.markFailed(manifest.swap_id, '');

      expect(vi.mocked(mockSwapRepo.updateState)).toHaveBeenCalledWith(
        expect.any(String),
        SwapState.FAILED,
        expect.any(Number),
        { error_message: '' },
      );
    });

    it('should handle long error message', async () => {
      const manifest = makeValidManifest();
      const swapCase = makeSwapCaseRow(manifest);
      const longErrorMessage = 'x'.repeat(1000);

      vi.mocked(mockSwapRepo.findBySwapId).mockResolvedValue(swapCase);
      vi.mocked(mockSwapRepo.updateState).mockResolvedValue(null);

      await manager.markFailed(manifest.swap_id, longErrorMessage);

      expect(vi.mocked(mockSwapRepo.updateState)).toHaveBeenCalledWith(
        expect.any(String),
        SwapState.FAILED,
        expect.any(Number),
        { error_message: longErrorMessage },
      );
    });
  });

  describe('constructor and dependency injection', () => {
    it('should initialize with provided dependencies', () => {
      const deps = {
        pool: mockPool,
        swapRepo: mockSwapRepo,
        depositRepo: mockDepositRepo,
        config,
      };

      const newManager = new SwapManager(deps);

      expect(newManager).toBeDefined();
      expect(newManager).toBeInstanceOf(SwapManager);
    });

    it('should use provided config for timeout validation', async () => {
      const manifest = makeValidManifest();
      const customConfig = makeConfig({
        swapTimeoutMin: 100,
        swapTimeoutMax: 200,
      });

      const customManager = new SwapManager({
        pool: mockPool,
        swapRepo: mockSwapRepo,
        depositRepo: mockDepositRepo,
        config: customConfig,
      });

      manifest.timeout = 50; // Below custom min

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(0);

      await expect(customManager.announceSwap(manifest)).rejects.toThrow(ManifestValidationError);
    });

    it('should use provided config for maxPendingSwaps', async () => {
      const manifest = makeValidManifest();
      const customConfig = makeConfig({ maxPendingSwaps: 5 });

      const customManager = new SwapManager({
        pool: mockPool,
        swapRepo: mockSwapRepo,
        depositRepo: mockDepositRepo,
        config: customConfig,
      });

      vi.mocked(mockSwapRepo.countPending).mockResolvedValue(5);

      await expect(customManager.announceSwap(manifest)).rejects.toThrow(SwapLimitError);
    });
  });
});
