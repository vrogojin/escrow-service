# BUG: Swap DM Delivery Failure in Long-Running Sphere Processes

## Summary

When two Sphere SDK instances run as **long-running processes** (not short-lived CLI commands), swap protocol DMs (`swap_proposal:`, `swap_acceptance:`, escrow messages) are NOT delivered between them via the `MultiAddressTransportMux`. The same swap flow works perfectly when executed via separate CLI command invocations (each creating a fresh Sphere instance).

## Impact

**Critical** — the entire swap execution pipeline fails. Agents can negotiate deals (NP-0 protocol over DMs works), but the SDK-level swap (`proposeSwap` / `acceptSwap` / escrow announce / deposit / payout) never completes because DMs between the SwapModules are not delivered.

## Reproduction

### Working: CLI separate commands (sphere-sdk e2e tests)

```bash
# Each command creates a fresh Sphere instance, sends/receives, exits
sphere-cli swap-propose --to @bob --offer "1 BTC" --want "10 ETH" --escrow @escrow
# Returns immediately. Bob runs:
sphere-cli swap-accept <swap-id>   # Retries fetchPendingEvents until DM found
sphere-cli swap-deposit <swap-id>
# Swap completes in ~15 seconds
```

This works because each CLI invocation:
1. Creates a new `Sphere.load()` instance
2. The `MultiAddressTransportMux.connect()` does an initial fetch of ALL pending events
3. Events are processed
4. Process exits

### Failing: Long-running processes (agentic hosting Docker containers)

```
Alice container: Sphere.init() → stays running for minutes
Bob container:   Sphere.init() → stays running for minutes

1. Bob calls proposeSwap() → sends swap_proposal: DM to Alice → SUCCESS
2. Alice's SwapModule.onDirectMessage should fire → NEVER FIRES
3. Bob's swap stays in EXECUTING forever
4. Alice never calls acceptSwap()
```

## Root Cause Analysis

The `MultiAddressTransportMux` in `sphere-sdk/transport/MultiAddressTransportMux.ts` manages DM delivery for multi-address wallets. It:

1. Creates its OWN WebSocket connection to Nostr relays (separate from the original transport)
2. Subscribes to two filters:
   - `walletFilter` (kinds 4, 31113, 31115, 31116) — wallet events
   - `chatFilter` (kind 1059 / GIFT_WRAP) — NIP-17 DMs including swap protocol messages
3. Suppresses the original transport's subscriptions (`suppressSubscriptions()`)
4. The `CommunicationsModule` and `SwapModule` receive DMs through the Mux adapter

### What fails

The Mux's persistent `chatFilter` subscription (kind 1059) stops receiving events after a few minutes. Evidence:

```
[Mux] No wallet events for 300s — re-subscribing
```

This health check message only monitors the `walletFilter` subscription (non-gift-wrap events). There is **no health check for the chatFilter subscription**. When the chatFilter subscription silently dies, all NIP-17 DMs (including swap proposals) stop being delivered.

### Why fetchPendingEvents doesn't fully help

`MultiAddressTransportMux.fetchPendingEvents()` does a one-shot REQ query that includes kind 1059. It DOES eventually find the swap DMs (verified — the `swap_proposal:` message is dispatched after ~4 minutes). But:

1. The relay seems to delay indexing/returning newly published gift-wrap events in response to REQ queries
2. Each fetchPendingEvents poll returns a growing number of events (4 → 17 → 65 over time), suggesting the relay needs time to make events queryable
3. By the time the swap_proposal DM is delivered (~4 min), the swap may have timed out or the test window expired

### Why initial DMs work

NP-0 negotiation DMs (which DO arrive) are delivered during the initial `connect()` fetch or within the first few seconds when the persistent subscription is still alive. Swap DMs are sent LATER (after NP-0 negotiation completes), by which time the persistent subscription has died.

### Dedup bug (secondary)

The `handleEvent()` method adds event IDs to `processedEventIds` BEFORE processing. If `routeGiftWrap()` fails (e.g., decryption error), the event is permanently marked as processed and never retried. Fix: move dedup to AFTER successful dispatch.

### _trackedAddressesLoaded bug (secondary)

`_getActiveAddressesInternal()` returns `[]` when `_trackedAddressesLoaded` is false, which happens in tsup-bundled contexts. This breaks `proposeSwap()`'s party matching. Fix: remove the guard.

## Proposed Fix

