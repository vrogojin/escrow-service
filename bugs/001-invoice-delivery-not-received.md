# Bug 001 — `invoice_delivery` never delivered: escrow authorization always fails

**Status:** Fixed (2026-03-19)
**Severity:** Critical — swap flow is completely broken; no swap can ever deliver an invoice
**Affected components:** `escrow-service` (`src/sphere/message-handler.ts`), `sphere-sdk` (secondary)

---

## Symptom

After `swap-accept`, Bob's wallet never receives the `invoice_delivery` DM from the escrow.
`swap-deposit` fails with `Unauthorized` and then the swap transitions to `failed`:

```
sphere-cli swap-deposit e8ca9bcc...
Syncing...
[Swap] Escrow error: Unauthorized
  Ready.
Waiting for escrow to deliver deposit invoice (up to 60s)...
Swap did not reach 'announced' state (current: failed).
```

---

## Root Cause — Escrow authorization is fundamentally broken

The escrow's `npubMatchesPartyAddress()` in `src/sphere/message-handler.ts` tries to
match the Nostr **transport pubkey** of the DM sender against the **DIRECT:// address**
from the swap manifest. These two values are completely unrelated and will never match.

### Why they never match

A wallet's DIRECT:// address is derived via `UnmaskedPredicateReference` from the private
key — it is a **predicate hash**, not an encoding of any public key:

```
Bob's chainPubkey:   03227fdca774a45e98ede12bf5c1ac95e02a53bda1a07bdb82817dd71a8edd66ea
Bob's x-only pubkey: 227fdca774a45e98ede12bf5c1ac95e02a53bda1a07bdb82817dd71a8edd66ea
Bob's directAddress: DIRECT://00004c4158434340b41a8ddab847e0c8512eed00eabae9a0282ebb47367b0d240148572dc3f0
```

The directAddress content (`00004c...dc3f0`) is completely different from the chain pubkey or
transport pubkey. The checks in `npubMatchesPartyAddress` all fail:

```typescript
// Check 1: exact match — fails, different values
resolvedAddr === `DIRECT://${npubLower}`    // false

// Check 2: substring match — fails, pubkey not in address content
resolvedAddr.slice(9).includes(npubLower)  // false

// Check 3: manifest address exact match — same as check 1
manifestAddr === `DIRECT://${npubLower}`   // false
```

### Consequence

In `handleAnnounce`, `party` is always `null`:
- Role is never registered in `npubRoleMap`
- `deliverDepositInvoice` is never called (guarded by `party !== null`)

When Bob subsequently calls `request_invoice`:
- `authorizeNpub` checks `npubRoleMap.getRole(npub, swapId)` → `null` (never registered)
- Returns `Unauthorized`

**This bug has always been present. No swap has ever successfully delivered an invoice
to a real wallet.**

---

## Fix Required in `src/sphere/message-handler.ts`

### New approach: resolve sender's transport pubkey → directAddress via sphere SDK

The escrow must use `sphere.resolve(senderPubkey)` to map the Nostr transport pubkey
to the sender's full identity (including `directAddress`), then compare that against the
manifest party addresses.

`sphere.resolve()` accepts a 64-hex transport pubkey and queries the Nostr relay for
the sender's identity binding event, which maps transport pubkey → directAddress.

#### Changes to `handleAnnounce`

```typescript
// BEFORE (broken — transport pubkey never matches DIRECT:// address)
const npubLower = senderPubkey.toLowerCase();
if (npubMatchesPartyAddress(npubLower, swap.resolved_party_a_address, swap.manifest.party_a_address)) {
  party = 'A';
} else if (npubMatchesPartyAddress(npubLower, swap.resolved_party_b_address, swap.manifest.party_b_address)) {
  party = 'B';
}

