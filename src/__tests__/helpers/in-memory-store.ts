import { vi } from 'vitest';
import { SwapState } from '../../core/state-machine.js';
import type { SwapManifest } from '../../core/manifest-validator.js';
import type { SwapCaseRow } from '../../storage/repositories/swap.repository.js';
import type { DepositRow } from '../../storage/repositories/deposit.repository.js';
import type {
  TransactionLogRow,
  TransactionType,
  TransactionDirection,
  TransactionStatus,
} from '../../storage/repositories/transaction.repository.js';
import type { SendPaymentRequest } from '../../sphere/payment-sender.js';
import type { Config } from '../../config.js';
import { SwapManager } from '../../core/swap-manager.js';
import { PaymentProcessor } from '../../core/payment-processor.js';
import { ConclusionProcessor } from '../../core/conclusion-processor.js';
import { RefundProcessor } from '../../core/refund-processor.js';
import { TimeoutManager } from '../../core/timeout-manager.js';

// ---------------------------------------------------------------------------
// In-memory SwapRepository
// ---------------------------------------------------------------------------
export class InMemorySwapRepo {
  private swaps = new Map<string, SwapCaseRow>();
  private idCounter = 1;

  async create(manifest: SwapManifest, _client?: unknown): Promise<SwapCaseRow> {
    const row: SwapCaseRow = {
      id: String(this.idCounter++),
      swap_id: manifest.swap_id,
      manifest: { ...manifest },
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
    };
    this.swaps.set(manifest.swap_id, row);
    return this.clone(row);
  }

  async findBySwapId(swapId: string, _client?: unknown): Promise<SwapCaseRow | null> {
    const row = this.swaps.get(swapId);
    return row ? this.clone(row) : null;
  }

  async findBySwapIdForUpdate(swapId: string, _client?: unknown): Promise<SwapCaseRow | null> {
    return this.findBySwapId(swapId);
  }

  async updateState(
    swapId: string,
    newState: SwapState,
    expectedVersion: number,
    updates: Record<string, unknown> = {},
    _client?: unknown,
  ): Promise<SwapCaseRow | null> {
    const row = this.swaps.get(swapId);
    if (!row || row.version !== expectedVersion) return null;
    row.state = newState;
    row.version++;
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) (row as any)[key] = value;
    }
    return this.clone(row);
  }

  async updateDeposits(
    swapId: string,
    updates: Record<string, string>,
    expectedVersion: number,
    _client?: unknown,
  ): Promise<SwapCaseRow | null> {
    const row = this.swaps.get(swapId);
    if (!row || row.version !== expectedVersion) return null;
    row.version++;
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) (row as any)[key] = value;
    }
    return this.clone(row);
  }

  async updateStateWithLock(
    swapId: string,
    newState: SwapState,
    updates: Record<string, unknown> = {},
    _client?: unknown,
  ): Promise<SwapCaseRow | null> {
    const row = this.swaps.get(swapId);
    if (!row) return null;
    row.state = newState;
    row.version++;
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) (row as any)[key] = value;
    }
    return this.clone(row);
  }

  async countPending(): Promise<number> {
    let count = 0;
    for (const row of this.swaps.values()) {
      if (row.state === SwapState.ANNOUNCED || row.state === SwapState.PARTIAL_DEPOSIT) count++;
    }
    return count;
  }

  async findTimedOut(): Promise<SwapCaseRow[]> {
    const now = new Date();
    const results: SwapCaseRow[] = [];
    for (const row of this.swaps.values()) {
      if (row.state === SwapState.PARTIAL_DEPOSIT && row.timeout_at && row.timeout_at <= now) {
        results.push(this.clone(row));
      }
    }
    return results;
  }

  async findByState(state: SwapState): Promise<SwapCaseRow[]> {
    const results: SwapCaseRow[] = [];
    for (const row of this.swaps.values()) {
      if (row.state === state) results.push(this.clone(row));
    }
    return results;
  }

  async countByState(state: SwapState): Promise<number> {
    let count = 0;
    for (const row of this.swaps.values()) {
      if (row.state === state) count++;
    }
    return count;
  }

  private clone(row: SwapCaseRow): SwapCaseRow {
    return {
      ...row,
      manifest: { ...row.manifest },
      created_at: new Date(row.created_at.getTime()),
      first_deposit_at: row.first_deposit_at ? new Date(row.first_deposit_at.getTime()) : null,
      timeout_at: row.timeout_at ? new Date(row.timeout_at.getTime()) : null,
      completed_at: row.completed_at ? new Date(row.completed_at.getTime()) : null,
    };
  }

  getRow(swapId: string): SwapCaseRow | undefined {
    return this.swaps.get(swapId);
  }
}

// ---------------------------------------------------------------------------
// In-memory DepositRepository
// ---------------------------------------------------------------------------
export class InMemoryDepositRepo {
  private deposits: DepositRow[] = [];
  private idCounter = 1;

