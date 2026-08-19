import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  isPhoneJid,
  LidUnavailableError,
  readLocalLidMapping,
  resolveOutboundSendTarget,
  WhatsAppNotRegisteredError,
  writeLocalLidMapping,
} from './lid_resolution.js';

// Baileys 7.0.0-rc13's onWhatsApp() only ever returns `{ jid, exists }` - it
// never includes a `lid` field (verified against the library source: `return
// results.list.filter(a => !!a.contact).map(({ contact, id }) => ({ jid: id,
// exists: contact }))`). All mocks below reflect that real shape; none of
// them ever include a `lid` property on the onWhatsApp result.
const noWait = () => Promise.resolve();

async function withSessionDir(fn) {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-lid-resolution-'));
  try {
    return await fn(sessionDir);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

test('isPhoneJid only matches @s.whatsapp.net targets', () => {
  assert.equal(isPhoneJid('15551234567@s.whatsapp.net'), true);
  assert.equal(isPhoneJid('15551234567:12@s.whatsapp.net'), true);
  assert.equal(isPhoneJid('267383306489914@lid'), false);
  assert.equal(isPhoneJid('120363012345678901@g.us'), false);
  assert.equal(isPhoneJid('status@broadcast'), false);
  assert.equal(isPhoneJid(''), false);
});

test('group and LID targets pass through unchanged, no sock calls', async () => {
  const sock = {
    onWhatsApp: () => { throw new Error('must not usync a non-phone target'); },
    signalRepository: { lidMapping: { getLIDForPN: () => { throw new Error('must not consult lidMapping'); } } },
  };
  await withSessionDir(async (sessionDir) => {
    const group = await resolveOutboundSendTarget({ chatId: '120363012345678901@g.us', sock, sessionDir });
    assert.equal(group.target, '120363012345678901@g.us');
    assert.equal(group.source, 'passthrough');
    assert.equal(group.lidResolved, false);

    const lid = await resolveOutboundSendTarget({ chatId: '267383306489914@lid', sock, sessionDir });
    assert.equal(lid.target, '267383306489914@lid');
    assert.equal(lid.source, 'passthrough');
    assert.equal(lid.lidResolved, true);
  });
});

test('phone JID resolved via sock.signalRepository.lidMapping.getLIDForPN (no usync needed)', async () => {
  await withSessionDir(async (sessionDir) => {
    const sock = {
      signalRepository: {
        lidMapping: { getLIDForPN: async () => '267383306489914@lid' },
      },
      onWhatsApp: () => { throw new Error('must not usync when Baileys already has the mapping'); },
    };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
    });

    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'signal-repo');
    assert.equal(result.lidResolved, true);
  });
});

test('existing local mapping file is used without calling onWhatsApp', async () => {
  await withSessionDir(async (sessionDir) => {
    writeFileSync(path.join(sessionDir, 'lid-mapping-15551234567.json'), JSON.stringify('267383306489914'));
    const sock = {
      signalRepository: {},
      onWhatsApp: () => { throw new Error('must not usync when a local mapping already exists'); },
    };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
    });

    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'file');
    assert.equal(result.lidResolved, true);
  });
});

test('sock.signalRepository.lidMapping.getLIDForPN is preferred over the local file', async () => {
  await withSessionDir(async (sessionDir) => {
    writeFileSync(path.join(sessionDir, 'lid-mapping-15551234567.json'), JSON.stringify('999999999999999'));
    const sock = {
      signalRepository: {
        lidMapping: { getLIDForPN: async () => '267383306489914@lid' },
      },
      onWhatsApp: () => { throw new Error('must not usync when Baileys already has the mapping'); },
    };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
    });

    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'signal-repo');
  });
});

test('exists:false raises WhatsAppNotRegisteredError instead of sending', async () => {
  await withSessionDir(async (sessionDir) => {
    const sock = {
      signalRepository: {},
      // Real onWhatsApp shape: only { jid, exists }, never a `lid` field.
      onWhatsApp: async (jid) => [{ exists: false, jid }],
    };

    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15559999999@s.whatsapp.net', sock, sessionDir, wait: noWait }),
      WhatsAppNotRegisteredError,
    );
  });
});

test('exists:true with LID mapping unavailable even after the post-usync retry throws LidUnavailableError, never falls back to the phone JID', async () => {
  await withSessionDir(async (sessionDir) => {
    let usyncCalls = 0;
    const sock = {
      signalRepository: {
        // Real onWhatsApp shape: no `lid` field, and the mapping never
        // becomes available even after the usync provisioning retry.
        lidMapping: { getLIDForPN: async () => null },
      },
      onWhatsApp: async (jid) => {
        usyncCalls += 1;
        return [{ exists: true, jid }];
      },
    };

    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, wait: noWait }),
      LidUnavailableError,
    );
    assert.equal(usyncCalls, 1);
    // Never persisted, and must never resolve to the raw phone JID.
    assert.equal(readLocalLidMapping(sessionDir, '15551234567'), null);
  });
});

