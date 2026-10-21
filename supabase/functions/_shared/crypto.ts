// Primitivas criptográficas con WebCrypto (nativo en Deno / Edge Runtime, sin dependencias).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparación en tiempo constante (evita ataques de temporización sobre firmas/secretos). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

/**
 * Verifica la cabecera X-Hub-Signature-256 de Meta: "sha256=" + HMAC(app_secret, cuerpo crudo).
 * Debe calcularse sobre el cuerpo EXACTO recibido, antes de JSON.parse.
 */
export async function verifyMetaSignature(
  appSecret: string, rawBody: string, header: string | null,
): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return timingSafeEqual(header.slice('sha256='.length), expected);
}

// --- Cifrado de contenido clínico (AES-256-GCM) ------------------------------
// Formato almacenado: base64( iv[12] || ciphertext+tag ). La clave vive en los
// secretos de la función, nunca en la BD: un volcado de la BD no expone notas.

export async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);
  if (raw.length !== 32) throw new Error('CLINICAL_DATA_KEY debe ser base64 de 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(key: CryptoKey, plaintext: string, aad?: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad ? encoder.encode(aad) : undefined },
    key, encoder.encode(plaintext),
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return toBase64(out);
}

/** `aad` (p. ej. el id de la nota) liga el cifrado a su fila: no se puede copiar a otra. */
export async function decryptText(key: CryptoKey, payload: string, aad?: string): Promise<string> {
  const bytes = fromBase64(payload);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aad ? encoder.encode(aad) : undefined },
    key, bytes.slice(12),
  );
  return decoder.decode(pt);
}
