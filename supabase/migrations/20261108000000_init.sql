-- NutriScan · esquema inicial
-- Ejecutar en Supabase (SQL Editor) o con `supabase db push`.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────
-- PERFILES
-- ─────────────────────────────────────────────
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  display_name   text,
  age            int check (age is null or (age between 14 and 120)),
  sex            text check (sex is null or sex in ('female','male','other')),
  weight_kg      numeric(5,1) check (weight_kg is null or weight_kg between 20 and 400),
  height_cm      numeric(5,1) check (height_cm is null or height_cm between 100 and 250),
  activity       text default 'moderate' check (activity in ('sedentary','light','moderate','active','very_active')),
  goal           text default 'maintain' check (goal in ('maintain','gain','lose_gradual','health')),
  diet_prefs     text[] default '{}',
  allergies      text[] default '{}',
  likes          text default '',
  dislikes       text default '',
  medical_flag   boolean default false,
  kcal_goal      int default 2000 check (kcal_goal between 800 and 6000),
  protein_goal   int default 75,
  carbs_goal     int default 250,
  fat_goal       int default 70,
  fiber_goal     int default 28,
  water_goal_ml  int default 2000,
  onboarded      boolean default false,
  settings       jsonb default '{}'::jsonb,
  health_consent_at timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- ─────────────────────────────────────────────
-- COMIDAS
-- items: [{ name, grams, per100g:{kcal,protein,carbs,fat,sat_fat,fiber,sugar,sodium_mg}, source, confidence }]
-- ─────────────────────────────────────────────
create table if not exists public.meals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  meal_type   text not null check (meal_type in ('breakfast','lunch','snack','dinner')),
  eaten_at    timestamptz not null default now(),
  title       text,
  photo_path  text,
  items       jsonb not null default '[]'::jsonb,
  kcal        numeric(8,1) default 0,
  protein     numeric(7,1) default 0,
  carbs       numeric(7,1) default 0,
  fat         numeric(7,1) default 0,
  sat_fat     numeric(7,1) default 0,
  fiber       numeric(7,1) default 0,
  sugar       numeric(7,1) default 0,
  sodium_mg   numeric(8,1) default 0,
  source      text default 'ai' check (source in ('ai','manual')),
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists meals_user_eaten_idx on public.meals (user_id, eaten_at desc);

-- ─────────────────────────────────────────────
-- AGUA
-- ─────────────────────────────────────────────
create table if not exists public.water_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ml         int not null check (ml between 1 and 3000),
  logged_at  timestamptz not null default now()
);
create index if not exists water_user_logged_idx on public.water_logs (user_id, logged_at desc);

-- ─────────────────────────────────────────────
-- CLAVES DE IA (cifradas). Sin políticas RLS:
-- solo la Edge Function (service role) puede leerlas.
-- ─────────────────────────────────────────────
create table if not exists public.ai_credentials (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  provider       text not null default 'anthropic',
  key_ciphertext text not null,
  key_iv         text not null,
  key_hint       text not null,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- ─────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────
alter table public.profiles       enable row level security;
alter table public.meals          enable row level security;
alter table public.water_logs     enable row level security;
alter table public.ai_credentials enable row level security;

drop policy if exists "profiles_own" on public.profiles;
create policy "profiles_own" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "meals_own" on public.meals;
create policy "meals_own" on public.meals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "water_own" on public.water_logs;
create policy "water_own" on public.water_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ai_credentials: ninguna política → inaccesible desde el cliente.
revoke all on public.ai_credentials from anon, authenticated;

-- ─────────────────────────────────────────────
-- updated_at automático
-- ─────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
drop trigger if exists meals_touch on public.meals;
create trigger meals_touch before update on public.meals
  for each row execute function public.touch_updated_at();

-- Perfil automático al registrarse
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, health_consent_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    case when (new.raw_user_meta_data->>'health_consent') = 'true' then now() end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────
-- STORAGE: fotos privadas por usuario (carpeta = uid)
-- ─────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meal-photos', 'meal-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "photos_select_own" on storage.objects;
create policy "photos_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos_insert_own" on storage.objects;
create policy "photos_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos_update_own" on storage.objects;
create policy "photos_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos_delete_own" on storage.objects;
create policy "photos_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
