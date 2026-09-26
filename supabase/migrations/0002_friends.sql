-- ===========================================================================
-- supabase/migrations/0002_friends.sql — friends on the Lantern hub.
-- ---------------------------------------------------------------------------
-- Run after 0001 (SQL Editor → New query → paste → Run). Safe to run again.
-- A new hub can paste supabase/lantern_hub_all.sql instead, which is 0001 and
-- this file together.
--
-- What it adds:
--   * every person gets a short FRIEND CODE (like LNT-7K3Q) they can share
--   * who can find you: by your exact email or friend code (always), and by
--     your name only if you turn that on. The owner can see everyone anyway.
--   * FRIEND REQUESTS: pending → accepted / declined / ignored / cancelled.
--     "Ignored" stays waiting for the person who got it (they can still
--     accept later); the sender just sees "waiting".
--     A request can go to an email address that has no account yet; it
--     attaches when that person signs up (in Lantern, or in Dayspring's
--     "Connect to Lantern").
--   * FRIENDSHIPS (both ways) and BLOCKS (a blocked person cannot send you
--     requests and does not see you in search).
--   * at most 20 requests a day per person; after a "no", the same person
--     can be asked again after 7 days.
--
-- Courses still go out only from the owner (lantern_owner_send). The app's
-- normal path is friends first; the owner may still send to anyone.
-- ===========================================================================

-- ---------------------------------------------------------------- people ---

alter table public.profiles add column if not exists friend_code text;
alter table public.profiles add column if not exists findable_by_name boolean not null default false;
create unique index if not exists profiles_friend_code_key on public.profiles (friend_code);

-- LNT- and four characters without look-alikes (no 0/O, 1/I/L).
create or replace function public.lantern_new_friend_code() returns text
language plpgsql volatile security definer set search_path = public as $$
declare alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; c text; i int;
begin
  loop
    c := 'LNT-';
    for i in 1..4 loop c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.profiles where friend_code = c);
  end loop;
  return c;
end $$;

create or replace function public.lantern_profile_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.friend_code is null then new.friend_code := public.lantern_new_friend_code(); end if;
  return new;
end $$;

drop trigger if exists lantern_profile_code on public.profiles;
create trigger lantern_profile_code before insert on public.profiles
  for each row execute function public.lantern_profile_code();

-- people who were here before this file get a code too
do $$
declare r record;
begin
  for r in select id from public.profiles where friend_code is null loop
    update public.profiles set friend_code = public.lantern_new_friend_code() where id = r.id;
  end loop;
end $$;

-- --------------------------------------------------------------- friends ---

create table if not exists public.friend_requests (
  id           uuid primary key default gen_random_uuid(),
  from_user    uuid not null references public.profiles(id) on delete cascade,
  to_user      uuid references public.profiles(id) on delete cascade,
  to_email     text,
  message      text not null default '',
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'ignored', 'cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (to_user is not null or to_email is not null)
);
create index if not exists friend_requests_to on public.friend_requests (to_user, status);
create index if not exists friend_requests_from on public.friend_requests (from_user, created_at);
-- one open request per pair (pending or ignored count as open)
create unique index if not exists friend_requests_open_pair on public.friend_requests (from_user, to_user)
  where status in ('pending', 'ignored') and to_user is not null;
create unique index if not exists friend_requests_open_email on public.friend_requests (from_user, lower(to_email))
  where status in ('pending', 'ignored') and to_user is null;

create table if not exists public.friendships (
  user_a     uuid not null references public.profiles(id) on delete cascade,
  user_b     uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

create table if not exists public.blocks (
  blocker    uuid not null references public.profiles(id) on delete cascade,
  blocked    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked)
);

-- --------------------------------------------------------------- helpers ---

create or replace function public.lantern_are_friends(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships where user_a = least(p_a, p_b) and user_b = greatest(p_a, p_b))
$$;

create or replace function public.lantern_blocked_either(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks where (blocker = p_a and blocked = p_b) or (blocker = p_b and blocked = p_a))
$$;

