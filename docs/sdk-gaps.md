# Sphere SDK Accounting Module — Gap Analysis

This document identifies gaps in the sphere-sdk AccountingModule (`feat/accounting-module-spec` branch) that affect the escrow service's invoice-based design. Each gap includes the current SDK behavior, impact on the escrow, a proposed API change, and priority.

## 1. `allowedSenders` on InvoiceRequestedAsset

**Priority: High**

### Current SDK Behavior

The `InvoiceRequestedAsset` type accepts payments from **any** sender address:

```typescript
// types.ts
export interface InvoiceRequestedAsset {
  readonly coin?: CoinEntry;  // [coinId, amount]
  readonly nft?: NFTEntry;
}
```

There is no field to restrict which addresses may pay a specific asset. The `InvoiceTarget` only specifies the destination address and the requested assets — not who is authorized to pay.

When a payment arrives with an `INV:<id>:F` memo, the AccountingModule indexes the transfer into the invoice-transfer ledger unconditionally if the destination address matches a target. Classification into the correct coin asset slot (and per-sender balance aggregation) happens post-facto in `computeInvoiceStatus()` (balance-computer.ts) — the indexing itself does not check the coin ID, only the classification step does.

### Impact on Escrow

The deposit invoice has the escrow's address as the target with two coin assets. Without `allowedSenders`:

- **Any address** can pay either asset, not just the designated parties
- The escrow must perform **application-level sender validation** on every `invoice:payment` event:
  1. Call `getInvoiceStatus()` and iterate `coinAssets[i].transfers` to identify the sender via each transfer's `InvoiceTransferRef.senderAddress` (the cryptographically-authenticated on-chain address — **not** `senderBalances`, whose keys are self-asserted `effectiveSender` values that include the unverified `refundAddress` when `isRefundAddress` is `true`). **Naming collision warning:** `InvoiceSenderBalance` also has a field called `senderAddress`, but in that context it holds the `effectiveSender` value (not the cryptographic address). Always use `InvoiceTransferRef.senderAddress` for identity verification. Note: `senderAddress` is `string | null` — it is `null` for masked-predicate senders, requiring the escrow to mandate unmasked predicates as a precondition.
  2. Check sender against resolved party addresses
  3. Call `returnInvoicePayment()` to bounce unauthorized payments
- This adds latency between payment receipt and validation response
- Race conditions are possible between unauthorized payment indexing and the bounce-back
- The escrow must handle the `returnInvoicePayment()` failure path (network errors, insufficient balance for return)

### Proposed API Change

