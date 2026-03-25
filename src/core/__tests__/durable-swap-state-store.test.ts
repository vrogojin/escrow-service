import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { DurableSwapStateStore } from '../durable-swap-state-store.js';
import { SwapState, isTerminalState } from '../state-machine.js';
import type { SwapManifest, ResolvedAddresses, SwapRecord } from '../types.js';
import { computeSwapId } from '../../utils/hash.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirRoot: string;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpDirRoot, 'durable-store-'));
  return dir;
}

function createTestManifest(overrides?: Partial<SwapManifest>): SwapManifest {
  const base = {
    party_a_address: 'DIRECT://party_a_pubkey',
    party_b_address: 'DIRECT://party_b_pubkey',
    party_a_currency_to_change: 'UCT',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'USDU',
    party_b_value_to_change: '500',
    timeout: 600,
    salt: randomBytes(16).toString('hex'),
    ...overrides,
  };

  const fields = {
    party_a_address: base.party_a_address,
    party_b_address: base.party_b_address,
    party_a_currency_to_change: base.party_a_currency_to_change,
    party_a_value_to_change: base.party_a_value_to_change,
    party_b_currency_to_change: base.party_b_currency_to_change,
    party_b_value_to_change: base.party_b_value_to_change,
    timeout: base.timeout,
    salt: base.salt,
  };

  const swap_id = computeSwapId(fields);
  return { ...base, swap_id };
}

function createTestResolvedAddresses(): ResolvedAddresses {
  return {
    partyA: 'DIRECT://party_a_pubkey',
    partyB: 'DIRECT://party_b_pubkey',
  };
}

/**
 * Walk a swap through valid state transitions to reach the target state.
 */
function walkToState(
  store: DurableSwapStateStore,
  swapId: string,
  target: SwapState,
  startVersion: number,
  updates?: Partial<SwapRecord>,
): SwapRecord {
  const paths: Record<string, SwapState[]> = {
    [SwapState.DEPOSIT_INVOICE_CREATED]: [SwapState.DEPOSIT_INVOICE_CREATED],
    [SwapState.PARTIAL_DEPOSIT]: [SwapState.DEPOSIT_INVOICE_CREATED, SwapState.PARTIAL_DEPOSIT],
    [SwapState.DEPOSIT_COVERED]: [SwapState.DEPOSIT_INVOICE_CREATED, SwapState.DEPOSIT_COVERED],
    [SwapState.CONCLUDING]: [SwapState.DEPOSIT_INVOICE_CREATED, SwapState.DEPOSIT_COVERED, SwapState.CONCLUDING],
    [SwapState.COMPLETED]: [SwapState.DEPOSIT_INVOICE_CREATED, SwapState.DEPOSIT_COVERED, SwapState.CONCLUDING, SwapState.COMPLETED],
    [SwapState.TIMED_OUT]: [SwapState.DEPOSIT_INVOICE_CREATED, SwapState.PARTIAL_DEPOSIT, SwapState.TIMED_OUT],
    [SwapState.CANCELLING]: [SwapState.DEPOSIT_INVOICE_CREATED, SwapState.PARTIAL_DEPOSIT, SwapState.TIMED_OUT, SwapState.CANCELLING],
    [SwapState.CANCELLED]: [SwapState.DEPOSIT_INVOICE_CREATED, SwapState.PARTIAL_DEPOSIT, SwapState.TIMED_OUT, SwapState.CANCELLING, SwapState.CANCELLED],
    [SwapState.FAILED]: [SwapState.FAILED],
  };
  const steps = paths[target];
  if (!steps) throw new Error(`No path to ${target}`);

  let version = startVersion;
  let result: SwapRecord | null = null;
  for (let i = 0; i < steps.length; i++) {
    const isLast = i === steps.length - 1;
    result = store.updateState(swapId, steps[i], isLast ? (updates ?? {}) : {}, version);
    if (!result) throw new Error(`Failed transition to ${steps[i]} at version ${version}`);
    version = result.version;
  }
  return result!;
}

function walPath(dataDir: string): string {
  return path.join(dataDir, 'swaps.wal');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-durable-tests-'));
});

afterAll(() => {
  fs.rmSync(tmpDirRoot, { recursive: true, force: true });
});

