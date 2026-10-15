-- Dados solicitados para emissão de nota fiscal. A tabela está vazia nesta migração;
-- os campos fiscais obrigatórios serão gravados somente pelo servidor da agenda.
alter table public.appointments
  add column patient_cpf text not null check (patient_cpf ~ '^[0-9]{11}$'),
  add column patient_address_line text not null check (length(trim(patient_address_line)) between 2 and 160),
  add column patient_address_number text not null check (length(trim(patient_address_number)) between 1 and 20),
  add column patient_address_complement text check (patient_address_complement is null or length(trim(patient_address_complement)) <= 100),
  add column patient_address_neighborhood text not null check (length(trim(patient_address_neighborhood)) between 2 and 80),
  add column patient_address_city text not null check (length(trim(patient_address_city)) between 2 and 80),
  add column patient_address_state text not null check (patient_address_state ~ '^[A-Z]{2}$'),
  add column patient_address_postal_code text not null check (patient_address_postal_code ~ '^[0-9]{8}$');

-- Regras recorrentes; os horários físicos são gerados de forma idempotente quando
-- o calendário consulta cada mês, sempre no fuso de São Paulo.
create table public.doctor_weekly_rules (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id),
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  slot_duration_minutes integer not null check (slot_duration_minutes between 5 and 240),
  starts_on date not null,
  ends_on date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  check (ends_on is null or ends_on >= starts_on),
  check (extract(epoch from (end_time - start_time))::integer % (slot_duration_minutes * 60) = 0),
  unique (doctor_id, weekday, starts_on)
);

alter table public.doctor_weekly_rules enable row level security;
revoke all on public.doctor_weekly_rules from anon, authenticated;
grant all on public.doctor_weekly_rules to service_role;

insert into public.doctor_weekly_rules
  (doctor_id, weekday, start_time, end_time, slot_duration_minutes, starts_on, is_active)
select id, 2, time '09:00', time '13:00', 30, date '2026-11-17', true
  from public.doctors where display_name = 'Jéssica Saab'
on conflict (doctor_id, weekday, starts_on) do update
  set start_time = excluded.start_time,
      end_time = excluded.end_time,
      slot_duration_minutes = excluded.slot_duration_minutes,
      ends_on = null,
      is_active = true;

insert into public.doctor_weekly_rules
  (doctor_id, weekday, start_time, end_time, slot_duration_minutes, starts_on, is_active)
select id, 2, time '14:00', time '18:00', 30, date '2026-11-17', true
  from public.doctors where display_name = 'Mariana Gil Furlanetti'
on conflict (doctor_id, weekday, starts_on) do update
  set start_time = excluded.start_time,
      end_time = excluded.end_time,
      slot_duration_minutes = excluded.slot_duration_minutes,
      ends_on = null,
      is_active = true;

create or replace function public.generate_recurring_slots(p_from_date date, p_to_date date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer := 0;
begin
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date
     or p_to_date - p_from_date > 31 then
    raise exception 'invalid_schedule_period';
  end if;

  insert into public.availability_slots (doctor_id, starts_at, ends_at)
  select
    rule.doctor_id,
    ((days.day_start::date + rule.start_time + make_interval(mins => offsets.minute_offset)) at time zone 'America/Sao_Paulo'),
    ((days.day_start::date + rule.start_time + make_interval(mins => offsets.minute_offset + rule.slot_duration_minutes)) at time zone 'America/Sao_Paulo')
  from public.doctor_weekly_rules as rule
  cross join lateral generate_series(
    greatest(p_from_date, rule.starts_on)::timestamp,
    least(p_to_date, coalesce(rule.ends_on, p_to_date))::timestamp,
    interval '1 day'
  ) as days(day_start)
  cross join lateral generate_series(
    0,
    (extract(epoch from (rule.end_time - rule.start_time))::integer / 60) - rule.slot_duration_minutes,
    rule.slot_duration_minutes
  ) as offsets(minute_offset)
  where rule.is_active
    and extract(dow from days.day_start)::integer = rule.weekday
  on conflict (doctor_id, starts_at) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.generate_recurring_slots(date, date) from public, anon, authenticated;
grant execute on function public.generate_recurring_slots(date, date) to service_role;

-- Atualiza a transação de reserva para exigir CPF/endereço, preservando a trava
-- da vaga e a confirmação sem pagamento da fase atual.
drop function public.book_appointment_without_payment(uuid, text, text, text, text, text);

create function public.book_appointment_without_payment(
  p_slot_id uuid,
  p_patient_name text,
  p_patient_email text,
  p_patient_phone text,
  p_patient_cpf text,
  p_patient_address_line text,
  p_patient_address_number text,
  p_patient_address_complement text,
  p_patient_address_neighborhood text,
  p_patient_address_city text,
  p_patient_address_state text,
  p_patient_address_postal_code text,
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
     or coalesce(p_patient_cpf, '') !~ '^[0-9]{11}$'
     or length(trim(coalesce(p_patient_address_line, ''))) not between 2 and 160
     or length(trim(coalesce(p_patient_address_number, ''))) not between 1 and 20
     or (p_patient_address_complement is not null and length(trim(p_patient_address_complement)) > 100)
     or length(trim(coalesce(p_patient_address_neighborhood, ''))) not between 2 and 80
     or length(trim(coalesce(p_patient_address_city, ''))) not between 2 and 80
     or upper(trim(coalesce(p_patient_address_state, ''))) !~ '^[A-Z]{2}$'
     or coalesce(p_patient_address_postal_code, '') !~ '^[0-9]{8}$'
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
    patient_cpf, patient_address_line, patient_address_number,
    patient_address_complement, patient_address_neighborhood, patient_address_city,
    patient_address_state, patient_address_postal_code,
    access_token_hash, status, payment_required, payment_status,
    deposit_amount_cents, privacy_notice_version, privacy_accepted_at, confirmed_at
  ) values (
    v_slot.id, v_slot.doctor_id, trim(p_patient_name), lower(trim(p_patient_email)),
    trim(p_patient_phone), trim(p_patient_cpf), trim(p_patient_address_line),
    trim(p_patient_address_number), nullif(trim(coalesce(p_patient_address_complement, '')), ''),
    trim(p_patient_address_neighborhood), trim(p_patient_address_city),
    upper(trim(p_patient_address_state)), trim(p_patient_address_postal_code),
    p_access_token_hash, 'confirmed', false, 'not_required', 0,
    trim(p_privacy_notice_version), now(), now()
  ) returning id into v_booking_id;

  update public.availability_slots
     set status = 'booked', hold_expires_at = null, active_appointment_id = v_booking_id
   where id = p_slot_id;

  return v_booking_id;
end;
$$;

revoke all on function public.book_appointment_without_payment(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.book_appointment_without_payment(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text) to service_role;
