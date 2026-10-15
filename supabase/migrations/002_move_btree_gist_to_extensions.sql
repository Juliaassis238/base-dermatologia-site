-- Mantém a extensão de suporte à restrição de horários fora do schema público.
create schema if not exists extensions;
alter extension btree_gist set schema extensions;
