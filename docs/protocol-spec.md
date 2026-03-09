# Escrow Protocol Specification

## 1. Wire Formats

All communication between parties and the escrow service uses NIP-17 encrypted direct messages (DMs) over Nostr relays. Messages are JSON objects with a `type` field discriminator.

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
- `swap_id` must equal `SHA-256(canonical(party_a_address, party_b_address, party_a_currency_to_change, party_a_value_to_change, party_b_currency_to_change, party_b_value_to_change, timeout))`
- Party addresses must differ
- Currencies must differ
- Values must be positive integer strings (no decimals, no leading zeros except "0")
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

For deposit invoices: `payment_instructions` tells the receiving party which currency and amount they should pay.

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
- Proceeds to Step 3 immediately

If the second party also sends `announce` with the same manifest, the escrow returns the existing swap case (`is_new: false`).

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

Each party pays into the deposit invoice using `payInvoice()` or by sending a transfer with the `INV:<invoice_id>:F` memo:

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
2. Inspects `targets[0].coinAssets[i].senderBalances` to identify the payer
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

On first valid deposit:
- Swap transitions: `DEPOSIT_INVOICE_CREATED → PARTIAL_DEPOSIT`
- Timeout timer starts: `setTimeout(handleTimeout, manifest.timeout * 1000)`

### Step 7: Deposit Coverage

When both parties have fully paid, the AccountingModule fires `invoice:covered`. The escrow:

1. Transitions: `PARTIAL_DEPOSIT → DEPOSIT_COVERED`
2. Cancels the timeout timer
3. Closes the deposit invoice: `closeInvoice(depositInvoiceId)`
4. Creates two payout invoices (see §2.2)
5. Transitions: `DEPOSIT_COVERED → CONCLUDING`

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

When the escrow returns a payment via `returnInvoicePayment()`, it includes a reason in the DM notification:

| Reason | Description |
|---|---|
| `UNKNOWN_SENDER` | Sender does not match party A or party B |
| `WRONG_CURRENCY` | Sender paid the wrong currency for their role |
| `SWAP_NOT_FOUND` | No swap case matches the invoice |
| `ALREADY_CANCELLED` | Invoice was already cancelled (timeout expired) |

The bounce-back uses the `:B` (back) direction code in the invoice memo:

```
INV:<invoice_id>:B Bounce: UNKNOWN_SENDER
```

### Retry Semantics

- Parties may retry failed payments. The AccountingModule deduplicates by `transferId::coinId`.
- The escrow does not explicitly retry — it relies on AccountingModule's idempotent operations.
- Auto-return retries up to 5 times (via `AutoReturnManager.MAX_RETRY_COUNT`). After exhaustion, entries are marked `failed` and can be reset by calling `setAutoReturn()` again.

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

When validating deposit senders, the escrow compares the transfer's sender DIRECT address against both parties' cached resolved DIRECT addresses:

```typescript
function identifyParty(senderDirectAddress: string, swap: SwapCase): 'A' | 'B' | null {
  if (senderDirectAddress === swap.resolved_party_a_address) return 'A';
  if (senderDirectAddress === swap.resolved_party_b_address) return 'B';
  return null;
}
```

Note: DIRECT address comparison is **case-sensitive exact string match** (per AccountingModule convention).

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
