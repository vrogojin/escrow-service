# Refactoring Plan: Fix Announce Race Condition (Bug 001)

**Version:** 3 (post-steelman corrections applied)

## Problem

A race condition in `SwapOrchestrator.announce()` allows concurrent DM processing to create two different deposit invoices for the same swap. This cascades into: orphaned on-chain tokens, "Deposit invoice token not available" for one party, and deposits going into different invoices → swap stuck at PARTIAL_DEPOSIT forever.

**Root cause:** No per-swap serialization in `announce()`. The multi-second `await` in `_createDepositInvoiceForSwap()` (line 356: `invoiceManager.createDepositInvoice()`) yields to the event loop, allowing a second announcer to read the swap in ANNOUNCED state before the first announcer's `updateState()` at line 364 executes.

## Fix Design

### Option A: Per-swap announce gate (primary fix)

Add a `Map<string, Promise<AnnounceResult>>` to `SwapOrchestrator` that deduplicates concurrent `announce()` calls for the same `swap_id`. The second caller awaits the first caller's promise instead of starting a parallel invoice creation.

### Option B: Pass `createdAt` for deterministic `dueDate` (defense-in-depth)

Pass `swap.created_at` to `createDepositInvoice()` so the `dueDate` computation is deterministic. Full deterministic invoice IDs require SDK gap #8 to be resolved (the `createdAt` field in `createInvoice()` options is not yet supported by the SDK), but wiring `createdAt` through now provides partial defense-in-depth and prepares for the SDK fix.

**IMPORTANT:** Option B is currently **inert** for invoice ID deduplication — the SDK does not accept `createdAt` yet. The announce gate (Option A) is the **sole** protection against duplicate invoices until SDK gap #8 is resolved.

### Both options are applied together.

---

## Changes Per File

### 1. `src/core/swap-orchestrator.ts` (primary)

#### A. Add `announceGates` field

After the `bounceCounters` field (around line 122), add:

```typescript
/** Per-swap announce gate: deduplicates concurrent announce() calls for the same swap_id. */
private readonly announceGates = new Map<string, Promise<AnnounceResult>>();

/** Timeout for announce gate promises (prevents permanent gate block on hung SDK calls). */
private static readonly ANNOUNCE_GATE_TIMEOUT_MS = 60_000;
```

#### B. Refactor `announce()` into gate + `_announceImpl()`

The current `announce()` method body (lines 277-328, after the stopping guard) becomes `_announceImpl()`. The public `announce()` becomes a thin gate wrapper:

```typescript
async announce(manifest: SwapManifest, _announcerNpub?: string): Promise<AnnounceResult> {
  if (this.stopping || !this.started) {
    throw new Error('SwapOrchestrator is not running');
  }

  const swapId = manifest.swap_id;

  // Type guard: swap_id must be a string before using as gate key.
  // Manifest validation happens inside _announceImpl, but we need a safe
  // key before that. Non-string swap_id would cause type-coercion collisions.
  if (typeof swapId !== 'string') {
    throw new Error('manifest.swap_id must be a string');
  }

  // Per-swap announce gate: if an announce for this swap_id is already
  // in flight, wait for it to finish and return its result.
  // If the in-flight promise rejects, this caller also receives the error.
  // The gate is cleaned up via finally, so subsequent retries get a fresh attempt.
  const inflight = this.announceGates.get(swapId);
  if (inflight) {
    const result = await inflight;
    // is_new: false — from this caller's perspective, the swap was not created
    // by their call. No downstream code branches on is_new (it's only passed
    // through to the announce_result DM reply).
    return { ...result, is_new: false };
  }

  // Wrap _announceImpl with a timeout to prevent hung SDK calls from
  // permanently blocking the gate. If the timeout fires, the gate is
  // cleaned up and subsequent callers can retry.
  const promise = Promise.race([
    this._announceImpl(manifest),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Announce timed out')),
        SwapOrchestrator.ANNOUNCE_GATE_TIMEOUT_MS),
    ),
  ]);
  this.announceGates.set(swapId, promise);
  try {
    return await promise;
  } finally {
    this.announceGates.delete(swapId);
  }
}

// _announcerNpub is intentionally not forwarded — it is unused in the current
// implementation (prefixed with underscore). The public announce() signature
// preserves it for backward compatibility.
private async _announceImpl(manifest: SwapManifest): Promise<AnnounceResult> {
  // ... current body of announce() starting from "// 1. Validate manifest"
}
```

