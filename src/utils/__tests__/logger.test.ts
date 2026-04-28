/**
 * Pino logger redaction + value-scrub coverage.
 *
 * The redact paths are tricky: pino's `*` wildcard substitutes for
 * exactly one path segment. A naive `*.mnemonic` does NOT redact a
 * top-level `mnemonic` field, and does NOT redact nested-twice. These
 * tests pin down the cases that matter for the threat model:
 *
 *   - top-level secret field names are redacted
 *   - depth-1 / depth-2 / depth-3+ nested secret field names are redacted
 *   - inline secrets (nsec1…, sk_…, 64-hex, JWTs) inside arbitrary string
 *     values are scrubbed via the formatters.log recursive walker
 *   - the `msg` argument to `log.info(obj, msg)` is scrubbed by the
 *     hooks.logMethod hook (it bypasses formatters.log)
 *   - normal string fields are NOT mutated
 *
 * Implementation: route output through a captured Writable stream and
 * import the production scrubber + secret-name list directly so test and
 * production logic cannot drift.
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { stdSerializers } from 'pino';
import { Writable } from 'node:stream';
import {
  SECRET_FIELD_NAMES,
  SECRET_VALUE_PATTERNS,
  deepScrub,
  scrubString,
} from '../logger.js';

function buildTestLogger(stream: NodeJS.WritableStream) {
  // Mirror the production redact + formatter + hook config, but route
  // output to our captured stream and skip the `transport: pino-pretty`
  // branch that the prod logger uses in dev (pretty makes JSON-capture
  // awkward).
  const REDACT_PATHS: string[] = [
    ...SECRET_FIELD_NAMES,
    ...SECRET_FIELD_NAMES.map((n) => `*.${n}`),
    ...SECRET_FIELD_NAMES.map((n) => `*.*.${n}`),
    ...SECRET_FIELD_NAMES.flatMap((n) => [`err.${n}`, `error.${n}`]),
  ];
  function scrubObjectStrings(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (depth <= 0) return value;
    if (typeof value === 'string') return scrubString(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return value;
    seen.add(value as object);
    if (Array.isArray(value)) return value.map((v) => scrubObjectStrings(v, depth - 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubObjectStrings(v, depth - 1, seen);
    }
    return out;
  }
  return pino(
    {
      level: 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        err(err: unknown) {
          const _err = stdSerializers.err(err as Error);
          return scrubObjectStrings(_err, 12, new WeakSet()) as typeof _err;
        },
      },
      hooks: {
        logMethod(args, method) {
          if (args.length >= 2 && typeof args[1] === 'string') {
            args[1] = scrubString(args[1]);
          } else if (args.length >= 1 && typeof args[0] === 'string') {
            args[0] = scrubString(args[0]);
          }
          return method.apply(this, args as Parameters<typeof method>);
        },
        streamWrite(s: string): string {
          // Mirror the production split — only run the safe-on-JSON
          // patterns at the stream layer (no 64-hex; that pattern's
          // surrounding-prose lookbehind doesn't survive JSON quoting).
          // Keep this list in sync with logger.ts's
          // STREAM_WRITE_PATTERNS.
          const STREAM_PATTERNS: RegExp[] = [
            /nsec1[ac-hj-np-z2-9]{58}/gi,
            /sk_[0-9a-f]{32,}/gi,
            /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
          ];
          let out = s;
          for (const pat of STREAM_PATTERNS) {
            out = out.replace(pat, '[REDACTED]');
          }
          return out;
        },
      },
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

  it('redacts a depth-3 nested secret field via deepScrub field-name match (H1)', () => {
    // Pino redact paths only enumerate `*.*.field` (depth-2). Depth-3+
    // secrets must be caught by deepScrub's field-name guard.
    const out = captureLog((log) =>
      log.info({ a: { b: { c: { mnemonic: 'twelve words here' } } } }, 'evt'),
    );
    const c = (
      (out['a'] as Record<string, Record<string, Record<string, unknown>>>)['b']!
    )['c']!;
    expect((c as Record<string, unknown>)['mnemonic']).toBe('[REDACTED]');
  });

  it('redacts a depth-4 secret inside cause-chain (M3 regression)', () => {
    const out = captureLog((log) =>
      log.info({ err: { cause: { wrapper: { privateKey: 'secret-value' } } } }, 'x'),
    );
    const wrapper = (
      (out['err'] as Record<string, Record<string, Record<string, unknown>>>)['cause']!
    )['wrapper']!;
    expect((wrapper as Record<string, unknown>)['privateKey']).toBe('[REDACTED]');
  });

  it('redacts well-known field-name aliases (privateKey, nsec, boot_token, password)', () => {
    const out = captureLog((log) =>
      log.info({ privateKey: 'a', nsec: 'b', boot_token: 'c', password: 'd' }, 'evt'),
    );
    expect(out['privateKey']).toBe('[REDACTED]');
    expect(out['nsec']).toBe('[REDACTED]');
    expect(out['boot_token']).toBe('[REDACTED]');
    expect(out['password']).toBe('[REDACTED]');
  });

  it('redacts new auth-header aliases (Authorization, authorization, cookie, set-cookie)', () => {
    const out = captureLog((log) =>
      log.info(
        {
          Authorization: 'Bearer abc',
          authorization: 'Bearer def',
          cookie: 'session=xyz',
          'set-cookie': 'session=xyz; HttpOnly',
        },
        'evt',
      ),
    );
    expect(out['Authorization']).toBe('[REDACTED]');
    expect(out['authorization']).toBe('[REDACTED]');
    expect(out['cookie']).toBe('[REDACTED]');
    expect(out['set-cookie']).toBe('[REDACTED]');
  });

  it('redacts token-style aliases (token, accessToken, refreshToken, webhookSecret, signingKey)', () => {
    const out = captureLog((log) =>
      log.info(
        {
          token: 'a',
          accessToken: 'b',
          refreshToken: 'c',
          webhookSecret: 'd',
          signingKey: 'e',
        },
        'evt',
      ),
    );
    expect(out['token']).toBe('[REDACTED]');
    expect(out['accessToken']).toBe('[REDACTED]');
    expect(out['refreshToken']).toBe('[REDACTED]');
    expect(out['webhookSecret']).toBe('[REDACTED]');
    expect(out['signingKey']).toBe('[REDACTED]');
  });

  it('redacts seed-phrase aliases (seed, seedPhrase, seed_phrase, mnemonics)', () => {
    const out = captureLog((log) =>
      log.info(
        {
          seed: 'one',
          seedPhrase: 'two',
          seed_phrase: 'three',
          mnemonics: 'four',
        },
        'evt',
      ),
    );
    expect(out['seed']).toBe('[REDACTED]');
    expect(out['seedPhrase']).toBe('[REDACTED]');
    expect(out['seed_phrase']).toBe('[REDACTED]');
    expect(out['mnemonics']).toBe('[REDACTED]');
  });

  it('redacts secret field names case-insensitively at depth (M2)', () => {
    const out = captureLog((log) =>
      log.info({ outer: { inner: { PRIVATEKEY: 'caps', Mnemonic: 'mixed' } } }, 'evt'),
    );
    const inner = (
      out['outer'] as Record<string, Record<string, unknown>>
    )['inner']!;
    expect((inner as Record<string, unknown>)['PRIVATEKEY']).toBe('[REDACTED]');
    expect((inner as Record<string, unknown>)['Mnemonic']).toBe('[REDACTED]');
  });

  it('does NOT mutate unrelated string fields', () => {
    const out = captureLog((log) =>
      log.info({ ordinaryString: 'hello world', amount: '500' }, 'evt'),
    );
    expect(out['ordinaryString']).toBe('hello world');
    expect(out['amount']).toBe('500');
  });

  it('SECRET_FIELD_NAMES is frozen at module load', () => {
    expect(Object.isFrozen(SECRET_FIELD_NAMES)).toBe(true);
  });
});

describe('pino logger — value-level secret scrubbing', () => {
  it('scrubs an inline nsec1... in an arbitrary string field', () => {
    // Use a 58-char bech32 body. Lowercase letters (no `b`,`i`,`o`,`1`).
    // Bech32 charset: qpzry9x8gf2tvdwks3jn54khce6mua7l (no b, i, o, 0, 1).
    // Real nsec: 5 chars prefix `nsec1` + 58 chars body = 63 chars total.
    const fakeNsec =
      'nsec1qpzry9x8gf2tvdwks3jn54khce6mua7lqpzry9x8gf2tvdwks3jn54khce';
    const out = captureLog((log) =>
      log.info({ debug_blob: `failed: ${fakeNsec} is bad` }, 'evt'),
    );
    expect(out['debug_blob']).toBe('failed: [REDACTED] is bad');
  });

  it('does NOT match an nsec body containing 0 (W3 — bech32 charset has no 0)', () => {
    // The body contains a `0` — if the regex still matched it, that's a
    // bech32 charset violation we want to flag, not silently redact. We
    // assert the value passes through unchanged so any future regression
    // is loud.
    const notQuiteBech32 =
      'nsec10pzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce';
    const out = captureLog((log) =>
      log.info({ debug_blob: notQuiteBech32 }, 'evt'),
    );
    expect(out['debug_blob']).toBe(notQuiteBech32);
  });

  it('scrubs an inline sk_<hex> token', () => {
    const sk = 'sk_' + 'a'.repeat(40);
    const out = captureLog((log) =>
      log.info({ msg_field: `auth header: ${sk}` }, 'evt'),
    );
    expect(out['msg_field']).toBe('auth header: [REDACTED]');
  });

  it('scrubs a 64-char hex private key (M1)', () => {
    const hex64 = 'a'.repeat(64);
    const out = captureLog((log) =>
      log.info({ note: `priv: ${hex64} end` }, 'evt'),
    );
    expect(out['note']).toBe('priv: [REDACTED] end');
  });

  it('does NOT chop the middle of a 128-char hex blob (lookbehind/ahead)', () => {
    // A 128-char hex string (e.g. a token id concatenation) should NOT
    // emit a partial [REDACTED] in the middle — the lookbehind/ahead
    // require non-hex boundaries.
    const hex128 = 'a'.repeat(128);
    const out = captureLog((log) => log.info({ note: hex128 }, 'evt'));
    expect(out['note']).toBe(hex128);
  });

  it('scrubs an inline JWT (M1)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = captureLog((log) =>
      log.info({ header: `Bearer ${jwt}` }, 'evt'),
    );
    expect(out['header']).toBe('Bearer [REDACTED]');
  });

  it('scrubs an inline secret inside a nested object', () => {
    const fakeNsec =
      'nsec1qpzry9x8gf2tvdwks3jn54khce6mua7lqpzry9x8gf2tvdwks3jn54khce';
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

describe('pino logger — msg-string scrubbing via logMethod hook (H2)', () => {
  it('scrubs an inline nsec1... that appears only in the msg argument', () => {
    const fakeNsec =
      'nsec1qpzry9x8gf2tvdwks3jn54khce6mua7lqpzry9x8gf2tvdwks3jn54khce';
    const out = captureLog((log) => log.info({}, `failure: ${fakeNsec}`));
    expect(out['msg']).toBe('failure: [REDACTED]');
  });

  it('scrubs a 64-char hex secret in the msg argument', () => {
    const hex64 = 'a'.repeat(64);
    const out = captureLog((log) => log.info({}, `priv: ${hex64}`));
    expect(out['msg']).toBe('priv: [REDACTED]');
  });

  it('scrubs a JWT in the msg argument', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = captureLog((log) => log.info({}, `header: Bearer ${jwt}`));
    expect(out['msg']).toBe('header: Bearer [REDACTED]');
  });

  it('scrubs a single-arg log message (log.info("plain message"))', () => {
    const fakeNsec =
      'nsec1qpzry9x8gf2tvdwks3jn54khce6mua7lqpzry9x8gf2tvdwks3jn54khce';
    const out = captureLog((log) => log.info(`plain: ${fakeNsec}`));
    expect(out['msg']).toBe('plain: [REDACTED]');
  });
});

describe('pino logger — Error message/stack scrubbing via streamWrite (H3)', () => {
  it('scrubs an inline nsec1... in Error.message via the streamWrite hook', () => {
    // The default pino err serializer emits err.message from the
    // prototype chain. deepScrub cannot reach it (Object.entries(err)
    // returns []). streamWrite runs on the final JSON line and catches
    // the leak.
    const fakeNsec =
      'nsec1qpzry9x8gf2tvdwks3jn54khce6mua7lqpzry9x8gf2tvdwks3jn54khce';
    const e = new Error(`failed to load wallet: ${fakeNsec}`);
    const out = captureLog((log) => log.error({ err: e }, 'wallet_load_failed'));
    const errOut = out['err'] as { message?: string; stack?: string };
    expect(errOut.message).not.toContain('nsec1');
    expect(errOut.message).toContain('[REDACTED]');
  });

  it('scrubs a 64-hex secret embedded in Error.message', () => {
    const hex64 = 'a'.repeat(64);
    const e = new Error(`failed: ${hex64} oops`);
    const out = captureLog((log) => log.error({ err: e }, 'evt'));
    const errOut = out['err'] as { message?: string };
    expect(errOut.message).toBe('failed: [REDACTED] oops');
  });

  it('scrubs Error.stack when it contains a leaked secret', () => {
    const fakeNsec =
      'nsec1qpzry9x8gf2tvdwks3jn54khce6mua7lqpzry9x8gf2tvdwks3jn54khce';
    const e = new Error(`outer: ${fakeNsec}`);
    const out = captureLog((log) => log.error({ err: e }, 'evt'));
    const errOut = out['err'] as { stack?: string };
    expect(errOut.stack).not.toContain('nsec1qpzry9x8');
  });
});

describe('pino logger — 64-hex regex sparing legitimate identifiers (H4)', () => {
  it('does NOT redact a bare swap_id (64-char hex as the entire field value)', () => {
    // swap_ids in this codebase are 64-char lowercase hex. They are
    // logged as bare values throughout the service. Redacting them
    // destroys log correlation. The 64-hex regex now requires non-hex
    // CONTEXT around the match, so a bare-value swap_id is left alone.
    const swapId = 'a'.repeat(64);
    const out = captureLog((log) => log.info({ swap_id: swapId }, 'announce'));
    expect(out['swap_id']).toBe(swapId);
  });

  it('DOES redact a 64-hex blob followed by non-hex prose (suspicious)', () => {
    // A field value that combines a 64-hex blob with surrounding text
    // is treated as suspicious — the bare-value short-circuit only
    // fires for strings that are EXACTLY 64 hex chars. The codebase
    // does not legitimately emit `<swap_id> <verb>` style strings
    // (verified by grep); swap_ids appear as bare values inside
    // structured fields.
    const swapId = 'b'.repeat(64);
    const out = captureLog((log) =>
      log.info({ note: `${swapId} processed` }, 'evt'),
    );
    expect(out['note']).toBe('[REDACTED] processed');
  });

  it('DOES redact a 64-hex blob surrounded by non-hex prose', () => {
    // The threat-model case: a private key embedded in an Error
    // message body. The lookbehind/ahead pass; the regex matches.
    const hex64 = 'c'.repeat(64);
    const out = captureLog((log) =>
      log.info({ note: `priv: ${hex64} bad` }, 'evt'),
    );
    expect(out['note']).toBe('priv: [REDACTED] bad');
  });

  it('does NOT redact a 32-hex value (too short for the pattern)', () => {
    const hex32 = 'd'.repeat(32);
    const out = captureLog((log) => log.info({ token_id: hex32 }, 'evt'));
    expect(out['token_id']).toBe(hex32);
  });
});
