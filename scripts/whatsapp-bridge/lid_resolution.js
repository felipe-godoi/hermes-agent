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

/**
 * Resolve the actual Baileys send target for an outbound message.
 *
 * - Non-phone-JID targets (group, LID, broadcast, ...) pass through
 *   unchanged.
 * - Phone JIDs are resolved PN->LID: first an in-memory cache, then the
 *   locally persisted mapping file, then (only if neither has it) a usync
 *   lookup via `sock.onWhatsApp()` that also establishes the session.
 * - Sends to the LID when the contact has one; otherwise falls back to the
 *   original phone JID.
 * - Throws `WhatsAppNotRegisteredError` when usync reports the number does
 *   not exist on WhatsApp, so the caller can answer with a clear 4xx instead
 *   of accepting the send and letting it fail silently later.
 */
export async function resolveOutboundSendTarget({
  chatId,
  sock,
  sessionDir,
  cache,
  onWhatsApp,
} = {}) {
  if (!isPhoneJid(chatId)) {
    return chatId;
  }

  const phone = normalizeWhatsAppIdentifier(chatId);
  if (!phone) return chatId;

  if (cache?.has(phone)) {
    return toLidJid(cache.get(phone)) || chatId;
  }

  const lidMapping = sock?.signalRepository?.lidMapping;
  let bareLid = null;
  if (typeof lidMapping?.getLIDForPN === 'function') {
    try {
      bareLid = normalizeWhatsAppIdentifier(await lidMapping.getLIDForPN(chatId)) || null;
    } catch {
      bareLid = null;
    }
  }
  if (!bareLid) {
    bareLid = readLocalLidMapping(sessionDir, phone);
  }

  if (!bareLid) {
    const lookup = typeof onWhatsApp === 'function' ? onWhatsApp : sock?.onWhatsApp?.bind(sock);
    if (typeof lookup !== 'function') {
      return chatId;
    }
    const results = await lookup(chatId);
    const result = Array.isArray(results) ? results[0] : results;
    if (!result?.exists) {
      throw new WhatsAppNotRegisteredError(chatId);
    }
    bareLid = normalizeWhatsAppIdentifier(result.lid) || null;
    if (bareLid) {
      writeLocalLidMapping(sessionDir, phone, bareLid);
    }
  }

  cache?.set(phone, bareLid);
  return toLidJid(bareLid) || chatId;
}