**Key design decisions:**
- Gate lives in `SwapOrchestrator` (not `MessageHandler`) — orchestrator owns swap lifecycle.
- `finally` block ensures cleanup on both success and failure.
- On failure: gate is cleared, subsequent retries get a fresh attempt.
- On success: second caller gets `is_new: false` (cosmetically correct).
- Gate is keyed on `manifest.swap_id` (deterministic, content-addressed).
- Type guard on `swap_id` before gate lookup prevents type-coercion collisions.
- `_announcerNpub` intentionally not forwarded to `_announceImpl` — unused parameter.
- 60s timeout on the gate prevents hung SDK calls from permanently blocking a swap.
  If `_announceImpl` continues after the timeout, it may create an invoice that
  nobody will read — this is equivalent to the CAS loser scenario and the orphaned
  invoice will be cleaned up by the CAS loser cancel logic or left for manual cleanup.

#### C. Drain announce gates in `_doStop()`

In `_doStop()`, after event unsubscription but before the `inFlight` drain loop, add:

```typescript
// Drain in-flight announce promises before proceeding with shutdown.
// Announce gate promises are NOT tracked in this.inFlight (which only tracks
// event handler promises). Gate drain must happen separately.
// Gates self-clean via finally blocks — no explicit clear() needed.
// Note: if an announce completes during this drain, it may create an invoice
// and update state. Any resulting invoice events are rejected by the stopping
// guard (line 152). Crash recovery handles missed events on next startup.
if (this.announceGates.size > 0) {
  await Promise.allSettled([...this.announceGates.values()]);
}
```

#### D. Pass `swap.created_at` to `createDepositInvoice()`

In `_createDepositInvoiceForSwap()` at line 356, change:

```typescript
// Before:
const result = await this.invoiceManager.createDepositInvoice(swap.manifest);

// After:
// IMPORTANT: The announce gate in announce() is the sole defense against
// duplicate invoices. This createdAt pass-through only affects dueDate
// computation until SDK gap #8 is resolved.
// Note for crash recovery: if swap.created_at is hours old, dueDate will
// be in the past. This is acceptable because dueDate is advisory — the
// escrow enforces timeouts via TimeoutManager independently.
const result = await this.invoiceManager.createDepositInvoice(swap.manifest, swap.created_at);
```

#### E. Cancel orphaned invoice in CAS loser path

At line 371 (CAS failure path in `_createDepositInvoiceForSwap`), cancel the orphaned invoice before returning:

```typescript
if (!updated) {
  // Cancel the orphaned invoice we just created — it will never be used.
  // Wrapped in catch so it does not block the return path.
  // If the orphaned invoice had already received a payment (possible if
  // the CAS loser's invoice was delivered to a party before the CAS resolved),
  // cancelInvoice with autoReturn:true will return the payment to the sender.
  this.invoiceManager.cancelDepositInvoice(result.invoiceId).catch((err) => {
    logger.error(
      { err, swap_id: swap.swap_id, orphanedInvoiceId: result.invoiceId },
      'Failed to cancel orphaned invoice from CAS loser path',
    );
  });

  const reloaded = this.stateStore.findBySwapId(swap.swap_id);
  if (reloaded?.deposit_invoice_id) {
    logger.warn(
      { swap_id: swap.swap_id, orphanedInvoiceId: result.invoiceId },
      'Concurrent announce won the race, returning existing invoice (orphaned invoice cancellation initiated)',
    );
    return {
      swap_id: reloaded.swap_id,
      deposit_invoice_id: reloaded.deposit_invoice_id,
      is_new: false,
    };
  }
  throw new Error(`Failed to persist deposit invoice ID for swap ${swap.swap_id}`);
}
```

### 2. `src/core/invoice-manager.ts` — NO CHANGES

The `createDepositInvoice` method already accepts `createdAt?: number` and uses it in the `dueDate` computation. The TODO comments about SDK gap #8 remain as-is.

### 3. `src/sphere/message-handler.ts` — NO CHANGES

