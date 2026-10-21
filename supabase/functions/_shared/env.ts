// Configuración leída de los secretos de la Edge Function (`supabase secrets set …`).
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automáticamente.

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return Deno.env.get(name) || undefined;
}

export const env = {
  get supabaseUrl() { return requireEnv('SUPABASE_URL'); },
  get serviceRoleKey() { return requireEnv('SUPABASE_SERVICE_ROLE_KEY'); },
  // Meta WhatsApp Cloud API
  get waVerifyToken() { return requireEnv('WHATSAPP_VERIFY_TOKEN'); },
  get waAppSecret() { return requireEnv('WHATSAPP_APP_SECRET'); },
  get waAccessToken() { return requireEnv('WHATSAPP_ACCESS_TOKEN'); },
  get waGraphVersion() { return optionalEnv('WHATSAPP_GRAPH_VERSION') ?? 'v23.0'; },
  // Recordatorios
  get dispatcherSecret() { return requireEnv('DISPATCHER_SECRET'); },
  // Pagos (Wompi). Si faltan, el bot reserva sin enlace de pago.
  get wompiPublicKey() { return optionalEnv('WOMPI_PUBLIC_KEY'); },
  get wompiIntegritySecret() { return optionalEnv('WOMPI_INTEGRITY_SECRET'); },
  get paymentRedirectUrl() { return optionalEnv('PAYMENT_REDIRECT_URL'); },
  // Cifrado de contenido clínico (base64 de 32 bytes)
  get clinicalDataKey() { return requireEnv('CLINICAL_DATA_KEY'); },
  get privacyPolicyUrl() { return optionalEnv('PRIVACY_POLICY_URL'); },
};
