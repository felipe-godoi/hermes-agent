import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { USyncQuery, USyncUser, getBinaryNodeChild } from '@whiskeysockets/baileys';

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

// Matches Baileys' own `S_WHATSAPP_NET` (WABinary/jid-utils.ts) used as the
// `to` attribute on every server-directed usync IQ.
const S_WHATSAPP_NET = '@s.whatsapp.net';

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
 * Combined contact+lid USync query for a single phone JID, via
 * `sock.executeUSyncQuery`.
 *
 * Baileys' own PN->LID path (`signalRepository.lidMapping.getLIDForPN`,
 * backed by `pnFromLIDUSync`) builds a LID-only query with
 * `withContext('background')` and a user built via `new
 * USyncUser().withId(jid)`. `USyncLIDProtocol.getUserElement()` only emits a
 * `<lid/>` child for that user when `user.lid` is *already* set - which is
 * never true for a PN->LID lookup - so the `<user jid="...">` node Baileys
 * sends ships with no children at all, and the server has nothing to
 * identify the request by beyond the bare jid attribute. That is why
 * `getLIDForPN` reliably returns null for every never-before-messaged
 * contact, registered or not (confirmed against @whiskeysockets/baileys
 * 7.0.0-rc13 source).
 *
 * Requesting the contact protocol alongside gives the same `<user>` node a
 * real (if attribute-empty) `<contact/>` child - the same shape `onWhatsApp`
 * already sends successfully - and the default "interactive" context
 * (never "background") matches it too. `res.list[0].contact` doubles as the
 * registration check, so this single round-trip replaces the old separate
 * `onWhatsApp()` existence call as well.
 *
 * Returns `null` when the query itself failed or returned no entry for this
 * user (unknown state - caller should keep trying other sources). Returns
 * `{ exists, lid }` once a real per-user entry came back.
 */
async function combinedUsyncQuery(sock, chatId) {
  if (typeof sock?.executeUSyncQuery !== 'function') return null;
  try {
    const query = new USyncQuery()
      .withContactProtocol()
      .withLIDProtocol()
      .withUser(new USyncUser().withId(chatId));
    const result = await sock.executeUSyncQuery(query);
    const entry = result?.list?.[0];
    if (!entry) return null;
    return {
      exists: entry.contact === true,
      lid: normalizeWhatsAppIdentifier(entry.lid) || null,
    };
  } catch {
    return null;
  }
}

/**
 * Last-resort raw usync IQ for a number `combinedUsyncQuery` already
 * confirmed registered but couldn't get a LID for (mapping not provisioned
 * server-side yet). Builds the same `<user jid="...">` node
 * `executeUSyncQuery` would, but forces a literal `<lid/>` child onto it
 * instead of relying on `USyncLIDProtocol.getUserElement()` - bypassing the
 * gate described in `combinedUsyncQuery` above directly, since there is no
 * public Baileys API to override that per-user element.
 */
async function rawLidQuery(sock, chatId) {
  if (typeof sock?.query !== 'function' || typeof sock?.generateMessageTag !== 'function') return null;
  try {
    const iq = {
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
      content: [{
        tag: 'usync',
        attrs: {
          context: 'interactive',
          mode: 'query',
          sid: sock.generateMessageTag(),
          last: 'true',
          index: '0',
        },
        content: [
          { tag: 'query', attrs: {}, content: [{ tag: 'lid', attrs: {} }] },
          { tag: 'list', attrs: {}, content: [{ tag: 'user', attrs: { jid: chatId }, content: [{ tag: 'lid', attrs: {} }] }] },
        ],
      }],
    };
    const result = await sock.query(iq);
    const usync = getBinaryNodeChild(result, 'usync');
    const list = usync ? getBinaryNodeChild(usync, 'list') : undefined;
    const user = list ? getBinaryNodeChild(list, 'user') : undefined;
    const lidNode = user ? getBinaryNodeChild(user, 'lid') : undefined;
    return normalizeWhatsAppIdentifier(lidNode?.attrs?.val) || null;
  } catch {
    return null;
  }
}

/** Runs the combined query, then (if registered but still no LID) the raw
 * XML fallback. Throws `WhatsAppNotRegisteredError` as soon as the combined
 * query explicitly reports the number isn't registered; otherwise returns
 * `{ lid, source } | {}` for the caller to decide whether to retry. */
async function attemptResolve(sock, chatId) {
  const combined = await combinedUsyncQuery(sock, chatId);
  if (combined) {
    if (!combined.exists) {
      throw new WhatsAppNotRegisteredError(chatId);
    }
    if (combined.lid) {
      return { lid: combined.lid, source: 'usync-combined' };
    }
  }

  const xmlLid = await rawLidQuery(sock, chatId);
  if (xmlLid) {
    return { lid: xmlLid, source: 'xml-lid' };
  }

  return {};
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
 *     1. `cache` - in-memory cache from a prior resolution this session.
 *     2. `file`  - the locally persisted `lid-mapping-<phone>.json`. A
 *        mapping learned in a previous run is treated as authoritative, so
 *        it's checked before any network round-trip.
 *     3. `usync-combined` - a single `sock.executeUSyncQuery` requesting
 *        both the contact and lid protocols for this jid. `exists` comes
 *        from the contact protocol result; when it's false, throws
 *        `WhatsAppNotRegisteredError` immediately. See `combinedUsyncQuery`
 *        for why this replaces `signalRepository.lidMapping.getLIDForPN`.
 *     4. `xml-lid` - if the number is registered but the combined query
 *        didn't carry a lid back (mapping not provisioned yet), a raw usync
 *        IQ that forces a `<lid/>` child onto the `<user>` node. See
 *        `rawLidQuery`.
 *     5. If still nothing, the first usync for a new contact typically
 *        provisions the PN<->LID mapping on the server asynchronously. Wait
 *        ~1.5s and repeat steps 3-4 once more.
 * - Only non-null LIDs are cached; a resolution that ends without a LID is
 *   never cached, so the next attempt (e.g. a retry) re-runs the full
 *   lookup instead of being poisoned by a stale miss.
 * - Never falls back to sending to the raw phone JID once a number is known
 *   to be registered: that has been observed to be accepted locally by
 *   Baileys and then rejected by the WhatsApp server. If no LID can be
 *   found after the retry, throws `LidUnavailableError` instead.
 *
 * Returns `{ target, source, lidResolved }` where `source` is one of
 * `passthrough | cache | file | usync-combined | xml-lid`.
 */
export async function resolveOutboundSendTarget({
  chatId,
  sock,
  sessionDir,
  cache,
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

  let bareLid = readLocalLidMapping(sessionDir, phone);
  let source = bareLid ? 'file' : null;

  if (!bareLid) {
    let attempt = await attemptResolve(sock, chatId);

    if (!attempt.lid) {
      const sleep = typeof wait === 'function' ? wait : defaultWait;
      await sleep(POST_USYNC_RETRY_MS);
      attempt = await attemptResolve(sock, chatId);
    }

    if (attempt.lid) {
      bareLid = attempt.lid;
      source = attempt.source;
      writeLocalLidMapping(sessionDir, phone, bareLid);
    }
  }

  if (!bareLid) {
    throw new LidUnavailableError(chatId);
  }

  cache?.set(phone, bareLid);
  return { target: toLidJid(bareLid), source, lidResolved: true };
}