// AFTER — resolve transport pubkey to directAddress first
const peerInfo = await sphere.resolve(senderPubkey);  // senderPubkey = transport pubkey
if (peerInfo?.directAddress) {
  const senderDirectAddr = peerInfo.directAddress.toLowerCase();
  const resolvedA = swap.resolved_party_a_address?.toLowerCase();
  const resolvedB = swap.resolved_party_b_address?.toLowerCase();
  if (senderDirectAddr === resolvedA) {
    party = 'A';
  } else if (senderDirectAddr === resolvedB) {
    party = 'B';
  }
}
```

`sphere.resolve(senderPubkey)` must be accessible in the message handler. Add it to
`MessageHandlerDeps` as `resolvePeer: (pubkey: string) => Promise<PeerInfo | null>`.

#### Changes to `authorizeNpub`

The `authorizeNpub` function also uses `npubMatchesPartyAddress` for the address back-check.
This needs the same fix. However, for the role map lookup path, the role was registered using
the transport pubkey as the key — this remains correct. Only the address back-check is broken.

Options:
1. **Resolve on every call** — call `sphere.resolve(npub)` inside `authorizeNpub` (requires
   making it async). More accurate but adds latency to every status/request_invoice call.
2. **Cache directAddress in npubRoleMap** — when registering the role, also store the
   resolved directAddress. Use the cached value for back-checks. Avoids repeated resolve calls.

Option 2 is preferred for performance. Extend `npubRoleMap.register()` to also accept the
resolved directAddress, and update `authorizeNpub` to compare using it.

#### `npubRoleMap` API change

```typescript
// Current
npubRoleMap.register(senderPubkey, result.swap_id, party);

// New — also store the resolved directAddress
npubRoleMap.register(senderPubkey, result.swap_id, party, resolvedDirectAddress);

// And getRole returns the stored address for back-check
npubRoleMap.getRole(npub, swapId): { role: 'A' | 'B', directAddress: string } | null
```

---

## Additional Fix: `sphere.resolve()` access in `MessageHandlerDeps`

Add `resolvePeer` to the deps interface in `src/sphere/message-handler.ts`:

```typescript
export interface MessageHandlerDeps {
  sphere: Sphere;
  // ... existing fields ...
  resolvePeer: (pubkey: string) => Promise<import('@unicitylabs/sphere-sdk').PeerInfo | null>;
}
```

And wire it up in the factory caller (`src/index.ts` or equivalent) as:
```typescript
resolvePeer: (pubkey) => sphere.resolve(pubkey),
```

---

## Secondary Issue: NIP-17 timestamp randomization

`sphere.communications.sendDM()` uses NIP-17 gift wraps with randomized `created_at`
(±2 days). This can cause messages to be invisible to relay `since` filters.

**sphere-sdk fix (already in `feat/swap-module-spec`):**
- `chatFilter.since = Math.max(0, dmSince - 172800)` in the always-on subscription
- `walletFilter.since = now - 86400 - 172800` in `fetchPendingEvents`

The escrow picks up this fix automatically (uses `sphere-sdk: "file:../sphere-sdk"`).
No escrow code change needed for this issue.

---

## Testing

After deploying the fix:

```bash
# Propose a swap
sphere-cli swap-propose \
  --offer ETH:10000000 \
  --want BTC:1000000 \
  --counterparty @bob \
  --escrow @test-escrow-swap

# Bob accepts
sphere-cli --profile bob swap-accept <swapId>

# Should advance to 'announced' state
sphere-cli --profile bob swap-deposit <swapId>
```

Expected: swap advances to `announced`, deposit is submitted. No `Unauthorized` errors.

---

## Files to modify in escrow-service

1. `src/sphere/message-handler.ts`
   - Add `resolvePeer` to `MessageHandlerDeps`
   - Fix `handleAnnounce`: resolve transport pubkey → directAddress before role assignment
   - Fix `authorizeNpub`: use cached directAddress for back-check instead of `npubMatchesPartyAddress`

2. `src/sphere/orchestrator-interfaces.ts`
   - Update `NpubRoleMap` interface: `register()` accepts directAddress, `getRole()` returns it

3. `src/core/` (if NpubRoleMap implementation lives there)
   - Update `register()` and `getRole()` implementations

4. `src/index.ts` (or entry point)
   - Wire `resolvePeer: (pubkey) => sphere.resolve(pubkey)` into `MessageHandlerDeps`

---

## Notes

- `sphere.resolve()` requires the party to have published an identity binding event
  (done automatically by sphere-sdk on `Sphere.init()`). This is the standard flow.
- If resolution fails (null), fall back to rejecting the announce — do not allow
  unresolvable senders to register roles (fail-closed).
- The `npubMatchesPartyAddress` function can be removed entirely after this fix.
