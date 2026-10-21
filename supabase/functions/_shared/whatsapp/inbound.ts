// Normaliza el payload del webhook de Meta a eventos internos simples.
// Entrada TOLERANTE (Meta añade campos sin avisar → passthrough), salida estricta.

import { z } from '../deps.ts';

const MessageSchema = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).passthrough().optional(),
  interactive: z.object({
    type: z.string(),
    button_reply: z.object({ id: z.string(), title: z.string() }).passthrough().optional(),
    list_reply: z.object({ id: z.string(), title: z.string() }).passthrough().optional(),
  }).passthrough().optional(),
  // Respuesta a un botón quick-reply de PLANTILLA (recordatorios)
  button: z.object({ payload: z.string(), text: z.string() }).passthrough().optional(),
}).passthrough();

const StatusSchema = z.object({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string().optional(),
  errors: z.array(z.object({ code: z.number(), title: z.string().optional() }).passthrough()).optional(),
}).passthrough();

const WebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({
      field: z.string(),
      value: z.object({
        metadata: z.object({ phone_number_id: z.string(), display_phone_number: z.string().optional() }).passthrough(),
        contacts: z.array(z.object({
          wa_id: z.string(),
          profile: z.object({ name: z.string() }).passthrough().optional(),
        }).passthrough()).optional(),
        messages: z.array(MessageSchema).optional(),
        statuses: z.array(StatusSchema).optional(),
      }).passthrough(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

export type UserInput =
  | { kind: 'text'; text: string }
  | { kind: 'reply'; id: string; title: string }
  | { kind: 'unsupported'; type: string };

export interface InboundMessage {
  phoneNumberId: string;
  wamid: string;
  from: string;            // wa_id (dígitos, sin "+")
  profileName?: string;
  sentAt: string;          // ISO-8601 UTC
  type: string;
  input: UserInput;
  raw: unknown;
}

export interface StatusUpdate {
  phoneNumberId: string;
  providerMessageId: string;
  status: string;          // sent | delivered | read | failed
  at: string;
  errorCode?: number;
}

export function parseWebhook(body: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } | null {
  const parsed = WebhookSchema.safeParse(body);
  if (!parsed.success) return null;

  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const { metadata, contacts = [], messages: msgs = [], statuses: sts = [] } = change.value;
      for (const m of msgs) {
        messages.push({
          phoneNumberId: metadata.phone_number_id,
          wamid: m.id,
          from: m.from,
          profileName: contacts.find((c) => c.wa_id === m.from)?.profile?.name,
          sentAt: unixToIso(m.timestamp),
          type: m.type,
          input: toUserInput(m),
          raw: m,
        });
      }
      for (const s of sts) {
        statuses.push({
          phoneNumberId: metadata.phone_number_id,
          providerMessageId: s.id,
          status: s.status,
          at: unixToIso(s.timestamp),
          errorCode: s.errors?.[0]?.code,
        });
      }
    }
  }
  return { messages, statuses };
}

function toUserInput(m: z.infer<typeof MessageSchema>): UserInput {
  if (m.type === 'text' && m.text) return { kind: 'text', text: m.text.body };
  if (m.type === 'interactive' && m.interactive) {
    const r = m.interactive.button_reply ?? m.interactive.list_reply;
    if (r) return { kind: 'reply', id: r.id, title: r.title };
  }
  if (m.type === 'button' && m.button) return { kind: 'reply', id: m.button.payload, title: m.button.text };
  return { kind: 'unsupported', type: m.type };
}

function unixToIso(ts: string): string {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : new Date().toISOString();
}
