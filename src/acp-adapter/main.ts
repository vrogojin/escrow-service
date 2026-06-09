/**
 * Escrow Service — ACP-wrapped entrypoint.
 *
 * This is the adapter that lets the escrow service run as a tenant under the
 * agentic-hosting Host Manager Agent. The non-ACP entrypoint (`src/index.ts`)
 * is still the primary way to run the service standalone; this module wraps
 * the same domain logic (SwapOrchestrator + InvoiceManager + DurableSwapStateStore
 * + DurableNpubRoleMap + MessageHandler) in the ACP-0 protocol envelope so a
 * Host Manager can spawn / heartbeat / status / shutdown the container.
 *
 * Spawn requirements (env vars injected by the Host Manager — see the
 * agentic-hosting Tenant Container Contract):
 *   - UNICITY_MANAGER_PUBKEY
 *   - UNICITY_MANAGER_DIRECT_ADDRESS
 *   - UNICITY_BOOT_TOKEN
 *   - UNICITY_INSTANCE_ID, UNICITY_INSTANCE_NAME, UNICITY_TEMPLATE_ID
 *   - UNICITY_NETWORK, UNICITY_DATA_DIR, UNICITY_TOKENS_DIR
 *
 * Source: ported from agentic-hosting/src/escrow/main.ts during the Phase 4(h)
 * decoupling. Imports now resolve to escrow-service's own modules instead of
 * `@unicitylabs/escrow-service/dist/...`.
 */

