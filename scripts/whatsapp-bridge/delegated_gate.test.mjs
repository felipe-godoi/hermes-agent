import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  emitDelegatedEnqueuedTrace,
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

function writePersistedAlias(sessionDir, lid, phone) {
  // Baileys rc13 stores the direct LID -> PN lookup under the reverse key:
  // keys.set({ 'lid-mapping': { '<lid>_reverse': '<pn>' } }) becomes this file.
  writeFileSync(
    path.join(sessionDir, `lid-mapping-${lid.split('@')[0]}_reverse.json`),
    JSON.stringify(phone),
  );
}

function assertDirectResolution(result, { active, senderId }) {
  assert.equal(result.active, active);
  assert.equal(result.senderId, senderId);
  assert.ok(result.diagnostic);
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

test('delegated exception retains the established trace events', () => {
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

test('direct-LID diagnostic truth table is identifier-free and does not change admission', async () => {
  const phone = '15550000001';
  const lid = '900000000000001@lid';
  const expectedKeys = [
    'active_delegation_alias_match', 'event', 'mapping_store_present',
    'outcome', 'persisted_alias_present', 'resolver_present', 'resolver_returned_value',
  ];
  const cases = [
    {
      name: 'mapping store absent',
      mappingStorePresent: false,
      resolveLidToPhone: undefined,
      expected: [false, false, false, false, false, 'dropped'],
    },
    {
      name: 'mapping store present with resolver absent',
      mappingStorePresent: true,
      resolveLidToPhone: undefined,
      expected: [true, false, false, false, false, 'dropped'],
    },
    {
      name: 'resolver returns null',
      mappingStorePresent: true,
      resolveLidToPhone: async () => null,
      expected: [true, true, false, false, false, 'dropped'],
    },
    {
      name: 'persisted alias exists without delegation',
      mappingStorePresent: true,
      resolveLidToPhone: async () => null,
      setup: (sessionDir) => writePersistedAlias(sessionDir, lid, phone),
      expected: [true, true, false, true, false, 'dropped'],
    },
    {
      name: 'persisted alias has expired delegation',
      mappingStorePresent: true,
      resolveLidToPhone: async () => null,
      setup: (sessionDir) => {
        writePersistedAlias(sessionDir, lid, phone);
        writeDelegations(sessionDir, {
          [phone]: { status: 'ACTIVE', expires_at: Date.now() / 1000 - 60 },
        });
      },
      expected: [true, true, false, true, false, 'dropped'],
    },
    {
      name: 'resolver mapping has active delegation',
      mappingStorePresent: true,
      resolveLidToPhone: async () => `${phone}@s.whatsapp.net`,
      setup: (sessionDir) => writeDelegations(sessionDir, {
        [phone]: { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
      }),
      expected: [true, true, true, false, true, 'forwarded'],
    },
  ];

  for (const scenario of cases) {
    await withSessionDirAsync(async (sessionDir) => {
      scenario.setup?.(sessionDir);
      const result = await evaluateDelegatedDirectInbound({
        senderId: lid,
        chatId: lid,
        sessionDir,
        mappingStorePresent: scenario.mappingStorePresent,
        resolveLidToPhone: scenario.resolveLidToPhone,
      });
      const diagnostic = result.diagnostic;
      assert.deepEqual(Object.keys(diagnostic).sort(), expectedKeys, scenario.name);
      assert.equal(diagnostic.event, 'whatsapp_delegated_direct_lid_diagnostic', scenario.name);
      assert.deepEqual([
        diagnostic.mapping_store_present, diagnostic.resolver_present,
        diagnostic.resolver_returned_value, diagnostic.persisted_alias_present,
        diagnostic.active_delegation_alias_match, diagnostic.outcome,
      ], scenario.expected, scenario.name);
      assert.equal(result.active, diagnostic.active_delegation_alias_match, scenario.name);
      const serialized = JSON.stringify(diagnostic);
      for (const sensitive of [phone, lid, 'delegated-conversations', sessionDir, 'messageId', 'Baileys']) {
        assert.equal(serialized.includes(sensitive), false, `${scenario.name}: ${sensitive}`);
      }
    });
  }
});

test('direct-LID delegated attempt emits only its identifier-free diagnostic trace', async () => {
  await withSessionDirAsync(async (sessionDir) => {
    const phone = '15550000001';
    const lid = '900000000000001@lid';
    writePersistedAlias(sessionDir, lid, phone);
    writeDelegations(sessionDir, {
      [phone]: { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });

    const resolution = await evaluateDelegatedDirectInbound({
      senderId: lid,
      chatId: lid,
      sessionDir,
      resolveLidToPhone: async () => null,
    });
    const traces = [resolution.diagnostic];
    const emit = trace => traces.push(trace);
    const emitLegacyTraces = !resolution.diagnostic;
    evaluateDelegatedInbound({
      senderId: resolution.senderId,
      sessionDir,
      messageId: 'raw-message-id',
      emit,
      emitLegacyTraces,
    });
    emitDelegatedEnqueuedTrace({
      senderId: resolution.senderId,
      messageId: 'raw-message-id',
      emit,
      emitLegacyTraces,
    });

    assert.equal(resolution.active, true);
    assert.deepEqual(traces.map(trace => trace.event), [
      'whatsapp_delegated_direct_lid_diagnostic',
    ]);
    const serialized = JSON.stringify(traces);
    for (const sensitive of [phone, lid, 'raw-message-id', 'contact', 'messageId', sessionDir]) {
      assert.equal(serialized.includes(sensitive), false, sensitive);
    }
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

    assertDirectResolution(result, {
      active: true,
      senderId: `${phone}@s.whatsapp.net`,
    });
  });
});

test('unresolved direct LID uses persisted aliases for an active phone delegation', async () => {
  await withSessionDirAsync(async (sessionDir) => {
    const phone = '15550000001';
    const lid = '900000000000001@lid';
    writeFileSync(path.join(sessionDir, `lid-mapping-${phone}.json`), JSON.stringify(lid.split('@')[0]));
    writeFileSync(path.join(sessionDir, `lid-mapping-${lid.split('@')[0]}_reverse.json`), JSON.stringify(phone));
    writeDelegations(sessionDir, {
      [phone]: { status: 'ACTIVE', expires_at: Date.now() / 1000 + 3600 },
    });

    const result = await evaluateDelegatedDirectInbound({
      senderId: lid,
      chatId: lid,
      sessionDir,
      resolveLidToPhone: async () => null,
    });

    assertDirectResolution(result, { active: true, senderId: lid });
  });
});

test('unresolved unmapped direct LID fails closed', async () => {
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

    assertDirectResolution(result, { active: false, senderId: lid });
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

    assertDirectResolution(result, { active: false, senderId: `${phone}@s.whatsapp.net` });
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
