import { delegatedContactTag } from './delegated_gate.js';

function isDirectMessageJid(jid) {
  return /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''));
}

/**
 * Build privacy-safe diagnostics for raw Baileys messages.upsert input.
 * This deliberately does not influence ingress handling or perform I/O.
 */
export function buildIngressTraceEvents({ messages, type }) {
  const batch = Array.isArray(messages) ? messages : [];
  const batchSize = batch.length;

  return batch.flatMap((msg) => {
    const key = msg?.key;
    const chatId = key?.remoteJid;
    if (key?.fromMe || !isDirectMessageJid(chatId)) return [];

    const message = msg?.message;
    return [{
      event: 'whatsapp-ingress-trace',
      stage: 'baileys_messages_upsert',
      messageId: key?.id ? String(key.id) : '',
      contact: delegatedContactTag(key?.participant || chatId),
      upsertType: type || '',
      batchSize,
      hasMessage: !!message,
      messageKeys: message && typeof message === 'object' ? Object.keys(message) : [],
    }];
  });
}