  async create(
    deposit: {
      swap_id: string;
      transaction_id: string;
      sender: string;
      amount: string;
      coin_id: string;
      memo: string;
      matched_party: 'A' | 'B' | null;
    },
    _client?: unknown,
  ): Promise<DepositRow> {
    const row: DepositRow = {
      id: String(this.idCounter++),
      ...deposit,
      status: 'PENDING',
      received_at: new Date(),
      processed_at: null,
    };
    this.deposits.push(row);
    return { ...row };
  }

  async findByTransactionId(transactionId: string, _client?: unknown): Promise<DepositRow | null> {
    return this.deposits.find((d) => d.transaction_id === transactionId) ?? null;
  }

  async findBySwapId(swapId: string, _client?: unknown): Promise<DepositRow[]> {
    return this.deposits.filter((d) => d.swap_id === swapId);
  }

  async markProcessed(id: string, _client?: unknown): Promise<void> {
    const deposit = this.deposits.find((d) => d.id === id);
    if (deposit) {
      deposit.status = 'PROCESSED';
      deposit.processed_at = new Date();
    }
  }

  getAll(): DepositRow[] {
    return this.deposits;
  }
}

// ---------------------------------------------------------------------------
// In-memory TransactionRepository
// ---------------------------------------------------------------------------
export class InMemoryTxRepo {
  private logs: TransactionLogRow[] = [];
  private idCounter = 1;

  async create(
    entry: {
      swap_id: string;
      type: TransactionType;
      direction: TransactionDirection;
      sender: string;
      recipient: string;
      amount: string;
      coin_id: string;
      memo?: string;
      transaction_id?: string;
      status?: TransactionStatus;
    },
    _client?: unknown,
  ): Promise<TransactionLogRow> {
    const row: TransactionLogRow = {
      id: String(this.idCounter++),
      swap_id: entry.swap_id,
      type: entry.type,
      direction: entry.direction,
      sender: entry.sender,
      recipient: entry.recipient,
      amount: entry.amount,
      coin_id: entry.coin_id,
      memo: entry.memo ?? null,
      transaction_id: entry.transaction_id ?? null,
      status: entry.status ?? 'PENDING',
      error_message: null,
      created_at: new Date(),
      confirmed_at: null,
    };
    this.logs.push(row);
    return { ...row };
  }

  async updateStatus(
    id: string,
    status: TransactionStatus,
    transactionId?: string,
    errorMessage?: string,
    _client?: unknown,
  ): Promise<void> {
    const log = this.logs.find((l) => l.id === id);
    if (log) {
      log.status = status;
      if (transactionId !== undefined) log.transaction_id = transactionId;
      if (errorMessage !== undefined) log.error_message = errorMessage;
      if (status === 'CONFIRMED') log.confirmed_at = new Date();
    }
  }

  async findBySwapId(swapId: string): Promise<TransactionLogRow[]> {
    return this.logs.filter((l) => l.swap_id === swapId);
  }

  async findBySwapIdAndType(swapId: string, type: TransactionType): Promise<TransactionLogRow[]> {
    return this.logs.filter((l) => l.swap_id === swapId && l.type === type);
  }

  async existsSuccessful(swapId: string, type: TransactionType, recipient: string): Promise<boolean> {
    return this.logs.some(
      (l) =>
        l.swap_id === swapId &&
        l.type === type &&
        l.recipient === recipient &&
        (l.status === 'SENT' || l.status === 'CONFIRMED'),
    );
  }

  getAll(): TransactionLogRow[] {
    return this.logs;
  }
}

// ---------------------------------------------------------------------------
// Mock Redis (sorted sets + key-value for locking)
// ---------------------------------------------------------------------------
export function createMockRedis() {
  const kv = new Map<string, string>();
  const sortedSets = new Map<string, Map<string, number>>();

  const redis = {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && kv.has(key)) return null;
      kv.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => kv.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      const had = kv.has(key);
      kv.delete(key);
      return had ? 1 : 0;
    }),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, value: string) => {
      if (kv.get(key) === value) {
        kv.delete(key);
        return 1;
      }
      return 0;
    }),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      if (!sortedSets.has(key)) sortedSets.set(key, new Map());
      const existed = sortedSets.get(key)!.has(member);
      sortedSets.get(key)!.set(member, score);
      return existed ? 0 : 1;
    }),
    zrem: vi.fn(async (key: string, member: string) => {
      if (!sortedSets.has(key)) return 0;
      return sortedSets.get(key)!.delete(member) ? 1 : 0;
    }),
    zrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
      if (!sortedSets.has(key)) return [];
      const result: string[] = [];
      for (const [member, score] of sortedSets.get(key)!) {
        if (score >= min && score <= max) result.push(member);
      }
      return result;
    }),
    zscore: vi.fn(async (key: string, member: string) => {
      if (!sortedSets.has(key)) return null;
      const score = sortedSets.get(key)!.get(member);
      return score !== undefined ? String(score) : null;
    }),
    _kv: kv,
    _sortedSets: sortedSets,
  };
  return redis;
}

