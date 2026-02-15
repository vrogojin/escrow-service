import type { Sphere, DirectMessage } from '@unicitylabs/sphere-sdk';
import type { SwapManager } from '../core/swap-manager.js';
import type { DepositRepository } from '../storage/repositories/deposit.repository.js';
import type { TransactionRepository } from '../storage/repositories/transaction.repository.js';
import type { WalletManager } from './wallet-manager.js';
import { ManifestValidationError, SwapLimitError } from '../core/swap-manager.js';
import { isValidSwapId } from '../utils/hash.js';
import { logger } from '../utils/logger.js';

export interface MessageHandlerDeps {
  sphere: Sphere;
  swapManager: SwapManager;
  depositRepo: DepositRepository;
  txRepo: TransactionRepository;
  walletManager: WalletManager;
}

export interface MessageHandler {
  start(): void;
  stop(): void;
}

export function createMessageHandler(deps: MessageHandlerDeps): MessageHandler {
  const { sphere, swapManager, depositRepo, txRepo, walletManager } = deps;
  let active = false;
  let unsubscribe: (() => void) | null = null;

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
    if ((err as any)?.code === '23505') {
      return { type: 'error', error: 'Swap already exists' };
    }
    logger.error({ err }, 'Unhandled error in message handler');
    return { type: 'error', error: 'Internal server error' };
  }

  async function handleAnnounce(senderPubkey: string, msg: Record<string, unknown>): Promise<void> {
    if (!msg.manifest || typeof msg.manifest !== 'object') {
      await reply(senderPubkey, { type: 'error', error: 'Request body must contain a "manifest" object' });
      return;
    }

    try {
      const result = await swapManager.announceSwap(msg.manifest as any);
      await reply(senderPubkey, {
        type: 'announce_result',
        swap_id: result.swapCase.swap_id,
        state: result.swapCase.state,
        created_at: result.swapCase.created_at,
        is_new: result.isNew,
      });
    } catch (err) {
      await reply(senderPubkey, mapError(err));
    }
  }

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
      const swap = await swapManager.getSwap(swapId);
      if (!swap) {
        await reply(senderPubkey, { type: 'error', error: 'Swap not found' });
        return;
      }

      const deposits = await depositRepo.findBySwapId(swap.swap_id);
      const transactions = await txRepo.findBySwapId(swap.swap_id);

      await reply(senderPubkey, {
        type: 'status_result',
        swap_id: swap.swap_id,
        state: swap.state,
        manifest: swap.manifest,
        party_a_deposited: swap.party_a_deposited,
        party_b_deposited: swap.party_b_deposited,
        created_at: swap.created_at,
        first_deposit_at: swap.first_deposit_at,
        timeout_at: swap.timeout_at,
        completed_at: swap.completed_at,
        error_message: swap.error_message,
        deposits: deposits.map((d) => ({
          transaction_id: d.transaction_id,
          sender: d.sender,
          amount: d.amount,
          coin_id: d.coin_id,
          matched_party: d.matched_party,
          status: d.status,
          received_at: d.received_at,
        })),
        transactions: transactions.map((t) => ({
          type: t.type,
          direction: t.direction,
          recipient: t.recipient,
          amount: t.amount,
          coin_id: t.coin_id,
          status: t.status,
          created_at: t.created_at,
        })),
      });
    } catch (err) {
      await reply(senderPubkey, mapError(err));
    }
  }

  async function handleDepositInstructions(senderPubkey: string, msg: Record<string, unknown>): Promise<void> {
    const swapId = typeof msg.swap_id === 'string' ? msg.swap_id.toLowerCase() : '';
    if (!isValidSwapId(swapId)) {
      await reply(senderPubkey, {
        type: 'error',
        error: 'Invalid swap_id: must be exactly 64 lowercase hex characters',
      });
      return;
    }

    try {
      const swap = await swapManager.getSwap(swapId);
      if (!swap) {
        await reply(senderPubkey, { type: 'error', error: 'Swap not found' });
        return;
      }

      await reply(senderPubkey, {
        type: 'deposit_instructions_result',
        swap_id: swap.swap_id,
        escrow_address: walletManager.getEscrowAddress(),
        memo: swap.swap_id,
        party_a: {
          address: swap.manifest.party_a_address,
          currency: swap.manifest.party_a_currency_to_change,
          amount: swap.manifest.party_a_value_to_change,
          deposited: swap.party_a_deposited,
        },
        party_b: {
          address: swap.manifest.party_b_address,
          currency: swap.manifest.party_b_currency_to_change,
          amount: swap.manifest.party_b_value_to_change,
          deposited: swap.party_b_deposited,
        },
      });
    } catch (err) {
      await reply(senderPubkey, mapError(err));
    }
  }

  async function onMessage(dm: DirectMessage): Promise<void> {
    if (!active) return;

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

    logger.info({ sender: dm.senderPubkey, type: msg.type }, 'DM request received');

    switch (msg.type) {
      case 'announce':
        await handleAnnounce(dm.senderPubkey, msg);
        break;
      case 'status':
        await handleStatus(dm.senderPubkey, msg);
        break;
      case 'deposit_instructions':
        await handleDepositInstructions(dm.senderPubkey, msg);
        break;
      default:
        await reply(dm.senderPubkey, { type: 'error', error: `Unknown message type: ${msg.type}` });
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      unsubscribe = sphere.communications.onDirectMessage((dm) => {
        onMessage(dm).catch((err) => {
          logger.error({ err, dmId: dm.id }, 'Unhandled error processing DM');
        });
      });
      logger.info('Message handler started');
    },
    stop() {
      if (!active) return;
      active = false;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      logger.info('Message handler stopped');
    },
  };
}
