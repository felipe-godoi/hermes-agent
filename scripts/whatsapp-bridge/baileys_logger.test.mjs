import { strict as assert } from 'node:assert';
import { Writable } from 'node:stream';
import { buildOutboundSendTrace } from './outbound_trace.js';
import { createSilentBaileysLogger, emitSafeBridgeError, safeBridgeError } from './baileys_logger.js';

let output = '';
const destination = new Writable({
  write(chunk, _encoding, callback) {
    output += chunk;
    callback();
  },
});
const privateMaterial = 'PRIVATE_KEY_MUST_NOT_APPEAR';
const session = {
  state: { privateKey: privateMaterial, chainKey: 'CHAIN_KEY_MUST_NOT_APPEAR' },
  toJSON() { throw new Error('raw session serialization must never run'); },
};
const logger = createSilentBaileysLogger(destination);
for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
  logger[level]({ msg: 'Closing session', session });
}
assert.equal(output, '', 'Baileys logger never writes session objects at any level');

const unsafeError = { code: 'ECONNRESET', name: 'DependencyFailure', message: privateMaterial, session };
assert.deepEqual(safeBridgeError(unsafeError), {
  code: 'ECONNRESET', name: 'DependencyFailure', message: 'Bridge operation failed',
});
let errorOutput = '';
emitSafeBridgeError(line => { errorOutput = line; }, 'send', unsafeError);
assert.equal(errorOutput.includes(privateMaterial), false, 'bridge diagnostics never serialize arbitrary errors');

const trace = buildOutboundSendTrace('baileys_accepted', {
  target_tag: 'jid:…4567', message_id: 'safe-message-id', chunk_count: 1,
  queue_wait_ms: 2, elapsed_ms: 4, connection_state: 'connected', session,
});
assert.equal(JSON.stringify({ event: 'whatsapp-outbound-trace', ...trace }).includes('safe-message-id'), true);
assert.equal(JSON.stringify(trace).includes(privateMaterial), false, 'safe outbound trace remains allowlisted');
console.log('  ✓ Baileys dependency logs and errors redact session material');
