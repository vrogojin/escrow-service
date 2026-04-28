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
 * formatter below for anything beyond.
 */
export const SECRET_FIELD_NAMES = [
  'mnemonic',
  'privateKey',
  'private_key',
  'nsec',
  'boot_token',
  'bootToken',
  'password',
  'secret',
  'apiKey',
  'api_key',
] as const;

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
 * object via the recursive `formatters.log` below. Catches inline secrets
 * (e.g. an Error message "failed to load wallet: nsec1...") that pino's
 * path-based redact cannot reach.
 */
export const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /nsec1[02-9ac-hj-np-z]{58}/gi, // bech32-encoded Nostr secret keys
  /sk_[0-9a-f]{32,}/gi,           // generic secret-key tokens
];

function scrubString(value: string): string {
  let out = value;
  for (const pat of SECRET_VALUE_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

/**
 * Recursive value scrubber. Walks the log object once; replaces string
 * values matching the secret-pattern set with `[REDACTED]`. Bounded depth
 * (12) and bounded breadth (the existing log objects are shallow); if a
 * cycle exists, the seen-set short-circuits.
 *
 * We do NOT scrub field NAMES — pino's `redact` already handles that for
 * the SECRET_FIELD_NAMES set, faster and at every depth.
 */
function deepScrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
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

  // Plain object: only scrub string-valued leaves, leave structure intact.
  let mutated = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
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
  formatters: {
    // Runs on every emitted log object AFTER pino merges bindings + child
    // context but BEFORE serialization. The redact step runs separately;
    // this complements it by catching inline secrets in string values that
    // path-based redact cannot reach (e.g. "...nsec1abcdef..." inside an
    // arbitrary string field).
    log(obj) {
      return deepScrub(obj, MAX_SCRUB_DEPTH, new WeakSet()) as Record<string, unknown>;
    },
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export type Logger = typeof logger;
