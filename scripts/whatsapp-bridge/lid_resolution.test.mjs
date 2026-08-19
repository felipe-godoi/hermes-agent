import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  isPhoneJid,
  readLocalLidMapping,
  resolveOutboundSendTarget,
  WhatsAppNotRegisteredError,
  writeLocalLidMapping,
} from './lid_resolution.js';

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
    assert.equal(group, '120363012345678901@g.us');

    const lid = await resolveOutboundSendTarget({ chatId: '267383306489914@lid', sock, sessionDir });
    assert.equal(lid, '267383306489914@lid');
  });
});

test('phone JID with no local mapping calls sock.onWhatsApp and sends to the returned LID', async () => {
  await withSessionDir(async (sessionDir) => {
    let calledWith = null;
    const sock = {
      signalRepository: {},
      onWhatsApp: async (jid) => {
        calledWith = jid;
        return [{ exists: true, jid, lid: '267383306489914@lid' }];
      },
    };

    const target = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
    });

    assert.equal(calledWith, '15551234567@s.whatsapp.net');
    assert.equal(target, '267383306489914@lid');
    // Learned mapping is persisted so future sends skip the usync lookup.
    assert.equal(readLocalLidMapping(sessionDir, '15551234567'), '267383306489914');
  });
});

test('existing local mapping file is used without calling onWhatsApp', async () => {
  await withSessionDir(async (sessionDir) => {
    writeFileSync(path.join(sessionDir, 'lid-mapping-15551234567.json'), JSON.stringify('267383306489914'));
    const sock = {
      signalRepository: {},
      onWhatsApp: () => { throw new Error('must not usync when a local mapping already exists'); },
    };

    const target = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
    });

    assert.equal(target, '267383306489914@lid');
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

    const target = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
    });

    assert.equal(target, '267383306489914@lid');
  });
});

test('contact without a LID falls back to the original phone JID', async () => {
  await withSessionDir(async (sessionDir) => {
    const sock = {
      signalRepository: {},
      onWhatsApp: async (jid) => [{ exists: true, jid }],
    };

    const target = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
    });

    assert.equal(target, '15551234567@s.whatsapp.net');
    assert.equal(readLocalLidMapping(sessionDir, '15551234567'), null);
  });
});

test('exists:false raises WhatsAppNotRegisteredError instead of sending', async () => {
  await withSessionDir(async (sessionDir) => {
    const sock = {
      signalRepository: {},
      onWhatsApp: async (jid) => [{ exists: false, jid }],
    };

    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15559999999@s.whatsapp.net', sock, sessionDir }),
      WhatsAppNotRegisteredError,
    );
  });
});

test('in-memory cache avoids a second usync for the same phone number', async () => {
  await withSessionDir(async (sessionDir) => {
    let calls = 0;
    const sock = {
      signalRepository: {},
      onWhatsApp: async (jid) => {
        calls += 1;
        return [{ exists: true, jid, lid: '267383306489914@lid' }];
      },
    };
    const cache = new Map();

    const first = await resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache });
    const second = await resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache });

    assert.equal(first, '267383306489914@lid');
    assert.equal(second, '267383306489914@lid');
    assert.equal(calls, 1, 'onWhatsApp should only be consulted once per session');
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
