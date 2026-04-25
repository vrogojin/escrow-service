import { describe, it, expect } from 'vitest';
import { createAcpMessage, isValidAcpMessage, ACP_VERSION, ACP_MESSAGE_TYPES } from '../protocols/acp.js';
import { hasDangerousKeys, parseAcpJson, serializeMessage } from '../protocols/envelope.js';

describe('acp-adapter / protocols', () => {
  describe('createAcpMessage', () => {
    it('produces a well-formed envelope', () => {
      const msg = createAcpMessage('acp.heartbeat', 'inst-1', 'name-1', { status: 'ok' });
      expect(msg.acp_version).toBe(ACP_VERSION);
      expect(msg.instance_id).toBe('inst-1');
      expect(msg.instance_name).toBe('name-1');
      expect(msg.type).toBe('acp.heartbeat');
      expect(msg.payload).toEqual({ status: 'ok' });
      expect(typeof msg.msg_id).toBe('string');
      expect(msg.msg_id.length).toBeGreaterThan(0);
      expect(Number.isFinite(msg.ts_ms)).toBe(true);
    });

    it.each(ACP_MESSAGE_TYPES)('round-trips message of type %s through validation', (type) => {
      const msg = createAcpMessage(type, 'inst', 'name', {});
      expect(isValidAcpMessage(msg)).toBe(true);
    });
  });

  describe('isValidAcpMessage', () => {
    it('rejects null / non-object input', () => {
      expect(isValidAcpMessage(null)).toBe(false);
      expect(isValidAcpMessage(undefined)).toBe(false);
      expect(isValidAcpMessage('a string')).toBe(false);
      expect(isValidAcpMessage(42)).toBe(false);
    });

    it('rejects wrong acp_version', () => {
      const msg = createAcpMessage('acp.ping', 'i', 'n', {});
      const tampered = { ...msg, acp_version: '99.0' };
      expect(isValidAcpMessage(tampered)).toBe(false);
    });

    it('rejects unknown type', () => {
      const msg = createAcpMessage('acp.ping', 'i', 'n', {});
      const tampered = { ...msg, type: 'acp.bogus' };
      expect(isValidAcpMessage(tampered)).toBe(false);
    });

    it('rejects missing instance_id / instance_name', () => {
      const msg = createAcpMessage('acp.ping', 'i', 'n', {});
      expect(isValidAcpMessage({ ...msg, instance_id: '' })).toBe(false);
      expect(isValidAcpMessage({ ...msg, instance_name: '' })).toBe(false);
    });

    it('rejects messages with __proto__ / constructor / prototype keys', () => {
      // Use JSON.parse to actually create an own __proto__ property — object
      // literal syntax {__proto__: ...} is a getter/setter pattern, not a
      // real own key. JSON.parse always creates own keys.
      const msg = JSON.parse(JSON.stringify(createAcpMessage('acp.ping', 'i', 'n', {})));
      msg.payload = JSON.parse('{"__proto__": {"polluted": true}}');
      expect(isValidAcpMessage(msg)).toBe(false);
    });
  });

  describe('hasDangerousKeys', () => {
    it('flags __proto__ at any depth', () => {
      // JSON.parse to ensure __proto__ becomes a real own key (object literal
      // syntax doesn't — see note above).
      const dangerous = JSON.parse('{"a": {"b": {"__proto__": {"x": 1}}}}');
      expect(hasDangerousKeys(dangerous)).toBe(true);
    });

    it('returns false for plain objects', () => {
      expect(hasDangerousKeys({ a: 1, b: { c: 2 } })).toBe(false);
    });

    it('caps recursion depth', () => {
      // Build a deeply nested object that exceeds MAX_NESTING_DEPTH (=20)
      let obj: Record<string, unknown> = { x: 1 };
      for (let i = 0; i < 25; i++) {
        obj = { nested: obj };
      }
      // Treated as dangerous (returns true) at depth cap to defend against
      // adversarial nesting that could starve the stack.
      expect(hasDangerousKeys(obj)).toBe(true);
    });
  });

  describe('parseAcpJson', () => {
    it('round-trips serializeMessage → parseAcpJson', () => {
      const msg = createAcpMessage('acp.command', 'i', 'n', {
        command_id: 'c1',
        name: 'STATUS',
        params: {},
      });
      const wire = serializeMessage(msg);
      const parsed = parseAcpJson(wire);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe('acp.command');
      expect(parsed!.payload['command_id']).toBe('c1');
    });

    it('returns null for invalid JSON', () => {
      expect(parseAcpJson('{not json')).toBeNull();
    });

    it('returns null for oversize input', () => {
      const big = '{"x":"' + 'a'.repeat(70_000) + '"}';
      expect(parseAcpJson(big)).toBeNull();
    });

    it('returns null for valid JSON that is not a valid ACP message', () => {
      expect(parseAcpJson(JSON.stringify({ acp_version: '0.1', type: 'acp.ping' }))).toBeNull();
    });
  });
});
