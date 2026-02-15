# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **trusted escrow service** for executing currency swaps on the Unicity network. Two parties exchange Unicity tokens carrying different currencies at agreed-upon values. The service acts as a trusted intermediary holding deposits and executing payouts.

## Domain Model

The core entity is a **swap manifest** — a JSON object containing:
- `swap_id`: 64 hex digits, derived as a hash of the manifest contents
- `party_A_address`, `party_B_address`: nametag/proxy or direct addresses
- `party_A_currency_to_change`, `party_A_value_to_change`
- `party_B_currency_to_change`, `party_B_value_to_change`
- `timeout`: seconds to wait from first deposit before auto-concluding

## Swap Lifecycle (5 phases)

1. **Agreement**: Parties collaborate off-service to form a shared swap manifest
2. **Announcement**: Parties submit the manifest to the escrow service
3. **Deposit**: Each party confirms the manifest via the escrow, then pays via instant transfer with the manifest ID in the transaction message
4. **Confirmation**: On receiving payment, the escrow:
   - Matches it to an open swap case by transaction message; bounces unmatched payments back immediately
   - If both deposits received, triggers conclusion immediately
   - Otherwise, starts a timeout timer from the first deposit
5. **Conclusion**: If fully covered, pays out cross-party amounts and returns surplus. Timeout also triggers conclusion (partial refunds if not fully covered)

## Key Design Constraints

- Payments use **instant transfer mode** — do not wait for unicity proof generation before proceeding
- Bounce-back of unmatched payments also uses instant transfer mode without waiting for proof
- The timeout timer starts from the **first** deposit, not from manifest submission
- Swap IDs are **hashes of the manifest** (content-addressed)
