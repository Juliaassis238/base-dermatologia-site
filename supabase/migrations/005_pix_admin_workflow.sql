-- Agenda Base Dermatologia: Pix manual, aprovações administrativas e auditoria.
-- O serviço privilegiado permanece exclusivamente no backend Edge Function.

alter table public.appointments
  add column admin_reviewed_by text,
  add column admin_reviewed_at timestamptz;

alter table public.appointments
  alter column status set default 'pending_payment',
  alter column payment_required set default true,
  alter column payment_status set default 'pending',
  alter column deposit_amount_cents set default 12500;

create table public.appointment_admin_audit (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id),
  actor_email text not null check (position('@' in actor_email) > 1),
  action text not null check (action in ('approve','cancel','edit','proof_marked','expire')),
  changed_fields text[] not null default '{}',
  previous_status text,
  resulting_status text,
  previous_slot_id uuid,
  resulting_slot_id uuid,
  created_at timestamptz not null default now()
);
alter table public.appointment_admin_audit enable row level security;
revoke all on public.appointment_admin_audit from public, anon, authenticated;
grant all on public.appointment_admin_audit to service_role;

create or replace function public.expire_pending_pix_appointments()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  with expired as (
    update public.appointments as a
       set status = 'expired', payment_status = 'expired', hold_expires_at = null
     where a.status = 'pending_payment'
       and a.hold_expires_at is not null
       and a.hold_expires_at <= now()
    returning a.id, a.slot_id
  ), released as (
    update public.availability_slots as s
       set status = 'available', hold_expires_at = null, active_appointment_id = null
      from expired as e
     where s.id = e.slot_id
       and s.active_appointment_id = e.id
       and s.status = 'held'
    returning s.id
  ), audited as (
    insert into public.appointment_admin_audit (
      appointment_id, actor_email, action, changed_fields,
      previous_status, resulting_status, previous_slot_id, resulting_slot_id
    )
    select e.id, 'sistema@basedermatologia.com.br', 'expire',
           array['status','payment_status'], 'pending_payment', 'expired', e.slot_id, e.slot_id
      from expired as e
    returning id
  )
  select count(*) into v_count from expired;
  return v_count;
end;
$$;
revoke all on function public.expire_pending_pix_appointments() from public, anon, authenticated;
grant execute on function public.expire_pending_pix_appointments() to service_role;