// ---------------------------------------------------------------------------
// Mock pg Pool / Client
// ---------------------------------------------------------------------------
export function createMockPool() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return { pool, client };
}

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------
export function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    nodeEnv: 'test',
    logLevel: 'silent',
    databaseUrl: '',
    redisUrl: '',
    sphereWalletPath: '',
    sphereAddressIndex: 0,
    sphereNetwork: 'testnet',
    swapTimeoutMin: 60,
    swapTimeoutMax: 86400,
    swapTimeoutDefault: 3600,
    paymentRetryMaxAttempts: 3,
    paymentRetryDelayMs: 1, // fast retries in tests
    rateLimitManifestPerMinute: 100,
    maxPendingSwaps: 10000,
    depositConfirmationTimeoutMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Full integration context: wires all components together
// ---------------------------------------------------------------------------
export interface TestContext {
  swapManager: SwapManager;
  paymentProcessor: PaymentProcessor;
  conclusionProcessor: ConclusionProcessor;
  refundProcessor: RefundProcessor;
  timeoutManager: TimeoutManager;

  swapRepo: InMemorySwapRepo;
  depositRepo: InMemoryDepositRepo;
  txRepo: InMemoryTxRepo;

  sentPayments: SendPaymentRequest[];
  paymentSender: { send: ReturnType<typeof vi.fn> };

  redis: ReturnType<typeof createMockRedis>;
  pool: ReturnType<typeof createMockPool>['pool'];
  config: Config;

  concludePromises: Promise<void>[];
  timeoutPromises: Promise<void>[];
  waitForConclusion: () => Promise<void>;
  waitForTimeouts: () => Promise<void>;
}

export function createIntegrationContext(
  configOverrides: Partial<Config> = {},
  deps?: { sphere?: unknown },
): TestContext {
  const swapRepo = new InMemorySwapRepo();
  const depositRepo = new InMemoryDepositRepo();
  const txRepo = new InMemoryTxRepo();

  const redis = createMockRedis();
  const { pool } = createMockPool();
  const config = createTestConfig(configOverrides);

  const sentPayments: SendPaymentRequest[] = [];
  const paymentSender = {
    send: vi.fn(async (req: SendPaymentRequest) => {
      sentPayments.push(req);
      return { id: `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`, status: 'sent' } as any;
    }),
  };

  const escrowAddress = 'DIRECT://escrow_pubkey_hex';

  const concludePromises: Promise<void>[] = [];
  const timeoutPromises: Promise<void>[] = [];

  const conclusionProcessor = new ConclusionProcessor({
    pool: pool as any,
    swapRepo: swapRepo as any,
    txRepo: txRepo as any,
    paymentSender,
    escrowAddress,
    config,
  });

  const refundProcessor = new RefundProcessor({
    pool: pool as any,
    swapRepo: swapRepo as any,
    txRepo: txRepo as any,
    paymentSender,
    escrowAddress,
    config,
  });

  const timeoutManager = new TimeoutManager({
    pool: pool as any,
    swapRepo: swapRepo as any,
    redis: redis as any,
    onTimeout: async (swapId: string) => {
      const p = refundProcessor.processTimeout(swapId);
      timeoutPromises.push(p);
      await p;
    },
  });

  const paymentProcessor = new PaymentProcessor({
    pool: pool as any,
    redis: redis as any,
    swapRepo: swapRepo as any,
    depositRepo: depositRepo as any,
    txRepo: txRepo as any,
    paymentSender,
    escrowAddress,
    onReadyToConclude: (swapId: string) => {
      const p = conclusionProcessor.conclude(swapId);
      concludePromises.push(p);
    },
    onFirstDeposit: (swapId: string, timeoutSeconds: number) => {
      timeoutManager.scheduleTimeout(swapId, timeoutSeconds);
    },
    sphere: deps?.sphere as any,
    depositConfirmationTimeoutMs: config.depositConfirmationTimeoutMs,
  });

  const swapManager = new SwapManager({
    pool: pool as any,
    swapRepo: swapRepo as any,
    depositRepo: depositRepo as any,
    config,
  });

  return {
    swapManager,
    paymentProcessor,
    conclusionProcessor,
    refundProcessor,
    timeoutManager,
    swapRepo,
    depositRepo,
    txRepo,
    sentPayments,
    paymentSender,
    redis,
    pool,
    config,
    concludePromises,
    timeoutPromises,
    waitForConclusion: () => Promise.all(concludePromises).then(() => {}),
    waitForTimeouts: () => Promise.all(timeoutPromises).then(() => {}),
  };
}
