import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// SPA estática: el build (dist/) se sirve igual en Vercel, Cloudflare Pages o Netlify.
// Toda la lógica de servidor vive en Supabase; aquí no hay funciones serverless.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