The message handler dispatches DMs concurrently by design. Concurrency control belongs in the orchestrator.

### 4. `src/core/swap-state-store.ts` — NO CHANGES

The `create()` idempotency guard and `updateState()` CAS are already correct.

---

## Ordering Constraints

1. Add `announceGates` field + timeout constant (trivial, no behavioral change)
2. Add gate drain in `_doStop()`
3. Refactor `announce()` into gate + `_announceImpl()` — **the critical change**
4. Pass `swap.created_at` to `createDepositInvoice()` — independent
5. Cancel orphaned invoice in CAS loser path — independent
6. Update tests — must come after production changes

Steps 1-2 can be done in any order. Step 3 depends on step 1. Steps 4-5 are independent.

---

## Test Strategy

### CRITICAL: Mock must support artificial delay

The `MockAccountingModule.createInvoice()` is synchronous in its core logic. Without introducing an artificial delay, `Promise.all([announce(m), announce(m)])` will execute the first announce to completion before the second one starts — the gate will already be cleaned up. Tests 1, 2, 4, 5, and 7 would be **false greens**.

**Solution:** Add `_setCreateInvoiceDelay(ms: number)` to `MockAccountingModule` that inserts `await new Promise(r => setTimeout(r, ms))` before the invoice creation logic. All concurrency tests MUST use this delay (e.g., 50ms) to create a real concurrency window.

### New tests in `src/core/__tests__/swap-orchestrator.test.ts`

1. **"should deduplicate concurrent announce calls for the same swap_id"**
   - Set mock delay on `createDepositInvoice` (e.g., 50ms)
   - Fire two `announce()` calls concurrently with the same manifest via `Promise.all`
   - Assert `createDepositInvoice` was called exactly once (spy on the mock)
   - Assert both return the same `deposit_invoice_id`
   - Assert exactly one result has `is_new: true` (use `results.filter(r => r.is_new).length === 1`)

2. **"should clean up announce gate on failure so retries succeed"**
   - Set mock delay and make `createDepositInvoice` reject on first call
   - Fire two concurrent announces — both should reject with the same error
   - Fire a third announce sequentially — should succeed (gate cleared by `finally`)

3. **"should pass swap.created_at to createDepositInvoice"**
   - Spy on `createDepositInvoice` and verify `createdAt` parameter matches `swap.created_at`
   - Note: this verifies plumbing only; the SDK ignores the parameter until gap #8 is resolved

4. **"should not serialize announces for different swap_ids"**
   - Set mock delay on `createDepositInvoice`
   - Fire two concurrent announces with different manifests
   - Assert `createDepositInvoice` called twice (both proceed independently)
   - Assert both return `is_new: true`

5. **"should coalesce three concurrent announces for same swap_id"**
   - Set mock delay
   - Fire three concurrent announces with same manifest
   - Assert `createDepositInvoice` called exactly once
   - Assert all three get the same `deposit_invoice_id`

6. **"should cancel orphaned invoice in CAS loser path"**
   - Test via `(orchestrator as any)._createDepositInvoiceForSwap(swap)` to bypass gate
   - Call `_createDepositInvoiceForSwap` twice concurrently with same swap at version 1
   - Assert `cancelDepositInvoice` was called with the loser's invoice ID
   - Note: this is a defense-in-depth test that intentionally bypasses the primary protection

7. **"should reject manifest with non-string swap_id"**
   - Pass manifests with `swap_id` as `undefined`, `null`, `123`, `{}`
   - Assert each throws with "manifest.swap_id must be a string"

8. **"should drain in-flight announce before completing stop()"**
   - Set mock delay (e.g., 100ms)
   - Start an announce
   - Call `stop()` while announce is in-flight
   - Assert `stop()` does not resolve until announce completes
   - Assert subsequent announces throw "SwapOrchestrator is not running"

9. **"should reject announce with timeout error on hung SDK call"**
   - Override `ANNOUNCE_GATE_TIMEOUT_MS` to a short value (e.g., 100ms)
   - Make `createDepositInvoice` never resolve
   - Assert announce rejects with "Announce timed out"
   - Assert subsequent announce for same swap gets a fresh attempt

### New test in `src/__tests__/integration/swap-lifecycle.integration.test.ts`