Add an optional `allowedSenders` field to `InvoiceRequestedAsset`. **Privacy tradeoff:** Since `InvoiceRequestedAsset` is embedded in `InvoiceTerms` (which is serialized into the on-chain invoice token), the `allowedSenders` list would be visible to anyone who obtains the token. For the escrow use case, party addresses are already known to both parties (they're in the manifest), so on-chain visibility is acceptable. Applications requiring private sender restrictions should use the application-level workaround instead, or the SDK could support a separate local-only config (not embedded in InvoiceTerms):

```typescript
export interface InvoiceRequestedAsset {
  readonly coin?: CoinEntry;
  readonly nft?: NFTEntry;
  /** Optional: only accept payments from these DIRECT:// addresses for this asset */
  readonly allowedSenders?: string[];
}
```

Behavior when set:
- When processing an inbound transfer event, check if the sender's **on-chain address** (`senderAddress` from the transfer, NOT `effectiveSender` which includes the self-asserted `refundAddress`) is in `allowedSenders`. **Design note:** This check uses `senderAddress` (cryptographically authenticated) rather than `effectiveSender`, which is consistent with the security goal of verifiable identity. However, `senderAddress` is `null` for masked-predicate senders — such senders would always fail the `allowedSenders` check. This means `allowedSenders` implicitly requires all authorized senders to use unmasked predicates (DIRECT:// addresses derived from their public keys).
- If not, treat as an irrelevant transfer with reason `'sender_unauthorized'`
- Fire `invoice:sender_unauthorized` event (see gap #5)
- Auto-return the payment if auto-return is enabled, or leave it for the target to return manually

For the escrow deposit invoice:
```typescript
createInvoice({
  targets: [{
    address: escrowAddress,
    assets: [
      {
        coin: [partyACurrency, partyAValue],
        allowedSenders: [resolvedPartyAAddress],
      },
      {
        coin: [partyBCurrency, partyBValue],
        allowedSenders: [resolvedPartyBAddress],
      },
    ],
  }],
})
```

This would eliminate the application-level validation loop entirely.

### Workaround

The escrow monitors `invoice:payment` events and calls `returnInvoicePayment()` for unauthorized senders. This works but requires careful handling of the event → validate → return sequence and adds complexity to the crash recovery path (a crash between payment receipt and return could leave unauthorized funds in the invoice).

---

## 2. `deliverInvoice()` Convenience Method

**Priority: Low**

### Current SDK Behavior

There is no SDK method that combines invoice token delivery with DM notification. To deliver an invoice to a recipient, the escrow must:

1. Retrieve the invoice token in TxfToken format (from token storage — `getInvoice()` returns `InvoiceRef` which exposes metadata but does **not** include the raw token; see gap #3)
2. Serialize the token for transport
3. Compose a DM with the token and payment instructions
4. Send via `communications.sendDM(recipientPubkey, payload)`

The `InvoiceTerms` type has a `deliveryMethods` field (commented as "PLACEHOLDER — not used by the current SDK"):

```typescript
// types.ts
export interface InvoiceTerms {
  // ...
  readonly deliveryMethods?: string[];
  // ...
}
```

This field is stored in the invoice token but not acted upon — the SDK uses Nostr-based delivery exclusively.

### Impact on Escrow

The escrow must implement its own invoice delivery logic:
- Serialize TxfToken to JSON for DM transport
- Handle delivery failures (DM send failures, recipient offline)
- Implement retry logic for failed deliveries
- The recipient must know to call `importInvoice()` with the received token

This is a moderate amount of boilerplate that every invoice-issuing application will need.

### Proposed API Change

```typescript
// AccountingModule
async deliverInvoice(invoiceId: string, params: {
  recipientPubkey: string;
  message?: string;  // optional human-readable message
}): Promise<{ delivered: boolean; error?: string }>;
```

Behavior:
1. Retrieve the invoice token from internal storage
2. Serialize using a standard portable format (see gap #3)
3. Send via `communications.sendDM()` with a structured payload the recipient's SDK can auto-detect and import
4. Return delivery status

### Workaround

The escrow implements delivery as part of its `invoice_delivery` DM message type. The recipient party must be running an application that understands this message format and calls `importInvoice()`.

---

## 3. Invoice Export/Serialization for Delivery

**Priority: Low**

### Current SDK Behavior

Invoice tokens are stored internally as `TxfToken` objects (the Token eXchange Format). The `InvoiceRef` returned by `getInvoice()` and `getInvoices()` exposes invoice metadata but does **not** include the raw token:

```typescript
// types.ts — actual InvoiceRef definition
export interface InvoiceRef {
  readonly invoiceId: string;
  readonly terms: InvoiceTerms;
  readonly isCreator: boolean;
  readonly cancelled: boolean;
  readonly closed: boolean;
}
```

To access the raw TxfToken for delivery, the escrow must retrieve it from token storage separately.

There is no standardized "invoice package" format that bundles the token with human-readable metadata for cross-wallet delivery.

### Impact on Escrow

The escrow must define its own serialization format for DM-based invoice delivery. This means:
- The recipient must understand the escrow's custom format
- Different applications may invent different formats for the same purpose
- No interoperability between invoice-issuing applications

### Proposed API Change

```typescript
// AccountingModule
async exportInvoice(invoiceId: string): Promise<InvoicePackage>;

interface InvoicePackage {
  /** Format version for forward compatibility */
  version: 1;
  /** The invoice token in TxfToken format */
  token: TxfToken;
  /** Parsed invoice terms (for display without parsing token) */
  terms: InvoiceTerms;
  /** Invoice token ID */
  invoiceId: string;
}
```

And the corresponding import:
```typescript
async importInvoicePackage(pkg: InvoicePackage): Promise<InvoiceTerms>;
```

This standardizes the portable format so any sphere-sdk application can send and receive invoice tokens.

### Workaround

The escrow serializes the TxfToken as JSON in DM payloads. Recipients parse the JSON and call `importInvoice(token)` directly.

---

## 4. `dueDate` Enforcement Option

**Priority: Low**

### Current SDK Behavior

The `dueDate` field in `InvoiceTerms` is **informational only**. When an invoice has a `dueDate` that has passed:

- `computeInvoiceStatus()` in balance-computer.ts sets `state = 'EXPIRED'` (lines 545–547):
  ```typescript
  } else if (terms.dueDate !== undefined && terms.dueDate < Date.now()) {
    state = 'EXPIRED';
  }
  ```
- However, payments are **still accepted and indexed**. The `EXPIRED` state does not prevent the `invoice:payment` event from firing or the balance from updating. Note: if an invoice past its `dueDate` receives enough payments to become fully covered, the state will be `COVERED` (not `EXPIRED`), because the `COVERED` check has higher priority than the `EXPIRED` check in the state computation chain (`CLOSED > CANCELLED > COVERED > EXPIRED > PARTIAL > OPEN`). Note: `CLOSED` and `CANCELLED` are determined by a separate frozen-balances code path, not the same dynamic if-else chain that computes `COVERED > EXPIRED > PARTIAL > OPEN`.
- There is no option to hard-reject payments after the due date.
- `createInvoice()` validates that `dueDate > Date.now()` at creation time (line 790–792) but does not enforce it after creation.

### Impact on Escrow

The escrow uses `dueDate` as a display hint but must enforce timeouts at the application level:

1. Start a timer from the first deposit event
2. When the timer fires, call `cancelInvoice({ autoReturn: true })`
3. The cancellation freezes balances and returns deposits

This works correctly — the application-level timeout is actually **more flexible** than hard `dueDate` enforcement because:
- The timeout starts from first deposit, not from invoice creation
- The escrow can cancel at any time, not just after `dueDate`

However, without hard enforcement, a payment arriving between timeout detection and `cancelInvoice()` completion could be accepted into a soon-to-be-cancelled invoice. This is handled by the AccountingModule's post-cancellation auto-return (any payment arriving after cancellation is auto-returned if `autoReturn` is enabled).

### Proposed API Change

Add an optional enforcement flag to `CreateInvoiceRequest`:

```typescript
export interface CreateInvoiceRequest {
  // ... existing fields ...
  /**
   * When true, payments received after dueDate are treated as irrelevant
   * (not indexed, not counted toward coverage). Default: false (informational).
   */
  readonly enforceDueDate?: boolean;
}
```

When `enforceDueDate: true`:
- The indexing pipeline checks `terms.dueDate` before adding an entry to the invoice-transfer ledger
- Payments after expiry are classified as irrelevant with reason `'expired'`
- The `invoice:payment` event is NOT fired for expired payments

### Workaround

The escrow's application-level timeout + `cancelInvoice({ autoReturn: true })` provides equivalent behavior. Post-cancellation payments are auto-returned by the dedup ledger. This is sufficient and not blocking.

---

## 5. Event: `invoice:sender_unauthorized`

**Priority: Low**

### Current SDK Behavior

There is no `allowedSenders` mechanism (see gap #1), so there is no concept of an "unauthorized sender" at the SDK level. All sender validation is the application's responsibility.

The `IrrelevantTransfer` type has these reason codes:

```typescript
// types.ts
export interface IrrelevantTransfer extends InvoiceTransferRef {
  readonly reason:
    | 'unknown_address'
    | 'unknown_asset'
    | 'unknown_address_and_asset'
    | 'self_payment'
    | 'no_coin_data'
    | 'unauthorized_return';
}
```

`'unauthorized_return'` exists for return-direction transfers from non-target addresses, but there is no `'sender_unauthorized'` for forward payments from disallowed senders.

### Impact on Escrow

Without a dedicated event, the escrow must:
1. Subscribe to the generic `invoice:payment` event
2. Perform its own sender check on every payment
3. Manually call `returnInvoicePayment()` for unauthorized senders
4. Handle the return's success/failure

If `allowedSenders` (gap #1) is implemented, a corresponding event would let the escrow passively monitor unauthorized attempts without needing to intercept every payment.

### Proposed API Change

If gap #1 (`allowedSenders`) is implemented, add a new event:

```typescript
// SphereEventMap additions
'invoice:sender_unauthorized': {
  invoiceId: string;
  senderAddress: string | null;
  coinId: string;
  amount: string;
  transferId: string;
  /** Whether auto-return was triggered */
  autoReturned: boolean;
}
```

Fired when a payment arrives for an asset with `allowedSenders` set and the sender is not in the list. The `autoReturned` field indicates whether the SDK automatically returned the payment (if auto-return was enabled for this invoice).

### Workaround

The escrow uses `invoice:payment` + application-level validation. This is the current design and works correctly. The event would be a convenience for monitoring/alerting purposes rather than a functional requirement.

---

## 6. Distributed Locking / Multi-Instance Support

**Priority: Medium**

### Current SDK Behavior

The AccountingModule serializes concurrent operations on the same invoice using an in-process async mutex (`invoiceGates` — a `Map<string, Promise<void>>` that chains promises per invoice ID). This prevents race conditions when multiple event handlers or API calls target the same invoice concurrently within a single Node.js process.

However, this mutex is **not distributed**. If two processes (or two instances of an application) operate on the same invoice simultaneously, the mutex provides no protection — both processes can proceed concurrently, potentially causing double-payments, inconsistent state, or corrupted ledger entries.

### Impact on Escrow

The escrow service must run as a **single instance**. This limits:
- Horizontal scaling for high swap throughput
- High-availability deployment (active-active is unsafe; only active-passive with failover is possible)
- Container orchestration (Kubernetes replicas must be set to 1)

For the current escrow use case (moderate swap volume), single-instance is acceptable. But it is a hard architectural constraint that must be documented and enforced.

### Proposed API Change

Add a `LockProvider` interface to the AccountingModule configuration:

```typescript
export interface LockProvider {
  /** Acquire an exclusive lock for the given key. Returns an unlock function. */
  acquire(key: string, timeoutMs?: number): Promise<() => Promise<void>>;
}

// AccountingModule configuration
interface AccountingModuleConfig {
  // ... existing fields ...
  /** Optional distributed lock provider. Defaults to in-process promise chaining. */
  lockProvider?: LockProvider;
}
```

Applications requiring multi-instance deployment would provide a Redis-based or database-based lock provider. The default in-process implementation remains for single-instance use.

### Workaround

The escrow runs as a single instance. Deployments must enforce `replicas: 1` in container orchestration. If the escrow needs high availability, an active-passive failover pattern (with leader election) is used instead of active-active scaling.

---

## 7. `getInvoices()` Per-Sender Filtering

**Priority: Low**

### Current SDK Behavior

The `getInvoices()` method returns all invoices (or all matching a filter like `state`, `createdByMe`, `targetingMe`, `limit`, `offset`, `sortBy`, `sortOrder`). There is no way to query invoices that have received payments from a specific sender address.

To find all invoices where a given address has contributed, the escrow must:
1. Call `getInvoices()` to retrieve all invoices
2. For each invoice, call `getInvoiceStatus()` to inspect transfers
3. Filter locally by iterating `coinAssets[i].transfers` and matching `senderAddress`

### Impact on Escrow

For operational queries (e.g., "show all swaps where address X has deposited"), the escrow must load every invoice's full status. This is O(N) in the total invoice count and becomes expensive as the escrow processes more swaps.

### Proposed API Change

Add an optional `senderAddress` filter to `getInvoices()`:

```typescript
async getInvoices(filter?: {
  // ... existing filters ...
  /** Only return invoices that have received payments from this address */
  senderAddress?: string;
}): Promise<InvoiceRef[]>;
```

Note: The AccountingModule does **not** currently maintain a sender-to-invoice index. Per-sender balance computation happens dynamically inside `computeInvoiceStatus()` (balance-computer.ts), which iterates all entries per invoice and builds per-sender accumulators on the fly. Implementing this filter would require building a new secondary index (`senderAddress → Set<invoiceId>`), which adds maintenance overhead but would be a significant query-time improvement.

### Workaround

The escrow uses application-level filtering. For the current escrow use case (moderate swap volume, queries are infrequent), this is acceptable.

---

## 8. `createdAt` Passthrough in `CreateInvoiceRequest`

**Priority: High**

### Current SDK Behavior

The `CreateInvoiceRequest` type does not expose a `createdAt` field. The SDK sets `createdAt = Date.now()` internally when building `InvoiceTerms` (AccountingModule.ts line 926):

```typescript
const terms: InvoiceTerms = {
  creator: request.anonymous ? undefined : deps.identity.chainPubkey,
  createdAt: Date.now(),  // ← always current timestamp
  // ...
};
```

Since the invoice ID is `SHA-256(canonicalSerialize(InvoiceTerms))` and `createdAt` is part of the serialized terms, each `createInvoice()` call produces a **different** invoice ID even when all other fields are identical.

### Impact on Escrow

Without deterministic invoice IDs, the escrow cannot:
- **Pre-compute** expected invoice IDs from swap state (needed for crash recovery without orphan scanning)
- **Safely re-create** invoices after crashes — re-calling `createInvoice()` produces a different ID, orphaning the original
- **Verify** that a created invoice matches expectations without memo-based string parsing

The escrow must fall back to:
1. O(N) memo scanning via `getInvoices()` to find orphaned invoices (fragile and slow)
2. Persisting invoice IDs before any subsequent action (the "persist-before-act" pattern), which works but adds recovery complexity

### Proposed API Change

Add an optional `createdAt` field to `CreateInvoiceRequest`:

```typescript
export interface CreateInvoiceRequest {
  readonly targets: InvoiceTarget[];
  readonly dueDate?: number;
  readonly memo?: string;
  readonly deliveryMethods?: string[];
  readonly anonymous?: boolean;
  /**
   * Optional creation timestamp (ms). When provided, used instead of Date.now().
   * Must be a positive integer ≤ Date.now() + 86400000 (1-day clock skew).
   * Enables deterministic invoice IDs for crash recovery.
   */
  readonly createdAt?: number;
}
```

When `createdAt` is provided:
- The SDK uses it directly in `InvoiceTerms.createdAt` instead of calling `Date.now()`
- Validation: must be a positive integer, ≤ `Date.now() + 86400000` (same clock skew check as `importInvoice()`)
- The resulting invoice ID is deterministic for a given set of terms

When `createdAt` is omitted (default, backward compatible):
- Existing behavior: `Date.now()` is used

### Workaround

The escrow uses the **persist-before-act** pattern: always write the invoice ID to SwapStateStore immediately after `createInvoice()` succeeds and before any dependent action. For crash recovery:
- If the store has the invoice ID: use it directly (no re-derivation needed)
- If the store lacks the invoice ID (crash between `createInvoice()` and store write): fall back to memo-based scanning via `getInvoices()` filtered by memo patterns:
    - `"Escrow deposit for swap <swap_id>"`
    - `"Swap <swap_id> payout to Party A"`
    - `"Swap <swap_id> payout to Party B"`

**Important:** Do not rely on catching `INVOICE_ALREADY_EXISTS` for crash recovery. The SDK's in-memory `invoiceTermsCache` is cleared on restart, so this error will not fire after a process restart — it only fires for duplicate calls within the same process lifetime (e.g., concurrent announce race).

This workaround is **functional but fragile**: memo parsing couples crash recovery to free-text conventions, and the O(N) scan becomes expensive as invoice count grows. The `createdAt` passthrough eliminates both issues.

---

## Summary

| # | Gap | Priority | Blocking? | Workaround |
|---|---|---|---|---|
| 1 | `allowedSenders` on InvoiceRequestedAsset | **High** | No | Application-level validation via `getInvoiceStatus()` + `returnInvoicePayment()` |
| 2 | `deliverInvoice()` convenience method | Low | No | Manual DM composition with serialized TxfToken |
| 3 | Invoice export/serialization format | Low | No | Custom JSON serialization of TxfToken in DM payloads |
| 4 | `dueDate` enforcement option | Low | No | Application-level timeout + `cancelInvoice({ autoReturn: true })` |
| 5 | `invoice:sender_unauthorized` event | Low | No | `invoice:payment` event + manual sender check |
| 6 | Distributed locking / multi-instance support | **Medium** | No | Single-instance deployment with active-passive failover |
| 7 | `getInvoices()` per-sender filtering | Low | No | Application-level filtering after retrieval |
| 8 | `createdAt` passthrough in `CreateInvoiceRequest` | **High** | No | Persist-before-act + memo-based orphan scanning |

**None of these gaps are blocking.** The escrow service can be fully implemented using the current AccountingModule API. The gaps represent opportunities for the SDK to reduce boilerplate and push common patterns into the framework. However, gap #1's workaround exposes a DOS surface (unauthorized payment flooding forces an event → validate → return loop per payment) that should be mitigated with application-level rate-limiting until `allowedSenders` is available.

The highest-impact gaps are **`allowedSenders`** (#1), which eliminates the most complex application-level workaround, and **`createdAt` passthrough** (#8), which enables deterministic invoice IDs for robust crash recovery without memo-based scanning. Gap #6 (distributed locking) is **Medium** because it imposes a hard single-instance architectural constraint on all AccountingModule consumers. The remaining gaps are convenience improvements that reduce code duplication across invoice-issuing applications.
