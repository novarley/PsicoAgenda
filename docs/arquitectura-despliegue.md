# Arquitectura y despliegue a coste cero

> Fecha de la evaluación: 21-oct-2026. Los límites de los planes gratuitos cambian;
> los marcados con *(verificar)* vienen de fuentes de terceros o no se confirmaron en la página oficial.

## Veredicto

**Sí se puede montar todo gratis, pero no "todo en Vercel".** La pieza que manda es
**Supabase**; Vercel (o una alternativa) solo sirve el panel web como archivos estáticos.

| Pieza | Dónde corre | Coste hoy |
|---|---|---|
| Base de datos PostgreSQL, RLS, auditoría | Supabase (Free) | 0 |
| Login del personal (RBAC) | Supabase Auth | 0 |
| Webhook de WhatsApp + bot (FSM) | Supabase Edge Functions | 0 |
| Recordatorios 48 h / 2 h, liberar reservas sin pago | `pg_cron` + `pg_net` dentro de Supabase | 0 |
| Alertas de crisis en tiempo real al panel | Supabase Realtime | 0 |
| Documentos y firmas | Supabase Storage (bucket privado) | 0 |
| Panel web (React + Tailwind, SPA estática) | Vercel Hobby **o** Cloudflare Pages | 0 |
| WhatsApp Cloud API (Meta, directo, sin intermediario) | Meta | **No es 0** — ver abajo |
| Pagos (Wompi / Mercado Pago / Stripe) | Pasarela | Comisión por transacción, sin cuota fija |

**El único coste inevitable desde el día 1 son las plantillas de WhatsApp** (los
recordatorios salen fuera de la ventana de 24 h, así que Meta los cobra por mensaje).
Las respuestas del bot dentro de una conversación que inició el paciente son gratis.

```
 Paciente (WhatsApp)                 Personal clínico (navegador)
        │                                        │
        ▼                                        ▼
   Meta Cloud API ── webhook ──►  ┌──────────────────────────────┐    SPA estática
        ▲                         │ SUPABASE (plan Free)         │◄── Vercel Hobby /
        │   mensajes / plantillas │                              │    Cloudflare Pages
        └──────────────────────── │  Edge Functions              │
                                  │   ├ whatsapp-webhook (bot)   │
                                  │   └ notifications-dispatcher │
                                  │  Postgres 17                 │
                                  │   ├ RLS por rol / tratante   │
                                  │   ├ book_appointment() atóm. │
                                  │   ├ exclusión anti-solapes   │
                                  │   └ pg_cron cada 5 min ──────┼──► dispatcher
                                  │  Auth · Realtime · Storage   │
                                  └──────────────────────────────┘
```

## Por qué cambié parte del stack propuesto

| Propuesta original | Decisión | Motivo |
|---|---|---|
| FastAPI / Node como servidor aparte | **Supabase Edge Functions (TypeScript/Deno)** + lógica en SQL | Un servidor propio siempre encendido no existe gratis de forma fiable (Render duerme a los 15 min; Fly.io ya no tiene plan gratis). Las Edge Functions están incluidas en Supabase. |
| SQLAlchemy / Prisma | **Migraciones SQL** como fuente única de verdad | RLS, triggers, `pg_cron` y la restricción de exclusión anti-solapes no se expresan en esos ORMs. Si más adelante se quiere Prisma, `prisma db pull` genera el esquema desde la BD. |
| Redis para el estado conversacional | **Tabla `conversations`** con lease + bloqueo optimista | Postgres ya está pagado (gratis). Evita un servicio más. Resiste reintentos del webhook y saltos entre instancias. |
| Baileys | **Descartado** — Meta Cloud API directa | Baileys es no oficial (riesgo de bloqueo del número de la clínica) y necesita un proceso conectado 24/7 que ni Vercel ni Supabase ofrecen. |
| Woztell u otro BSP | **Meta directo** | Un BSP cobra cuota mensual encima de las tarifas de Meta. |
| LangChain + OpenAI | **Opcional, apagado por defecto** | El flujo de 10 pasos es determinista (botones/listas). La detección de crisis es por reglas: no puede caerse por cuota ni alucinar. Los planes gratuitos de LLM suelen usar los datos para entrenar: **no aptos para datos de salud**. |
| Docker Compose propio | `supabase start` (usa Docker por debajo) | Levanta la pila completa local con un comando. |
| Vercel Cron | **pg_cron** | En Vercel Hobby el cron es como mínimo **una vez al día** y con precisión horaria: inútil para un recordatorio de 2 h. pg_cron corre cada 5 min dentro de Supabase. |

