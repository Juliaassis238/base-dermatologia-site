-- Registros de teste da agenda, separados de appointments e availability_slots.
-- Não ocupam horários, não representam pacientes e não registram pagamentos reais.
create table if not exists public.agenda_test_entries (
  id uuid primary key default gen_random_uuid(),
  test_name text not null check (test_name in ('teste1', 'teste2')),
  doctor_name text not null check (doctor_name in ('Mariana Gil Furlanetti', 'Jéssica Saab')),
  test_date date not null,
  amount_cents integer not null check (amount_cents = 1),
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'payment_review', 'confirmed', 'cancelled')),
  is_test boolean not null default true check (is_test is true),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (test_name, test_date)
);

alter table public.agenda_test_entries enable row level security;
revoke all on public.agenda_test_entries from public, anon, authenticated;
grant all on public.agenda_test_entries to service_role;
