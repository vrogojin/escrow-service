import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createSwapRoutes, type SwapRoutesDeps } from '../routes/swap.routes.js';
import type { SwapManager } from '../../core/swap-manager.js';
import type { DepositRepository } from '../../storage/repositories/deposit.repository.js';
import type { TransactionRepository } from '../../storage/repositories/transaction.repository.js';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { WalletManager } from '../../sphere/wallet-manager.js';
import type { SwapCaseRow } from '../../storage/repositories/swap.repository.js';

/**
 * Helper to create a mock Express Request object
 */
function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    body: {},
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

/**
 * Helper to create a mock Express Response object with status/json tracking
 */
function createMockResponse(): Response & { statusCode?: number; jsonData?: unknown; ended?: boolean } {
  const res: any = {};
  // Default to 200 (matching Express behavior)
  res.statusCode = 200;

  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };

  res.json = (data: unknown) => {
    res.jsonData = data;
    res.ended = true;
    return res;
  };

  res.send = (data: unknown) => {
    res.jsonData = data;
    res.ended = true;
    return res;
  };

  return res;
}

describe('Swap Routes', () => {
  let mockSwapManager: Partial<SwapManager>;
  let mockDepositRepo: Partial<DepositRepository>;
  let mockTxRepo: Partial<TransactionRepository>;
  let mockPool: Partial<Pool>;
  let mockRedis: Partial<Redis>;
  let mockWalletManager: Partial<WalletManager>;
  let deps: SwapRoutesDeps;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSwapManager = {
      announceSwap: vi.fn(),
      getSwap: vi.fn(),
      markFailed: vi.fn(),
    };

    mockDepositRepo = {
      findBySwapId: vi.fn().mockResolvedValue([]),
    };

    mockTxRepo = {
      findBySwapId: vi.fn().mockResolvedValue([]),
    };

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
    };

    mockWalletManager = {
      getEscrowAddress: vi.fn().mockReturnValue('escrow_address_123'),
    };

    deps = {
      swapManager: mockSwapManager as SwapManager,
      depositRepo: mockDepositRepo as DepositRepository,
      txRepo: mockTxRepo as TransactionRepository,
      pool: mockPool as Pool,
      redis: mockRedis as Redis,
      walletManager: mockWalletManager as WalletManager,
    };
  });

  describe('POST /swaps - announceSwap', () => {
    it('should return 201 with new swap', async () => {
      const swapId = 'a'.repeat(64);
      const swapCase: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {} as any,
        state: 'ANNOUNCED' as any,
        party_a_deposited: '0',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date('2026-02-15T00:00:00Z'),
        first_deposit_at: null,
        timeout_at: null,
        completed_at: null,
        error_message: null,
        version: 1,
      };

      (mockSwapManager.announceSwap as any).mockResolvedValue({
        swapCase,
        isNew: true,
      });

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        body: { manifest: { test: true } },
      });
      const res = createMockResponse();
      const next = vi.fn();

      // Find and call the POST /swaps handler
      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps' && r.route?.methods?.post);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.statusCode).toBe(201);
        expect(res.jsonData).toEqual({
          swap_id: swapId,
          state: 'ANNOUNCED',
          created_at: new Date('2026-02-15T00:00:00Z'),
          is_new: true,
        });
      }
    });

    it('should return 200 with existing swap (duplicate)', async () => {
      const swapId = 'a'.repeat(64);
      const swapCase: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {} as any,
        state: 'ANNOUNCED' as any,
        party_a_deposited: '0',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date('2026-02-15T00:00:00Z'),
        first_deposit_at: null,
        timeout_at: null,
        completed_at: null,
        error_message: null,
        version: 1,
      };

      (mockSwapManager.announceSwap as any).mockResolvedValue({
        swapCase,
        isNew: false,
      });

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        body: { manifest: { test: true } },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps' && r.route?.methods?.post);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.statusCode).toBe(200);
        expect(res.jsonData).toEqual({
          swap_id: swapId,
          state: 'ANNOUNCED',
          created_at: new Date('2026-02-15T00:00:00Z'),
          is_new: false,
        });
      }
    });

    it('should pass manifest to swapManager.announceSwap', async () => {
      const manifest = { test: true, timeout: 300 };

      (mockSwapManager.announceSwap as any).mockResolvedValue({
        swapCase: {
          id: '1',
          swap_id: 'a'.repeat(64),
          state: 'ANNOUNCED',
          created_at: new Date(),
        } as any,
        isNew: true,
      });

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        body: { manifest },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps' && r.route?.methods?.post);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(mockSwapManager.announceSwap).toHaveBeenCalledWith(manifest);
      }
    });

    it('should call next() with error if swapManager throws', async () => {
      const testError = new Error('Validation failed');
      (mockSwapManager.announceSwap as any).mockRejectedValue(testError);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        body: { manifest: { test: true } },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps' && r.route?.methods?.post);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(next).toHaveBeenCalledWith(testError);
      }
    });
  });

  describe('GET /swaps/:swap_id - getSwap', () => {
    it('should return swap data with 200 when swap found', async () => {
      const swapId = 'a'.repeat(64);
      const swapCase: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {
          swap_id: swapId,
          party_a_address: 'addr_a',
          party_a_currency_to_change: 'USD',
          party_a_value_to_change: '100',
          party_b_address: 'addr_b',
          party_b_currency_to_change: 'EUR',
          party_b_value_to_change: '90',
          timeout: 300,
        } as any,
        state: 'ANNOUNCED' as any,
        party_a_deposited: '0',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date('2026-02-15T00:00:00Z'),
        first_deposit_at: null,
        timeout_at: null,
        completed_at: null,
        error_message: null,
        version: 1,
      };

      (mockSwapManager.getSwap as any).mockResolvedValue(swapCase);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        params: { swap_id: swapId },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id' && r.route?.methods?.get);
      if (routes.length > 0) {
        // Skip the validation middleware and call handler directly
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.statusCode).toBe(200);
        expect(res.jsonData).toMatchObject({
          swap_id: swapId,
          state: 'ANNOUNCED',
          manifest: swapCase.manifest,
        });
      }
    });

    it('should return 404 when swap not found', async () => {
      const swapId = 'a'.repeat(64);

      (mockSwapManager.getSwap as any).mockResolvedValue(null);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        params: { swap_id: swapId },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.statusCode).toBe(404);
        expect(res.jsonData).toEqual({ error: 'Swap not found' });
      }
    });

    it('should include deposits in response', async () => {
      const swapId = 'a'.repeat(64);
      const swapCase: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {} as any,
        state: 'PARTIAL_DEPOSIT' as any,
        party_a_deposited: '100',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date(),
        first_deposit_at: new Date(),
        timeout_at: null,
        completed_at: null,
        error_message: null,
        version: 1,
      };

      const deposits = [
        {
          id: '1',
          swap_id: swapId,
          transaction_id: 'tx_1',
          sender: 'addr_a',
          amount: '100',
          coin_id: 'USD',
          matched_party: 'party_a',
          status: 'CONFIRMED',
          received_at: new Date(),
        },
      ];

      (mockSwapManager.getSwap as any).mockResolvedValue(swapCase);
      (mockDepositRepo.findBySwapId as any).mockResolvedValue(deposits);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        params: { swap_id: swapId },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.jsonData).toMatchObject({
          deposits: [
            {
              transaction_id: 'tx_1',
              sender: 'addr_a',
              amount: '100',
              coin_id: 'USD',
              matched_party: 'party_a',
              status: 'CONFIRMED',
            },
          ],
        });
      }
    });

    it('should include transactions in response', async () => {
      const swapId = 'a'.repeat(64);
      const swapCase: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {} as any,
        state: 'COMPLETED' as any,
        party_a_deposited: '100',
        party_b_deposited: '90',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date(),
        first_deposit_at: new Date(),
        timeout_at: null,
        completed_at: new Date(),
        error_message: null,
        version: 1,
      };

      const transactions = [
        {
          id: '1',
          swap_id: swapId,
          type: 'PAYOUT',
          direction: 'OUT',
          recipient: 'addr_a',
          amount: '90',
          coin_id: 'EUR',
          status: 'COMPLETED',
          created_at: new Date(),
        },
      ];

      (mockSwapManager.getSwap as any).mockResolvedValue(swapCase);
      (mockDepositRepo.findBySwapId as any).mockResolvedValue([]);
      (mockTxRepo.findBySwapId as any).mockResolvedValue(transactions);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        params: { swap_id: swapId },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.jsonData).toMatchObject({
          transactions: [
            {
              type: 'PAYOUT',
              direction: 'OUT',
              recipient: 'addr_a',
              amount: '90',
              coin_id: 'EUR',
              status: 'COMPLETED',
            },
          ],
        });
      }
    });

    it('should call next() with error if getSwap throws', async () => {
      const testError = new Error('Database error');
      (mockSwapManager.getSwap as any).mockRejectedValue(testError);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        params: { swap_id: 'a'.repeat(64) },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(next).toHaveBeenCalledWith(testError);
      }
    });
  });

  describe('GET /swaps/:swap_id/deposit-instructions', () => {
    it('should return deposit instructions with 200 when swap found', async () => {
      const swapId = 'a'.repeat(64);
      const swapCase: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {
          swap_id: swapId,
          party_a_address: 'addr_a',
          party_a_currency_to_change: 'USD',
          party_a_value_to_change: '100',
          party_b_address: 'addr_b',
          party_b_currency_to_change: 'EUR',
          party_b_value_to_change: '90',
          timeout: 300,
        } as any,
        state: 'ANNOUNCED' as any,
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
      };

      (mockSwapManager.getSwap as any).mockResolvedValue(swapCase);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        params: { swap_id: swapId },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id/deposit-instructions' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.statusCode).toBe(200);
        expect(res.jsonData).toEqual({
          swap_id: swapId,
          escrow_address: 'escrow_address_123',
          memo: swapId,
          party_a: {
            address: 'addr_a',
            currency: 'USD',
            amount: '100',
            deposited: '0',
          },
          party_b: {
            address: 'addr_b',
            currency: 'EUR',
            amount: '90',
            deposited: '0',
          },
        });
      }
    });

    it('should return 404 when swap not found', async () => {
      (mockSwapManager.getSwap as any).mockResolvedValue(null);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        params: { swap_id: 'a'.repeat(64) },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id/deposit-instructions' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.statusCode).toBe(404);
        expect(res.jsonData).toEqual({ error: 'Swap not found' });
      }
    });

    it('should include deposit status for both parties', async () => {
      const swapId = 'a'.repeat(64);
      const swapCase: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {
          swap_id: swapId,
          party_a_address: 'addr_a',
          party_a_currency_to_change: 'USD',
          party_a_value_to_change: '100',
          party_b_address: 'addr_b',
          party_b_currency_to_change: 'EUR',
          party_b_value_to_change: '90',
          timeout: 300,
        } as any,
        state: 'PARTIAL_DEPOSIT' as any,
        party_a_deposited: '100',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date(),
        first_deposit_at: new Date(),
        timeout_at: null,
        completed_at: null,
        error_message: null,
        version: 1,
      };

      (mockSwapManager.getSwap as any).mockResolvedValue(swapCase);

      const router = createSwapRoutes(deps);
      const req = createMockRequest({
        params: { swap_id: swapId },
      });
      const res = createMockResponse();
      const next = vi.fn();

      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id/deposit-instructions' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, next);

        expect(res.jsonData).toEqual({
          swap_id: swapId,
          escrow_address: 'escrow_address_123',
          memo: swapId,
          party_a: {
            address: 'addr_a',
            currency: 'USD',
            amount: '100',
            deposited: '100',
          },
          party_b: {
            address: 'addr_b',
            currency: 'EUR',
            amount: '90',
            deposited: '0',
          },
        });
      }
    });
  });

  describe('GET /health', () => {
    it('should return 200 when all checks are healthy', async () => {
      (mockPool.query as any).mockResolvedValue({ rows: [{ result: 1 }] });
      (mockRedis.ping as any).mockResolvedValue('PONG');

      const router = createSwapRoutes(deps);
      const req = createMockRequest();
      const res = createMockResponse();

      const routes = router.stack.filter((r: any) => r.route?.path === '/health' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, undefined as any);

        expect(res.statusCode).toBe(200);
        expect(res.jsonData).toEqual({
          status: 'healthy',
          checks: {
            database: { status: 'ok' },
            redis: { status: 'ok' },
            sphere: { status: 'ok' },
          },
        });
      }
    });

    it('should return 503 when database is down', async () => {
      const dbError = new Error('Connection failed');
      (mockPool.query as any).mockRejectedValue(dbError);
      (mockRedis.ping as any).mockResolvedValue('PONG');

      const router = createSwapRoutes(deps);
      const req = createMockRequest();
      const res = createMockResponse();

      const routes = router.stack.filter((r: any) => r.route?.path === '/health' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, undefined as any);

        expect(res.statusCode).toBe(503);
        expect(res.jsonData).toEqual({
          status: 'degraded',
          checks: {
            database: { status: 'error', error: 'Connection failed' },
            redis: { status: 'ok' },
            sphere: { status: 'ok' },
          },
        });
      }
    });

    it('should return 503 when Redis is down', async () => {
      const redisError = new Error('Redis unreachable');
      (mockPool.query as any).mockResolvedValue({ rows: [{ result: 1 }] });
      (mockRedis.ping as any).mockRejectedValue(redisError);

      const router = createSwapRoutes(deps);
      const req = createMockRequest();
      const res = createMockResponse();

      const routes = router.stack.filter((r: any) => r.route?.path === '/health' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, undefined as any);

        expect(res.statusCode).toBe(503);
        expect(res.jsonData).toEqual({
          status: 'degraded',
          checks: {
            database: { status: 'ok' },
            redis: { status: 'error', error: 'Redis unreachable' },
            sphere: { status: 'ok' },
          },
        });
      }
    });

    it('should return 503 when sphere wallet is unavailable', async () => {
      (mockPool.query as any).mockResolvedValue({ rows: [{ result: 1 }] });
      (mockRedis.ping as any).mockResolvedValue('PONG');
      (mockWalletManager.getEscrowAddress as any).mockReturnValue(null);

      const router = createSwapRoutes(deps);
      const req = createMockRequest();
      const res = createMockResponse();

      const routes = router.stack.filter((r: any) => r.route?.path === '/health' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, undefined as any);

        expect(res.statusCode).toBe(503);
        expect(res.jsonData).toEqual({
          status: 'degraded',
          checks: {
            database: { status: 'ok' },
            redis: { status: 'ok' },
            sphere: { status: 'error' },
          },
        });
      }
    });

    it('should handle sphere wallet exception gracefully', async () => {
      const sphereError = new Error('Wallet initialization failed');
      (mockPool.query as any).mockResolvedValue({ rows: [{ result: 1 }] });
      (mockRedis.ping as any).mockResolvedValue('PONG');
      (mockWalletManager.getEscrowAddress as any).mockImplementation(() => {
        throw sphereError;
      });

      const router = createSwapRoutes(deps);
      const req = createMockRequest();
      const res = createMockResponse();

      const routes = router.stack.filter((r: any) => r.route?.path === '/health' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, undefined as any);

        expect(res.statusCode).toBe(503);
        expect(res.jsonData).toEqual({
          status: 'degraded',
          checks: {
            database: { status: 'ok' },
            redis: { status: 'ok' },
            sphere: { status: 'error', error: 'Wallet initialization failed' },
          },
        });
      }
    });

    it('should return 503 when all services are down', async () => {
      const dbError = new Error('DB down');
      const redisError = new Error('Redis down');
      const sphereError = new Error('Sphere down');

      (mockPool.query as any).mockRejectedValue(dbError);
      (mockRedis.ping as any).mockRejectedValue(redisError);
      (mockWalletManager.getEscrowAddress as any).mockImplementation(() => {
        throw sphereError;
      });

      const router = createSwapRoutes(deps);
      const req = createMockRequest();
      const res = createMockResponse();

      const routes = router.stack.filter((r: any) => r.route?.path === '/health' && r.route?.methods?.get);
      if (routes.length > 0) {
        const handler = routes[0].route.stack.at(-1).handle;
        await handler(req, res, undefined as any);

        expect(res.statusCode).toBe(503);
        expect(res.jsonData.status).toBe('degraded');
        expect(res.jsonData.checks.database.status).toBe('error');
        expect(res.jsonData.checks.redis.status).toBe('error');
        expect(res.jsonData.checks.sphere.status).toBe('error');
      }
    });
  });

  describe('Route creation', () => {
    it('should create router without throwing', () => {
      expect(() => createSwapRoutes(deps)).not.toThrow();
    });

    it('should return a Router instance', () => {
      const router = createSwapRoutes(deps);
      expect(router).toBeDefined();
      expect(typeof router.get).toBe('function');
      expect(typeof router.post).toBe('function');
    });

    it('should register all required routes', () => {
      const router = createSwapRoutes(deps);
      const swapRoutes = router.stack.filter((r: any) => r.route);
      const paths = swapRoutes.map((r: any) => r.route.path);

      expect(paths).toContain('/swaps');
      expect(paths).toContain('/swaps/:swap_id');
      expect(paths).toContain('/swaps/:swap_id/deposit-instructions');
      expect(paths).toContain('/health');
    });

    it('should register POST method for /swaps', () => {
      const router = createSwapRoutes(deps);
      const route = router.stack.find((r: any) => r.route?.path === '/swaps' && r.route?.methods?.post);
      expect(route).toBeDefined();
    });

    it('should register GET methods for /swaps/:swap_id', () => {
      const router = createSwapRoutes(deps);
      const routes = router.stack.filter((r: any) => r.route?.path === '/swaps/:swap_id' && r.route?.methods?.get);
      expect(routes.length).toBeGreaterThan(0);
    });

    it('should register GET method for /health', () => {
      const router = createSwapRoutes(deps);
      const route = router.stack.find((r: any) => r.route?.path === '/health' && r.route?.methods?.get);
      expect(route).toBeDefined();
    });
  });
});