import { Sphere, DEFAULT_ESCROW_ADDRESS } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import type { DirectMessage } from '@unicitylabs/sphere-sdk';
import { writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// ACP-adapter local modules (copied from agentic-hosting during decoupling)
import { parseTenantConfig } from './shared/tenant-config.js';
import {
  createAcpMessage,
  isAcpCommandPayload,
  isAcpHelloAckPayload,
} from './protocols/acp.js';
import { isTimestampFresh, parseAcpJson, serializeMessage } from './protocols/envelope.js';
import { pubkeysEqual } from './shared/crypto.js';
import { resolveApiKey } from './shared/api-key.js';
import { createReplayGuard } from './shared/replay-guard.js';

// Escrow-service domain modules — relative imports (formerly `@unicitylabs/escrow-service/dist/...`)
import { SwapOrchestrator } from '../core/swap-orchestrator.js';
import { InvoiceManager } from '../core/invoice-manager.js';
import type { InvoiceManagerDeps } from '../core/invoice-manager.js';
import { DurableSwapStateStore } from '../core/durable-swap-state-store.js';
import { DurableNpubRoleMap } from '../core/durable-npub-role-map.js';
import { TimeoutManager } from '../core/timeout-manager.js';
import { createMessageHandler } from '../sphere/message-handler.js';
import type { SwapOrchestrator as ISwapOrchestrator } from '../sphere/orchestrator-interfaces.js';
import { logger } from '../utils/logger.js';

const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';

export async function startEscrow(): Promise<void> {
  const config = parseTenantConfig();

  const log = logger.child({
    component: 'escrow-acp',
    instance_id: config.instance_id,
    instance_name: config.instance_name,
  });

  // ---------------------------------------------------------------------------
  // 1. Read manager DIRECT address from env (injected by host manager)
  // ---------------------------------------------------------------------------
  const managerDirectAddress = process.env['UNICITY_MANAGER_DIRECT_ADDRESS'] ?? '';
  if (!managerDirectAddress) {
    log.error('UNICITY_MANAGER_DIRECT_ADDRESS not set');
    throw new Error('UNICITY_MANAGER_DIRECT_ADDRESS environment variable is required');
  }

  // ---------------------------------------------------------------------------
  // 2. Ensure data directories exist
  // ---------------------------------------------------------------------------
  mkdirSync(config.data_dir, { recursive: true });
  mkdirSync(config.tokens_dir, { recursive: true });

  // Escrow-specific data directory for WAL files
  const escrowDataDir = process.env['ESCROW_DATA_DIR'] ?? join(config.data_dir, 'escrow');
  mkdirSync(escrowDataDir, { recursive: true, mode: 0o700 });

  // ---------------------------------------------------------------------------
  // 3. Download trustbase
  // ---------------------------------------------------------------------------
  log.info({ url: TRUSTBASE_URL }, 'downloading_trustbase');
  const tbResponse = await fetch(TRUSTBASE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!tbResponse.ok) {
    throw new Error(`Failed to download trustbase: HTTP ${tbResponse.status}`);
  }
  const trustbasePath = join(config.data_dir, 'trustbase.json');
  writeFileSync(trustbasePath, await tbResponse.text());

  // ---------------------------------------------------------------------------
  // 4. Initialize Sphere wallet with accounting (no swap/market modules — escrow
  //    drives the swap protocol directly via SwapOrchestrator + invoices).
  // ---------------------------------------------------------------------------
  const apiKey = resolveApiKey();

  // Optional Nostr-relay override. Set `UNICITY_NOSTR_RELAYS` (or
  // `SPHERE_NOSTR_RELAYS` as a fallback) to a comma-separated list of
  // WebSocket URLs to replace the network preset's relays — used by the
  // local-infra e2e harness to point at a Docker-hosted relay when the
  // public testnet relay's write path is degraded.
  const relayOverride = (() => {
    const raw = process.env['UNICITY_NOSTR_RELAYS'] ?? process.env['SPHERE_NOSTR_RELAYS'];
    if (!raw) return undefined;
    const relays = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return relays.length > 0 ? relays : undefined;
  })();
  if (relayOverride) {
    log.info({ relays: relayOverride }, 'nostr_relays_override_active');
  }

  log.info({ network: config.network, data_dir: config.data_dir }, 'initializing_sphere');
  const providers = createNodeProviders({
    network: config.network as 'testnet' | 'mainnet' | 'dev',
    dataDir: config.data_dir,
    tokensDir: config.tokens_dir,
    oracle: {
      trustBasePath: trustbasePath,
      apiKey,
    },
    ...(relayOverride ? { transport: { relays: relayOverride } } : {}),
  });

  // ---------------------------------------------------------------------------
  // Nametag bootstrap (sphere-sdk#456)
  //
  // Two-tier model:
  //
  //   PRIMARY (HD address 0): tenant-unique identity. Handles ACP heartbeats,
  //   swap state, deposit/payout DMs. Stable across the tenant's lifetime —
  //   rotating it would break in-flight swaps and the HM's container tracking.
  //
  //   PUBLIC (HD address 1+): discovery nametag end-user wallets resolve via
  //   the SDK's hardcoded `DEFAULT_ESCROW_ADDRESS`. Minted on a fresh HD
  //   address so a wallet that already owns a PRIMARY nametag can still own
  //   the public one (the SDK enforces 1 nametag / address on-chain).
  //
  // Operator override surface:
  //   - SPHERE_NAMETAG: PRIMARY nametag for fresh deploys. Ignored on existing
  //     wallets (re-init with a different name throws ALREADY_INITIALIZED).
  //   - ESCROW_PUBLIC_NAMETAG: PUBLIC nametag override. Defaults to the
  //     SDK's `DEFAULT_ESCROW_ADDRESS` (currently `@escrow-testnet-v1`).
  //
  // Fresh-deploy behaviour: PRIMARY is the auto-generated `e-<id>` so the
  // ACP-channel nametag stays tenant-unique; PUBLIC mint runs against the
  // SDK default, giving the new tenant `@escrow-testnet-v1` discoverability
  // without any operator action.
  // ---------------------------------------------------------------------------
  const primaryNametag = process.env['SPHERE_NAMETAG']
    ?? `e-${config.instance_id.replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
  log.info({ nametag: primaryNametag }, 'registering_primary_nametag');

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag: primaryNametag,
    accounting: true,
    swap: false,
    market: false,
  });

  const identity = sphere.identity;
  if (!identity) {
    throw new Error('Sphere wallet initialization failed — no identity');
  }

  const walletPath = join(config.data_dir, 'wallet');
  log.warn(
    {
      wallet_path: walletPath,
      data_dir: config.data_dir,
    },
    'CRITICAL: The escrow wallet MUST be backed up. Loss of wallet data means loss of escrowed funds.',
  );

  const escrowPubkey = identity.chainPubkey;
  const escrowDirectAddress = identity.directAddress ?? `DIRECT://${escrowPubkey}`;
  log.info(
    {
      pubkey: escrowPubkey.slice(0, 16) + '...',
      direct_address: escrowDirectAddress,
      nametag: identity.nametag ?? null,
      accounting: sphere.accounting !== null,
    },
    'sphere_initialized',
  );

  // Verify nametag is resolvable on the relay before declaring ready.
  const resolveFunc = (sphere as unknown as { resolve(id: string): Promise<{ directAddress?: string } | null> }).resolve.bind(sphere);
  async function verifyNametagResolves(name: string): Promise<boolean> {
    const at = name.startsWith('@') ? name : `@${name}`;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const resolved = await resolveFunc(at);
        if (resolved?.directAddress) {
          log.info({ nametag: name, attempt }, 'nametag_verified');
          return true;
        }
      } catch { /* retry */ }
      if (attempt < 10) await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
    log.error({ nametag: name }, 'nametag_verification_failed');
    return false;
  }
  if (identity.nametag) {
    await verifyNametagResolves(identity.nametag);
  }

  // ---------------------------------------------------------------------------
  // Public nametag bootstrap (sphere-sdk#456 B+C)
  //
  // Ensures the canonical public nametag (default `@escrow-testnet-v1`) is
  // owned by ONE of our tracked HD addresses. Idempotent on restart: if any
  // tracked address already owns it (primary mint matched, or a previous boot
  // already minted on a secondary), this block is a no-op.
  //
  // Cross-address message routing — incoming DMs to the secondary address
  // flow through the central event bus (`sphere.on('message:dm')`) wired in
  // message-handler.ts; outbound replies go from the primary identity, which
  // is the canonical escrow address embedded in deposit invoices.
  // ---------------------------------------------------------------------------
  const publicNametag = (process.env['ESCROW_PUBLIC_NAMETAG'] ?? DEFAULT_ESCROW_ADDRESS)
    .replace(/^@/, '')
    .toLowerCase();
  let publicNametagTransportPubkey: string | null = null;
  {
    const tracked = sphere.getActiveAddresses();
    const owning = tracked.find((a) => a.nametag === publicNametag);
    if (!owning) {
      // ---------------------------------------------------------------------
      // FIRST BOOT: mint + publish. Use `registerNametag` (not
      // `switchToAddress`'s built-in nametag option) because the latter only
      // mints the on-chain token via `postSwitchSync.mintNametag` and DOES
      // NOT publish the Nostr binding — observed sphere-sdk#456 testnet
      // deploy where the on-chain token landed but `queryBindingByNametag`
      // returned null. `registerNametag` does both.
      // ---------------------------------------------------------------------
      const nextIdx = Math.max(0, ...tracked.map((a) => a.index)) + 1;
      log.info({ index: nextIdx, nametag: publicNametag }, 'minting_public_nametag_on_secondary');
      await sphere.switchToAddress(nextIdx);
      await sphere.registerNametag(publicNametag);
      const secondaryIdentity = sphere.identity;
      if (secondaryIdentity?.chainPubkey) {
        publicNametagTransportPubkey = secondaryIdentity.chainPubkey.slice(2);
      }
      // Switch back to the primary so all subsequent operations (heartbeats,
      // swap manifests, deposit invoices) carry the primary identity.
      await sphere.switchToAddress(0);
      log.info({ index: nextIdx, nametag: publicNametag }, 'public_nametag_minted');
      // Fire-and-forget relay verification. The mint itself is on-chain
      // synchronous; the relay binding publishes in the background (default
      // `publishMode='background'` of `registerNametag`) and can take 30+
      // seconds to reflect — awaiting it would push past the host manager's
      // hello timeout (30s).
      void verifyNametagResolves(publicNametag).then((ok) => {
        if (!ok) log.warn({ nametag: publicNametag }, 'public_nametag_post_mint_resolve_failed');
      });
    } else {
      // ---------------------------------------------------------------------
      // SUBSEQUENT BOOT: nametag already minted locally + on-chain. The Nostr
      // relay binding may have been lost (prior boot killed mid-publish, or
      // relay rotated). Cycle through the secondary address: switchToAddress
      // without nametag triggers `postSwitchSync.syncIdentityWithTransport`,
      // which republishes the identity binding (with whatever nametag is on
      // the local cache for that address) to the configured relays.
      // ---------------------------------------------------------------------
      publicNametagTransportPubkey = owning.chainPubkey.slice(2);
      log.info({ index: owning.index, nametag: publicNametag }, 'public_nametag_already_present_republishing_binding');
      await sphere.switchToAddress(owning.index);
      await sphere.switchToAddress(0);
      // Async verify — same reasoning as fresh-mint branch.
      void verifyNametagResolves(publicNametag).then((ok) => {
        if (!ok) log.warn({ nametag: publicNametag }, 'public_nametag_resolve_failed_after_republish');
      });
    }
  }

  // Re-read identity in case switchToAddress(0) above renormalized fields.
  const primaryIdentity = sphere.identity;
  if (!primaryIdentity) {
    throw new Error('Primary identity unexpectedly missing after public nametag bootstrap');
  }

  // ---------------------------------------------------------------------------
  // 5. Send acp.hello to manager (transitions container to RUNNING)
  // ---------------------------------------------------------------------------
  const managerAddress = config.manager_pubkey;
  const helloMsg = createAcpMessage('acp.hello', config.instance_id, config.instance_name, {
    boot_token: config.boot_token,
    tenant_pubkey: escrowPubkey,
    tenant_direct_address: escrowDirectAddress,
    tenant_nametag: identity.nametag ?? null,
    adapter: {
      name: 'escrow-service',
      version: '0.1',
      capabilities: ['heartbeat', 'ping', 'shutdown', 'status'],
    },
  });
  await sphere.communications.sendDM(managerAddress, serializeMessage(helloMsg));
  log.info({ instance_id: config.instance_id }, 'hello_sent');

  // ---------------------------------------------------------------------------
  // 6. Set up ACP DM subscription (hello_ack, ping, command from manager)
  // ---------------------------------------------------------------------------

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();

  // Content-hash replay guard for ACP messages from the manager. Same pattern
  // as the tenant-cli-boilerplate's acp-listener: prevents captured
  // SHUTDOWN_GRACEFUL / STATUS DMs from being denial-of-custody-replayed.
  const replayLogPath = join(config.data_dir, 'acp-replay.log');
  const acpReplayGuard = createReplayGuard(replayLogPath, {
    onPersistError: (err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'acp_replay_persist_error');
    },
  });

  // ACP commands the manager is permitted to send. Anything else → UNKNOWN_COMMAND
  // (explicit allowlist, not silent fall-through, so the security boundary is
  // visible to future contributors).
  const ESCROW_SYSTEM_COMMANDS = new Set(['STATUS', 'SHUTDOWN_GRACEFUL']);

  // Heartbeat interval bounds: 1s floor matches the spec minimum; 5min ceiling
  // prevents a malicious/buggy manager from pushing the tenant into a near-
  // infinite "appear-alive" silence by sending an absurdly large interval.
  const HEARTBEAT_MIN_MS = 1_000;
  const HEARTBEAT_MAX_MS = 300_000;

  const acpUnsubscribe = sphere.on('message:dm', (msg: DirectMessage) => {
    const senderPubkey = msg.senderPubkey;
    const content = msg.content;

    // Enforce size limit
    if (content.length > 65536) return;

    // Only handle ACP messages from the manager
    if (!pubkeysEqual(senderPubkey, config.manager_pubkey)) return;

    // Single-call boundary parser: size cap + JSON.parse + dangerous-keys + structural validator.
    // Returns null on any of those failures so we don't have to repeat the
    // size/JSON/proto-pollution checks at every call site.
    const acpMsg = parseAcpJson(content);
    if (acpMsg === null) return;

    // Clock-skew gate: defense-in-depth on top of the content-hash replay guard.
    // A captured DM replayed AFTER the replay-guard TTL (or against a fresh
    // container with empty replay log) would otherwise execute again. The
    // structural validator only requires `ts_ms` to be a finite number —
    // freshness is a separate liveness invariant and must be enforced here,
    // BEFORE the replay-guard records the hash (so a stale message doesn't
    // poison the dedup cache).
    if (!isTimestampFresh(acpMsg.ts_ms)) {
      log.debug(
        { msg_id: acpMsg.msg_id, type: acpMsg.type, ts_ms: acpMsg.ts_ms },
        'acp_ts_ms_out_of_window',
      );
      return;
    }

    // Replay guard: reject content we've seen before within the retention window.
    // Applied AFTER shape validation AND freshness check so malformed/stale messages
    // don't burn dedup slots.
    if (!acpReplayGuard.check(content)) {
      log.debug({ msg_id: acpMsg.msg_id, type: acpMsg.type }, 'acp_replay_rejected');
      return;
    }

    switch (acpMsg.type) {
      case 'acp.hello_ack': {
        if (!isAcpHelloAckPayload(acpMsg.payload)) {
          log.debug({ msg_id: acpMsg.msg_id }, 'acp_hello_ack_payload_invalid');
          break;
        }
        const payload = acpMsg.payload;
        if (payload.accepted === false) {
          log.warn({ instance_id: config.instance_id }, 'hello_ack_rejected');
          break;
        }
        // Clear boot token from env after successful handshake
        delete process.env['UNICITY_BOOT_TOKEN'];

        // Start heartbeat. The guard already rejects NaN/Infinity/<=0 for the
        // optional manager-supplied value, so by this point either the value
        // is a finite positive number, or it's undefined and we use the
        // configured default. Clamp to [HEARTBEAT_MIN_MS, HEARTBEAT_MAX_MS]
        // to bound abuse.
        const requested = typeof payload.heartbeat_interval_ms === 'number'
          ? payload.heartbeat_interval_ms
          : config.heartbeat_interval_ms;
        const interval = Math.min(Math.max(requested, HEARTBEAT_MIN_MS), HEARTBEAT_MAX_MS);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
          const hb = createAcpMessage('acp.heartbeat', config.instance_id, config.instance_name, {
            status: 'ok',
            uptime_ms: Date.now() - startedAt,
            app: { mode: 'escrow', pid: process.pid },
          });
          sphere.communications.sendDM(managerAddress, serializeMessage(hb)).catch(() => {});
        }, interval);
        log.info({ heartbeat_interval_ms: interval }, 'hello_ack_received');
        break;
      }

      case 'acp.ping': {
        const pong = createAcpMessage('acp.pong', config.instance_id, config.instance_name, {
          in_reply_to: acpMsg.msg_id,
          ts_ms: Date.now(),
        });
        sphere.communications.sendDM(managerAddress, serializeMessage(pong)).catch((err: unknown) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'pong_send_failed');
        });
        break;
      }

      case 'acp.command': {
        if (!isAcpCommandPayload(acpMsg.payload)) {
          log.debug({ msg_id: acpMsg.msg_id }, 'acp_command_payload_invalid');
          break;
        }
        const cmdPayload = acpMsg.payload;
        const commandName = cmdPayload.name.toUpperCase();

        // Reject non-allowlisted commands explicitly.
        if (!ESCROW_SYSTEM_COMMANDS.has(commandName)) {
          const errResponse = createAcpMessage('acp.error', config.instance_id, config.instance_name, {
            command_id: cmdPayload.command_id,
            ok: false,
            error_code: 'UNKNOWN_COMMAND',
            message: `Escrow does not handle command: ${cmdPayload.name}`,
          });
          sphere.communications.sendDM(managerAddress, serializeMessage(errResponse)).catch((err: unknown) => {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'error_response_send_failed');
          });
          break;
        }

        let result: Record<string, unknown>;

        if (commandName === 'STATUS') {
          result = {
            command_id: cmdPayload.command_id,
            ok: true,
            data: {
              instance_id: config.instance_id,
              instance_name: config.instance_name,
              uptime_ms: Date.now() - startedAt,
              mode: 'escrow',
              pid: process.pid,
              escrow_address: escrowDirectAddress,
            },
          };
        } else {
          // SHUTDOWN_GRACEFUL — allowlist-verified above.
          result = {
            command_id: cmdPayload.command_id,
            ok: true,
            data: { message: 'Shutdown initiated' },
          };
          // Initiate graceful shutdown after responding
          setTimeout(() => {
            shutdown('SHUTDOWN_GRACEFUL').catch(() => process.exit(1));
          }, 100);
        }

        const responseType = result['ok'] ? 'acp.result' as const : 'acp.error' as const;
        const response = createAcpMessage(responseType, config.instance_id, config.instance_name, result);
        sphere.communications.sendDM(managerAddress, serializeMessage(response)).catch((err: unknown) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'command_response_send_failed');
        });
        break;
      }

      default:
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Wire up escrow domain logic (same as src/index.ts)
  // ---------------------------------------------------------------------------

  if (!sphere.accounting) {
    throw new Error('AccountingModule not available — ensure Sphere is initialized with accounting enabled');
  }

  const invoiceManager = new InvoiceManager({
    accounting: sphere.accounting as unknown as InvoiceManagerDeps['accounting'],
    escrowAddress: escrowDirectAddress,
    getToken: (id) => sphere.payments.getToken(id),
    eventSource: sphere,
    receiveAndFinalize: async () => { await sphere.payments.receive({ finalize: true }); },
    waitForPendingOperations: async () => { await sphere.payments.waitForPendingOperations(); },
  });

  const stateStore = new DurableSwapStateStore(escrowDataDir);
  const npubRoleStore = new DurableNpubRoleMap(escrowDataDir);

  const maxPendingSwaps = parseInt(process.env['MAX_PENDING_SWAPS'] ?? '100', 10);

  // Late-bound callback to break circular dep between timeoutManager and orchestrator.
  // eslint-disable-next-line prefer-const -- assigned after timeoutManager creation (circular dep)
  let orchestratorRef: SwapOrchestrator;
  const timeoutManager = new TimeoutManager({
    onTimeout: async (swapId: string) => orchestratorRef._handleTimeout(swapId),
  });

  const orchestrator = new SwapOrchestrator({
    invoiceManager,
    stateStore,
    timeoutManager,
    messageSender: {
      sendToParty: async (swapId, party, message) => {
        const npub = npubRoleStore.findNpub(swapId, party);
        if (!npub) {
          log.warn({ swapId, party }, 'no_npub_for_party');
          return;
        }
        try {
          await sphere.communications.sendDM(npub, JSON.stringify(message));
        } catch (err) {
          log.warn({ swapId, party, err: err instanceof Error ? err.message : String(err) }, 'dm_send_failed');
        }
      },
      sendToAddress: async (address, message) => {
        const npub = npubRoleStore.findNpubByAddress?.(address) ?? null;
        if (npub) {
          try {
            await sphere.communications.sendDM(npub, JSON.stringify(message));
            return;
          } catch (err) {
            log.warn({ address, err: err instanceof Error ? err.message : String(err) }, 'dm_send_via_cached_npub_failed');
          }
        }
        log.warn({ address, type: (message as Record<string, unknown>).type }, 'bounce_dm_undeliverable');
      },
    },
    addressResolver: {
      resolve: async (address) => {
        if (address.startsWith('DIRECT://')) return address;
        if (address.startsWith('PROXY://')) {
          log.warn({ address }, 'proxy_address_not_supported');
          return null;
        }
        try {
          const peer = await sphere.resolve(address);
          return peer?.directAddress ?? null;
        } catch (err) {
          log.warn({ address, err: err instanceof Error ? err.message : String(err) }, 'address_resolution_failed');
          return null;
        }
      },
    },
    maxPendingSwaps,
  });

  orchestratorRef = orchestrator;
  orchestrator.start();

  // Crash recovery: reconcile non-terminal swaps
  await orchestrator.recoverSwaps();
  stateStore.compact();

  // Start DM message handler for swap-protocol messages (announce, request_invoice, status, cancel)
  const escrowMessageHandler = createMessageHandler({
    sphere,
    orchestrator: orchestrator as ISwapOrchestrator,
    stateStore,
    invoiceManager,
    npubRoleMap: npubRoleStore,
    escrowAddress: escrowDirectAddress,
    // sphere-sdk#456 B: when the public nametag (default `@escrow-testnet-v1`)
    // lives on a secondary HD address, end-user DMs target that address's
    // transport pubkey. The message handler wires a parallel subscription to
    // the central event bus so those DMs reach the same swap orchestrator.
    secondaryTransportPubkey: publicNametagTransportPubkey ?? undefined,
  });
  escrowMessageHandler.start();

  // Catch up on DMs that arrived while offline
  await sphere.fetchPendingEvents().catch((err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'fetch_pending_events_failed');
  });

  // Periodic sync: receive tokens AND fetch pending DM events.
  const receiveLoop = setInterval(async () => {
    try {
      await sphere.payments.receive({ finalize: true });
    } catch {
      // Transient errors are tolerable
    }
    try {
      await (sphere as unknown as { fetchPendingEvents(): Promise<void> }).fetchPendingEvents();
    } catch {
      // Transient errors are tolerable
    }
  }, 15_000);

  log.info(
    {
      pubkey: escrowPubkey.slice(0, 16) + '...',
      direct_address: escrowDirectAddress,
      escrow_data_dir: escrowDataDir,
    },
    'escrow_service_running',
  );

  // ---------------------------------------------------------------------------
  // 8. Graceful shutdown
  // ---------------------------------------------------------------------------

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown_initiated');

    const hardKill = setTimeout(() => {
      log.error('shutdown_timeout — forcing exit');
      process.exit(1);
    }, 30_000);
    hardKill.unref();

    // Stop periodic loops
    clearInterval(receiveLoop);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    // Stop ACP subscription
    if (acpUnsubscribe) acpUnsubscribe();

    // Stop escrow message handler
    await escrowMessageHandler.stop().catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'message_handler_stop_failed');
    });

    // Stop orchestrator
    await orchestrator.stop();

    // Compact WAL files
    try {
      stateStore.compact();
      npubRoleStore.compact((swapId) => {
        const swap = stateStore.findBySwapId(swapId);
        if (!swap) return true;
        return swap.state === 'COMPLETED' || swap.state === 'CANCELLED' || swap.state === 'FAILED';
      });
      log.info('wal_files_compacted');
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'wal_compact_failed');
    }

    // Destroy Sphere
    await sphere.destroy().catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'sphere_destroy_failed');
    });

    log.info('shutdown_complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}

/**
 * Gate auto-start on isMainModule() so test imports don't trigger a real
 * Sphere bootstrap (which would throw on missing UNICITY_* env vars).
 */
function isMainModule(): boolean {
  try {
    const url = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (!argv1) return false;
    try {
      const realArgv1 = realpathSync(argv1);
      return url === realArgv1;
    } catch {
      return url === argv1 || url.endsWith(argv1) || argv1.endsWith(url);
    }
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startEscrow().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'escrow_acp_startup_failed');
    process.exit(1);
  });
}
