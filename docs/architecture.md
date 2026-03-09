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
| Cancel on timeout | `cancelInvoice({ autoReturn: true })` | Timeout expiry |
| Return wrong-sender | `returnInvoicePayment()` | Sender validation bounce |
| Create payout invoices | `createInvoice()` | Conclusion phase |
| Pay into payout invoices | `payInvoice()` | Escrow pays out |
| Send receipts | `sendInvoiceReceipts()` | Post-payout confirmation |
| Import invoice tokens | `importInvoice()` | Receiving invoice tokens |
| List invoices | `getInvoices()` | Operational queries |
| Parse memo | `parseInvoiceMemo()` | Transfer attribution |

### TimeoutManager (Simplified)

Application-level timer that fires after `manifest.timeout` seconds from the first deposit event. The AccountingModule's `dueDate` field is **informational only** — it does not enforce payment rejection after expiry. The escrow service must enforce timeouts at the application level.

On timeout:
1. Calls `cancelInvoice(depositInvoiceId, { autoReturn: true })`
2. The AccountingModule handles returning all deposited funds to their original senders via the auto-return deduplication ledger
3. No manual RefundProcessor needed — auto-return covers all return logistics

### MessageHandler (Simplified)

Handles DM-based communication with swap parties. Reduced to:
- `announce` — receive manifest, trigger deposit invoice creation
- `deposit_instructions` — replaced by `invoice_delivery` (deliver invoice token)
- `status` — query swap state (delegates to SwapStateStore + InvoiceManager)
- `invoice_delivery` — deliver deposit/payout invoice tokens to parties

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

Both parties pay into the same invoice. The AccountingModule tracks per-sender balances automatically via the invoice-transfer index. The escrow validates that the correct party paid the correct currency by inspecting `senderBalances` in the invoice status.

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
  memo: `Swap ${manifest.swap_id} payout`,
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
  memo: `Swap ${manifest.swap_id} payout`,
});
```

The escrow pays into both payout invoices using `payInvoice()`, then delivers the invoice tokens to the parties so they can independently verify receipt.

## State Machine

```
ANNOUNCED
    │
    ▼  (createInvoice succeeds)
DEPOSIT_INVOICE_CREATED
    │
    ▼  (invoice:payment — first deposit event)
PARTIAL_DEPOSIT ──────────────────────┐
    │                                 │ (timeout fires)
    ▼  (invoice:covered)              ▼
DEPOSIT_COVERED                   TIMED_OUT
    │                                 │
    ▼  (closeInvoice + create         ▼  (cancelInvoice w/ autoReturn)
        payout invoices)          CANCELLING
CONCLUDING                            │
    │                                 ▼  (auto-return complete)
    ▼  (both payouts paid)        CANCELLED
COMPLETED                             │
                                      ▼  (if auto-return fails)
                                  FAILED
