/**
 * Live End-to-End Test: Swap Lifecycle
 *
 * Exercises the complete escrow swap lifecycle against the real Unicity testnet.
 * Three real Sphere wallets are created (Party A, Party B, Escrow), funded via
 * the public faucet, and wired together through the actual escrow service
 * components (SwapOrchestrator, InvoiceManager, TimeoutManager,
 * InMemorySwapStateStore) using the escrow wallet's real AccountingModule.
 *
 * Prerequisites:
 *   - Network access to testnet infrastructure
 *   - Access to the public faucet at FAUCET_URL
 *   - Run via: npm run test:e2e-live
 *
 * Configuration:
 *   - vitest.e2e-live.config.ts: testTimeout=300s, singleFork, sequential
 *
 * Test suite order matters — tests run sequentially because each wallet is
 * heavy to initialise. Wallets are shared within the suite via module-level
 * state and torn down in afterAll.
 *
 * Notes on timing:
 *   - Testnet round-trips take 2–15 seconds per operation.
 *   - Token delivery over Nostr transport is asynchronous; polling is used.
 *   - The timeout test uses a 30s manifest timeout plus a 15s safety buffer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

// Sphere SDK
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// Escrow service
import { SwapOrchestrator } from '../../core/swap-orchestrator.js';
import { InvoiceManager } from '../../core/invoice-manager.js';
import { TimeoutManager } from '../../core/timeout-manager.js';
import { InMemorySwapStateStore } from '../../core/swap-state-store.js';
import { SwapState, isTerminalState } from '../../core/state-machine.js';
import { computeSwapId } from '../../utils/hash.js';
import type { SwapManifest } from '../../core/manifest-validator.js';
import type { SwapRecord } from '../../core/types.js';

// =============================================================================
// Constants
// =============================================================================

const NETWORK = 'testnet';

/**
 * Publicly-available trust base manifest for testnet.
 * Pinned to a known-stable branch ref.
 */
const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';

/** Default API key for the testnet aggregator. */
const DEFAULT_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

/** Faucet endpoint — accepts POST with { unicityId, coin, amount }. */
const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';

/**
 * Coin symbols used in manifests and invoice targets (max 20 chars, alphanumeric).
 * These are the short identifiers used by AccountingModule.
 */
const COIN_UCT = 'UCT';
const COIN_USDU = 'USDU';

/**
 * Actual token coinId hashes — resolved at runtime from wallet balances.
 * These are the hex-encoded hashes used by PaymentsModule.send().
 * Set in beforeAll after faucet tokens are received.
 */
let TOKEN_ID_UCT = '';
let TOKEN_ID_USDU = '';

/**
 * Small deposit amounts well within typical faucet grants.
 * UCT:  0.1 UCT  = 1e17 smallest units (18 decimals).
 * USDU: 0.1 USDU = 1e5  smallest units  (6 decimals).
 */
const AMOUNT_UCT = '100000000000000000'; // 0.1 UCT
const AMOUNT_USDU = '100000'; // 0.1 USDU

/**
 * Polling intervals and maximum wait durations (milliseconds).
 */
const POLL_INTERVAL_MS = 3_000;
const FAUCET_WAIT_MS = 120_000;
const SWAP_COMPLETE_WAIT_MS = 90_000;
const PAYOUT_RECEIVE_WAIT_MS = 90_000;
// (BOUNCE_WAIT_MS removed — third-party deposits are accepted, not bounced)

// =============================================================================
// Helpers
// =============================================================================

/**
 * Sleeps for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a temporary directory hierarchy for a single wallet instance.
 * Each wallet gets an isolated directory to prevent storage collisions.
 */
function makeTempDir(label: string): { dataDir: string; tokensDir: string } {
  const rand = Math.random().toString(36).slice(2, 8);
  const dataDir = join(tmpdir(), `sphere-e2e-${label}-${Date.now()}-${rand}`);
  const tokensDir = join(dataDir, 'tokens');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  return { dataDir, tokensDir };
}

/**
 * Requests tokens from the public faucet.
 *
 * @param unicityId - The nametag (without @) or DIRECT:// address of the recipient wallet.
 * @param coin      - Coin name as accepted by the faucet ('unicity' or 'unicity-usd').
 * @param amount    - Number of whole tokens to request.
 */
