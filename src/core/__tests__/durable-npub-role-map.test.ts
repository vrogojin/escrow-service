import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DurableNpubRoleMap } from '../durable-npub-role-map.js';

describe('DurableNpubRoleMap', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npub-role-map-test-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const NPUB_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const NPUB_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const SWAP_ID = 'a'.repeat(64);
  const SWAP_ID_2 = 'b'.repeat(64);
  const ADDR_A = 'DIRECT://aaaa1111';
  const ADDR_B = 'DIRECT://bbbb2222';

  // =========================================================================
  // Basic register / getRole / getSwapIds
  // =========================================================================

  describe('register and getRole', () => {
    it('should register and retrieve a role', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);

      const role = map.getRole(NPUB_A, SWAP_ID);
      expect(role).toEqual({ role: 'A', directAddress: ADDR_A });
    });

    it('should return null for unregistered npub', () => {
      const map = new DurableNpubRoleMap(dataDir);
      expect(map.getRole(NPUB_A, SWAP_ID)).toBeNull();
    });

    it('should return null for registered npub but different swapId', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      expect(map.getRole(NPUB_A, SWAP_ID_2)).toBeNull();
    });

    it('should be idempotent for duplicate registrations', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);

      const role = map.getRole(NPUB_A, SWAP_ID);
      expect(role).toEqual({ role: 'A', directAddress: ADDR_A });

      // WAL should contain only one entry
      const walContent = fs.readFileSync(path.join(dataDir, 'npub-roles.wal'), 'utf-8');
      const lines = walContent.trim().split('\n');
      expect(lines).toHaveLength(1);
    });

    it('should support multiple swaps for the same npub', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map.register(NPUB_A, SWAP_ID_2, 'B', ADDR_A);

      expect(map.getRole(NPUB_A, SWAP_ID)).toEqual({ role: 'A', directAddress: ADDR_A });
      expect(map.getRole(NPUB_A, SWAP_ID_2)).toEqual({ role: 'B', directAddress: ADDR_A });
    });
  });

  describe('getSwapIds', () => {
    it('should return all swap IDs for a registered npub', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map.register(NPUB_A, SWAP_ID_2, 'B', ADDR_A);

      const ids = map.getSwapIds(NPUB_A);
      expect(ids).toHaveLength(2);
      expect(ids).toContain(SWAP_ID);
      expect(ids).toContain(SWAP_ID_2);
    });

    it('should return empty array for unregistered npub', () => {
      const map = new DurableNpubRoleMap(dataDir);
      expect(map.getSwapIds(NPUB_A)).toEqual([]);
    });
  });

  // =========================================================================
  // findNpub (reverse lookup)
  // =========================================================================

  describe('findNpub', () => {
    it('should find npub by swapId and party', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map.register(NPUB_B, SWAP_ID, 'B', ADDR_B);

      expect(map.findNpub(SWAP_ID, 'A')).toBe(NPUB_A);
      expect(map.findNpub(SWAP_ID, 'B')).toBe(NPUB_B);
    });

    it('should return null when no npub is registered for (swapId, party)', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);

      expect(map.findNpub(SWAP_ID, 'B')).toBeNull();
      expect(map.findNpub(SWAP_ID_2, 'A')).toBeNull();
    });
  });

  // =========================================================================
  // findNpubByAddress (address reverse lookup)
  // =========================================================================

  describe('findNpubByAddress', () => {
    it('should find npub by direct address', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);

      expect(map.findNpubByAddress(ADDR_A)).toBe(NPUB_A);
    });

    it('should perform case-insensitive lookup', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', 'DIRECT://AaBb1122');

      expect(map.findNpubByAddress('DIRECT://aabb1122')).toBe(NPUB_A);
      expect(map.findNpubByAddress('DIRECT://AABB1122')).toBe(NPUB_A);
    });

    it('should return null for unknown address', () => {
      const map = new DurableNpubRoleMap(dataDir);
      expect(map.findNpubByAddress('DIRECT://unknown')).toBeNull();
    });
  });

  // =========================================================================
  // WAL replay (persistence across restarts)
  // =========================================================================

  describe('WAL replay', () => {
    it('should restore state from WAL after re-instantiation', () => {
      const map1 = new DurableNpubRoleMap(dataDir);
      map1.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map1.register(NPUB_B, SWAP_ID, 'B', ADDR_B);

      // Create a new instance reading from the same WAL
      const map2 = new DurableNpubRoleMap(dataDir);

      expect(map2.getRole(NPUB_A, SWAP_ID)).toEqual({ role: 'A', directAddress: ADDR_A });
      expect(map2.getRole(NPUB_B, SWAP_ID)).toEqual({ role: 'B', directAddress: ADDR_B });
      expect(map2.findNpub(SWAP_ID, 'A')).toBe(NPUB_A);
      expect(map2.findNpub(SWAP_ID, 'B')).toBe(NPUB_B);
      expect(map2.findNpubByAddress(ADDR_A)).toBe(NPUB_A);
      expect(map2.findNpubByAddress(ADDR_B)).toBe(NPUB_B);
      expect(map2.getSwapIds(NPUB_A)).toEqual([SWAP_ID]);
    });

    it('should skip malformed WAL lines gracefully', () => {
      // Write a WAL with one good line and one bad line
      const walPath = path.join(dataDir, 'npub-roles.wal');
      const goodEntry = JSON.stringify({ npub: NPUB_A, swapId: SWAP_ID, party: 'A', directAddress: ADDR_A });
      const badLine = '{this is not valid json';
      fs.writeFileSync(walPath, goodEntry + '\n' + badLine + '\n', { mode: 0o600 });

      const map = new DurableNpubRoleMap(dataDir);
      expect(map.getRole(NPUB_A, SWAP_ID)).toEqual({ role: 'A', directAddress: ADDR_A });
    });

    it('should skip WAL lines with invalid fields', () => {
      const walPath = path.join(dataDir, 'npub-roles.wal');
      // Missing directAddress field (will be typeof undefined, not string)
      const badEntry = JSON.stringify({ npub: NPUB_A, swapId: SWAP_ID, party: 'A' });
      const goodEntry = JSON.stringify({ npub: NPUB_B, swapId: SWAP_ID, party: 'B', directAddress: ADDR_B });
      fs.writeFileSync(walPath, badEntry + '\n' + goodEntry + '\n', { mode: 0o600 });

      const map = new DurableNpubRoleMap(dataDir);
      expect(map.getRole(NPUB_A, SWAP_ID)).toBeNull();
      expect(map.getRole(NPUB_B, SWAP_ID)).toEqual({ role: 'B', directAddress: ADDR_B });
    });

    it('should handle truncated WAL (partial last line from crash)', () => {
      const walPath = path.join(dataDir, 'npub-roles.wal');
      const goodEntry = JSON.stringify({ npub: NPUB_A, swapId: SWAP_ID, party: 'A', directAddress: ADDR_A });
      // Simulate crash: truncated last line
      fs.writeFileSync(walPath, goodEntry + '\n' + '{"npub":"bb","swap', { mode: 0o600 });

      const map = new DurableNpubRoleMap(dataDir);
      expect(map.getRole(NPUB_A, SWAP_ID)).toEqual({ role: 'A', directAddress: ADDR_A });
    });

    it('should deduplicate entries during replay', () => {
      const walPath = path.join(dataDir, 'npub-roles.wal');
      const entry = JSON.stringify({ npub: NPUB_A, swapId: SWAP_ID, party: 'A', directAddress: ADDR_A });
      // Same entry written twice (e.g., replay after partial compaction)
      fs.writeFileSync(walPath, entry + '\n' + entry + '\n', { mode: 0o600 });

      const map = new DurableNpubRoleMap(dataDir);
      expect(map.getSwapIds(NPUB_A)).toHaveLength(1);
    });

    it('should work with empty WAL file', () => {
      const walPath = path.join(dataDir, 'npub-roles.wal');
      fs.writeFileSync(walPath, '', { mode: 0o600 });

      const map = new DurableNpubRoleMap(dataDir);
      expect(map.getSwapIds(NPUB_A)).toEqual([]);
    });

    it('should work when WAL file does not exist', () => {
      const map = new DurableNpubRoleMap(dataDir);
      expect(map.getSwapIds(NPUB_A)).toEqual([]);
    });
  });

  // =========================================================================
  // WAL file properties
  // =========================================================================

  describe('WAL file', () => {
    it('should create WAL file with 0o600 permissions', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);

      const walPath = path.join(dataDir, 'npub-roles.wal');
      const stats = fs.statSync(walPath);
      // Check file permissions (owner read+write only)
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('should append JSON lines to WAL on register', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map.register(NPUB_B, SWAP_ID, 'B', ADDR_B);

      const walPath = path.join(dataDir, 'npub-roles.wal');
      const content = fs.readFileSync(walPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      const entry1 = JSON.parse(lines[0]);
      expect(entry1).toEqual({ npub: NPUB_A, swapId: SWAP_ID, party: 'A', directAddress: ADDR_A });

      const entry2 = JSON.parse(lines[1]);
      expect(entry2).toEqual({ npub: NPUB_B, swapId: SWAP_ID, party: 'B', directAddress: ADDR_B });
    });
  });

  // =========================================================================
  // Compaction
  // =========================================================================

  describe('compact', () => {
    it('should remove entries for terminal swaps', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map.register(NPUB_B, SWAP_ID, 'B', ADDR_B);
      map.register(NPUB_A, SWAP_ID_2, 'A', ADDR_A);

      // Mark SWAP_ID as terminal
      map.compact((swapId) => swapId === SWAP_ID);

      // SWAP_ID entries should be gone
      expect(map.getRole(NPUB_A, SWAP_ID)).toBeNull();
      expect(map.getRole(NPUB_B, SWAP_ID)).toBeNull();
      expect(map.findNpub(SWAP_ID, 'A')).toBeNull();
      expect(map.findNpub(SWAP_ID, 'B')).toBeNull();

      // SWAP_ID_2 should survive
      expect(map.getRole(NPUB_A, SWAP_ID_2)).toEqual({ role: 'A', directAddress: ADDR_A });
      expect(map.findNpub(SWAP_ID_2, 'A')).toBe(NPUB_A);
    });

    it('should rewrite WAL file with only surviving entries', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map.register(NPUB_A, SWAP_ID_2, 'A', ADDR_A);

      map.compact((swapId) => swapId === SWAP_ID);

      const walPath = path.join(dataDir, 'npub-roles.wal');
      const content = fs.readFileSync(walPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const entry = JSON.parse(lines[0]);
      expect(entry.swapId).toBe(SWAP_ID_2);
    });

    it('should produce a WAL that replays correctly after compaction', () => {
      const map1 = new DurableNpubRoleMap(dataDir);
      map1.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map1.register(NPUB_B, SWAP_ID, 'B', ADDR_B);
      map1.register(NPUB_A, SWAP_ID_2, 'A', ADDR_A);

      map1.compact((swapId) => swapId === SWAP_ID);

      // Re-instantiate from compacted WAL
      const map2 = new DurableNpubRoleMap(dataDir);
      expect(map2.getRole(NPUB_A, SWAP_ID)).toBeNull();
      expect(map2.getRole(NPUB_A, SWAP_ID_2)).toEqual({ role: 'A', directAddress: ADDR_A });
      expect(map2.findNpub(SWAP_ID_2, 'A')).toBe(NPUB_A);
      expect(map2.findNpubByAddress(ADDR_A)).toBe(NPUB_A);
    });

    it('should handle compaction when all entries are terminal', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);

      map.compact(() => true);

      expect(map.getRole(NPUB_A, SWAP_ID)).toBeNull();
      expect(map.getSwapIds(NPUB_A)).toEqual([]);

      const walPath = path.join(dataDir, 'npub-roles.wal');
      const content = fs.readFileSync(walPath, 'utf-8');
      expect(content.trim()).toBe('');
    });

    it('should handle compaction when no entries are terminal', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);

      map.compact(() => false);

      expect(map.getRole(NPUB_A, SWAP_ID)).toEqual({ role: 'A', directAddress: ADDR_A });
    });

    it('should update address index correctly after compaction removes an entry', () => {
      const map = new DurableNpubRoleMap(dataDir);
      map.register(NPUB_A, SWAP_ID, 'A', ADDR_A);
      map.register(NPUB_B, SWAP_ID_2, 'B', ADDR_B);

      // Terminal: SWAP_ID_2 -> removes NPUB_B / ADDR_B
      map.compact((swapId) => swapId === SWAP_ID_2);

      expect(map.findNpubByAddress(ADDR_B)).toBeNull();
      expect(map.findNpubByAddress(ADDR_A)).toBe(NPUB_A);
    });
  });
});
