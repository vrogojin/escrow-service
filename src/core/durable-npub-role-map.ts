/**
 * DurableNpubRoleMap — WAL-backed implementation of NpubRoleMap.
 *
 * Provides crash-durable persistence of npub-to-(swapId, party, directAddress)
 * associations using a JSON Lines append-only WAL file.
 *
 * Three in-memory indexes are maintained for fast lookups:
 * - Forward map: npub -> entries[] (same structure as the inline implementation)
 * - Reverse index: "${swapId}:${party}" -> npub
 * - Address index: lowercase directAddress -> npub
 *
 * WAL file: `npub-roles.wal` in the configured data directory.
 * Each line is a JSON object: { npub, swapId, party, directAddress }
 *
 * File permissions: WAL file is opened with mode 0o600.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NpubRoleMap } from '../sphere/orchestrator-interfaces.js';
import { logger } from '../utils/logger.js';

/** Shape of a single WAL entry (one JSON line). */
interface WalEntry {
  npub: string;
  swapId: string;
  party: 'A' | 'B';
  directAddress: string;
}

/** Shape of an in-memory forward-map entry. */
interface RoleEntry {
  swapId: string;
  party: 'A' | 'B';
  directAddress: string;
}

export class DurableNpubRoleMap implements NpubRoleMap {
  private readonly walPath: string;

  /** Forward map: npub -> list of (swapId, party, directAddress). */
  private readonly entries = new Map<string, RoleEntry[]>();

  /** Reverse index: "${swapId}:${party}" -> npub. */
  private readonly reverseIndex = new Map<string, string>();

  /** Address index: lowercase directAddress -> npub. */
  private readonly addressIndex = new Map<string, string>();

  /**
   * @param dataDir - Directory for the WAL file. Must already exist.
   */
  constructor(private readonly dataDir: string) {
    this.walPath = path.join(dataDir, 'npub-roles.wal');
    this._replayWal();
  }

  // ---------------------------------------------------------------------------
  // NpubRoleMap interface
  // ---------------------------------------------------------------------------

  register(npub: string, swapId: string, party: 'A' | 'B', directAddress: string): void {
    // Idempotency: skip if already registered with same (npub, swapId, party).
    const existing = this.entries.get(npub);
    if (existing?.some((e) => e.swapId === swapId && e.party === party)) {
      return;
    }

    // Persist to WAL before updating in-memory state.
    const walEntry: WalEntry = { npub, swapId, party, directAddress };
    this._appendWal(walEntry);

    // Update in-memory indexes.
    this._indexEntry(npub, { swapId, party, directAddress });
  }

  getRole(npub: string, swapId: string): { role: 'A' | 'B'; directAddress: string } | null {
    const list = this.entries.get(npub);
    const entry = list?.find((e) => e.swapId === swapId);
    return entry ? { role: entry.party, directAddress: entry.directAddress } : null;
  }

  getSwapIds(npub: string): string[] {
    return (this.entries.get(npub) ?? []).map((e) => e.swapId);
  }

  findNpub(swapId: string, party: 'A' | 'B'): string | null {
    return this.reverseIndex.get(`${swapId}:${party}`) ?? null;
  }

  findNpubByAddress(directAddress: string): string | null {
    return this.addressIndex.get(directAddress.toLowerCase()) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  /**
   * Rewrite the WAL to contain only entries for non-terminal swaps.
   *
   * @param isTerminal - Predicate that returns true when a swapId is in a
   *   terminal state (COMPLETED, CANCELLED, FAILED). Entries for terminal
   *   swaps are dropped from the WAL and from all in-memory indexes.
   */
  compact(isTerminal: (swapId: string) => boolean): void {
    // Collect entries to keep.
    const surviving: WalEntry[] = [];

    for (const [npub, list] of this.entries) {
      for (const entry of list) {
        if (!isTerminal(entry.swapId)) {
          surviving.push({
            npub,
            swapId: entry.swapId,
            party: entry.party,
            directAddress: entry.directAddress,
          });
        }
      }
    }

    // Atomic rewrite: write to temp file, fsync, rename.
    const tmpPath = this.walPath + '.tmp';
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      for (const entry of surviving) {
        const line = JSON.stringify(entry) + '\n';
        fs.writeSync(fd, line);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.walPath);

    // Rebuild all in-memory indexes from surviving entries.
    this.entries.clear();
    this.reverseIndex.clear();
    this.addressIndex.clear();
    for (const entry of surviving) {
      this._indexEntry(entry.npub, {
        swapId: entry.swapId,
        party: entry.party,
        directAddress: entry.directAddress,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Replay WAL from disk and populate all in-memory indexes. */
  private _replayWal(): void {
    if (!fs.existsSync(this.walPath)) {
      return;
    }

    const content = fs.readFileSync(this.walPath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;

      try {
        const entry = JSON.parse(line) as WalEntry;

        // Basic validation.
        if (
          typeof entry.npub !== 'string' ||
          typeof entry.swapId !== 'string' ||
          (entry.party !== 'A' && entry.party !== 'B') ||
          typeof entry.directAddress !== 'string'
        ) {
          logger.error(`[DurableNpubRoleMap] Skipping malformed WAL line ${i + 1}: invalid fields`);
          continue;
        }

        // Idempotency during replay: skip duplicates.
        const existing = this.entries.get(entry.npub);
        if (existing?.some((e) => e.swapId === entry.swapId && e.party === entry.party)) {
          continue;
        }

        this._indexEntry(entry.npub, {
          swapId: entry.swapId,
          party: entry.party,
          directAddress: entry.directAddress,
        });
      } catch {
        logger.error(`[DurableNpubRoleMap] Skipping malformed WAL line ${i + 1}: parse error`);
      }
    }
  }

  /** Append a single WAL entry with fsync for durability. */
  private _appendWal(entry: WalEntry): void {
    const line = JSON.stringify(entry) + '\n';
    const fd = fs.openSync(this.walPath, 'a', 0o600);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Add a role entry to all three in-memory indexes.
   * Does NOT check for duplicates — callers must guard beforehand.
   */
  private _indexEntry(npub: string, entry: RoleEntry): void {
    // Forward map.
    const list = this.entries.get(npub) ?? [];
    list.push(entry);
    this.entries.set(npub, list);

    // Reverse index.
    this.reverseIndex.set(`${entry.swapId}:${entry.party}`, npub);

    // Address index (case-insensitive).
    this.addressIndex.set(entry.directAddress.toLowerCase(), npub);
  }
}