async function requestFaucet(
  unicityId: string,
  coin: string,
  amount: number,
): Promise<unknown> {
  const response = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unicityId, coin, amount }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(
      `Faucet request failed: HTTP ${response.status} — ${text}`,
    );
  }

  return response.json();
}

/**
 * Generates a unique nametag safe for testnet registration.
 *
 * Nametag format: 3–20 lowercase alphanumeric/underscore/hyphen chars.
 * We keep it short (prefix + 6 random hex chars) to stay well under the cap.
 *
 * @param prefix - Short label for readability (e.g. 'ea', 'eb', 'es').
 */
function generateNametag(prefix: string): string {
  const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 6);
  // Ensure total length <= 20 and starts with a letter
  return `${prefix.slice(0, 4)}${rand}`.toLowerCase();
}

/**
 * Initialises a Sphere wallet on the testnet and registers a unique nametag.
 *
 * The nametag is registered at wallet creation time so it is available for
 * faucet requests immediately after this function returns.
 *
 * Downloads the trustbase, sets up providers, and returns the wallet with
 * accounting enabled only when requested (escrow wallet).
 *
 * @param label       - Human-readable label used in temp directory names and
 *                      as a prefix for the generated nametag.
 * @param accounting  - Pass true to enable AccountingModule (escrow wallet only).
 */
async function initWallet(
  label: string,
  accounting: boolean = false,
): Promise<{ sphere: Sphere; dataDir: string; nametag: string }> {
  const { dataDir, tokensDir } = makeTempDir(label);

  // Download trustbase into the wallet's data directory
  const tbResponse = await fetch(TRUSTBASE_URL);
  if (!tbResponse.ok) {
    throw new Error(
      `Failed to download trustbase: HTTP ${tbResponse.status}`,
    );
  }
  writeFileSync(join(dataDir, 'trustbase.json'), await tbResponse.text());

  const providers = createNodeProviders({
    network: NETWORK,
    dataDir,
    tokensDir,
    oracle: {
      trustBasePath: join(dataDir, 'trustbase.json'),
      apiKey: DEFAULT_API_KEY,
    },
  });

  // Generate a unique nametag for this wallet.
  // Sphere.init() with `nametag` automatically registers it on-chain.
  // The faucet requires a registered nametag — passing it at init time
  // ensures the nametag is available by the time we call requestFaucet().
  const nametag = generateNametag(label.replace(/[^a-z]/g, '').slice(0, 4) || 'e2e');

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag,
    accounting,
  });

  return { sphere, dataDir, nametag };
}

/**
 * Polls `sphere.payments.receive()` until the wallet has a positive balance
 * for the specified coin, or until the timeout expires.
 *
 * @param sphere    - The wallet to poll.
 * @param coinLabel - Coin symbol to check (used only for error messages).
 * @param coinId    - Coin ID passed to `getBalance()` for filtering.
 * @param timeoutMs - Maximum wait in milliseconds (default: FAUCET_WAIT_MS).
 * @throws If no balance appears within the timeout.
 */
