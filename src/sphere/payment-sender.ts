import type { Sphere, TransferResult } from '@unicitylabs/sphere-sdk';
import { logger } from '../utils/logger.js';

export interface SendPaymentRequest {
  recipient: string;
  amount: string;
  coinId: string;
  memo: string;
}

export interface PaymentSender {
  send(request: SendPaymentRequest): Promise<TransferResult>;
}

/**
 * Wraps Sphere SDK payment sending with instant transfer mode.
 */
export function createPaymentSender(sphere: Sphere): PaymentSender {
  return {
    async send(request: SendPaymentRequest): Promise<TransferResult> {
      logger.info(
        { recipient: request.recipient, amount: request.amount, coinId: request.coinId },
        'Sending instant payment',
      );

      const result = await sphere.payments.send({
        recipient: request.recipient,
        amount: request.amount,
        coinId: request.coinId,
        memo: request.memo,
        transferMode: 'instant',
      });

      logger.info(
        { id: result.id, status: result.status },
        'Payment sent',
      );

      return result;
    },
  };
}