create or replace function public.lantern_befriend(p_a uuid, p_b uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.friendships (user_a, user_b) values (least(p_a, p_b), greatest(p_a, p_b)) on conflict do nothing;
end $$;

-- Requests waiting for this email, now that its owner has a verified account.
create or replace function public.lantern_attach_friend_requests(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare e text; n integer;
begin
  select lower(email) into e from auth.users where id = p_user and email_confirmed_at is not null;
  if e is null then return 0; end if;
  -- a second request from the same person to the same email is dropped
  update public.friend_requests r set status = 'cancelled', responded_at = now()
  where r.to_user is null and lower(r.to_email) = e and r.status in ('pending', 'ignored')
    and (r.from_user = p_user
         or exists (select 1 from public.friend_requests x where x.from_user = r.from_user and x.to_user = p_user and x.status in ('pending', 'ignored'))
         or public.lantern_are_friends(r.from_user, p_user));
  update public.friend_requests r set to_user = p_user
  where r.to_user is null and lower(r.to_email) = e and r.status in ('pending', 'ignored');
  get diagnostics n = row_count;
  return n;
end $$;

-- Who a query names: an account id, a friend code, or an exact email.
create or replace function public.lantern_resolve_person(p_to text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare t text := trim(coalesce(p_to, '')); who uuid;
begin
  if t ~ '^[0-9a-fA-F-]{36}$' then select id into who from public.profiles where id = t::uuid;
  elsif upper(t) ~ '^(LNT-)?[A-Z0-9]{4}$' then
    select id into who from public.profiles where friend_code = case when upper(t) like 'LNT-%' then upper(t) else 'LNT-' || upper(t) end;
  elsif t like '%@%' then select id into who from public.profiles where lower(email) = lower(t) limit 1;
  end if;
  return who;
end $$;

-- ---------------------------------------------------------- for everyone ---

-- lantern_me also hands back your friend code and attaches waiting requests.
create or replace function public.lantern_me() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user(); p public.profiles;
begin
  select * into p from public.profiles where id = u;
  if not found then
    insert into public.profiles (id, email, display_name)
      select id, email, split_part(email, '@', 1) from auth.users where id = u
      on conflict (id) do nothing;
    select * into p from public.profiles where id = u;
  end if;
  if p.friend_code is null then
    update public.profiles set friend_code = public.lantern_new_friend_code() where id = u returning * into p;
  end if;
  perform public.lantern_attach_email_offers(u);
  perform public.lantern_attach_friend_requests(u);
  return jsonb_build_object('id', p.id, 'email', p.email, 'display_name', p.display_name, 'role', p.role,
    'friend_code', p.friend_code, 'findable_by_name', p.findable_by_name,
    'owner_exists', exists (select 1 from public.profiles where role = 'owner'));
end $$;

create or replace function public.lantern_set_findable(p_by_name boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user();
begin
  update public.profiles set findable_by_name = coalesce(p_by_name, false) where id = u;
  return public.lantern_me();
end $$;

-- How the asker stands with someone: you, friend, sent, received, blocked, none.
create or replace function public.lantern_relation(p_me uuid, p_other uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_me = p_other then 'you'
    when exists (select 1 from public.blocks where blocker = p_me and blocked = p_other) then 'blocked'
    when public.lantern_are_friends(p_me, p_other) then 'friend'
    when exists (select 1 from public.friend_requests where from_user = p_me and to_user = p_other and status in ('pending', 'ignored')) then 'sent'
    when exists (select 1 from public.friend_requests where from_user = p_other and to_user = p_me and status in ('pending', 'ignored')) then 'received'
    else 'none' end
$$;

-- Find people. Everyone: exact email or friend code, or a name among people
-- who allow name search. The owner: anyone, by any part of name or email.
create or replace function public.lantern_find_people(p_query text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user(); q text := trim(coalesce(p_query, '')); owner boolean := public.lantern_is_owner(); code text;
begin
  if length(q) < 2 then return '[]'::jsonb; end if;
  code := case when upper(q) like 'LNT-%' then upper(q) else 'LNT-' || upper(q) end;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'friend_code', p.friend_code,
      'email', case when owner then p.email else null end,
      'relation', public.lantern_relation(u, p.id)) order by p.display_name)
    from (
      select * from public.profiles p
      where p.id <> u
        and not exists (select 1 from public.blocks b where b.blocker = p.id and b.blocked = u)
        and (p.friend_code = code
             or lower(p.email) = lower(q)
             or (p.findable_by_name and length(q) >= 3 and p.display_name ilike '%' || q || '%')
             or (owner and (p.display_name ilike '%' || q || '%' or p.email ilike '%' || q || '%')))
      limit 20
    ) p
  ), '[]'::jsonb);
end $$;

-- Ask someone to be friends: an account id, a friend code, or an email (an
-- email with no account yet waits for them). If they already asked you, this
-- accepts theirs instead.
create or replace function public.lantern_send_friend_request(p_to text, p_message text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user(); who uuid; e text; r public.friend_requests; recent integer;
begin
  who := public.lantern_resolve_person(p_to);
  if who is null and trim(coalesce(p_to, '')) like '%@%' then
    e := lower(trim(p_to));
    if e !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'That is not an email address: %', p_to; end if;
  elsif who is null then
    raise exception 'Nobody was found with that friend code or email.';
  end if;
  if who = u then raise exception 'That is you.'; end if;
  select count(*) into recent from public.friend_requests where from_user = u and created_at > now() - interval '1 day';
  if recent >= 20 then raise exception 'That is a lot of friend requests for one day. Try again tomorrow.'; end if;

  if who is null then
    if exists (select 1 from public.friend_requests where from_user = u and to_user is null and lower(to_email) = e and status in ('pending', 'ignored')) then
      return jsonb_build_object('status', 'sent', 'waiting_for_signup', true);
    end if;
    insert into public.friend_requests (from_user, to_email, message) values (u, e, left(coalesce(p_message, ''), 300));
    return jsonb_build_object('status', 'sent', 'waiting_for_signup', true);
  end if;

  if public.lantern_blocked_either(u, who) then raise exception 'You cannot send a friend request to this person.'; end if;
  if public.lantern_are_friends(u, who) then return jsonb_build_object('status', 'friend'); end if;
  -- they asked first: that is a yes
  select * into r from public.friend_requests where from_user = who and to_user = u and status in ('pending', 'ignored') limit 1;
  if found then
    update public.friend_requests set status = 'accepted', responded_at = now() where id = r.id;
    perform public.lantern_befriend(u, who);
    return jsonb_build_object('status', 'friend', 'accepted_theirs', true);
  end if;
  if exists (select 1 from public.friend_requests where from_user = u and to_user = who and status in ('pending', 'ignored')) then
    return jsonb_build_object('status', 'sent');
  end if;
  if exists (select 1 from public.friend_requests where from_user = u and to_user = who and status = 'declined' and responded_at > now() - interval '7 days') then
    raise exception 'They said no to a request recently. You can ask again after a week.';
  end if;
  insert into public.friend_requests (from_user, to_user, message) values (u, who, left(coalesce(p_message, ''), 300));
  return jsonb_build_object('status', 'sent');
end $$;

-- accept | decline | ignore (ignore keeps it waiting, just out of the way)
create or replace function public.lantern_respond_friend_request(p_request uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user(); r public.friend_requests;
begin
  select * into r from public.friend_requests where id = p_request and to_user = u;
  if not found then raise exception 'That friend request was not found.'; end if;
  if r.status not in ('pending', 'ignored') then raise exception 'That friend request is no longer waiting (it was %).', r.status; end if;
  if p_action = 'accept' then
    update public.friend_requests set status = 'accepted', responded_at = now() where id = r.id;
    perform public.lantern_befriend(u, r.from_user);
    return jsonb_build_object('status', 'friend', 'friend', r.from_user);
  elsif p_action = 'decline' then
    update public.friend_requests set status = 'declined', responded_at = now() where id = r.id;
    return jsonb_build_object('status', 'declined');
  elsif p_action = 'ignore' then
    update public.friend_requests set status = 'ignored', responded_at = now() where id = r.id;
    return jsonb_build_object('status', 'ignored');
  end if;
  raise exception 'Say accept, decline or ignore.';
end $$;

create or replace function public.lantern_cancel_friend_request(p_request uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user();
begin
  update public.friend_requests set status = 'cancelled', responded_at = now()
  where id = p_request and from_user = u and status in ('pending', 'ignored');
  if not found then raise exception 'That friend request is no longer waiting.'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.lantern_remove_friend(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user();
begin
  delete from public.friendships where user_a = least(u, p_user) and user_b = greatest(u, p_user);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.lantern_block_user(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user();
begin
  if p_user = u then raise exception 'That is you.'; end if;
  insert into public.blocks (blocker, blocked) values (u, p_user) on conflict do nothing;
  delete from public.friendships where user_a = least(u, p_user) and user_b = greatest(u, p_user);
  update public.friend_requests set status = 'cancelled', responded_at = now()
  where status in ('pending', 'ignored') and ((from_user = u and to_user = p_user) or (from_user = p_user and to_user = u));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.lantern_unblock_user(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user();
begin
  delete from public.blocks where blocker = u and blocked = p_user;
  return jsonb_build_object('ok', true);
end $$;

-- Your friends: name, code, online, and what they are studying now.
create or replace function public.lantern_my_friends() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'friend_code', p.friend_code, 'role', p.role,
      'since', f.created_at, 'last_seen', pr.last_seen, 'online', coalesce(pr.last_seen > now() - interval '2 minutes', false),
      'current_course', pr.course_id,
      'current_course_title', (select c.title from public.courses c where c.id = pr.course_id))
      order by p.display_name)
    from public.friendships f
    join public.profiles p on p.id = case when f.user_a = u then f.user_b else f.user_a end
    left join lateral (select * from public.presence z where z.user_id = p.id order by z.last_seen desc limit 1) pr on true
    where f.user_a = u or f.user_b = u
  ), '[]'::jsonb);
end $$;

-- Requests you got (pending and ignored) and sent (an ignored one shows as
-- "pending" to its sender), plus the people you blocked.
create or replace function public.lantern_my_friend_requests() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public.lantern_require_user();
begin
  perform public.lantern_attach_friend_requests(u);
  return jsonb_build_object(
    'received', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'from', r.from_user, 'from_name', p.display_name,
        'from_code', p.friend_code, 'from_role', p.role, 'message', r.message, 'status', r.status, 'created_at', r.created_at) order by r.created_at desc)
      from public.friend_requests r join public.profiles p on p.id = r.from_user
      where r.to_user = u and r.status in ('pending', 'ignored')), '[]'::jsonb),
    'sent', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'to', r.to_user, 'to_name', coalesce(p.display_name, r.to_email),
        'to_email', case when r.to_user is null then r.to_email else null end,
        'status', case when r.status = 'ignored' then 'pending' else r.status end, 'created_at', r.created_at, 'responded_at',
        case when r.status = 'ignored' then null else r.responded_at end) order by r.created_at desc)
      from public.friend_requests r left join public.profiles p on p.id = r.to_user
      where r.from_user = u and (r.status in ('pending', 'ignored') or (r.status in ('accepted', 'declined') and r.responded_at > now() - interval '7 days'))), '[]'::jsonb),
    'blocked', coalesce((select jsonb_agg(jsonb_build_object('id', b.blocked, 'display_name', p.display_name))
      from public.blocks b join public.profiles p on p.id = b.blocked where b.blocker = u), '[]'::jsonb));