## Límites del plan gratuito y consumo estimado

### Supabase Free
| Recurso | Límite | Fuente |
|---|---|---|
| Base de datos | 500 MB | supabase.com/pricing |
| Proyectos activos | 2 | supabase.com/pricing |
| Pausa por inactividad | tras 1 semana sin actividad | docs "Project pausing" |
| Edge Functions: duración | 150 s (free) · CPU 2 s/request · 256 MB | docs "Edge Functions limits" |
| Edge Functions: invocaciones | ~500 mil/mes *(verificar)* | terceros |
| Storage | ~1 GB *(verificar)* | — |
| Backups | no incluidos en Free *(Pro: diarios 7 días)* | supabase.com/pricing |

**Consumo de una clínica con 400 citas/mes** (estimación):
- Webhook: ~12 mensajes por reserva → ~5.000 invocaciones.
- Dispatcher: 12/h × 24 × 30 = **8.640** invocaciones (fijo, da igual cuántas clínicas).
- Total ≈ 15.000/mes → el límite de invocaciones da para **decenas de clínicas**.
- BD: las filas son pequeñas; los payloads crudos de WhatsApp se purgan a los 90 días.
  Lo primero que se agotará es **Storage** si se suben PDFs/imágenes clínicas.

### Vercel Hobby
- **Uso comercial no permitido** en Hobby (solo Pro y Enterprise). Mientras sea un piloto
  sin cobrar es aceptable; **el día que se cobre, hay que salir de Hobby**.
- Cron: una vez al día, ±59 min → por eso no se usa.

### Meta (WhatsApp)
- Desde el 1-jul-2025 se cobra **por mensaje de plantilla**; los mensajes que no son plantilla
  son gratis dentro de la ventana de servicio de 24 h.
- Colombia tiene tarifas *utility* por encima de la base del tarifario de julio 2025
  *(consultar la tabla oficial de Meta: los terceros dan cifras contradictorias)*.
- Presupuesto: **≈3 plantillas por cita** (48 h, 2 h, aftercare). Para ahorrar al principio:
  desactivar `aftercare` o enviar un solo recordatorio de 24 h.

## Alternativas igual de gratuitas

### Para el panel web (frontend)
| Opción | Comercial gratis | Notas | Veredicto |
|---|---|---|---|
| **Cloudflare Pages** | Sí *(según comparativas; verificar ToS)* | Ancho de banda sin tope para estáticos, 500 builds/mes | **Recomendada a partir del cobro** |
| Vercel Hobby | **No** | La mejor DX; Pro cuesta 20 USD/mes | Bien para el piloto |
| Netlify Free | Sí | Límite de ancho de banda y minutos de build | Alternativa válida |
| GitHub Pages | Sí (repos públicos) | Sin cabeceras de seguridad personalizadas | No recomendada para datos de salud |

Como el panel es una **SPA estática** (`apps/web`, Vite), moverla de Vercel a Cloudflare
Pages es cambiar dónde se sube `dist/`: ya incluye `vercel.json` y `public/_redirects`.

