# Escrow Service — Test Suite Specification

## 1. Test Infrastructure & Conventions

### 1.1 Framework & Configuration

Vitest with 4 configuration tiers:

| Tier | Config File | Glob Pattern | Timeout | Pool |
|---|---|---|---|---|
| Unit | `vitest.config.ts` | `src/**/*.test.ts` (exclude `*.integration.*`, `*.e2e.*`, `*.e2e-live.*`) | 10s | default (forks) |
| Integration | `vitest.integration.config.ts` | `src/**/*.integration.test.ts` | 30s | default (forks) |
| E2E (mocked) | `vitest.e2e.config.ts` | `src/**/*.e2e.test.ts` | 120s | default (forks) |
| E2E (live) | `vitest.e2e-live.config.ts` | `src/**/*.e2e-live.test.ts` | 300s | `singleFork` |

**New config: `vitest.e2e-live.config.ts`**:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.e2e-live.test.ts'],
    globals: true,
    testTimeout: 300_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    retry: 0,
  },
});
```

**NPM scripts**:

```json
{
  "test": "vitest run",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "test:e2e": "vitest run --config vitest.e2e.config.ts",
  "test:e2e-live": "vitest run --config vitest.e2e-live.config.ts"
}
```

### 1.2 Naming Convention

All test descriptions use the `should <behavior>` pattern:

```typescript
it('should transition to PARTIAL_DEPOSIT on first valid payment', ...)
it('should bounce payment with wrong currency', ...)
```

### 1.3 New Test Helpers

#### `mock-accounting-module.ts`

Mock implementation of the AccountingModule interface for unit/integration tests.

```typescript
interface MockAccountingModule {
  // Invoice CRUD
  // NOTE: `createdAt` is a shim for SDK gap #8 (not yet in the real CreateInvoiceRequest).
  // Tests using `createdAt` verify aspirational deterministic-ID behavior.
  // Production code must NOT pass `createdAt` until gap #8 is merged into the SDK.
  createInvoice(request: CreateInvoiceRequest & { createdAt?: number }): Promise<CreateInvoiceResult>;
  getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus>;
  closeInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>;
  cancelInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>;
  payInvoice(invoiceId: string, params: PayInvoiceParams): Promise<TransferResult>;
  returnInvoicePayment(invoiceId: string, params: ReturnPaymentParams): Promise<TransferResult>;
  importInvoice(token: TxfToken): Promise<InvoiceTerms>;
  getInvoices(options?: GetInvoicesOptions): Promise<InvoiceRef[]>;

  // Event subscription (EventEmitter pattern)
  on(event: string, handler: Function): void;
  off(event: string, handler: Function): void;

  // Test control methods
  _simulatePayment(invoiceId: string, transfer: InvoiceTransferRef): void;
  _simulateCoverage(invoiceId: string): void;
  _simulateCancelled(invoiceId: string): void;
  _getInvoiceState(invoiceId: string): MockInvoiceState;
  _setInvoiceState(invoiceId: string, state: Partial<MockInvoiceState>): void;
}

interface MockInvoiceState {
  terms: InvoiceTerms;
  state: 'OPEN' | 'PARTIAL' | 'COVERED' | 'EXPIRED' | 'CLOSED' | 'CANCELLED';
  transfers: InvoiceTransferRef[];
  senderBalances: InvoiceSenderBalance[];  // array (not Map) — matches SDK InvoiceCoinAssetStatus.senderBalances
  isClosed: boolean;
  isCancelled: boolean;
}

// Note: InvoiceSenderBalance has these REQUIRED fields (no `?`):
//   senderAddress: string, netBalance: string, forwardedAmount: string,
//   returnedAmount: string, contacts: ReadonlyArray<{ address: string; url?: string }>
// All mock senderBalances entries MUST include contacts (use [] for empty).
```

Key behaviors:
- `createInvoice()` generates a deterministic invoice ID from SHA-256 of the canonical terms. When `request.createdAt` is provided, it is used directly in `InvoiceTerms.createdAt`; when omitted, `Date.now()` is used (matching SDK gap #8 behavior). Throws `INVOICE_ALREADY_EXISTS` if the computed ID matches an existing invoice.
- `_simulatePayment()` adds a transfer, updates balances, fires `invoice:payment` event
- `_simulateCoverage()` fires `invoice:covered` event with payload `{ invoiceId: string, confirmed: boolean }`
- `closeInvoice()` on already-closed throws `INVOICE_ALREADY_CLOSED`; on cancelled throws `INVOICE_ALREADY_CANCELLED`
- `cancelInvoice()` on already-cancelled throws `INVOICE_ALREADY_CANCELLED`; on closed throws `INVOICE_ALREADY_CLOSED`
- `payInvoice()` with remaining = 0 throws `INVOICE_INVALID_AMOUNT` **only when `params.amount` is omitted** (SDK computes remaining internally). If `params.amount` is explicitly `'0'`, the code hits a different path — crash recovery tests MUST omit `amount` to trigger this guard. On terminated invoice throws `INVOICE_TERMINATED`.
- `payInvoice()` and `returnInvoicePayment()` return `TransferResult` (not void). The orchestrator MUST check `result.status` — a `'failed'` status with silent continuation would advance swaps to COMPLETED without actual fund delivery.
- `returnInvoicePayment()` does NOT throw `INVOICE_TERMINATED` — the SDK allows returning payments to terminated invoices. Do not test for this error code on return operations.

#### `mock-invoice-status.ts`

Factory functions for creating `InvoiceStatus` objects with controlled `coinAssets`, `transfers`, and `senderBalances`.

```typescript
function createMockInvoiceStatus(opts: {
  invoiceId?: string;            // default: deterministic from opts hash
  state?: InvoiceState;          // default: 'OPEN'
  targetAddress: string;         // required — the target address (e.g., escrow DIRECT address)
  assets: Array<{
    coinId: string;
    requestedAmount: string;
    transfers?: InvoiceTransferRef[];
    senderBalances?: InvoiceSenderBalance[];
    isCovered?: boolean;
    netCoveredAmount?: string;
  }>;
  irrelevantTransfers?: IrrelevantTransfer[];  // default: []
  totalForward?: Record<string, string>;       // default: computed from assets
  totalBack?: Record<string, string>;          // default: {}
  allConfirmed?: boolean;                      // default: false
  lastActivityAt?: number;                     // default: Date.now()
  explicitClose?: boolean;
}): InvoiceStatus;
// Returns a complete InvoiceStatus with targets[0].address = targetAddress,
// targets[0].coinAssets[] populated from assets, targets[0].nftAssets = [],
// targets[0].isCovered = all assets covered, targets[0].confirmed = allConfirmed.

function createMockTransferRef(opts: {
  transferId: string;            // required — must be unique per transfer (ledger key)
  senderAddress: string | null;  // null for masked predicates
  refundAddress?: string;        // self-asserted return address (inv.ra)
  amount: string;
  coinId: string;
  direction?: 'inbound' | 'outbound';               // default: 'inbound'
  paymentDirection?: 'forward' | 'back' | 'return_closed' | 'return_cancelled';  // default: 'forward'
  destinationAddress?: string;   // default: escrow DIRECT address
  timestamp?: number;            // default: Date.now()
  confirmed?: boolean;           // default: true
  senderPubkey?: string;         // undefined for masked predicates (SDK type is `?: string`, not nullable)
  contact?: { address: string; url?: string };
}): InvoiceTransferRef;

