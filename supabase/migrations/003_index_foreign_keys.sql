-- Índices para manter consultas e relacionamentos eficientes conforme a agenda crescer.
create index if not exists appointments_doctor_id_idx on public.appointments(doctor_id);
create index if not exists availability_slots_active_appointment_id_idx on public.availability_slots(active_appointment_id);
create index if not exists payments_appointment_id_idx on public.payments(appointment_id);
