// Validación "cero fallos" de mensajes salientes de la WhatsApp Cloud API.
//
// Meta rechaza (o, peor, entrega mal) mensajes interactivos con títulos largos,
// ids repetidos o claves sobrantes. Aquí:
//   1. Los builders recortan los textos dinámicos (nombres de profesionales…) al límite.
//   2. Todo mensaje se valida con esquemas .strict() ANTES de llamar a la API.
// Si algo no cumple, falla en nuestro código con un error claro, nunca en silencio.

import { z } from '../deps.ts';

export const LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  headerText: 60,
  footerText: 60,
  maxButtons: 3,
  buttonTitle: 20,
  buttonId: 256,
  listButton: 20,
  maxRowsTotal: 10,
  maxSections: 10,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  templateParam: 1024,
  quickReplyPayload: 256,
} as const;

/** Texto no vacío, sin espacios al borde y dentro del límite (cuenta unidades UTF-16: más estricto que Meta). */
const boundedText = (max: number) =>
  z.string().min(1).max(max).refine((s) => s.trim() === s && s.length > 0, {
    message: 'texto vacío o con espacios al inicio/fin',
  });

const textObject = (max: number) => z.object({ text: boundedText(max) }).strict();

// ---------------------------------------------------------------- interactivos
const ReplyButtonSchema = z.object({
  type: z.literal('reply'),
  reply: z.object({ id: boundedText(LIMITS.buttonId), title: boundedText(LIMITS.buttonTitle) }).strict(),
}).strict();

const ButtonInteractiveSchema = z.object({
  type: z.literal('button'),
  header: z.object({ type: z.literal('text'), text: boundedText(LIMITS.headerText) }).strict().optional(),
  body: textObject(LIMITS.interactiveBody),
  footer: textObject(LIMITS.footerText).optional(),
  action: z.object({
    buttons: z.array(ReplyButtonSchema).min(1).max(LIMITS.maxButtons),
  }).strict(),
}).strict().superRefine((msg, ctx) => {
  assertUnique(msg.action.buttons.map((b) => b.reply.id), 'id de botón', ctx);
  assertUnique(msg.action.buttons.map((b) => b.reply.title), 'título de botón', ctx);
});

const ListRowSchema = z.object({
  id: boundedText(LIMITS.rowId),
  title: boundedText(LIMITS.rowTitle),
  description: boundedText(LIMITS.rowDescription).optional(),
}).strict();

const ListSectionSchema = z.object({
  title: boundedText(LIMITS.sectionTitle).optional(),
  rows: z.array(ListRowSchema).min(1).max(LIMITS.maxRowsTotal),
}).strict();

const ListInteractiveSchema = z.object({
  type: z.literal('list'),
  header: z.object({ type: z.literal('text'), text: boundedText(LIMITS.headerText) }).strict().optional(),
  body: textObject(LIMITS.interactiveBody),
  footer: textObject(LIMITS.footerText).optional(),
  action: z.object({
    button: boundedText(LIMITS.listButton),
    sections: z.array(ListSectionSchema).min(1).max(LIMITS.maxSections),
  }).strict(),
}).strict().superRefine((msg, ctx) => {
  const rows = msg.action.sections.flatMap((s) => s.rows);
  if (rows.length > LIMITS.maxRowsTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `máximo ${LIMITS.maxRowsTotal} filas en total` });
  }
  if (msg.action.sections.length > 1 && msg.action.sections.some((s) => !s.title)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'con varias secciones, todas necesitan título' });
  }
  assertUnique(rows.map((r) => r.id), 'id de fila', ctx);
});

// ------------------------------------------------------------------ plantillas
// Meta rechaza parámetros de plantilla con saltos de línea, tabulaciones o 4+ espacios seguidos
const templateParamText = boundedText(LIMITS.templateParam).refine((s) => !/[\n\t]| {4,}/.test(s), {
  message: 'parámetro de plantilla con salto de línea, tabulación o 4+ espacios',
});

const TemplateComponentSchema = z.union([
  z.object({
    type: z.literal('body'),
    parameters: z.array(z.object({ type: z.literal('text'), text: templateParamText }).strict()).max(20),
  }).strict(),
  z.object({
    type: z.literal('button'),
    sub_type: z.literal('quick_reply'),
    index: z.enum(['0', '1', '2']),
    parameters: z.tuple([
      z.object({ type: z.literal('payload'), payload: boundedText(LIMITS.quickReplyPayload) }).strict(),
    ]),
  }).strict(),
]);

const TemplateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'nombre de plantilla inválido'),
  language: z.object({ code: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/) }).strict(),
  components: z.array(TemplateComponentSchema).optional(),
}).strict();

// -------------------------------------------------------------------- sobres
const envelope = {
  messaging_product: z.literal('whatsapp'),
  recipient_type: z.literal('individual'),
  to: z.string().regex(/^[1-9]\d{6,14}$/, 'destinatario debe ser E.164 sin "+"'),
};

