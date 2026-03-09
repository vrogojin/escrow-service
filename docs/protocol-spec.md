# Escrow Protocol Specification

## 1. Wire Formats

All communication between parties and the escrow service uses NIP-17 encrypted direct messages (DMs) over Nostr relays. Messages are JSON objects with a `type` field discriminator.

**Message versioning:** All messages include an optional `v` field (integer, defaults to `1` if absent). The escrow and parties should ignore unknown fields for forward compatibility. Breaking changes to existing message types require incrementing `v` and supporting both old and new formats during a transition period.

### 1.1 Party → Escrow Messages

#### `announce`

Submit a swap manifest to the escrow service.

```json
{
  "type": "announce",
  "manifest": {
    "swap_id": "<64 hex chars — SHA-256 of other fields>",
    "party_a_address": "<DIRECT:// | PROXY:// | @nametag>",
    "party_b_address": "<DIRECT:// | PROXY:// | @nametag>",
    "party_a_currency_to_change": "<coinId, e.g. 'UCT'>",
    "party_a_value_to_change": "<positive integer string>",
    "party_b_currency_to_change": "<coinId, e.g. 'USDU'>",
    "party_b_value_to_change": "<positive integer string>",
    "timeout": "<integer, seconds, 60..86400>"
  }
}
```

**Validation rules:**
- `swap_id` must be exactly 64 lowercase hex characters
- `swap_id` must equal `SHA-256(JCS(manifest_fields))` where JCS is RFC 8785 (JSON Canonicalization Scheme). The `manifest_fields` object contains exactly these keys: `party_a_address`, `party_b_address`, `party_a_currency_to_change`, `party_a_value_to_change`, `party_b_currency_to_change`, `party_b_value_to_change`, `timeout`. The hash input is the JCS-serialized UTF-8 byte string of this object.
- Party addresses must differ
- Currencies must differ
- Values must be positive integer strings (no decimals; the current validator accepts any string matching `/^[0-9]+$/` with `BigInt(value) > 0n`). **Note:** The SDK's `createInvoice()` uses the stricter regex `/^[1-9][0-9]*$/` (rejects leading zeros). The escrow's validator should be tightened to match the SDK — values like `"007"` will pass the escrow's current check but fail at invoice creation time.
- Timeout must be an integer in range [60, 86400]

#### `status`

Query the current state of a swap.

```json
{
  "type": "status",
  "swap_id": "<64 hex chars>"
}
```

#### `deposit_instructions`

Request deposit payment information (legacy — replaced by `invoice_delivery` in the new design, but kept for backward compatibility).

```json
{
  "type": "deposit_instructions",
  "swap_id": "<64 hex chars>"
}
```

#### `request_invoice`

Request re-delivery of an invoice token. Used when a party lost their deposit or payout invoice token (e.g., DM delivery failed, client crash before import).

```json
{
  "type": "request_invoice",
  "swap_id": "<64 hex chars>",
  "invoice_type": "deposit" | "payout"
}
```

The escrow responds with an `invoice_delivery` message containing the requested token. The requesting party must be one of the swap's designated parties. **Note on authorization:** The DM sender is identified by their Nostr npub key, which exists in a different key space from the DIRECT:// chain addresses in the manifest. The escrow must maintain a mapping between Nostr npubs and chain addresses. This mapping is established during the `announce` phase: the DM sender's npub is recorded when they submit the manifest and is associated with the party role they claim. **Note:** The `invoice:payment` event reveals the payer's on-chain `senderAddress`, NOT their Nostr npub — on-chain payments do not disclose the DM identity. Parties who did not announce via DM cannot use `request_invoice` — they must first establish their Nostr identity by sending an `announce` message.

### 1.2 Escrow → Party Messages

#### `announce_result`

Response to a successful `announce`.

```json
{
  "type": "announce_result",
  "swap_id": "<64 hex chars>",
  "state": "DEPOSIT_INVOICE_CREATED",
  "deposit_invoice_id": "<64 hex chars — invoice token ID>",
  "created_at": "<ISO 8601 timestamp>",
  "is_new": true
}
```

#### `invoice_delivery`

Delivers an invoice token to a party. Used for both deposit and payout invoices.

