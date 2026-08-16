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
