/** Privacy-safe unit tests for the outbound trace tracker. */
import { strict as assert } from 'node:assert';
import { buildOutboundSendTrace, createOutboundTraceTracker, maskOutboundTarget } from './outbound_trace.js';

assert.equal(maskOutboundTarget('15551234567@s.whatsapp.net'), 'jid:…4567');
assert.equal(maskOutboundTarget('15551234567@g.us'), 'group:…4567');

const attempt = buildOutboundSendTrace('attempt', {
  target_tag: 'jid:…4567', message_id: 'msg-1', chunk_count: 2,
  queue_wait_ms: 4.9, elapsed_ms: 8.1, connection_state: 'connected',
  message: 'private body', remoteJid: '15551234567@s.whatsapp.net',
});
assert.deepStrictEqual(attempt, {
  stage: 'attempt', target_tag: 'jid:…4567', message_id: 'msg-1', chunk_count: 2,
  queue_wait_ms: 4, elapsed_ms: 8, connection_state: 'connected',
});

const failed = buildOutboundSendTrace('error', { target_tag: 'jid:…4567', error: 'secret raw error text from Baileys' });
assert.equal(JSON.stringify(failed).includes('secret raw error text from Baileys'), false, 'raw send errors are never traced');
assert.equal(failed.error, 'unknown_error', 'an unrecognized error value collapses to a safe placeholder, never passes through raw');

const lidUnavailableFailed = buildOutboundSendTrace('error', { target_tag: 'jid:…4567', error: 'LidUnavailableError' });
assert.equal(lidUnavailableFailed.error, 'LidUnavailableError', 'known-safe error class names (never .message/.stack) pass through');

const notRegisteredFailed = buildOutboundSendTrace('error', { target_tag: 'jid:…4567', error: 'WhatsAppNotRegisteredError' });
assert.equal(notRegisteredFailed.error, 'WhatsAppNotRegisteredError');

let clock = 1_000;
const events = [];
const tracker = createOutboundTraceTracker({
  maxSize: 2,
  ttlMs: 100,
  now: () => clock,
  emit: event => events.push(event),
});

const mockSend = async () => ({ key: { id: 'safe-message-id' } });
const sent = await mockSend();
tracker.remember(sent.key.id);
const accepted = buildOutboundSendTrace('baileys_accepted', {
  target_tag: 'jid:…4567', message_id: sent.key.id, chunk_count: 1,
  queue_wait_ms: 0, elapsed_ms: 2, connection_state: 'connected',
});
assert.equal(accepted.message_id, 'safe-message-id', 'mocked Baileys key is traced');
tracker.observeMessageUpdates([
  { key: { id: 'unrelated-id' }, update: { status: 3, remoteJid: '15551234567@s.whatsapp.net' } },
  { key: { id: 'safe-message-id' }, update: { status: 3, remoteJid: '15551234567@s.whatsapp.net' } },
]);
tracker.observeReceipts([
  { key: { id: 'safe-message-id', remoteJid: '15551234567@s.whatsapp.net' }, participant: '15550000000@s.whatsapp.net' },
]);

assert.deepStrictEqual(events, [
  {
    stage: 'status_transition',
    message_id: 'safe-message-id',
    transition_source: 'messages.update',
    baileys_status: 3,
  },
  {
    stage: 'status_transition',
    message_id: 'safe-message-id',
    transition_source: 'message-receipt.update',
  },
]);
assert.equal(JSON.stringify(events).includes('1555'), false, 'identity is never traced');

clock += 101;
tracker.observeMessageUpdates([{ key: { id: 'safe-message-id' }, update: { status: 2 } }]);
assert.equal(events.length, 2, 'expired message IDs are ignored');
console.log('  ✓ outbound trace transitions are bounded and sanitized');