test('exists:true then LID becomes available on the post-usync retry via signal-repo (source lid-usync)', async () => {
  await withSessionDir(async (sessionDir) => {
    let getLIDForPNCalls = 0;
    const sock = {
      signalRepository: {
        lidMapping: {
          getLIDForPN: async () => {
            getLIDForPNCalls += 1;
            // First consultation (pre-usync) misses; the retry after usync
            // provisioning succeeds.
            return getLIDForPNCalls < 2 ? null : '267383306489914@lid';
          },
        },
      },
      // Real onWhatsApp shape: confirms registration only, no `lid` field.
      onWhatsApp: async (jid) => [{ exists: true, jid }],
    };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
      wait: noWait,
    });

    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'lid-usync');
    assert.equal(result.lidResolved, true);
    assert.equal(getLIDForPNCalls, 2);
    // Learned mapping is persisted so future sends skip the usync lookup.
    assert.equal(readLocalLidMapping(sessionDir, '15551234567'), '267383306489914');
  });
});

test('exists:true then LID becomes available on the post-usync retry via the local file (source contact-usync)', async () => {
  await withSessionDir(async (sessionDir) => {
    const sock = {
      signalRepository: {},
      onWhatsApp: async (jid) => {
        // Simulate Baileys' own auth-state key store learning the mapping as
        // a side effect of the first usync call, before our retry reads it.
        writeFileSync(path.join(sessionDir, 'lid-mapping-15551234567.json'), JSON.stringify('267383306489914'));
        return [{ exists: true, jid }];
      },
    };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
      wait: noWait,
    });

    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'contact-usync');
    assert.equal(result.lidResolved, true);
  });
});

test('waits ~1.5s after a successful usync before re-consulting LID sources', async () => {
  await withSessionDir(async (sessionDir) => {
    let waitedMs = null;
    let getLIDForPNCalls = 0;
    const sock = {
      signalRepository: {
        lidMapping: {
          getLIDForPN: async () => {
            getLIDForPNCalls += 1;
            return getLIDForPNCalls < 2 ? null : '267383306489914@lid';
          },
        },
      },
      onWhatsApp: async (jid) => [{ exists: true, jid }],
    };

    await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
      wait: (ms) => { waitedMs = ms; return Promise.resolve(); },
    });

    assert.equal(waitedMs, 1500);
  });
});

test('in-memory cache avoids a second usync for the same phone number', async () => {
  await withSessionDir(async (sessionDir) => {
    let calls = 0;
    const sock = {
      signalRepository: {
        lidMapping: { getLIDForPN: async () => '267383306489914@lid' },
      },
      onWhatsApp: async (jid) => {
        calls += 1;
        return [{ exists: true, jid }];
      },
    };
    const cache = new Map();

    const first = await resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache });
    const second = await resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache });

    assert.equal(first.target, '267383306489914@lid');
    assert.equal(first.source, 'signal-repo');
    assert.equal(second.target, '267383306489914@lid');
    assert.equal(second.source, 'cache');
    assert.equal(calls, 0, 'onWhatsApp should never be consulted when signal-repo already has the mapping');
  });
});

test('a null resolution is never cached, so a retry re-runs the full lookup instead of being poisoned', async () => {
  await withSessionDir(async (sessionDir) => {
    let getLIDForPNCalls = 0;
    let usyncCalls = 0;
    const cache = new Map();
    const sock = {
      signalRepository: {
        lidMapping: {
          getLIDForPN: async () => {
            getLIDForPNCalls += 1;
            return null;
          },
        },
      },
      onWhatsApp: async (jid) => {
        usyncCalls += 1;
        return [{ exists: true, jid }];
      },
    };

    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache, wait: noWait }),
      LidUnavailableError,
    );
    assert.equal(cache.has('15551234567'), false, 'a failed resolution must not poison the cache');

    // Retry: must not short-circuit on a cached null, and must re-run the
    // full lookup (including a second usync) rather than skipping straight
    // to the phone JID.
    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache, wait: noWait }),
      LidUnavailableError,
    );
    assert.equal(usyncCalls, 2, 'retry must re-run the usync lookup instead of trusting a poisoned cache');
    assert.ok(getLIDForPNCalls >= 4, 'retry must re-consult signal-repo rather than short-circuiting on a null cache entry');
  });
});

test('a manually poisoned cache entry (null) is treated as a miss, not a hit', async () => {
  await withSessionDir(async (sessionDir) => {
    const cache = new Map([['15551234567', null]]);
    const sock = {
      signalRepository: {
        lidMapping: { getLIDForPN: async () => '267383306489914@lid' },
      },
      onWhatsApp: () => { throw new Error('must not usync when signal-repo has the mapping'); },
    };

    const result = await resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache });

    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'signal-repo');
  });
});

test('writeLocalLidMapping/readLocalLidMapping round-trip matches buildLidMap format', () => {
  withSessionDir((sessionDir) => {
    writeLocalLidMapping(sessionDir, '15551234567', '267383306489914@lid');
    const raw = JSON.parse(readFileSync(path.join(sessionDir, 'lid-mapping-15551234567.json'), 'utf8'));
    assert.equal(raw, '267383306489914');
    assert.equal(readLocalLidMapping(sessionDir, '15551234567'), '267383306489914');
  });
});
