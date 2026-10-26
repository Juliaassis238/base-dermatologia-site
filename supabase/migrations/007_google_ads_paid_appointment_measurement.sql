-- Atribuição opcional de cliques e outbox de conversões pagas.
-- Nenhum dado de paciente é copiado para a outbox; entradas de teste permanecem em outra tabela.

alter table public.appointments
  add column measurement_consent boolean not null default false,
  add column measurement_consent_at timestamptz,
  add column ads_click_identifier_type text,
  add column ads_click_identifier text,
  add constraint appointments_ads_identifier_type_check
    check (ads_click_identifier_type is null or ads_click_identifier_type in ('gclid','gbraid','wbraid')),
  add constraint appointments_ads_identifier_pair_check
    check ((ads_click_identifier_type is null) = (ads_click_identifier is null)),
  add constraint appointments_ads_identifier_consent_check
    check (ads_click_identifier is null or measurement_consent);

create table public.google_ads_conversion_outbox (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references public.appointments(id),
  click_identifier_type text not null check (click_identifier_type in ('gclid','gbraid','wbraid')),
  click_identifier text not null check (length(click_identifier) between 1 and 512),
  event_name text not null default 'paid_dermatology_appointment' check (event_name = 'paid_dermatology_appointment'),
  event_timestamp timestamptz not null,
  conversion_value_cents integer not null check (conversion_value_cents > 0),
  currency text not null default 'BRL' check (currency = 'BRL'),
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0)
);

alter table public.google_ads_conversion_outbox enable row level security;
revoke all on public.google_ads_conversion_outbox from public, anon, authenticated;
grant all on public.google_ads_conversion_outbox to service_role;

create or replace function public.record_ad_measurement_consent(
  p_appointment_id uuid,
  p_access_token_hash text,
  p_identifier_type text,
  p_identifier text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
begin
  if (p_identifier_type is null) <> (p_identifier is null)
     or (p_identifier_type is not null and p_identifier_type not in ('gclid','gbraid','wbraid'))
     or (p_identifier is not null and (length(p_identifier) not between 1 and 512
       or p_identifier !~ '^[A-Za-z0-9._~+/-]+$')) then
    raise exception 'invalid_ad_identifier';
  end if;

  select * into v_appointment
    from public.appointments
   where id = p_appointment_id
     and access_token_hash = p_access_token_hash
   for update;
  if not found then raise exception 'booking_not_found'; end if;
  if v_appointment.status <> 'pending_payment'
     or v_appointment.payment_status <> 'pending' then
    raise exception 'booking_not_pending';
  end if;

  update public.appointments
     set measurement_consent = true,
         measurement_consent_at = now(),
         ads_click_identifier_type = p_identifier_type,
         ads_click_identifier = p_identifier
   where id = v_appointment.id;
end;
$$;
revoke all on function public.record_ad_measurement_consent(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.record_ad_measurement_consent(uuid,text,text,text) to service_role;

create or replace function public.enqueue_paid_appointment_conversion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status is distinct from 'confirmed'
     and new.status = 'confirmed'
     and new.payment_status = 'received'
     and new.payment_required = true
     and new.deposit_amount_cents = 12500
     and new.measurement_consent = true
     and new.measurement_consent_at is not null
     and new.ads_click_identifier_type is not null
     and new.ads_click_identifier is not null then
    insert into public.google_ads_conversion_outbox (
      appointment_id, click_identifier_type, click_identifier,
      event_name, event_timestamp, conversion_value_cents, currency
    ) values (
      new.id, new.ads_click_identifier_type, new.ads_click_identifier,
      'paid_dermatology_appointment', coalesce(new.confirmed_at, now()),
      new.deposit_amount_cents, 'BRL'
    )
    on conflict (appointment_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.enqueue_paid_appointment_conversion() from public, anon, authenticated;

create trigger appointments_enqueue_paid_conversion
  after update of status, payment_status on public.appointments
  for each row execute function public.enqueue_paid_appointment_conversion();
