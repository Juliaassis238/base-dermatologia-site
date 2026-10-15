-- Agenda Base Dermatologia — primeira fase sem pagamento.
-- Os horários só devem ser publicados depois de a clínica confirmar a disponibilidade real.
-- A tabela payments fica pronta para integração futura com InfinitePay, sem cobrar nesta fase.

create extension if not exists btree_gist;

create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  display_name text not null unique,
  notification_email text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (notification_email is null or position('@' in notification_email) > 1)
);

create table public.availability_slots (
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

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.availability_slots(id),
  doctor_id uuid not null references public.doctors(id),
  patient_name text not null,
  patient_email text not null,
  patient_phone text not null,
  access_token_hash text not null,
  status text not null default 'confirmed'
    check (status in ('pending_payment','confirmed','expired','cancelled','payment_review')),
  payment_required boolean not null default false,
  payment_status text not null default 'not_required'
    check (payment_status in ('not_required','pending','received','refused','expired','refunded','review')),
  deposit_amount_cents integer not null default 0 check (deposit_amount_cents >= 0),
  privacy_notice_version text not null,
  privacy_accepted_at timestamptz not null,
  hold_expires_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index one_active_appointment_per_slot
  on public.appointments(slot_id)
  where status in ('pending_payment','confirmed','payment_review');

alter table public.availability_slots
  add constraint availability_slots_active_appointment_id_fkey
  foreign key (active_appointment_id) references public.appointments(id);

-- Estrutura reservada para o checkout/webhook InfinitePay, ainda sem cobranças.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id),
  provider text not null default 'infinitepay' check (provider = 'infinitepay'),
  order_nsu text not null unique,
  invoice_slug text unique,
  transaction_nsu text unique,
  amount_cents integer not null check (amount_cents > 0),
  capture_method text,
  receipt_url text,
  status text not null default 'pending'
    check (status in ('pending','received','refused','expired','refunded','review')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table public.payment_webhook_events (
  provider_event_key text primary key,
  order_nsu text not null,
  invoice_slug text,
  transaction_nsu text,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text
);

-- Sem dados fictícios de disponibilidade; apenas cadastramos as profissionais já apresentadas no site.
insert into public.doctors (display_name)
values ('Mariana Gil Furlanetti'), ('Jéssica Saab')
on conflict (display_name) do nothing;

-- Reserva sem pagamento. A operação bloqueia a linha do horário para impedir dupla marcação.
create or replace function public.book_appointment_without_payment(
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
begin
  if length(trim(coalesce(p_patient_name, ''))) < 2
     or length(trim(coalesce(p_patient_name, ''))) > 120
     or position('@' in coalesce(p_patient_email, '')) < 2
     or length(trim(coalesce(p_patient_phone, ''))) < 8
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
       set status = 'expired', payment_status = 'expired'
     where id = v_slot.active_appointment_id
       and status = 'pending_payment';
    update public.availability_slots
       set status = 'available', hold_expires_at = null, active_appointment_id = null
     where id = p_slot_id;
    select * into v_slot from public.availability_slots where id = p_slot_id;
  end if;

  if v_slot.status <> 'available' or v_slot.starts_at <= now() then
    raise exception 'slot_unavailable';
  end if;

  if not exists (
    select 1 from public.doctors
     where id = v_slot.doctor_id and is_active = true
  ) then
    raise exception 'doctor_inactive';
  end if;

  insert into public.appointments (
    slot_id, doctor_id, patient_name, patient_email, patient_phone,
    access_token_hash, status, payment_required, payment_status,
    deposit_amount_cents, privacy_notice_version, privacy_accepted_at, confirmed_at
  ) values (
    v_slot.id, v_slot.doctor_id, trim(p_patient_name), lower(trim(p_patient_email)),
    trim(p_patient_phone), p_access_token_hash, 'confirmed', false, 'not_required',
    0, trim(p_privacy_notice_version), now(), now()
  ) returning id into v_booking_id;

  update public.availability_slots
     set status = 'booked', hold_expires_at = null, active_appointment_id = v_booking_id
   where id = p_slot_id;

  return v_booking_id;
end;
$$;

-- Nenhuma tabela operacional fica acessível diretamente pelo navegador.
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

revoke all on function public.book_appointment_without_payment(uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.book_appointment_without_payment(uuid,text,text,text,text,text) to service_role;
