-- ===========================================================================
-- 0003_lock_helpers.sql — the hub's internal helpers are not for callers.
-- ---------------------------------------------------------------------------
-- 0001 and 0002 let every signed-in person run every lantern_* function. Most
-- of those are the hub's API and check who is asking. A few are INTERNAL
-- helpers that take user ids as arguments and trust them: called directly,
-- lantern_make_offer could make an "offer from the owner" to yourself (and so
-- give yourself any course), lantern_befriend could make any two people
-- friends, lantern_resolve_person could look up anyone by email.
--
-- This takes the right to call them away from everyone but the database's
-- own functions. Nothing in Lantern or Dayspring calls them directly: they
-- only run inside the lantern_* API functions (which run as the database
-- owner) and in triggers. lantern_is_owner and lantern_has_access stay
-- callable, because the row level security rules use them (and they only
-- answer about the person asking).
--
-- Safe to run again, and safe to run after 0001/0002 are run again.
-- ===========================================================================

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'lantern_make_offer', 'lantern_make_email_offer',
             'lantern_attach_email_offers', 'lantern_attach_friend_requests',
             'lantern_befriend', 'lantern_are_friends', 'lantern_blocked_either', 'lantern_relation',
             'lantern_resolve_person', 'lantern_new_friend_code',
             'lantern_new_user', 'lantern_profile_code',
             'lantern_require_user', 'lantern_require_owner') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
