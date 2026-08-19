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

// `sock.signalRepository.lidMapping.getLIDForPN()` (Baileys' own PN->LID
// path, backed by `pnFromLIDUSync`) is no longer consulted at all: verified
// against @whiskeysockets/baileys 7.0.0-rc13 source, it builds a
// `<user jid="...">` node whose only possible child - `USyncLIDProtocol`'s
// `<lid/>` - is gated on `user.lid` already being set, which is never true
// for a PN->LID lookup. That per-user node ships empty and the server
// returns nothing for it, which is why the previous getLIDForPN-based
// resolution reliably failed for every never-before-messaged contact,
// registered or not. The new strategy replaces it with a combined
// contact+lid `executeUSyncQuery` (same shape `onWhatsApp` already sends
// successfully) and, if that's registered but still lid-less, a raw usync
// IQ that forces a literal `<lid/>` child onto the `<user>` node.
const noWait = () => Promise.resolve();

async function withSessionDir(fn) {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-lid-resolution-'));
  try {
    return await fn(sessionDir);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

function mustNotUsync() {
  throw new Error('must not run a usync query for this case');
}

/** A `sock.executeUSyncQuery` mock that returns a fixed per-user entry
 * (`{ contact, lid }`) every time it's called. Pass an array to return a
 * different entry on each successive call (e.g. miss then hit, across the
 * post-usync retry). Records call count. */
function combinedQueryMock(entryOrEntries) {
  const entries = Array.isArray(entryOrEntries) ? entryOrEntries : null;
  let calls = 0;
  const fn = async (query) => {
    calls += 1;
    assert.ok(query.protocols.some(p => p.name === 'contact'), 'combined query must request the contact protocol');
    assert.ok(query.protocols.some(p => p.name === 'lid'), 'combined query must request the lid protocol');
    assert.equal(query.context, 'interactive', 'must use the default interactive context, never background');
    assert.equal(query.users.length, 1);
    const entry = entries ? entries[Math.min(calls, entries.length) - 1] : entryOrEntries;
    return { list: [{ id: query.users[0].id, ...entry }] };
  };
  fn.callCount = () => calls;
  return fn;
}

/** A `sock.query` mock for the raw-XML `<lid/>` fallback that returns a
 * fixed bare LID (or nothing) every time it's called. */
function rawQueryMock(bareLidOrNull) {
  let calls = 0;
  const fn = async (iq) => {
    calls += 1;
    assert.equal(iq.attrs.xmlns, 'usync');
    const usyncNode = iq.content[0];
    const listNode = usyncNode.content.find(n => n.tag === 'list');
    const userNode = listNode.content[0];
    assert.ok(userNode.content.some(n => n.tag === 'lid'), 'must force a literal <lid/> child onto the <user> node');
    if (!bareLidOrNull) return { attrs: {}, content: [{ tag: 'usync', attrs: {}, content: [] }] };
    return {
      attrs: {},
      content: [{
        tag: 'usync',
        attrs: {},
        content: [{
          tag: 'list',
          attrs: {},
          content: [{
            tag: 'user',
            attrs: { jid: userNode.attrs.jid },
            content: [{ tag: 'lid', attrs: { val: bareLidOrNull } }],
          }],
        }],
      }],
    };
  };
  fn.callCount = () => calls;
  return fn;
}

function generateMessageTagMock() {
  let n = 0;
  return () => `tag-${n++}`;
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
  const sock = { executeUSyncQuery: mustNotUsync, query: mustNotUsync };
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

test('existing local mapping file is authoritative: used without calling executeUSyncQuery or query', async () => {
  await withSessionDir(async (sessionDir) => {
    writeFileSync(path.join(sessionDir, 'lid-mapping-15551234567.json'), JSON.stringify('267383306489914'));
    const sock = { executeUSyncQuery: mustNotUsync, query: mustNotUsync };

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

test('a null in-memory cache entry is never used: does not short-circuit resolution', async () => {
  await withSessionDir(async (sessionDir) => {
    writeFileSync(path.join(sessionDir, 'lid-mapping-15551234567.json'), JSON.stringify('267383306489914'));
    const cache = new Map([['15551234567', null]]);
    const sock = { executeUSyncQuery: mustNotUsync, query: mustNotUsync };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
      cache,
    });

    // Falls through to the (authoritative) file, proving the null cache
    // entry was treated as a miss rather than a poisoned hit.
    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'file');
  });
});

test('combined usync query (contact+lid) resolves and persists the LID in one round trip', async () => {
  await withSessionDir(async (sessionDir) => {
    const executeUSyncQuery = combinedQueryMock({ contact: true, lid: '267383306489914' });
    const sock = { executeUSyncQuery, query: mustNotUsync };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
      wait: noWait,
    });

    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'usync-combined');
    assert.equal(result.lidResolved, true);
    assert.equal(executeUSyncQuery.callCount(), 1);
    assert.equal(readLocalLidMapping(sessionDir, '15551234567'), '267383306489914');
  });
});

test('combined query reporting exists:false raises WhatsAppNotRegisteredError, never falls back to the raw XML query', async () => {
  await withSessionDir(async (sessionDir) => {
    const executeUSyncQuery = combinedQueryMock({ contact: false });
    const sock = { executeUSyncQuery, query: mustNotUsync };

    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15559999999@s.whatsapp.net', sock, sessionDir, wait: noWait }),
      WhatsAppNotRegisteredError,
    );
    assert.equal(executeUSyncQuery.callCount(), 1);
  });
});

