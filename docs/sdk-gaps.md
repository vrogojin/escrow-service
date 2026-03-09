# Sphere SDK Accounting Module — Gap Analysis

This document identifies gaps in the sphere-sdk AccountingModule (`feat/accounting-module-spec` branch) that affect the escrow service's invoice-based design. Each gap includes the current SDK behavior, impact on the escrow, a proposed API change, and priority.

## 1. `allowedSenders` on InvoiceRequestedAsset

**Priority: Medium**

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

When a payment arrives with an `INV:<id>:F` memo, the AccountingModule indexes it into the invoice-transfer ledger unconditionally if the destination address and coin ID match a target. All per-sender tracking happens post-facto in `computeInvoiceStatus()` (balance-computer.ts).

### Impact on Escrow

The deposit invoice has the escrow's address as the target with two coin assets. Without `allowedSenders`:

- **Any address** can pay either asset, not just the designated parties
- The escrow must perform **application-level sender validation** on every `invoice:payment` event:
  1. Call `getInvoiceStatus()` to inspect `senderBalances`
  2. Check sender against resolved party addresses
  3. Call `returnInvoicePayment()` to bounce unauthorized payments
- This adds latency between payment receipt and validation response
- Race conditions are possible between unauthorized payment indexing and the bounce-back
- The escrow must handle the `returnInvoicePayment()` failure path (network errors, insufficient balance for return)

### Proposed API Change

Add an optional `allowedSenders` field to `InvoiceRequestedAsset`:

```typescript
export interface InvoiceRequestedAsset {
  readonly coin?: CoinEntry;
  readonly nft?: NFTEntry;
  /** Optional: only accept payments from these DIRECT:// addresses for this asset */
  readonly allowedSenders?: string[];
}
```

Behavior when set:
- During invoice-transfer indexing, check if the sender's effective address (refundAddress ?? senderAddress) is in `allowedSenders`
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

1. Retrieve the invoice token in TxfToken format (from `getInvoice()` which returns `InvoiceRef` containing the token)
2. Serialize the token for transport
3. Compose a DM with the token and payment instructions
4. Send via `communications.sendDM(recipientPubkey, payload)`

The `InvoiceTerms` type has a `deliveryMethods` field (commented as "PLACEHOLDER — not used by the current SDK"):

```typescript
// types.ts
export interface InvoiceTerms {
  // ...
  readonly deliveryMethods?: string[];  // e.g. ["https://pay.example.com/inv/abc"]
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

Invoice tokens are stored internally as `TxfToken` objects (the Token eXchange Format). The `InvoiceRef` returned by `getInvoice()` and `getInvoices()` includes:

```typescript
export interface InvoiceRef {
  readonly invoiceId: string;
  readonly terms: InvoiceTerms;
  readonly token: TxfToken;
  readonly isTarget: boolean;
  readonly role: 'creator' | 'payer' | 'target' | 'observer';
}
```

To access the raw TxfToken for delivery, the escrow must retrieve it from token storage separately — `InvoiceRef` does not include the token:

```typescript
export interface InvoiceRef {
  readonly invoiceId: string;
  readonly terms: InvoiceTerms;
  readonly isCreator: boolean;
  readonly cancelled: boolean;
  readonly closed: boolean;
}
```

There is no standardized "invoice package" format that bundles the token with human-readable metadata for cross-wallet delivery.

### Impact on Escrow

The escrow must define its own serialization format for DM-based invoice delivery. This means:
- The recipient must understand the escrow's custom format
- Different applications may invent different formats for the same purpose
- No interoperability between invoice-issuing applications

### Proposed API Change

```typescript
// AccountingModule
exportInvoice(invoiceId: string): InvoicePackage;

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

- `computeInvoiceStatus()` in balance-computer.ts sets `state = 'EXPIRED'` (line 545–547):
  ```typescript
  } else if (terms.dueDate !== undefined && terms.dueDate < Date.now()) {
    state = 'EXPIRED';
  }
  ```
- However, payments are **still accepted and indexed**. The `EXPIRED` state does not prevent the `invoice:payment` event from firing or the balance from updating.
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
  senderAddress: string;
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

## Summary

| # | Gap | Priority | Blocking? | Workaround |
|---|---|---|---|---|
| 1 | `allowedSenders` on InvoiceRequestedAsset | Medium | No | Application-level validation via `getInvoiceStatus()` + `returnInvoicePayment()` |
| 2 | `deliverInvoice()` convenience method | Low | No | Manual DM composition with serialized TxfToken |
| 3 | Invoice export/serialization format | Low | No | Custom JSON serialization of TxfToken in DM payloads |
| 4 | `dueDate` enforcement option | Low | No | Application-level timeout + `cancelInvoice({ autoReturn: true })` |
| 5 | `invoice:sender_unauthorized` event | Low | No | `invoice:payment` event + manual sender check |

**None of these gaps are blocking.** The escrow service can be fully implemented using the current AccountingModule API. The gaps represent opportunities for the SDK to reduce boilerplate and push common patterns into the framework.

The highest-impact gap is **`allowedSenders`** (#1), which would eliminate the most complex application-level workaround (the payment → validate → bounce loop). The remaining gaps are convenience improvements that reduce code duplication across invoice-issuing applications.
