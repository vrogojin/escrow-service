/**
 * ACP-0 (Agent Control Protocol) types, constructors, and validators.
 *
 * Source: copied from agentic-hosting/src/protocols/acp.ts during Phase 4(h)
 * decoupling. ACP-0 is owned by the agentic-hosting protocol spec (see
 * agentic-hosting/ref_materials → 02-ACP-MVP.md). This adapter implements
 * the tenant side; if the spec evolves, both repos must update in lockstep.
 */

import { randomUUID } from 'node:crypto';
import { hasDangerousKeys } from './envelope.js';

export const ACP_VERSION = '0.1';

export const ACP_MESSAGE_TYPES = [
  'acp.hello',
  'acp.hello_ack',
  'acp.heartbeat',
  'acp.ping',
  'acp.pong',
  'acp.command',
  'acp.result',
  'acp.error',
] as const;
export type AcpMessageType = (typeof ACP_MESSAGE_TYPES)[number];

export interface AcpCommandPayload {
  readonly command_id: string;
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AcpMessage {
  readonly acp_version: string;
  readonly msg_id: string;
  readonly ts_ms: number;
  readonly instance_id: string;
  readonly instance_name: string;
  readonly type: AcpMessageType;
  readonly payload: Record<string, unknown>;
}

export function createAcpMessage(
  type: AcpMessageType,
  instanceId: string,
  instanceName: string,
  payload: Record<string, unknown>,
): AcpMessage {
  return {
    acp_version: ACP_VERSION,
    msg_id: randomUUID(),
    ts_ms: Date.now(),
    instance_id: instanceId,
    instance_name: instanceName,
    type,
    payload,
  };
}

export function isValidAcpMessage(msg: unknown): msg is AcpMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj['acp_version'] === ACP_VERSION &&
    typeof obj['msg_id'] === 'string' && obj['msg_id'] !== '' &&
    Number.isFinite(obj['ts_ms']) &&
    typeof obj['instance_id'] === 'string' && obj['instance_id'] !== '' &&
    typeof obj['instance_name'] === 'string' && obj['instance_name'] !== '' &&
    typeof obj['type'] === 'string' &&
    (ACP_MESSAGE_TYPES as readonly string[]).includes(obj['type'] as string) &&
    typeof obj['payload'] === 'object' &&
    obj['payload'] !== null &&
    !hasDangerousKeys(obj)
  );
}