test('registered but lid-less combined result falls back to the raw XML <lid/> query, then persists', async () => {
  await withSessionDir(async (sessionDir) => {
    const executeUSyncQuery = combinedQueryMock({ contact: true });
    const query = rawQueryMock('267383306489914');
    const sock = { executeUSyncQuery, query, generateMessageTag: generateMessageTagMock() };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
      wait: noWait,
    });

    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'xml-lid');
    assert.equal(result.lidResolved, true);
    assert.equal(executeUSyncQuery.callCount(), 1);
    assert.equal(query.callCount(), 1);
    assert.equal(readLocalLidMapping(sessionDir, '15551234567'), '267383306489914');
  });
});

test('both sources empty on the first pass: waits ~1.5s then repeats combined+xml once, second pass succeeds', async () => {
  await withSessionDir(async (sessionDir) => {
    const executeUSyncQuery = combinedQueryMock([{ contact: true }, { contact: true, lid: '267383306489914' }]);
    const query = rawQueryMock(null);
    let waitedMs = null;
    const sock = { executeUSyncQuery, query, generateMessageTag: generateMessageTagMock() };

    const result = await resolveOutboundSendTarget({
      chatId: '15551234567@s.whatsapp.net',
      sock,
      sessionDir,
      wait: (ms) => { waitedMs = ms; return Promise.resolve(); },
    });

    assert.equal(waitedMs, 1500);
    assert.equal(result.target, '267383306489914@lid');
    assert.equal(result.source, 'usync-combined');
    assert.equal(executeUSyncQuery.callCount(), 2);
    // Second pass got its LID from the combined query, so the raw XML
    // fallback only ran on the first pass.
    assert.equal(query.callCount(), 1);
  });
});

test('registered but no LID from either source, even after the retry: LidUnavailableError, never falls back to the phone JID', async () => {
  await withSessionDir(async (sessionDir) => {
    const executeUSyncQuery = combinedQueryMock({ contact: true });
    const query = rawQueryMock(null);
    const sock = { executeUSyncQuery, query, generateMessageTag: generateMessageTagMock() };

    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, wait: noWait }),
      LidUnavailableError,
    );
    assert.equal(executeUSyncQuery.callCount(), 2);
    assert.equal(query.callCount(), 2);
    // Never persisted, and must never resolve to the raw phone JID.
    assert.equal(readLocalLidMapping(sessionDir, '15551234567'), null);
  });
});

test('in-memory cache avoids a second usync query for the same phone number', async () => {
  await withSessionDir(async (sessionDir) => {
    const executeUSyncQuery = combinedQueryMock({ contact: true, lid: '267383306489914' });
    const sock = { executeUSyncQuery, query: mustNotUsync };
    const cache = new Map();

    const first = await resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache, wait: noWait });
    const second = await resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache, wait: noWait });

    assert.equal(first.target, '267383306489914@lid');
    assert.equal(first.source, 'usync-combined');
    assert.equal(second.target, '267383306489914@lid');
    assert.equal(second.source, 'cache');
    assert.equal(executeUSyncQuery.callCount(), 1, 'the second resolution must be served entirely from cache');
  });
});

test('a failed resolution is never cached, so a retry re-runs the full lookup instead of being poisoned', async () => {
  await withSessionDir(async (sessionDir) => {
    const executeUSyncQuery = combinedQueryMock({ contact: true });
    const query = rawQueryMock(null);
    const sock = { executeUSyncQuery, query, generateMessageTag: generateMessageTagMock() };
    const cache = new Map();

    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache, wait: noWait }),
      LidUnavailableError,
    );
    assert.equal(cache.has('15551234567'), false, 'a failed resolution must not poison the cache');

    await assert.rejects(
      () => resolveOutboundSendTarget({ chatId: '15551234567@s.whatsapp.net', sock, sessionDir, cache, wait: noWait }),
      LidUnavailableError,
    );
    assert.equal(executeUSyncQuery.callCount(), 4, 'retry must re-run the full two-pass lookup instead of trusting a poisoned cache');
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
