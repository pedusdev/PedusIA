-- =====================================================================
-- PedusGPT — Esquema completo de Supabase
-- Ejecuta este archivo ENTERO en: Supabase → SQL Editor → New query → Run
-- Es idempotente: puedes volver a ejecutarlo sin romper nada.
--
-- Mejoras respecto al esquema base:
--  * Las políticas de admin usan una función SECURITY DEFINER (is_admin)
--    para evitar el error "infinite recursion detected in policy".
--  * Un trigger impide que un usuario se cambie a sí mismo el rol, el
--    baneo o los contadores usando la anon key directamente.
--  * Incremento ATÓMICO del contador diario de PRO ULTRA (sin carreras).
--  * Columnas extra: default_model, last_seen_at, file_text, extracted_text.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- TABLAS
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
    id uuid references auth.users(id) on delete cascade primary key,
    email text not null,
    display_name text default 'Usuario',
    avatar_url text default null,
    bio text default '',
    favorite_animal text default '',
    interests text default '',
    role text default 'user' check (role in ('user', 'max', 'admin', 'owner')),
    daily_405b_requests integer default 0,
    last_405b_reset date default ((now() at time zone 'utc')::date),
    preferred_language text default 'es',
    preferred_theme text default 'light',
    default_model text default 'pedus-gpt-2',
    is_banned boolean default false,
    ban_reason text default null,
    last_seen_at timestamptz default null,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- Columnas nuevas (por si la tabla ya existía con el esquema base)
alter table public.profiles add column if not exists default_model text default 'pedus-gpt-2';
alter table public.profiles add column if not exists last_seen_at timestamptz default null;
-- Contador diario de PedusCode (agente de código, Plan MAX)
alter table public.profiles add column if not exists daily_code_runs integer default 0;
alter table public.profiles add column if not exists last_code_reset date default ((now() at time zone 'utc')::date);

create table if not exists public.conversations (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references public.profiles(id) on delete cascade,
    title text default 'Nueva conversación',
    model_used text default 'pedus-gpt-2',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table if not exists public.messages (
    id uuid default gen_random_uuid() primary key,
    conversation_id uuid references public.conversations(id) on delete cascade,
    role text not null check (role in ('user', 'assistant', 'system')),
    content text not null,
    file_url text default null,
    file_type text default null,
    file_name text default null,
    file_text text default null,        -- texto extraído del PDF/TXT adjunto (contexto del modelo)
    liked boolean default null,
    created_at timestamptz default now()
);
alter table public.messages add column if not exists file_text text default null;

create table if not exists public.uploaded_files (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references public.profiles(id) on delete cascade,
    message_id uuid references public.messages(id) on delete cascade,
    file_name text not null,
    file_url text not null,
    file_type text not null,
    file_size integer,
    extracted_text text default null,
    created_at timestamptz default now()
);
alter table public.uploaded_files add column if not exists extracted_text text default null;

-- Índices
create index if not exists idx_conversations_user_updated on public.conversations (user_id, updated_at desc);
create index if not exists idx_messages_conversation_created on public.messages (conversation_id, created_at);
create index if not exists idx_uploaded_files_user on public.uploaded_files (user_id);
create index if not exists idx_profiles_role on public.profiles (role);
create index if not exists idx_profiles_last_seen on public.profiles (last_seen_at);

-- ---------------------------------------------------------------------
-- FUNCIONES AUXILIARES
-- ---------------------------------------------------------------------

-- ¿El usuario actual es admin u owner? (SECURITY DEFINER evita recursión en RLS)
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid() and role in ('admin', 'owner')
    );
$$;

-- updated_at automático
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- Protege columnas sensibles: un usuario normal (anon/authenticated) no puede
-- cambiar su rol, baneo, contadores ni email. El backend usa la service key.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
as $$
begin
    if current_user in ('anon', 'authenticated') then
        new.role := old.role;
        new.is_banned := old.is_banned;
        new.ban_reason := old.ban_reason;
        new.daily_405b_requests := old.daily_405b_requests;
        new.last_405b_reset := old.last_405b_reset;
        new.daily_code_runs := old.daily_code_runs;
        new.last_code_reset := old.last_code_reset;
        new.email := old.email;
        new.id := old.id;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists protect_profile_columns on public.profiles;