```json
{
  "type": "invoice_delivery",
  "swap_id": "<64 hex chars>",
  "invoice_type": "deposit" | "payout",
  "invoice_id": "<64 hex chars — invoice token ID>",
  "invoice_token": "<TxfToken JSON — the full serialized invoice token>",
  "payment_instructions": {
    "your_currency": "<coinId>",
    "your_amount": "<amount string>",
    "memo": "INV:<invoice_id>:F"
  }
}
```

For deposit invoices: `payment_instructions` tells the receiving party which currency and amount they should pay. **Note:** If the party uses `payInvoice()`, the SDK constructs the memo automatically — the `memo` field here is informational for parties making raw transfers without the SDK.

For payout invoices: `payment_instructions` is omitted (the escrow pays, not the party). The party uses the token to verify receipt.

#### `status_result`

Response to a `status` query.

```json
{
  "type": "status_result",
  "swap_id": "<64 hex chars>",
  "state": "<current swap state>",
  "manifest": { ... },
  "deposit_invoice_id": "<64 hex chars>",
  "deposit_status": {
    "state": "<invoice state: OPEN|PARTIAL|COVERED|EXPIRED|CLOSED|CANCELLED>",
    "party_a_covered": true,
    "party_b_covered": false,
    "party_a_amount": "<deposited amount>",
    "party_b_amount": "<deposited amount>"
  },
  "payout_a_invoice_id": "<64 hex chars | null>",
  "payout_b_invoice_id": "<64 hex chars | null>",
  "created_at": "<ISO 8601>",
  "first_deposit_at": "<ISO 8601 | null>",
  "timeout_at": "<ISO 8601 | null>",
  "completed_at": "<ISO 8601 | null>",
  "error_message": "<string | null>"
}
```

**Derivation of `deposit_status` per-party fields:**

The escrow derives per-party coverage from `getInvoiceStatus(depositInvoiceId)`:

1. Get `status.targets[0].coinAssets` — the array of per-coin balance summaries
2. Asset at index 0 corresponds to `party_a_currency_to_change`, index 1 to `party_b_currency_to_change`
3. For each asset, iterate `coinAssets[i].transfers` (the raw `InvoiceTransferRef[]` array) to find the party's contribution:
   - Use each transfer's `senderAddress` field (the cryptographically-authenticated on-chain sender) — **not** `effectiveSender` from `senderBalances`, which is `refundAddress ?? senderAddress` and includes the self-asserted (unverified) `refundAddress`
   - Sum `amount` from transfers whose `senderAddress` matches the party's resolved DIRECT address
   - Set `party_X_covered = true` if the summed amount >= the requested amount
   - **Important:** Do not use `senderBalances` for identity verification — its keys are `effectiveSender` values, which include the self-asserted (unverified) `refundAddress` field
4. If a party has no matching transfers, `party_X_amount = "0"` and `party_X_covered = false`

**Authorization:** Status queries are only served if the requesting party's Nostr DM pubkey is associated with one of the swap's parties. Since Nostr npub keys and DIRECT:// chain addresses are in different key spaces, the escrow must establish this association during the announce phase (the DM sender who submits the manifest is recorded as one of the swap's parties). Queries from unrecognized npubs receive an `error` response with `"Unauthorized"`.

**Note:** The `deposit_status.state` field may show `EXPIRED` even while the escrow's application-level timeout has not yet fired. This happens because `dueDate` is set from invoice creation time, while the escrow timeout starts from the first deposit (see §4). The `state` field in the outer response (the swap state) is the authoritative indicator of escrow lifecycle status.

#### `payment_confirmation`

Sent after the escrow pays into a payout invoice.

```json
{
  "type": "payment_confirmation",
  "swap_id": "<64 hex chars>",
  "payout_invoice_id": "<64 hex chars>",
  "currency": "<coinId received>",
  "amount": "<amount string>",
  "status": "paid"
}
```

#### `swap_cancelled`

Sent to both parties when a swap is cancelled (timeout or manual cancellation).

```json
{
  "type": "swap_cancelled",
  "swap_id": "<64 hex chars>",
  "reason": "timeout",
  "deposits_returned": true
}
```

#### `bounce_notification`

Sent to a party when their payment is bounced back by the escrow.

```json
{
  "type": "bounce_notification",
  "swap_id": "<64 hex chars>",
  "reason": "UNKNOWN_SENDER" | "WRONG_CURRENCY" | "SWAP_NOT_FOUND" | "SWAP_CLOSED" | "ALREADY_COVERED",
  "returned_amount": "<amount string>",
  "returned_currency": "<coinId>"
}
```

#### `error`