function createMockSenderBalance(opts: {
  senderAddress: string;         // required — effectiveSender (refundAddress ?? senderAddress)
  netBalance: string;            // required — net amount after forwards and returns
  forwardedAmount: string;       // required — total forwarded
  returnedAmount?: string;       // default: '0'
  contacts?: ReadonlyArray<{ address: string; url?: string }>;  // default: [] — REQUIRED field on SDK type (no `?`)
}): InvoiceSenderBalance;
```

**Event handler signature:** The `invoice:payment` handler registered via `accounting.on('invoice:payment', handler)` receives the payload **directly** as its argument (not wrapped in `event.data`):
```typescript
// Correct handler pattern:
accounting.on('invoice:payment', (payload: {
  invoiceId: string;
  transfer: InvoiceTransferRef;
  paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  confirmed: boolean;
}) => {
  const sender = payload.transfer.senderAddress;  // ✓ correct
  // NOT: event.data.transfer.senderAddress        // ✗ wrong — extra .data nesting
});
```

#### `in-memory-swap-state-store.ts`

Replacement for `in-memory-store.ts` — the new simplified swap state store aligned with the invoice-based design.

```typescript
interface SwapRecord {
  swap_id: string;
  manifest: SwapManifest;
  state: SwapState;
  deposit_invoice_id: string | null;
  payout_a_invoice_id: string | null;
  payout_b_invoice_id: string | null;
  resolved_party_a_address: string;    // cached DIRECT:// address
  resolved_party_b_address: string;    // cached DIRECT:// address
  first_deposit_at: number | null;     // epoch ms
  timeout_at: number | null;           // epoch ms
  created_at: number;                  // epoch ms
  completed_at: number | null;         // epoch ms
  error_message: string | null;
  version: number;                     // optimistic concurrency
}

class InMemorySwapStateStore {
  create(manifest: SwapManifest, resolvedAddresses: ResolvedAddresses): SwapRecord;
  findBySwapId(swapId: string): SwapRecord | null;
  findByInvoiceId(invoiceId: string): SwapRecord | null;   // reverse lookup
  findNonTerminal(): SwapRecord[];
  updateState(swapId: string, newState: SwapState, updates: Partial<SwapRecord>, expectedVersion: number): SwapRecord | null;
}
```

Key differences from `InMemorySwapRepo`:
- No `party_a_deposited`/`party_b_deposited` fields (derived from `getInvoiceStatus()`)
- No `party_a_coin_id`/`party_b_coin_id` fields
- Adds `deposit_invoice_id`, `payout_a_invoice_id`, `payout_b_invoice_id`
- Adds `resolved_party_a_address`, `resolved_party_b_address`
- Adds `findByInvoiceId()` for reverse lookup from invoice events

#### `live-context.ts`

Setup/teardown for live E2E tests against real Unicity infrastructure.

```typescript
interface LiveTestContext {
  // Wallets
  escrowWallet: SphereInstance;
  partyAWallet: SphereInstance;
  partyBWallet: SphereInstance;
  charlieWallet: SphereInstance;  // third-party depositor (tests that any sender may deposit into correct currency slot)

  // Resolved addresses
  escrowAddress: string;    // DIRECT://...
  partyAAddress: string;
  partyBAddress: string;
  charlieAddress: string;

  // Nametags (timestamp-based to avoid collisions)
  escrowNametag: string;    // @escrow-test-<timestamp>
  partyANametag: string;    // @alice-test-<timestamp>
  partyBNametag: string;    // @bob-test-<timestamp>

  // Accounting modules
  escrowAccounting: AccountingModule;
  partyAAccounting: AccountingModule;
  partyBAccounting: AccountingModule;

  // Escrow service instance
  escrowService: EscrowService;

  // Infrastructure
  aggregatorUrl: string;
  nostrRelays: string[];

  // Helpers
  fundWallet(wallet: SphereInstance, coinId: string, amount: string): Promise<void>;
  waitForInvoiceState(accounting: AccountingModule, invoiceId: string, state: string, timeoutMs?: number): Promise<InvoiceStatus>;
  createManifest(overrides?: Partial<SwapManifest>): SwapManifest;
  cleanup(): Promise<void>;
}

