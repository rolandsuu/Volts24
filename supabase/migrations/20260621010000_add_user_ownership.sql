alter table video_batches
  add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table videos
  add column if not exists user_id uuid references auth.users(id) on delete set null;

update videos
set user_id = video_batches.user_id
from video_batches
where videos.batch_id = video_batches.id
  and videos.user_id is null
  and video_batches.user_id is not null;

create index if not exists video_batches_user_id_updated_at_idx
  on video_batches(user_id, updated_at desc);

create index if not exists videos_user_id_updated_at_idx
  on videos(user_id, updated_at desc);
