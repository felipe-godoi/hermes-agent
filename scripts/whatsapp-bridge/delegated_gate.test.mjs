import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  evaluateDelegatedInbound,
  evaluateDelegatedDirectInbound,
  isDelegatedConversationActive,
} from './delegated_gate.js';

function withSessionDir(fn) {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-delegation-'));
  try {
    return fn(sessionDir);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

async function withSessionDirAsync(fn) {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-delegation-'));
  try {
    return await fn(sessionDir);
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

test('delegated exception emits only safe trace markers and forwards active contact', () => {
  withSessionDir((sessionDir) => {
    writeDelegations(sessionDir, {
      '19175395595': { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });
    const traces = [];
    const active = evaluateDelegatedInbound({
      senderId: '19175395595@s.whatsapp.net',
      sessionDir,
      messageId: 'safe-message-id',
      emit: trace => traces.push(trace),
    });

    assert.equal(active, true);
    assert.deepEqual(traces.map(trace => trace.stage), [
      'bridge_delegation_exception_received',
      'bridge_delegation_lookup',
    ]);
    assert.equal(traces[1].active, true);
    assert.equal(traces[1].action, 'forward');
    assert.equal(traces[0].contact, 'jid:…9595');
    assert.equal(JSON.stringify(traces).includes('19175395595'), false);
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

test('active delegated direct LID reply resolves through Baileys before the bridge gate', async () => {
  await withSessionDirAsync(async (sessionDir) => {
    const phone = '15550000001';
    const lid = '900000000000001@lid';
    writeDelegations(sessionDir, {
      [phone]: { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });

    const result = await evaluateDelegatedDirectInbound({
      senderId: lid,
      chatId: lid,
      sessionDir,
      resolveLidToPhone: async candidate => (
        candidate === lid ? `${phone}@s.whatsapp.net` : null
      ),
    });

    assert.deepEqual(result, {
      active: true,
      senderId: `${phone}@s.whatsapp.net`,
    });
  });
});

test('unresolved direct LID fails closed even when a delegation exists', async () => {
  await withSessionDirAsync(async (sessionDir) => {
    const lid = '900000000000001@lid';
    writeDelegations(sessionDir, {
      '15550000001': { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });

    const result = await evaluateDelegatedDirectInbound({
      senderId: lid,
      chatId: lid,
      sessionDir,
      resolveLidToPhone: async () => null,
    });

    assert.deepEqual(result, { active: false, senderId: lid });
  });
});

test('mapped direct LID without its own active delegation fails closed', async () => {
  await withSessionDirAsync(async (sessionDir) => {
    const phone = '15550000001';
    const lid = '900000000000001@lid';
    writeDelegations(sessionDir, {
      '15550000002': { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });

    const result = await evaluateDelegatedDirectInbound({
      senderId: lid,
      chatId: lid,
      sessionDir,
      resolveLidToPhone: async () => `${phone}@s.whatsapp.net`,
    });

    assert.deepEqual(result, { active: false, senderId: `${phone}@s.whatsapp.net` });
  });
});

test('a group LID participant cannot use the delegated direct-message exception', async () => {
  await withSessionDirAsync(async (sessionDir) => {
    const phone = '15550000001';
    const lid = '900000000000001@lid';
    writeDelegations(sessionDir, {
      [phone]: { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });

    const result = await evaluateDelegatedDirectInbound({
      senderId: lid,
      chatId: '120363000000000000@g.us',
      sessionDir,
      resolveLidToPhone: async () => `${phone}@s.whatsapp.net`,
    });

    assert.deepEqual(result, { active: false, senderId: lid });
  });
});

test('broadcast, newsletter, and status chats cannot use the delegated direct-message exception', async () => {
  await withSessionDirAsync(async (sessionDir) => {
    const lid = '900000000000001@lid';
    writeDelegations(sessionDir, {
      '15550000001': { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });

    for (const chatId of ['status@broadcast', '120363000000000000@newsletter', 'news@broadcast']) {
      let resolverCalled = false;
      const result = await evaluateDelegatedDirectInbound({
        senderId: lid,
        chatId,
        sessionDir,
        resolveLidToPhone: async () => {
          resolverCalled = true;
          return '15550000001@s.whatsapp.net';
        },
      });

      assert.deepEqual(result, { active: false, senderId: lid });
      assert.equal(resolverCalled, false);
    }
  });
});

test('malformed JSON file -> fails closed (not active)', () => {
  withSessionDir((sessionDir) => {
    writeFileSync(path.join(sessionDir, 'delegated-conversations.json'), '{not valid json');
    assert.equal(isDelegatedConversationActive('19175395595@s.whatsapp.net', sessionDir), false);
  });
});