10. **"concurrent announce for same swap produces identical deposit invoice"**
    - Set mock delay on `createDepositInvoice`
    - Two simulated parties announce concurrently
    - Assert only one invoice created, both get same ID

### Existing tests — should pass without modification

- State machine tests — no state machine changes
- Crash recovery tests — recovery calls `announce()` which goes through the gate
- Message handler tests — orchestrator is mocked; gate is internal to orchestrator
- Invoice manager tests — no invoice-manager changes

---

## Startup Ordering Verification

Verified in `src/index.ts`:
- Line 79: `await orchestrator.recoverSwaps()` — crash recovery completes BEFORE message handler starts
- Line 108: `messageHandler.start()` — DM processing begins AFTER recovery
- **Conclusion:** No race between crash recovery and DM-triggered announces during startup. This is safe.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Gate leak on unhandled rejection | Low | `finally` block always cleans up |
| Memory pressure from gate map | Negligible | Max 50 entries (MAX_CONCURRENT limit) |
| `is_new` semantics for second caller | Cosmetic | No downstream code branches on `is_new` |
| `dueDate` shift from using `swap.created_at` | Negligible | Sub-second difference in normal flow; advisory for crash recovery |
| Gate map lost on crash/restart | Safe | Crash recovery goes through `announce()`, gate serializes it |
| Orphaned invoice from CAS loser path | Defense-in-depth | Gate prevents this path; CAS loser now cancels orphaned invoice |
| Option B inert until SDK gap #8 | Documented | Gate is sole defense; prominent comments added |
| Gate key type coercion | Low | Type guard added before gate lookup |
| In-flight announce during shutdown | Low | `_doStop()` drains announce gates (separate from inFlight drain) |
| `dueDate` in past during crash recovery | Acceptable | `dueDate` is advisory; `TimeoutManager` is authoritative |
| Hung SDK call blocking gate | Low | 60s timeout via `Promise.race` clears the gate |
| Announce completing during shutdown drain | Acceptable | Events rejected by stopping guard; crash recovery handles on restart |

---

## Review Corrections Applied

### v1 → v2 (post-review)

1. **CRITICAL (Unicity SDK):** Added orphaned invoice cancellation in CAS loser path (change E)
2. **WARNING (Security):** Added type guard on `swap_id` before gate lookup (change B)
3. **CONCERN (Code Review):** Changed `_doStop()` from `clear()` to `Promise.allSettled` drain (change C)
4. **CONCERN (Code Review):** Documented `_announcerNpub` not forwarded intentionally (change B)
5. **CONCERN (Code Review):** Added missing test cases: per-swap independence, three-caller coalescing, CAS orphan cancel (tests 4-6)
6. **WARNING (Security):** Fixed incorrect statement about crash recovery not using `announce()` (risk table)
7. **WARNING (Unicity SDK):** Added prominent comment that Option B is inert until SDK gap #8
8. **SUGGESTION (Code Review):** Added comment about `dueDate` in past during crash recovery (change D)

### v2 → v3 (post-steelman)

9. **WARNING (Steelman-Gate):** Added 60s timeout on gate via `Promise.race` to prevent hung SDK calls from permanently blocking a swap (change A + B)
10. **CRITICAL (Steelman-Tests):** Added mock delay requirement — `MockAccountingModule` must support `_setCreateInvoiceDelay()` for concurrency tests to be valid (test strategy preamble)
11. **CRITICAL (Steelman-Tests):** CAS loser path test now uses `(orchestrator as any)._createDepositInvoiceForSwap()` to bypass gate (test 6)
12. **WARNING (Steelman-Tests):** Added test for non-string swap_id type guard (test 7)
13. **WARNING (Steelman-Tests):** Added test for shutdown drain behavior (test 8)
14. **WARNING (Steelman-Tests):** Added test for gate timeout (test 9)
15. **NOTE (Steelman-Gate):** Added comment explaining gate drain is separate from `inFlight` drain (change C)
16. **NOTE (Steelman-Gate):** Verified startup ordering — crash recovery completes before message handler starts (new section)
17. **NOTE (Steelman-Tests):** `is_new` assertion uses `filter().length === 1` not array indices (test 1)
