# Escrow Service — Bug Report & Audit Findings

**Date:** 2026-03-19
**Source:** e2e CLI swap test + Opus code review + Opus security audit

---

## Status Tracker

| # | Severity | Status | Finding |
|---|----------|--------|---------|
| 1 | **Critical** | ✅ FIXED | Announce race → duplicate invoices (per-swap mutex + 60s timeout) |
| 2 | **Critical** | ✅ FIXED | Durable state store — WAL with CRC32 checksums + fsync |
| 3 | **Critical** | ✅ FIXED | Durable NpubRoleMap — WAL-backed with 3 indexes |
| 4 | **High** | ✅ FIXED | `messageSender` wired to `sendDM()` via role map |
| 5 | **High** | ✅ FIXED | Graceful shutdown compacts WAL + persists state |
| 6 | **Medium** | ✅ FIXED | Cancel DM command implemented |
| 7 | **Medium** | ✅ FIXED | Address resolver calls `sphere.resolve()` for nametags |
| 8 | **Medium** | 🟡 PARTIAL | Post-announce address verification added (v1 still accepted) |
| 9 | **Medium** | 🟡 NOTED | Amount values have no upper bound |
| 10 | **Medium** | 🟡 NOTED | v2 identity binding incomplete for predicate addresses (SDK gap) |
| 11 | **Low** | ✅ FIXED | `maxPendingSwaps` enforced with efficient counter |
| 12 | **Low** | 🟡 NOTED | Bounce rate limiter not per-sender |
| 13 | **Low** | 🟡 NOTED | Receive loop errors suppressed at debug level |
| 14 | **Low** | 🟡 NOTED | Duplicate currency via symbol/hash aliasing |
| 15 | **Info** | 🟡 NOTED | setTimeout drift on long timeouts |
| 16 | **Critical** | ✅ FIXED | `invoice:covered` accepted unconfirmed deposits — double-spend vulnerability |
| 17 | **Medium** | ✅ FIXED | coinId symbol↔hash mismatch in coverage verification and payout verification |
| 18 | **Medium** | ✅ FIXED | importInvoice rejected null dueDate (canonicalSerialize normalizes undefined→null) |

---

# CRITICAL: Announce Race Condition (FIXED)

## Summary

A race condition in `SwapOrchestrator.announce()` allowed concurrent DM processing to create **two different deposit invoices** for the same swap. This cascaded into: invoice token delivery failure, parties depositing into different invoices, swap stuck at `PARTIAL_DEPOSIT` forever.

## Fix Applied

Per-swap mutex (`announceGates` map) in `SwapOrchestrator.announce()` serializes concurrent announces for the same `swap_id`. The second announcer awaits the first, then returns the existing invoice. Includes 60s timeout and orphaned invoice cleanup in CAS loser path.

**Defense-in-depth (Option B) deferred:** Deterministic invoice ID derivation from `swap_id` requires SDK change (`AccountingModule.createInvoice()` to accept caller-provided `createdAt`). Tracked as SDK gap #8.

## Verification

Code review confirms: race fixed, invoice delivery works for both parties, deposit attribution works, no regressions to happy path, edge cases handled (restart, timeout, crash recovery).

---

# CRITICAL: In-Memory State Store (OPEN) {#bug-2}

## Description

`InMemorySwapStateStore` at `swap-state-store.ts:42` stores ALL swap records in a JavaScript `Map`. On process crash or restart, all swap state is lost permanently.

## Impact

If the escrow crashes at ANY point after deposits are received but before payouts complete, **both parties' deposits are trapped** in the escrow wallet with no record of which swap they belong to. The invoice tokens still exist in the Sphere wallet's AccountingModule, but the swap-to-invoice mapping is gone.

**This is a guaranteed fund-loss scenario on any unclean shutdown during active swaps.**

The `CrashRecoveryManager` exists but is useless: it calls `stateStore.findNonTerminal()`, which returns an empty list after restart because the in-memory store is empty.

## Fix Required

Replace `InMemorySwapStateStore` with a **durable storage backend**. Options:
1. Use the SDK's own `StorageProvider` (already available via `sphere.storage`) — key-value, simple
2. SQLite or LevelDB for richer queries
3. Minimum viable: write-ahead log (append JSON lines to a file on every `create()` and `updateState()`)

**Constraint:** The swap record MUST be persisted to disk BEFORE any external side effect (invoice creation, token transfer). The existing `SwapStateStore` interface is well-designed for this; only the implementation needs to change.

