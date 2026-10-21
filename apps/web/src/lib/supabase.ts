import { createClient } from '@supabase/supabase-js';

/** VITE_DEMO=true: el panel funciona con datos de ejemplo en memoria, sin Supabase. */
export const isDemo = import.meta.env.VITE_DEMO === 'true';

// Solo la clave pública (anon/publishable): la seguridad la imponen las políticas RLS.
// La service_role key NUNCA va en el frontend.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
if (!isDemo && (!url || !anonKey)) {
  throw new Error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (ver apps/web/.env.example)');
}

// En modo demo el cliente existe pero nunca se usa para leer datos.
export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'demo');