export const OutboundMessageSchema = z.union([
  z.object({
    ...envelope,
    type: z.literal('text'),
    text: z.object({ body: boundedText(LIMITS.textBody), preview_url: z.boolean().optional() }).strict(),
  }).strict(),
  z.object({ ...envelope, type: z.literal('interactive'), interactive: ButtonInteractiveSchema }).strict(),
  z.object({ ...envelope, type: z.literal('interactive'), interactive: ListInteractiveSchema }).strict(),
  z.object({ ...envelope, type: z.literal('template'), template: TemplateSchema }).strict(),
]);

export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;
/** Contenido sin destinatario: lo que produce el motor del bot. */
export type OutboundContent = DistributiveOmit<OutboundMessage, 'messaging_product' | 'recipient_type' | 'to'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class InvalidWhatsAppMessageError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Mensaje de WhatsApp inválido: ${issues.join('; ')}`);
  }
}

/** Valida y devuelve el cuerpo listo para POST /messages. Lanza si no cumple. */
export function buildOutbound(to: string, content: OutboundContent): OutboundMessage {
  const candidate = { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), ...content };
  const result = OutboundMessageSchema.safeParse(candidate);
  if (!result.success) {
    throw new InvalidWhatsAppMessageError(
      result.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
    );
  }
  return result.data;
}

function assertUnique(values: string[], label: string, ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} repetido: "${v}"` });
    seen.add(v);
  }
}

// ------------------------------------------------------------------- builders
/** Recorta texto de UNA línea (títulos, parámetros) al límite con "…" en vez de dejar que Meta lo rechace. */
export function fitText(value: string, max: number): string {
  return truncate(value.replace(/\s+/g, ' ').trim(), max);
}

/** Como fitText, pero para cuerpos de mensaje: conserva los saltos de línea (listas, párrafos). */
export function fitBody(value: string, max: number): string {
  const clean = value
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(clean, max);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export interface Choice { id: string; title: string; description?: string }

export function textMessage(body: string): OutboundContent {
  return { type: 'text', text: { body: fitBody(body, LIMITS.textBody) } };
}

export function buttonsMessage(body: string, choices: Choice[], footer?: string): OutboundContent {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: fitBody(body, LIMITS.interactiveBody) },
      ...(footer ? { footer: { text: fitText(footer, LIMITS.footerText) } } : {}),
      action: {
        buttons: choices.map((c) => ({ type: 'reply' as const, reply: { id: c.id, title: fitText(c.title, LIMITS.buttonTitle) } })),
      },
    },
  };
}

export function listMessage(body: string, button: string, choices: Choice[], footer?: string): OutboundContent {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: fitBody(body, LIMITS.interactiveBody) },
      ...(footer ? { footer: { text: fitText(footer, LIMITS.footerText) } } : {}),
      action: {
        button: fitText(button, LIMITS.listButton),
        sections: [{
          rows: choices.slice(0, LIMITS.maxRowsTotal).map((c) => ({
            id: c.id,
            title: fitText(c.title, LIMITS.rowTitle),
            ...(c.description ? { description: fitText(c.description, LIMITS.rowDescription) } : {}),
          })),
        }],
      },
    },
  };
}

/** Plantilla aprobada con parámetros de cuerpo y, opcionalmente, payloads de sus botones quick-reply. */
export function templateMessage(
  name: string, language: string, bodyParams: string[], quickReplies: string[] = [],
): OutboundContent {
  return {
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: [
        {
          type: 'body',
          parameters: bodyParams.map((text) => ({
            type: 'text' as const,
            text: fitText(text.replace(/[\n\t]/g, ' '), LIMITS.templateParam),
          })),
        },
        ...quickReplies.map((payload, i) => ({
          type: 'button' as const,
          sub_type: 'quick_reply' as const,
          index: String(i) as '0' | '1' | '2',
          parameters: [{ type: 'payload' as const, payload }] as [{ type: 'payload'; payload: string }],
        })),
      ],
    },
  };
}

/** Botones si caben (≤3 y títulos cortos), si no, lista. */
export function choiceMessage(body: string, listButton: string, choices: Choice[]): OutboundContent {
  const fitsButtons = choices.length <= LIMITS.maxButtons &&
    choices.every((c) => c.title.length <= LIMITS.buttonTitle && !c.description);
  return fitsButtons ? buttonsMessage(body, choices) : listMessage(body, listButton, choices);
}

// Los ids de respuesta llevan el paso que los emitió: "<paso>|<valor>".
// Así un botón viejo (de un mensaje anterior) no se confunde con el paso actual.
export function replyId(step: string, value: string): string {
  return `${step}|${value}`;
}

export function parseReplyId(id: string): { step: string; value: string } | null {
  const i = id.indexOf('|');
  if (i <= 0) return null;
  return { step: id.slice(0, i), value: id.slice(i + 1) };
}
