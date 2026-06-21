create extension if not exists pgcrypto;

create table if not exists video_batches (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  target_language text not null,
  expected_video_count integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table video_batches add column if not exists title text;
alter table video_batches add column if not exists target_language text;
alter table video_batches add column if not exists expected_video_count integer;
alter table video_batches add column if not exists created_at timestamptz default now();
alter table video_batches add column if not exists updated_at timestamptz default now();

update video_batches set title = 'Video upload' where title is null;
update video_batches set target_language = 'zh' where target_language is null;
update video_batches
set expected_video_count = 1
where expected_video_count is null;
update video_batches set created_at = now() where created_at is null;
update video_batches set updated_at = now() where updated_at is null;

alter table video_batches alter column title set not null;
alter table video_batches alter column target_language set not null;
alter table video_batches alter column expected_video_count set not null;
alter table video_batches alter column created_at set default now();
alter table video_batches alter column created_at set not null;
alter table video_batches alter column updated_at set default now();
alter table video_batches alter column updated_at set not null;

alter table videos add column if not exists batch_id uuid;
alter table videos add column if not exists batch_position integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.videos'::regclass
      and conname = 'videos_batch_id_fkey'
  ) then
    alter table videos
      add constraint videos_batch_id_fkey
      foreign key (batch_id)
      references video_batches(id)
      on delete set null;
  end if;
end $$;

create index if not exists videos_batch_id_batch_position_idx
  on videos(batch_id, batch_position);

create unique index if not exists videos_batch_id_batch_position_unique_idx
  on videos(batch_id, batch_position)
  where batch_id is not null and batch_position is not null;
