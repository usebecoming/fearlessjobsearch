-- Fearless Job Search: Database Setup
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Profiles table (stores resume text per user)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  resume_text text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "Users can view own profile"
  on profiles for select using (auth.uid() = id);

create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);

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

alter table pipeline enable row level security;

create policy "Users can view own pipeline"
  on pipeline for select using (auth.uid() = user_id);

create policy "Users can insert own pipeline"
  on pipeline for insert with check (auth.uid() = user_id);

create policy "Users can update own pipeline"
  on pipeline for update using (auth.uid() = user_id);

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

create policy "Users can view own favorites"
  on favorites for select using (auth.uid() = user_id);

create policy "Users can insert own favorites"
  on favorites for insert with check (auth.uid() = user_id);

create policy "Users can delete own favorites"
  on favorites for delete using (auth.uid() = user_id);

-- 4. Auto-create profile on signup
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
