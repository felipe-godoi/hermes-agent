import path from 'path';
import { existsSync, readFileSync } from 'fs';

import { expandWhatsAppIdentifiers } from './allowlist.js';

/**
 * Pure check: does an active, unexpired delegated-conversation grant cover
 * `senderId`?
 *
 * Reads the SAME `delegated-conversations.json` file the Python
 * `whatsapp_delegation` plugin writes (see
 * `plugins/whatsapp_delegation/store.py`) into the bridge's session
 * directory. Python is the sole writer; this is read-only, dynamic (no
 * bridge restart needed), and mirrors exactly how `matchesAllowedUser`
 * already reads `lid-mapping-*.json` from the same directory.
 *
 * Deliberately independent of `matchesAllowedUser` / `WHATSAPP_ALLOWED_USERS`
 * -- this never touches or widens the allowlist. It is a second, narrower
 * gate OR'd into the drop condition in `bridge.js`, so a delegated grant
 * admits exactly one contact for exactly the TTL window it was granted,
 * nothing else.
 */
export function isDelegatedConversationActive(senderId, sessionDir, now = Date.now() / 1000) {
  const filePath = path.join(sessionDir, 'delegated-conversations.json');
  if (!existsSync(filePath)) {
    return false;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object') {
    return false;
  }

  const aliases = expandWhatsAppIdentifiers(senderId, sessionDir);
  for (const alias of aliases) {
    const record = data[alias];
    if (
      record &&
      record.status === 'ACTIVE' &&
      typeof record.expires_at === 'number' &&
      record.expires_at > now
    ) {
      return true;
    }
  }
  return false;
}

function isDirectWhatsAppChat(chatId) {
  const [userPart = '', domainPart = ''] = String(chatId || '').trim().split('@', 2);
  return Boolean(userPart) && (domainPart === 's.whatsapp.net' || domainPart === 'lid');
}

function canonicalPhoneJid(value) {
  const match = String(value || '').trim().match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  return match ? `${match[1]}@s.whatsapp.net` : '';
}

/**
 * Resolve the narrow delegated-DM exception before the bridge's ordinary
 * allowlist drop. Baileys owns the LID↔PN mapping: `getPNForLID` reads its
 * authenticated key state and returns null when it has no verified reverse
 * mapping. We fail closed for every other chat shape and resolver result.
 *
 * The returned senderId is deliberately the canonical PN JID while callers
 * retain the original chatId. This lets the adapter's intake/delegation path
 * associate the message with the phone-keyed grant without changing the
 * Baileys reply route for the LID chat.
 */
export async function evaluateDelegatedDirectInbound({
  senderId,
  chatId,
  sessionDir,
  resolveLidToPhone,
  now,
}) {
  const originalSenderId = String(senderId || '').trim();
  if (!isDirectWhatsAppChat(chatId)) {
    return { active: false, senderId: originalSenderId };
  }

  let resolvedSenderId = canonicalPhoneJid(originalSenderId);
  if (originalSenderId.endsWith('@lid')) {
    try {
      resolvedSenderId = canonicalPhoneJid(await resolveLidToPhone?.(originalSenderId));
    } catch {
      // Baileys mapping state is unavailable or has no reverse mapping. Do
      // not turn an identity-resolution failure into an admission.
    }
  }
  if (!resolvedSenderId) {
    return { active: false, senderId: originalSenderId };
  }

  return {
    active: isDelegatedConversationActive(resolvedSenderId, sessionDir, now),
    senderId: resolvedSenderId,
  };
}

/**
 * Safe, stable identifier for delegation diagnostics.  Do not use this for
 * routing: it intentionally retains only the final four digits and JID kind.
 */
export function delegatedContactTag(senderId) {
  const raw = String(senderId || '').trim();
  const [userPart = '', domainPart = ''] = raw.split('@', 2);
  const digits = userPart.replace(/\D/g, '');
  const suffix = digits ? digits.slice(-4) : userPart.slice(-4);
  const kind = domainPart === 'lid' ? 'lid' : domainPart ? 'jid' : 'unknown';
  return `${kind}:…${suffix || 'unknown'}`;
}

/**
 * Evaluate the narrow delegated-contact exception and emit only safe trace
 * fields. Kept pure so the bridge policy and its observability stay testable
 * without loading the Baileys socket.
 */
export function evaluateDelegatedInbound({ senderId, sessionDir, messageId, emit = () => {}, now }) {
  const contact = delegatedContactTag(senderId);
  const trace = (stage, extra = {}) => emit({
    event: 'whatsapp-delegation-trace',
    stage,
    contact,
    ...(messageId ? { messageId: String(messageId) } : {}),
    ...extra,
  });

  trace('bridge_delegation_exception_received');
  const active = isDelegatedConversationActive(senderId, sessionDir, now);
  trace('bridge_delegation_lookup', {
    active,
    action: active ? 'forward' : 'drop',
  });
  return active;
}
