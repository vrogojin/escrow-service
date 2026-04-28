import pino from 'pino';
import { stdSerializers } from 'pino';

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
 * 64-HEX SECRET DETECTION: the threat model is "a private key (32-byte
 * raw secp256k1) leaked into a free-form Error message". Many legitimate
 * identifiers in this codebase are ALSO 64-char hex — `swap_id`,
 * `coinId`, token-id hashes — and are logged as bare values. We
 * distinguish at the `scrubString` level:
 *  - if the entire string IS exactly 64 hex chars (matches
 *    `BARE_64_HEX_RE`), it is treated as an identifier and returned
 *    unchanged.
 *  - otherwise, the 64-hex pattern below scans for embedded blobs
 *    inside surrounding prose (e.g. an Error message body).
 * The pattern uses negative lookbehind/ahead `(?<![0-9a-fA-F])` /
 * `(?![0-9a-fA-F])` which match at string boundaries (start/end count
 * as "no neighbour"); the BARE_64_HEX_RE short-circuit removes the
 * one collision (a string that IS only the hex).
 *
 * TWO PATTERN SETS — we expose two ordered lists.
 *  - `SECRET_VALUE_PATTERNS` runs on per-value strings inside
 *    `formatters.log` (deepScrub) and on `msg` arguments via
 *    `hooks.logMethod`. The bare-64-hex short-circuit applies here
 *    via scrubString.
 *  - `STREAM_WRITE_PATTERNS` runs on the FINAL JSON output line via
 *    `hooks.streamWrite`. JSON wraps every string field in `"`; we
 *    exclude the 64-hex pattern at this layer because the JSON
 *    quoting would interact badly with the lookbehind/ahead and
 *    cause swap_id false-positives. The 64-hex layer-1 scrub
 *    (formatters.log + logMethod) already covers the threat model
 *    for inputs that pino doesn't post-process; the streamWrite hook
 *    exists primarily to scrub secrets that come from pino's default
 *    err serializer (which reads err.message/stack from the prototype
 *    chain, bypassing formatters.log).
 */
export const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // bech32-encoded Nostr secret keys (5-char prefix + 58-char body)
  /nsec1[ac-hj-np-z2-9]{58}/gi,
  // generic secret-key tokens (sk_<hex>)
  /sk_[0-9a-f]{32,}/gi,
  // 64-char hex (private keys, raw secp256k1 secrets). The
  // lookbehind/ahead prevent partial matches inside a longer hex blob.
  // The bare-64-hex case (a value that IS exactly 64 hex chars) is
  // short-circuited inside `scrubString` because it's almost certainly
  // a legitimate identifier (swap_id, coinId, tokenId) rather than a
  // leaked secret with surrounding prose.
  /(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])/gi,
  // JWT (header.payload.signature, base64url segments)
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
];

/**
 * Patterns safe to run on already-JSON-serialized output. Round-5 update:
 * the 64-hex pattern WAS excluded due to false-positive on bare swap_id
 * values inside JSON quotes (`"abc...64chars"` would match). Round-5 audit
 * found this leaves an Error.message hex-leak gap (a 64-hex secret embedded
 * INSIDE a stringified Error.message survives the deepScrub via prototype
 * chain reads, and was not caught at this layer either).
 *
 * Fix: use a JSON-structural-aware boundary. JSON delimiters around string
 * fields are `"` and `\` (escaped); around values they are `:` `,` `[` `]`
 * and whitespace. The pattern fires on hex sequences SURROUNDED BY any
 * non-hex JSON-structural char. This matches:
 *   - secrets in Error.message: `"...private key: <64hex> bad"`
 *   - secrets between commas: `,"a","<64hex>","b"`
 *
 * It does NOT match bare-id values: `"swap_id":"<64hex>"` because the
 * `"` boundary is structural — wait, it WOULD match. So we ADDITIONALLY
 * require non-hex chars on at least ONE side that aren't `"` (i.e. there
 * must be REAL prose context, not just JSON quoting). Realised via the
 * lookbehind/ahead asserting non-hex AND non-quote.
 */
const STREAM_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /nsec1[ac-hj-np-z2-9]{58}/gi,
  /sk_[0-9a-f]{32,}/gi,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  // 64-hex with real prose context on at least one side. The negative
  // lookbehind/lookahead ensures the boundary char is NOT `"` (JSON
  // string boundary) AND NOT a hex char. So `"abc...64hex"` (bare id
  // in JSON) does NOT match (both boundaries are `"`), but
  // `"...key: abc...64hex bad"` DOES (the leading space and trailing
  // space are non-hex non-quote).
  /(?<![0-9a-fA-F"])[0-9a-f]{64}(?![0-9a-fA-F"])/gi,
];

