/**
 * DurableSwapStateStore — WAL-backed persistent implementation of SwapStateStore.
 *
 * Uses an append-only Write-Ahead Log (JSON Lines format) for durability, with
 * an in-memory Map for read performance. Each WAL entry includes a CRC32 checksum
 * for corruption detection.
 *
 * The WAL file (`swaps.wal`) resides in a configurable data directory and MUST
 * be on a local POSIX filesystem (ext4, xfs, btrfs). Network mounts (NFS, CIFS)
 * do not guarantee fsync semantics and may cause data loss.
 *
 * File permissions: WAL files are opened with mode 0o600 (owner read/write only).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// CRC32 implementation using the standard polynomial (0xEDB88320).
// node:zlib.crc32 is only available in Node.js 22+; this userland
// implementation works on Node 18+.
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c;
}
function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

import { SwapState, isTerminalState, isValidTransition } from './state-machine.js';
import { normalizeDirectAddress } from './swap-state-store.js';
import { logger } from '../utils/logger.js';
import type { SwapRecord, SwapStateStore, ResolvedAddresses } from './types.js';
import type { SwapManifest } from './manifest-validator.js';

export { normalizeDirectAddress } from './swap-state-store.js';

/** Shape of each WAL line (before CRC field is stripped for verification). */
interface WalEntry {
  op: 'create' | 'update';
  record: SwapRecord;
  _crc: number;
}

/** Regex for validating 64-character hex swap IDs. */
const SWAP_ID_RE = /^[0-9a-f]{64}$/;

/** Set of all valid SwapState enum values for fast membership check. */
const VALID_SWAP_STATES = new Set<string>(Object.values(SwapState));

/**
 * Validates that an address has a recognized format (DIRECT:// or known prefix).
 * Mirrors the validation used by the address resolver — only DIRECT:// addresses
 * are expected in persisted records since they are pre-resolved during announce.
 */
function isValidPersistedAddress(addr: string): boolean {
  return typeof addr === 'string' && addr.startsWith('DIRECT://') && addr.length > 'DIRECT://'.length;
}

/**
 * Computes CRC32 over a JSON string (UTF-8 encoded).
 */
function computeCrc32(json: string): number {
  return crc32(Buffer.from(json, 'utf-8'));
}

/**
 * Durable WAL-backed implementation of SwapStateStore.
 *
 * Thread-safety: Same single-threaded guarantee as InMemorySwapStateStore.
 * Synchronous filesystem writes (openSync + writeSync + fsyncSync) ensure
 * durability before the in-memory map is updated.
 */
export class DurableSwapStateStore implements SwapStateStore {
  private readonly swaps = new Map<string, SwapRecord>();
  private readonly invoiceIndex = new Map<string, string>();
  private readonly walPath: string;
  private nonTerminalCount = 0;

  /**
   * Creates a new DurableSwapStateStore.
   *
   * The constructor replays the existing WAL file (if any) to rebuild
   * in-memory state. Invalid or corrupted entries are logged and skipped.
   *
   * @param dataDir - Directory for the WAL file. Must exist and be writable.
   */
  constructor(dataDir: string) {
    this.walPath = path.join(dataDir, 'swaps.wal');
    this._warnIfNetworkMount(dataDir);
    this._replayWal();
    this._recalculateNonTerminalCount();
  }

  /**
   * Creates a new swap record in ANNOUNCED state.
   *
   * Writes a WAL entry with op:'create' before updating the in-memory map.
   * Idempotency: if a record already exists for this swap_id, returns it
   * without writing to the WAL.
   */
  create(manifest: SwapManifest, resolvedAddresses: ResolvedAddresses): SwapRecord {
    const existing = this.swaps.get(manifest.swap_id);
    if (existing !== undefined) {
      return this._clone(existing);
    }

    const record: SwapRecord = {
      swap_id: manifest.swap_id,
      manifest,
      state: SwapState.ANNOUNCED,
      deposit_invoice_id: null,
      payout_a_invoice_id: null,
      payout_b_invoice_id: null,
      resolved_party_a_address: normalizeDirectAddress(resolvedAddresses.partyA),
      resolved_party_b_address: normalizeDirectAddress(resolvedAddresses.partyB),
      first_deposit_at: null,
      timeout_at: null,
      created_at: Date.now(),
      completed_at: null,
      error_message: null,
      version: 1,
    };

    this._appendWal('create', record);
    this.swaps.set(manifest.swap_id, record);
    this.nonTerminalCount++;
    return this._clone(record);
  }

