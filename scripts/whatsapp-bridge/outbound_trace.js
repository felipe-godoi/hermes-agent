/**
 * Privacy-safe, bounded observability for outbound Baileys messages.
 *
 * This intentionally retains only message IDs and safe transport metadata.
 * Contact identities, message content, and raw Baileys errors never enter it.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;

// The only `error` values a trace may ever carry: Error `.name`s from
// lid_resolution.js, never `.message`/`.stack`. Anything else collapses to
// `unknown_error` so a future caller passing a raw Baileys error by mistake
// can't reintroduce the leak this module is built to prevent.
const SAFE_ERROR_NAMES = new Set(['WhatsAppNotRegisteredError', 'LidUnavailableError']);

function safeNumber(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function maskOutboundTarget(value) {
  const raw = String(value || '').trim();
  const [user, domain = ''] = raw.split('@', 2);
  const suffix = (user.replace(/\D/g, '') || user).slice(-4) || 'unknown';
  const kind = domain === 'g.us' ? 'group' : domain === 'lid' ? 'lid' : 'jid';
  return `${kind}:…${suffix}`;
}

/** Return the allowlisted shape for a /send lifecycle trace.
 * `resolution_source` / `lid_resolved` / `error` are optional (set by the
 * caller as applicable per stage) and only appear when provided, so callers
 * that don't pass them keep the original trace shape. `error` is always an
 * Error `.name` (e.g. `LidUnavailableError`), never a raw message or stack -
 * this trace must never carry contact identities or message content. */
export function buildOutboundSendTrace(stage, fields = {}) {
  const trace = {
    stage,
    target_tag: String(fields.target_tag || 'unknown'),
    message_id: String(fields.message_id || ''),
    chunk_count: safeNumber(fields.chunk_count),
    queue_wait_ms: safeNumber(fields.queue_wait_ms),
    elapsed_ms: safeNumber(fields.elapsed_ms),
    connection_state: String(fields.connection_state || 'unknown'),
  };
  if (fields.resolution_source !== undefined) {
    trace.resolution_source = String(fields.resolution_source);
  }
  if (fields.lid_resolved !== undefined) {
    trace.lid_resolved = Boolean(fields.lid_resolved);
  }
  if (fields.error !== undefined) {
    const name = String(fields.error);
    trace.error = SAFE_ERROR_NAMES.has(name) ? name : 'unknown_error';
  }
  return trace;
}

function messageIdFrom(event) {
  return event?.key?.id || event?.receipt?.key?.id || '';
}

export function createOutboundTraceTracker({
  maxSize = 128,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  emit,
} = {}) {
  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new RangeError('createOutboundTraceTracker: maxSize must be a positive integer');
  }
  const entries = new Map();
  const clock = typeof now === 'function' ? now : () => Date.now();
  const write = typeof emit === 'function' ? emit : () => {};

  function expire() {
    const cutoff = clock() - safeNumber(ttlMs);
    for (const [id, entry] of entries) {
      if (entry.acceptedAt < cutoff) entries.delete(id);
    }
  }

  function remember(id, metadata = {}) {
    if (!id) return;
    expire();
    entries.set(String(id), { acceptedAt: clock(), ...metadata });
    while (entries.size > maxSize) entries.delete(entries.keys().next().value);
  }

  function emitTransition(id, source, status) {
    expire();
    if (!id || !entries.has(String(id))) return false;
    const event = {
      stage: 'status_transition',
      message_id: String(id),
      transition_source: source,
    };
    // Baileys status is protocol-derived. Keep it numeric, never stringify
    // arbitrary update data into diagnostics.
    if (Number.isFinite(status)) event.baileys_status = safeNumber(status);
    write(event);
    return true;
  }

  function observeMessageUpdates(updates) {
    for (const update of (Array.isArray(updates) ? updates : [updates])) {
      if (Number.isFinite(update?.update?.status)) {
        emitTransition(messageIdFrom(update), 'messages.update', update.update.status);
      }
    }
  }

  function observeReceipts(receipts) {
    for (const receipt of (Array.isArray(receipts) ? receipts : [receipts])) {
      // A receipt event is itself an explicit observation. Do not infer
      // recipient delivery/read state from it, and do not include participant IDs.
      emitTransition(messageIdFrom(receipt), 'message-receipt.update');
    }
  }

  return { remember, observeMessageUpdates, observeReceipts, size: () => (expire(), entries.size) };
}