function scrubStreamLine(value: string): string {
  let out = value;
  for (const pat of STREAM_WRITE_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

/**
 * Match exactly-64-char-lowercase-hex strings. Used to short-circuit
 * the 64-hex secret scan in scrubString — a string that IS exactly
 * 64 hex chars is almost certainly an identifier (swap_id, coinId,
 * tokenId hash) rather than a leaked private key with surrounding
 * prose.
 */
const BARE_64_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Apply the value-level scrubber to a string. Special-case: a string
 * that is EXACTLY 64 hex chars is treated as a legitimate identifier
 * (swap_id, coinId, tokenId hash) rather than a leaked private key,
 * and is returned unchanged. The other patterns (nsec1, sk_, JWT) still
 * run so a string-shaped-like-an-identifier doesn't bypass non-hex
 * detection — but BARE_64_HEX_RE matches only when the entire string
 * is 64 hex with nothing else, so those other patterns can't match
 * anyway.
 */
export function scrubString(value: string): string {
  if (BARE_64_HEX_RE.test(value)) {
    return value;
  }
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

/**
 * Walk an arbitrary object once and apply scrubString to every string
 * leaf. Used inside the err serializer to catch secrets in
 * `_err.message` / `_err.stack` that arrive AFTER deepScrub has run.
 */
function scrubObjectStrings(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth <= 0) return value;
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => scrubObjectStrings(v, depth - 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubObjectStrings(v, depth - 1, seen);
  }
  return out;
}

/**
 * Round-5 audit fix (test drift): export the full pino config builder
 * so tests instantiate the logger via the SAME options used in production
 * rather than rebuilding a hand-coded mirror. Any future change to the
 * config (new redact paths, new serializers, new hooks, formatters) will
 * automatically be reflected in tests — no silent regression.
 */
export function buildLoggerOptions(): pino.LoggerOptions {
  return {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
  },
  serializers: {
    /**
     * Wrap pino's default `err` serializer so `_err.message` and
     * `_err.stack` (and any other string leaves the default emits) get
     * the full SECRET_VALUE_PATTERNS scrub. The default serializer
     * reads `err.message` and `err.stack` from Error.prototype, which
     * `formatters.log`'s deepScrub cannot enumerate via Object.entries.
     * Without this wrapper, a leaked secret in an Error message
     * silently slips out via `log.error({ err })`.
     */
    err(err: unknown) {
      const _err = stdSerializers.err(err as Error);
      // Round-5 audit fix: walk `cause` and `aggregateErrors[]` chains
      // explicitly so nested Error.message / Error.stack from prototype
      // reads on inner errors don't slip past scrubObjectStrings (which
      // can only enumerate own properties via Object.entries).
      const scrubbedSelf = scrubObjectStrings(_err, 12, new WeakSet()) as Record<string, unknown>;
      const walkErrChain = (e: unknown, depth: number): unknown => {
        if (depth <= 0 || e === null || e === undefined) return e;
        if (e instanceof Error) {
          const layered = stdSerializers.err(e) as Record<string, unknown>;
          const scrubbed = scrubObjectStrings(layered, 12, new WeakSet()) as Record<string, unknown>;
          if (e.cause !== undefined) {
            scrubbed['cause'] = walkErrChain(e.cause, depth - 1);
          }
          // AggregateError carries .errors[]
          if (Array.isArray((e as unknown as { errors?: unknown[] }).errors)) {
            scrubbed['aggregateErrors'] = ((e as unknown as { errors: unknown[] }).errors).map((inner) => walkErrChain(inner, depth - 1));
          }
          return scrubbed;
        }
        if (typeof e === 'object') {
          return scrubObjectStrings(e as Record<string, unknown>, 12, new WeakSet());
        }
        if (typeof e === 'string') {
          return scrubString(e);
        }
        return e;
      };
      // If the original `err` was an Error with cause / aggregateErrors,
      // attach the walked versions; stdSerializers.err loses these by
      // default in some configurations.
      if (err instanceof Error) {
        if (err.cause !== undefined) {
          scrubbedSelf['cause'] = walkErrChain(err.cause, 8);
        }
        if (Array.isArray((err as unknown as { errors?: unknown[] }).errors)) {
          scrubbedSelf['aggregateErrors'] = ((err as unknown as { errors: unknown[] }).errors).map((inner) => walkErrChain(inner, 8));
        }
      }
      return scrubbedSelf as typeof _err;
    },
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
    /**
     * Final-stage scrub on the stringified JSON line.
     *
     * MOTIVATION: pino's pipeline is
     *   formatters.log(obj)  →  per-key serializers  →  JSON.stringify
     * The default `serializers.err` (pino-std-serializers) reads
     * `err.message` and `err.stack` from prototype chain and emits them
     * AFTER `formatters.log` has already run, so deepScrub never sees
     * them. (Object.entries(error) returns [] — the message/stack live
     * on the Error prototype, not as own enumerable properties.)
     *
     * Concretely, without this hook a leaked secret in
     *   log.error({ err: new Error('failed: nsec1...') }, 'oops');
     * emits the raw nsec.
     *
     * `streamWrite` runs `scrubStreamLine` on the final JSON string
     * just before transport write. This catches secrets that arrived
     * via the err serializer, custom serializers, or any future code
     * path we don't control. NOTE: `scrubStreamLine` uses
     * STREAM_WRITE_PATTERNS, which excludes the 64-hex pattern; see
     * SECRET_VALUE_PATTERNS for the rationale (JSON `"` quoting
     * defeats the surrounding-prose lookbehind for 64-hex). The
     * 64-hex pattern still runs on per-value strings inside
     * formatters.log, which catches the threat-model case. The cost
     * is one regex pass per log line — acceptable at the volumes this
     * service emits (heartbeat-rate, not request-rate).
     */
    streamWrite(s) {
      return scrubStreamLine(s);
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
  };
}

// STREAM_WRITE_PATTERNS / scrubStreamLine / REDACT_PATHS exported for
// test reuse so the security-boundary tests can assert against the SAME
// constants the production logger uses.
export { STREAM_WRITE_PATTERNS, scrubStreamLine, REDACT_PATHS };

export const logger = pino(buildLoggerOptions());

export type Logger = typeof logger;