Error response for any failed request.

```json
{
  "type": "error",
  "error": "<human-readable error message>",
  "details": [...]
}
```

## 2. Invoice Terms Structure

### 2.1 Deposit Invoice Terms

Created by the escrow when a manifest announcement is accepted.

```typescript
InvoiceTerms {
  creator: escrowChainPubkey,       // escrow's secp256k1 pubkey
  createdAt: Date.now(),            // creation timestamp (ms)
  dueDate: Date.now() + timeout * 1000,  // informational only
  memo: "Escrow deposit for swap <swap_id>",
  targets: [{
    address: "DIRECT://<escrow_pubkey_hex>",  // escrow's DIRECT address
    assets: [
      { coin: ["<party_a_currency>", "<party_a_value>"] },
      { coin: ["<party_b_currency>", "<party_b_value>"] },
    ]
  }]
}
```

**Key properties:**
- Single target: the escrow's own DIRECT address
- Two coin assets: one per party's required contribution
- `dueDate` is set to `createdAt + timeout * 1000` but is informational only — the escrow enforces timeout at the application level
- `creator` is the escrow's chain pubkey (non-anonymous — parties can verify the invoice creator)
- Invoice token ID = SHA-256 of the canonical serialization of InvoiceTerms

### 2.2 Payout Invoice Terms

Two separate invoices, created by the escrow after deposit coverage.