  /**
   * Finds a swap record by its swap_id.
   */
  findBySwapId(swapId: string): SwapRecord | null {
    const record = this.swaps.get(swapId);
    return record ? this._clone(record) : null;
  }

  /**
   * Finds a swap record by any of its invoice IDs (deposit, payout A, payout B).
   */
  findByInvoiceId(invoiceId: string): SwapRecord | null {
    const swapId = this.invoiceIndex.get(invoiceId);
    if (!swapId) return null;
    const record = this.swaps.get(swapId);
    return record ? this._clone(record) : null;
  }

  /**
   * Returns all non-terminal swap records (for crash recovery).
   */
  findNonTerminal(): SwapRecord[] {
    const results: SwapRecord[] = [];
    for (const record of this.swaps.values()) {
      if (!isTerminalState(record.state)) {
        results.push(this._clone(record));
      }
    }
    return results;
  }

  /**
   * Updates the swap state with optimistic locking.
   *
   * Writes a WAL entry with op:'update' before updating the in-memory map.
   * Returns null on version mismatch (CAS failure).
   */
  updateState(
    swapId: string,
    newState: SwapState,
    updates: Partial<SwapRecord>,
    expectedVersion: number,
  ): SwapRecord | null {
    const record = this.swaps.get(swapId);
    if (!record || record.version !== expectedVersion) {
      return null;
    }

    if (!isValidTransition(record.state, newState)) {
      throw new Error(`Invalid state transition: ${record.state} → ${newState} (swap ${swapId})`);
    }

    const wasTerminal = isTerminalState(record.state);

    // Build the updated record as a NEW object — do NOT mutate the existing
    // in-memory record before the WAL write succeeds. If _appendWal throws
    // (disk full, I/O error), the in-memory state must remain unchanged.
    const updated: SwapRecord = {
      ...record,
      state: newState,
      version: record.version + 1,
      manifest: { ...record.manifest },
    };

    // Apply updates — only allow safe mutable fields
    const ALLOWED_UPDATE_FIELDS = new Set([
      'deposit_invoice_id',
      'payout_a_invoice_id',
      'payout_b_invoice_id',
      'first_deposit_at',
      'timeout_at',
      'completed_at',
      'error_message',
    ]);

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'state' && key !== 'version' && value !== undefined) {
        if (!ALLOWED_UPDATE_FIELDS.has(key)) {
          throw new Error(`updateState: field '${key}' is not in the allowed update list (swap ${swapId})`);
        }
        (updated as unknown as Record<string, unknown>)[key] = value;
      }
    }

    // Persist BEFORE updating in-memory state (crash-safe ordering).
    this._appendWal('update', updated);

    // WAL write succeeded — now update in-memory state.
    this.swaps.set(swapId, updated);
    this._rebuildInvoiceIndex(swapId, updated);

    // Update non-terminal counter
    const isNowTerminal = isTerminalState(newState);
    if (!wasTerminal && isNowTerminal) {
      this.nonTerminalCount--;
    }

    return this._clone(updated);
  }

  /**
   * Returns the count of non-terminal (active) swap records.
   * Uses an efficient counter instead of scanning all records.
   */
  countNonTerminal(): number {
    return this.nonTerminalCount;
  }

  /**
   * Compacts the WAL by rewriting it as a snapshot.
   *
   * Each live record is written as a single 'create' entry. This reduces
   * WAL file size by eliminating superseded update entries.
   * Recalculates the non-terminal count after compaction for self-healing.
   */
  compact(): void {
    const tempPath = this.walPath + '.tmp';
    const fd = fs.openSync(tempPath, 'w', 0o600);

    try {
      for (const record of this.swaps.values()) {
        const entry = { op: 'create' as const, record };
        const json = JSON.stringify(entry);
        const crcValue = computeCrc32(json);
        const line = JSON.stringify({ ...entry, _crc: crcValue }) + '\n';
        fs.writeSync(fd, line);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempPath, this.walPath);
    this._recalculateNonTerminalCount();

    logger.info(
      { recordCount: this.swaps.size, nonTerminal: this.nonTerminalCount },
      'WAL compacted',
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Appends a WAL entry with CRC32 checksum using synchronous I/O.
   * The entry is fsynced to disk before returning.
   */
  private _appendWal(op: 'create' | 'update', record: SwapRecord): void {
    const entry = { op, record };
    const json = JSON.stringify(entry);
    const crcValue = computeCrc32(json);
    const line = JSON.stringify({ ...entry, _crc: crcValue }) + '\n';

    const fd = fs.openSync(this.walPath, 'a', 0o600);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Replays the WAL file to rebuild in-memory state.
   *
   * Each line is validated:
   * - JSON parse must succeed
   * - CRC32 must match
   * - swap_id must be 64 hex chars
   * - state must be a valid SwapState enum value
   * - Resolved addresses must be valid DIRECT:// addresses
   * - State transitions must be valid in sequence
   *
   * Invalid lines are logged at ERROR level and skipped.
   */
  private _replayWal(): void {
    if (!fs.existsSync(this.walPath)) {
      return;
    }

    const content = fs.readFileSync(this.walPath, 'utf-8');
    const lines = content.split('\n');
    let replayed = 0;
    let skipped = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue;

      // Parse JSON
      let parsed: WalEntry;
      try {
        parsed = JSON.parse(line) as WalEntry;
      } catch {
        logger.error({ lineNumber: i + 1 }, 'WAL replay: malformed JSON — skipping line');
        skipped++;
        continue;
      }

      // Validate CRC32
      const storedCrc = parsed._crc;
      if (typeof storedCrc !== 'number') {
        logger.error({ lineNumber: i + 1 }, 'WAL replay: missing _crc field — skipping line');
        skipped++;
        continue;
      }

      // Recompute CRC over JSON without _crc field
      const { _crc: _, ...entryWithoutCrc } = parsed;
      const expectedCrc = computeCrc32(JSON.stringify(entryWithoutCrc));
      if (storedCrc !== expectedCrc) {
        logger.error(
          { lineNumber: i + 1, storedCrc, expectedCrc },
          'WAL replay: CRC32 mismatch — skipping line',
        );
        skipped++;
        continue;
      }

      // Validate op
      if (parsed.op !== 'create' && parsed.op !== 'update') {
        logger.error({ lineNumber: i + 1, op: parsed.op }, 'WAL replay: invalid op — skipping line');
        skipped++;
        continue;
      }

      const record = parsed.record;
      if (!record || typeof record !== 'object') {
        logger.error({ lineNumber: i + 1 }, 'WAL replay: missing record — skipping line');
        skipped++;
        continue;
      }

      // Validate swap_id format
      if (!SWAP_ID_RE.test(record.swap_id)) {
        logger.error(
          { lineNumber: i + 1, swap_id: record.swap_id },
          'WAL replay: invalid swap_id format — skipping line',
        );
        skipped++;
        continue;
      }

      // Validate state enum
      if (!VALID_SWAP_STATES.has(record.state)) {
        logger.error(
          { lineNumber: i + 1, state: record.state },
          'WAL replay: invalid SwapState — skipping line',
        );
        skipped++;
        continue;
      }

      // Validate addresses
      if (
        !isValidPersistedAddress(record.resolved_party_a_address) ||
        !isValidPersistedAddress(record.resolved_party_b_address)
      ) {
        logger.error(
          { lineNumber: i + 1, swap_id: record.swap_id },
          'WAL replay: invalid resolved address — skipping line',
        );
        skipped++;
        continue;
      }

      // Validate state transition for updates
      if (parsed.op === 'update') {
        const existing = this.swaps.get(record.swap_id);
        if (!existing) {
          logger.error(
            { lineNumber: i + 1, swap_id: record.swap_id },
            'WAL replay: update entry with no preceding create — orphaned update, skipping',
          );
          skipped++;
          continue;
        }
        if (!isValidTransition(existing.state, record.state)) {
          logger.error(
            {
              lineNumber: i + 1,
              swap_id: record.swap_id,
              from: existing.state,
              to: record.state,
            },
            'WAL replay: invalid state transition — skipping line',
          );
          skipped++;
          continue;
        }
      }

      // Apply to in-memory state
      // Deep clone the record to own the data (detach from parsed JSON references)
      const cloned: SwapRecord = {
        ...record,
        manifest: { ...record.manifest },
      };
      this.swaps.set(cloned.swap_id, cloned);
      this._rebuildInvoiceIndex(cloned.swap_id, cloned);
      replayed++;
    }

    if (replayed > 0 || skipped > 0) {
      logger.info(
        { replayed, skipped, totalRecords: this.swaps.size },
        'WAL replay completed',
      );
    }
  }

  /**
   * Recalculates the non-terminal counter by scanning all records.
   * Called after WAL replay and compaction for self-healing against counter drift.
   */
  private _recalculateNonTerminalCount(): void {
    let count = 0;
    for (const record of this.swaps.values()) {
      if (!isTerminalState(record.state)) {
        count++;
      }
    }
    this.nonTerminalCount = count;
  }

  /**
   * Rebuilds the invoice reverse index for a single swap record.
   */
  private _rebuildInvoiceIndex(swapId: string, record: SwapRecord): void {
    // Remove all existing entries for this swap
    for (const [invoiceId, id] of this.invoiceIndex.entries()) {
      if (id === swapId) {
        this.invoiceIndex.delete(invoiceId);
      }
    }

    // Add current invoice IDs
    if (record.deposit_invoice_id) {
      this.invoiceIndex.set(record.deposit_invoice_id, swapId);
    }
    if (record.payout_a_invoice_id) {
      this.invoiceIndex.set(record.payout_a_invoice_id, swapId);
    }
    if (record.payout_b_invoice_id) {
      this.invoiceIndex.set(record.payout_b_invoice_id, swapId);
    }
  }

  /**
   * Returns a deep-enough clone of a SwapRecord.
   */
  private _clone(record: SwapRecord): SwapRecord {
    return {
      ...record,
      manifest: { ...record.manifest },
    };
  }

  /**
   * Logs a warning if the data directory appears to be on a network mount.
   * Heuristic: checks /proc/mounts on Linux for NFS/CIFS mount points.
   */
  private _warnIfNetworkMount(dataDir: string): void {
    try {
      if (!fs.existsSync('/proc/mounts')) return;
      const mounts = fs.readFileSync('/proc/mounts', 'utf-8');
      const resolved = fs.realpathSync(dataDir);
      for (const line of mounts.split('\n')) {
        const parts = line.split(' ');
        if (parts.length < 3) continue;
        const mountPoint = parts[1];
        const fsType = parts[2];
        if (
          resolved.startsWith(mountPoint) &&
          (fsType === 'nfs' || fsType === 'nfs4' || fsType === 'cifs' || fsType === 'smbfs')
        ) {
          logger.warn(
            { dataDir, fsType, mountPoint },
            'WAL data directory appears to be on a network filesystem — fsync guarantees may not hold',
          );
          return;
        }
      }
    } catch {
      // Best-effort check — ignore errors
    }
  }
}
