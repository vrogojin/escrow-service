import type { Sphere, DirectMessage } from '@unicitylabs/sphere-sdk';
import { verifySwapSignature } from '@unicitylabs/sphere-sdk';
import type { SwapStateStore, SwapRecord } from '../core/types.js';
import type {
  SwapOrchestrator,
  InvoiceManager,
  NpubRoleMap,
  InvoiceToken,
} from './orchestrator-interfaces.js';
import {
  ManifestValidationError,
  SwapLimitError,
} from './orchestrator-interfaces.js';
import { SwapState } from '../core/state-machine.js';
import { isValidSwapId } from '../utils/hash.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MessageHandlerDeps {
  sphere: Sphere;
  orchestrator: SwapOrchestrator;
  stateStore: SwapStateStore;
  invoiceManager: InvoiceManager;
  /** Tracks npub → (swapId, party role) associations. */
  npubRoleMap: NpubRoleMap;
  /** The escrow's own DIRECT:// address — used to validate manifest.escrow_address in v2. */
  escrowAddress: string;
}

export interface MessageHandler {
  start(): void;
  stop(): Promise<void>;
}

// Re-export so callers can import the interface types from one place.
export type { NpubRoleMap } from './orchestrator-interfaces.js';

// ---------------------------------------------------------------------------
// Manifest field allow-list
// ---------------------------------------------------------------------------

// Known manifest fields — strip everything else from untrusted input.
const MANIFEST_KEYS = [
  'swap_id',
  'party_a_address',
  'party_b_address',
  'party_a_currency_to_change',
  'party_a_value_to_change',
  'party_b_currency_to_change',
  'party_b_value_to_change',
  'timeout',
  'salt',
  'escrow_address',
  'protocol_version',
] as const;