async function createLiveTestContext(): Promise<LiveTestContext>;
```

---

## 2. Unit Tests

### 2.1 State Machine — `state-machine.test.ts`

**~41 tests** covering the new 10-state machine defined in `docs/architecture.md`.

The new state enum replaces the old one:

```typescript
// NEW states (architecture.md)
enum SwapState {
  ANNOUNCED,
  DEPOSIT_INVOICE_CREATED,
  PARTIAL_DEPOSIT,
  DEPOSIT_COVERED,
  CONCLUDING,
  COMPLETED,
  TIMED_OUT,
  CANCELLING,
  CANCELLED,
  FAILED,
}
```

#### Valid Transitions (~13 tests)

```
should allow ANNOUNCED → DEPOSIT_INVOICE_CREATED
should allow DEPOSIT_INVOICE_CREATED → PARTIAL_DEPOSIT
should allow DEPOSIT_INVOICE_CREATED → DEPOSIT_COVERED (both deposits before first event processed)
should allow DEPOSIT_INVOICE_CREATED → TIMED_OUT (admin cancel)
should allow PARTIAL_DEPOSIT → DEPOSIT_COVERED
should allow PARTIAL_DEPOSIT → TIMED_OUT
should allow DEPOSIT_COVERED → CONCLUDING
should allow CONCLUDING → COMPLETED
should allow TIMED_OUT → DEPOSIT_COVERED (coverage wins the race — SDK confirmed coverage)
should allow TIMED_OUT → CANCELLING
should allow CANCELLING → DEPOSIT_COVERED (coverage won — cancelInvoice got INVOICE_ALREADY_CLOSED)
should allow CANCELLING → CANCELLED
should allow any non-terminal state → FAILED
```

#### Invalid Transitions (~10 tests)

```
should reject ANNOUNCED → PARTIAL_DEPOSIT (must go through DEPOSIT_INVOICE_CREATED)
should reject ANNOUNCED → COMPLETED (skip states)
should reject PARTIAL_DEPOSIT → CONCLUDING (must go through DEPOSIT_COVERED)
should reject DEPOSIT_COVERED → COMPLETED (must go through CONCLUDING)
should reject DEPOSIT_COVERED → CANCELLED (must go through TIMED_OUT → CANCELLING)
should reject CONCLUDING → CANCELLED
should reject COMPLETED → any state (terminal)
should reject CANCELLED → any state (terminal)
should reject FAILED → any state (terminal)
should reject CANCELLING → CONCLUDING
```

#### Terminal State Checks (~5 tests)

```
should identify COMPLETED as terminal
should identify CANCELLED as terminal
should identify FAILED as terminal
should not identify PARTIAL_DEPOSIT as terminal
should not identify ANNOUNCED as terminal
```

#### `canAcceptDeposit()` (~5 tests)

```
should return true for DEPOSIT_INVOICE_CREATED
should return true for PARTIAL_DEPOSIT
should return false for ANNOUNCED (no invoice yet)
should return false for DEPOSIT_COVERED
should return false for CONCLUDING
```

#### `getValidNextStates()` (~8 tests)

```
should return [DEPOSIT_INVOICE_CREATED, FAILED] for ANNOUNCED
should return [PARTIAL_DEPOSIT, DEPOSIT_COVERED, TIMED_OUT, FAILED] for DEPOSIT_INVOICE_CREATED
should return [DEPOSIT_COVERED, TIMED_OUT, FAILED] for PARTIAL_DEPOSIT
should return [CONCLUDING, FAILED] for DEPOSIT_COVERED
should return [COMPLETED, FAILED] for CONCLUDING
should return [CANCELLING, DEPOSIT_COVERED, FAILED] for TIMED_OUT
should return [CANCELLED, DEPOSIT_COVERED, FAILED] for CANCELLING
should return empty array for terminal states
```

---

### 2.2 SwapOrchestrator — `swap-orchestrator.test.ts`

**~55 tests** covering the central coordinator's event handling, state guards, race conditions, and DM delivery.

#### `invoice:payment` Event Handling (~14 tests)

```
should look up swap by deposit invoice ID on payment event
should call getInvoiceStatus() and iterate coinAssets[i].transfers to identify deposit by InvoiceTransferRef.coinId (not senderAddress)
should transition DEPOSIT_INVOICE_CREATED → PARTIAL_DEPOSIT on first valid deposit
should start timeout timer on first valid deposit
should NOT start timeout timer on second valid deposit (already running)
should accept deposit from charlie (third party) when charlie pays party_a_currency into asset[0]
should accept deposit from charlie (third party) when charlie pays party_b_currency into asset[1]
should call returnInvoicePayment() when sender paid wrong currency (party A's currency into asset[1] slot)
should use effectiveSender (refundAddress ?? senderAddress) as recipient for returnInvoicePayment()
should accept payment with senderAddress === null (masked predicate) when coinId matches the correct asset slot
should ignore payment event when swap is in TIMED_OUT or later state
should not call returnInvoicePayment() when swap state is CANCELLED (let autoReturn handle it)
should deliver bounce_notification DM to bounced sender in the invoice:payment handler (not only in invoice:covered)
should not call closeInvoice() or transition to DEPOSIT_COVERED within the payment handler (even when coverage is met — invoice:covered handles that)
```

#### `invoice:covered` Event Handling (~20 tests)

```
should transition PARTIAL_DEPOSIT → DEPOSIT_COVERED on coverage
should transition DEPOSIT_INVOICE_CREATED → DEPOSIT_COVERED (both deposits arrive before first event)
should re-validate coverage by checking that asset[0] netCoveredAmount >= party_a_value and asset[1] netCoveredAmount >= party_b_value (currency-slot check only — sender identity irrelevant)
should NOT proceed if asset slots are swapped (party_a_currency paid into asset[1], party_b_currency paid into asset[0])
should cancel timeout timer on coverage
should call closeInvoice(depositInvoiceId) without autoReturn — spy verifies options argument is undefined or {} (never { autoReturn: true })
should create two payout invoices with correct cross-currency targets
should NOT transpose payout invoices: payout A targets party A's DIRECT address with party B's currency, payout B targets party B's DIRECT address with party A's currency (negative test: fail if A's invoice targets A's own currency)
should call closeInvoice(depositInvoiceId) BEFORE createInvoice() for payouts — ordered sequence: [closeInvoice, createInvoice(payoutA), createInvoice(payoutB)] verified via call-order spy
should persist state as CONCLUDING with payout invoice IDs BEFORE payInvoice() — ordered sequence: [updateState(CONCLUDING), payInvoice(payoutA), payInvoice(payoutB)] verified via call-order spy (not just call count)
should call payInvoice() for both payout invoices
should transition to FAILED when payInvoice() returns TransferResult with status 'failed'
should transition to FAILED and cancel orphan payout invoice when first createInvoice(payoutA) succeeds but second createInvoice(payoutB) fails — verify cancelInvoice(payoutAId) called
should transition to FAILED when persist DEPOSIT_COVERED succeeds but closeInvoice() fails with unexpected error — swap is stranded but not lost (crash recovery can pick up)
should deliver payout invoice tokens to both parties via DM after payouts succeed (before COMPLETED transition)
should deliver bounce_notification DM to bounced sender with reason code when returnInvoicePayment() succeeds
should send payment_confirmation DM to party A with party_b_currency and party_b_value (not party A's own currency — negative transposition test)
should send payment_confirmation DM to party B with party_a_currency and party_a_value (both parties receive individual confirmations)
should transition CONCLUDING → COMPLETED after both payouts and DM delivery succeed
should accept charlie's contribution toward asset[0] coverage when charlie paid party_a_currency — coverage check is currency-only, payout goes to party A regardless of depositor
```

#### `invoice:cancelled` Event Handling (~3 tests)

```
should transition CANCELLING → CANCELLED on invoice:cancelled event
should persist CANCELLED state to SwapStateStore on invoice:cancelled
should ignore invoice:cancelled if swap is not in CANCELLING state (idempotency guard)
```

#### State Guards & Race Conditions (~15 tests)

```
should ignore invoice:covered if swap is already in DEPOSIT_COVERED or later (idempotency)
should ignore timeout if swap already transitioned to DEPOSIT_COVERED
should transition to TIMED_OUT if timeout fires before coverage
should ignore invoice:covered after TIMED_OUT (timeout won the race)
should catch INVOICE_ALREADY_CLOSED in coverage path and proceed if same-operation
should catch INVOICE_ALREADY_CANCELLED in coverage path and abort (timeout won)
should catch INVOICE_ALREADY_CLOSED in timeout path and abort (coverage won)
should transition to FAILED on unrecoverable error during conclusion
should send error DM to both parties when transitioning to FAILED (parties need notification for manual intervention)
should not call payInvoice() twice when invoice:covered fires concurrently before state transition completes (TOCTOU)
should prevent second conclusion attempt after CONCLUDING state is persisted (state guard check)
should not start duplicate timeout timer when two invoice:payment events fire concurrently for the same swap (second handler sees timer already running)
should handle duplicate announcement (return existing swap case with is_new: false)
should not call returnInvoicePayment() when swap state is COMPLETED or FAILED (terminal states)
should handle optimistic lock null return (version mismatch) by aborting the current operation and re-reading state (not silently continuing)
```

#### Rate Limiting — Wrong-Currency Payment Flooding (~3 tests)

```
should not call returnInvoicePayment() more than N times per minute per invoice (rate limit)
should log wrong-currency payments that exceed the rate limit without returning immediately
should not starve legitimate deposit processing when flooded with wrong-currency payments
```

---

### 2.3 InvoiceManager — `invoice-manager.test.ts`

**~14 tests** wrapping AccountingModule SDK methods with escrow-specific logic.

#### `createDepositInvoice()` (~4 tests)

```
should create invoice with escrow DIRECT address as single target
should create invoice with two coin assets (party A currency + party B currency)
should set memo to "Escrow deposit for swap <swap_id>"
should set dueDate to swap.created_at + timeout * 1000 (informational only)
```

#### `createPayoutInvoice()` (~3 tests)

```
should create payout A with party A's DIRECT address and party B's currency
should create payout B with party B's DIRECT address and party A's currency
should set memo to "Swap <swap_id> payout to Party <A|B>"
```

#### Error Code Handling (~5 tests)

```
should throw INVOICE_ALREADY_CLOSED when closeInvoice() on closed invoice
should throw INVOICE_ALREADY_CANCELLED when closeInvoice() on cancelled invoice
should throw INVOICE_ALREADY_CANCELLED when cancelInvoice() on cancelled invoice
should throw INVOICE_ALREADY_CLOSED when cancelInvoice() on closed invoice
should throw INVOICE_INVALID_AMOUNT when payInvoice() with remaining = 0
```

#### `returnInvoicePayment()` (~2 tests)

```
should pass effectiveSender as recipient (not raw senderAddress)
should include bounce reason in freeText parameter
```

---

### 2.4 TimeoutManager — `timeout-manager.test.ts`

**~14 tests** covering the simplified application-level timer.

```
should schedule timeout for manifest.timeout seconds from invocation
should fire callback after timeout duration elapses
should cancel scheduled timeout when cancel() is called
should be idempotent: calling cancel() on already-cancelled timer is a no-op
should not fire if cancelled before expiry
should handle multiple concurrent timeouts for different swap IDs
should report remaining time for a scheduled timeout
should re-register timeout with remaining time computed as timeout_at - Date.now() (not manifest.timeout from scratch — crash duration must not extend the window)
should not schedule timeout if swap is already in terminal state
should not fire if timeout already elapsed and swap progressed to DEPOSIT_COVERED
should persist TIMED_OUT state BEFORE calling cancelInvoice() — ordered sequence: [updateState(TIMED_OUT), cancelInvoice()] verified via call-order spy (crash between persist and cancel is recoverable; reverse is not)
should throw if scheduling timeout for swap that already has an active timer
should clear timer reference after firing (prevent memory leak)
should not extend timeout window when re-registering after crash (if first_deposit_at was 30s ago and timeout is 60s, timer fires in ~30s not 60s)
```

---

### 2.5 MessageHandler — `message-handler.test.ts`

**~24 tests** covering the DM-based protocol from `docs/protocol-spec.md`.

#### `announce` Message (~9 tests)

```
should create swap case and return announce_result with deposit_invoice_id
should record sender npub association with party role
should return existing swap case (is_new: false) when same manifest announced twice
should return error message when manifest validation fails
should reject announcement when nametag resolves to null (propagation delay — hard error, not soft warning)
should resolve PROXY:// address to DIRECT:// and cache the resolved address at announcement time
should allow second announcer to register additional npub for same party role only if their claim is consistent with existing mapping
should not overwrite resolved_party_a_address or resolved_party_b_address on second announce (addresses are immutable after first resolution — prevents nametag reassignment attacks)
should re-attempt createInvoice() when re-announce arrives for swap stuck in ANNOUNCED state (previous createInvoice() failed) — not create duplicate swap, not return is_new:false without retry
```

**Note on announce-first attack:** The manifest is public (shared off-service). An attacker who obtains it can announce first, claiming a party role. The `announce` handler MUST NOT blindly trust the first npub — it should record the association but the `request_invoice` authorization must verify against the resolved DIRECT addresses, not just npub association. The npub-to-role mapping is a convenience for DM routing, NOT a security boundary. On-chain `senderAddress` (cryptographic) is the only identity authority.

#### `status` Message (~5 tests)

```
should return status_result with swap state and deposit_status for authorized party
should derive per-party coverage from coinAssets[i].netCoveredAmount vs requestedAmount (currency-slot check)
should reject status query from unauthorized npub with error response
should reject status query from party A of swap 1 when querying swap 2 (cross-swap authorization scoping)
should reject status query from attacker who announced first (attacker npub in role map, but attacker's DIRECT address ≠ resolved party address) — npub presence in role map is insufficient; DIRECT address back-check required
```

#### `request_invoice` Message (~6 tests)

```
should re-deliver deposit invoice token to authorized party
should re-deliver payout invoice token to authorized party
should reject request from party not associated with the swap
should reject request for payout invoice when swap is not yet in CONCLUDING/COMPLETED
should reject request_invoice when sender npub has no recorded association (never announced)
should reject request_invoice from attacker who announced first (attacker npub in role map for party A, but attacker's DIRECT address ≠ resolved_party_a_address) — forces implementation to verify DIRECT address, not just npub-to-role mapping
```

#### Legacy Message Compatibility (~1 test)

```
should handle deposit_instructions message as alias for request_invoice with invoice_type='deposit' (backward compatibility)
```

#### Payout Invoice Token Security (~3 tests)

```
should not allow third party who imports payout invoice token to call cancelInvoice() on it
should not allow third party to redirect payout funds after importing intercepted invoice token
should verify payout invoice target address matches intended party (not the importer)
```

---

### 2.6 SwapStateStore — `swap-state-store.test.ts`

**~12 tests** covering the simplified persistence layer.

#### CRUD Operations (~5 tests)

```
should create swap record with manifest, state=ANNOUNCED, and resolved addresses
should find swap by swap_id
should find swap by deposit_invoice_id (reverse lookup)
should find swap by payout_a_invoice_id or payout_b_invoice_id (reverse lookup)
should return null for non-existent swap_id
```

#### State Updates with Optimistic Locking (~4 tests)

```
should update state and increment version on success
should return null when expectedVersion does not match (optimistic lock failure)
should update deposit_invoice_id alongside state transition
should update payout_a_invoice_id and payout_b_invoice_id alongside CONCLUDING transition
```

#### Query Methods (~3 tests)

```
should return all non-terminal swaps via findNonTerminal()
should not include COMPLETED swaps in findNonTerminal()
should not include CANCELLED or FAILED swaps in findNonTerminal()
```

---

### 2.7 ManifestValidator — `manifest-validator.test.ts`

**~4 tests** — focused on the leading-zero rejection alignment with SDK.

```
should reject value "007" (leading zeros — SDK regex /^[1-9][0-9]*$/ rejects these)
should reject value "0" (zero is not a positive integer)
should accept value "1" (valid positive integer)
should accept value "1000000000000000000" (large BigInt value)
```

Note: The existing manifest validator tests cover swap_id format, party address uniqueness, currency uniqueness, timeout range, etc. These 4 tests specifically address the leading-zero gap identified in `docs/protocol-spec.md` §1.1.

---

### 2.8 Deposit Validation — `deposit-validation.test.ts`

**~14 tests** covering the currency-slot identification logic described in `docs/architecture.md` §Deposit Validation.

Party identification is by **asset/currency type** (coinId), not by sender address. Any sender — including masked predicates and third parties — may deposit into the correct currency slot. The only bounce reason is `WRONG_CURRENCY`.

#### Currency-Slot Identification (~5 tests)

```
should accept any sender paying party_a_currency_to_change into asset[0] (coinId match — sender identity irrelevant)
should accept any sender paying party_b_currency_to_change into asset[1] (coinId match — sender identity irrelevant)
should accept deposit from charlie (third-party) when charlie pays party_a_currency into asset[0]
should accept deposit with senderAddress === null (masked predicate) when coinId matches asset[0]
should bounce payment with WRONG_CURRENCY when coinId does not match either asset slot
```

#### Third-Party Deposit Tests (~2 tests)

```
should accept deposit from charlie if charlie pays party_a_currency to asset[0] — swap transitions to PARTIAL_DEPOSIT
should accept deposit from charlie if charlie pays party_b_currency to asset[1] — swap transitions to DEPOSIT_COVERED when combined with prior party deposit
```

#### Return Routing (~4 tests)

```
should use effectiveSender (refundAddress ?? senderAddress) for returnInvoicePayment recipient on WRONG_CURRENCY bounce
should use raw senderAddress when no refundAddress is provided on WRONG_CURRENCY bounce
should use refundAddress when sender provided one on WRONG_CURRENCY bounce
should pass the specific transfer amount (not aggregated senderBalance) to returnInvoicePayment
```

#### Return Failure Handling (~1 test)

```
should log and queue failed returnInvoicePayment() when escrow has insufficient balance (rely on cancelInvoice autoReturn for cleanup)
```

#### BigInt Amount Handling (~2 tests)

```
should handle amounts as BigInt strings without precision loss
should correctly compare netCoveredAmount >= requestedAmount with BigInt arithmetic
```

---

### 2.9 Crash Recovery — `crash-recovery.test.ts`

**~41 tests** covering all recovery pairs from `docs/architecture.md` §Crash Recovery.

Each test sets up a swap in a specific (swap state, invoice state) pair, then runs the recovery procedure and verifies the resulting action. All re-validation steps check coverage by currency slot (coinId against asset index) — sender identity is not evaluated.

#### ANNOUNCED Recovery (~1 test)

```
should re-create deposit invoice when swap is ANNOUNCED with no invoice (creation failed or store write lost)
```

#### DEPOSIT_INVOICE_CREATED Recovery (~6 tests)

```
should re-subscribe to events when swap is DEPOSIT_INVOICE_CREATED and invoice is OPEN
should treat EXPIRED invoice as equivalent to OPEN and re-subscribe (dueDate is informational)
should re-register timeout with remaining time when invoice is PARTIAL
should resume conclusion when invoice is COVERED (re-validate by checking asset[0].netCoveredAmount >= party_a_value and asset[1].netCoveredAmount >= party_b_value — currency-slot check only)
should transition to CANCELLED when invoice is CANCELLED
should transition to FAILED when invoice is unexpectedly CLOSED
```

#### PARTIAL_DEPOSIT Recovery (~5 tests)

```
should re-register timeout with remaining time when invoice is PARTIAL
should treat EXPIRED invoice as equivalent to PARTIAL and re-register timeout
should resume conclusion when invoice is COVERED (re-validate by currency-slot coverage amounts — sender identity not checked)
should transition to CANCELLED when invoice is CANCELLED (timeout fired during crash)
should transition to FAILED when invoice is unexpectedly CLOSED with partial coverage
```

#### DEPOSIT_COVERED Recovery (~5 tests)

```
should re-validate coverage and revert to PARTIAL_DEPOSIT if asset slot amounts no longer meet thresholds (OPEN/PARTIAL/EXPIRED — auto-returns may have reduced netCoveredAmount below requestedAmount)
should re-validate coverage and proceed with conclusion if asset slot amounts still meet thresholds despite aggregate regression (OPEN/PARTIAL/EXPIRED — some auto-returns occurred but remaining deposits in each slot still suffice)
should transition to CANCELLED if invoice is CANCELLED and all deposits auto-returned
should transition to FAILED if invoice is CANCELLED but auto-returns are incomplete (funds at risk)
should create payout invoices and proceed with conclusion if invoice is CLOSED but payouts missing
```

#### CONCLUDING Recovery (~7 tests)

```
should check each payout invoice individually when deposit is CLOSED
should re-pay payout invoice if not yet covered (omit amount parameter to avoid double-payment)
should create payout invoice if payout_invoice_id is null, then pay
should catch INVOICE_INVALID_AMOUNT (remaining = 0) as success (payout already completed)
should catch INVOICE_TERMINATED as success (payout already closed/cancelled)
should handle (CONCLUDING, OPEN) pair — deposit invoice still OPEN means closeInvoice() didn't complete; close deposit invoice first, then proceed with payouts
should handle (CONCLUDING, COVERED) pair — deposit invoice covered but not yet closed; close deposit invoice first, then proceed with payouts
```

#### TIMED_OUT Recovery (~6 tests)

```
should call cancelInvoice() when swap is TIMED_OUT and invoice is still OPEN (deposits not yet returned)
should call cancelInvoice() when swap is TIMED_OUT and invoice is PARTIAL (partial deposits to return)
should call cancelInvoice() when swap is TIMED_OUT and invoice is EXPIRED (dueDate passed — still needs explicit cancel for autoReturn)
should transition TIMED_OUT → CANCELLING when invoice is already CANCELLED (autoReturn completed during crash)
should handle INVOICE_ALREADY_CLOSED during TIMED_OUT recovery (coverage won race — reconcile swap to DEPOSIT_COVERED and resume conclusion)
should handle (TIMED_OUT, COVERED) — coverage arrived but closeInvoice() not yet called; call closeInvoice() first, then reconcile to DEPOSIT_COVERED and resume conclusion (distinct from CLOSED case where closeInvoice() already ran)
```

#### CANCELLING Recovery (~5 tests)

```
should transition to CANCELLED when invoice is already CANCELLED
should call cancelInvoice() when swap is CANCELLING but invoice is still OPEN (cancel didn't complete before crash)
should call cancelInvoice() when swap is CANCELLING but invoice is still PARTIAL (cancel started but didn't complete)
should call cancelInvoice() when swap is CANCELLING but invoice is EXPIRED (dueDate passed, cancel didn't complete)
should handle (CANCELLING, COVERED) — coverage arrived after TIMED_OUT was persisted but before cancelInvoice() completed; call closeInvoice() first (coverage won), then resume conclusion via DEPOSIT_COVERED path
```

#### Deterministic Invoice ID Recovery (~3 tests)

These tests exercise the target behavior (SDK gap #8). The mock supports `createdAt` passthrough as a gap #8 shim.

```
should re-derive expected deposit invoice ID from swap.created_at and adopt existing invoice when deposit_invoice_id is null (ANNOUNCED recovery — requires gap #8)
should re-derive expected payout invoice IDs from swap.created_at and adopt existing invoices when payout_invoice_id is null (CONCLUDING recovery — requires gap #8)
should re-create deposit invoice with same deterministic ID when getInvoiceStatus returns INVOICE_NOT_FOUND (invoice was never created — requires gap #8)
```

#### Interim Orphan Recovery (~1 test)

```
should adopt orphaned deposit invoice via memo scan when deposit_invoice_id is null and gap #8 is unavailable (interim behavior — scan getInvoices by memo pattern)
```

#### Concurrent Announce Race (~1 test)

```
should catch INVOICE_ALREADY_EXISTS on concurrent createInvoice() within same process and treat as success (same-process guard only — does NOT fire after restart; see architecture.md §Race Conditions)
```

#### Partial Payout Edge Cases (~1 test)

```
should catch INVOICE_NOT_FOUND on payout retry and re-import via importInvoice() before retrying
```

---

## 3. Integration Tests — `swap-lifecycle.integration.test.ts`

**~25 tests** using `InMemorySwapStateStore` + `MockAccountingModule`. These wire the real SwapOrchestrator, TimeoutManager, and MessageHandler together with mock infrastructure.

### Happy Path (~4 tests)

```
should complete full lifecycle: announce → deposit A → deposit B → coverage → payout → COMPLETED
should complete lifecycle when party B deposits first
should complete lifecycle with DIRECT:// addresses (no nametag resolution)
should deliver deposit invoice tokens to both parties via DM on announcement
```

### Bounce Scenarios (~4 tests)

```
should accept deposit from third-party charlie when charlie pays party_a_currency into asset[0]
should bounce payment with wrong currency and continue accepting valid deposits
should bounce payment on already-covered swap with reason ALREADY_COVERED
should bounce payment on cancelled swap (autoReturn handles it, handler ignores)
```

### Timeout and Cancellation (~4 tests)

```
should cancel swap and return deposits on timeout after partial deposit
should not start timeout timer until first deposit arrives
should handle admin cancel on DEPOSIT_INVOICE_CREATED (no deposits to return)
should notify both parties with swap_cancelled message on timeout
```

### Concurrent / Race Conditions (~4 tests)

```
should handle coverage-vs-timeout race (coverage wins: timeout is no-op)
should handle coverage-vs-timeout race (timeout wins: coverage is ignored)
should handle both deposits arriving simultaneously (both fire invoice:payment, one fires invoice:covered)
should prevent duplicate swap creation when same manifest announced concurrently
```

### Multiple Swaps (~3 tests)

```
should run 3 independent swaps concurrently without cross-contamination
should handle different swap timeouts independently
should complete one swap while another is still in PARTIAL_DEPOSIT
```

### Crash Recovery (~4 tests)

```
should resume PARTIAL_DEPOSIT swap on startup with correct remaining timeout
should resume CONCLUDING swap on startup and complete payout
should recover orphaned invoices via deterministic ID re-derivation on startup
should reconcile DEPOSIT_COVERED swap with CANCELLED invoice (admin action during crash)
```

### DM Protocol Integration (~2 tests)

```
should deliver deposit invoice to both parties after announcement
should deliver payout invoices and payment_confirmation after conclusion
```

---

## 4. Live Infrastructure E2E Tests — `swap-lifecycle.e2e-live.test.ts`

Tests run against real Unicity dev infrastructure. **Sequential execution, no parallelism.**

### Infrastructure

| Resource | Endpoint |
|---|---|
| Aggregator | `https://dev-aggregator.dyndns.org/rpc` |
| Nostr relays | `wss://relay.unicity.network`, `wss://relay2.unicity.network` |
| Faucet | HTTP API for test token funding |
| Currencies | `UCT` (Unicity Test Coin), `USDU` (USD Test Unit) |

### Global Setup

```typescript
beforeAll(async () => {
  const ctx = await createLiveTestContext();

  // 1. Create 4 wallets with timestamp-based nametags
  //    @escrow-test-<ts>, @alice-test-<ts>, @bob-test-<ts>, @charlie-test-<ts>
  // 2. Register nametags on Nostr relays
  // 3. Fund each wallet via faucet:
  //    - escrow: 0 (funded by deposits)
  //    - partyA (alice): 10000 UCT
  //    - partyB (bob): 10000 USDU
  //    - charlie: 5000 UCT (for third-party deposit tests — charlie deposits on behalf of party A)
  // 4. Start escrow service instance with escrowWallet's AccountingModule
  // 5. Wait for all wallets to confirm funding (poll getBalance until non-zero)
}, 120_000);

afterAll(async () => {
  await ctx.cleanup();
  // Stop escrow service, close all wallet connections
});
```

### Polling Helper

All async verifications use poll-based checks:

```typescript
async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  { intervalMs = 3000, timeoutMs = 60_000, description = '' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (predicate(result)) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out: ${description}`);
}
```

### A. Setup Validation (~4 tests)

```
should create wallets with valid secp256k1 keypairs
should connect to aggregator and receive valid response
should register nametags and resolve them back to DIRECT:// addresses
should fund wallets via faucet and confirm non-zero balances
```

**Flakiness**: Low. Faucet availability is the main risk; retry faucet call up to 3 times with 5s backoff.

### B. Happy Path (~3 tests)

```
should complete a full swap lifecycle: announce → fund → coverage → payout → COMPLETED
  - Party A announces manifest (UCT 1000 for USDU 500)
  - Party B announces same manifest (is_new: false)
  - Both parties import deposit invoice token
  - Party A pays 1000 UCT into deposit invoice
  - Party B pays 500 USDU into deposit invoice
  - Poll: escrow swap state reaches COMPLETED
  - Both parties import payout invoice tokens
  - Party A verifies: payout invoice shows 500 USDU received
  - Party B verifies: payout invoice shows 1000 UCT received

should handle both-party announcement (second announcement returns existing swap)
  - Party A announces first → is_new: true
  - Party B announces same manifest → is_new: false, same deposit_invoice_id

should verify on-chain proof generation for completed swap
  - After swap completion, poll getInvoiceStatus() on payout invoices
  - Verify allConfirmed === true (unicity proofs generated)
  - Verify targets[0].coinAssets[0].isCovered === true
```

**Flakiness**: Medium. Depends on aggregator latency and proof generation time. Use 60s poll timeout for proof verification.

### C. Timeout (~2 tests)

```
should auto-return deposits on timeout with single (partial) deposit
  - Create manifest with timeout: 90 (seconds)
  - Party A deposits 1000 UCT
  - Wait for timeout (poll swap state until CANCELLED, up to 120s)
  - Party A verifies: balance restored (poll until UCT balance >= original - small fee tolerance)

should handle timeout when both parties deposit but one underfunds
  - Create manifest: UCT 1000, USDU 500 with timeout: 90
  - Party A deposits 1000 UCT (full)
  - Party B deposits 200 USDU (insufficient — invoice not covered)
  - Wait for timeout → CANCELLED
  - Both parties verify: deposits returned (poll balances)
```

**Flakiness**: Medium. Timer precision depends on escrow service's setTimeout accuracy. Use generous poll windows. Timeout tests are inherently slow (90s minimum).

### D. Bounce-Back and Third-Party Deposits (~3 tests)

```
should accept deposit from charlie (third-party) into correct currency slot
  - Announce swap between alice (UCT) and bob (USDU)
  - Charlie pays 1000 UCT into deposit invoice (party_a_currency slot)
  - Poll: swap state transitions to PARTIAL_DEPOSIT (charlie's deposit counted toward asset[0])
  - Bob pays 500 USDU — swap reaches DEPOSIT_COVERED and completes
  - Verify: party A receives USDU payout, party B receives UCT payout (charlie's contribution)

should bounce payment with wrong currency
  - Party A (should pay UCT) sends USDU instead
  - Poll: party A's USDU balance restored
  - Swap state remains DEPOSIT_INVOICE_CREATED

should handle post-cancellation payment (auto-return)
  - Create short-timeout swap (timeout: 60)
  - Wait for timeout → CANCELLED
  - Party A sends late payment after cancellation
  - Poll: party A's funds auto-returned (autoReturn on cancelInvoice handles this)
```

**Flakiness**: Medium. Third-party deposit test depends on transfer propagation and state polling. Wrong-currency bounce depends on returnInvoicePayment confirmation. Post-cancellation test requires tight timing; use 60s timeout + delay before late payment.

### E. DM Protocol (~5 tests)

```
should deliver announce_result DM with deposit_invoice_id to announcing party
  - Party A sends announce DM to escrow
  - Party A polls DMs for announce_result message
  - Verify: announce_result.deposit_invoice_id matches expected format

should deliver deposit invoice tokens to both parties via invoice_delivery DM
  - After announcement, both parties poll DMs for invoice_delivery
  - Verify: invoice_delivery.invoice_type === 'deposit'
  - Verify: invoice_delivery.payment_instructions contains correct currency/amount per party

should import delivered invoice token successfully
  - Party A receives invoice_delivery DM
  - Party A calls importInvoice(invoice_delivery.invoice_token)
  - Verify: imported terms match expected deposit invoice terms

should re-deliver lost invoice token via request_invoice
  - Party A sends request_invoice DM for deposit invoice
  - Party A polls DMs for invoice_delivery response
  - Verify: re-delivered token matches original

should reject request_invoice from unauthorized sender (charlie)
  - Charlie sends request_invoice DM for alice/bob's swap
  - Charlie polls DMs for error response
  - Verify: error message contains "Unauthorized"
```

**Flakiness**: Medium-High. Nostr relay DM delivery is eventually consistent. Use 30s poll timeout for DM arrival. Consider retry on DM send if relay is temporarily unavailable.

### F. Concurrent / Race (~2 tests)

```
should handle simultaneous deposits from both parties
  - Announce swap, deliver invoices
  - Party A and Party B call payInvoice() concurrently (Promise.all)
  - Poll: swap state reaches COMPLETED
  - Verify: both payout invoices are COVERED

should handle coverage-vs-timeout race under tight timing
  - Create swap with timeout: 60
  - Party A deposits immediately
  - Wait until ~55s elapsed, then party B deposits
  - Verify: swap ends in either COMPLETED or CANCELLED (both are valid outcomes)
  - If COMPLETED: verify payout invoices are covered
  - If CANCELLED: verify deposits are returned
```

**Flakiness**: High. Race condition tests are inherently non-deterministic. The coverage-vs-timeout race test accepts either outcome. Log timing data for post-mortem analysis.

### G. Crash Recovery (~3 tests)

```
should resume PARTIAL_DEPOSIT swap after escrow service restart
  - Announce swap, party A deposits (swap in PARTIAL_DEPOSIT)
  - Stop escrow service
  - Restart escrow service (triggers crash recovery)
  - Party B deposits
  - Poll: swap reaches COMPLETED

should resume CONCLUDING swap after escrow service restart
  - Announce swap, both parties deposit (swap reaches DEPOSIT_COVERED)
  - Kill escrow service mid-conclusion (after CONCLUDING persisted but before payouts)
  - Restart escrow service
  - Poll: swap reaches COMPLETED
  - Verify: no double-payments (check payout invoice coverage amounts)

should handle expired timeout during crash window
  - Create swap with timeout: 60
  - Party A deposits, timeout starts
  - Stop escrow service
  - Wait > 60s
  - Restart escrow service
  - Verify: swap transitions to CANCELLED, deposits returned
```

**Flakiness**: Medium-High. Crash simulation requires clean process lifecycle management. Mid-conclusion kill is timing-sensitive; may need to instrument a delay between CONCLUDING state persistence and payInvoice() calls. Expired-timeout test is slow (~90s minimum).

---

## 5. Cross-Reference Verification

### 5.1 State Machine Transition Coverage

Every transition from the state machine diagram in `docs/architecture.md` is covered by at least one test:

| Transition | Unit Test | Integration Test | Live E2E |
|---|---|---|---|
| ANNOUNCED → DEPOSIT_INVOICE_CREATED | state-machine.test.ts | swap-lifecycle §Happy Path | B.1 |
| DEPOSIT_INVOICE_CREATED → PARTIAL_DEPOSIT | state-machine.test.ts, swap-orchestrator §invoice:payment | swap-lifecycle §Happy Path | B.1 |
| DEPOSIT_INVOICE_CREATED → DEPOSIT_COVERED | state-machine.test.ts, swap-orchestrator §invoice:covered | swap-lifecycle §Concurrent | F.1 |
| DEPOSIT_INVOICE_CREATED → TIMED_OUT | state-machine.test.ts | swap-lifecycle §Timeout (admin) | — |
| PARTIAL_DEPOSIT → DEPOSIT_COVERED | state-machine.test.ts, swap-orchestrator §invoice:covered | swap-lifecycle §Happy Path | B.1 |
| PARTIAL_DEPOSIT → TIMED_OUT | state-machine.test.ts | swap-lifecycle §Timeout | C.1 |
| DEPOSIT_COVERED → CONCLUDING | state-machine.test.ts, swap-orchestrator §invoice:covered | swap-lifecycle §Happy Path | B.1 |
| CONCLUDING → COMPLETED | state-machine.test.ts, swap-orchestrator §invoice:covered | swap-lifecycle §Happy Path | B.1 |
| TIMED_OUT → CANCELLING | state-machine.test.ts | swap-lifecycle §Timeout | C.1 |
| TIMED_OUT → DEPOSIT_COVERED | state-machine.test.ts, swap-orchestrator §State Guards, crash-recovery §TIMED_OUT Recovery | — | — |
| CANCELLING → CANCELLED | state-machine.test.ts | swap-lifecycle §Timeout | C.1 |
| CANCELLING → DEPOSIT_COVERED | state-machine.test.ts, crash-recovery §CANCELLING Recovery | — | — |
| Any → FAILED | state-machine.test.ts | swap-lifecycle §Crash Recovery | — |

### 5.2 Crash Recovery Table Coverage

Every (swap state, invoice state) pair from the crash recovery table in `docs/architecture.md`:

| Swap State | Invoice State | Test |
|---|---|---|
| ANNOUNCED | (no invoice) | crash-recovery.test.ts §ANNOUNCED |
| DEPOSIT_INVOICE_CREATED | OPEN | crash-recovery.test.ts §DIC Recovery #1 |
| DEPOSIT_INVOICE_CREATED | EXPIRED | crash-recovery.test.ts §DIC Recovery #2 |
| DEPOSIT_INVOICE_CREATED / PARTIAL_DEPOSIT | PARTIAL | crash-recovery.test.ts §DIC Recovery #3, §PD Recovery #1 |
| PARTIAL_DEPOSIT | EXPIRED | crash-recovery.test.ts §PD Recovery #2 |
| DEPOSIT_INVOICE_CREATED / PARTIAL_DEPOSIT | COVERED | crash-recovery.test.ts §DIC Recovery #4, §PD Recovery #3 |
| PARTIAL_DEPOSIT | CLOSED | crash-recovery.test.ts §PD Recovery #5 |
| PARTIAL_DEPOSIT | CANCELLED | crash-recovery.test.ts §PD Recovery #4 |
| DEPOSIT_INVOICE_CREATED | CANCELLED | crash-recovery.test.ts §DIC Recovery #5 |
| DEPOSIT_INVOICE_CREATED | CLOSED | crash-recovery.test.ts §DIC Recovery #6 |
| DEPOSIT_COVERED | OPEN / PARTIAL / EXPIRED (regressed, revert) | crash-recovery.test.ts §DC Recovery #1a |
| DEPOSIT_COVERED | OPEN / PARTIAL / EXPIRED (valid coverage restorable, proceed) | crash-recovery.test.ts §DC Recovery #1b |
| DEPOSIT_COVERED | CANCELLED (all returned) | crash-recovery.test.ts §DC Recovery #2a |
| DEPOSIT_COVERED | CANCELLED (returns incomplete) | crash-recovery.test.ts §DC Recovery #2b → FAILED |
| DEPOSIT_COVERED | CLOSED | crash-recovery.test.ts §DC Recovery #3 |
| CONCLUDING | CLOSED | crash-recovery.test.ts §CONCLUDING Recovery #1–#5 |
| CONCLUDING | OPEN | crash-recovery.test.ts §CONCLUDING Recovery #6 — close deposit first |
| CONCLUDING | COVERED | crash-recovery.test.ts §CONCLUDING Recovery #7 — close deposit first |
| TIMED_OUT | OPEN | crash-recovery.test.ts §TIMED_OUT Recovery #1 |
| TIMED_OUT | PARTIAL | crash-recovery.test.ts §TIMED_OUT Recovery #2 |
| TIMED_OUT | EXPIRED | crash-recovery.test.ts §TIMED_OUT Recovery #3 |
| TIMED_OUT | CANCELLED | crash-recovery.test.ts §TIMED_OUT Recovery #4 — autoReturn completed |
| TIMED_OUT | CLOSED (INVOICE_ALREADY_CLOSED) | crash-recovery.test.ts §TIMED_OUT Recovery #5 — coverage won race |
| TIMED_OUT | COVERED | crash-recovery.test.ts §TIMED_OUT Recovery #6 — close first, then reconcile |
| CANCELLING | CANCELLED | crash-recovery.test.ts §CANCELLING Recovery #1 |
| CANCELLING | OPEN | crash-recovery.test.ts §CANCELLING Recovery #2 — cancel didn't complete |
| CANCELLING | PARTIAL | crash-recovery.test.ts §CANCELLING Recovery #3 |
| CANCELLING | EXPIRED | crash-recovery.test.ts §CANCELLING Recovery #4 |
| CANCELLING | COVERED | crash-recovery.test.ts §CANCELLING Recovery #5 — coverage won, resume conclusion |
| ANNOUNCED (deposit_invoice_id=null) | (invoice exists) | crash-recovery.test.ts §Deterministic ID Recovery #1 — adopt via re-derived ID (gap #8) |
| CONCLUDING (payout_id=null) | (payout exists) | crash-recovery.test.ts §Deterministic ID Recovery #2 — adopt via re-derived ID (gap #8) |
| ANNOUNCED (deposit_invoice_id=null) | (no invoice) | crash-recovery.test.ts §Deterministic ID Recovery #3 — re-create with same ID (gap #8) |
| ANNOUNCED (deposit_invoice_id=null, no gap #8) | (orphan via memo scan) | crash-recovery.test.ts §Interim Orphan Recovery — adopt via memo match |
| ANNOUNCED (concurrent createInvoice) | INVOICE_ALREADY_EXISTS | crash-recovery.test.ts §Concurrent Announce Race — same-process guard |

### 5.3 DM Message Type Coverage

Every message type from `docs/protocol-spec.md` §1.1 and §1.2:

| Direction | Message Type | Test |
|---|---|---|
| Party → Escrow | `announce` | message-handler.test.ts §announce, E.1 |
| Party → Escrow | `status` | message-handler.test.ts §status, E.1 (implicit) |
| Party → Escrow | `request_invoice` | message-handler.test.ts §request_invoice, E.4 |
| Escrow → Party | `announce_result` | message-handler.test.ts §announce, E.1 |
| Escrow → Party | `invoice_delivery` | message-handler.test.ts §request_invoice, swap-lifecycle §DM Integration, E.2, E.3 |
| Escrow → Party | `status_result` | message-handler.test.ts §status |
| Escrow → Party | `payment_confirmation` | swap-lifecycle §DM Integration |
| Escrow → Party | `swap_cancelled` | swap-lifecycle §Timeout |
| Escrow → Party | `bounce_notification` | swap-orchestrator §invoice:payment (wrong-currency bounce), swap-orchestrator §invoice:covered (bounce DM delivery) |
| Party → Escrow | `deposit_instructions` | message-handler.test.ts §Legacy Message (alias for request_invoice) |
| Escrow → Party | `error` | message-handler.test.ts §announce (validation failure), E.5 |

### 5.4 Live E2E Lifecycle Coverage

The live E2E tests cover the complete trader-creation → topup → escrow → exchange flow:

1. **Trader creation**: Global setup creates wallets with keypairs (A.1)
2. **Nametag registration**: Global setup registers nametags (A.3)
3. **Topup**: Global setup funds wallets via faucet (A.4)
4. **Escrow announcement**: B.1 (both parties announce)
5. **Invoice delivery**: E.2 (deposit invoice tokens delivered)
6. **Deposit**: B.1 (both parties pay into deposit invoice)
7. **Coverage verification**: B.1 (escrow detects coverage)
8. **Payout**: B.1 (escrow pays payout invoices)
9. **Verification**: B.3 (parties verify on-chain proofs)

### 5.5 Test Helper Alignment with SDK Types

| Helper | SDK Type | Alignment |
|---|---|---|
| `MockAccountingModule.createInvoice()` | `AccountingModule.createInvoice(CreateInvoiceRequest)` | Returns `CreateInvoiceResult` with `success`, `invoiceId?`, `token?`, `terms?`, `error?` |
| `MockAccountingModule.getInvoiceStatus()` | `AccountingModule.getInvoiceStatus(string)` | Returns `InvoiceStatus` with `state`, `targets[].coinAssets[]` including `transfers: InvoiceTransferRef[]` and `senderBalances: InvoiceSenderBalance[]` |
| `MockAccountingModule.payInvoice()` | `AccountingModule.payInvoice(string, PayInvoiceParams)` | Returns `TransferResult` (not void) |
| `MockAccountingModule.returnInvoicePayment()` | `AccountingModule.returnInvoicePayment(string, ReturnPaymentParams)` | Returns `TransferResult` (not void) |
| `createMockTransferRef()` | `InvoiceTransferRef` | Includes `transferId`, `senderAddress: string | null`, `refundAddress?`, `amount`, `coinId`, `direction`, `paymentDirection`, `destinationAddress`, `timestamp`, `confirmed` |
| `InMemorySwapStateStore` schema | `SwapStateStore` interface | Fields match `docs/architecture.md` §SwapStateStore: `swap_id`, `manifest`, `state`, `deposit_invoice_id`, `payout_a_invoice_id`, `payout_b_invoice_id`, `resolved_party_a_address`, `resolved_party_b_address`, `first_deposit_at`, `timeout_at`, `version` |
| `createMockInvoiceStatus()` | `InvoiceStatus` | `targets[0].coinAssets[i].transfers` uses `InvoiceTransferRef[]`; `senderBalances` is `InvoiceSenderBalance[]` (array, not Map) — tests verify that deposit classification uses `transfers[].coinId` against asset slot index, not `senderAddress` or `senderBalances` |

---

## 6. Test Count Summary

| Category | File | Count |
|---|---|---|
| **Unit** | state-machine.test.ts | ~41 |
| | swap-orchestrator.test.ts | ~55 |
| | invoice-manager.test.ts | ~14 |
| | timeout-manager.test.ts | ~14 |
| | message-handler.test.ts | ~24 |
| | swap-state-store.test.ts | ~12 |
| | manifest-validator.test.ts | ~4 |
| | deposit-validation.test.ts | ~14 |
| | crash-recovery.test.ts | ~41 |
| **Unit subtotal** | | **~219** |
| **Integration** | swap-lifecycle.integration.test.ts | ~25 |
| **Live E2E** | swap-lifecycle.e2e-live.test.ts | ~22 |
| **Total** | | **~266** |
