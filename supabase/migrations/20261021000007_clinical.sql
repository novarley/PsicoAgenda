-- =============================================================================
-- PsicoAgenda · Historia clínica: reglas de integridad de las notas de evolución
-- El contenido se cifra en la Edge Function clinical-record (la clave nunca llega a la BD).
-- =============================================================================

-- Una nota solo la edita su autor y solo durante las primeras 24 h.
-- Después se corrige con una nota nueva: la historia conserva lo que se escribió.
drop policy clinical_notes_update on public.clinical_notes;
create policy clinical_notes_update on public.clinical_notes for update to authenticated
  using (author_id = app.my_professional_id(org_id) and created_at > now() - interval '24 hours')
  with check (author_id = app.my_professional_id(org_id));

-- Ni siquiera el autor puede mover una nota a otro paciente, cambiar su autoría o su fecha
create or replace function app.clinical_note_immutable() returns trigger
language plpgsql as $$
begin
  if new.org_id <> old.org_id or new.patient_id <> old.patient_id
     or new.author_id <> old.author_id or new.created_at <> old.created_at then
    raise exception 'Campos inmutables de la nota clínica' using errcode = 'PA005';
  end if;
  return new;
end $$;

create trigger clinical_notes_immutable before update on public.clinical_notes
  for each row execute function app.clinical_note_immutable();

-- La auditoría también registra LECTURAS de la historia (las inserta la Edge Function)
create index audit_log_record_idx on public.audit_log(record_id, at desc);
