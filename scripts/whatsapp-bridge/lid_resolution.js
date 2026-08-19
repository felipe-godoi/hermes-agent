import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

import { normalizeWhatsAppIdentifier } from './allowlist.js';

/**
 * Outbound sends to a phone JID (`@s.whatsapp.net`) whose PN<->LID session
 * was never established get accepted locally by Baileys and then rejected
 * by the WhatsApp server (baileys_status 0 / ERROR observed on
 * `messages.update`, after `baileys_accepted`). Groups, LIDs, and other
 * non-phone targets already have an established session and must pass
 * through unresolved.
 */
export function isPhoneJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

export class WhatsAppNotRegisteredError extends Error {
  constructor(jid) {
    super('This number is not registered on WhatsApp.');
    this.name = 'WhatsAppNotRegisteredError';
    this.jid = jid;
  }
}

/**
 * Thrown when a phone number is confirmed registered on WhatsApp but no
 * PN<->LID mapping could be obtained by any of the available paths. Sending
 * to the raw phone JID in this state is known to be accepted locally by
 * Baileys and then rejected server-side (baileys_status 0), so the caller
 * must surface this instead of silently falling back.
 */
export class LidUnavailableError extends Error {
  constructor(jid) {
    super('This number is registered on WhatsApp but its LID mapping is unavailable right now.');
    this.name = 'LidUnavailableError';
    this.jid = jid;
  }
}

const POST_USYNC_RETRY_MS = 1500;

function lidMappingPath(sessionDir, phone) {
  return path.join(sessionDir, `lid-mapping-${phone}.json`);
}

/** Read the locally persisted PN->LID mapping, matching the format Baileys'
 * own multi-file auth state (and `buildLidMap`) already read/write:
 * `lid-mapping-<phone>.json` containing the bare LID as a JSON string. */
export function readLocalLidMapping(sessionDir, phone) {
  const filePath = lidMappingPath(sessionDir, phone);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return normalizeWhatsAppIdentifier(parsed) || null;
  } catch {
    return null;
  }
}

/** Best-effort cache write so a future send skips the usync lookup. Baileys
 * itself may already persist this via the auth-state key store once it
 * learns the mapping internally; this is a redundant safety net. */
export function writeLocalLidMapping(sessionDir, phone, lid) {
  const bareLid = normalizeWhatsAppIdentifier(lid);
  if (!bareLid) return;
  try {
    writeFileSync(lidMappingPath(sessionDir, phone), JSON.stringify(bareLid));
  } catch {
    // Non-fatal: worst case, the next send re-runs the usync lookup.
  }
}

function toLidJid(bareLid) {
  return bareLid ? `${bareLid}@lid` : null;
}

async function consultLidMapping(sock, chatId) {
  const lidMapping = sock?.signalRepository?.lidMapping;
  if (typeof lidMapping?.getLIDForPN !== 'function') return null;
  try {
    return normalizeWhatsAppIdentifier(await lidMapping.getLIDForPN(chatId)) || null;
  } catch {
    return null;
  }
}

function defaultWait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve the actual Baileys send target for an outbound message.
 *
 * - Non-phone-JID targets (group, LID, broadcast, ...) pass through
 *   unchanged.
 * - Phone JIDs are resolved PN->LID through, in order:
 *     1. `cache`      - in-memory cache from a prior resolution this session.
 *     2. `signal-repo`- `sock.signalRepository.lidMapping.getLIDForPN()`.
 *     3. `file`       - the locally persisted `lid-mapping-<phone>.json`.
 *     4. a `sock.onWhatsApp()` usync call to confirm the number is even
 *        registered. Baileys 7.0.0-rc13's `onWhatsApp()` only ever returns
 *        `{ jid, exists }` - it never includes a `lid` field, so this step
 *        cannot resolve the LID by itself. When `exists` is false, throws
 *        `WhatsAppNotRegisteredError`.
 *     5. If it exists, the first usync for a new contact typically
 *        provisions the PN<->LID mapping on the server asynchronously. Wait
 *        ~1.5s and re-consult `signal-repo` (source `lid-usync`) then `file`
 *        (source `contact-usync`).
 * - Only non-null LIDs are cached; a resolution that ends without a LID is
 *   never cached, so the next attempt (e.g. a retry) re-runs the full
 *   lookup instead of being poisoned by a stale miss.
 * - Never falls back to sending to the raw phone JID once a number is known
 *   to be registered: that has been observed to be accepted locally by
 *   Baileys and then rejected by the WhatsApp server. If no LID can be
 *   found after the retry, throws `LidUnavailableError` instead.
 *
 * Returns `{ target, source, lidResolved }` where `source` is one of
 * `passthrough | cache | signal-repo | file | lid-usync | contact-usync`.
 */
export async function resolveOutboundSendTarget({
  chatId,
  sock,
  sessionDir,
  cache,
  onWhatsApp,
  wait,
} = {}) {
  if (!isPhoneJid(chatId)) {
    return { target: chatId, source: 'passthrough', lidResolved: typeof chatId === 'string' && chatId.endsWith('@lid') };
  }

  const phone = normalizeWhatsAppIdentifier(chatId);
  if (!phone) {
    return { target: chatId, source: 'passthrough', lidResolved: false };
  }

  if (cache?.has(phone) && cache.get(phone)) {
    return { target: toLidJid(cache.get(phone)), source: 'cache', lidResolved: true };
  }

  let bareLid = await consultLidMapping(sock, chatId);
  let source = bareLid ? 'signal-repo' : null;

  if (!bareLid) {
    bareLid = readLocalLidMapping(sessionDir, phone);
    if (bareLid) source = 'file';
  }

  if (!bareLid) {
    const lookup = typeof onWhatsApp === 'function' ? onWhatsApp : sock?.onWhatsApp?.bind(sock);
    if (typeof lookup !== 'function') {
      return { target: chatId, source: 'passthrough', lidResolved: false };
    }
    const results = await lookup(chatId);
    const result = Array.isArray(results) ? results[0] : results;
    if (!result?.exists) {
      throw new WhatsAppNotRegisteredError(chatId);
    }

    const sleep = typeof wait === 'function' ? wait : defaultWait;
    await sleep(POST_USYNC_RETRY_MS);

    bareLid = await consultLidMapping(sock, chatId);
    if (bareLid) {
      source = 'lid-usync';
    } else {
      bareLid = readLocalLidMapping(sessionDir, phone);
      if (bareLid) source = 'contact-usync';
    }

    if (bareLid) {
      writeLocalLidMapping(sessionDir, phone, bareLid);
    }
  }

  if (!bareLid) {
    throw new LidUnavailableError(chatId);
  }

  cache?.set(phone, bareLid);
  return { target: toLidJid(bareLid), source, lidResolved: true };
}
