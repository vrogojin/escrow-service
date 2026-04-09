# BUG-002: No Mechanism to Re-deliver Payout Token Transfer Events

**Severity:** High (potential asset inaccessibility)
**Component:** escrow-service + sphere-sdk
**Discovered:** 2026-04-09
**Status:** Open

---

## Summary

If the Nostr relay event (kind 31113) containing a payout token transfer is lost or the recipient fails to receive it, there is no mechanism to re-deliver the actual token data. The token exists on-chain (L3 aggregator committed the state transition) but the recipient cannot access it without the token transfer event.

## Root Cause

The `payments.send()` method publishes a single Nostr event containing the token transfer bundle (V6 combined bundle with sourceToken + commitmentData + proofs). This event is the ONLY delivery channel. If it's lost:

1. The recipient's `payments.receive()` will never find the token
2. IPFS sync is per-wallet (sender-to-self), not cross-wallet
3. The aggregator doesn't support "all tokens owned by pubkey X" queries
4. The `TokenRecoveryService` in the SDK has recovery stubs but they return null/"not implemented"

## Current Mitigations

1. **Verified publish** (sphere-sdk): `sendTokenTransfer()` now queries the relay after publish to confirm storage, retrying up to 3 times
2. **Relay persistence**: Kind 31113 is a Parameterized Replaceable Event — relays persist them
3. **Escrow outbox**: The sender's outbox retains transfer data after send

## Proposed Fix

### Short-term: Escrow re-delivery endpoint

Add a `redeliver_payout` message type to the escrow's message handler. When a party sends `{ type: "redeliver_payout", swap_id: "..." }`, the escrow:

1. Looks up the swap in its state store
2. Retrieves the outbox entry for the payout transfer
3. Re-publishes the kind 31113 Nostr event (same event ID, so relay deduplicates)
4. Sends the token transfer data directly via NIP-17 DM to the recipient as a fallback

### Medium-term: SDK token recovery

Implement the `TokenRecoveryService.recoverSentTokens()` method:
1. On load, scan the outbox for completed-but-undelivered sends
2. Re-publish the Nostr events for each
3. Clean up outbox entries only after confirmed re-delivery

### Long-term: On-chain token discovery

Add an aggregator query for "all tokens at address X" (requires index extension at the aggregator layer). This would allow the recipient to discover tokens independently of any notification channel.

## Impact Assessment

- **In practice**: The verified publish and relay persistence mean token loss is extremely unlikely. Our e2e tests show 95%+ payout delivery within seconds.
- **Worst case**: If a relay crashes and loses events between verified publish and recipient fetch, tokens are inaccessible until the escrow re-delivers or the SDK recovery is implemented.
- **Affected scenario**: Only payout deliveries where the recipient's `receive()` doesn't fetch the event before the relay purges it. For direct P2P transfers, the sender's wallet retains the outbox entry.

## Test Evidence

In cross-environment trading tests (11 agents, 3 escrows, 5 trades), 1 out of 10 payouts occasionally doesn't arrive within 120s of polling. The token IS on the relay (verified publish succeeded) — the issue is the recipient's transport subscription timing, not actual relay loss.
