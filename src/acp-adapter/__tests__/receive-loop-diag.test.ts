/**
 * Coverage for the ESCROW_DIAG_RECEIVE_LOOP gate.
 *
 * The receive-loop logger emits one of two payloads depending on whether
 * the diagnostic env var is set:
 *
 *   - diag OFF (default) — emits ONLY `{ transferCount }`. No
 *     per-transfer detail. This is the default because the per-transfer
 *     `senderPubkey` is a deanonymization vector for swap counterparties
 *     and the (formerly logged) `memo` is free-form operator input that
 *     can carry anything.
 *
 *   - diag ON — adds a `transfers` array of per-transfer summaries. The
 *     `memo` field is dropped even with diag on (see comment in
 *     `main.ts`).
 *
 * These tests pin the env-driven contract without spinning up the full
 * escrow service.
 */

import { describe, it, expect } from 'vitest';
import { buildReceiveLoopLogPayload } from '../main.js';

describe('buildReceiveLoopLogPayload — ESCROW_DIAG_RECEIVE_LOOP gate (W1)', () => {
  const sampleTransfers = [
    {
      id: 'transfer-1',
      senderPubkey: '0123456789abcdef0123456789abcdef',
      memo: 'free-form operator memo',
      tokens: [{}, {}],
    },
    {
      id: 'transfer-2',
      senderPubkey: 'fedcba9876543210fedcba9876543210',
      memo: undefined,
      tokens: [{}],
    },
  ];

  it('emits ONLY transferCount when diag is OFF', () => {
    const payload = buildReceiveLoopLogPayload(sampleTransfers, false);
    expect(payload).toEqual({ transferCount: 2 });
    expect(payload['transfers']).toBeUndefined();
  });

  it('emits per-transfer summary when diag is ON', () => {
    const payload = buildReceiveLoopLogPayload(sampleTransfers, true);
    expect(payload['transferCount']).toBe(2);
    const transfers = payload['transfers'] as Array<Record<string, unknown>>;
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toEqual({
      id: 'transfer-1',
      sender: '0123456789abcdef',
      token_count: 2,
    });
    expect(transfers[1]).toEqual({
      id: 'transfer-2',
      sender: 'fedcba9876543210',
      token_count: 1,
    });
  });

  it('NEVER includes the memo field even with diag ON', () => {
    const payload = buildReceiveLoopLogPayload(sampleTransfers, true);
    const transfers = payload['transfers'] as Array<Record<string, unknown>>;
    for (const t of transfers) {
      expect(t).not.toHaveProperty('memo');
    }
  });

  it('emits an empty transfers array when called with [] and diag ON', () => {
    const payload = buildReceiveLoopLogPayload([], true);
    expect(payload).toEqual({ transferCount: 0, transfers: [] });
  });

  it('emits transferCount: 0 when called with [] and diag OFF', () => {
    const payload = buildReceiveLoopLogPayload([], false);
    expect(payload).toEqual({ transferCount: 0 });
  });
});