function stripManifest(raw: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const key of MANIFEST_KEYS) {
    if (key in raw) {
      stripped[key] = raw[key];
    }
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum DM content length (UTF-16 code units) accepted before parsing. */
const MAX_DM_LENGTH = 65_536;

/** Maximum concurrent in-flight DM handlers. */
const MAX_CONCURRENT = 50;

// ---------------------------------------------------------------------------
// States that allow payout-invoice delivery
// ---------------------------------------------------------------------------

const PAYOUT_ELIGIBLE_STATES: ReadonlySet<SwapState> = new Set([
  SwapState.CONCLUDING,
  SwapState.COMPLETED,
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMessageHandler(deps: MessageHandlerDeps): MessageHandler {
  const { sphere, orchestrator, stateStore, invoiceManager, npubRoleMap, escrowAddress } = deps;

  // Lifecycle state.
  // `active` is set synchronously before any await, so the flag-check at
  // handler entry is race-free in single-threaded JS.  In-flight promises
  // are tracked so stop() can drain them.
  let active = false;
  let unsubscribe: (() => void) | null = null;
  const inFlight = new Set<Promise<void>>();
  let startedAt = Date.now();
  // Per-swap gate: serializes the entire announce+resolve+register+deliver
  // sequence so concurrent handleAnnounce calls for the same swap don't race.
  const announceResolveGates = new Map<string, Promise<void>>();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function reply(senderPubkey: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await sphere.communications.sendDM(senderPubkey, JSON.stringify(payload));
    } catch (err) {
      logger.error({ err, recipient: senderPubkey }, 'Failed to send DM reply');
    }
  }

  function mapError(err: unknown): Record<string, unknown> {
    if (err instanceof ManifestValidationError) {
      return { type: 'error', error: 'Manifest validation failed', details: err.errors };
    }
    if (err instanceof SwapLimitError) {
      return { type: 'error', error: err.message };
    }
    logger.error({ err }, 'Unhandled error in message handler');
    return { type: 'error', error: 'Internal server error' };
  }

  /**
   * Determine which party role a given npub holds for a swap.
   *
   * Two conditions must both be satisfied (defence-in-depth against the
   * announce-first attack):
   *
   * 1. The npub must be registered in npubRoleMap for this swapId (role was
   *    granted during announce after sphere.resolve() confirmed identity).
   * 2. The cached directAddress stored at registration time must still match
   *    the swap's resolved party address.  This guards against the role map
   *    being populated by an attacker who announced first with a spoofed role.
   *
   * Returns the party role ('A' or 'B') or null when either condition fails.
   */
  function authorizeNpub(
    npub: string,
    swap: SwapRecord,
  ): 'A' | 'B' | null {
    // Step 1: role map lookup (includes cached directAddress from announce time).
    const entry = npubRoleMap.getRole(npub, swap.swap_id);
    if (entry === null) return null;

    // Step 2: Address back-check — cached directAddress must match the swap's
    // stored resolved party address.  Case-insensitive comparison.
    const cachedAddr = entry.directAddress.toLowerCase();

    if (entry.role === 'A') {
      if (cachedAddr === swap.resolved_party_a_address?.toLowerCase()) return 'A';
    } else {
      if (cachedAddr === swap.resolved_party_b_address?.toLowerCase()) return 'B';
    }

    // Cached address doesn't match current swap record — attacker who announced
    // first will have their own directAddress cached, which won't match the
    // legitimate party's resolved address.
    return null;
  }

  /**
   * Authorize a sender with fallback: try npubRoleMap first, then resolve
   * the sender's transport pubkey and match against the swap's manifest addresses.
   * Registers the sender in the role map on success so future calls are fast.
   */
  async function authorizeWithFallback(senderPubkey: string, swap: SwapRecord): Promise<'A' | 'B' | null> {
    const role = authorizeNpub(senderPubkey, swap);
    if (role !== null) return role;

    // Fallback: resolve sender's transport pubkey to DIRECT address
    let resolveKey = senderPubkey;
    if (resolveKey.length === 66 && (resolveKey.startsWith('02') || resolveKey.startsWith('03'))) {
      resolveKey = resolveKey.slice(2);
    }
    const peerInfo = await sphere.resolve(resolveKey).catch(() => null);
    if (peerInfo?.directAddress) {
      const addr = peerInfo.directAddress.toLowerCase();
      if (addr === swap.resolved_party_a_address?.toLowerCase()) {
        npubRoleMap.register(senderPubkey, swap.swap_id, 'A', swap.resolved_party_a_address!);
        return 'A';
      }
      if (addr === swap.resolved_party_b_address?.toLowerCase()) {
        npubRoleMap.register(senderPubkey, swap.swap_id, 'B', swap.resolved_party_b_address!);
        return 'B';
      }
    }
    return null;
  }

  /**
   * Deliver a deposit invoice token to the given npub with party-specific
   * payment instructions.
   */
  async function deliverDepositInvoice(
    recipientNpub: string,
    swap: SwapRecord,
    party: 'A' | 'B',
  ): Promise<void> {
    const recipientPrefix = recipientNpub.slice(0, 16);
    logger.info({ swap_id: swap.swap_id, party, recipient_prefix: recipientPrefix }, 'deliver_deposit_invoice_enter');
    try {
      if (!swap.deposit_invoice_id) {
        logger.warn({ swap_id: swap.swap_id, party }, 'deliver_deposit_invoice_no_id');
        await reply(recipientNpub, {
          type: 'error',
          error: 'Deposit invoice not yet created',
        });
        return;
      }

      // Retry token retrieval — the invoice was just minted and the token may
      // not be persisted to storage yet (race between createInvoice returning
      // the invoiceId and the token being flushed to disk/memory).
      let token: unknown | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          token = await invoiceManager.getDepositInvoiceToken(swap.deposit_invoice_id);
        } catch (err) {
          lastError = err;
          logger.warn(
            {
              swap_id: swap.swap_id,
              party,
              attempt,
              err: err instanceof Error ? err.message : String(err),
            },
            'deliver_deposit_invoice_get_token_threw',
          );
        }
        if (token) break;
        if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
      }
      if (!token) {
        logger.warn(
          {
            swap_id: swap.swap_id,
            party,
            recipient_prefix: recipientPrefix,
            invoice_id: swap.deposit_invoice_id,
            last_error: lastError instanceof Error ? lastError.message : (lastError === null ? null : String(lastError)),
          },
          'deliver_deposit_invoice_no_token',
        );
        await reply(recipientNpub, {
          type: 'error',
          error: 'Deposit invoice token not available',
        });
        return;
      }

      const yourCurrency =
        party === 'A'
          ? swap.manifest.party_a_currency_to_change
          : swap.manifest.party_b_currency_to_change;
      const yourAmount =
        party === 'A'
          ? swap.manifest.party_a_value_to_change
          : swap.manifest.party_b_value_to_change;

      logger.info(
        {
          swap_id: swap.swap_id,
          party,
          recipient_prefix: recipientPrefix,
          invoice_id: swap.deposit_invoice_id,
          your_currency: yourCurrency,
          your_amount: String(yourAmount),
        },
        'deliver_deposit_invoice_sending',
      );
      await reply(recipientNpub, {
        type: 'invoice_delivery',
        swap_id: swap.swap_id,
        invoice_type: 'deposit',
        invoice_id: swap.deposit_invoice_id,
        invoice_token: token,
        payment_instructions: {
          your_currency: yourCurrency,
          your_amount: yourAmount,
          memo: `INV:${swap.deposit_invoice_id}:F`,
        },
      });
      logger.info(
        { swap_id: swap.swap_id, party, recipient_prefix: recipientPrefix },
        'deliver_deposit_invoice_sent',
      );
    } catch (err) {
      logger.error(
        {
          swap_id: swap.swap_id,
          party,
          recipient_prefix: recipientPrefix,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'deliver_deposit_invoice_threw',
      );
      throw err;
    }
  }

  /**
   * Deliver a payout invoice token to the given npub.
   * No payment instructions are included — the escrow pays, not the party.
   */
  async function deliverPayoutInvoice(
    recipientNpub: string,
    swapId: string,
    invoiceId: string,
    token: InvoiceToken,
  ): Promise<void> {
    await reply(recipientNpub, {
      type: 'invoice_delivery',
      swap_id: swapId,
      invoice_type: 'payout',
      invoice_id: invoiceId,
      invoice_token: token,
    });
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle an `announce` message.
   *
   * Flow:
   * 1. Strip and validate the manifest object.
   * 2. Delegate to orchestrator.announce() which creates/retrieves the swap
   *    case and ensures the deposit invoice exists.
   * 3. Determine which party role the announcer is claiming based on their npub.
   * 4. Register the npub→(swapId, role) association in the role map.
   * 5. Reply with announce_result.
   * 6. Deliver the deposit invoice token via a separate invoice_delivery DM.
   */
  async function handleAnnounce(senderPubkey: string, msg: Record<string, unknown>): Promise<void> {
    if (!msg.manifest || typeof msg.manifest !== 'object' || Array.isArray(msg.manifest)) {
      await reply(senderPubkey, { type: 'error', error: 'Request body must contain a "manifest" object' });
      return;
    }

    const manifest = stripManifest(msg.manifest as Record<string, unknown>);

    // Protocol v2: verify party signatures before accepting the manifest.
    // v1 (or omitted version) skips signature verification for backward compatibility —
    // v1 announces rely on address-based trust (the announcer's npub matches a party address).
    const rawVersion = msg.version;
    const version = (typeof rawVersion === 'number' || typeof rawVersion === 'string')
      ? Number(rawVersion) || 0
      : 0;
    if (version === 2) {
      const signatures = msg.signatures;
      const chainPubkeys = msg.chain_pubkeys;

      // Type-validate: must be non-null plain objects (not arrays, strings, numbers)
      if (!signatures || typeof signatures !== 'object' || Array.isArray(signatures) ||
          !chainPubkeys || typeof chainPubkeys !== 'object' || Array.isArray(chainPubkeys)) {
        await reply(senderPubkey, { type: 'error', error: 'Protocol v2 requires "signatures" and "chain_pubkeys" objects' });
        return;
      }

      const sigs = signatures as Record<string, unknown>;
      const pubs = chainPubkeys as Record<string, unknown>;
      const swapId = typeof manifest.swap_id === 'string' ? manifest.swap_id : '';

      // Validate escrow_address matches this escrow's actual address
      const manifestEscrowAddr = typeof manifest.escrow_address === 'string' ? manifest.escrow_address : '';
      if (manifestEscrowAddr !== escrowAddress) {
        await reply(senderPubkey, {
          type: 'error',
          error: `manifest.escrow_address does not match this escrow's address`,
        });
        return;
      }

      // Reject duplicate chain_pubkeys early (before expensive signature verification)
      if (typeof pubs.party_a === 'string' && typeof pubs.party_b === 'string' &&
          pubs.party_a === pubs.party_b) {
        await reply(senderPubkey, { type: 'error', error: 'party_a and party_b chain_pubkeys must be different' });
        return;
      }

      let verified = 0;
      const partyAAddr = typeof manifest.party_a_address === 'string' ? manifest.party_a_address : '';
      const partyBAddr = typeof manifest.party_b_address === 'string' ? manifest.party_b_address : '';

      // Helper: check if a DIRECT:// address value contains the chain_pubkey.
      // Searches only the value portion (after "DIRECT://"), not the prefix itself.
      const addrValueContains = (addr: string, pubkey: string): boolean =>
        addr.startsWith('DIRECT://') && addr.slice(9).includes(pubkey);

      // Verify party A signature + identity binding
      if (typeof sigs.party_a === 'string' && typeof pubs.party_a === 'string') {
        if (!verifySwapSignature(swapId, escrowAddress, sigs.party_a, pubs.party_a)) {
          await reply(senderPubkey, { type: 'error', error: 'Party A signature verification failed' });
          return;
        }
        // Identity binding: verify chain_pubkey corresponds to manifest.party_a_address.
        // For DIRECT:// addresses containing the raw pubkey, the chain_pubkey must appear
        // in the address value. For predicate addresses (derived from the key via SDK),
        // full derivation requires private key access (SDK limitation — see bugs/004).
        // For nametag/proxy addresses, binding is verified post-resolution by the orchestrator.
        if (partyAAddr.startsWith('DIRECT://') && !addrValueContains(partyAAddr, pubs.party_a)) {
          logger.warn(
            { swap_id: swapId, chain_pubkey: pubs.party_a, party_a_address: partyAAddr },
            'Party A chain_pubkey not found in party_a_address — may be a predicate-derived address (cannot verify binding without SDK support)',
          );
        }
        verified++;
      }

      // Verify party B signature + identity binding
      if (typeof sigs.party_b === 'string' && typeof pubs.party_b === 'string') {
        if (!verifySwapSignature(swapId, escrowAddress, sigs.party_b, pubs.party_b)) {
          await reply(senderPubkey, { type: 'error', error: 'Party B signature verification failed' });
          return;
        }
        if (partyBAddr.startsWith('DIRECT://') && !addrValueContains(partyBAddr, pubs.party_b)) {
          logger.warn(
            { swap_id: swapId, chain_pubkey: pubs.party_b, party_b_address: partyBAddr },
            'Party B chain_pubkey not found in party_b_address — may be a predicate-derived address (cannot verify binding without SDK support)',
          );
        }
        verified++;
      }

      // At least one party must have provided a valid signature
      if (verified === 0) {
        await reply(senderPubkey, { type: 'error', error: 'Protocol v2 requires at least one party signature' });
        return;
      }

      logger.info({ swap_id: swapId, version: 2, verified }, 'Protocol v2 signatures verified');
    }

    // The ENTIRE announce+resolve+register+deliver sequence must be serialized
    // per swap_id. Without this, two concurrent handleAnnounce calls (Bob's v2
    // and Alice's v1) both see empty npubRoleMap, both call sphere.resolve()
    // concurrently (doubling relay load), and partial failures leave parties
    // permanently unregistered ("Unauthorized").
    const swapId = typeof manifest.swap_id === 'string' ? manifest.swap_id : '';
    const existingGate = announceResolveGates.get(swapId);
    if (existingGate) {
      // Another handleAnnounce for this swap is already running.
      // Wait for it to complete — it will resolve+register+deliver for both parties.
      await existingGate.catch(() => {});
      // After the first handler completes, parties are registered.
      // Still send announce_result to THIS sender so their SDK gets the response.
      const swap = stateStore.findBySwapId(swapId);
      if (swap?.deposit_invoice_id) {
        await reply(senderPubkey, {
          type: 'announce_result',
          swap_id: swapId,
          state: swap.state,
          deposit_invoice_id: swap.deposit_invoice_id,
          created_at: new Date(swap.created_at).toISOString(),
          is_new: false,
        });
        // Deliver invoice to this sender if they're a registered party
        const role = npubRoleMap.getRole(senderPubkey, swapId);
        if (role) {
          await deliverDepositInvoice(senderPubkey, swap, role.role);
        }
      }
      return;
    }

    const gate = (async () => {
      let result: Awaited<ReturnType<SwapOrchestrator['announce']>>;
      try {
        result = await orchestrator.announce(
          manifest as unknown as import('../core/manifest-validator.js').SwapManifest,
          senderPubkey,
        );
      } catch (err) {
        await reply(senderPubkey, mapError(err));
        return;
      }

      const swap = stateStore.findBySwapId(result.swap_id);
      if (!swap) return;

      // Resolve party transport pubkeys from DIRECT:// manifest addresses.
      let partyAPubkey = npubRoleMap.findNpub(result.swap_id, 'A');
      let partyBPubkey = npubRoleMap.findNpub(result.swap_id, 'B');

      const RESOLVE_ATTEMPTS = 3;
      for (let attempt = 0; attempt < RESOLVE_ATTEMPTS && (!partyAPubkey || !partyBPubkey); attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 2000));
        }

        const [peerA, peerB] = await Promise.all([
          !partyAPubkey && swap.resolved_party_a_address
            ? sphere.resolve(swap.resolved_party_a_address).catch(() => null)
            : Promise.resolve(null),
          !partyBPubkey && swap.resolved_party_b_address
            ? sphere.resolve(swap.resolved_party_b_address).catch(() => null)
            : Promise.resolve(null),
        ]);

        if (peerA?.transportPubkey && !partyAPubkey) {
          partyAPubkey = peerA.transportPubkey;
          npubRoleMap.register(peerA.transportPubkey, result.swap_id, 'A', swap.resolved_party_a_address!);
        }
        if (peerB?.transportPubkey && !partyBPubkey) {
          partyBPubkey = peerB.transportPubkey;
          npubRoleMap.register(peerB.transportPubkey, result.swap_id, 'B', swap.resolved_party_b_address!);
        }
      }

      // Build announce_result payload
      const announcePayload = {
        type: 'announce_result',
        swap_id: result.swap_id,
        state: swap.state,
        deposit_invoice_id: result.deposit_invoice_id,
        created_at: new Date(swap.created_at).toISOString(),
        is_new: result.is_new,
      };

      // Send to BOTH parties — isolate per-party errors so a throw on
      // party A's delivery doesn't skip party B (which would silently
      // half-complete the swap and force the trader to spin in
      // "registered, polling for invoice").
      for (const [party, pubkey] of [['A', partyAPubkey], ['B', partyBPubkey]] as const) {
        if (!pubkey) {
          logger.warn(
            { swap_id: result.swap_id, party },
            'Could not resolve party transport pubkey — announce_result skipped',
          );
          continue;
        }
        try {
          await reply(pubkey, announcePayload);
        } catch (err) {
          logger.error(
            {
              swap_id: result.swap_id,
              party,
              recipient_prefix: pubkey.slice(0, 16),
              err: err instanceof Error ? err.message : String(err),
            },
            'announce_result_send_failed',
          );
        }
        try {
          await deliverDepositInvoice(pubkey, swap, party);
        } catch (err) {
          logger.error(
            {
              swap_id: result.swap_id,
              party,
              recipient_prefix: pubkey.slice(0, 16),
              err: err instanceof Error ? err.message : String(err),
            },
            'deliver_deposit_invoice_failed',
          );
        }
      }
    })();

    announceResolveGates.set(swapId, gate);
    try {
      await gate;
    } finally {
      announceResolveGates.delete(swapId);
    }
  }

  /**
   * Handle a `status` message.
   *
   * Authorization: the requesting npub must:
   * (a) have a registered role for this swapId in npubRoleMap, AND
   * (b) pass the DIRECT address back-check (their npub-derived address must
   *     match the swap's cached resolved party address).
   *
   * This double check defends against the announce-first attack (§2.5 spec
   * note): an attacker who grabbed the manifest and announced first will have
   * a role map entry but their DIRECT address will not match the manifest
   * party address.
   */
  async function handleStatus(senderPubkey: string, msg: Record<string, unknown>): Promise<void> {
    const swapId = typeof msg.swap_id === 'string' ? msg.swap_id.toLowerCase() : '';
    if (!isValidSwapId(swapId)) {
      await reply(senderPubkey, {
        type: 'error',
        error: 'Invalid swap_id: must be exactly 64 lowercase hex characters',
      });
      return;
    }

    try {
      const swap = stateStore.findBySwapId(swapId);
      if (!swap) {
        await reply(senderPubkey, { type: 'error', error: 'Swap not found' });
        return;
      }

      // Cross-swap authorization: reject if the npub's role is for a different
      // swap only — authorizeNpub handles this by scoping to the specific swapId.
      const role = await authorizeWithFallback(senderPubkey, swap);
      if (role === null) {
        await reply(senderPubkey, { type: 'error', error: 'Unauthorized' });
        return;
      }

      // Build deposit_status by querying the invoice manager.
      // Per protocol-spec §1.2, derive deposit_status from getInvoiceStatus()
      // coinAssets per-currency coverage.
      let depositStatus: Record<string, unknown> | null = null;
      if (swap.deposit_invoice_id) {
        try {
          const invoiceStatus = await invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
          const target = invoiceStatus.targets[0];
          if (target && target.coinAssets.length >= 2) {
            const assetA = target.coinAssets[0];
            const assetB = target.coinAssets[1];
            depositStatus = {
              state: invoiceStatus.state,
              party_a_covered: assetA?.isCovered ?? false,
              party_b_covered: assetB?.isCovered ?? false,
              party_a_amount: assetA?.netCoveredAmount ?? '0',
              party_b_amount: assetB?.netCoveredAmount ?? '0',
            };
          }
        } catch (err) {
          logger.warn({ err, swap_id: swap.swap_id }, 'Failed to fetch deposit invoice status for status_result');
          // depositStatus remains null on error, per protocol-spec
        }
      }

      await reply(senderPubkey, {
        type: 'status_result',
        swap_id: swap.swap_id,
        state: swap.state,
        manifest: swap.manifest,
        deposit_invoice_id: swap.deposit_invoice_id,
        deposit_status: depositStatus,
        payout_a_invoice_id: swap.payout_a_invoice_id,
        payout_b_invoice_id: swap.payout_b_invoice_id,
        created_at: new Date(swap.created_at).toISOString(),
        first_deposit_at: swap.first_deposit_at !== null
          ? new Date(swap.first_deposit_at).toISOString()
          : null,
        timeout_at: swap.timeout_at !== null
          ? new Date(swap.timeout_at).toISOString()
          : null,
        completed_at: swap.completed_at !== null
          ? new Date(swap.completed_at).toISOString()
          : null,
        error_message: swap.error_message,
      });
    } catch (err) {
      await reply(senderPubkey, mapError(err));
    }
  }

  /**
   * Handle a `request_invoice` message.
   *
   * Authorization: same double-check as handleStatus (npubRoleMap + DIRECT
   * address back-check).
   *
   * invoice_type 'deposit':
   *   Re-deliver the deposit invoice token with party-specific payment
   *   instructions.  Available in any state after DEPOSIT_INVOICE_CREATED.
   *
   * invoice_type 'payout':
   *   Re-deliver the requesting party's payout invoice token.  Only available
   *   when the swap is in CONCLUDING or COMPLETED state.
   */
  async function handleRequestInvoice(
    senderPubkey: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const swapId = typeof msg.swap_id === 'string' ? msg.swap_id.toLowerCase() : '';
    if (!isValidSwapId(swapId)) {
      await reply(senderPubkey, {
        type: 'error',
        error: 'Invalid swap_id: must be exactly 64 lowercase hex characters',
      });
      return;
    }

    const invoiceType = msg.invoice_type;
    if (invoiceType !== 'deposit' && invoiceType !== 'payout') {
      await reply(senderPubkey, {
        type: 'error',
        error: 'invoice_type must be "deposit" or "payout"',
      });
      return;
    }

    try {
      const swap = stateStore.findBySwapId(swapId);
      if (!swap) {
        await reply(senderPubkey, { type: 'error', error: 'Swap not found' });
        return;
      }

      // Authorization: npub must be registered AND pass the DIRECT address
      // back-check.  Reject from unrecognized npubs (never announced).
      const role = await authorizeWithFallback(senderPubkey, swap);
      if (role === null) {
        await reply(senderPubkey, { type: 'error', error: 'Unauthorized' });
        return;
      }

      if (invoiceType === 'deposit') {
        await deliverDepositInvoice(senderPubkey, swap, role);
        return;
      }

      // invoiceType === 'payout'
      if (!PAYOUT_ELIGIBLE_STATES.has(swap.state)) {
        await reply(senderPubkey, {
          type: 'error',
          error: 'Payout invoice not available: swap is not yet in CONCLUDING or COMPLETED state',
        });
        return;
      }

      const payoutInvoiceId =
        role === 'A' ? swap.payout_a_invoice_id : swap.payout_b_invoice_id;

      if (!payoutInvoiceId) {
        await reply(senderPubkey, {
          type: 'error',
          error: 'Payout invoice not yet created',
        });
        return;
      }

      const token = await invoiceManager.getPayoutInvoiceToken(payoutInvoiceId);
      if (!token) {
        await reply(senderPubkey, {
          type: 'error',
          error: 'Payout invoice token not available',
        });
        return;
      }

      await deliverPayoutInvoice(senderPubkey, swap.swap_id, payoutInvoiceId, token);
    } catch (err) {
      await reply(senderPubkey, mapError(err));
    }
  }

  /**
   * Handle a `deposit_instructions` message (legacy backward-compat alias).
   *
   * Treated identically to `request_invoice` with `invoice_type: 'deposit'`.
   * See protocol-spec §1.1 `deposit_instructions`.
   */
  async function handleDepositInstructions(
    senderPubkey: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    await handleRequestInvoice(senderPubkey, {
      ...msg,
      invoice_type: 'deposit',
    });
  }

  /**
   * Handle a `cancel` message.
   *
   * Flow:
   * 1. Parse and validate swap_id.
   * 2. Authorize the requesting npub via authorizeNpub().
   * 3. Delegate to orchestrator.cancelSwap().
   * 4. Reply with cancel_result.
   */
  async function handleCancel(senderPubkey: string, msg: Record<string, unknown>): Promise<void> {
    const swapId = typeof msg.swap_id === 'string' ? msg.swap_id.toLowerCase() : '';
    if (!isValidSwapId(swapId)) {
      await reply(senderPubkey, {
        type: 'error',
        error: 'Invalid swap_id: must be exactly 64 lowercase hex characters',
      });
      return;
    }

    try {
      const swap = stateStore.findBySwapId(swapId);
      if (!swap) {
        await reply(senderPubkey, { type: 'error', error: 'Swap not found' });
        return;
      }

      const role = await authorizeWithFallback(senderPubkey, swap);
      if (role === null) {
        await reply(senderPubkey, { type: 'error', error: 'Unauthorized' });
        return;
      }

      const result = await orchestrator.cancelSwap(swapId, role);

      await reply(senderPubkey, {
        type: 'cancel_result',
        swap_id: swapId,
        success: result.success,
        reason: result.reason,
      });
    } catch (err) {
      await reply(senderPubkey, mapError(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Ping (unauthenticated health check)
  // ---------------------------------------------------------------------------

  async function handlePing(senderPubkey: string): Promise<void> {
    await reply(senderPubkey, {
      type: 'pong',
      escrow_address: escrowAddress,
      timestamp: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Core DM dispatcher
  // ---------------------------------------------------------------------------

  async function onMessage(dm: DirectMessage): Promise<void> {
    if (!active) return;

    // Skip already-processed DMs. The SDK's CommunicationsModule persists
    // isRead across restarts, so DMs processed in a previous session are
    // automatically skipped on replay without any custom dedup logic.
    if (dm.isRead) return;

    if (dm.content.length > MAX_DM_LENGTH) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(dm.content);
    } catch {
      // Not valid JSON — mark as read so we don't retry
      await sphere.communications.markAsRead([dm.id]);
      return;
    }

    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      await sphere.communications.markAsRead([dm.id]);
      return;
    }
    if (!msg.type || typeof msg.type !== 'string') {
      await sphere.communications.markAsRead([dm.id]);
      return;
    }

    const msgType = msg.type;
    logger.info({ sender: dm.senderPubkey, type: msgType }, 'DM request received');

    switch (msgType) {
      case 'announce':
        await handleAnnounce(dm.senderPubkey, msg);
        break;
      case 'status':
        await handleStatus(dm.senderPubkey, msg);
        break;
      case 'request_invoice':
        await handleRequestInvoice(dm.senderPubkey, msg);
        break;
      case 'deposit_instructions':
        await handleDepositInstructions(dm.senderPubkey, msg);
        break;
      case 'cancel':
        await handleCancel(dm.senderPubkey, msg);
        break;
      case 'ping':
        await handlePing(dm.senderPubkey);
        break;
      default:
        break;
    }

    // Mark as processed — persisted by CommunicationsModule across restarts
    await sphere.communications.markAsRead([dm.id]);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  return {
    start() {
      if (active) return;
      active = true;
      startedAt = Date.now();
      // Bounded processing queue: up to MAX_CONCURRENT handlers run in
      // parallel. Excess DMs are queued (FIFO) and processed as slots free.
      // The shouldSkipDm fast-path runs synchronously BEFORE queuing so
      // replay-duplicates and terminal-swap DMs never occupy a slot.
      const pendingQueue: DirectMessage[] = [];
      let draining = false;

      function drainQueue(): void {
        if (draining) return;
        draining = true;
        while (pendingQueue.length > 0 && inFlight.size < MAX_CONCURRENT) {
          const next = pendingQueue.shift()!;
          const p = onMessage(next).catch((err) => {
            logger.error({ err, dmId: next.id }, 'Unhandled error processing queued DM');
          });
          inFlight.add(p);
          p.finally(() => { inFlight.delete(p); drainQueue(); });
        }
        draining = false;
      }

      unsubscribe = sphere.communications.onDirectMessage((dm) => {
        // Fast skip: already processed in a previous session (persisted by SDK)
        if (dm.isRead) return;

        if (inFlight.size < MAX_CONCURRENT) {
          const p = onMessage(dm).catch((err) => {
            logger.error({ err, dmId: dm.id }, 'Unhandled error processing DM');
          });
          inFlight.add(p);
          p.finally(() => { inFlight.delete(p); drainQueue(); });
        } else {
          pendingQueue.push(dm);
        }
      });
      logger.info('Message handler started');
    },
    async stop() {
      if (!active) return;
      active = false;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      // Drain in-flight handlers before returning (loop handles late additions).
      while (inFlight.size > 0) {
        logger.info({ count: inFlight.size }, 'Draining in-flight DM handlers');
        await Promise.all(inFlight);
      }
      logger.info('Message handler stopped');
    },
  };
}
