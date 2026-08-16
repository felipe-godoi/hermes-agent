import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { isDelegatedConversationActive } from './delegated_gate.js';

function withSessionDir(fn) {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-delegation-'));
  try {
    return fn(sessionDir);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

function writeDelegations(sessionDir, data) {
  writeFileSync(path.join(sessionDir, 'delegated-conversations.json'), JSON.stringify(data));
}

test('no delegation file at all -> not active', () => {
  withSessionDir((sessionDir) => {
    assert.equal(isDelegatedConversationActive('19175395595@s.whatsapp.net', sessionDir), false);
  });
});

test('unknown contact (not in the file) -> not active', () => {
  withSessionDir((sessionDir) => {
    writeDelegations(sessionDir, {
      '15551234567': { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });
    assert.equal(isDelegatedConversationActive('19175395595@s.whatsapp.net', sessionDir), false);
  });
});

test('active, unexpired delegation -> active', () => {
  withSessionDir((sessionDir) => {
    writeDelegations(sessionDir, {
      '19175395595': { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });
    assert.equal(isDelegatedConversationActive('19175395595@s.whatsapp.net', sessionDir), true);
  });
});

test('expired delegation -> not active', () => {
  withSessionDir((sessionDir) => {
    writeDelegations(sessionDir, {
      '19175395595': { status: 'ACTIVE', expires_at: Date.now() / 1000 - 60 },
    });
    assert.equal(isDelegatedConversationActive('19175395595@s.whatsapp.net', sessionDir), false);
  });
});

test('closed delegation -> not active even if TTL has not lapsed', () => {
  withSessionDir((sessionDir) => {
    writeDelegations(sessionDir, {
      '19175395595': { status: 'CLOSED', expires_at: Date.now() / 1000 + 3600 },
    });
    assert.equal(isDelegatedConversationActive('19175395595@s.whatsapp.net', sessionDir), false);
  });
});

test('resolves via lid-mapping aliases the same way matchesAllowedUser does', () => {
  withSessionDir((sessionDir) => {
    writeFileSync(path.join(sessionDir, 'lid-mapping-19175395595.json'), JSON.stringify('267383306489914'));
    writeFileSync(path.join(sessionDir, 'lid-mapping-267383306489914_reverse.json'), JSON.stringify('19175395595'));
    writeDelegations(sessionDir, {
      '19175395595': { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });
    // Bridge delivers the LID form; the grant was stored under the phone form.
    assert.equal(isDelegatedConversationActive('267383306489914@lid', sessionDir), true);
  });
});

test('malformed JSON file -> fails closed (not active)', () => {
  withSessionDir((sessionDir) => {
    writeFileSync(path.join(sessionDir, 'delegated-conversations.json'), '{not valid json');
    assert.equal(isDelegatedConversationActive('19175395595@s.whatsapp.net', sessionDir), false);
  });
});
