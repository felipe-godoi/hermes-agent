import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIngressTraceEvents } from './ingress_trace.js';

test('traces a non-owner direct history upsert before a null message is dropped', () => {
  const phone = '15551234567';
  const body = 'private message body must not be logged';
  const traces = buildIngressTraceEvents({
    type: 'history',
    messages: [{
      key: {
        id: 'history-null-message',
        remoteJid: `${phone}@s.whatsapp.net`,
        fromMe: false,
      },
      message: null,
      pushName: 'Sensitive sender name',
      body,
    }],
  });

  assert.deepEqual(traces, [{
    event: 'whatsapp-ingress-trace',
    stage: 'baileys_messages_upsert',
    messageId: 'history-null-message',
    contact: 'jid:…4567',
    upsertType: 'history',
    batchSize: 1,
    hasMessage: false,
    messageKeys: [],
  }]);
  const output = JSON.stringify(traces);
  assert.equal(output.includes(phone), false);
  assert.equal(output.includes(body), false);
});

test('does not trace owner, group, broadcast, newsletter, or status messages', () => {
  const traces = buildIngressTraceEvents({
    type: 'notify',
    messages: [
      { key: { id: 'owner', remoteJid: '15551234567@s.whatsapp.net', fromMe: true }, message: {} },
      { key: { id: 'group', remoteJid: '120363001234567890@g.us', fromMe: false }, message: {} },
      { key: { id: 'broadcast', remoteJid: '12345@broadcast', fromMe: false }, message: {} },
      { key: { id: 'newsletter', remoteJid: '12345@newsletter', fromMe: false }, message: {} },
      { key: { id: 'status', remoteJid: 'status@broadcast', fromMe: false }, message: {} },
    ],
  });

  assert.deepEqual(traces, []);
});
