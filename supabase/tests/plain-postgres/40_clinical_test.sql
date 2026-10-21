-- Pruebas de la migración 0007 (integridad de notas clínicas). Se ejecuta tras 10_–30_.
-- En 10_ la psicóloga 1 (a3, pr …201) ya tiene una nota privada del paciente 1.
\set ON_ERROR_STOP 1
reset role;
set request.jwt.claims = '{"role":"service_role"}';

-- Nota antigua (creada hace 2 días) de la misma autora
insert into public.clinical_notes (id, org_id, patient_id, author_id, is_private, content_ciphertext, created_at)
values ('99999999-9999-9999-9999-999999999901', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555501', '22222222-2222-2222-2222-222222222201',
        false, 'cifrado-antiguo', now() - interval '2 days');

set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a3"}';
do $$
declare n int;
begin
  -- Nota reciente: la autora puede corregirla
  update public.clinical_notes set content_ciphertext = 'cifrado-corregido'
  where content_ciphertext = 'cifrado-de-prueba';
  get diagnostics n = row_count;
  assert n = 1, 'la autora debe poder corregir su nota reciente';

  -- Nota de hace 2 días: ya no se edita (RLS la excluye del UPDATE)
  update public.clinical_notes set content_ciphertext = 'intento'
  where id = '99999999-9999-9999-9999-999999999901';
  get diagnostics n = row_count;
  assert n = 0, 'una nota de más de 24 h no se edita';

  -- No se puede mover una nota a otro paciente
  begin
    update public.clinical_notes set patient_id = '55555555-5555-5555-5555-555555555502'
    where content_ciphertext = 'cifrado-corregido';
    raise exception 'debió impedir cambiar el paciente de la nota';
  exception when sqlstate 'PA005' then null;
  end;
end $$;

-- Otro profesional no puede editar la nota (ni la ve)
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a4"}';
do $$ declare n int; begin
  update public.clinical_notes set content_ciphertext = 'x';
  get diagnostics n = row_count;
  assert n = 0, 'otro profesional no edita notas ajenas';
end $$;

reset role;
\echo 'OK 10 · historia clínica: notas editables solo por su autor y durante 24 h; campos inmutables'