end $$;

-- The owner's People list also says who is already a friend.
create or replace function public.lantern_owner_people() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid();
begin
  perform public.lantern_require_owner();
  return coalesce((
    select jsonb_agg(x order by x->>'display_name') from (
      select jsonb_build_object(
        'id', p.id, 'email', p.email, 'display_name', p.display_name, 'role', p.role, 'created_at', p.created_at,
        'friend_code', p.friend_code, 'relation', public.lantern_relation(u, p.id),
        'last_seen', pr.last_seen, 'online', coalesce(pr.last_seen > now() - interval '2 minutes', false),
        'app_version', pr.app_version, 'current_course', pr.course_id, 'current_lesson', pr.lesson_id, 'status', pr.status,
        'groups', coalesce((select jsonb_agg(g.name) from public.group_members gm join public.groups g on g.id = gm.group_id where gm.user_id = p.id), '[]'::jsonb),
        'courses', coalesce((select jsonb_agg(jsonb_build_object('course_id', s.course_id, 'percent', s.percent, 'finished', s.finished,
            'count', s.count, 'current_ref', s.current_ref, 'current_title', s.current_title, 'seconds', s.seconds, 'updated_at', s.updated_at))
            from public.progress_summary s where s.user_id = p.id), '[]'::jsonb),
        'granted', coalesce((select jsonb_agg(g.course_id) from public.grants g where g.user_id = p.id), '[]'::jsonb)
      ) as x
      from public.profiles p
      left join lateral (select * from public.presence z where z.user_id = p.id order by z.last_seen desc limit 1) pr on true
      union all
      select jsonb_build_object('id', null, 'email', lower(o.to_email), 'display_name', lower(o.to_email), 'role', 'invited',
        'pending_invite', true, 'online', false, 'courses', '[]'::jsonb, 'granted', '[]'::jsonb, 'groups', '[]'::jsonb,
        'offered', jsonb_agg(o.course_id))
      from public.course_offers o
      where o.to_user is null and o.status = 'pending'
      group by lower(o.to_email)
    ) q
  ), '[]'::jsonb);
