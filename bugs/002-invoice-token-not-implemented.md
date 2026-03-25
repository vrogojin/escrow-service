# Bug 002 — `getDepositInvoiceToken` / `getPayoutInvoiceToken` always return null (not implemented)

**Status:** Fixed (2026-03-19)
**Severity:** Critical — swap flow is blocked; deposit invoice is never delivered to parties
**Affected file:** `src/core/invoice-manager.ts` lines 229–239

---

## Symptom

After `swap-accept`, `swap-list` shows the swap stuck in `accepted` state and logs:

```
[Swap] Escrow error: Deposit invoice token not available
```

The escrow creates the deposit invoice successfully but then fails to retrieve its
serialized token to send to the swap parties.

---

## Root Cause

Both token retrieval methods in `InvoiceManager` are **stub placeholders** that
unconditionally return `null`:

```typescript
// src/core/invoice-manager.ts

async getDepositInvoiceToken(_invoiceId: string): Promise<unknown | null> {
    return null;  // ← TODO: not implemented
}

async getPayoutInvoiceToken(_invoiceId: string): Promise<unknown | null> {
    return null;  // ← TODO: not implemented
}
```

When `handleAnnounce` calls `deliverDepositInvoice` → `invoiceManager.getDepositInvoiceToken()`,
it always gets `null` → replies with `{ type: 'error', error: 'Deposit invoice token not available' }`.

---

## How to implement

### What the escrow needs to send

The escrow must send the **serialized TxfToken** (raw JSON) of the invoice token to the
swap party. The party's sphere-sdk then imports this token via `sphere.accounting.importInvoice(token)`,
which parses the `InvoiceTerms` embedded in `genesis.data.tokenData` and registers the invoice locally.

### How to retrieve the token from sphere-sdk

After `accounting.createInvoice()` returns an `invoiceId`, the invoice token lives in
`sphere.payments.getTokens()` (it is a regular L3 token with `tokenType = INVOICE_TOKEN_TYPE_HEX`).
The raw TxfToken data is in `token.sdkData` (a JSON string of the `TxfToken` structure).

```typescript
async getDepositInvoiceToken(invoiceId: string): Promise<unknown | null> {
    // The invoice token's ID = the invoiceId returned by createInvoice()
    const tokens = sphere.payments.getTokens();
    const token = tokens.find(t => t.id === invoiceId);
    if (!token?.sdkData) return null;
    // Return the raw TxfToken JSON — the recipient imports it via importInvoice()
    return JSON.parse(token.sdkData);
}
```

`InvoiceManager` needs access to the `PaymentsModule` (or to `Sphere` directly).
Either:

**Option A** — inject `Sphere` into `InvoiceManager`:
```typescript
export interface InvoiceManagerDeps {
  accounting: AccountingModule;
  escrowAddress: string;
  sphere: Sphere;             // ← add this
  eventSource?: EventSource;
}
```

**Option B** — inject a token getter callback:
```typescript
export interface InvoiceManagerDeps {
  accounting: AccountingModule;
  escrowAddress: string;
  getToken: (id: string) => { sdkData?: string } | undefined;  // ← add this
  eventSource?: EventSource;
}
```
Wire it up: `getToken: (id) => sphere.payments.getToken(id)`.

`sphere.payments.getToken(id)` is the single-token lookup:
```typescript
// In PaymentsModule (line 3175):
getToken(id: string): Token | undefined
```

Option B is preferred — narrower dependency, easier to mock in tests.

### Implementation

```typescript
async getDepositInvoiceToken(invoiceId: string): Promise<unknown | null> {
    const token = this.getToken(invoiceId);
    if (!token?.sdkData) return null;
    try {
        return JSON.parse(token.sdkData);
    } catch {
        return null;
    }
}

async getPayoutInvoiceToken(invoiceId: string): Promise<unknown | null> {
    const token = this.getToken(invoiceId);
    if (!token?.sdkData) return null;
    try {
        return JSON.parse(token.sdkData);
    } catch {
        return null;
    }
}
```

---

## Files to modify

1. **`src/core/invoice-manager.ts`**
   - Add `getToken` callback to `InvoiceManagerDeps`
   - Implement `getDepositInvoiceToken` and `getPayoutInvoiceToken` using it

2. **`src/index.ts`** (or wherever `InvoiceManager` is constructed)
   - Pass `getToken: (id) => sphere.payments.getToken(id)` in deps

---

## Timing note

`createInvoice()` in sphere-sdk is async — it mints the token on-chain (aggregator round-trip).
By the time `invoiceManager.createDepositInvoice()` returns, the token is in `payments.getTokens()`.
There is no race condition: `orchestrator.announce()` awaits `createDepositInvoice()` before
`deliverDepositInvoice` is called.

---

## Related

- Bug 001: authorization fix (must be applied before this becomes visible)
- `sphere.accounting.importInvoice(token)` on the receiver side parses the TxfToken and registers the invoice locally — this is the correct import API for the party receiving the invoice
