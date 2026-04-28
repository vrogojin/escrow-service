import pino from 'pino';

/**
 * Redaction paths for pino. The `*` wildcards reach top-level and nested
 * fields with these names anywhere in the log object. Mirrors the trader's
 * sanitizing logger so that secrets accidentally placed in log fields by a
 * future contributor are stripped before stdout.
 */
const REDACT_PATHS = [
  '*.mnemonic',
  '*.privateKey',
  '*.private_key',
  '*.nsec',
  '*.boot_token',
  '*.password',
  '*.secret',
  'err.mnemonic',
  'err.nsec',
  'err.privateKey',
  'err.boot_token',
  'err.password',
  'error.mnemonic',
  'error.nsec',
  'error.privateKey',
  'error.boot_token',
  'error.password',
] as const;

/**
 * Value-level secret patterns. pino's `redact` only acts on field paths;
 * if a secret appears INLINE inside a string value (e.g. an error message
 * "failed to load wallet: nsec1..."), redact doesn't help. The serializer
 * below scrubs Error.message/Error.stack with these patterns.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /nsec1[02-9ac-hj-np-z]{58}/gi, // bech32-encoded Nostr secret keys
  /sk_[0-9a-f]{32,}/gi,           // generic secret-key tokens
];

function scrubSecrets(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const pat of SECRET_VALUE_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

interface SerializableErr {
  message?: string;
  stack?: string;
  [k: string]: unknown;
}

function scrubErr(err: SerializableErr): SerializableErr {
  return {
    ...err,
    message: typeof err?.message === 'string' ? (scrubSecrets(err.message) as string) : err?.message,
    stack: typeof err?.stack === 'string' ? (scrubSecrets(err.stack) as string) : err?.stack,
  };
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
  },
  serializers: {
    err: scrubErr,
    error: scrubErr,
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export type Logger = typeof logger;
