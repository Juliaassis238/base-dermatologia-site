-- Esquema de referência para Supabase/Postgres da Base Dermatologia.
-- Nenhum profissional ou horário fictício é pré-cadastrado.
-- Implantar somente após revisão técnica e de privacidade da clínica.

create extension if not exists btree_gist;

create table if not exists public.doctors (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  notification_email text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Cada linha é um horário real criado pela clínica. A exclusão impede
-- que dois horários sobrepostos sejam disponibilizados para a mesma doutora.
create table if not exists public.availability_slots (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'available'
    check (status in ('available','held','booked','blocked')),
  hold_expires_at timestamptz,
  active_appointment_id uuid,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  constraint one_slot_start_per_doctor unique (doctor_id, starts_at),
  constraint no_overlapping_doctor_slots exclude using gist (
    doctor_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('available','held','booked'))
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.availability_slots(id),
  doctor_id uuid not null references public.doctors(id),
  patient_name text not null,
  patient_email text not null,
  patient_phone text not null,
  access_token_hash text not null,
  status text not null default 'pending_payment'
    check (status in ('pending_payment','confirmed','expired','cancelled','payment_review')),
  deposit_amount_cents integer not null default 12500 check (deposit_amount_cents > 0),
  privacy_notice_version text not null,
  privacy_accepted_at timestamptz not null,
  hold_expires_at timestamptz not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists one_active_appointment_per_slot
  on public.appointments(slot_id)
  where status in ('pending_payment','confirmed','payment_review');

alter table public.availability_slots
  drop constraint if exists availability_slots_active_appointment_id_fkey;
alter table public.availability_slots
  add constraint availability_slots_active_appointment_id_fkey
  foreign key (active_appointment_id) references public.appointments(id);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id),
  provider text not null default 'asaas' check (provider = 'asaas'),
  provider_payment_id text not null unique,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'pending'
    check (status in ('pending','received','refused','expired','refunded','review')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

-- Eventos mínimos para idempotência. Evite guardar payloads integrais com dados do cliente.
create table if not exists public.payment_webhook_events (
  provider_event_id text primary key,
  provider_payment_id text not null,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text
);

-- Toda operação pública passa por Edge Functions confiáveis: visitantes não podem
-- consultar pacientes, alterar horários ou escrever cobranças diretamente.
alter table public.doctors enable row level security;
alter table public.availability_slots enable row level security;
alter table public.appointments enable row level security;
alter table public.payments enable row level security;
alter table public.payment_webhook_events enable row level security;

revoke all on public.doctors from anon, authenticated;
revoke all on public.availability_slots from anon, authenticated;
revoke all on public.appointments from anon, authenticated;
revoke all on public.payments from anon, authenticated;
revoke all on public.payment_webhook_events from anon, authenticated;

grant all on public.doctors to service_role;
grant all on public.availability_slots to service_role;
grant all on public.appointments to service_role;
grant all on public.payments to service_role;
grant all on public.payment_webhook_events to service_role;

-- Serializa duas tentativas concorrentes de reservar a mesma vaga.
-- Chamar apenas de uma Edge Function, usando credencial administrativa no servidor.
create or replace function public.hold_appointment_slot(
  p_slot_id uuid,
  p_patient_name text,
  p_patient_email text,
  p_patient_phone text,
  p_access_token_hash text,
  p_privacy_notice_version text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slot public.availability_slots%rowtype;
  v_booking_id uuid;
  v_hold_expires_at timestamptz := now() + interval '10 minutes';
begin
  if length(trim(p_patient_name)) < 2 or length(trim(p_patient_phone)) < 8
     or position('@' in p_patient_email) = 0
     or coalesce(trim(p_access_token_hash), '') = ''
     or coalesce(trim(p_privacy_notice_version), '') = '' then
    raise exception 'invalid_booking_input';
  end if;

  select * into v_slot
    from public.availability_slots
   where id = p_slot_id
   for update;

  if not found then
    raise exception 'slot_not_found';
  end if;

  if v_slot.status = 'held' and v_slot.hold_expires_at <= now() then
    update public.appointments
       set status = 'expired'
     where id = v_slot.active_appointment_id
       and status = 'pending_payment';
    update public.availability_slots
       set status = 'available', hold_expires_at = null, active_appointment_id = null
     where id = p_slot_id;
    select * into v_slot from public.availability_slots where id = p_slot_id;
  end if;

  if v_slot.status <> 'available' then
    raise exception 'slot_unavailable';
  end if;

  insert into public.appointments (
    slot_id, doctor_id, patient_name, patient_email, patient_phone,
    access_token_hash, privacy_notice_version, privacy_accepted_at, hold_expires_at
  ) values (
    v_slot.id, v_slot.doctor_id, trim(p_patient_name), lower(trim(p_patient_email)),
    trim(p_patient_phone), p_access_token_hash, trim(p_privacy_notice_version),
    now(), v_hold_expires_at
  ) returning id into v_booking_id;

  update public.availability_slots
     set status = 'held', hold_expires_at = v_hold_expires_at, active_appointment_id = v_booking_id
   where id = p_slot_id;

  return v_booking_id;
end;
$$;

revoke all on function public.hold_appointment_slot(uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.hold_appointment_slot(uuid,text,text,text,text,text) to service_role;
