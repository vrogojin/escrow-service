# Bug Fix: Resolve parties from manifest addresses, not DM senders

**Date:** 2026-03-20
**Severity:** Critical — blocks all swaps

## Problem

The escrow's `handleAnnounce()` in `message-handler.ts` tries to identify parties by calling
`sphere.resolve(senderPubkey)` on the DM sender's transport pubkey. This fails because:

1. The sender pubkey may be a 66-char compressed chain pubkey (not 64-char transport pubkey)
2. Identity binding events may not have propagated on the relay yet
3. The whole approach is wrong — party identity comes from the **manifest**, not the DM sender

## Root Cause

The manifest already contains `party_a_address` and `party_b_address` (resolved DIRECT:// addresses).
The escrow already resolves these during `orchestrator.announce()`. The party identification from
the DM sender was unnecessary indirection that added a fragile relay dependency.

## Fix

1. After `orchestrator.announce()` returns, resolve party transport pubkeys from the manifest
   addresses (via `sphere.resolve(party_a_address)` and `sphere.resolve(party_b_address)`).
   These are DIRECT:// addresses which resolve reliably without relay event propagation issues.

2. Register both parties' transport pubkeys in the NpubRoleMap immediately after the swap is
   created — don't wait for each party to announce individually.

3. Deliver the deposit invoice to the DM sender (whoever announced) AND proactively to the
   other party if their transport pubkey was resolved.

4. Remove the `sphere.resolve(senderPubkey)` call entirely from the announce flow.

## Payout Logic (from manifest)

The manifest defines everything needed for payouts:
- Party A receives: `party_b_currency_to_change` / `party_b_value_to_change` → to `party_a_address`
- Party B receives: `party_a_currency_to_change` / `party_a_value_to_change` → to `party_b_address`

Deposit attribution is handled by the AccountingModule via invoice memos — it doesn't matter
WHO deposits, only that the invoice targets are covered.