### Key References
- `swap-state-store.ts:42` — `InMemorySwapStateStore` class
- `index.ts:39` — `new InMemorySwapStateStore()` instantiation
- `crash-recovery-manager.ts` — `stateStore.findNonTerminal()` returns empty after restart

---

# CRITICAL: NpubRoleMap Not Persisted (OPEN) {#bug-3}

## Description

The `npubRoleMap` at `index.ts:82-99` is an in-memory `Map` that tracks which Nostr pubkey is authorized as party A or B for each swap. Populated only during `handleAnnounce`. Lost on restart.

## Impact

After restart, both legitimate parties are **permanently locked out** of all endpoints:
- `authorizeNpub()` returns null → status queries rejected with "Unauthorized"
- Invoice re-delivery (`request_invoice`) blocked
- Payout invoice delivery impossible

Re-announcing doesn't help: if the swap is in CONCLUDING or COMPLETED state, the orchestrator returns early at `swap-orchestrator.ts:354-373` without re-resolving the sender's identity, so the role map never gets populated.

## Fix Required

Either:
1. **Persist alongside SwapStateStore** — store `(npub, swapId, party, directAddress)` tuples durably
2. **Rebuild during crash recovery** — re-resolve `resolved_party_a_address` / `resolved_party_b_address` back to transport pubkeys via `sphere.resolve()`