async function waitForBalance(
  sphere: Sphere,
  coinLabel: string,
  coinId: string,
  timeoutMs: number = FAUCET_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Use load() to reload token state from storage + transport.
    // The sphere-sdk E2E tests use this pattern — receive() alone may not
    // pick up faucet tokens if the Nostr transport hasn't fully connected.
    try {
      await sphere.payments.load();
    } catch {
      // load() may fail transiently
    }

    // Also try receive() and sync() as alternative delivery channels
    try {
      await sphere.payments.receive();
    } catch {
      // receive() may throw if transport doesn't support fetchPendingEvents
    }

    const balances = sphere.payments.getBalance();
    const total = balances.find((b) => b.coinId === coinId || b.symbol === coinLabel);
    if (total && BigInt(total.totalAmount) > 0n) {
      console.log(`[waitForBalance] ${coinLabel} received: ${total.totalAmount} (${total.tokenCount} tokens) coinId=${total.coinId} symbol=${total.symbol}`);
      return;
    }
    // Log every 15s to track progress
    const elapsed = Date.now() - (deadline - timeoutMs);
    if (elapsed % 15000 < POLL_INTERVAL_MS) {
      const allSymbols = balances.map((b) => `${b.symbol}:${b.totalAmount}`).join(', ');
      console.log(`[waitForBalance] Waiting for ${coinLabel}... ${Math.round(elapsed / 1000)}s elapsed. Balances: [${allSymbols || 'none'}]`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const finalBalances = sphere.payments.getBalance();
  const allSymbols = finalBalances.map((b) => `${b.symbol}:${b.totalAmount}`).join(', ');
  throw new Error(
    `Wallet did not receive ${coinLabel} balance within ${timeoutMs}ms. Final balances: [${allSymbols || 'none'}]`,
  );
}

/**
 * Polls `stateStore.findBySwapId()` until the swap reaches `targetState`,
 * or until the timeout expires.
 *
 * @param stateStore  - The state store to query.
 * @param swapId      - Swap identifier.
 * @param targetState - The expected terminal or intermediate state.
 * @param timeoutMs   - Maximum wait in milliseconds.
 * @throws If the swap does not reach `targetState` within the timeout, or
 *         if it lands in an unexpected terminal state.
 */
async function waitForSwapState(
  stateStore: InMemorySwapStateStore,
  swapId: string,
  targetState: SwapState,
  timeoutMs: number,
): Promise<SwapRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = stateStore.findBySwapId(swapId);
    if (record) {
      if (record.state === targetState) {
        return record;
      }
      // Fail fast if we have landed in an unrecoverable wrong terminal state
      if (isTerminalState(record.state) && record.state !== targetState) {
        throw new Error(
          `Swap ${swapId} reached terminal state ${record.state} instead of ${targetState}. ` +
          (record.error_message ? `Error: ${record.error_message}` : ''),
        );
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const finalRecord = stateStore.findBySwapId(swapId);
  throw new Error(
    `Swap ${swapId} did not reach ${targetState} within ${timeoutMs}ms. ` +
    `Current state: ${finalRecord?.state ?? 'NOT_FOUND'}. ` +
    (finalRecord?.error_message ? `Error: ${finalRecord.error_message}` : ''),
  );
}

/**
 * Polls `escrowSphere.payments.receive()` periodically so that the escrow's
 * AccountingModule can detect incoming transfers and fire invoice events.
 *
 * Returns a cleanup function that clears the interval.
 */
function startEscrowReceiveLoop(
  escrowSphere: Sphere,
  intervalMs: number = POLL_INTERVAL_MS,
): () => void {
  let receiveCount = 0;
  const handle = setInterval(async () => {
    try {
      await escrowSphere.payments.load();
    } catch (e) {
      // load() may fail transiently
    }
    try {
      await escrowSphere.payments.receive();
    } catch (e) {
      // receive() may fail transiently
    }
    receiveCount++;
  }, intervalMs);
  return () => clearInterval(handle);
}

/**
 * Builds a swap manifest and computes its content-addressed swap_id.
 */
function buildManifest(
  partyAAddress: string,
  partyBAddress: string,
  partyACurrency: string,
  partyAValue: string,
  partyBCurrency: string,
  partyBValue: string,
  timeout: number,
): SwapManifest {
  const fields = {
    party_a_address: partyAAddress,
    party_b_address: partyBAddress,
    party_a_currency_to_change: partyACurrency,
    party_a_value_to_change: partyAValue,
    party_b_currency_to_change: partyBCurrency,
    party_b_value_to_change: partyBValue,
    timeout,
  };
  return { swap_id: computeSwapId(fields), ...fields };
}

/**
 * Builds an orchestrator stack backed by a given AccountingModule.
 * The stateStore, timeoutManager, invoiceManager, and orchestrator are
 * all returned for direct manipulation by tests.
 */
function buildOrchestratorStack(
  escrowSphere: Sphere,
): {
  stateStore: InMemorySwapStateStore;
  timeoutManager: TimeoutManager;
  invoiceManager: InvoiceManager;
  orchestrator: SwapOrchestrator;
} {
  const accounting = escrowSphere.accounting;
  if (!accounting) {
    throw new Error(
      'AccountingModule is null — did you pass accounting: true to Sphere.init()?',
    );
  }

  const escrowAddress = escrowSphere.identity!.directAddress!;

  const stateStore = new InMemorySwapStateStore();

  const invoiceManager = new InvoiceManager({
    // The real AccountingModule satisfies the IAccountingModule duck-type
    // contract used by InvoiceManager — cast via `any` to bridge the gap
    // between the SDK's unexported type and our local interface mirror.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accounting: accounting as any,
    escrowAddress,
    // Events are emitted on the Sphere instance, not on AccountingModule directly
    eventSource: escrowSphere as any,
  });

  // Orchestrator reference is needed inside the timeout callback, which is
  // constructed before the orchestrator — use a holder object to break the
  // circular dependency.
  let orchestratorRef!: SwapOrchestrator;

  const timeoutManager = new TimeoutManager({
    onTimeout: async (swapId: string) => {
      await orchestratorRef._handleTimeout(swapId);
    },
  });

  const orchestrator = new SwapOrchestrator({
    invoiceManager,
    stateStore,
    timeoutManager,
    messageSender: {
      // DMs are not tested here — live E2E focuses on token flows
      sendToParty: async () => {},
      sendToAddress: async () => {},
    },
    addressResolver: {
      // Only DIRECT:// addresses are used in these tests
      resolve: async (address: string) =>
        address.startsWith('DIRECT://') ? address : null,
    },
  });

  orchestratorRef = orchestrator;
  orchestrator.start();

  return { stateStore, timeoutManager, invoiceManager, orchestrator };
}

// =============================================================================
// Module-level state (shared across tests; initialised in beforeAll)
// =============================================================================

/**
 * Wallet handles shared across all tests in this suite.
 * Initialised once in beforeAll, destroyed in afterAll.
 */
let sphereA: Sphere;
let sphereB: Sphere;
let sphereEscrow: Sphere;

// =============================================================================
// Suite setup and teardown
// =============================================================================

beforeAll(async () => {
  /*
   * Initialise all three wallets in parallel to minimise total setup time.
   * The escrow wallet needs accounting: true so its AccountingModule is
   * available for InvoiceManager.
   *
   * Each wallet registers a unique nametag during init, which is required
   * by the public faucet (it does not accept DIRECT:// addresses).
   */
  const [resultA, resultB, resultEscrow] = await Promise.all([
    initWallet('partya'),
    initWallet('partyb'),
    initWallet('escrow', /* accounting= */ true),
  ]);

  sphereA = resultA.sphere;
  sphereB = resultB.sphere;
  sphereEscrow = resultEscrow.sphere;

  /*
   * Fund all three wallets via the faucet.
   * Party A needs UCT to deposit; Party B needs USDU.
   * The escrow wallet needs a small UCT balance to cover payout transaction
   * fees (the AccountingModule sends tokens on behalf of the escrow).
   *
   * Faucet coin names: 'unicity' maps to UCT, 'unicity-usd' maps to USDU.
   */
  const partyANametag = resultA.nametag;
  const partyBNametag = resultB.nametag;
  const escrowNametag = resultEscrow.nametag;

  // Request faucet grants — fire all in parallel to save time
  console.log(`[setup] Requesting faucet: A=${partyANametag} (UCT), B=${partyBNametag} (USDU), Escrow=${escrowNametag} (UCT)`);
  const [faucetA, faucetB, faucetE] = await Promise.all([
    requestFaucet(partyANametag, 'unicity', 2),         // 2 UCT for Party A deposits
    requestFaucet(partyBNametag, 'unicity-usd', 2),     // 2 USDU for Party B deposits
    requestFaucet(escrowNametag, 'unicity', 1),          // 1 UCT for escrow fee coverage
  ]);
  console.log(`[setup] Faucet responses: A=${JSON.stringify(faucetA)?.slice(0, 100)}, B=${JSON.stringify(faucetB)?.slice(0, 100)}, E=${JSON.stringify(faucetE)?.slice(0, 100)}`);

  // Wait until each wallet has actually received its tokens before proceeding
  console.log('[setup] Waiting for token balances...');
  await Promise.all([
    waitForBalance(sphereA, COIN_UCT, COIN_UCT),
    waitForBalance(sphereB, COIN_USDU, COIN_USDU),
    waitForBalance(sphereEscrow, COIN_UCT, COIN_UCT),
  ]);

  // Resolve actual hex token IDs from wallet balances (used for payments.send())
  const balA = sphereA.payments.getBalance();
  const uctEntry = balA.find((b) => b.symbol === COIN_UCT);
  TOKEN_ID_UCT = uctEntry!.coinId;

  const balB = sphereB.payments.getBalance();
  const usduEntry = balB.find((b) => b.symbol === COIN_USDU);
  TOKEN_ID_USDU = usduEntry!.coinId;

  console.log(`[setup] Resolved token IDs: UCT=${TOKEN_ID_UCT}, USDU=${TOKEN_ID_USDU}`);
  console.log('[setup] All wallets funded.');
}, /* timeout from vitest.e2e-live.config.ts = 300s */ 300_000);

afterAll(async () => {
  // Graceful teardown — destroy each sphere to close Nostr connections and
  // flush storage. Wrapped in try/catch so one failure does not block others.
  await Promise.allSettled([
    sphereA?.destroy().catch(() => {}),
    sphereB?.destroy().catch(() => {}),
    sphereEscrow?.destroy().catch(() => {}),
  ]);
});

// =============================================================================
// Tests
// =============================================================================

describe('Live E2E: Swap Lifecycle (Unicity testnet)', () => {
  // ---------------------------------------------------------------------------
  // Test 1 — Happy path: full swap completes end-to-end
  // ---------------------------------------------------------------------------

  it(
    'should complete happy-path swap: announce → deposits → coverage → payouts → COMPLETED',
    async () => {
      // ----- Build orchestrator stack -----
      const { stateStore, orchestrator, timeoutManager } =
        buildOrchestratorStack(sphereEscrow);
      const stopReceiveLoop = startEscrowReceiveLoop(sphereEscrow);

      try {
        const escrowAddress = sphereEscrow.identity!.directAddress!;
        const partyAAddress = sphereA.identity!.directAddress!;
        const partyBAddress = sphereB.identity!.directAddress!;

        // ----- Build and announce manifest -----
        // Use hex token IDs as currency so the invoice targets match token genesis coinData
        const manifest = buildManifest(
          partyAAddress,
          partyBAddress,
          TOKEN_ID_UCT,
          AMOUNT_UCT,
          TOKEN_ID_USDU,
          AMOUNT_USDU,
          /* timeout= */ 300, // 5 minutes — generous for testnet latency
        );

        const announceResult = await orchestrator.announce(manifest);
        expect(announceResult.is_new).toBe(true);
        expect(announceResult.deposit_invoice_id).toBeTruthy();

        // Swap should be in DEPOSIT_INVOICE_CREATED immediately after announcement
        const afterAnnounce = stateStore.findBySwapId(manifest.swap_id);
        expect(afterAnnounce?.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);

        // ----- Party A deposits UCT -----
        // The AccountingModule on the escrow side detects transfers to the
        // escrow address and matches them to open invoices by coin type.
        // The memo must include the invoice reference so the AccountingModule
        // can attribute the payment: INV:<invoiceId>:F
        const depositInvoiceId = announceResult.deposit_invoice_id!;
        const invoiceMemo = `INV:${depositInvoiceId}:F`;

        const sendResultA = await sphereA.payments.send({
          coinId: TOKEN_ID_UCT,
          amount: AMOUNT_UCT,
          recipient: escrowAddress,
          memo: invoiceMemo,
          invoiceContact: { address: partyAAddress },
          invoiceRefundAddress: partyAAddress,
          transferMode: 'instant',
        });
        expect(sendResultA.status).not.toBe('failed');

        // ----- Party B deposits USDU -----
        const sendResultB = await sphereB.payments.send({
          coinId: TOKEN_ID_USDU,
          amount: AMOUNT_USDU,
          recipient: escrowAddress,
          memo: invoiceMemo,
          invoiceContact: { address: partyBAddress },
          invoiceRefundAddress: partyBAddress,
          transferMode: 'instant',
        });
        expect(sendResultB.status).not.toBe('failed');

        // ----- Wait for orchestrator to complete the swap -----
        // The escrow receive loop drives the AccountingModule which fires
        // invoice:payment then invoice:covered once both legs are deposited.
        // The orchestrator then creates payout invoices, pays them, and
        // transitions the swap to COMPLETED.
        const completedRecord = await waitForSwapState(
          stateStore,
          manifest.swap_id,
          SwapState.COMPLETED,
          SWAP_COMPLETE_WAIT_MS,
        );

        expect(completedRecord.completed_at).not.toBeNull();
        expect(completedRecord.payout_a_invoice_id).toBeTruthy();
        expect(completedRecord.payout_b_invoice_id).toBeTruthy();

        // ----- Verify Party A received USDU (Party B's currency) -----
        const balanceAAfter = sphereA.payments.getBalance(TOKEN_ID_USDU);
        const uctAsset = balanceAAfter.find(
          (b) => b.coinId === TOKEN_ID_USDU,
        );
        expect(
          uctAsset && BigInt(uctAsset.totalAmount) > 0n,
          `Party A should have received USDU, but balance is: ${JSON.stringify(balanceAAfter)}`,
        ).toBe(true);

        // ----- Verify Party B received UCT (Party A's currency) -----
        await sphereB.payments.receive();
        const balanceBAfter = sphereB.payments.getBalance(TOKEN_ID_UCT);
        const usduAsset = balanceBAfter.find(
          (b) => b.coinId === TOKEN_ID_UCT,
        );
        expect(
          usduAsset && BigInt(usduAsset.totalAmount) > 0n,
          `Party B should have received UCT, but balance is: ${JSON.stringify(balanceBAfter)}`,
        ).toBe(true);
      } finally {
        stopReceiveLoop();
        await orchestrator.stop().catch(() => {});
        timeoutManager.destroy();
      }
    },
    120_000, // 2 minutes per test (overall suite cap is 300s)
  );

  // ---------------------------------------------------------------------------
  // Test 2 — Timeout path: partial deposit is refunded after manifest timeout
  // ---------------------------------------------------------------------------

  it(
    'should handle timeout and refund partial deposits',
    async () => {
      const { stateStore, orchestrator, timeoutManager } =
        buildOrchestratorStack(sphereEscrow);
      const stopReceiveLoop = startEscrowReceiveLoop(sphereEscrow);

      try {
        const escrowAddress = sphereEscrow.identity!.directAddress!;
        const partyAAddress = sphereA.identity!.directAddress!;
        const partyBAddress = sphereB.identity!.directAddress!;

        /*
         * Short timeout so the test does not take too long.
         * Note: validateManifest enforces timeoutMin=60 seconds by default.
         * We use exactly 60s here (the minimum) so the total wait for this
         * test is 60s + 15s buffer = 75s, well within the 90s per-test budget.
         */
        const TIMEOUT_SECONDS = 60;

        const manifest = buildManifest(
          partyAAddress,
          partyBAddress,
          TOKEN_ID_UCT,
          AMOUNT_UCT,
          TOKEN_ID_USDU,
          AMOUNT_USDU,
          TIMEOUT_SECONDS,
        );

        const announceResult = await orchestrator.announce(manifest);
        const depositInvoiceId = announceResult.deposit_invoice_id!;
        const invoiceMemo = `INV:${depositInvoiceId}:F`;

        // Record Party A's UCT balance before depositing so we can verify refund
        const balanceABefore = sphereA.payments.getBalance(TOKEN_ID_UCT);
        const uctBefore =
          balanceABefore.find((b) => b.coinId === TOKEN_ID_UCT)
            ?.totalAmount ?? '0';

        // Only Party A deposits — Party B deliberately withholds their deposit
        const sendResultA = await sphereA.payments.send({
          coinId: TOKEN_ID_UCT,
          amount: AMOUNT_UCT,
          recipient: escrowAddress,
          memo: invoiceMemo,
          invoiceContact: { address: sphereA.identity!.directAddress! },
          invoiceRefundAddress: sphereA.identity!.directAddress!,
          transferMode: 'instant',
        });
        expect(sendResultA.status).not.toBe('failed');

        // Wait for PARTIAL_DEPOSIT state (first deposit acknowledged)
        await waitForSwapState(
          stateStore,
          manifest.swap_id,
          SwapState.PARTIAL_DEPOSIT,
          30_000,
        );

        // Wait for the timeout timer to fire and the swap to reach CANCELLED.
        // Extra buffer = TIMEOUT_SECONDS * 1000 + 15s for network latency.
        const cancelDeadline = TIMEOUT_SECONDS * 1000 + 15_000;
        await waitForSwapState(
          stateStore,
          manifest.swap_id,
          SwapState.CANCELLED,
          cancelDeadline,
        );

        // ----- Verify Party A's deposit was returned -----
        // Poll for the refund to arrive back in Party A's wallet.
        const refundDeadlineMs = Date.now() + PAYOUT_RECEIVE_WAIT_MS;
        let refundArrived = false;

        while (Date.now() < refundDeadlineMs) {
          await sphereA.payments.receive();
          const balanceAAfter = sphereA.payments.getBalance(TOKEN_ID_UCT);
          const uctAfter =
            balanceAAfter.find((b) => b.coinId === TOKEN_ID_UCT)
              ?.totalAmount ?? '0';

          // The refund is confirmed once Party A's UCT balance is back to at
          // least what it was before the deposit (accounting for rounding).
          if (BigInt(uctAfter) >= BigInt(uctBefore)) {
            refundArrived = true;
            break;
          }
          await sleep(POLL_INTERVAL_MS);
        }

        expect(
          refundArrived,
          `Party A's UCT deposit was not refunded within ${PAYOUT_RECEIVE_WAIT_MS}ms. ` +
          `Balance before: ${uctBefore}`,
        ).toBe(true);
      } finally {
        stopReceiveLoop();
        await orchestrator.stop().catch(() => {});
        timeoutManager.destroy();
      }
    },
    90_000, // 1.5 minutes
  );

  // ---------------------------------------------------------------------------
  // Test 3 — Third-party deposit: Charlie deposits on behalf of Party A
  // ---------------------------------------------------------------------------

  it(
    'should accept third-party deposit from Charlie (on behalf of Party A) and complete swap',
    async () => {
      const { stateStore, orchestrator, timeoutManager } =
        buildOrchestratorStack(sphereEscrow);
      const stopReceiveLoop = startEscrowReceiveLoop(sphereEscrow);

      try {
        const escrowAddress = sphereEscrow.identity!.directAddress!;
        const partyAAddress = sphereA.identity!.directAddress!;
        const partyBAddress = sphereB.identity!.directAddress!;

        /*
         * Charlie is NOT a party in the manifest, but deposits UCT on behalf
         * of Party A. In the new model, anyone can deposit — party side is
         * determined by currency type, not sender address. Charlie's UCT
         * payment goes toward asset slot 0 (party_a_currency).
         *
         * Party B then deposits USDU normally → both slots covered → swap completes.
         * Party A receives USDU, Party B receives UCT.
         */
        const manifest = buildManifest(
          partyAAddress,
          partyBAddress,
          TOKEN_ID_UCT,
          AMOUNT_UCT,
          TOKEN_ID_USDU,
          AMOUNT_USDU,
          /* timeout= */ 300,
        );

        const announceResult = await orchestrator.announce(manifest);
        const depositInvoiceId = announceResult.deposit_invoice_id!;
        const invoiceMemo = `INV:${depositInvoiceId}:F`;

        // ----- Initialise a third wallet (Charlie) -----
        const { sphere: sphereCharlie, nametag: charlieNametag } =
          await initWallet('charlie');

        // Fund Charlie with UCT
        await requestFaucet(charlieNametag, 'unicity', 1);
        await waitForBalance(sphereCharlie, COIN_UCT, COIN_UCT, 90_000);

        // Charlie deposits UCT on behalf of Party A
        const charlieAddress = sphereCharlie.identity!.directAddress!;
        const charlieSend = await sphereCharlie.payments.send({
          coinId: TOKEN_ID_UCT,
          amount: AMOUNT_UCT,
          recipient: escrowAddress,
          memo: invoiceMemo,
          invoiceRefundAddress: charlieAddress,
          transferMode: 'instant',
        });
        expect(charlieSend.status).not.toBe('failed');

        // Wait for the deposit to be processed (PARTIAL_DEPOSIT)
        await waitForSwapState(
          stateStore,
          manifest.swap_id,
          SwapState.PARTIAL_DEPOSIT,
          30_000,
        );

        // Party B deposits USDU
        const bAddress = sphereB.identity!.directAddress!;
        const bSend = await sphereB.payments.send({
          coinId: TOKEN_ID_USDU,
          amount: AMOUNT_USDU,
          recipient: escrowAddress,
          memo: invoiceMemo,
          invoiceRefundAddress: bAddress,
          transferMode: 'instant',
        });
        expect(bSend.status).not.toBe('failed');

        // Wait for COMPLETED — both slots covered, payouts executed
        await waitForSwapState(
          stateStore,
          manifest.swap_id,
          SwapState.COMPLETED,
          30_000,
        );

        const finalSwap = stateStore.findBySwapId(manifest.swap_id)!;
        expect(finalSwap.state).toBe(SwapState.COMPLETED);
        expect(finalSwap.payout_a_invoice_id).toBeTruthy();
        expect(finalSwap.payout_b_invoice_id).toBeTruthy();

        // ----- Cleanup Charlie's sphere -----
        await sphereCharlie.destroy().catch(() => {});
      } finally {
        stopReceiveLoop();
        await orchestrator.stop().catch(() => {});
        timeoutManager.destroy();
      }
    },
    90_000, // 1.5 minutes
  );
});