### Immediate: Fix the Mux's chat subscription health check

Add a health check for the chatFilter subscription similar to the walletFilter one. If no gift-wrap events are received for N seconds, re-subscribe.

### Better: Ensure persistent subscriptions are reliable

Investigate why the chatFilter subscription dies. It could be:
- WebSocket connection reset not detected
- Relay closing the subscription without notification
- Subscription filter expiry

### Best: Add continuous process e2e tests

The SDK's existing swap tests use mocked transport (integration) or short-lived CLI commands (e2e). Neither tests the long-running continuous process scenario. Add tests that:

1. Create two Sphere instances in the SAME Node.js process
2. Keep them running (don't exit between operations)
3. Execute the full swap flow
4. Verify DMs are delivered in real-time (<5 seconds)

## Proposed Test Scenarios

### Test 1: Basic continuous-process swap

```typescript
// Two long-running Sphere instances, same Node.js process
const alice = await Sphere.init({ network: 'testnet', nametag: 'alice-test-xxx' });
const bob = await Sphere.init({ network: 'testnet', nametag: 'bob-test-xxx' });

// Fund both via faucet
await topup(alice, 'BTC', 10);
await topup(bob, 'ETH', 100);

// Alice proposes swap
const proposal = await alice.swap.proposeSwap({
  partyA: '@alice-test-xxx',
  partyB: '@bob-test-xxx',
  partyACurrency: 'BTC', partyAAmount: '1',
  partyBCurrency: 'ETH', partyBAmount: '10',
  escrowAddress: '@escrow-nametag',
  timeout: 3600,
});

// Bob should receive swap:proposal_received within 5 seconds
const proposalEvent = await waitForEvent(bob, 'swap:proposal_received', 5000);
assert(proposalEvent.swapId === proposal.swapId);

// Bob accepts
await bob.swap.acceptSwap(proposal.swapId);

// Both should reach 'announced' within 10 seconds
const aliceStatus = await waitForProgress(alice, proposal.swapId, 'announced', 10000);
const bobStatus = await waitForProgress(bob, proposal.swapId, 'announced', 10000);

// Both deposit
await alice.swap.deposit(proposal.swapId);
await bob.swap.deposit(proposal.swapId);

// Swap completes within 30 seconds
await waitForProgress(alice, proposal.swapId, 'completed', 30000);
await waitForProgress(bob, proposal.swapId, 'completed', 30000);

// Verify balances changed
```

### Test 2: DM delivery latency measurement

```typescript
// Measure actual DM delivery time between two long-running instances
const alice = await Sphere.init({ ... });
const bob = await Sphere.init({ ... });

// Wait 60s to simulate real-world "instances have been running for a while"
await sleep(60000);

// Send DM from Alice to Bob and measure delivery time
const sendTime = Date.now();
await alice.communications.sendDM('@bob-test-xxx', 'ping');

const dm = await waitForDM(bob, 10000);
const deliveryMs = Date.now() - sendTime;
console.log(`DM delivery: ${deliveryMs}ms`);
assert(deliveryMs < 5000, `DM delivery took ${deliveryMs}ms, expected <5000ms`);
```

### Test 3: DM delivery after subscription stale period

```typescript
// Verify DMs still work after the Mux subscription goes stale
const alice = await Sphere.init({ ... });
const bob = await Sphere.init({ ... });

// Wait 360s (beyond the 300s "No wallet events" threshold)
await sleep(360000);

// Send swap_proposal DM
const proposal = await alice.swap.proposeSwap({ ... });

// Bob MUST receive it within 5 seconds
const event = await waitForEvent(bob, 'swap:proposal_received', 5000);
assert(event);
```

## Environment

- Sphere SDK: feat/swap-module-spec branch
- Escrow service: /home/vrogojin/escrow-service
- Nostr relay: wss://nostr-relay.testnet.unicity.network
- Node.js: 22.x
- Transport: MultiAddressTransportMux (NostrTransportProvider suppressed)

## Files Affected

- `sphere-sdk/transport/MultiAddressTransportMux.ts` — chat subscription health check, dedup fix
- `sphere-sdk/core/Sphere.ts` — _getActiveAddressesInternal guard removal
- `sphere-sdk/tests/integration/` — new continuous-process swap tests needed

## Workaround

Call `sphere.fetchPendingEvents()` every 15 seconds. This partially works but events take ~4 minutes to appear in REQ query results, which is unacceptable for real-time swap execution.
