-- Fearless Job Search: Database Setup
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Profiles table (stores resume text, plan, usage per user)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  resume_text text default '',
  plan text default 'free',
  stripe_customer_id text default '',
  subscription_status text default '',
  search_count_month int default 0,
  search_reset_date timestamptz default null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Add columns if table already exists
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name='profiles' and column_name='plan') then
    alter table profiles add column plan text default 'free';
  end if;
  if not exists (select 1 from information_schema.columns where table_name='profiles' and column_name='stripe_customer_id') then
    alter table profiles add column stripe_customer_id text default '';
  end if;
  if not exists (select 1 from information_schema.columns where table_name='profiles' and column_name='subscription_status') then
    alter table profiles add column subscription_status text default '';
  end if;
  if not exists (select 1 from information_schema.columns where table_name='profiles' and column_name='search_count_month') then
    alter table profiles add column search_count_month int default 0;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='profiles' and column_name='search_reset_date') then
    alter table profiles add column search_reset_date timestamptz default null;
  end if;
end $$;

alter table profiles enable row level security;

drop policy if exists "Users can view own profile" on profiles;
create policy "Users can view own profile"
  on profiles for select using (auth.uid() = id);

drop policy if exists "Users can insert own profile" on profiles;
create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);

drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

-- 2. Pipeline table
create table if not exists pipeline (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  job_id text not null,
  title text not null,
  company text not null,
  location text default '',
  fit_score int default 50,
  status text default 'Researching',
  added_at date default current_date,
  created_at timestamptz default now()
);

-- Add columns if table already exists
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name='pipeline' and column_name='salary') then
    alter table pipeline add column salary text default '';
  end if;
  if not exists (select 1 from information_schema.columns where table_name='pipeline' and column_name='job_url') then
    alter table pipeline add column job_url text default '';
  end if;
end $$;

-- Unique constraint to prevent duplicates
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'unique_user_job') then
    alter table pipeline add constraint unique_user_job unique (user_id, title, company);
  end if;
end $$;

alter table pipeline enable row level security;

drop policy if exists "Users can view own pipeline" on pipeline;
create policy "Users can view own pipeline"
  on pipeline for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own pipeline" on pipeline;
create policy "Users can insert own pipeline"
  on pipeline for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own pipeline" on pipeline;
create policy "Users can update own pipeline"
  on pipeline for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own pipeline" on pipeline;
create policy "Users can delete own pipeline"
  on pipeline for delete using (auth.uid() = user_id);

-- 3. Favorites table
create table if not exists favorites (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  title text not null,
  company text not null,
  industry text default '',
  location text default '',
  fit_score int default 50,
  highlights text[] default '{}',
  created_at timestamptz default now()
);

alter table favorites enable row level security;

drop policy if exists "Users can view own favorites" on favorites;
create policy "Users can view own favorites"
  on favorites for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own favorites" on favorites;
create policy "Users can insert own favorites"
  on favorites for insert with check (auth.uid() = user_id);

drop policy if exists "Users can delete own favorites" on favorites;
create policy "Users can delete own favorites"
  on favorites for delete using (auth.uid() = user_id);

-- 4. Search profiles table
create table if not exists search_profiles (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  name text not null,
  titles text[] default '{}',
  locations text[] default '{}',
  work_types text[] default '{}',
  salary_min text default '',
  salary_max text default '',
  anchors text[] default '{}',
  created_at timestamptz default now()
);

alter table search_profiles enable row level security;

drop policy if exists "Users can view own search profiles" on search_profiles;
create policy "Users can view own search profiles"
  on search_profiles for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own search profiles" on search_profiles;
create policy "Users can insert own search profiles"
  on search_profiles for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own search profiles" on search_profiles;
create policy "Users can update own search profiles"
  on search_profiles for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own search profiles" on search_profiles;
create policy "Users can delete own search profiles"
  on search_profiles for delete using (auth.uid() = user_id);

-- 5. Usage tracking table
create table if not exists usage_log (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade,
  action text not null,
  details jsonb default '{}',
  created_at timestamptz default now()
);

alter table usage_log enable row level security;

drop policy if exists "Users can view own usage" on usage_log;
create policy "Users can view own usage"
  on usage_log for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own usage" on usage_log;
create policy "Users can insert own usage"
  on usage_log for insert with check (auth.uid() = user_id);

-- Admin can view all usage (add your user ID here)
drop policy if exists "Admin can view all usage" on usage_log;
create policy "Admin can view all usage"
  on usage_log for select using (true);

-- 6. Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
