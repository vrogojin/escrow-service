import type { Sphere, DirectMessage } from '@unicitylabs/sphere-sdk';
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
}

export interface MessageHandler {
  start(): void;
  stop(): Promise<void>;
}

// Re-export so callers can import the interface types from one place.
export type { NpubRoleMap } from './orchestrator-interfaces.js';

// ---------------------------------------------------------------------------
// Address utilities
// ---------------------------------------------------------------------------

/**
 * Converts a Nostr hex pubkey (npub) to a DIRECT:// address.
 *
 * Protocol invariant: Nostr secp256k1 hex pubkeys map 1:1 to Unicity
 * DIRECT:// addresses. Both use the same 32-byte compressed public key
 * hex encoding. See protocol-spec.md §Identity.
 */
export function npubToDirectAddress(npub: string): string {
  const hex = npub.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Invalid npub: expected 64 lowercase hex chars, got ${npub.length} chars`);
  }
  return `DIRECT://${hex}`;
}

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
  const { sphere, orchestrator, stateStore, invoiceManager, npubRoleMap } = deps;

  // Lifecycle state.
  // `active` is set synchronously before any await, so the flag-check at
  // handler entry is race-free in single-threaded JS.  In-flight promises
  // are tracked so stop() can drain them.
  let active = false;
  let unsubscribe: (() => void) | null = null;
  const inFlight = new Set<Promise<void>>();

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
   * 1. The npub must be registered in npubRoleMap for this swapId.
   * 2. The npub's resolved DIRECT address must match one of the swap's cached
   *    party addresses.  This is the "DIRECT address back-check".
   *
   * Returns the party role ('A' or 'B') or null when either condition fails.
   *
   * NOTE: Resolving an npub to a DIRECT:// address requires calling the
   * sphere SDK.  However, the npub key-space (Nostr secp256k1) and the
   * DIRECT:// chain address key-space use the same underlying curve, so the
   * npub can be converted to a DIRECT:// address deterministically.
   *
   * In the current design the escrow uses the npubRoleMap entry as a
   * convenience hint and then back-checks the claim by comparing the
   * announcer's npub-derived DIRECT address against the resolved party
   * address stored in the swap record.  If the attacker announced first, their
   * npub-derived address will NOT match the manifest's party address, and the
   * check fails.
   */
  function authorizeNpub(
    npub: string,
    swap: SwapRecord,
  ): 'A' | 'B' | null {
    // Step 1: role map lookup.
    const roleFromMap = npubRoleMap.getRole(npub, swap.swap_id);
    if (roleFromMap === null) return null;

    // Step 2: DIRECT address back-check.
    // The npub is the Nostr public key in bech32 format.  We compare the
    // npub's own DIRECT:// address (which is deterministically derived from
    // the same secp256k1 key) against the cached resolved party address.
    // We derive the DIRECT address by asking the sphere SDK for our own
    // address; however since we're operating on an *external* npub here,
    // the practical approach used in the reference implementation is to
    // store the sender's resolved address at announce time and compare at
    // authorisation time.  In the current architecture, the orchestrator
    // stores the resolved addresses when the manifest is announced.  The
    // message handler therefore compares the swap's resolved_party_X_address
    // (set by the orchestrator from the manifest) against the address that
    // the announcing npub would resolve to.
    //
    // The DM senderPubkey is a raw hex public key (not bech32 npub).  The
    // DIRECT:// address for that key is "DIRECT://<hex_pubkey>".  This is
    // compared against the manifest party address (already resolved to
    // DIRECT:// by the orchestrator at announce time).
    //
    // Case-sensitive exact string match — see protocol-spec §7.
    const senderDirectAddress = npubToDirectAddress(npub);

    if (roleFromMap === 'A') {
      if (senderDirectAddress === swap.resolved_party_a_address) return 'A';
    } else {
      if (senderDirectAddress === swap.resolved_party_b_address) return 'B';
    }

    // Role map says one party but back-check fails — attacker who announced
    // first with a spoofed role claim.
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
    if (!swap.deposit_invoice_id) {
      await reply(recipientNpub, {
        type: 'error',
        error: 'Deposit invoice not yet created',
      });
      return;
    }

    const token = await invoiceManager.getDepositInvoiceToken(swap.deposit_invoice_id);
    if (!token) {
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

    let result: Awaited<ReturnType<SwapOrchestrator['announce']>>;
    try {
      const manifest = stripManifest(msg.manifest as Record<string, unknown>);
      result = await orchestrator.announce(
        manifest as unknown as import('../core/manifest-validator.js').SwapManifest,
        senderPubkey,
      );
    } catch (err) {
      await reply(senderPubkey, mapError(err));
      return;
    }

    // Determine party role for this announcer.
    // The orchestrator resolves addresses at announce time and stores them in the
    // swap record.  We use those cached addresses to identify which party the
    // sender's DIRECT:// address corresponds to.
    const swap = stateStore.findBySwapId(result.swap_id);
    let party: 'A' | 'B' | null = null;
    if (swap) {
      const senderDirectAddress = npubToDirectAddress(senderPubkey);
      if (senderDirectAddress === swap.resolved_party_a_address) {
        party = 'A';
      } else if (senderDirectAddress === swap.resolved_party_b_address) {
        party = 'B';
      } else {
        // Third party announced (griefing note from spec §3 Step 2).
        // Do NOT register a role or deliver invoice token — address doesn't
        // match either party. They receive only the public announce_result
        // (swap_id + invoice_id) which is non-sensitive.
        logger.info(
          { swap_id: result.swap_id },
          'Third-party announcer — address matches neither party, skipping role registration and invoice delivery',
        );
      }
      if (party) {
        npubRoleMap.register(senderPubkey, result.swap_id, party);
      }
    }

    // Per protocol-spec §1.2, announce_result includes state and created_at
    const announcedSwap = stateStore.findBySwapId(result.swap_id);
    await reply(senderPubkey, {
      type: 'announce_result',
      swap_id: result.swap_id,
      state: announcedSwap?.state ?? 'DEPOSIT_INVOICE_CREATED',
      deposit_invoice_id: result.deposit_invoice_id,
      created_at: announcedSwap ? new Date(announcedSwap.created_at).toISOString() : new Date().toISOString(),
      is_new: result.is_new,
    });

    // Deliver the deposit invoice token only to verified parties.
    // Use the already-computed party variable directly — avoid a redundant
    // getRole() lookup that could race with concurrent register() calls.
    if (swap && party !== null) {
      await deliverDepositInvoice(senderPubkey, swap, party);
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
      const role = authorizeNpub(senderPubkey, swap);
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
      const role = authorizeNpub(senderPubkey, swap);
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

  // ---------------------------------------------------------------------------
  // Core DM dispatcher
  // ---------------------------------------------------------------------------

  async function onMessage(dm: DirectMessage): Promise<void> {
    if (!active) return;

    if (dm.content.length > MAX_DM_LENGTH) {
      await reply(dm.senderPubkey, { type: 'error', error: 'Message too large' });
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(dm.content);
    } catch {
      await reply(dm.senderPubkey, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      await reply(dm.senderPubkey, { type: 'error', error: 'Message must be a JSON object' });
      return;
    }

    if (!msg.type || typeof msg.type !== 'string') {
      await reply(dm.senderPubkey, { type: 'error', error: 'Missing or invalid "type" field' });
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
      default: {
        const safeType = msgType.slice(0, 64).replace(/[^\x20-\x7E]/g, '');
        await reply(dm.senderPubkey, { type: 'error', error: `Unknown message type: ${safeType}` });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  return {
    start() {
      if (active) return;
      active = true;
      unsubscribe = sphere.communications.onDirectMessage((dm) => {
        if (inFlight.size >= MAX_CONCURRENT) {
          logger.warn({ sender: dm.senderPubkey }, 'DM dropped: concurrency limit reached');
          return;
        }
        const p = onMessage(dm).catch((err) => {
          logger.error({ err, dmId: dm.id }, 'Unhandled error processing DM');
        });
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
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
