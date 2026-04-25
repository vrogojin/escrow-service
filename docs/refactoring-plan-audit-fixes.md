# Refactoring Plan: Audit Findings Fixes (Bugs #2-#11)

**Version:** 3 (post-steelman corrections applied)

## Overview

7 OPEN bugs from the audit report need fixes, organized in 3 implementation groups by dependency order.

---

## Group 1: Durable Persistence (Bugs #2, #3, #5) — CRITICAL

### Problem
All swap state and party authorization data is in-memory. Any restart = fund loss.

### Solution

#### New file: `src/core/durable-swap-state-store.ts`

Implements the `SwapStateStore` interface with WAL persistence. **Note:** The interface is extended with `countNonTerminal(): number` — all implementations (production, test helper) must be updated.

- **In-memory Map** for reads (same performance as `InMemorySwapStateStore`)
- **JSON Lines append-only WAL file** (`swaps.wal`) for durability
- `create()`: write WAL entry with full `SwapRecord` using `fs.openSync(path, 'a', 0o600)` + `fs.writeSync` + `fs.fsyncSync` for durability, then update in-memory map
- `updateState()`: same write pattern with full updated record
- **WAL entry validation on replay:** Each line is parsed and validated:
  - `swap_id` must be 64 hex chars
  - `state` must be a valid SwapState enum value
  - State transitions are checked in sequence (each update's new state must be a valid transition from the previous state for that swap)
  - Address formats validated via `isValidAddress()`
  - Malformed or invalid entries logged at ERROR level and skipped
- **CRC32 line checksum:** Each WAL line includes a `_crc` field with a CRC32 of the JSON payload (excluding the `_crc` field). Replay verifies the checksum to detect truncated writes.
- Invoice index rebuilt from swap records during replay (derived, not independently persisted)
- `compact()`: rewrite WAL as snapshot. Called on clean shutdown AND after crash recovery replay.
- **countNonTerminal(): number** — efficient counter (increment on create, decrement on terminal state transitions) to avoid full Map scan in maxPendingSwaps check. Self-healing: add `_recalculateNonTerminalCount()` called after `compact()` and WAL replay to prevent counter drift.
- Export `normalizeDirectAddress` (re-export from existing `swap-state-store.ts`)
- **File permissions:** Data directory created with `mode: 0o700`, WAL files opened with `mode: 0o600`
- **Filesystem constraint:** Document that WAL data directory MUST be on a local POSIX filesystem (ext4, xfs, btrfs). Log a startup warning if the path appears to be a network mount.

#### New file: `src/core/durable-npub-role-map.ts`

Implements the existing `NpubRoleMap` interface with WAL persistence.

- Same WAL pattern: `npub-roles.wal` in the same data directory
- `register()`: append WAL entry, update in-memory map (idempotency check before append)
- `getRole()`, `getSwapIds()`: read from in-memory map
- **New method: `findNpub(swapId, party): string | null`** — reverse lookup needed by messageSender
- Maintain reverse index `Map<string, string>` keyed by `${swapId}:${party}` → npub
- **New method: `findNpubByAddress(directAddress): string | null`** — reverse lookup for sendToAddress bounce notifications
- Maintain address-to-npub index populated during register()
- **WAL entry validation on replay:** Verify `directAddress` matches the corresponding swap record's `resolved_party_X_address` (requires swap store reference or cross-validation step)
- Constructor: replay WAL, populate forward, reverse, and address indexes
- `compact(isTerminal)`: rewrite with only entries for non-terminal swaps

#### Modified: `src/sphere/orchestrator-interfaces.ts`

Add to `NpubRoleMap` interface:
```typescript
findNpub(swapId: string, party: 'A' | 'B'): string | null;
findNpubByAddress?(directAddress: string): string | null; // optional — for bounce DM routing
```

#### Modified: `src/core/types.ts`

Add to `SwapStateStore` interface:
```typescript
countNonTerminal(): number;
```

#### Modified: `src/config.ts`

Add `dataDir: string` to Config (default: `process.env.ESCROW_DATA_DIR ?? './.escrow-data'`).

#### Modified: `src/index.ts`

- Replace `InMemorySwapStateStore` with `DurableSwapStateStore`
- Replace inline NpubRoleMap with `DurableNpubRoleMap`
- `fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })` early in `main()`
- In `setupGracefulShutdown`: add `stateStore.compact()` + `npubRoleStore.compact(...)` before `orchestrator.stop()`
- Pass `stateStore` and `npubRoleStore` to `setupGracefulShutdown`
- After `orchestrator.recoverSwaps()`: call `stateStore.compact()` to rewrite clean WAL after recovery

**NOT modified:** `src/core/swap-state-store.ts` (kept for test use)

---

## Group 2: Wire Stubs (Bugs #4, #7)

### Problem
messageSender and addressResolver are stubs. No DM notifications, no nametag resolution.

### Solution

#### Modified: `src/index.ts`

**Bug #4 — messageSender:**

**IMPORTANT (SDK limitation):** `sphere.resolve()` cannot reverse-resolve a DIRECT:// chain address to a transport pubkey. `sendToAddress` must use the `npubRoleMap`'s address-to-npub index as the primary routing mechanism. Fall back to best-effort logging when the address is unknown.

```typescript
messageSender: {
  sendToParty: async (swapId, party, message) => {
    const npub = npubRoleStore.findNpub(swapId, party);
    if (!npub) {
      logger.warn({ swapId, party }, 'No npub found for party — DM not sent');
      return;
    }
    try {
      await sphere.communications.sendDM(npub, JSON.stringify(message));
    } catch (err) {
      logger.warn({ err, swapId, party }, 'Failed to send DM to party');
    }
  },
  sendToAddress: async (address, message) => {
    // Primary: look up npub from the address-to-npub index (populated during announce)
    const npub = npubRoleStore.findNpubByAddress?.(address);
    if (npub) {
      try {
        await sphere.communications.sendDM(npub, JSON.stringify(message));
        return;
      } catch (err) {
        logger.warn({ err, address }, 'Failed to send DM via cached npub');
      }
    }
    // Fallback: third-party depositor — not in our role map. Bounce notifications
    // are undeliverable. Escalate to WARN for operator visibility.
    logger.warn({ address, type: (message as any).type }, 'Bounce DM undeliverable — sender not in role map');
  },
},
```

**Bug #7 — addressResolver:**
```typescript
addressResolver: {
  resolve: async (address) => {
    if (address.startsWith('DIRECT://')) return address;
    if (address.startsWith('PROXY://')) {
      logger.warn({ address }, 'PROXY:// address resolution not yet supported');
      return null;
    }
    try {
      const peer = await sphere.resolve(address);
      return peer?.directAddress ?? null;
    } catch (err) {
      logger.warn({ err, address }, 'Address resolution failed');
      return null;
    }
  },
},
```

---

## Group 3: New Features + Hardening (Bugs #6, #11)

### Bug #6 — Cancel DM Command

#### Modified: `src/core/state-machine.ts`

Add `CANCELLING` as valid transition from BOTH `ANNOUNCED` and `DEPOSIT_INVOICE_CREATED`:
```
ANNOUNCED → CANCELLING              (new: cancel before invoice creation)
DEPOSIT_INVOICE_CREATED → CANCELLING  (new: cancel before deposits)
```
The `CANCELLING → CANCELLED` transition already exists.

**Rationale for ANNOUNCED → CANCELLING:** If invoice creation fails, the swap is stuck in ANNOUNCED. Parties should be able to cancel it rather than waiting for a re-announce or manual intervention. When `deposit_invoice_id` is null, skip the `cancelDepositInvoice` call.

#### Modified: `src/core/swap-orchestrator.ts`

Add public method:
```typescript
async cancelSwap(swapId: string, requestingParty: 'A' | 'B'): Promise<{ success: boolean; reason?: string }>
```
Logic:
1. **Gate check:** If `announceGates.has(swapId)`, return `{ success: false, reason: 'Announce in progress for this swap' }`. This prevents cancel-during-announce orphaned invoices.
2. Load swap. Reject if not in `ANNOUNCED` or `DEPOSIT_INVOICE_CREATED` (no deposits received yet).
3. Transition to `CANCELLING` via CAS. If CAS fails (deposit arrived), return `{ success: false, reason: 'State changed during cancel — deposit may have arrived' }`.
4. If `deposit_invoice_id` is null (ANNOUNCED state cancel), transition directly `CANCELLING → CANCELLED`. Skip to step 8.
5. If `deposit_invoice_id` is not null, call `invoiceManager.cancelDepositInvoice(swap.deposit_invoice_id)`.
   - On success: the `invoice:cancelled` event handler transitions `CANCELLING → CANCELLED`.
   - On `INVOICE_ALREADY_CLOSED`: coverage won the race. Copy the timeout handler pattern: attempt CAS `CANCELLING → DEPOSIT_COVERED`. If CAS succeeds, coverage proceeds to conclusion. Return `{ success: false, reason: 'Deposit covered during cancel — swap will proceed to completion' }`. If CAS fails, another handler already advanced the state — return `{ success: false, reason: 'State changed during cancel' }`.
   - On `INVOICE_ALREADY_CANCELLED`: idempotent — the cancel already happened (e.g., timeout beat us). Return `{ success: true }`.
6. Wait briefly for the `invoice:cancelled` event to fire and transition to CANCELLED (or verify state).
7. Notify both parties via `_notifyBothParties()` with clear message: "Swap cancelled. Any deposits received will be automatically returned."
8. Return `{ success: true }`.

#### Modified: `src/sphere/orchestrator-interfaces.ts`

Add to `SwapOrchestrator` interface:
```typescript
cancelSwap(swapId: string, requestingParty: 'A' | 'B'): Promise<{ success: boolean; reason?: string }>;
```

#### Modified: `src/sphere/message-handler.ts`

Add `handleCancel` function:
1. Parse `swap_id`, validate format
2. Authorize via `authorizeNpub()`
3. Call `orchestrator.cancelSwap(swapId, role)`
4. Reply with `{ type: 'cancel_result', swap_id, success, reason }`

Add `'cancel'` case to DM dispatcher switch.

### Bug #11 — maxPendingSwaps Enforcement

#### Modified: `src/core/swap-orchestrator.ts`

Add `maxPendingSwaps?: number` to `SwapOrchestratorDeps` (**optional**, default 0 = no limit).

At top of `_announceImpl()`, before manifest validation:
```typescript
if (this.maxPendingSwaps > 0) {
  const count = this.stateStore.countNonTerminal();
  if (count >= this.maxPendingSwaps) {
    throw new SwapLimitError(`Pending swap limit reached (${this.maxPendingSwaps})`);
  }
}
```

Uses `countNonTerminal()` instead of `findNonTerminal().length` to avoid cloning all records.

#### Modified: `src/index.ts`

Pass `maxPendingSwaps: config.maxPendingSwaps` in orchestrator constructor.

---

## Implementation Order

```
Group 1 (Bugs #2, #3, #5)  →  Group 2 (Bugs #4, #7)  →  Group 3 (Bugs #6, #11)
```

- Group 2 depends on Group 1 (messageSender needs `findNpub` + `findNpubByAddress` on durable NpubRoleMap)
- Group 3 depends on Group 1 (cancel state must be durable)
- Groups 2 and 3 are independent of each other

---

## Test Strategy

### Group 1 Tests

**New: `src/core/__tests__/durable-swap-state-store.test.ts`**
- All existing `swap-state-store.test.ts` tests adapted for durable store (use temp directory)
- WAL replay correctness: write records, create new store instance from same WAL, verify state
- Crash simulation: write partial WAL line, verify replay skips it with error log
- CRC32 validation: tamper with line, verify replay rejects it
- Compaction: verify WAL file shrinks after compact()
- countNonTerminal: verify counter tracks create/updateState correctly
- File permissions: verify WAL file created with 0600

**New: `src/core/__tests__/durable-npub-role-map.test.ts`**
- register + getRole + getSwapIds tests with WAL persistence
- findNpub reverse lookup tests
- findNpubByAddress tests
- WAL replay correctness
- Compaction tests

**Modified: `src/__tests__/helpers/in-memory-swap-state-store.ts`**
- Add `countNonTerminal()` method (simple counter)

### Group 2 Tests

- Mock `sphere.communications.sendDM` and `sphere.resolve` in integration tests
- Verify sendToParty calls sendDM with correct npub
- Verify sendToAddress uses npubRoleMap address lookup (not sphere.resolve)
- Verify addressResolver delegates to sphere.resolve for @nametag
- Verify addressResolver rejects PROXY:// with warning

### Group 3 Tests

**swap-orchestrator.test.ts additions:**
- `cancelSwap` happy path: cancel in DEPOSIT_INVOICE_CREATED state
- `cancelSwap` happy path: cancel in ANNOUNCED state (no invoice to cancel)
- `cancelSwap` rejection: attempt cancel in PARTIAL_DEPOSIT state
- `cancelSwap` CAS failure: deposit arrives between state check and CAS
- `cancelSwap` coverage race: coverage wins between CANCELLING and cancelDepositInvoice
- maxPendingSwaps enforcement: fill to limit, verify next announce throws SwapLimitError
- maxPendingSwaps=0: no limit enforced (default behavior)

**message-handler.test.ts additions:**
- `handleCancel` happy path
- `handleCancel` unauthorized
- `handleCancel` invalid swap_id
- `handleCancel` swap not found

### Existing test updates
- `swap-orchestrator.test.ts`: add `maxPendingSwaps: 10000` to `setupOrchestrator` (one-line change)
- `message-handler.test.ts`: add `findNpub` + `cancelSwap` to mocks
- `in-memory-swap-state-store.ts` (test helper): add `countNonTerminal()` method
- All other test files: no changes expected

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| fsync latency on every write | Low | Acceptable for low-volume escrow; sync I/O documented |
| WAL corruption from crash-during-write | Low | CRC32 checksum per line; invalid lines logged + skipped |
| WAL grows unbounded | Low | Compact on shutdown + after crash recovery |
| WAL replay with corrupted/tampered entries | Medium | State transition validation + CRC32 during replay |
| sphere.resolve() failure in addressResolver | Medium | Catch + log + return null |
| sendToAddress can't reverse-resolve DIRECT:// | Addressed | Use npubRoleMap address-to-npub index instead of sphere.resolve() |
| Cancel race with deposit/coverage | Medium | CAS + state re-check before cancelDepositInvoice |
| Cancel griefing (single-party) | Low | Pre-deposit only; no funds at risk; notifications sent |
| maxPendingSwaps bypassed via announce-cancel cycling | Low | Per-npub rate limiting deferred (noted as future hardening) |
| Network filesystem (NFS/CIFS) WAL corruption | Medium | Document local POSIX FS requirement; startup warning |

---

## Review Corrections Applied (v1 → v2)

1. **CRITICAL (SDK):** Redesigned `sendToAddress` to use npubRoleMap address-to-npub index instead of `sphere.resolve()` (which can't reverse-resolve DIRECT:// addresses)
2. **CRITICAL (Security):** Added WAL entry validation during replay (state transitions, address formats, CRC32 checksum)
3. **BUG (Code Review):** Added `ANNOUNCED → CANCELLING` transition for swaps stuck without invoice
4. **BUG (Code Review):** Added state re-check before `cancelDepositInvoice` to handle coverage race
5. **BUG (Code Review):** Made `maxPendingSwaps` optional in deps (default 0 = no limit) to avoid breaking tests
6. **CONCERN (Code Review):** Added `countNonTerminal()` to SwapStateStore interface to avoid cloning all records
7. **CONCERN (Code Review):** Added WAL compaction after crash recovery (not just shutdown)
8. **WARNING (Security):** Added file permissions (0700 dir, 0600 files) and local filesystem requirement
9. **WARNING (SDK):** Added explicit `PROXY://` handling (warn + return null)
10. **WARNING (Security):** Documented single-party cancel as pre-deposit only; clear user messaging

### v2 → v3 (post-steelman)

11. **CRITICAL (Steelman):** Fixed cancel-vs-coverage TOCTOU race — cancelSwap now handles INVOICE_ALREADY_CLOSED with CAS contest pattern (copied from timeout handler)
12. **HIGH (Steelman):** Added announce gate check in cancelSwap — reject cancel if announce is in-flight for the same swap
13. **HIGH (Steelman):** Removed false "no interface changes" claim — countNonTerminal() IS an interface addition
14. **MEDIUM (Steelman):** Added self-healing `_recalculateNonTerminalCount()` for counter drift prevention
15. **MEDIUM (Steelman):** Escalated bounce-undeliverable log from INFO to WARN
16. **LOW (Steelman):** maxPendingSwaps check placement — accepted as tolerable off-by-N for DoS limit
17. **LOW (Steelman):** Plan should show exact VALID_TRANSITIONS diff — noted for implementer
