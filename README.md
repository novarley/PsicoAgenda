# PsicoAgenda

Plataforma de gestión clínica y agendamiento automatizado por WhatsApp para centros de
psicología y medicina general. Objetivo: bajar el ausentismo del ~30 % a menos del 5 %
con confirmación activa, recordatorios y anticipos.

**Coste de infraestructura: 0** (Supabase Free + hosting estático gratuito).
La decisión y sus límites están en [docs/arquitectura-despliegue.md](docs/arquitectura-despliegue.md).

## Estructura

```
supabase/
  migrations/
    …0001_core_schema.sql              organizaciones, pacientes, citas, bonos, pagos, facturas,
                                       historia clínica cifrada, conversaciones WhatsApp, crisis, auditoría
    …0002_rls_policies.sql             RBAC: admin · recepción · profesional (solo sus pacientes)
    …0003_booking_and_notifications.sql huecos en hora local→UTC, reserva atómica, bonos,
                                       recordatorios, lista de espera, métricas
    …0004_supabase_cron_storage.sql    pg_cron cada 5 min, bucket privado de documentos
    …0005_inbox.sql                    vistas de la bandeja de WhatsApp, autor de cada respuesta, Realtime
    …0006_panel.sql                    personal, último admin protegido, ocupación, ingresos, pagos manuales
  functions/
    whatsapp-webhook/                  endpoint del webhook de Meta (GET verificación, POST mensajes)
    notifications-dispatcher/          recordatorios 48 h / 2 h, aftercare, lista de espera
    inbox-send/                        respuesta manual del equipo desde la bandeja (ventana de 24 h)
    staff-invite/                      invitar personal por correo y asignar rol (Auth Admin API)
    _shared/
      bot/engine.ts                    máquina de estados del flujo de 10 pasos (pura, testeable)
      bot/crisis.ts                    protocolo de crisis por reglas
      bot/supabase-ports.ts            adaptador a la BD
      bot/conversation-repo.ts         estado persistente con lease + bloqueo optimista
      whatsapp/schema.ts               validación estricta de botones/listas/plantillas
      payments/wompi.ts                enlace de pago firmado
      crypto.ts                        firma de Meta, AES-256-GCM para notas clínicas
    tests/                             pruebas Deno (37)
  tests/plain-postgres/                pruebas SQL de agenda, bonos, bandeja, panel y RLS por rol
  seed.sql                             datos demo (solo local)
apps/web/                              panel React + Tailwind (SPA estática)
  src/features/agenda/                 agenda por profesional, huecos libres, nueva cita, estados, pago manual
  src/features/patients/               lista, alta, ficha (datos, citas, bonos, documentos)
  src/features/inbox/                  bandeja de WhatsApp (crisis y derivaciones)
  src/features/metrics/                ocupación, asistencia vs ausentismo, ingresos
  src/features/settings/               organización, sedes, servicios, EPS, profesionales, horarios, personal
  src/demo/store.ts                    datos ficticios para el modo demo
docs/                                  arquitectura y despliegue
```

## Pruebas

```bash
cd supabase/functions && npx deno task test
```

```bash
bash supabase/tests/plain-postgres/run.sh
```

La segunda necesita Docker (en Windows, con WSL2).

## Ver el panel sin Supabase (modo demo)

```bash
cd apps/web
```

```bash
npm install
```

```bash
npm run demo
```

Con `VITE_DEMO=true` (archivo `apps/web/.env.demo`) el panel usa datos ficticios en memoria: unos 4 meses de citas, pacientes, bonos, pagos y la bandeja con una crisis abierta. El selector «Demo · ver como» de la cabecera muestra la app como administración, recepción o profesional. No guarda nada ni envía mensajes; al recargar se reinicia.