end $$;

-- ------------------------------------------------------ row level security ---

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;

drop policy if exists lantern_friend_requests_read on public.friend_requests;
create policy lantern_friend_requests_read on public.friend_requests for select to authenticated
  using (from_user = auth.uid() or to_user = auth.uid() or public.lantern_is_owner());

drop policy if exists lantern_friendships_read on public.friendships;
create policy lantern_friendships_read on public.friendships for select to authenticated
  using (user_a = auth.uid() or user_b = auth.uid() or public.lantern_is_owner());

drop policy if exists lantern_blocks_read on public.blocks;
create policy lantern_blocks_read on public.blocks for select to authenticated
  using (blocker = auth.uid());

-- Functions are for signed-in people only (the same rule as 0001, again for
-- the new ones).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'lantern\_%'
             -- internal helpers (they trust the ids they are given) stay locked; see 0003
             and p.proname not in ('lantern_make_offer', 'lantern_make_email_offer', 'lantern_attach_email_offers', 'lantern_attach_friend_requests', 'lantern_befriend', 'lantern_are_friends', 'lantern_blocked_either', 'lantern_relation', 'lantern_resolve_person', 'lantern_new_friend_code', 'lantern_new_user', 'lantern_profile_code', 'lantern_require_user', 'lantern_require_owner') loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
