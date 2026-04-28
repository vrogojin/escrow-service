/**
 * Pino logger redaction + value-scrub coverage.
 *
 * The redact paths are tricky: pino's `*` wildcard substitutes for
 * exactly one path segment. A naive `*.mnemonic` does NOT redact a
 * top-level `mnemonic` field, and does NOT redact nested-twice. These
 * tests pin down the cases that matter for the threat model:
 *
 *   - top-level secret field names are redacted
 *   - depth-1 and depth-2 nested secret field names are redacted
 *   - inline secrets (nsec1…, sk_…) inside arbitrary string values are
 *     scrubbed via the formatters.log recursive walker
 *   - normal string fields are NOT mutated
 *
 * Implementation: capture the JSON written to stdout via a `pino` thrown
 * stream so we can read what would be emitted. The production logger is
 * configured with pino-pretty in non-prod, which short-circuits the JSON
 * format — for tests we construct an isolated logger sharing the same
 * redact + formatters config.
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';

// Re-import the SAME redact + formatter config the production logger
// uses, by re-exporting it here for testing.
function buildTestLogger(stream: NodeJS.WritableStream) {
  // Inlined from src/utils/logger.ts — keep in sync. We don't import the
  // production module because the prod transport (pino-pretty in
  // dev / undefined in prod) makes capture awkward.
  const SECRET_FIELD_NAMES = [
    'mnemonic', 'privateKey', 'private_key', 'nsec', 'boot_token',
    'bootToken', 'password', 'secret', 'apiKey', 'api_key',
  ];
  const REDACT_PATHS: string[] = [
    ...SECRET_FIELD_NAMES,
    ...SECRET_FIELD_NAMES.map((n) => `*.${n}`),
    ...SECRET_FIELD_NAMES.map((n) => `*.*.${n}`),
    ...SECRET_FIELD_NAMES.flatMap((n) => [`err.${n}`, `error.${n}`]),
  ];
  const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
    /nsec1[02-9ac-hj-np-z]{58}/gi,
    /sk_[0-9a-f]{32,}/gi,
  ];
  function scrubString(value: string): string {
    let out = value;
    for (const pat of SECRET_VALUE_PATTERNS) {
      out = out.replace(pat, '[REDACTED]');
    }
    return out;
  }
  function deepScrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (depth <= 0) return value;
    if (typeof value === 'string') return scrubString(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return value;
    seen.add(value as object);
    if (Array.isArray(value)) {
      return value.map((v) => deepScrub(v, depth - 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepScrub(v, depth - 1, seen);
    }
    return out;
  }
  return pino(
    {
      level: 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      formatters: {
        log(obj) {
          return deepScrub(obj, 12, new WeakSet()) as Record<string, unknown>;
        },
      },
    },
    stream,
  );
}

function captureLog(fn: (log: pino.Logger) => void): Record<string, unknown> {
  let line = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      line += chunk.toString();
      cb();
    },
  });
  const log = buildTestLogger(stream);
  fn(log);
  // pino is sync against a non-pretty stream — line is already populated.
  // Each log call emits one trailing-newline JSON object; for tests we
  // call once.
  const trimmed = line.trim();
  if (!trimmed) throw new Error('no log output captured');
  return JSON.parse(trimmed) as Record<string, unknown>;
}

describe('pino logger — redaction', () => {
  it('redacts a TOP-LEVEL secret field by bare name', () => {
    const out = captureLog((log) => log.info({ mnemonic: 'twelve magic words' }, 'evt'));
    expect(out['mnemonic']).toBe('[REDACTED]');
  });

  it('redacts a depth-1 nested secret field via wildcard', () => {
    const out = captureLog((log) => log.info({ deal: { mnemonic: 'x' } }, 'evt'));
    expect((out['deal'] as Record<string, unknown>)['mnemonic']).toBe('[REDACTED]');
  });

  it('redacts a depth-2 nested secret field via double wildcard', () => {
    const out = captureLog((log) =>
      log.info({ deal: { terms: { mnemonic: 'x' } } }, 'evt'),
    );
    expect(
      ((out['deal'] as Record<string, Record<string, unknown>>)['terms']!)['mnemonic'],
    ).toBe('[REDACTED]');
  });

  it('redacts well-known field-name aliases (privateKey, nsec, boot_token)', () => {
    const out = captureLog((log) =>
      log.info({ privateKey: 'a', nsec: 'b', boot_token: 'c', password: 'd' }, 'evt'),
    );
    expect(out['privateKey']).toBe('[REDACTED]');
    expect(out['nsec']).toBe('[REDACTED]');
    expect(out['boot_token']).toBe('[REDACTED]');
    expect(out['password']).toBe('[REDACTED]');
  });

  it('does NOT mutate unrelated string fields', () => {
    const out = captureLog((log) =>
      log.info({ ordinaryString: 'hello world', amount: '500' }, 'evt'),
    );
    expect(out['ordinaryString']).toBe('hello world');
    expect(out['amount']).toBe('500');
  });
});

describe('pino logger — value-level secret scrubbing', () => {
  it('scrubs an inline nsec1... in an arbitrary string field', () => {
    // Use a 58-char bech32 body. Lowercase letters (no `b`,`i`,`o`,`1`).
    // Bech32 charset: qpzry9x8gf2tvdw0s3jn54khce6mua7l (no b, i, o, 1).
    // Real nsec: 5 chars prefix `nsec1` + 58 chars body = 63 chars total.
    const fakeNsec =
      'nsec1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce';
    const out = captureLog((log) =>
      log.info({ debug_blob: `failed: ${fakeNsec} is bad` }, 'evt'),
    );
    expect(out['debug_blob']).toBe('failed: [REDACTED] is bad');
  });

  it('scrubs an inline sk_<hex> token', () => {
    const sk = 'sk_' + 'a'.repeat(40);
    const out = captureLog((log) =>
      log.info({ msg_field: `auth header: ${sk}` }, 'evt'),
    );
    expect(out['msg_field']).toBe('auth header: [REDACTED]');
  });

  it('scrubs an inline secret inside a nested object', () => {
    // Bech32 charset: qpzry9x8gf2tvdw0s3jn54khce6mua7l (no b, i, o, 1).
    // Real nsec: 5 chars prefix `nsec1` + 58 chars body = 63 chars total.
    const fakeNsec =
      'nsec1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce';
    const out = captureLog((log) =>
      log.info({ ctx: { sub: { detail: `oops ${fakeNsec}` } } }, 'evt'),
    );
    const detail = (
      (out['ctx'] as Record<string, Record<string, Record<string, string>>>)
        ['sub']!
    )['detail'];
    expect(detail).toBe('oops [REDACTED]');
  });

  it('handles cyclic objects without crashing', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    expect(() => captureLog((log) => log.info(obj, 'evt'))).not.toThrow();
  });
});
