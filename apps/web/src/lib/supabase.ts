import { createClient } from '@supabase/supabase-js';

// Solo la clave pública (anon/publishable): la seguridad la imponen las políticas RLS.
// La service_role key NUNCA va en el frontend.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
if (!url || !anonKey) throw new Error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (ver apps/web/.env.example)');

export const supabase = createClient(url, anonKey);
