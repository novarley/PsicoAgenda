// Cliente mínimo de la WhatsApp Cloud API (Meta). Sin SDK: un fetch validado.
import { buildOutbound, type OutboundContent } from './schema.ts';

export interface WhatsAppSender {
  send(to: string, content: OutboundContent): Promise<{ messageId: string }>;
}

export class WhatsAppApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: number) {
    super(message);
  }
  /** 131047: fuera de la ventana de 24 h → hay que usar plantilla. */
  get needsTemplate() { return this.code === 131047; }
}

export function createCloudApiSender(opts: {
  phoneNumberId: string;
  accessToken: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}): WhatsAppSender {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${opts.graphVersion}/${opts.phoneNumberId}/messages`;

  return {
    async send(to, content) {
      const body = buildOutbound(to, content); // lanza InvalidWhatsAppMessageError antes de salir a la red
      let lastError: WhatsAppApiError | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json?.messages?.[0]?.id) return { messageId: json.messages[0].id };

        lastError = new WhatsAppApiError(
          json?.error?.message ?? `HTTP ${res.status}`, res.status, json?.error?.code,
        );
        // Solo se reintenta lo transitorio (limitación de tasa / errores del servidor)
        if (res.status !== 429 && res.status < 500) break;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
      throw lastError;
    },
  };
}