create or replace function public.book_appointment_for_pix(
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
  v_expiry timestamptz := now() + interval '2 hours';
begin
  if length(trim(coalesce(p_patient_name, ''))) not between 2 and 120
     or position('@' in coalesce(p_patient_email, '')) < 2
     or length(trim(coalesce(p_patient_phone, ''))) not between 8 and 22
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

  perform public.expire_pending_pix_appointments();
  select * into v_slot from public.availability_slots where id = p_slot_id for update;
  if not found then raise exception 'slot_not_found'; end if;
  if v_slot.status <> 'available' or v_slot.starts_at <= now() then
    raise exception 'slot_unavailable';
  end if;
  if not exists (
    select 1 from public.doctors where id = v_slot.doctor_id and is_active = true
  ) then raise exception 'doctor_inactive'; end if;

  insert into public.appointments (
    slot_id, doctor_id, patient_name, patient_email, patient_phone,
    patient_cpf, patient_address_line, patient_address_number,
    patient_address_complement, patient_address_neighborhood, patient_address_city,
    patient_address_state, patient_address_postal_code, access_token_hash,
    status, payment_required, payment_status, deposit_amount_cents,
    privacy_notice_version, privacy_accepted_at, hold_expires_at, confirmed_at
  ) values (
    v_slot.id, v_slot.doctor_id, trim(p_patient_name), lower(trim(p_patient_email)),
    trim(p_patient_phone), trim(p_patient_cpf), trim(p_patient_address_line),
    trim(p_patient_address_number), nullif(trim(coalesce(p_patient_address_complement, '')), ''),
    trim(p_patient_address_neighborhood), trim(p_patient_address_city),
    upper(trim(p_patient_address_state)), trim(p_patient_address_postal_code),
    p_access_token_hash, 'pending_payment', true, 'pending', 12500,
    trim(p_privacy_notice_version), now(), v_expiry, null
  ) returning id into v_booking_id;

  update public.availability_slots
     set status = 'held', hold_expires_at = v_expiry, active_appointment_id = v_booking_id
   where id = v_slot.id;
  return v_booking_id;
end;
$$;
revoke all on function public.book_appointment_for_pix(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.book_appointment_for_pix(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text) to service_role;

create or replace function public.mark_pix_proof_sent(
  p_appointment_id uuid,
  p_access_token_hash text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
begin
  perform public.expire_pending_pix_appointments();
  select * into v_appointment
    from public.appointments
   where id = p_appointment_id and access_token_hash = p_access_token_hash
   for update;
  if not found then raise exception 'booking_not_found'; end if;
  if v_appointment.status = 'payment_review' then return; end if;
  if v_appointment.status <> 'pending_payment' then raise exception 'booking_not_pending'; end if;
  update public.appointments
     set status = 'payment_review', payment_status = 'review', hold_expires_at = null
   where id = v_appointment.id;
  insert into public.appointment_admin_audit (
    appointment_id, actor_email, action, changed_fields,
    previous_status, resulting_status, previous_slot_id, resulting_slot_id
  ) values (
    v_appointment.id, lower(trim(v_appointment.patient_email)), 'proof_marked',
    array['status','payment_status'], v_appointment.status, 'payment_review',
    v_appointment.slot_id, v_appointment.slot_id
  );
  update public.availability_slots
     set hold_expires_at = null
   where id = v_appointment.slot_id
     and active_appointment_id = v_appointment.id
     and status = 'held';
  return;
end;
$$;
revoke all on function public.mark_pix_proof_sent(uuid,text) from public, anon, authenticated;
grant execute on function public.mark_pix_proof_sent(uuid,text) to service_role;

create or replace function public.admin_approve_pix_appointment(
  p_appointment_id uuid,
  p_actor_email text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_slot public.availability_slots%rowtype;
begin
  perform public.expire_pending_pix_appointments();
  select * into v_appointment from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'appointment_not_found'; end if;
  if v_appointment.status not in ('pending_payment','payment_review') then
    raise exception 'appointment_not_approvable';
  end if;
  select * into v_slot from public.availability_slots where id = v_appointment.slot_id for update;
  if not found or v_slot.status <> 'held' or v_slot.active_appointment_id <> v_appointment.id then
    raise exception 'appointment_slot_unavailable';
  end if;
  update public.appointments
     set status = 'confirmed', payment_status = 'received', confirmed_at = now(),
         hold_expires_at = null, admin_reviewed_by = lower(trim(p_actor_email)),
         admin_reviewed_at = now()
   where id = v_appointment.id;
  update public.availability_slots
     set status = 'booked', hold_expires_at = null
   where id = v_slot.id;
  insert into public.appointment_admin_audit (
    appointment_id, actor_email, action, changed_fields,
    previous_status, resulting_status, previous_slot_id, resulting_slot_id
  ) values (
    v_appointment.id, lower(trim(p_actor_email)), 'approve',
    array['status','payment_status','confirmed_at'], v_appointment.status,
    'confirmed', v_appointment.slot_id, v_appointment.slot_id
  );
end;
$$;
revoke all on function public.admin_approve_pix_appointment(uuid,text) from public, anon, authenticated;
grant execute on function public.admin_approve_pix_appointment(uuid,text) to service_role;

create or replace function public.admin_cancel_appointment(
  p_appointment_id uuid,
  p_actor_email text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_slot public.availability_slots%rowtype;
begin
  select * into v_appointment from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'appointment_not_found'; end if;
  if v_appointment.status in ('cancelled','expired') then return; end if;
  select * into v_slot from public.availability_slots where id = v_appointment.slot_id for update;
  update public.appointments
     set status = 'cancelled', hold_expires_at = null,
         admin_reviewed_by = lower(trim(p_actor_email)), admin_reviewed_at = now()
   where id = v_appointment.id;
  update public.availability_slots
     set status = 'available', hold_expires_at = null, active_appointment_id = null
   where id = v_appointment.slot_id and active_appointment_id = v_appointment.id;
  insert into public.appointment_admin_audit (
    appointment_id, actor_email, action, changed_fields,
    previous_status, resulting_status, previous_slot_id, resulting_slot_id
  ) values (
    v_appointment.id, lower(trim(p_actor_email)), 'cancel',
    array['status'], v_appointment.status, 'cancelled', v_appointment.slot_id, null
  );
end;
$$;
revoke all on function public.admin_cancel_appointment(uuid,text) from public, anon, authenticated;
grant execute on function public.admin_cancel_appointment(uuid,text) to service_role;

create or replace function public.admin_update_appointment(
  p_appointment_id uuid,
  p_actor_email text,
  p_changes jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_old_slot public.availability_slots%rowtype;
  v_new_slot public.availability_slots%rowtype;
  v_new_slot_id uuid;
  v_fields text[];
  v_key text;
  v_next_slot_status text;
begin
  if jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'invalid_changes';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key <> all(array[
      'patient_name','patient_email','patient_phone','patient_cpf',
      'patient_address_line','patient_address_number','patient_address_complement',
      'patient_address_neighborhood','patient_address_city','patient_address_state',
      'patient_address_postal_code','new_slot_id'
    ]) then raise exception 'invalid_changes'; end if;
  end loop;
  if p_changes ? 'patient_name' and length(trim(coalesce(p_changes->>'patient_name',''))) not between 2 and 120 then raise exception 'invalid_patient_name'; end if;
  if p_changes ? 'patient_email' and (length(coalesce(p_changes->>'patient_email','')) > 254 or (p_changes->>'patient_email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'invalid_patient_email'; end if;
  if p_changes ? 'patient_phone' and length(regexp_replace(coalesce(p_changes->>'patient_phone',''), '[^0-9]', '', 'g')) not between 10 and 13 then raise exception 'invalid_patient_phone'; end if;
  if p_changes ? 'patient_cpf' and coalesce(p_changes->>'patient_cpf','') !~ '^[0-9]{11}$' then raise exception 'invalid_patient_cpf'; end if;
  if p_changes ? 'patient_address_line' and length(trim(coalesce(p_changes->>'patient_address_line',''))) not between 2 and 160 then raise exception 'invalid_patient_address'; end if;
  if p_changes ? 'patient_address_number' and length(trim(coalesce(p_changes->>'patient_address_number',''))) not between 1 and 20 then raise exception 'invalid_patient_address'; end if;
  if p_changes ? 'patient_address_complement' and length(coalesce(p_changes->>'patient_address_complement','')) > 100 then raise exception 'invalid_patient_address'; end if;
  if p_changes ? 'patient_address_neighborhood' and length(trim(coalesce(p_changes->>'patient_address_neighborhood',''))) not between 2 and 80 then raise exception 'invalid_patient_address'; end if;
  if p_changes ? 'patient_address_city' and length(trim(coalesce(p_changes->>'patient_address_city',''))) not between 2 and 80 then raise exception 'invalid_patient_address'; end if;
  if p_changes ? 'patient_address_state' and upper(trim(coalesce(p_changes->>'patient_address_state',''))) !~ '^[A-Z]{2}$' then raise exception 'invalid_patient_address'; end if;
  if p_changes ? 'patient_address_postal_code' and coalesce(p_changes->>'patient_address_postal_code','') !~ '^[0-9]{8}$' then raise exception 'invalid_patient_address'; end if;
  if p_changes ? 'new_slot_id' then
    begin v_new_slot_id := (p_changes->>'new_slot_id')::uuid;
    exception when others then raise exception 'invalid_slot_id'; end;
  end if;

  perform public.expire_pending_pix_appointments();
  select * into v_appointment from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'appointment_not_found'; end if;

  if v_new_slot_id is not null and v_new_slot_id <> v_appointment.slot_id then
    if v_appointment.status not in ('pending_payment','payment_review','confirmed') then
      raise exception 'appointment_not_reschedulable';
    end if;
    select * into v_old_slot from public.availability_slots where id = v_appointment.slot_id for update;
    select * into v_new_slot from public.availability_slots where id = v_new_slot_id for update;
    if not found or v_new_slot.status <> 'available' or v_new_slot.starts_at <= now() then
      raise exception 'new_slot_unavailable';
    end if;
    if not exists (select 1 from public.doctors where id = v_new_slot.doctor_id and is_active) then
      raise exception 'doctor_inactive';
    end if;
    update public.availability_slots
       set status = 'available', hold_expires_at = null, active_appointment_id = null
     where id = v_old_slot.id and active_appointment_id = v_appointment.id;
    v_next_slot_status := case when v_appointment.status = 'confirmed' then 'booked' else 'held' end;
    update public.availability_slots
       set status = v_next_slot_status,
           hold_expires_at = case when v_appointment.status = 'pending_payment' then v_appointment.hold_expires_at else null end,
           active_appointment_id = v_appointment.id
     where id = v_new_slot.id;
  end if;

  update public.appointments as a set
    patient_name = case when p_changes ? 'patient_name' then trim(p_changes->>'patient_name') else a.patient_name end,
    patient_email = case when p_changes ? 'patient_email' then lower(trim(p_changes->>'patient_email')) else a.patient_email end,
    patient_phone = case when p_changes ? 'patient_phone' then trim(p_changes->>'patient_phone') else a.patient_phone end,
    patient_cpf = case when p_changes ? 'patient_cpf' then p_changes->>'patient_cpf' else a.patient_cpf end,
    patient_address_line = case when p_changes ? 'patient_address_line' then trim(p_changes->>'patient_address_line') else a.patient_address_line end,
    patient_address_number = case when p_changes ? 'patient_address_number' then trim(p_changes->>'patient_address_number') else a.patient_address_number end,
    patient_address_complement = case when p_changes ? 'patient_address_complement' then nullif(trim(coalesce(p_changes->>'patient_address_complement','')), '') else a.patient_address_complement end,
    patient_address_neighborhood = case when p_changes ? 'patient_address_neighborhood' then trim(p_changes->>'patient_address_neighborhood') else a.patient_address_neighborhood end,
    patient_address_city = case when p_changes ? 'patient_address_city' then trim(p_changes->>'patient_address_city') else a.patient_address_city end,
    patient_address_state = case when p_changes ? 'patient_address_state' then upper(trim(p_changes->>'patient_address_state')) else a.patient_address_state end,
    patient_address_postal_code = case when p_changes ? 'patient_address_postal_code' then p_changes->>'patient_address_postal_code' else a.patient_address_postal_code end,
    slot_id = case when v_new_slot_id is not null and v_new_slot_id <> v_appointment.slot_id then v_new_slot.id else a.slot_id end,
    doctor_id = case when v_new_slot_id is not null and v_new_slot_id <> v_appointment.slot_id then v_new_slot.doctor_id else a.doctor_id end
  where a.id = v_appointment.id;

  select array_agg(case when field = 'new_slot_id' then 'slot_id' else field end order by field)
    into v_fields from jsonb_object_keys(p_changes) as fields(field);
  insert into public.appointment_admin_audit (
    appointment_id, actor_email, action, changed_fields,
    previous_status, resulting_status, previous_slot_id, resulting_slot_id
  ) values (
    v_appointment.id, lower(trim(p_actor_email)), 'edit', v_fields,
    v_appointment.status, v_appointment.status, v_appointment.slot_id,
    case when v_new_slot_id is not null and v_new_slot_id <> v_appointment.slot_id then v_new_slot.id else v_appointment.slot_id end
  );
end;
$$;
revoke all on function public.admin_update_appointment(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.admin_update_appointment(uuid,text,jsonb) to service_role;

create index if not exists appointments_status_created_at_idx
  on public.appointments(status, created_at desc);
create index if not exists appointments_created_at_idx
  on public.appointments(created_at desc);

create or replace function public.admin_search_appointments(
  p_status text,
  p_search text,
  p_offset integer,
  p_limit integer
) returns table (
  id uuid,
  slot_id uuid,
  doctor_id uuid,
  patient_name text,
  patient_email text,
  patient_phone text,
  patient_cpf text,
  patient_address_line text,
  patient_address_number text,
  patient_address_complement text,
  patient_address_neighborhood text,
  patient_address_city text,
  patient_address_state text,
  patient_address_postal_code text,
  status text,
  payment_status text,
  payment_required boolean,
  deposit_amount_cents integer,
  created_at timestamptz,
  confirmed_at timestamptz,
  hold_expires_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  doctor_name text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.slot_id, a.doctor_id,
         a.patient_name, a.patient_email, a.patient_phone, a.patient_cpf,
         a.patient_address_line, a.patient_address_number, a.patient_address_complement,
         a.patient_address_neighborhood, a.patient_address_city, a.patient_address_state,
         a.patient_address_postal_code, a.status, a.payment_status, a.payment_required,
         a.deposit_amount_cents, a.created_at, a.confirmed_at, a.hold_expires_at,
         s.starts_at, s.ends_at, d.display_name
    from public.appointments as a
    join public.availability_slots as s on s.id = a.slot_id
    join public.doctors as d on d.id = a.doctor_id
   where (p_status is null or a.status = p_status)
     and (coalesce(trim(p_search), '') = ''
       or a.id::text ilike lower(trim(p_search)) || '%'
       or a.patient_name ilike '%' || trim(p_search) || '%'
       or a.patient_email ilike '%' || trim(p_search) || '%'
       or (regexp_replace(coalesce(trim(p_search), ''), '[^0-9]', '', 'g') <> ''
           and regexp_replace(a.patient_phone, '[^0-9]', '', 'g') like '%' || regexp_replace(trim(p_search), '[^0-9]', '', 'g') || '%'))
   order by a.created_at desc
   offset greatest(0, least(coalesce(p_offset,0), 100000))
   limit greatest(1, least(coalesce(p_limit,50), 100));
$$;
revoke all on function public.admin_search_appointments(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.admin_search_appointments(text,text,integer,integer) to service_role;

-- Evita que o RPC legado continue a confirmar reservas sem o novo fluxo Pix.
revoke all on function public.book_appointment_without_payment(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text) from service_role;
