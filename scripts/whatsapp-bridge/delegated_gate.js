import path from 'path';
import { existsSync, readFileSync } from 'fs';

import { expandWhatsAppIdentifiers, normalizeWhatsAppIdentifier } from './allowlist.js';

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
  if (!existsSync(filePath)) return false;

  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object') {
    return false;
  }

  for (const alias of expandWhatsAppIdentifiers(senderId, sessionDir)) {
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

/**
 * Whether the persisted multi-file alias state relates this identifier to a
 * different alias. This reuses the allowlist's read-only mapping traversal;
 * callers receive only a boolean, never a path or identifier.
 */
export function hasPersistedWhatsAppAlias(identifier, sessionDir) {
  const normalized = normalizeWhatsAppIdentifier(identifier);
  if (!normalized) return false;
  return [...expandWhatsAppIdentifiers(identifier, sessionDir)]
    .some((alias) => alias !== normalized);
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
 * mapping. When that best-effort lookup is absent, the active-delegation
 * check can use the same persisted aliases as the Python boundary. We fail
 * closed for every other chat shape and resolver result.
 *
 * The returned senderId is the canonical PN JID when available. For an
 * admitted persisted LID alias it remains the original LID, preserving the
 * reply route while the downstream identity boundary resolves that alias.
 */
export async function evaluateDelegatedDirectInbound({
  senderId,
  chatId,
  sessionDir,
  resolveLidToPhone,
  mappingStorePresent = false,
  now,
}) {
  const originalSenderId = String(senderId || '').trim();
  if (!isDirectWhatsAppChat(chatId)) {
    return { active: false, senderId: originalSenderId };
  }

  let resolvedSenderId = canonicalPhoneJid(originalSenderId);
  const isDirectLid = originalSenderId.endsWith('@lid');
  const resolverPresent = typeof resolveLidToPhone === 'function';
  if (originalSenderId.endsWith('@lid')) {
    try {
      resolvedSenderId = canonicalPhoneJid(await resolveLidToPhone?.(originalSenderId));
    } catch {
      // Baileys mapping state is unavailable or has no reverse mapping. Do
      // not turn an identity-resolution failure into an admission.
    }
  }
  const delegatedSenderId = resolvedSenderId || originalSenderId;
  // Preserve the pre-diagnostic resolver/fallback admission semantics: use
  // the resolver's canonical PN when it returned one; otherwise use the
  // original LID and its persisted aliases.
  const active = isDelegatedConversationActive(delegatedSenderId, sessionDir, now);
  return {
    active,
    senderId: delegatedSenderId,
    ...(isDirectLid ? {
      diagnostic: {
        event: 'whatsapp_delegated_direct_lid_diagnostic',
        mapping_store_present: Boolean(mappingStorePresent),
        resolver_present: resolverPresent,
        resolver_returned_value: Boolean(resolvedSenderId),
        persisted_alias_present: hasPersistedWhatsAppAlias(originalSenderId, sessionDir),
        active_delegation_alias_match: active,
        outcome: active ? 'forwarded' : 'dropped',
      },
    } : {}),
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
 * Emit the established delegated-contact trace pair. This remains separate
 * from the direct-LID diagnostic, whose schema intentionally has no IDs.
 */
export function evaluateDelegatedInbound({
  senderId,
  sessionDir,
  messageId,
  emit = () => {},
  now,
  emitLegacyTraces = true,
}) {
  const active = isDelegatedConversationActive(senderId, sessionDir, now);
  // A direct-LID attempt has one intentionally identifier-free diagnostic.
  // Do not add the older contact/message trace pair to that same attempt.
  if (!emitLegacyTraces) return active;

  const contact = delegatedContactTag(senderId);
  const trace = (stage, extra = {}) => emit({
    event: 'whatsapp-delegation-trace',
    stage,
    contact,
    ...(messageId ? { messageId: String(messageId) } : {}),
    ...extra,
  });

  trace('bridge_delegation_exception_received');
  trace('bridge_delegation_lookup', {
    active,
    action: active ? 'forward' : 'drop',
  });
  return active;
}

/** Emit the legacy enqueue trace unless this is a direct-LID attempt. */
export function emitDelegatedEnqueuedTrace({
  senderId,
  messageId,
  emit = () => {},
  emitLegacyTraces = true,
}) {
  if (!emitLegacyTraces) return;
  emit({
    event: 'whatsapp-delegation-trace',
    stage: 'bridge_delegation_enqueued',
    contact: delegatedContactTag(senderId),
    ...(messageId ? { messageId: String(messageId) } : {}),
    action: 'forwarded',
  });
}
