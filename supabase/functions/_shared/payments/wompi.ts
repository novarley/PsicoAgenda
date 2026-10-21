// Wompi (Colombia) — Web Checkout por URL firmada. No requiere llamada previa a la API
// ni servidor propio: generamos el enlace y Wompi notifica el resultado por webhook.
// Referencia: docs.wompi.co → "Widget & Checkout Web" → "Firma de integridad".
// VERIFICAR el orden exacto de concatenación con la documentación vigente antes de producción.
import { sha256Hex } from '../crypto.ts';

export interface WompiCheckoutInput {
  publicKey: string;
  integritySecret: string;
  reference: string;
  amountInCents: number;
  currency: string;
  redirectUrl?: string;
  /** ISO-8601 UTC; el enlace deja de aceptar pagos después de esta hora */
  expirationTime?: string;
}

export async function wompiIntegritySignature(i: Omit<WompiCheckoutInput, 'publicKey' | 'redirectUrl'>): Promise<string> {
  return sha256Hex(`${i.reference}${i.amountInCents}${i.currency}${i.expirationTime ?? ''}${i.integritySecret}`);
}

export async function wompiCheckoutUrl(i: WompiCheckoutInput): Promise<string> {
  if (!Number.isInteger(i.amountInCents) || i.amountInCents <= 0) throw new Error('monto inválido');
  const params = new URLSearchParams({
    'public-key': i.publicKey,
    currency: i.currency,
    'amount-in-cents': String(i.amountInCents),
    reference: i.reference,
    'signature:integrity': await wompiIntegritySignature(i),
  });
  if (i.redirectUrl) params.set('redirect-url', i.redirectUrl);
  if (i.expirationTime) params.set('expiration-time', i.expirationTime);
  return `https://checkout.wompi.co/p/?${params}`;
}
