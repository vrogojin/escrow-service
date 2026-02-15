import type { Sphere, IncomingTransfer } from '@unicitylabs/sphere-sdk';
import { logger } from '../utils/logger.js';

export type IncomingTransferHandler = (transfer: IncomingTransfer) => Promise<void>;

export interface PaymentListener {
  start(handler: IncomingTransferHandler): void;
  stop(): void;
}

/**
 * Listens for incoming transfers on the Sphere wallet and delegates to a handler.
 */
export function createPaymentListener(sphere: Sphere): PaymentListener {
  let active = false;
  let currentHandler: IncomingTransferHandler | null = null;

  const onTransfer = (transfer: IncomingTransfer) => {
    if (!active || !currentHandler) return;

    logger.info(
      {
        id: transfer.id,
        sender: transfer.senderPubkey,
        nametag: transfer.senderNametag,
        tokenCount: transfer.tokens.length,
        memo: transfer.memo,
      },
      'Incoming transfer received',
    );

    currentHandler(transfer).catch((err) => {
      logger.error({ err, transferId: transfer.id }, 'Error processing incoming transfer');
    });
  };

  return {
    start(handler: IncomingTransferHandler) {
      if (active) return;
      active = true;
      currentHandler = handler;
      sphere.on('transfer:incoming', onTransfer);
      logger.info('Payment listener started');
    },
    stop() {
      active = false;
      currentHandler = null;
      // Note: Sphere SDK may not have an off() method; we guard with `active` flag
      logger.info('Payment listener stopped');
    },
  };
}
