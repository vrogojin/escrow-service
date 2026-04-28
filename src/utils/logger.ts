import pino from 'pino';

/**
 * Sensitive field names. Used both as pino `redact` paths (at every depth
 * we know the log code reaches) and as a key-name filter inside the
 * recursive scrubber below.
 *
 * IMPORTANT: pino's `*` wildcard substitutes for exactly ONE path segment
 * — `*.mnemonic` redacts `{deal: {mnemonic}}` but NOT `{mnemonic}` and not
 * `{deal: {terms: {mnemonic}}}`. We enumerate explicit top-level entries
 * AND wildcards at depth 1 + 2, AND fall through to the recursive
 * scrubber below for depth-3+ matching by field NAME.
 *
 * The list is exported and frozen at module load so tests can import the
 * production source-of-truth (drift is impossible — there is only one
 * list).
 */
export const SECRET_FIELD_NAMES = Object.freeze([
  // Crypto / wallet identity
  'mnemonic',
  'mnemonics',
  'seed',
  'seedPhrase',
  'seed_phrase',
  'privateKey',
  'private_key',
  'nsec',
  // Bootstrap / identity tokens
  'boot_token',
  'bootToken',
  // Generic auth / secrets
  'password',
  'secret',
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'refreshToken',
  'webhookSecret',
  'signingKey',
  // HTTP transport headers
  'Authorization',
  'authorization',
  'cookie',
  'set-cookie',
] as const);

/** Lowercase set for case-insensitive field-name lookup in deepScrub. */
const SECRET_FIELD_NAMES_SET: ReadonlySet<string> = new Set(
  SECRET_FIELD_NAMES.map((n) => n.toLowerCase()),
);

const REDACT_PATHS: ReadonlyArray<string> = [
  // Top-level — pino does NOT auto-redact bare names from a wildcard pattern.
  ...SECRET_FIELD_NAMES,
  // Depth 1 wildcard
  ...SECRET_FIELD_NAMES.map((n) => `*.${n}`),
  // Depth 2 wildcard
  ...SECRET_FIELD_NAMES.map((n) => `*.*.${n}`),
  // Common explicit paths under err / error (errors often carry these)
  ...SECRET_FIELD_NAMES.flatMap((n) => [`err.${n}`, `error.${n}`]),
];

/**
 * Value-level secret patterns — apply to any string anywhere in the log
 * object via the recursive scrubber below. Catches inline secrets (e.g.
 * an Error message "failed to load wallet: nsec1...") that pino's
 * path-based redact cannot reach.
 *
 * The bech32 charset excludes `b`, `i`, `o`, `1` to avoid confusing
 * lookalikes — and `0` is NOT in the charset either. Earlier the regex
 * permitted `[02-9ac-hj-np-z]{58}` which incorrectly accepted `0`.
 *
 * The 64-hex pattern is intentionally aggressive: token IDs are typically
 * not logged as bare strings (they appear inside structured fields the
 * field-name redact already covers). The narrow lookbehind/ahead avoids
 * partial matches inside longer hex blobs.
 */
export const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // bech32-encoded Nostr secret keys (5-char prefix + 58-char body)
  /nsec1[ac-hj-np-z2-9]{58}/gi,
  // generic secret-key tokens (sk_<hex>)
  /sk_[0-9a-f]{32,}/gi,
  // 64-char hex (private keys, raw secp256k1 secrets)
  /(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])/gi,
  // JWT (header.payload.signature, base64url segments)
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Apply the value-level scrubber to a string. */
export function scrubString(value: string): string {
  let out = value;
  for (const pat of SECRET_VALUE_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

/**
 * Recursive scrubber. Walks the log object once and:
 *   1. Redacts any value whose KEY (case-insensitive) is in
 *      SECRET_FIELD_NAMES_SET — at any depth, regardless of value type.
 *      This closes the depth-3+ gap that pino's `*.*.field` paths cannot
 *      reach (extending the redact paths to deeper wildcards is O(N*depth)
 *      and brittle).
 *   2. Replaces string VALUES matching SECRET_VALUE_PATTERNS with
 *      `[REDACTED]`.
 *
 * Bounded depth and a seen-set guard against cycles and pathological
 * structures.
 */
export function deepScrub(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth <= 0) return value;
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    let mutated = false;
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const scrubbed = deepScrub(value[i], depth - 1, seen);
      if (scrubbed !== value[i]) mutated = true;
      out[i] = scrubbed;
    }
    return mutated ? out : value;
  }

  // Plain object: redact by field name first (covers depth-3+ secrets that
  // pino's static path list misses), then recurse into the rest.
  let mutated = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES_SET.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
      mutated = true;
      continue;
    }
    const scrubbed = deepScrub(v, depth - 1, seen);
    if (scrubbed !== v) mutated = true;
    out[k] = scrubbed;
  }
  return mutated ? out : value;
}

const MAX_SCRUB_DEPTH = 12;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
  },
  hooks: {
    /**
     * Scrub the second argument to `log.info(obj, msg)` — pino emits
     * `msg` verbatim and the `formatters.log` callback never sees it.
     * Without this hook a caller writing
     *   log.info({}, `failure: nsec1${'q'.repeat(58)} bad`)
     * would emit the raw secret. We pass `msg` through the same string
     * scrubber the deepScrub uses; the merging-object argument is left
     * for `formatters.log` (below) to handle.
     *
     * NOTE: pino accepts `(obj, msg, ...interpolation)`; we scrub only
     * the message string. Interpolation arguments are positional after
     * `msg` and are stringified by pino into the final `msg` field —
     * scrubbing the template alone is insufficient if a caller passes
     * `log.info({}, 'failure: %s', secret)`. We do NOT use
     * util.format-style interpolation in this codebase (rg'd: no `%s`
     * patterns in any log call); enforced by code review.
     */
    logMethod(args, method) {
      // pino signature: log.info(mergingObj?, msg?, ...interpolationArgs)
      // We only need to scrub the `msg` string when present.
      if (args.length >= 2 && typeof args[1] === 'string') {
        args[1] = scrubString(args[1]);
      } else if (args.length >= 1 && typeof args[0] === 'string') {
        // Form: log.info('plain message') — scrub it too.
        args[0] = scrubString(args[0]);
      }
      return method.apply(this, args as Parameters<typeof method>);
    },
  },
  formatters: {
    // Runs on every emitted log object AFTER pino merges bindings + child
    // context but BEFORE serialization. Complements the static `redact`
    // paths above by:
    //   - redacting secret field names at depth 3+ (covers
    //     `cause.*.*.privateKey` etc.)
    //   - scrubbing inline secrets in arbitrary string values
    log(obj) {
      return deepScrub(obj, MAX_SCRUB_DEPTH, new WeakSet()) as Record<
        string,
        unknown
      >;
    },
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export type Logger = typeof logger;
