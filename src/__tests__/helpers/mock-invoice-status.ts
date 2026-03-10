import { createHash } from 'crypto';
import canonicalize from 'canonicalize';
import type {
  InvoiceStatus,
  InvoiceTransferRef,
  InvoiceSenderBalance,
  IrrelevantTransfer,
} from './mock-accounting-module.js';

/**
 * Factory for creating a mock InvoiceStatus object.
 */
export function createMockInvoiceStatus(opts: {
  invoiceId?: string;
  state?: 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';
  targetAddress: string;
  assets: Array<{
    coinId: string;
    requestedAmount: string;
    transfers?: InvoiceTransferRef[];
    senderBalances?: InvoiceSenderBalance[];
    isCovered?: boolean;
    netCoveredAmount?: string;
  }>;
  irrelevantTransfers?: IrrelevantTransfer[];
  totalForward?: Record<string, string>;
  totalBack?: Record<string, string>;
  allConfirmed?: boolean;
  lastActivityAt?: number;
  explicitClose?: boolean;
}): InvoiceStatus {
  const invoiceId =
    opts.invoiceId ||
    createHash('sha256')
      .update((canonicalize as any)({ ...opts }))
      .digest('hex');

  const coinAssets = (opts.assets as any[]).map((asset: any) => {
    const transfers = asset.transfers || [];
    const coveredAmount = (transfers as InvoiceTransferRef[]).reduce(
      (sum: string, t: InvoiceTransferRef) => String(BigInt(sum) + BigInt(t.amount)),
      '0',
    );
    const netCoveredAmount = asset.netCoveredAmount ?? coveredAmount;
    const isCovered =
      asset.isCovered !== undefined
        ? asset.isCovered
        : BigInt(netCoveredAmount) >= BigInt(asset.requestedAmount);
    const surplusAmount =
      BigInt(netCoveredAmount) > BigInt(asset.requestedAmount)
        ? String(BigInt(netCoveredAmount) - BigInt(asset.requestedAmount))
        : '0';

    return {
      coin: [asset.coinId, asset.requestedAmount] as [string, string],
      coveredAmount,
      returnedAmount: '0',
      netCoveredAmount,
      isCovered,
      surplusAmount,
      confirmed: opts.allConfirmed ?? false,
      transfers,
      senderBalances: asset.senderBalances || [],
    };
  });

  const allCovered = coinAssets.every((ca) => ca.isCovered);

  const totalForward = opts.totalForward || {};
  const totalBack = opts.totalBack || {};

  return {
    invoiceId,
    state: opts.state || 'OPEN',
    targets: [
      {
        address: opts.targetAddress,
        coinAssets,
        nftAssets: [],
        isCovered: allCovered,
        confirmed: opts.allConfirmed ?? false,
      },
    ],
    irrelevantTransfers: opts.irrelevantTransfers || [],
    totalForward,
    totalBack,
    allConfirmed: opts.allConfirmed ?? false,
    lastActivityAt: opts.lastActivityAt ?? Date.now(),
    explicitClose: opts.explicitClose,
  };
}

/**
 * Factory for creating a mock InvoiceTransferRef.
 */
export function createMockTransferRef(opts: {
  transferId: string;
  senderAddress: string | null;
  refundAddress?: string;
  amount: string;
  coinId: string;
  direction?: 'inbound' | 'outbound';
  paymentDirection?: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  destinationAddress?: string;
  timestamp?: number;
  confirmed?: boolean;
  senderPubkey?: string;
  contact?: { address: string; url?: string };
}): InvoiceTransferRef {
  return {
    transferId: opts.transferId,
    senderAddress: opts.senderAddress,
    refundAddress: opts.refundAddress,
    amount: opts.amount,
    coinId: opts.coinId,
    direction: opts.direction || 'inbound',
    paymentDirection: opts.paymentDirection || 'forward',
    destinationAddress: opts.destinationAddress || 'DIRECT://escrow_address',
    timestamp: opts.timestamp ?? Date.now(),
    confirmed: opts.confirmed ?? true,
    senderPubkey: opts.senderPubkey,
    contact: opts.contact,
  };
}

/**
 * Factory for creating a mock InvoiceSenderBalance.
 */
export function createMockSenderBalance(opts: {
  senderAddress: string;
  netBalance: string;
  forwardedAmount: string;
  returnedAmount?: string;
  contacts?: ReadonlyArray<{ address: string; url?: string }>;
}): InvoiceSenderBalance {
  return {
    senderAddress: opts.senderAddress,
    netBalance: opts.netBalance,
    forwardedAmount: opts.forwardedAmount,
    returnedAmount: opts.returnedAmount ?? '0',
    contacts: opts.contacts ?? [],
  };
}