### Para el backend + base de datos
| Opción | Qué da gratis | Qué falta | Veredicto |
|---|---|---|---|
| **Supabase** | Postgres + Auth + RLS + funciones + cron + Realtime + Storage | Backups y no-pausa requieren Pro | **Elegida**: es la única que cubre todo sin piezas extra |
| Neon + Cloudflare Workers | Postgres serverless (0,5 GB) + Workers con Cron Triggers | Auth, Storage y Realtime hay que montarlos aparte | Plan B si Supabase cambia condiciones |
| Firebase (Spark) | Auth, Firestore, Hosting | No es SQL: pierdes RLS relacional, exclusión anti-solapes, transacciones de reserva | No encaja con datos clínicos relacionales |
| Render Free | Web service | Se duerme a los 15 min: el primer webhook tarda y Meta reintenta | No apto para webhook |
| Oracle Cloud Always Free | VM ARM siempre encendida | Pide tarjeta; tú administras SO, parches, backups, TLS | Solo si se necesita Baileys o un servidor propio |

## Riesgos del plan gratis y cómo se mitigan

| Riesgo | Mitigación |
|---|---|
| Supabase pausa el proyecto tras 1 semana sin actividad | Con una clínica real hay tráfico diario. En staging: un cron de GitHub Actions que haga una consulta diaria. |
| **Sin backups** en Free | GitHub Actions diario con `pg_dump` **cifrado** (gpg) a un repo privado. Al primer cliente de pago: Supabase Pro (25 USD/mes) con backups diarios. |
| Vercel Hobby prohíbe uso comercial | Panel en Cloudflare Pages desde que se cobre (o Vercel Pro). |
| Límites de Edge Functions (CPU 2 s) | El bot hace I/O, no cómputo; la lógica pesada (huecos, reservas) corre en SQL. |
| Datos de salud en la nube | Región **São Paulo (sa-east-1)** para Colombia; cifrado AES-256-GCM a nivel de aplicación para notas clínicas; RLS; auditoría. El consentimiento del paso 1 debe mencionar la transferencia internacional (Ley 1581). |

## Cuándo empezar a pagar (en este orden)

1. **Primer cliente que paga** → Supabase Pro (backups, sin pausa) + panel en Cloudflare Pages (sigue gratis).
2. **Muchas clínicas o archivos pesados** → ampliar Storage / cómputo de Supabase.
3. **Embedded Signup de Meta** (cada clínica conecta su número sola) → requiere verificación como Tech Provider, no pago.

## Puesta en marcha

```bash
# 1. Local (requiere Docker con WSL2 en Windows)
npx supabase start
npx supabase db reset            # aplica migraciones + seed

# 2. Proyecto en la nube (crear en supabase.com, región São Paulo)
npx supabase link --project-ref <ref>
npx supabase db push
# Crear secretos de Vault (ver cabecera de la migración 0004) y de las funciones:
npx supabase secrets set --env-file supabase/functions/.env
npx supabase functions deploy whatsapp-webhook
npx supabase functions deploy notifications-dispatcher

# 3. Meta: en la app de WhatsApp → Webhooks
#    URL:   https://<ref>.supabase.co/functions/v1/whatsapp-webhook
#    Token: el mismo WHATSAPP_VERIFY_TOKEN · suscribir el campo "messages"
#    Crear y aprobar las plantillas: recordatorio_cita_48h, recordatorio_cita_2h,
#    seguimiento_post_sesion, oferta_lista_espera (ver notifications-dispatcher/index.ts)

# 4. Panel: Vercel (piloto) o Cloudflare Pages → raíz apps/web, build "npm run build", salida dist/
```

## Pendiente (siguientes iteraciones)
- Webhook de Wompi → marcar `payments.approved` y pasar la cita de `pending_payment` a `scheduled`.
  Hasta entonces, las reservas con anticipo se liberan solas a los 30 min.
- Barrido de `wa_inbound_messages` con `processed_at is null` (reproceso si la función murió).
- Respuesta "Aceptar" a la oferta de lista de espera desde el bot.
- Edge Function `clinical-notes` que cifra/descifra con `CLINICAL_DATA_KEY` (la primitiva ya está en `_shared/crypto.ts`).
- Sincronización con Google Calendar / Outlook, firma de consentimientos, facturación electrónica.
- Pantallas del panel: bandeja de WhatsApp (handoff), agenda, ficha clínica, métricas (`v_attendance_monthly`).