create trigger protect_profile_columns
    before update on public.profiles
    for each row execute function public.protect_profile_columns();

drop trigger if exists conversations_updated_at on public.conversations;
create trigger conversations_updated_at
    before update on public.conversations
    for each row
    when (new.updated_at is not distinct from old.updated_at)
    execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- PERMISOS DE LA DATA API (obligatorio desde 2026)
-- Supabase ya no da permisos automáticos sobre las tablas nuevas de
-- "public" (proyectos nuevos desde el 30/05/2026 y todos desde el
-- 30/10/2026). Sin esto el backend recibe: "permission denied for table".
-- El backend usa la secret key (rol service_role) para todo; el navegador
-- nunca lee las tablas directamente, así que anon/authenticated no
-- necesitan acceso (más seguro).
-- ---------------------------------------------------------------------
grant usage on schema public to service_role;
grant select, insert, update, delete on table
    public.profiles, public.conversations, public.messages, public.uploaded_files
    to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on table
    public.profiles, public.conversations, public.messages, public.uploaded_files
    from anon, authenticated;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.uploaded_files enable row level security;

-- Perfiles
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile" on public.profiles
    for select using (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
    for update using (auth.uid() = id);

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles" on public.profiles
    for select using (public.is_admin());

-- (Las modificaciones de admin pasan por el backend con la service key,
--  que aplica las reglas de jerarquía. No se permite UPDATE directo de admins.)
drop policy if exists "Admins can update all profiles" on public.profiles;

-- Conversaciones
drop policy if exists "Users can view own conversations" on public.conversations;
create policy "Users can view own conversations" on public.conversations
    for select using (auth.uid() = user_id);

drop policy if exists "Users can create conversations" on public.conversations;
create policy "Users can create conversations" on public.conversations
    for insert with check (auth.uid() = user_id);

drop policy if exists "Users can delete own conversations" on public.conversations;
create policy "Users can delete own conversations" on public.conversations
    for delete using (auth.uid() = user_id);

drop policy if exists "Users can update own conversations" on public.conversations;
create policy "Users can update own conversations" on public.conversations
    for update using (auth.uid() = user_id);

-- Mensajes
drop policy if exists "Users can view own messages" on public.messages;
create policy "Users can view own messages" on public.messages
    for select using (
        conversation_id in (select id from public.conversations where user_id = auth.uid())
    );

drop policy if exists "Users can create messages" on public.messages;
create policy "Users can create messages" on public.messages
    for insert with check (
        conversation_id in (select id from public.conversations where user_id = auth.uid())
    );

drop policy if exists "Users can update own messages" on public.messages;
create policy "Users can update own messages" on public.messages
    for update using (
        conversation_id in (select id from public.conversations where user_id = auth.uid())
    );

drop policy if exists "Users can delete own messages" on public.messages;
create policy "Users can delete own messages" on public.messages
    for delete using (
        conversation_id in (select id from public.conversations where user_id = auth.uid())
    );

-- Archivos
drop policy if exists "Users can view own files" on public.uploaded_files;
create policy "Users can view own files" on public.uploaded_files
    for select using (auth.uid() = user_id);

drop policy if exists "Users can create own files" on public.uploaded_files;
create policy "Users can create own files" on public.uploaded_files
    for insert with check (auth.uid() = user_id);

drop policy if exists "Users can delete own files" on public.uploaded_files;
create policy "Users can delete own files" on public.uploaded_files
    for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- PERFIL AUTOMÁTICO AL REGISTRARSE (email o Google)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, email, display_name, avatar_url)
    values (
        new.id,
        new.email,
        coalesce(
            nullif(new.raw_user_meta_data->>'full_name', ''),
            nullif(new.raw_user_meta_data->>'name', ''),
            split_part(new.email, '@', 1)
        ),
        coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- LÍMITE DIARIO DE PEDUSGPT 2 PRO ULTRA (reinicio 00:00 UTC)
-- ---------------------------------------------------------------------

-- Consume 1 petición de forma atómica. Devuelve el nuevo contador,
-- o -1 si el usuario ya alcanzó el límite de hoy.
create or replace function public.consume_405b_request(p_user_id uuid, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_today date := (now() at time zone 'utc')::date;
    v_count integer;
begin
    update public.profiles
    set daily_405b_requests = case
            when last_405b_reset is null or last_405b_reset < v_today then 1
            else daily_405b_requests + 1
        end,
        last_405b_reset = v_today
    where id = p_user_id
      and (last_405b_reset is null or last_405b_reset < v_today or daily_405b_requests < p_limit)
    returning daily_405b_requests into v_count;

    if not found then
        return -1;
    end if;
    return v_count;
end;
$$;

-- Devuelve una petición (si Groq falló antes de responder)
create or replace function public.refund_405b_request(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.profiles
    set daily_405b_requests = greatest(0, daily_405b_requests - 1)
    where id = p_user_id
      and last_405b_reset = (now() at time zone 'utc')::date;
end;
$$;

-- Resetea todos los contadores de días anteriores
create or replace function public.reset_daily_405b_requests()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.profiles
    set daily_405b_requests = 0,
        last_405b_reset = (now() at time zone 'utc')::date
    where last_405b_reset < (now() at time zone 'utc')::date;
end;
$$;

-- Solo el backend (service_role) puede ejecutar estas funciones
revoke execute on function public.consume_405b_request(uuid, integer) from public, anon, authenticated;
revoke execute on function public.refund_405b_request(uuid) from public, anon, authenticated;
revoke execute on function public.reset_daily_405b_requests() from public, anon, authenticated;
grant execute on function public.consume_405b_request(uuid, integer) to service_role;
grant execute on function public.refund_405b_request(uuid) to service_role;
grant execute on function public.reset_daily_405b_requests() to service_role;

-- ---------------------------------------------------------------------
-- LÍMITE DIARIO DE PEDUSCODE (reinicio 00:00 UTC)
-- ---------------------------------------------------------------------

-- Consume 1 ejecución de forma atómica. Devuelve el nuevo contador,
-- o -1 si el usuario ya alcanzó el límite de hoy.
create or replace function public.consume_code_run(p_user_id uuid, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_today date := (now() at time zone 'utc')::date;
    v_count integer;
begin
    update public.profiles
    set daily_code_runs = case
            when last_code_reset is null or last_code_reset < v_today then 1
            else coalesce(daily_code_runs, 0) + 1
        end,
        last_code_reset = v_today
    where id = p_user_id
      and (last_code_reset is null or last_code_reset < v_today or coalesce(daily_code_runs, 0) < p_limit)
    returning daily_code_runs into v_count;

    if not found then
        return -1;
    end if;
    return v_count;
end;
$$;

-- Devuelve una ejecución (si el organizador falló y no se hizo nada)
create or replace function public.refund_code_run(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.profiles
    set daily_code_runs = greatest(0, coalesce(daily_code_runs, 0) - 1)
    where id = p_user_id
      and last_code_reset = (now() at time zone 'utc')::date;
end;
$$;

revoke execute on function public.consume_code_run(uuid, integer) from public, anon, authenticated;
revoke execute on function public.refund_code_run(uuid) from public, anon, authenticated;
grant execute on function public.consume_code_run(uuid, integer) to service_role;
grant execute on function public.refund_code_run(uuid) to service_role;

-- (Opcional) Reset programado a las 00:00 UTC con pg_cron.
-- No es imprescindible: el backend ya reinicia el contador al detectar un día nuevo.
-- Activa la extensión pg_cron en Database → Extensions y descomenta:
-- select cron.schedule('reset-405b-daily', '0 0 * * *', $$select public.reset_daily_405b_requests();$$);

-- ---------------------------------------------------------------------
-- STORAGE: buckets para avatares y archivos del chat
-- (rutas con UUID aleatorio, imposibles de adivinar; el backend sube con la service key)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
    ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    ('uploads', 'uploads', true, 10485760, array[
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'application/pdf', 'text/plain', 'text/markdown', 'text/csv'
    ])
on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- OWNER (alternativa a la variable OWNER_EMAIL): descomenta y pon tu email
-- ---------------------------------------------------------------------
-- update public.profiles set role = 'owner' where email = 'tu-email@ejemplo.com';
