# Escrow Service Architecture — Invoice-Based Design

## Overview

The escrow service executes currency swaps on the Unicity network by acting as a trusted intermediary. Two parties exchange tokens carrying different currencies at agreed-upon values. This document describes the redesigned architecture that replaces the custom payment-tracking stack (PostgreSQL + Redis) with the sphere-sdk AccountingModule's invoice lifecycle.

**Core insight:** A single swap maps to **three invoices** — one deposit invoice (collecting both parties' contributions) and two payout invoices (delivering cross-currency amounts).

```
                    ┌─────────────────────┐
                    │   SwapOrchestrator   │
                    │   (swap lifecycle)   │
                    └─────────┬───────────┘
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
    ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
    │  Invoice     │   │  Timeout    │   │  Message    │
    │  Manager     │   │  Manager    │   │  Handler    │
    │  (Accounting │   │  (app-level │   │  (DM API)   │
    │   Module)    │   │   timers)   │   │             │
    └──────┬──────┘   └─────────────┘   └─────────────┘
           │
    ┌──────▼──────┐
    │  SwapState   │
    │  Store       │
    │  (simplified)│
    └─────────────┘
```

## Components

### SwapOrchestrator

Central coordinator for the swap lifecycle. Reacts to events from the InvoiceManager and TimeoutManager to drive state transitions. Replaces the combined responsibilities of PaymentProcessor and ConclusionProcessor.

Responsibilities:
- Receives swap manifest announcements from MessageHandler
- Creates deposit invoices via InvoiceManager
- Monitors deposit invoice events to detect coverage
- Creates and pays payout invoices on coverage
- Handles timeout-triggered cancellation
- Persists swap state transitions to SwapStateStore

### InvoiceManager

Thin wrapper around the AccountingModule. Exposes swap-specific operations while delegating all invoice lifecycle, balance tracking, and payment attribution to the SDK.

Key AccountingModule methods used:

| Operation | SDK Method | Context |
|---|---|---|
| Create deposit invoice | `createInvoice()` | On manifest announcement |
| Monitor payments | `invoice:payment` event | Deposit tracking |
| Check coverage | `invoice:covered` event | Both deposits received |
| Get balance details | `getInvoiceStatus()` | Per-sender validation |
| Close deposit invoice | `closeInvoice()` | After coverage confirmed |
| Cancel on timeout | `cancelInvoice(invoiceId, { autoReturn: true })` | Timeout expiry |
| Return wrong-sender | `returnInvoicePayment(invoiceId, { recipient, amount, coinId, freeText? })` | Sender validation bounce |
| Create payout invoices | `createInvoice()` | Conclusion phase |
| Pay into payout invoices | `payInvoice(invoiceId, { targetIndex, assetIndex, amount? })` | Escrow pays out |
| Send receipts | `sendInvoiceReceipts()` | Post-payout confirmation |
| Import invoice tokens | `importInvoice()` | Receiving invoice tokens |
| List invoices | `getInvoices()` | Operational queries |
| Parse memo | `parseInvoiceMemo()` | Transfer attribution |

### TimeoutManager (Simplified)

Application-level timer that fires after `manifest.timeout` seconds from the first deposit event. The AccountingModule's `dueDate` field is **informational only** — it does not enforce payment rejection after expiry. The escrow service must enforce timeouts at the application level.

On timeout:
1. Calls `cancelInvoice(depositInvoiceId, { autoReturn: true })`
2. The AccountingModule handles returning all deposited funds to their original senders via the auto-return deduplication ledger
3. No manual RefundProcessor needed — auto-return covers all return logistics. The auto-return dedup ledger routes each return to `effectiveSender` (`refundAddress ?? senderAddress`). If a payer provided neither a `refundAddress` nor an unmasked `senderAddress`, auto-return has no destination and the return will fail; these funds require manual intervention.

### MessageHandler (Simplified)

Handles DM-based communication with swap parties. Reduced to:
- `announce` — receive manifest, trigger deposit invoice creation
- `deposit_instructions` — replaced by `invoice_delivery` (deliver invoice token)
- `status` — query swap state (delegates to SwapStateStore + InvoiceManager)
- `invoice_delivery` — deliver deposit/payout invoice tokens to parties
- `request_invoice` — re-deliver a lost invoice token to an authorized party

The current `deposit_instructions` response (returning escrow address + memo) is replaced by delivering the actual invoice token, which contains all payment information.

### SwapStateStore (Simplified)

Persists swap case metadata and state. The schema shrinks significantly because deposit tracking, transaction logging, and balance computation move into the AccountingModule.

**Retained fields:**
- `swap_id` — content-addressed hash of the manifest
- `manifest` — the full swap manifest
- `state` — current swap state
- `deposit_invoice_id` — the deposit invoice token ID
- `payout_a_invoice_id` — payout invoice for party A (nullable)
- `payout_b_invoice_id` — payout invoice for party B (nullable)
- `first_deposit_at` — timestamp for timeout calculation
- `timeout_at` — computed deadline
- `created_at`, `completed_at`, `error_message`
- `version` — optimistic concurrency

**Eliminated fields:** `party_a_deposited`, `party_b_deposited`, `party_a_coin_id`, `party_b_coin_id` — all derivable from `getInvoiceStatus()`.

## Deterministic Invoice IDs

Invoice IDs in the AccountingModule are `SHA-256(canonicalSerialize(InvoiceTerms))`. The `InvoiceTerms` type includes a `createdAt` timestamp. By default, `createInvoice()` sets `createdAt = Date.now()`, making each invocation produce a different ID even for identical logical invoices. This is problematic for crash recovery: if the process crashes between `createInvoice()` and the SwapStateStore write, re-creating the invoice on restart produces a **different** ID, orphaning the original.

### Target Design (Requires SDK Gap #8)

> **Status: Pending.** The design below requires SDK gap #8 (`createdAt` passthrough in `CreateInvoiceRequest` — see `docs/sdk-gaps.md` §8). Until gap #8 is merged into the SDK, the escrow uses the interim workaround described below. All `createInvoice({ createdAt: ... })` examples in this document and §Invoice Design are target behavior.

When gap #8 is available, the escrow passes `createdAt: swap.created_at` (the swap's announcement timestamp from SwapStateStore) to all `createInvoice()` calls. With this, all invoice terms are fully deterministic from swap state:

- **Deposit invoice ID** = `SHA-256(canonicalSerialize({ creator: escrowPubkey, createdAt: swap.created_at, dueDate: swap.created_at + timeout*1000, memo: "Escrow deposit for swap <swap_id>", targets: [...] }))`
- **Payout A invoice ID** = `SHA-256(canonicalSerialize({ creator: escrowPubkey, createdAt: swap.created_at, memo: "Swap <swap_id> payout to Party A", dueDate: undefined (serializes as null), targets: [{ address: resolvedPartyA, ... }] }))`
- **Payout B invoice ID** = `SHA-256(canonicalSerialize({ creator: escrowPubkey, createdAt: swap.created_at, memo: "Swap <swap_id> payout to Party B", dueDate: undefined (serializes as null), targets: [{ address: resolvedPartyB, ... }] }))`

**Collision resistance:** All three invoice types embed the `swap_id` in their memos: deposit (`"Escrow deposit for swap <swap_id>"`), payout A (`"Swap <swap_id> payout to Party A"`), and payout B (`"Swap <swap_id> payout to Party B"`). Since `swap_id` is a content-addressed hash of the manifest, this ensures unique invoice IDs across swaps. Any change to the memo format must preserve `swap_id` embedding in all three — it is load-bearing for collision prevention.

**Key invariant:** `swap.created_at` is the single source of truth for all invoice IDs derived from a swap. Any code path that creates an invoice without explicitly passing `createdAt: swap.created_at` will break the determinism guarantee. The `escrowChainPubkey` (the `creator` field) must also remain stable for the lifetime of in-flight swaps — key rotation invalidates all pre-computed IDs and is not supported while swaps are active.

**Address normalization:** All `targets[].address` values used in `deriveInvoiceId()` must be in the same case as the addresses passed to `createInvoice()`. The store normalizes party DIRECT:// addresses to lowercase via `normalizeDirectAddress()` (in `swap-state-store.ts`). The SDK's `canonicalSerialize()` is case-sensitive on addresses. Therefore:
- **Party addresses:** `deriveInvoiceId()` must use the stored (lowercased) addresses from `SwapRecord.resolved_party_a_address` / `resolved_party_b_address`, never freshly-resolved addresses that may be mixed-case.
- **Escrow address:** The escrow's own `escrowDirectAddress` (the deposit invoice target) must also be normalized to lowercase at startup. The `InvoiceManager` should apply `normalizeDirectAddress()` to the escrow identity address in its constructor and use the normalized value in all invoice terms construction.

**Note:** The `normalizeDirectAddress()` function in `swap-state-store.ts` is the correct store-internal normalization function. The legacy `normalizeAddress()` in `address.ts` is deprecated and should not be used — it performs the same lowercasing but its scope is display-only contexts.

The escrow can **pre-compute** expected invoice IDs without calling the SDK, and verify whether an invoice already exists via `getInvoiceStatus(expectedId)`. This eliminates the need for memo-based orphan scanning (see §Crash Recovery).

**Pre-computation helpers:**

```typescript
function deriveInvoiceId(terms: InvoiceTerms): string {
  return sha256Hex(canonicalSerialize(terms));
}

// Deposit invoice — REQUIRES SDK GAP #8
const expectedDepositId = deriveInvoiceId({
  creator: escrowChainPubkey,
  createdAt: swap.created_at,
  dueDate: swap.created_at + manifest.timeout * 1000,
  memo: `Escrow deposit for swap ${manifest.swap_id}`,
  targets: [{ address: escrowDirectAddress, assets: [...] }],
});

// Payout A invoice — REQUIRES SDK GAP #8
const expectedPayoutAId = deriveInvoiceId({
  creator: escrowChainPubkey,
  createdAt: swap.created_at,
  // dueDate omitted → serializes as null
  memo: `Swap ${manifest.swap_id} payout to Party A`,
  targets: [{ address: swap.resolved_party_a_address, assets: [
    { coin: [manifest.party_b_currency_to_change, manifest.party_b_value_to_change] }
  ] }],
});

// Payout B invoice — REQUIRES SDK GAP #8
const expectedPayoutBId = deriveInvoiceId({
  creator: escrowChainPubkey,
  createdAt: swap.created_at,
  memo: `Swap ${manifest.swap_id} payout to Party B`,
  targets: [{ address: swap.resolved_party_b_address, assets: [
    { coin: [manifest.party_a_currency_to_change, manifest.party_a_value_to_change] }
  ] }],
});
```

### Interim Behavior (Without Gap #8)

Until gap #8 is merged, invoice IDs are non-deterministic (`createdAt = Date.now()` varies per call). The escrow relies on two mechanisms:

1. **Persist-before-act:** Always write the invoice ID to SwapStateStore immediately after `createInvoice()` succeeds and before any dependent action (see §Persistence Ordering). If the store has the invoice ID on recovery, no re-derivation is needed.

2. **Memo-based orphan scanning:** If the store lacks the invoice ID (crash between `createInvoice()` and store write), scan `getInvoices()` for matching memos:
   - Deposit: `"Escrow deposit for swap <swap_id>"`
   - Payout A: `"Swap <swap_id> payout to Party A"`
   - Payout B: `"Swap <swap_id> payout to Party B"`

   If found, adopt the existing invoice (update the store with its ID). If not found, re-create (produces a new ID). This is O(N) in invoice count and relies on memo string conventions — the deterministic ID scheme (gap #8) eliminates both limitations.

**`INVOICE_ALREADY_EXISTS` scope:** This error code is a **same-process** guard only. The SDK's `invoiceTermsCache` is an in-memory `Map` that is cleared on restart. After a crash and restart, `createInvoice()` with identical terms will NOT throw `INVOICE_ALREADY_EXISTS` — it will attempt to mint a new token. The error fires only for duplicate calls within a running process (e.g., concurrent announce for the same swap). Crash recovery must use `getInvoiceStatus(expectedId)` (with gap #8) or memo scanning (without gap #8) to detect pre-existing invoices — not rely on catching `INVOICE_ALREADY_EXISTS`.

## Invoice Design

### Deposit Invoice

A single invoice with the escrow's address as the target, requesting two coin assets (one per party's contribution):

```typescript
const depositInvoice = await accounting.createInvoice({
  targets: [{
    address: escrowDirectAddress,  // DIRECT://...
    assets: [
      { coin: [manifest.party_a_currency_to_change, manifest.party_a_value_to_change] },
      { coin: [manifest.party_b_currency_to_change, manifest.party_b_value_to_change] },
    ],
  }],
  memo: `Escrow deposit for swap ${manifest.swap_id}`,
  dueDate: swap.created_at + manifest.timeout * 1000,  // informational only
  createdAt: swap.created_at,  // REQUIRES SDK GAP #8 — see §Deterministic Invoice IDs
});
```

Both parties pay into the same invoice. The AccountingModule tracks per-sender balances automatically via the invoice-transfer index. The escrow identifies which party side a payment covers by matching the **coin asset type** of the transferred token against the manifest's declared currencies — not by the sender's address. Anyone can deposit on behalf of a party; what matters is which currency slot the token fills.

### Payout Invoices

Two separate invoices, one per party. Each targets the receiving party's address with the counter-currency amount:

**Payout A** (party A receives party B's currency):
```typescript
const payoutA = await accounting.createInvoice({
  targets: [{
    address: partyADirectAddress,
    assets: [
      { coin: [manifest.party_b_currency_to_change, manifest.party_b_value_to_change] },
    ],
  }],
  memo: `Swap ${manifest.swap_id} payout to Party A`,
  createdAt: swap.created_at,  // REQUIRES SDK GAP #8 — see §Deterministic Invoice IDs
});
```

**Payout B** (party B receives party A's currency):
```typescript
const payoutB = await accounting.createInvoice({
  targets: [{
    address: partyBDirectAddress,
    assets: [
      { coin: [manifest.party_a_currency_to_change, manifest.party_a_value_to_change] },
    ],
  }],
  memo: `Swap ${manifest.swap_id} payout to Party B`,
  createdAt: swap.created_at,  // REQUIRES SDK GAP #8 — see §Deterministic Invoice IDs
});
```

The escrow pays into both payout invoices using `payInvoice()`, then delivers the invoice tokens to the parties so they can independently verify receipt.

## State Machine

```
ANNOUNCED
    │
    ▼  (createInvoice succeeds)
DEPOSIT_INVOICE_CREATED ─────────────────────────┐
    │                    \                       │
    │                     \(admin cancel)        │ (invoice:covered — both
    ▼  (invoice:payment)   \                     │  deposits arrive before
PARTIAL_DEPOSIT             ▼                    │  first event processed)
    │             \     TIMED_OUT                │
    │(invoice:     \(timeout) │                  │
    │ covered)      \         │                  │
    ▼                \        ▼ (cancelInvoice)  │
DEPOSIT_COVERED ◄─────────────────────────────────┘
    │                     CANCELLING
    ▼  (close + create        │
        payouts + pay)        ▼ (invoice:cancelled)
CONCLUDING                CANCELLED
    │
    ▼  (both payouts)
COMPLETED

(Any non-terminal state may also transition directly to FAILED
 on unrecoverable error — not shown for clarity.
 Note: CANCELLED swaps may have pending auto-return entries
 that need monitoring via setAutoReturn().)
```

**State transitions:**

| From | To | Trigger |
|---|---|---|
| `ANNOUNCED` | `DEPOSIT_INVOICE_CREATED` | `createInvoice()` succeeds |
| `DEPOSIT_INVOICE_CREATED` | `PARTIAL_DEPOSIT` | First `invoice:payment` event |
| `DEPOSIT_INVOICE_CREATED` | `DEPOSIT_COVERED` | `invoice:covered` event (both deposits arrive before first event processed) |
| `DEPOSIT_INVOICE_CREATED` | `TIMED_OUT` | Manual cancellation via admin API (the normal timeout timer only starts on first deposit, so this transition requires explicit operator intervention) |
| `PARTIAL_DEPOSIT` | `DEPOSIT_COVERED` | `invoice:covered` event |
| `PARTIAL_DEPOSIT` | `TIMED_OUT` | TimeoutManager fires |
| `DEPOSIT_COVERED` | `CONCLUDING` | Orchestrator starts conclusion |
| `CONCLUDING` | `COMPLETED` | Both payout invoices paid |
| `TIMED_OUT` | `CANCELLING` | `cancelInvoice()` called |
| `CANCELLING` | `CANCELLED` | `invoice:cancelled` event fires (during `cancelInvoice()`, before auto-return begins) |
| Any non-terminal | `FAILED` | Unrecoverable error (invoice creation failure, payout failure, persistence failure) |

## Event-Driven Flow

The SwapOrchestrator subscribes to AccountingModule events and maps them to swap state transitions:

### `invoice:payment`

Fired when a payment referencing the deposit invoice is received. The handler:

1. Looks up the swap by deposit invoice ID
2. Inspects `getInvoiceStatus()` and identifies which currency asset the incoming transfer funded by checking `targets[0].coinAssets[i]`. The side (party A or party B) is determined by the asset's currency type, **not** by the sender's address. Anyone may deposit on behalf of a side.
3. If the deposited token's currency does not match either `party_a_currency_to_change` or `party_b_currency_to_change`: calls `returnInvoicePayment()` to bounce with reason `WRONG_CURRENCY`
4. If first valid deposit: transitions to `PARTIAL_DEPOSIT`, starts timeout timer
5. Does NOT need to check coverage here — `invoice:covered` handles that

### `invoice:covered`

Fired when all requested assets in the deposit invoice reach their targets. The handler:

1. Verifies the invoice ID maps to an active swap
2. **State guard:** only proceed if swap is in `DEPOSIT_INVOICE_CREATED` or `PARTIAL_DEPOSIT` — ignore if already `DEPOSIT_COVERED` or later (idempotency)
3. **Re-validate per-currency coverage:** call `getInvoiceStatus()` and verify that `coinAssets[0]` (party A's currency) and `coinAssets[1]` (party B's currency) are each individually covered at the required amounts. The `invoice:covered` event only means the aggregate amounts are met — it does not guarantee that the two distinct currency slots are both individually satisfied (e.g., someone could have overpaid one currency while the other remains uncovered). If either slot is not individually covered at the correct threshold, do NOT proceed — bounce the wrong-currency payment and remain in `PARTIAL_DEPOSIT` (or `DEPOSIT_INVOICE_CREATED`). The `invoice:covered` event fires on every payment event where all targets meet their coverage thresholds, so it will fire again naturally once the correct currencies restore full coverage.
4. Transitions to `DEPOSIT_COVERED`
5. Cancels the timeout timer (if running)
6. Closes the deposit invoice: `closeInvoice(depositInvoiceId)` — do **not** pass `{autoReturn: true}` here. Surplus handling, if needed, should be done after payouts complete. Passing `autoReturn: true` on close would trigger surplus returns concurrently with payout `payInvoice()` calls, creating a race for the escrow's token balance.
7. Creates two payout invoices
8. **Persist state to SwapStateStore** as `CONCLUDING` with both payout invoice IDs **before** paying — this ensures crash recovery can resume payout even if the process dies mid-payment
9. Pays into both: `payInvoice(payoutAId, ...)` and `payInvoice(payoutBId, ...)`
10. Delivers payout invoice tokens to parties via DM
11. Transitions to `COMPLETED`

### `invoice:closed`

Fired when `closeInvoice()` completes (balances frozen). Used for internal bookkeeping; the orchestrator has already advanced state by this point.

### `invoice:cancelled`

Fired during `cancelInvoice()` execution, after balances are frozen and the terminal set is persisted, but **before** auto-return processing begins. The handler transitions the swap from `CANCELLING` to `CANCELLED`. Note: auto-return of deposited funds continues asynchronously after this event — individual return failures do not affect the swap state. CANCELLED swaps with pending auto-return entries can be monitored and retried via `setAutoReturn()`.

## Timeout Handling

The timeout timer is an application-level `setTimeout` (or persistent timer) that starts from the **first deposit event**, not from manifest submission.

**Why not rely on `dueDate`?** The AccountingModule's `dueDate` is informational — it causes the invoice state to show as `EXPIRED` but does **not** reject payments or trigger returns. The escrow needs hard enforcement:

```typescript
// On first invoice:payment event for this swap
const timeoutMs = manifest.timeout * 1000;
timeoutManager.schedule(swapId, timeoutMs, async () => {
  await accounting.cancelInvoice(depositInvoiceId, { autoReturn: true });
  // cancelInvoice freezes balances, fires invoice:cancelled event,
  // then begins auto-return (asynchronous, after event).
  // invoice:cancelled handler transitions CANCELLING → CANCELLED
});
```

**Race condition: coverage vs timeout.** If `invoice:covered` fires at nearly the same time as the timeout:
- The SwapOrchestrator uses swap state as the arbiter. If the swap has already transitioned to `DEPOSIT_COVERED`, the timeout callback is a no-op.
- If the timeout fires first and the swap transitions to `TIMED_OUT`, a subsequent `invoice:covered` is ignored (swap is no longer in `PARTIAL_DEPOSIT`).
- Both paths are safe because the escrow wraps `closeInvoice()` and `cancelInvoice()` in try-catch blocks. **Important semantic distinction:** catching `INVOICE_ALREADY_CLOSED` in the coverage path means "closure already happened, proceed." But catching `INVOICE_ALREADY_CANCELLED` in the coverage path means "the timeout won the race — abort conclusion, do NOT proceed to payout." Similarly, catching `INVOICE_ALREADY_CLOSED` in the timeout path means "coverage won the race — abort cancellation." The try-catch must distinguish between same-operation errors (safe to proceed) and opposite-operation errors (must abort the current path). The swap state guard is the primary arbiter; the try-catch is a safety net for the brief window between state check and SDK call.

## Deposit Validation

The deposit invoice accepts payments from anyone. Party identification is by **currency type**, not by sender address. The escrow's application-level validation is:

1. On `invoice:payment`, call `getInvoiceStatus(depositInvoiceId)`
2. Identify which currency asset the incoming transfer funded by inspecting `targets[0].coinAssets[i]`. Note: `targets[0]` is correct because the deposit invoice has a single target (the escrow address). Asset index 0 corresponds to `party_a_currency_to_change`; index 1 to `party_b_currency_to_change`.
3. If the deposited token's currency does not match either declared asset — i.e., the coin type falls outside both party A's and party B's expected currencies — call `returnInvoicePayment()` to bounce with reason `WRONG_CURRENCY`. This is the **only** bounce reason for deposit payments.

**Return routing:** The `recipient` parameter of `returnInvoicePayment()` must be `effectiveSender` (`refundAddress ?? senderAddress`), not raw `senderAddress`, because the SDK validates the balance cap against `senderBalances` keyed by `effectiveSender`. If both `refundAddress` and `senderAddress` are absent or null, auto-return has no destination — log for manual intervention.

**Masked predicates:** `InvoiceTransferRef.senderAddress` may be `null` when the sender uses a masked predicate. This does not affect validation — currency type is still determinable from the asset the transfer credited. The payment is accepted normally if the currency matches; surplus (overpayment) is returned to `effectiveSender` via the auto-return dedup ledger on timeout or close. If neither `refundAddress` nor `senderAddress` is present, surplus return will fail and require manual intervention.

**Address resolution:** Party addresses in the manifest may be nametags (`@alice`) or PROXY addresses. Resolution is still required for payout invoice target addresses and for DM authorization (associating a Nostr npub with a party role). Resolved DIRECT:// addresses are cached in the swap case at announcement time. Resolution is **not** used for deposit validation — currency type alone determines the party side.

## What Gets Eliminated

The following components are fully replaced by AccountingModule operations:

| Eliminated Component | Replacement |
|---|---|
| `PaymentProcessor` | `invoice:payment` event + `getInvoiceStatus()` + `returnInvoicePayment()` |
| `ConclusionProcessor` | `payInvoice()` into payout invoices |
| `RefundProcessor` | `cancelInvoice({ autoReturn: true })` |
| `DepositRepository` | AccountingModule's invoice-transfer index (§5.4) |
| `TransactionRepository` | AccountingModule's per-invoice ledger + frozen balances |
| Payment listener (custom) | AccountingModule's PaymentsModule event subscription |
| Payment sender (custom) | `payInvoice()` and `returnInvoicePayment()` |
| PostgreSQL deposit/tx tables | AccountingModule's StorageProvider |
| Redis distributed locks | AccountingModule's per-invoice async mutex (in-process only — see Deployment Constraint) |

## What Remains (Simplified)

| Component | Changes |
|---|---|
| **TimeoutManager** | Simplified — no longer manages refund logic, just fires `cancelInvoice()` |
| **MessageHandler** | Simplified — fewer message types, delivers invoice tokens instead of instructions |
| **SwapStateStore** | Simplified schema — no deposit tracking columns, just state + invoice IDs |
| **ManifestValidator** | Unchanged — still validates swap manifest structure and content-addressed ID |
| **SwapOrchestrator** | New — central coordinator replacing the distributed PaymentProcessor/ConclusionProcessor |

## Crash Recovery

### AccountingModule Built-in Recovery

The AccountingModule provides built-in crash recovery:

1. **Invoice-transfer index** — rebuilt from token transaction histories on `load()`. No separate persistence needed for payment attribution.
2. **Auto-return dedup ledger** — write-first intent log with `pending → completed | failed` lifecycle. On restart, pending entries are retried automatically during `AccountingModule.load()` (up to 5 times) — no manual retry logic is needed at the escrow level.
3. **Frozen balances** — persisted at terminal state (CLOSED/CANCELLED). Reconstructed from ledger entries if terminal-set entry exists but frozen snapshot is missing (storage reconciliation).
4. **Terminal sets** — CANCELLED_INVOICES and CLOSED_INVOICES persisted as arrays. Forward and inverse reconciliation on load ensures consistency.

### Escrow-Level Recovery

The SwapStateStore must persist swap state and invoice IDs at each transition. On startup:

1. Load all non-terminal swaps from SwapStateStore
2. For each swap, call `getInvoiceStatus(depositInvoiceId)` to determine actual invoice state
3. Reconcile based on (swap state, invoice state) pairs:

| Swap State | Invoice State | Recovery Action |
|---|---|---|
| `ANNOUNCED` | (no invoice) | Invoice creation failed or store write lost — re-create invoice |
| `DEPOSIT_INVOICE_CREATED` | `OPEN` | Normal — re-subscribe to events, no action needed |
| `DEPOSIT_INVOICE_CREATED` | `EXPIRED` | `dueDate` passed but no deposits arrived. Treat as equivalent to `OPEN` — the escrow enforces timeout at the application level, not via `dueDate`. Re-subscribe to events. |
| `DEPOSIT_INVOICE_CREATED` or `PARTIAL_DEPOSIT` | `PARTIAL` | Re-register timeout timer with remaining time, re-subscribe to events |
| `PARTIAL_DEPOSIT` | `EXPIRED` | `dueDate` passed with partial deposits. Treat as equivalent to `PARTIAL` — re-register timeout timer. Note: if the invoice becomes fully covered, the SDK state will be `COVERED` (which takes priority over `EXPIRED` in the state computation). |
| `DEPOSIT_INVOICE_CREATED` or `PARTIAL_DEPOSIT` | `COVERED` | Coverage achieved during crash — re-validate per-currency coverage (both `coinAssets[0]` and `coinAssets[1]` individually covered at their required amounts), then resume conclusion (step 5 of `invoice:covered` handler). The `COVERED` state is dynamically computed and may change if auto-returns execute between crash and recovery. |
| `PARTIAL_DEPOSIT` | `CLOSED` | Deposit closed unexpectedly with only partial coverage — investigate and transition to `FAILED` |
| `PARTIAL_DEPOSIT` | `CANCELLED` | Timeout fired during crash — transition to `CANCELLED` |
| `DEPOSIT_INVOICE_CREATED` | `CANCELLED` | Manual or unexpected cancellation before any deposit — transition to `CANCELLED` |
| `DEPOSIT_INVOICE_CREATED` | `CLOSED` | Deposit closed without the escrow tracking it — investigate and transition to `FAILED` |
| `DEPOSIT_COVERED` | `OPEN` or `PARTIAL` or `EXPIRED` | Coverage regressed during crash window — auto-returns or late return-direction transfers reduced `netCoveredAmount` below threshold. Re-validate per-currency coverage (check each `coinAssets[i]` individually). If both currency slots are still individually covered at the required amounts, proceed with conclusion. If not, revert swap to `PARTIAL_DEPOSIT`, re-subscribe to events, and re-register timeout with remaining time. |
| `DEPOSIT_COVERED` | `CANCELLED` | Deposit cancelled after coverage (e.g., admin action during crash window) — check if deposits were auto-returned (inspect auto-return dedup ledger). If all returned, transition to `CANCELLED`. If partially returned or no returns, transition to `FAILED` for manual intervention. |
| `DEPOSIT_COVERED` | `CLOSED` | Deposit closed before payouts created — create payout invoices if missing, persist as `CONCLUDING`, then proceed with payouts |
| `CONCLUDING` | `CLOSED` | Payouts may be partially complete — check each payout invoice individually (see below) |
| `TIMED_OUT` | any | Call `cancelInvoice()` — idempotent if already cancelled |
| `CANCELLING` | `CANCELLED` | Transition to `CANCELLED` |

4. **Orphaned invoice recovery:** If `createInvoice()` succeeded but the subsequent SwapStateStore write failed, the invoice exists in the AccountingModule but the swap record's `deposit_invoice_id` is null. On startup, for any swap in `ANNOUNCED` state with `deposit_invoice_id = null`:

   **With SDK gap #8 (target):** Re-derive the expected deposit invoice ID using `deriveInvoiceId()` with `createdAt: swap.created_at`. Call `getInvoiceStatus(expectedId)` — if found, adopt the invoice (update `deposit_invoice_id` in the store). If not found (`INVOICE_NOT_FOUND`), re-create — the deterministic `createdAt` ensures the same ID is produced. This eliminates the need for memo-based scanning.

   **Without gap #8 (interim):** Scan `getInvoices()` for invoices whose memo matches `"Escrow deposit for swap <swap_id>"`. If exactly one match is found, adopt its ID (update the store). If multiple matches are found (successive crashes each orphaned an invoice), adopt the one with the earliest `terms.createdAt` and log a warning identifying the duplicate(s) for manual cleanup. If not found, re-create (produces a new ID — the orphan is inert since no party has its token unless DM delivery occurred before the crash).

   The same pattern applies to payout invoices during `CONCLUDING` recovery: if `payout_a_invoice_id` or `payout_b_invoice_id` is null, use deterministic ID re-derivation (gap #8) or memo scanning (`"Swap <swap_id> payout to Party A"` / `"Swap <swap_id> payout to Party B"`) before creating a new invoice.

5. **Partial payout recovery** (swap in `CONCLUDING`): Check each payout invoice individually:
   - If `payout_a_invoice_id` exists: call `getInvoiceStatus()` — if not yet covered, re-pay via `payInvoice()`
   - If `payout_a_invoice_id` is null: create payout A invoice and pay
   - Repeat for payout B
   - **Critical: omit the `amount` parameter** when retrying `payInvoice()` during crash recovery. When `amount` is omitted, the SDK computes `remaining = requestedAmount - netCoveredAmount` and sends only the uncovered remainder. If the payout was already completed before the crash, `remaining` will be `0` and the SDK throws `INVOICE_INVALID_AMOUNT` (safe to catch as success). If an explicit `amount` is passed, the SDK sends that amount regardless of existing coverage — this bypasses the zero-remaining guard and causes a **double-payment**. The escrow must also catch `INVOICE_TERMINATED` (invoice already closed/cancelled) as a success condition, and `INVOICE_NOT_FOUND` (invoice token not loaded in AccountingModule after restart — re-import the payout invoice token via `importInvoice()`, then retry `payInvoice()`).

6. Re-register timeout timers for any `PARTIAL_DEPOSIT` swaps with remaining time

### Persistence Ordering

To minimize recovery complexity, the escrow follows a **persist-before-act** pattern:

1. Before `createInvoice()`: persist the swap in `ANNOUNCED` state with `deposit_invoice_id = null`. If `createInvoice()` succeeds, update the stored `deposit_invoice_id` to the actual value before delivering tokens. If the process crashes between `createInvoice()` and the update, orphaned invoice recovery (step 4 above) handles it — either via deterministic ID re-derivation (with gap #8) or memo-based scanning (without gap #8).
2. Before `payInvoice()` calls: persist state as `CONCLUDING` with both payout invoice IDs populated (note: this happens after `closeInvoice()` and payout invoice creation — see covered handler steps 6-7)
3. Before `cancelInvoice()`: persist state as `TIMED_OUT`

This ensures that on crash, the SwapStateStore always reflects the intended action, and the idempotent AccountingModule operations can safely resume.

The AccountingModule operations are **not** idempotent on terminal invoices. The escrow's crash recovery must wrap each SDK call in a try-catch that distinguishes **same-terminal** errors (safe to proceed) from **cross-terminal** errors (must reconcile):

**Same-terminal errors** — the operation already completed as intended. Safe to treat as success:
- `closeInvoice()` throws `INVOICE_ALREADY_CLOSED` → already closed, proceed
- `cancelInvoice()` throws `INVOICE_ALREADY_CANCELLED` → already cancelled, proceed
- `payInvoice()` throws `INVOICE_INVALID_AMOUNT` (remaining = 0) → already fully covered, proceed
- `payInvoice()` throws `INVOICE_TERMINATED` → invoice already closed/cancelled, proceed
- `createInvoice()` throws `INVOICE_ALREADY_EXISTS` → same terms already exist in this process (same-process guard only — does NOT fire after restart; see §Deterministic Invoice IDs)

**Cross-terminal errors** — a different outcome occurred. Do NOT treat as success; reconcile state:
- `closeInvoice()` throws `INVOICE_ALREADY_CANCELLED` → timeout won the race; abort conclusion, reconcile swap to `CANCELLED`
- `cancelInvoice()` throws `INVOICE_ALREADY_CLOSED` → coverage won the race; abort cancellation, reconcile swap to `DEPOSIT_COVERED` and resume conclusion

The recovery logic must always check which terminal state the invoice is actually in after catching a cross-terminal error, and reconcile the swap state accordingly.

**All other SDK errors** (non-terminal codes such as `NOT_INITIALIZED`, `MODULE_DESTROYED`, or aggregator network errors) are unrecoverable. The escrow catches them, logs the error, transitions the swap to `FAILED`, and notifies both parties (see protocol-spec §5 Failure States).

## Security Considerations

### Wrong-Currency Validation

Any address can pay the deposit invoice. The only validation the escrow performs on deposit payments is a **currency-type check**: if the deposited token's currency does not match either `party_a_currency_to_change` or `party_b_currency_to_change`, the payment is returned via `returnInvoicePayment()` with reason `WRONG_CURRENCY`. There is no sender identity check — anyone may contribute to either party's side.

### Nametag-to-DIRECT Resolution

If party addresses use nametags, the escrow resolves them to DIRECT:// addresses for invoice target creation. Resolution must happen at announcement time and be cached — nametag reassignment during a swap could cause party misidentification.

### Race Conditions

- **Coverage vs timeout:** Handled by swap state machine — only one can win
- **Duplicate announcements:** The escrow checks SwapStateStore for an existing swap with the same `swap_id` before creating a new invoice — if a swap already exists, it returns the existing swap case (`is_new: false`). For concurrent announce calls that both pass the store check (no await boundary between read and write), the store's idempotency guard in `create()` returns the existing record. If two concurrent calls both reach `createInvoice()`, with deterministic `createdAt` (gap #8) they produce the same ID and the SDK throws `INVOICE_ALREADY_EXISTS` within the same process (the escrow catches this as success). Without gap #8, different `Date.now()` values produce different IDs — the second invoice is orphaned but inert (the store records only the first).
- **Concurrent overpayment via TOCTOU race:** The per-invoice async mutex (`invoiceGates`) serializes the terminal-state check within `payInvoice()`, but the actual payment (`send()`) executes **outside** the gate to avoid blocking during network calls. Two concurrent `payInvoice()` calls that both pass the terminal check will both send. The escrow must prevent concurrent payout attempts at the application level by serializing the conclusion phase within SwapOrchestrator. The single-instance deployment constraint (see Deployment Constraint section) ensures no cross-process races. Per-sender balance tracking deduplicates by `transferId::coinId` for deposit-side tracking.

### Deployment Constraint: Single-Instance

The AccountingModule's per-invoice async mutex (`invoiceGates` in AccountingModule.ts) is an **in-process** `Map<string, Promise<void>>` — it serializes concurrent operations on the same invoice within a single Node.js process. It does **not** provide distributed locking across multiple processes or hosts.

**Consequence:** The escrow service must run as a **single instance**. Running multiple instances concurrently would bypass the per-invoice mutex, potentially causing:
- Double-payment of payout invoices
- Race conditions between sender validation and coverage transitions
- Inconsistent swap state across instances

If horizontal scaling is required in the future, the escrow must introduce its own distributed coordination (e.g., Redis-based advisory locks keyed by `swap_id`) or the AccountingModule must add a distributed locking adapter (see `docs/sdk-gaps.md` gap #6).

### Wrong-Currency Payment Flooding (DOS Mitigation)

Any address can pay the deposit invoice with any token. A malicious actor could flood the invoice with small wrong-currency payments, forcing the escrow to:
- Process an `invoice:payment` event for each payment
- Call `getInvoiceStatus()` to check the currency type
- Call `returnInvoicePayment()` to bounce each wrong-currency payment back

**Mitigations:**
- **Rate limiting:** The escrow should rate-limit `returnInvoicePayment()` calls per invoice (e.g., max 10 bounces per minute). Excess wrong-currency payments are logged but not immediately returned — they can be batch-returned later or on invoice cancellation via `autoReturn`.
- **Monitoring:** Log wrong-currency payment attempts with currency types for operational alerting.
- **Future SDK support:** An `allowedCurrencies` filter on `InvoiceRequestedAsset` (analogous to the existing `allowedSenders` gap) would eliminate this attack surface entirely by rejecting wrong-currency payments at the SDK level.

### Invoice Token Security

Invoice tokens are on-chain cryptographic objects. If a party loses their deposit invoice token, they cannot verify payout. The escrow must:
- Persist invoice tokens in its own storage
- Be prepared to re-deliver tokens via DM on request
- Payout invoice tokens must be delivered reliably — they are the party's proof of payment