Option 1 is simpler and more reliable (doesn't depend on relay availability at recovery time).

### Key References
- `index.ts:82-99` — in-memory NpubRoleMap
- `message-handler.ts:141-163` — `authorizeNpub()` check
- `swap-orchestrator.ts:354-373` — existing-swap early return (skips role registration)

---

# HIGH: MessageSender Stubs (OPEN) {#bug-4}

## Description

`messageSender.sendToParty` and `sendToAddress` at `index.ts:54-62` are stubs that only `logger.debug`. They never actually send DMs.

## Impact

These are called by the orchestrator for:
- **Payment confirmations** after payout (line 1349) — never delivered
- **Swap cancellation notifications** (line 912) — never delivered
- **Bounce notifications** for already-covered deposits (line 549) — never delivered
- **Payout invoice delivery** from orchestrator (line 1333-1346) — never delivered

Parties have no way to know their swap completed, failed, or timed out unless they manually poll via `status` DMs.

## Fix Required

Implement using `sphere.communications.sendDM()` + `npubRoleMap` for pubkey lookup:

```typescript
messageSender: {
  sendToParty: async (swapId, party, message) => {
    const entries = npubRoleMap.getSwapIds(/* need reverse lookup */);
    // Look up npub for (swapId, party) → sendDM(npub, JSON.stringify(message))
  },
  sendToAddress: async (address, message) => {
    const peer = await sphere.resolve(address);
    if (peer?.transportPubkey) {
      await sphere.communications.sendDM(peer.transportPubkey, JSON.stringify(message));
    }
  },
},
```

### Key References
- `index.ts:54-62` — stub implementations
- `swap-orchestrator.ts:1333-1349` — payout delivery calls
- `swap-orchestrator.ts:912` — cancellation notification call

---

# HIGH: Graceful Shutdown Doesn't Persist State (OPEN) {#bug-5}

## Description

`setupGracefulShutdown` at `index.ts:142-177` stops the message handler and orchestrator but does NOT persist the in-memory swap state. After `orchestrator.stop()` destroys the timeout manager, all timer state is also lost.

## Impact

Even a **clean `SIGTERM`** (e.g., during deployment) loses all swap state. Combined with Bug #2, every deployment or restart is a potential fund-loss event for active swaps.

## Fix Required

Add state persistence to shutdown sequence before calling `orchestrator.stop()`. Serialize all non-terminal swap records + NpubRoleMap to durable storage. This should be addressed together with Bug #2.

---

# MEDIUM: No Cancel DM Command (OPEN) {#bug-6}

## Description

The message handler at `message-handler.ts:652-668` supports `announce`, `status`, `request_invoice`, and `deposit_instructions` but no `cancel` command. Parties cannot voluntarily cancel a swap.

## Impact

If both parties want to cancel (e.g., wrong terms), they must wait the full timeout (up to 24 hours) for deposits to be returned. Ties up funds unnecessarily.

## Fix Required

Implement `cancel` DM command. Two options:
1. **Mutual consent** — both parties must request cancel for the same swapId
2. **Single-party pre-deposit** — allow cancel if no deposits received yet

---

# MEDIUM: Address Resolver Stub (OPEN) {#bug-7}

## Description

`addressResolver.resolve` at `index.ts:64-71` only passes through `DIRECT://` addresses. `@nametag` and `PROXY://` addresses return null.

## Impact

The escrow only works with `DIRECT://` addresses. Manifests with `@nametag` party addresses (valid per SDK validation) fail with confusing errors. The nametag re-verification in `_concludeSwap` and crash recovery never triggers.

## Fix Required

```typescript
addressResolver: {
  resolve: async (address) => {
    if (address.startsWith('DIRECT://')) return address;
    const peer = await sphere.resolve(address);
    return peer?.directAddress ?? null;
  },
},
```

---

# MEDIUM: v1 Protocol Third-Party Announce Leakage (NOTED) {#bug-8}

The message handler skips signature verification for v1 announces (`message-handler.ts:256-259`). A third party who intercepts the manifest can announce and learn the `swap_id` and `deposit_invoice_id`. The `authorizeNpub` back-check prevents status/invoice access, but the announce itself succeeds.

**Recommendation:** Make v2 mandatory, or require the announcer's resolved DIRECT address match a party address BEFORE creating the swap record.

---

# MEDIUM: Unbounded Amount Values (NOTED) {#bug-9}

Manifest validation (`AMOUNT_RE = /^[1-9][0-9]*$/`) accepts arbitrarily large integers. An attacker can submit impossible amounts, locking a swap slot until timeout.

**Recommendation:** Add maximum amount bound (e.g., `10^18`) in manifest validation.

---

# MEDIUM: v2 Identity Binding Incomplete for Predicate Addresses (NOTED) {#bug-10}

The v2 signature verification works for raw-pubkey DIRECT:// addresses but skips identity binding for predicate-derived addresses (76-char hex). Logs warning: "cannot verify binding without SDK support."

**Recommendation:** Known limitation (bugs/004). When SDK supports predicate address derivation, add the binding check.

---

# LOW: maxPendingSwaps Not Enforced (OPEN) {#bug-11}

Config has `maxPendingSwaps` (default 10000) and `SwapLimitError` exists, but no check in `announce()`. An attacker can create unbounded swap records, each minting an on-chain invoice and registering a timeout timer.

**Fix:** Add at top of `_announceImpl()`:
```typescript
if (this.stateStore.findNonTerminal().length >= config.maxPendingSwaps) {
  throw new SwapLimitError();
}
```

---

# LOW: Bounce Rate Limiter Not Per-Sender (NOTED) {#bug-12}

Rate limiter at `swap-orchestrator.ts:1381-1397` is keyed by `invoiceId`, not sender. A malicious actor spamming wrong-currency deposits triggers the limit for ALL senders.

**Recommendation:** Key by `${invoiceId}:${effectiveSender}`.

---

# LOW: Receive Loop Errors Suppressed (NOTED) {#bug-13}

The 5s receive loop at `index.ts:121-134` logs errors at `debug` level. Persistent transport failure is invisible to operators at default `info` log level.

**Recommendation:** Track consecutive failures, escalate to `warn` after threshold (e.g., 10 failures).

---

# LOW: Duplicate Currency via Symbol/Hash Aliasing (NOTED) {#bug-14}

Manifest validation uses exact string comparison for `party_a_currency !== party_b_currency`. An attacker could use symbol `"UCT"` for party A and the full hash coinId for party B — different strings but same token. Per-slot coverage check in `_onInvoiceCovered` catches this (one slot has zero), preventing conclusion.

**Recommendation:** Normalize currencies through token registry before comparison.

---

# INFO: setTimeout Drift on Long Timeouts (NOTED) {#bug-15}

`TimeoutManager` uses `setTimeout` for up to 86400s. Can drift by milliseconds to low seconds due to event loop latency. Within acceptable tolerance.

---

# Priority Order for Fixes

1. **Bug #2 + #5: Durable state store + persist on shutdown** — Without this, the escrow cannot safely hold funds. Every restart = potential fund loss.
2. **Bug #3: Persist NpubRoleMap** — Without this, parties are locked out after restart.
3. **Bug #4: Wire messageSender** — Without this, parties get no notifications.
4. **Bug #7: Wire address resolver** — Without this, @nametag addresses don't work.
5. **Bug #6: Cancel command** — Usability: parties shouldn't wait 24h to cancel.
6. **Bug #11: Enforce maxPendingSwaps** — DoS prevention.
7. Everything else is defense-in-depth or edge-case hardening.
