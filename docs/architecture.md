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
3. No manual RefundProcessor needed — auto-return covers all return logistics (given the unmasked-predicate precondition — see Deposit Validation). If a sender has `senderAddress === null` and no `refundAddress`, auto-return has no destination and the return will fail; these funds require manual intervention.

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
  dueDate: Date.now() + manifest.timeout * 1000,  // informational only
});
```

Both parties pay into the same invoice. The AccountingModule tracks per-sender balances automatically via the invoice-transfer index. The escrow validates that the correct party paid the correct currency by iterating `coinAssets[i].transfers` (the raw `InvoiceTransferRef[]` array) and matching each transfer's cryptographically-authenticated `senderAddress` against the resolved party addresses. **Do not use `senderBalances`** for identity verification — its keys are `effectiveSender` values (`refundAddress ?? senderAddress`), where `refundAddress` is self-asserted by the sender (not cryptographically verified).

**Precondition: unmasked predicates required.** The `InvoiceTransferRef.senderAddress` field is `string | null` — it is `null` when the sender uses a masked predicate. The escrow's deposit validation relies on `senderAddress` for identity verification, so **both parties must use unmasked predicates** (DIRECT:// addresses derived from their public keys). If a party uses a masked predicate, their `senderAddress` will be `null` and the escrow cannot verify their identity. This precondition must be enforced during manifest validation: the resolved DIRECT:// addresses for both parties must be non-null before proceeding.

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
2. Inspects `getInvoiceStatus()` and iterates `targets[0].coinAssets[i].transfers` to identify the sender via each transfer's `senderAddress` (the cryptographically-authenticated on-chain address — **not** `senderBalances`, whose keys are self-asserted `effectiveSender` values). Transfers with `senderAddress === null` (masked predicates) are treated as unknown senders and bounced.
3. Validates that the sender matches a swap party and paid the correct currency
4. If wrong sender or wrong currency: calls `returnInvoicePayment()` to bounce
5. If first valid deposit: transitions to `PARTIAL_DEPOSIT`, starts timeout timer
6. Does NOT need to check coverage here — `invoice:covered` handles that

### `invoice:covered`

Fired when all requested assets in the deposit invoice reach their targets. The handler:

1. Verifies the invoice ID maps to an active swap
2. **State guard:** only proceed if swap is in `DEPOSIT_INVOICE_CREATED` or `PARTIAL_DEPOSIT` — ignore if already `DEPOSIT_COVERED` or later (idempotency)
3. **Re-validate per-party coverage:** call `getInvoiceStatus()` and iterate `coinAssets[i].transfers` to verify that the correct party paid the correct currency using each transfer's `senderAddress` (not `senderBalances`). The `invoice:covered` event only means the aggregate amounts are met — it does not guarantee that the right senders paid the right assets. An unauthorized sender could have covered an asset before the bounce-back completed. If validation fails, do NOT proceed — return the unauthorized payment and remain in `PARTIAL_DEPOSIT` (or `DEPOSIT_INVOICE_CREATED`). The `invoice:covered` event fires on every payment event where all targets meet their coverage thresholds, so it will fire again naturally once the correct party's payment restores coverage.
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

The deposit invoice accepts payments from anyone — the AccountingModule does not have `allowedSenders` filtering (see `docs/sdk-gaps.md`). The escrow performs application-level sender validation:

1. On `invoice:payment`, call `getInvoiceStatus(depositInvoiceId)`
2. Iterate `targets[0].coinAssets[i].transfers` (the raw `InvoiceTransferRef[]` array) and use each transfer's `senderAddress` field to find the new sender. **Do not use `senderBalances`** — its keys are `effectiveSender` (`refundAddress ?? senderAddress`), where `refundAddress` is self-asserted by the sender (set via `inv.ra` in the on-chain message) without cryptographic proof of ownership. A malicious sender could set `inv.ra` to another party's address to impersonate them. The `senderAddress` is derived from the transfer's cryptographic signature and cannot be forged, but **can be `null`** for masked-predicate senders — treat `null` as an unknown sender and bounce. Note: `targets[0]` is correct because the deposit invoice has a single target (the escrow address).
3. Resolve the sender's DIRECT address to determine which party they are
4. If the sender is not party A or party B: `returnInvoicePayment()` to bounce back. **Important:** The `recipient` parameter must be the `effectiveSender` (`refundAddress ?? senderAddress`), not raw `senderAddress`, because the SDK's `returnInvoicePayment()` validates the balance cap against `senderBalances` which are keyed by `effectiveSender`. Using raw `senderAddress` when the sender provided a `refundAddress` would fail the balance cap check or send to the wrong address. Note: identity verification still uses `senderAddress` (cryptographic), but return routing uses `effectiveSender`.
5. If the sender paid the wrong currency (party A paid party B's currency): bounce back

**Address resolution:** Party addresses in the manifest may be nametags (`@alice`) or PROXY addresses. The AccountingModule tracks senders by their DIRECT:// address. The escrow must resolve manifest addresses to DIRECT:// for matching. Nametag resolution uses the sphere-sdk's nametag lookup; PROXY addresses resolve via the PROXY→DIRECT mapping.

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
| `DEPOSIT_INVOICE_CREATED` or `PARTIAL_DEPOSIT` | `COVERED` | Coverage achieved during crash — re-validate per-sender coverage (correct party paid correct currency via `senderAddress` in transfers), then resume conclusion (step 5 of `invoice:covered` handler). The `COVERED` state is dynamically computed and may change if auto-returns execute between crash and recovery. |
| `PARTIAL_DEPOSIT` | `CLOSED` | Deposit closed unexpectedly with only partial coverage — investigate and transition to `FAILED` |
| `PARTIAL_DEPOSIT` | `CANCELLED` | Timeout fired during crash — transition to `CANCELLED` |
| `DEPOSIT_INVOICE_CREATED` | `CANCELLED` | Manual or unexpected cancellation before any deposit — transition to `CANCELLED` |
| `DEPOSIT_INVOICE_CREATED` | `CLOSED` | Deposit closed without the escrow tracking it — investigate and transition to `FAILED` |
| `DEPOSIT_COVERED` | `CANCELLED` | Deposit cancelled after coverage (e.g., admin action during crash window) — check if deposits were auto-returned (inspect auto-return dedup ledger). If all returned, transition to `CANCELLED`. If partially returned or no returns, transition to `FAILED` for manual intervention. |
| `DEPOSIT_COVERED` | `CLOSED` | Deposit closed before payouts created — create payout invoices if missing, persist as `CONCLUDING`, then proceed with payouts |
| `CONCLUDING` | `CLOSED` | Payouts may be partially complete — check each payout invoice individually (see below) |
| `TIMED_OUT` | any | Call `cancelInvoice()` — idempotent if already cancelled |
| `CANCELLING` | `CANCELLED` | Transition to `CANCELLED` |

4. **Orphaned invoice detection:** If `createInvoice()` succeeded but the subsequent SwapStateStore write failed, the invoice exists in the AccountingModule but no swap references it. On startup, the escrow should scan `getInvoices()` for invoices whose memo matches `"Escrow deposit for swap <swap_id>"` but have no corresponding swap in SwapStateStore, and either adopt or cancel them.

5. **Partial payout recovery** (swap in `CONCLUDING`): Check each payout invoice individually:
   - If `payout_a_invoice_id` exists: call `getInvoiceStatus()` — if not yet covered, re-pay via `payInvoice()`
   - If `payout_a_invoice_id` is null: create payout A invoice and pay
   - Repeat for payout B
   - **Critical: omit the `amount` parameter** when retrying `payInvoice()` during crash recovery. When `amount` is omitted, the SDK computes `remaining = requestedAmount - netCoveredAmount` and sends only the uncovered remainder. If the payout was already completed before the crash, `remaining` will be `0` and the SDK throws `INVOICE_INVALID_AMOUNT` (safe to catch as success). If an explicit `amount` is passed, the SDK sends that amount regardless of existing coverage — this bypasses the zero-remaining guard and causes a **double-payment**. The escrow must also catch `INVOICE_TERMINATED` (invoice already closed/cancelled) as a success condition, and `INVOICE_NOT_FOUND` (invoice token not loaded in AccountingModule after restart — re-import the payout invoice token via `importInvoice()`, then retry `payInvoice()`).

6. Re-register timeout timers for any `PARTIAL_DEPOSIT` swaps with remaining time

### Persistence Ordering

To minimize recovery complexity, the escrow follows a **persist-before-act** pattern:

1. Before `createInvoice()`: persist the swap in `ANNOUNCED` state with `deposit_invoice_id = null`. If `createInvoice()` succeeds, update the stored `deposit_invoice_id` to the actual value before delivering tokens. If the process crashes between `createInvoice()` and the update, orphaned invoice detection (step 4 above) handles recovery.
2. Before `payInvoice()` calls: persist state as `CONCLUDING` with both payout invoice IDs populated (note: this happens after `closeInvoice()` and payout invoice creation — see covered handler steps 6-7)
3. Before `cancelInvoice()`: persist state as `TIMED_OUT`

This ensures that on crash, the SwapStateStore always reflects the intended action, and the idempotent AccountingModule operations can safely resume.

The AccountingModule operations are **not** idempotent on terminal invoices. The escrow's crash recovery must wrap each SDK call in a try-catch that handles these error codes:

- `closeInvoice()` throws `INVOICE_ALREADY_CLOSED` (already closed) or `INVOICE_ALREADY_CANCELLED` (cancelled by timeout/admin)
- `cancelInvoice()` throws `INVOICE_ALREADY_CANCELLED` (already cancelled) or `INVOICE_ALREADY_CLOSED` (coverage won the race)
- `payInvoice()` throws `INVOICE_INVALID_AMOUNT` (remaining = 0, fully covered) or `INVOICE_TERMINATED` (invoice already closed/cancelled)

All four error codes should be caught and treated as success conditions during crash recovery (the operation was already completed before the crash). However, cross-terminal errors (e.g., `INVOICE_ALREADY_CANCELLED` when trying to close) indicate a different outcome than expected — the recovery logic must check which terminal state the invoice is actually in and reconcile the swap state accordingly.

## Security Considerations

### Wrong-Sender Validation

Without `allowedSenders` on `InvoiceRequestedAsset` (see SDK gaps), any address can pay the deposit invoice. The escrow must:
- Check every `invoice:payment` event against the swap manifest's party addresses
- Immediately return unauthorized payments via `returnInvoicePayment()`
- Log unauthorized payment attempts for monitoring

### Nametag-to-DIRECT Resolution

If party addresses use nametags, the escrow resolves them to DIRECT:// addresses for invoice target creation. Resolution must happen at announcement time and be cached — nametag reassignment during a swap could cause party misidentification.

### Race Conditions

- **Coverage vs timeout:** Handled by swap state machine — only one can win
- **Duplicate announcements:** Invoice IDs are SHA-256 of canonical `InvoiceTerms`, which includes `createdAt` — so duplicate `createInvoice()` calls at different times produce **different** IDs. The escrow must check SwapStateStore for an existing swap with the same `swap_id` before creating a new invoice. If a swap already exists, return the existing swap case (`is_new: false`).
- **Concurrent overpayment via TOCTOU race:** The per-invoice async mutex (`invoiceGates`) serializes the terminal-state check within `payInvoice()`, but the actual payment (`send()`) executes **outside** the gate to avoid blocking during network calls. Two concurrent `payInvoice()` calls that both pass the terminal check will both send. The escrow must prevent concurrent payout attempts at the application level by serializing the conclusion phase within SwapOrchestrator. The single-instance deployment constraint (see Deployment Constraint section) ensures no cross-process races. Per-sender balance tracking deduplicates by `transferId::coinId` for deposit-side tracking.

### Deployment Constraint: Single-Instance

The AccountingModule's per-invoice async mutex (`invoiceGates` in AccountingModule.ts) is an **in-process** `Map<string, Promise<void>>` — it serializes concurrent operations on the same invoice within a single Node.js process. It does **not** provide distributed locking across multiple processes or hosts.

**Consequence:** The escrow service must run as a **single instance**. Running multiple instances concurrently would bypass the per-invoice mutex, potentially causing:
- Double-payment of payout invoices
- Race conditions between sender validation and coverage transitions
- Inconsistent swap state across instances

If horizontal scaling is required in the future, the escrow must introduce its own distributed coordination (e.g., Redis-based advisory locks keyed by `swap_id`) or the AccountingModule must add a distributed locking adapter (see `docs/sdk-gaps.md` gap #6).

### Unauthorized Payment Flooding (DOS Mitigation)

Without `allowedSenders` (see SDK gaps), any address can pay the deposit invoice. A malicious actor could flood the invoice with small unauthorized payments, forcing the escrow to:
- Process an `invoice:payment` event for each payment
- Call `getInvoiceStatus()` to identify the sender
- Call `returnInvoicePayment()` to bounce each payment back

**Mitigations:**
- **Rate limiting:** The escrow should rate-limit `returnInvoicePayment()` calls per invoice (e.g., max 10 bounces per minute). Excess unauthorized payments are logged but not immediately returned — they can be batch-returned later or on invoice cancellation via `autoReturn`.
- **Monitoring:** Log unauthorized payment attempts with sender addresses for operational alerting.
- **Future SDK support:** The `allowedSenders` gap (#1 in sdk-gaps.md) would eliminate this attack surface entirely by rejecting unauthorized payments at the SDK level.

### Invoice Token Security

Invoice tokens are on-chain cryptographic objects. If a party loses their deposit invoice token, they cannot verify payout. The escrow must:
- Persist invoice tokens in its own storage
- Be prepared to re-deliver tokens via DM on request
- Payout invoice tokens must be delivered reliably — they are the party's proof of payment