```

**State transitions:**

| From | To | Trigger |
|---|---|---|
| `ANNOUNCED` | `DEPOSIT_INVOICE_CREATED` | `createInvoice()` succeeds |
| `DEPOSIT_INVOICE_CREATED` | `PARTIAL_DEPOSIT` | First `invoice:payment` event |
| `PARTIAL_DEPOSIT` | `DEPOSIT_COVERED` | `invoice:covered` event |
| `PARTIAL_DEPOSIT` | `TIMED_OUT` | TimeoutManager fires |
| `DEPOSIT_COVERED` | `CONCLUDING` | Orchestrator starts conclusion |
| `CONCLUDING` | `COMPLETED` | Both payout invoices paid |
| `TIMED_OUT` | `CANCELLING` | `cancelInvoice()` called |
| `CANCELLING` | `CANCELLED` | Auto-return completes |
| Any non-terminal | `FAILED` | Unrecoverable error |

## Event-Driven Flow

The SwapOrchestrator subscribes to AccountingModule events and maps them to swap state transitions:

### `invoice:payment`

Fired when a payment referencing the deposit invoice is received. The handler:

1. Looks up the swap by deposit invoice ID
2. Inspects `getInvoiceStatus()` to identify the sender via `senderBalances`
3. Validates that the sender matches a swap party and paid the correct currency
4. If wrong sender or wrong currency: calls `returnInvoicePayment()` to bounce
5. If first valid deposit: transitions to `PARTIAL_DEPOSIT`, starts timeout timer
6. Does NOT need to check coverage here — `invoice:covered` handles that

### `invoice:covered`

Fired when all requested assets in the deposit invoice reach their targets. The handler:

1. Verifies the invoice ID maps to an active swap
2. Transitions to `DEPOSIT_COVERED`
3. Closes the deposit invoice: `closeInvoice(depositInvoiceId)`
4. Creates two payout invoices
5. Pays into both: `payInvoice(payoutAId, ...)` and `payInvoice(payoutBId, ...)`
6. Delivers payout invoice tokens to parties via DM
7. Transitions to `COMPLETED`

### `invoice:closed`

Fired when `closeInvoice()` completes (balances frozen). Used for internal bookkeeping; the orchestrator has already advanced state by this point.

### `invoice:cancelled`

Fired when `cancelInvoice()` completes. The handler transitions the swap from `CANCELLING` to `CANCELLED`.

## Timeout Handling

The timeout timer is an application-level `setTimeout` (or persistent timer) that starts from the **first deposit event**, not from manifest submission.

**Why not rely on `dueDate`?** The AccountingModule's `dueDate` is informational — it causes the invoice state to show as `EXPIRED` but does **not** reject payments or trigger returns. The escrow needs hard enforcement:

```typescript
// On first invoice:payment event for this swap
const timeoutMs = manifest.timeout * 1000;
timeoutManager.schedule(swapId, timeoutMs, async () => {
  await accounting.cancelInvoice(depositInvoiceId, { autoReturn: true });
  // cancelInvoice freezes balances, auto-return handles refunds
  // invoice:cancelled event triggers CANCELLING → CANCELLED transition
});
```

**Race condition: coverage vs timeout.** If `invoice:covered` fires at nearly the same time as the timeout:
- The SwapOrchestrator uses swap state as the arbiter. If the swap has already transitioned to `DEPOSIT_COVERED`, the timeout callback is a no-op.
- If the timeout fires first and the swap transitions to `TIMED_OUT`, a subsequent `invoice:covered` is ignored (swap is no longer in `PARTIAL_DEPOSIT`).
- Both paths are safe because `closeInvoice()` and `cancelInvoice()` are idempotent once the invoice reaches a terminal state.

## Deposit Validation

The deposit invoice accepts payments from anyone — the AccountingModule does not have `allowedSenders` filtering (see `docs/sdk-gaps.md`). The escrow performs application-level sender validation:

1. On `invoice:payment`, call `getInvoiceStatus(depositInvoiceId)`
2. Inspect `targets[0].coinAssets[i].senderBalances` to find the new sender
3. Resolve the sender's address to determine which party they are
4. If the sender is not party A or party B: `returnInvoicePayment()` to bounce back
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
| Redis distributed locks | AccountingModule's per-invoice async mutex (§5.9) |

## What Remains (Simplified)

| Component | Changes |
|---|---|
| **TimeoutManager** | Simplified — no longer manages refund logic, just fires `cancelInvoice()` |
| **MessageHandler** | Simplified — fewer message types, delivers invoice tokens instead of instructions |
| **SwapStateStore** | Simplified schema — no deposit tracking columns, just state + invoice IDs |
| **ManifestValidator** | Unchanged — still validates swap manifest structure and content-addressed ID |
| **SwapOrchestrator** | New — central coordinator replacing the distributed PaymentProcessor/ConclusionProcessor |

## Crash Recovery

The AccountingModule provides built-in crash recovery:

1. **Invoice-transfer index** — rebuilt from token transaction histories on `load()`. No separate persistence needed for payment attribution.
2. **Auto-return dedup ledger** — write-first intent log with `pending → completed | failed` lifecycle. On restart, pending entries are retried (up to 5 times).
3. **Frozen balances** — persisted at terminal state (CLOSED/CANCELLED). Reconstructed from ledger entries if terminal-set entry exists but frozen snapshot is missing (storage reconciliation).
4. **Terminal sets** — CANCELLED_INVOICES and CLOSED_INVOICES persisted as arrays. Forward and inverse reconciliation on load ensures consistency.

**Escrow-level recovery:**

The SwapStateStore must persist the swap state and invoice IDs. On startup:

1. Load all non-terminal swaps from SwapStateStore
2. For each swap, call `getInvoiceStatus(depositInvoiceId)` to determine actual state
3. Reconcile: if the invoice is `COVERED` but the swap is `PARTIAL_DEPOSIT`, resume conclusion
4. If the invoice is `CANCELLED` but the swap is `TIMED_OUT`, resume to `CANCELLED`
5. Re-register timeout timers for any `PARTIAL_DEPOSIT` swaps with remaining time

All AccountingModule operations (`closeInvoice`, `cancelInvoice`, `payInvoice`) are idempotent on already-terminal invoices, making resume safe.

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
- **Duplicate announcements:** `createInvoice()` is content-addressed (SHA-256 of terms). Same terms produce the same invoice ID; `INVOICE_ALREADY_EXISTS` error on re-creation is safe to handle
- **Double payments:** Per-sender balance tracking in the AccountingModule prevents double-counting. The invoice-transfer index deduplicates by `transferId::coinId`

### Invoice Token Security

Invoice tokens are on-chain cryptographic objects. If a party loses their deposit invoice token, they cannot verify payout. The escrow must:
- Persist invoice tokens in its own storage
- Be prepared to re-deliver tokens via DM on request
- Payout invoice tokens must be delivered reliably — they are the party's proof of payment
