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
 * Wraps Sphere SDK payment sending with conservative transfer mode.
 *
 * The escrow uses payInvoice → payments.send for both deposit-collection
 * round-trips (refund / reject) and final settlement payouts. Recipients
 * downstream of these sends include traders that may immediately attempt
 * to spend the received tokens (e.g., a trader that just received a swap
 * payout might immediately withdraw or fund a new swap deposit).
 *
 * 'instant' mode delivers a COMBINED_TRANSFER_V6 bundle that the
 * recipient initially saves at status='submitted' with the SENDER's
 * sdkData (UnmaskedPredicate over the SENDER's pubkey). The SDK swaps
 * sdkData to the RECIPIENT-keyed predicate ONLY after a background
 * proof poll completes (~seconds, but tied to aggregator round-trip
 * time and not gated by `payInvoice`'s return). If the recipient's
 * downstream spend runs in that window — and the spend queue picks the
 * not-yet-finalized token — submitTransferCommitment fails with
 * "Authenticator does not match source state predicate" because the
 * commitment carries sourceState=sender's predicate but
 * authenticator=recipient's signature.
 *
 * 'conservative' mode collects the inclusion proof on the SENDER's
 * side BEFORE delivering the wire payload. The recipient receives a
 * fully-finalized {sourceToken, transferTx} bundle and produces a
 * 'confirmed' Token with sdkData already bound to its own predicate
 * (via PaymentsModule.finalizeTransferToken with the recipient's
 * signingService). The trader's withdraw, post-settlement, then picks
 * any UCT/USDU token (faucet-funded OR swap-payout) and the spend
 * succeeds without a race window.
 *
 * Cost trade-off: conservative is ~slightly slower on the sender side
 * (one extra waitInclusionProof per token) but predictable. For the
 * escrow's payouts at the END of a swap — where downstream spending
 * may follow immediately — predictability beats latency.
 */
export function createPaymentSender(sphere: Sphere): PaymentSender {
  return {
    async send(request: SendPaymentRequest): Promise<TransferResult> {
      logger.info(
        { recipient: request.recipient, amount: request.amount, coinId: request.coinId },
        'Sending conservative payment',
      );

      const result = await sphere.payments.send({
        recipient: request.recipient,
        amount: request.amount,
        coinId: request.coinId,
        memo: request.memo,
        transferMode: 'conservative',
      });

      logger.info(
        { id: result.id, status: result.status },
        'Payment sent',
      );

      return result;
    },
  };
}