describe('DurableSwapStateStore', () => {
  describe('CRUD Operations', () => {
    it('should create swap record with manifest, state=ANNOUNCED, resolved addresses', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const record = store.create(manifest, addresses);

      expect(record.swap_id).toBe(manifest.swap_id);
      expect(record.manifest).toEqual(manifest);
      expect(record.state).toBe(SwapState.ANNOUNCED);
      expect(record.resolved_party_a_address).toBe(addresses.partyA);
      expect(record.resolved_party_b_address).toBe(addresses.partyB);
      expect(record.version).toBe(1);
      expect(record.deposit_invoice_id).toBeNull();
      expect(record.payout_a_invoice_id).toBeNull();
      expect(record.payout_b_invoice_id).toBeNull();
    });

    it('should find swap by swap_id', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      const found = store.findBySwapId(manifest.swap_id);

      expect(found).not.toBeNull();
      expect(found?.swap_id).toBe(manifest.swap_id);
      expect(found?.state).toBe(SwapState.ANNOUNCED);
    });

    it('should find swap by deposit_invoice_id', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      const invoiceId = 'a'.repeat(64);
      store.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: invoiceId },
        1,
      );

      const found = store.findByInvoiceId(invoiceId);
      expect(found).not.toBeNull();
      expect(found?.swap_id).toBe(manifest.swap_id);
      expect(found?.deposit_invoice_id).toBe(invoiceId);
    });

    it('should find swap by payout_a_invoice_id or payout_b_invoice_id', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      const payoutAInvoiceId = 'b'.repeat(64);
      const payoutBInvoiceId = 'c'.repeat(64);

      walkToState(store, manifest.swap_id, SwapState.CONCLUDING, 1, {
        payout_a_invoice_id: payoutAInvoiceId,
        payout_b_invoice_id: payoutBInvoiceId,
      });

      const foundByA = store.findByInvoiceId(payoutAInvoiceId);
      const foundByB = store.findByInvoiceId(payoutBInvoiceId);

      expect(foundByA).not.toBeNull();
      expect(foundByA?.payout_a_invoice_id).toBe(payoutAInvoiceId);
      expect(foundByB).not.toBeNull();
      expect(foundByB?.payout_b_invoice_id).toBe(payoutBInvoiceId);
    });

    it('should return null for non-existent swap_id', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const found = store.findBySwapId('z'.repeat(64));
      expect(found).toBeNull();
    });

    it('should handle idempotent create (return existing record)', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const first = store.create(manifest, addresses);
      const second = store.create(manifest, addresses);

      expect(second.swap_id).toBe(first.swap_id);
      expect(second.version).toBe(1);
    });
  });

  describe('State Updates with Optimistic Locking', () => {
    it('should update state and increment version on success', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      const updated = store.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        {},
        1,
      );

      expect(updated).not.toBeNull();
      expect(updated?.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(updated?.version).toBe(2);
    });

    it('should return null when expectedVersion does not match', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      const result = store.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        {},
        99,
      );

      expect(result).toBeNull();
    });

    it('should throw on invalid state transition', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      expect(() => {
        store.updateState(manifest.swap_id, SwapState.COMPLETED, {}, 1);
      }).toThrow(/Invalid state transition/);
    });

    it('should throw on disallowed update field', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      expect(() => {
        store.updateState(
          manifest.swap_id,
          SwapState.DEPOSIT_INVOICE_CREATED,
          { swap_id: 'x'.repeat(64) } as any,
          1,
        );
      }).toThrow(/not in the allowed update list/);
    });

    it('should update deposit_invoice_id alongside state transition', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      const invoiceId = 'a'.repeat(64);
      const updated = store.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: invoiceId },
        1,
      );

      expect(updated).not.toBeNull();
      expect(updated?.deposit_invoice_id).toBe(invoiceId);
    });
  });

  describe('Query Methods', () => {
    it('should return all non-terminal swaps via findNonTerminal', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_party_a',
        party_b_address: 'DIRECT://other_party_b',
      });
      const addresses = createTestResolvedAddresses();

      store.create(manifest1, addresses);
      store.create(manifest2, addresses);

      const nonTerminal = store.findNonTerminal();
      expect(nonTerminal).toHaveLength(2);
    });

    it('should not include COMPLETED swaps in findNonTerminal', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      walkToState(store, manifest.swap_id, SwapState.COMPLETED, 1);

      const nonTerminal = store.findNonTerminal();
      expect(nonTerminal).toHaveLength(0);
    });

    it('should not include CANCELLED or FAILED swaps in findNonTerminal', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_party_a',
        party_b_address: 'DIRECT://other_party_b',
      });
      const manifest3 = createTestManifest({
        party_a_address: 'DIRECT://third_party_a',
        party_b_address: 'DIRECT://third_party_b',
      });
      const addresses = createTestResolvedAddresses();

      store.create(manifest1, addresses);
      store.create(manifest2, addresses);
      store.create(manifest3, addresses);

      walkToState(store, manifest1.swap_id, SwapState.CANCELLED, 1);
      store.updateState(manifest2.swap_id, SwapState.FAILED, {}, 1);

      const nonTerminal = store.findNonTerminal();
      expect(nonTerminal).toHaveLength(1);
      expect(nonTerminal[0].swap_id).toBe(manifest3.swap_id);
    });
  });

  describe('WAL Persistence and Replay', () => {
    it('should create WAL file on first write', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      expect(fs.existsSync(walPath(dir))).toBe(false);
      store.create(manifest, addresses);
      expect(fs.existsSync(walPath(dir))).toBe(true);
    });

    it('should replay WAL and restore state on new instance', () => {
      const dir = makeTmpDir();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();
      const invoiceId = 'a'.repeat(64);

      // Write some state
      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest, addresses);
      store1.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: invoiceId },
        1,
      );

      // Create new instance from same WAL
      const store2 = new DurableSwapStateStore(dir);
      const found = store2.findBySwapId(manifest.swap_id);

      expect(found).not.toBeNull();
      expect(found?.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(found?.deposit_invoice_id).toBe(invoiceId);
      expect(found?.version).toBe(2);
    });

    it('should rebuild invoice index on replay', () => {
      const dir = makeTmpDir();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();
      const invoiceId = 'a'.repeat(64);

      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest, addresses);
      store1.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: invoiceId },
        1,
      );

      const store2 = new DurableSwapStateStore(dir);
      const found = store2.findByInvoiceId(invoiceId);

      expect(found).not.toBeNull();
      expect(found?.swap_id).toBe(manifest.swap_id);
    });

    it('should replay multiple records correctly', () => {
      const dir = makeTmpDir();
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_party_a',
        party_b_address: 'DIRECT://other_party_b',
      });
      const addresses = createTestResolvedAddresses();

      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest1, addresses);
      store1.create(manifest2, addresses);
      walkToState(store1, manifest1.swap_id, SwapState.COMPLETED, 1);

      const store2 = new DurableSwapStateStore(dir);
      expect(store2.findBySwapId(manifest1.swap_id)?.state).toBe(SwapState.COMPLETED);
      expect(store2.findBySwapId(manifest2.swap_id)?.state).toBe(SwapState.ANNOUNCED);
      expect(store2.findNonTerminal()).toHaveLength(1);
    });
  });

  describe('Crash Simulation — Partial/Corrupted WAL', () => {
    it('should skip malformed JSON lines', () => {
      const dir = makeTmpDir();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      // Write a valid record, then corrupt the WAL
      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest, addresses);

      // Append garbage
      fs.appendFileSync(walPath(dir), '{ this is not valid json }\n');

      // New instance should skip the bad line and load the good record
      const store2 = new DurableSwapStateStore(dir);
      const found = store2.findBySwapId(manifest.swap_id);
      expect(found).not.toBeNull();
      expect(found?.state).toBe(SwapState.ANNOUNCED);
    });

    it('should skip truncated/partial last line (no newline)', () => {
      const dir = makeTmpDir();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest, addresses);

      // Append a truncated line (no newline, partial JSON)
      fs.appendFileSync(walPath(dir), '{"op":"update","record":{"swap_id":"abc');

      const store2 = new DurableSwapStateStore(dir);
      const found = store2.findBySwapId(manifest.swap_id);
      expect(found).not.toBeNull();
      expect(found?.state).toBe(SwapState.ANNOUNCED);
    });

    it('should skip lines with CRC32 mismatch (tampered data)', () => {
      const dir = makeTmpDir();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest, addresses);

      // Read WAL, tamper with the CRC
      const content = fs.readFileSync(walPath(dir), 'utf-8');
      const lines = content.trim().split('\n');
      const parsed = JSON.parse(lines[0]);
      parsed._crc = 12345; // Wrong CRC
      lines[0] = JSON.stringify(parsed);
      fs.writeFileSync(walPath(dir), lines.join('\n') + '\n');

      const store2 = new DurableSwapStateStore(dir);
      const found = store2.findBySwapId(manifest.swap_id);
      expect(found).toBeNull(); // The only record was tampered
    });

    it('should skip lines with invalid swap_id format', () => {
      const dir = makeTmpDir();

      // Write a WAL line with invalid swap_id
      const badRecord = {
        swap_id: 'not-a-hex-id',
        manifest: { swap_id: 'not-a-hex-id' },
        state: SwapState.ANNOUNCED,
        deposit_invoice_id: null,
        payout_a_invoice_id: null,
        payout_b_invoice_id: null,
        resolved_party_a_address: 'DIRECT://aaa',
        resolved_party_b_address: 'DIRECT://bbb',
        first_deposit_at: null,
        timeout_at: null,
        created_at: Date.now(),
        completed_at: null,
        error_message: null,
        version: 1,
      };
      const entry = { op: 'create', record: badRecord };
      const json = JSON.stringify(entry);
      const crcVal = crc32(Buffer.from(json, 'utf-8'));
      fs.writeFileSync(walPath(dir), JSON.stringify({ ...entry, _crc: crcVal }) + '\n');

      const store = new DurableSwapStateStore(dir);
      expect(store.findBySwapId('not-a-hex-id')).toBeNull();
    });

    it('should skip lines with invalid state transition', () => {
      const dir = makeTmpDir();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      // Write a valid create
      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest, addresses);

      // Manually append an invalid transition (ANNOUNCED -> COMPLETED)
      const badUpdate = {
        op: 'update',
        record: {
          ...store1.findBySwapId(manifest.swap_id)!,
          state: SwapState.COMPLETED,
          version: 2,
        },
      };
      const json = JSON.stringify(badUpdate);
      const crcVal = crc32(Buffer.from(json, 'utf-8'));
      fs.appendFileSync(walPath(dir), JSON.stringify({ ...badUpdate, _crc: crcVal }) + '\n');

      const store2 = new DurableSwapStateStore(dir);
      const found = store2.findBySwapId(manifest.swap_id);
      expect(found).not.toBeNull();
      expect(found?.state).toBe(SwapState.ANNOUNCED); // Invalid transition was skipped
    });
  });

  describe('Compaction', () => {
    it('should reduce WAL size after compaction', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      store.updateState(manifest.swap_id, SwapState.DEPOSIT_INVOICE_CREATED, {}, 1);
      store.updateState(manifest.swap_id, SwapState.PARTIAL_DEPOSIT, {}, 2);

      const sizeBeforeCompact = fs.statSync(walPath(dir)).size;

      store.compact();

      const sizeAfterCompact = fs.statSync(walPath(dir)).size;
      expect(sizeAfterCompact).toBeLessThan(sizeBeforeCompact);
    });

    it('should preserve state after compaction + replay', () => {
      const dir = makeTmpDir();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();
      const invoiceId = 'a'.repeat(64);

      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest, addresses);
      store1.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: invoiceId },
        1,
      );
      store1.updateState(manifest.swap_id, SwapState.PARTIAL_DEPOSIT, {}, 2);
      store1.compact();

      // Replay from compacted WAL
      const store2 = new DurableSwapStateStore(dir);
      const found = store2.findBySwapId(manifest.swap_id);
      expect(found).not.toBeNull();
      expect(found?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(found?.deposit_invoice_id).toBe(invoiceId);
      expect(found?.version).toBe(3);
    });

    it('should produce one WAL line per record after compaction', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_a',
        party_b_address: 'DIRECT://other_b',
      });
      const addresses = createTestResolvedAddresses();

      store.create(manifest1, addresses);
      store.create(manifest2, addresses);
      store.updateState(manifest1.swap_id, SwapState.DEPOSIT_INVOICE_CREATED, {}, 1);
      store.updateState(manifest1.swap_id, SwapState.PARTIAL_DEPOSIT, {}, 2);

      store.compact();

      const content = fs.readFileSync(walPath(dir), 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      expect(lines).toHaveLength(2); // One per record
    });
  });

  describe('countNonTerminal', () => {
    it('should return 0 for empty store', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      expect(store.countNonTerminal()).toBe(0);
    });

    it('should increment on create', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      expect(store.countNonTerminal()).toBe(1);
    });

    it('should not increment on idempotent create', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      store.create(manifest, addresses);
      expect(store.countNonTerminal()).toBe(1);
    });

    it('should decrement on terminal state transition', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      expect(store.countNonTerminal()).toBe(1);

      walkToState(store, manifest.swap_id, SwapState.COMPLETED, 1);
      expect(store.countNonTerminal()).toBe(0);
    });

    it('should not change on non-terminal to non-terminal transition', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);
      store.updateState(manifest.swap_id, SwapState.DEPOSIT_INVOICE_CREATED, {}, 1);
      expect(store.countNonTerminal()).toBe(1);

      store.updateState(manifest.swap_id, SwapState.PARTIAL_DEPOSIT, {}, 2);
      expect(store.countNonTerminal()).toBe(1);
    });

    it('should track multiple swaps correctly', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_a',
        party_b_address: 'DIRECT://other_b',
      });
      const manifest3 = createTestManifest({
        party_a_address: 'DIRECT://third_a',
        party_b_address: 'DIRECT://third_b',
      });
      const addresses = createTestResolvedAddresses();

      store.create(manifest1, addresses);
      store.create(manifest2, addresses);
      store.create(manifest3, addresses);
      expect(store.countNonTerminal()).toBe(3);

      walkToState(store, manifest1.swap_id, SwapState.COMPLETED, 1);
      expect(store.countNonTerminal()).toBe(2);

      store.updateState(manifest2.swap_id, SwapState.FAILED, {}, 1);
      expect(store.countNonTerminal()).toBe(1);
    });

    it('should be correct after WAL replay', () => {
      const dir = makeTmpDir();
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_a',
        party_b_address: 'DIRECT://other_b',
      });
      const addresses = createTestResolvedAddresses();

      const store1 = new DurableSwapStateStore(dir);
      store1.create(manifest1, addresses);
      store1.create(manifest2, addresses);
      walkToState(store1, manifest1.swap_id, SwapState.COMPLETED, 1);

      const store2 = new DurableSwapStateStore(dir);
      expect(store2.countNonTerminal()).toBe(1);
    });

    it('should self-heal after compact', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_a',
        party_b_address: 'DIRECT://other_b',
      });
      const addresses = createTestResolvedAddresses();

      store.create(manifest1, addresses);
      store.create(manifest2, addresses);
      walkToState(store, manifest1.swap_id, SwapState.COMPLETED, 1);

      store.compact();
      expect(store.countNonTerminal()).toBe(1);
    });
  });

  describe('File Permissions', () => {
    it('should create WAL file with mode 0600', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      store.create(manifest, addresses);

      const stats = fs.statSync(walPath(dir));
      // On Linux, check the permission bits (ignore file type bits)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('Clone Isolation', () => {
    it('should return cloned records that do not affect internal state', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const record = store.create(manifest, addresses);
      record.state = SwapState.COMPLETED; // Mutate the returned clone
      record.manifest.timeout = 99999;

      const found = store.findBySwapId(manifest.swap_id);
      expect(found?.state).toBe(SwapState.ANNOUNCED); // Internal state unchanged
      expect(found?.manifest.timeout).toBe(manifest.timeout);
    });
  });

  describe('Address Normalization', () => {
    it('should normalize DIRECT:// addresses on create', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      const manifest = createTestManifest();
      const addresses: ResolvedAddresses = {
        partyA: 'DIRECT://AABBCC',
        partyB: 'DIRECT://DDEEFF',
      };

      const record = store.create(manifest, addresses);
      expect(record.resolved_party_a_address).toBe('DIRECT://aabbcc');
      expect(record.resolved_party_b_address).toBe('DIRECT://ddeeff');
    });
  });

  describe('Empty WAL', () => {
    it('should handle empty WAL file gracefully', () => {
      const dir = makeTmpDir();
      fs.writeFileSync(walPath(dir), '', { mode: 0o600 });

      const store = new DurableSwapStateStore(dir);
      expect(store.findNonTerminal()).toHaveLength(0);
      expect(store.countNonTerminal()).toBe(0);
    });

    it('should handle missing WAL file gracefully', () => {
      const dir = makeTmpDir();
      const store = new DurableSwapStateStore(dir);
      expect(store.findNonTerminal()).toHaveLength(0);
      expect(store.countNonTerminal()).toBe(0);
    });
  });
});