**Payout A** (party A receives party B's currency):

```typescript
InvoiceTerms {
  creator: escrowChainPubkey,
  createdAt: Date.now(),
  memo: "Swap <swap_id> payout to Party A",
  targets: [{
    address: "DIRECT://<party_a_resolved_pubkey>",
    assets: [
      { coin: ["<party_b_currency>", "<party_b_value>"] }
    ]
  }]
}
```

**Payout B** (party B receives party A's currency):

```typescript
InvoiceTerms {
  creator: escrowChainPubkey,
  createdAt: Date.now(),
  memo: "Swap <swap_id> payout to Party B",
  targets: [{
    address: "DIRECT://<party_b_resolved_pubkey>",
    assets: [
      { coin: ["<party_a_currency>", "<party_a_value>"] }
    ]
  }]
}
```

**Key properties:**
- Each payout invoice has exactly one target (the receiving party's DIRECT address)
- Each has exactly one coin asset (the counter-currency the party should receive)
- No `dueDate` — payout invoices are paid immediately by the escrow
- Party addresses must be resolved to DIRECT:// format before invoice creation

## 3. Swap Lifecycle Protocol

### Step 1: Off-chain Agreement

Parties A and B agree on swap terms off-service (e.g., via messaging, marketplace). They construct a swap manifest and compute the content-addressed `swap_id`.

### Step 2: Manifest Announcement

Either party sends an `announce` DM to the escrow with the manifest.

```
Party A ──[announce {manifest}]──▶ Escrow
```

The escrow validates the manifest. If valid:
- Creates a swap case in state `ANNOUNCED`
- Records the announcing party's Nostr npub as associated with a swap party (for later authorization of status queries and invoice re-delivery)
- Proceeds to Step 3 immediately
- If `createInvoice()` fails (e.g., aggregator unreachable), the escrow responds with an `error` message: `{"type": "error", "error": "Invoice creation failed", "details": [...]}`. The swap remains in `ANNOUNCED` state. The party may retry by re-sending the same `announce` message — the escrow detects the existing swap in `ANNOUNCED` state (via `swap_id` lookup) and re-attempts `createInvoice()` rather than creating a duplicate swap case.

If the second party also sends `announce` with the same manifest, the escrow returns the existing swap case (`is_new: false`) and records their npub association.

**Griefing note:** The `announce` message does not cryptographically prove that the DM sender is one of the parties listed in the manifest. A third party who obtains the manifest (e.g., from an untrusted channel) could submit it to the escrow, causing an invoice to be created. This is mitigated by the content-addressed `swap_id` — the announcement is only harmful if the attacker has the exact manifest. If this is a concern, the protocol could require that both parties announce independently before the deposit invoice is created (changing `ANNOUNCED` to a two-phase state). For the current trust model (parties share the manifest only with each other), single-party announcement is sufficient.

### Step 3: Deposit Invoice Creation

The escrow creates a deposit invoice via `accounting.createInvoice()`:

```
Escrow: createInvoice({
  targets: [{ address: escrowAddress, assets: [partyACoin, partyBCoin] }],
  memo: "Escrow deposit for swap <swap_id>",
  dueDate: now + timeout * 1000
})
```

Swap transitions: `ANNOUNCED → DEPOSIT_INVOICE_CREATED`

### Step 4: Invoice Token Delivery

The escrow delivers the deposit invoice token to **both** parties via DM:

```
Escrow ──[invoice_delivery {deposit, token, instructions_A}]──▶ Party A
Escrow ──[invoice_delivery {deposit, token, instructions_B}]──▶ Party B
```

Each party receives:
- The full invoice token (TxfToken) — they can import it with `accounting.importInvoice()`
- Payment instructions specific to their role (which currency and amount to pay)
- The invoice memo format: `INV:<invoice_id>:F`

### Step 5: Parties Pay Deposits

Each party pays into the deposit invoice using `payInvoice()` (which handles memo construction automatically) or by sending a raw transfer with the `INV:<invoice_id>:F` memo:

```
Party A ──[payInvoice: currency_A, value_A]──▶ Escrow (via invoice)
Party B ──[payInvoice: currency_B, value_B]──▶ Escrow (via invoice)
```

The on-chain transfer message encodes the invoice reference:

```json
{
  "inv": {
    "id": "<deposit_invoice_id>",
    "dir": "F",
    "ra": "DIRECT://<sender_refund_address>",
    "ct": { "a": "DIRECT://<sender_contact_address>" }
  }
}
```

### Step 6: Escrow Monitors and Validates Deposits

On each `invoice:payment` event, the escrow:

1. Calls `getInvoiceStatus(depositInvoiceId)` to get the current balance
2. Inspects the payment event's transfer data or iterates `targets[0].coinAssets[i].transfers` (raw `InvoiceTransferRef[]`) to identify the payer by their `senderAddress` field (cryptographically-authenticated on-chain address)
3. Resolves the sender's DIRECT address to determine which party they are:
   - Match against party A's resolved DIRECT address
   - Match against party B's resolved DIRECT address
4. Validates currency: party A must pay `party_a_currency_to_change`, party B must pay `party_b_currency_to_change`
5. If wrong sender or wrong currency → calls `returnInvoicePayment()`:

```typescript
await accounting.returnInvoicePayment(depositInvoiceId, {
  recipient: wrongSenderAddress,  // DIRECT:// address to return to
  amount: paymentAmount,          // amount to return (smallest units)
  coinId: wrongCoinId,
  freeText: 'Bounce: UNKNOWN_SENDER',  // optional annotation
});
```

6. **Already-covered check:** Before processing, verify the swap is not already in `DEPOSIT_COVERED` or later. If a party retries a payment with a new `transferId` after the invoice is already covered, bounce with reason `ALREADY_COVERED`.

On first valid deposit:
- Swap transitions: `DEPOSIT_INVOICE_CREATED → PARTIAL_DEPOSIT`
- Timeout timer starts: `setTimeout(handleTimeout, manifest.timeout * 1000)`

### Step 7: Deposit Coverage

**Note:** Steps 7, 8, and 9 are sub-steps within a single handler invocation (the `invoice:covered` event handler in SwapOrchestrator). They are numbered separately for clarity but execute as one sequential flow, not as separate asynchronous phases. However, this flow is **not transactional** — a crash between any sub-step leaves the swap in an intermediate state. The persist-before-act pattern (persisting `CONCLUDING` with payout IDs before calling `payInvoice()`) ensures crash recovery can resume from the correct point (see architecture.md §Crash Recovery).

When both parties have fully paid, the AccountingModule fires `invoice:covered`. The escrow:

1. **State guard:** only proceed if swap is in `DEPOSIT_INVOICE_CREATED` or `PARTIAL_DEPOSIT`
2. **Re-validate per-party coverage:** call `getInvoiceStatus()` and iterate `coinAssets[i].transfers` to verify that party A's `senderAddress` (the on-chain address, **not** `effectiveSender` from `senderBalances`) contributed to asset 0 and party B's to asset 1. The `invoice:covered` event only means aggregate amounts are met — an unauthorized sender could have contributed before being bounced. If validation fails, return the unauthorized payment and wait.
3. **Check for swapped-currency deposits:** Verify that each party paid their **own** required currency. Party A must contribute to asset 0 (`party_a_currency`) and party B to asset 1 (`party_b_currency`). If party A paid `party_b_currency` (or vice versa), bounce the payment with reason `WRONG_CURRENCY` even though the aggregate amounts may show coverage.
4. Transitions: `PARTIAL_DEPOSIT → DEPOSIT_COVERED` (or `DEPOSIT_INVOICE_CREATED → DEPOSIT_COVERED`). Note: `DEPOSIT_COVERED` is a transient state — the escrow immediately proceeds to closing and payout creation within the same handler. It is persisted only as a recovery checkpoint (as `CONCLUDING`) before payout.
5. Cancels the timeout timer
6. Closes the deposit invoice: `closeInvoice(depositInvoiceId)`
7. Creates two payout invoices (see §2.2)
8. Persists state as `CONCLUDING` with payout invoice IDs to SwapStateStore
9. Transitions: `DEPOSIT_COVERED → CONCLUDING`

### Step 8: Escrow Pays Payout Invoices

The escrow pays into both payout invoices:

```typescript
// Pay party A's payout invoice (target 0, asset 0 = party B's currency)
await accounting.payInvoice(payoutAInvoiceId, {
  targetIndex: 0,   // first (only) target
  assetIndex: 0,    // first (only) asset — party B's currency
  amount: manifest.party_b_value_to_change,
});

// Pay party B's payout invoice (target 0, asset 0 = party A's currency)
await accounting.payInvoice(payoutBInvoiceId, {
  targetIndex: 0,
  assetIndex: 0,    // first (only) asset — party A's currency
  amount: manifest.party_a_value_to_change,
});
```

### Step 9: Payout Delivery and Confirmation

The escrow delivers payout invoice tokens + confirmation to both parties:

```
Escrow ──[invoice_delivery {payout, token_A}]──▶ Party A
Escrow ──[payment_confirmation {payout_A, paid}]──▶ Party A

Escrow ──[invoice_delivery {payout, token_B}]──▶ Party B
Escrow ──[payment_confirmation {payout_B, paid}]──▶ Party B
```

Swap transitions: `CONCLUDING → COMPLETED`

### Step 10: Party Verification

Each party independently verifies the swap:

1. Import the payout invoice token: `accounting.importInvoice(payoutToken)`
2. Check invoice status: `accounting.getInvoiceStatus(payoutInvoiceId)`
3. Verify `state === 'COVERED'` or `state === 'CLOSED'`
4. Verify the correct currency and amount in `targets[0].coinAssets[0]`
5. Optionally wait for `allConfirmed === true` (unicity proofs generated)

## 4. Timeout Protocol

### Timer Start

The timeout timer starts when the **first valid deposit** is received (first `invoice:payment` event that passes sender validation). This matches the existing escrow behavior.

### Timer Duration

`manifest.timeout` seconds (integer, range 60–86400).

### Expiry Flow

```
TimeoutManager fires
    │
    ▼
Escrow checks swap state
    │
    ├── State is PARTIAL_DEPOSIT:
    │   ▼
    │   cancelInvoice(depositInvoiceId, { autoReturn: true })
    │   │
    │   ▼ Swap transitions: PARTIAL_DEPOSIT → TIMED_OUT → CANCELLING
    │   │
    │   ▼ AccountingModule auto-return:
    │     - Freezes balances (CANCELLED state)
    │     - For each sender balance: records intent → sends return → marks completed
    │     - Dedup ledger prevents double-returns on crash recovery
    │   │
    │   ▼ invoice:cancelled event
    │   │
    │   ▼ Swap transitions: CANCELLING → CANCELLED
    │
    ├── State is DEPOSIT_COVERED or later:
    │   ▼ (no-op — coverage won the race)
    │
    └── State is terminal (COMPLETED/CANCELLED/FAILED):
        ▼ (no-op)
```

### Manual Cancellation (Admin API)

The `DEPOSIT_INVOICE_CREATED → TIMED_OUT` transition is **not** triggered by the TimeoutManager (the timer only starts on first deposit). It requires explicit operator intervention via an admin API:

```
Admin API call: cancelSwap(swapId)
    │
    ▼
cancelInvoice(depositInvoiceId, { autoReturn: true })
    │
    ▼ Swap transitions: DEPOSIT_INVOICE_CREATED → TIMED_OUT → CANCELLING
    │
    ▼ No deposits to return (autoReturn is a no-op)
    │
    ▼ invoice:cancelled event
    │
    ▼ Swap transitions: CANCELLING → CANCELLED
```

### Timeout Notifications

After cancellation, the escrow notifies both parties:

```json
{
  "type": "swap_cancelled",
  "swap_id": "<64 hex chars>",
  "reason": "timeout",
  "deposits_returned": true
}
```

## 5. Error Handling Protocol

### Bounce-Back Reasons

When the escrow returns a payment via `returnInvoicePayment()`, it includes a reason in the DM notification (via `bounce_notification` message). Reason codes are aligned with the existing escrow codebase:

| Reason | Description |
|---|---|
| `UNKNOWN_SENDER` | Sender does not match party A or party B |
| `WRONG_CURRENCY` | Sender paid the wrong currency for their role |
| `SWAP_NOT_FOUND` | No swap case matches the invoice |
| `SWAP_CLOSED` | Swap is in a terminal state (COMPLETED, CANCELLED, FAILED) |
| `ALREADY_COVERED` | The party's required asset is already fully covered |

The bounce-back uses the `:B` (back) direction code in the invoice memo:

```
INV:<invoice_id>:B Bounce: UNKNOWN_SENDER
```

### Retry Semantics

- Parties may retry failed payments. The AccountingModule deduplicates by `transferId::coinId`.
- The escrow does not explicitly retry — it relies on AccountingModule's idempotent operations.
- Auto-return retries up to 5 times (via `AutoReturnManager.MAX_RETRY_COUNT`). After exhaustion, entries are marked `failed` and can be reset by calling `setAutoReturn()` again.

### Post-Cancellation Payments

Payments may arrive after the deposit invoice has been cancelled (e.g., network latency, Nostr relay delay). The AccountingModule handles this automatically:

- If `autoReturn` was enabled on `cancelInvoice()`, post-cancellation payments are auto-returned via the dedup ledger
- The `invoice:payment` event still fires for post-cancellation payments, but `getInvoiceStatus()` will show `state: 'CANCELLED'`
- The escrow's `invoice:payment` handler should check the swap state — if `TIMED_OUT`, `CANCELLING`, or `CANCELLED`, ignore the event (auto-return handles it)
- Auto-returned payments use the `:RX` (return_cancelled) direction code in the memo

### Failure States

A swap enters `FAILED` state on unrecoverable errors:
- Invoice creation failure (aggregator unreachable after retries)
- Payout payment failure (insufficient escrow balance)
- State store persistence failure (database down)

Failed swaps require manual intervention. The escrow logs the error message and notifies both parties.

## 6. Invoice Memo Conventions

### Transport Memo Format

All invoice-related transfers use the `INV:` memo format:

```
INV:<invoice_id>:<direction> [free_text]
```

Where:
- `<invoice_id>` — 64 lowercase hex characters (the invoice token ID)
- `<direction>` — one of:
  - `F` (forward) — payment toward the invoice
  - `B` (back) — return/bounce of a payment
  - `RC` (return_closed) — return from a closed invoice
  - `RX` (return_cancelled) — return from a cancelled invoice
- `[free_text]` — optional annotation (max 256 chars outbound, 1024 inbound)

### On-Chain Message Format

The authoritative invoice reference is encoded in `TransferTransactionData.message` as UTF-8 JSON:

```json
{
  "inv": {
    "id": "<64-hex invoice ID>",
    "dir": "F",
    "ra": "DIRECT://<refund_address>",
    "ct": {
      "a": "DIRECT://<contact_address>",
      "u": "https://contact.example.com"
    }
  },
  "txt": "Optional free text"
}
```

Fields:
- `inv.id` — invoice ID (required, normalized to lowercase)
- `inv.dir` — direction code (required: `F`, `B`, `RC`, `RX`)
- `inv.ra` — refund address (optional, DIRECT:// format, max 256 chars)
- `inv.ct.a` — contact address (optional, DIRECT:// format, max 256 chars)
- `inv.ct.u` — contact URL (optional, https:// or wss://, max 2048 chars)
- `txt` — free text (optional, max 1024 code points)

### Swap ID ↔ Invoice Memo Mapping

The swap ID is **not** directly embedded in the invoice memo. Instead:
- The deposit invoice's `memo` field contains the swap ID: `"Escrow deposit for swap <swap_id>"`
- Payments reference the **invoice ID** (not the swap ID) in the `INV:` memo
- The escrow maps invoice IDs back to swap IDs via the SwapStateStore

This decoupling is intentional — the AccountingModule operates on invoice IDs, while the escrow manages the swap↔invoice mapping.

## 7. Address Resolution

### Resolution Flow

Manifest party addresses may use three formats:
1. `DIRECT://<hex_pubkey>` — already resolved, use directly
2. `PROXY://<proxy_id>` — resolve via PROXY→DIRECT mapping (sphere-sdk ProxyModule)
3. `@<nametag>` — resolve via nametag lookup (sphere-sdk NametagModule)

Resolution happens **once at announcement time**:

```
announce received
    │
    ▼
Resolve party_a_address → DIRECT://...
Resolve party_b_address → DIRECT://...
    │
    ▼
Cache resolved addresses in SwapStateStore
    │
    ▼
Use resolved DIRECT addresses for:
  - Invoice target addresses
  - Sender validation in deposit monitoring
  - Payout invoice target addresses
```

### Resolution Caching

Resolved addresses are cached in the swap case to avoid re-resolution. This prevents a nametag reassignment mid-swap from causing party misidentification.

### Sender Matching

When validating deposit senders, the escrow compares the transfer's **on-chain sender address** (`InvoiceTransferRef.senderAddress`) against both parties' cached resolved DIRECT addresses:

```typescript
function identifyParty(senderAddress: string, swap: SwapCase): 'A' | 'B' | null {
  if (senderAddress === swap.resolved_party_a_address) return 'A';
  if (senderAddress === swap.resolved_party_b_address) return 'B';
  return null;
}
```

**Security note:** The escrow must use `senderAddress` (the cryptographically-authenticated on-chain sender), **not** `effectiveSender` (which is `refundAddress ?? senderAddress`). The `refundAddress` field (`inv.ra` in the on-chain message) is self-asserted by the sender without cryptographic proof of ownership — a malicious sender could set `inv.ra` to party A's address to impersonate them. The `senderAddress` is derived from the transfer's cryptographic signature and cannot be forged.

DIRECT address comparison is **case-sensitive exact string match** (matching the SDK's convention — see `balance-computer.ts` line 12 and `isTarget()` which uses `Set.has()`). The escrow MUST store the exact DIRECT address format returned by the SDK's address resolution methods, without modification. If addresses are compared at the application level (e.g., `identifyParty()`), the comparison must also be case-sensitive. **No case normalization is applied** — JCS (RFC 8785) preserves string values exactly as-is, and the SDK performs case-sensitive matching throughout. Addresses must be used in exactly the format provided by the SDK's resolution methods.

**Migration note:** The existing escrow codebase (`address.ts`) applies `normalizeAddress()` which lowercases the hex portion of DIRECT addresses. This is **incompatible** with the SDK's case-sensitive matching. The new `identifyParty()` implementation must use the SDK-returned address strings verbatim — do not pipe them through `normalizeAddress()`. The `normalizeAddress()` function should be deprecated or restricted to display-only contexts.

## 8. Verification Protocol

### Party Verification of Swap Completion

After receiving payout notification, each party independently verifies:

1. **Import payout invoice token:**
   ```typescript
   const terms = await accounting.importInvoice(payoutToken);
   ```

2. **Verify invoice terms match expectations:**
   - `terms.targets[0].address` === my DIRECT address
   - `terms.targets[0].assets[0].coin[0]` === expected currency
   - `terms.targets[0].assets[0].coin[1]` === expected amount
   - `terms.creator` === escrow's known chain pubkey

3. **Check invoice status:**
   ```typescript
   const status = await accounting.getInvoiceStatus(payoutInvoiceId);
   ```
   - `status.state` should be `'COVERED'` or `'CLOSED'`
   - `status.targets[0].coinAssets[0].isCovered` should be `true`
   - `status.targets[0].coinAssets[0].netCoveredAmount` >= expected amount

4. **Wait for confirmation (optional):**
   - `status.allConfirmed === true` means all tokens have unicity proofs
   - This may take a few seconds after payment as proofs are generated

### Escrow Verification

The escrow can verify its own operations by checking:
- Deposit invoice is `CLOSED` with correct frozen balances
- Both payout invoices are `COVERED` (or `CLOSED` after receipts)
- No pending auto-return entries in the dedup ledger

### Third-Party Audit

Because invoices are on-chain tokens with cryptographic proofs:
- Any party with the invoice token can verify its terms
- The aggregator's Sparse Merkle Tree provides inclusion proofs for all state transitions
- Transfer histories are traceable via the invoice-transfer index
