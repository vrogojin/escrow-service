# BUG-001: Payout `invoice_delivery` DM Missing `invoice_token` Field

**Severity:** Critical (swap lifecycle broken for all SDK-based consumers)
**Component:** `src/core/swap-orchestrator.ts` (lines 1547-1563)
**Discovered:** 2026-04-08
**Status:** Fix applied, pending review

---

## Summary

The `SwapOrchestrator.concludeSwap()` method sends payout `invoice_delivery` DMs to both swap parties **without the `invoice_token` field**. The Sphere SDK's `parseInvoiceDelivery()` requires `invoice_token` to be a non-null object and silently drops messages that lack it. This means **no SDK-based consumer ever receives a payout invoice**, the `swap:payout_received` event never fires, and the swap never reaches `completed` state on the client side.

## Root Cause

Two separate code paths in the escrow service send `invoice_delivery` DMs:

1. **`message-handler.ts` `deliverPayoutInvoice()` (lines 259-272)** — correctly includes `invoice_token`:
   ```typescript
   await reply(recipientNpub, {
     type: 'invoice_delivery',
     swap_id: swapId,
     invoice_type: 'payout',
     invoice_id: invoiceId,
     invoice_token: token,  // <-- PRESENT
   });
   ```

2. **`swap-orchestrator.ts` `concludeSwap()` (lines 1547-1563)** — sends the DM directly, **omitting** `invoice_token`:
   ```typescript
   this.messageSender.sendToParty(swap.swap_id, 'A', {
     type: 'invoice_delivery',
     swap_id: manifest.swap_id,
     invoice_type: 'payout',
     invoice_id: payoutAId,
     // invoice_token: MISSING
   });
   ```

The orchestrator bypasses the `deliverPayoutInvoice()` helper and constructs the DM payload inline, omitting the critical `invoice_token` field that contains the serialized TXF invoice token.

## Impact

- **SDK SwapModule silently drops the payout DM** — `parseInvoiceDelivery()` in `sphere-sdk/modules/swap/dm-protocol.ts` (line 651) validates: `if (obj.invoice_token === undefined || obj.invoice_token === null || typeof obj.invoice_token !== 'object') return null;`
- **`swap:payout_received` event never fires** on the client side
- **`swap:completed` event never fires** through the payout verification path
- **Swaps stay stuck in `concluding` or `depositing` state** indefinitely on SDK-based consumers
- **The only completion path that works** is the `status_result` DM (triggered by explicit `getSwapStatus()` polling), which is a secondary mechanism not all consumers invoke

## Why This Wasn't Caught

The escrow-service's own e2e test (`src/__tests__/e2e/swap-lifecycle.e2e-live.test.ts`) **does not use the SDK's SwapModule at all**. Instead, it:

1. Uses raw `payments.send()` to deposit directly to the escrow address
2. Checks the escrow's internal `stateStore` for `SwapState.COMPLETED`
3. Verifies balances via `payments.receive()` + `getBalance()`

This test validates the escrow's internal mechanics (receive deposits, create payouts, pay them) but **completely bypasses the swap DM protocol**. The `invoice_delivery` messages are sent but no test ever parses them as an SDK consumer would.

The sphere-sdk's CLI e2e test (`tests/e2e/swap-cli-e2e.sh`) works around this bug by polling `swap-status` every 15 seconds, which calls `getSwapStatus(swapId)` — this sends a `status_result` query to the escrow, and the escrow responds with state=COMPLETED, which drives the swap to completion through a different code path.

## Architectural Concern

The escrow-service duplicates swap DM construction in two places instead of using a single authoritative function. The `message-handler.ts` has the correct `deliverPayoutInvoice()` helper, but the `swap-orchestrator.ts` constructs the same message type inline with a different (incomplete) payload. This is the same class of bug that occurs whenever SDK functionality is reimplemented instead of reused.

**Recommendation:** The orchestrator should call `deliverPayoutInvoice()` (or a shared utility) rather than constructing DM payloads inline. All `invoice_delivery` messages — deposit and payout — should flow through a single code path that enforces the complete payload schema.

## Fix Applied

In `src/core/swap-orchestrator.ts`, the inline payout DM payloads now include `invoice_token` from the `createPayoutInvoice()` result:

```typescript
this.messageSender.sendToParty(swap.swap_id, 'A', {
  type: 'invoice_delivery',
  swap_id: manifest.swap_id,
  invoice_type: 'payout',
  invoice_id: payoutAId,
  ...(payoutAResult.token ? { invoice_token: payoutAResult.token } : {}),
});
```

A better long-term fix would refactor to call the existing `deliverPayoutInvoice()` helper directly, ensuring a single source of truth for the DM schema.

## Verification

To verify the fix, observe the payout `invoice_delivery` DM size:
- **Before fix:** ~212 bytes (missing `invoice_token`)
- **After fix:** ~5500 bytes (includes serialized TXF invoice token)

The SDK's `parseInvoiceDelivery()` will now accept the message, `swap:payout_received` will fire, auto-verification will run, and `swap:completed` will be emitted.

## Related Test Gap

The escrow-service e2e test suite needs a test that exercises the full DM-based swap protocol using the SDK's SwapModule as the consumer. The current test proves the escrow's internal logic works but does not validate that the DMs it sends are parseable by SDK consumers. This is a critical integration gap.
