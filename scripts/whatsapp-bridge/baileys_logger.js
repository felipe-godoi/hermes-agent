/**
 * Baileys receives this logger directly and may attach Signal session objects
 * to its log records.  Keep the logger disabled rather than merely raising its
 * level: a future Baileys level must not make credentials observable through
 * the bridge's inherited stdout/stderr.
 */
import pino from 'pino';

export function createSilentBaileysLogger(destination) {
  return pino({ enabled: false }, destination);
}

const MAX_TOKEN_LENGTH = 80;

function safeToken(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const token = value.slice(0, MAX_TOKEN_LENGTH);
  return /^[A-Za-z0-9_.:-]+$/.test(token) ? token : fallback;
}

/**
 * Return an allowlisted error shape without inspecting/stringifying arbitrary
 * values.  Dependency error messages can themselves contain protocol data, so
 * use a bounded generic message rather than forwarding one.
 */
export function safeBridgeError(error) {
  let code = 'bridge_error';
  let name = 'Error';
  try {
    code = safeToken(error?.code, code);
    name = safeToken(error?.name, name);
  } catch {
    // Accessors on dependency objects are not trusted diagnostic input.
  }
  return { code, name, message: 'Bridge operation failed' };
}

export function emitSafeBridgeError(write, operation, error) {
  const emit = typeof write === 'function' ? write : console.warn;
  const details = safeBridgeError(error);
  emit(JSON.stringify({ event: 'whatsapp-bridge-error', operation, ...details }));
  return details;
}
