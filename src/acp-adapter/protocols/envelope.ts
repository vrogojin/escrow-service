/**
 * ACP-0 envelope helpers — protocol detection, JSON serialization, prototype-pollution guards.
 *
 * Source: copied from agentic-hosting/src/protocols/envelope.ts during the
 * Phase 4(h) decoupling. Trimmed to the surface this adapter needs (ACP only;
 * HMCP is host-manager-only and not relevant inside a tenant).
 */

import { isValidAcpMessage } from './acp.js';
import type { AcpMessage } from './acp.js';

export const MAX_MESSAGE_SIZE = 64 * 1024;
export const MAX_NESTING_DEPTH = 20;

/** Reject messages whose decoded JSON contains __proto__ / constructor / prototype keys. */
export function hasDangerousKeys(obj: unknown, depth = 0): boolean {
  if (depth > MAX_NESTING_DEPTH) return true;
  if (typeof obj !== 'object' || obj === null) return false;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === 'object' && val !== null && hasDangerousKeys(val, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function serializeMessage(msg: AcpMessage): string {
  return JSON.stringify(msg);
}

export function parseAcpJson(data: string): AcpMessage | null {
  if (data.length > MAX_MESSAGE_SIZE) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (hasDangerousKeys(parsed)) return null;
  if (!isValidAcpMessage(parsed)) return null;
  return parsed;
}
