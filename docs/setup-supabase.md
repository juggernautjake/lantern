# Setting up your hub (free)

Your **hub** is where Lantern keeps accounts and the courses you share, and lets you see how everyone is doing. It's a free Supabase project that you own. This takes about 15 minutes, once. You don't need to know any code: you'll paste one file and copy two values.

> **You only need a hub if you want to share courses.** Lantern works fully on one computer without one.

## 1. Make the project

1. Go to **https://supabase.com** and click **Start your project**. Sign up; "Continue with GitHub" is quickest.
2. Click **New project**.
   - **Organization:** the one it made for you (the Free plan is fine).
   - **Project name:** anything, e.g. `lantern-hub`.
   - **Database password:** click **Generate a password** and save it in your password manager. Lantern never needs it.
   - **Region:** the one closest to you and your learners.
3. Click **Create new project** and wait a minute or two while it sets up.

## 2. Add Lantern's tables (one paste)

1. In the left bar, open **SQL Editor**, then click **New query**.
2. Open `supabase/lantern_hub_all.sql` from the Lantern download in Notepad. Select all (Ctrl+A), copy, and paste it into the editor. (It is every part of the hub in one file: accounts, courses, progress and friends.)
3. Click **Run**. It takes a few seconds. The last result is one row with **owner_claim_code**. **Copy that code** and keep it for step 5.

**Already set up your hub before friends existed?** Your hub ran `0001_lantern_hub.sql` only. Paste and run `supabase/migrations/0002_friends.sql` the same way, once. Nothing you have is changed; it adds friend codes, friend requests and friends. (Running a file again is always safe.)

**Set up your hub before September 2026?** Also paste and run `supabase/migrations/0003_lock_helpers.sql` once. It closes a gap where a signed-in person could call the hub's internal helpers directly (and, for example, give themselves a course). New hubs that paste `lantern_hub_all.sql` already have it.

Lost the code? Run this in a new query to see it again:
```sql
select value from public.app_secrets where key = 'owner_claim_code';
```

(Using the Supabase CLI instead? `supabase link` to the project, then `supabase db push` runs the files in `supabase/migrations` in order.)

## 3. Choose how people sign in

In the left bar, open **Authentication**, then **Sign In / Providers**, then **Email**. Pick one:

| Option | How | Good for |
|---|---|---|
| **A. Simplest:** a password, no confirmation email | Turn **Confirm email** off, then Save | A few people you know. They sign up in Lantern and are in at once |
| **B. An emailed sign-in link (no passwords)** | Nothing to change: keep Email on. Lantern's **Email me a link** sends Supabase's standard sign-in email; pressing the link on the same computer signs the person in | People who'd rather not have another password. Dayspring's "Connect to Lantern" offers it too |

Both work at once; Lantern offers a password and an emailed link.

> **A 6-digit code instead of a link?** Only with your own email sender. On the free plan Supabase's email templates can't be edited until you add custom SMTP (**Project Settings → Authentication → SMTP**, for example Resend or Brevo, which both have free plans). Then open **Authentication → Emails → Magic link or OTP**, add `Your Lantern code: {{ .Token }}`, save, and put `"emailCode": true` in the hub file you bake into your release (`release-hub.json`, next to `url` and `anonKey`). Lantern then shows **Email me a code**. Without all of that, keep the link: it just works.

> **Email limits on the free plan.** Supabase's built-in email sends only a few messages an hour. That's fine for a handful of people. For more, add your own email sender under **Project Settings → Authentication → SMTP** (for example Resend or Brevo, which both have free plans). Or use option A, which sends no email at all.

Under **Authentication → URL Configuration**:
- set **Site URL** to `http://127.0.0.1:4321` (where a link lands when nothing else is said), and
- under **Redirect URLs**, click **Add URL** and add `http://127.0.0.1:4321/**` (Lantern's sign-in page) and `http://127.0.0.1:4747/**` (Dayspring's, for its "Connect to Lantern"). Save.

Without these, an emailed sign-in link can't come back to the app.

## 4. Copy the two values Lantern needs

Open **Project Settings**, then **API Keys** (on older projects, **API**).

| Value | Where | Looks like |
|---|---|---|
| **Project URL** | Project Settings → Data API, or the top of the API page | `https://<your-project-id>.supabase.co` |
| **Public key** | The **publishable** key (`sb_publishable_…`), or under "Legacy API keys", the **anon public** key (`eyJ…`) | Either works |

> ⚠️ **Never** use the **secret** or **service_role** key in Lantern, and never send it to anyone. Lantern refuses it if you try. The public key is safe to share: your hub's rules decide what each person may see.

## 5. Connect your own Lantern and become the owner

1. Open Lantern, then **Settings → Account & hub**.
2. Paste the **Project URL** and the **public key**, then click **Connect**.
3. Create your account (**Create an account** with a password, or **Email me a link**).
4. Under **I set up this hub**, paste the **owner claim code** from step 2 and click **Claim**. You're the owner now, and **Owner** appears in the top bar.

Nobody else can claim the hub after you. The code works once.

## 6. Put a course on it

On the computer where you make courses:

```
node scripts/publish-course.mjs cfml --publish
```

Lantern must be open and signed in as the owner. The course appears under **Owner → Courses**. Then send it from **Owner → People**; see [Sharing courses](sharing-courses.md).

## 7. Tell your learners two things

Send each person:
- the **download link:** `https://github.com/<you>/lantern/releases/latest/download/Lantern.zip` (or wherever you share Lantern)
- your hub's **Project URL** and **public key**, to paste under Settings → Account & hub

The easiest way is to send the course to their **email address** first (Owner → People → Send course → "Also send to these email addresses"). It's waiting for them when they sign up with that email.

## Check it works

1. **Two accounts:** on a second computer (or a second Windows user), install Lantern, connect it to the hub and create an account.
2. **Owner → People:** they appear, with **Online** and their Lantern version.
3. **Send:** tick them, click **Send course…**, pick the course, write a note and click Send.
4. **Their Lantern:** under **Invitations** they see "*<your name> sent you …*" with your note. They click **Accept** and the course downloads.
5. **Study:** they open a lesson and finish an exercise.
6. **Back on Owner → People:** within a minute you see their course, lesson and %.

## Good to know

- **Free projects pause** after a week with no activity at all. Anyone using Lantern keeps it active. If yours pauses, open the Supabase dashboard and click **Restore**. Nothing is lost, and everyone's Lantern keeps working offline meanwhile and syncs once it's back.
- **Backups:** the free plan doesn't include database backups. Each person's progress is also kept on their own computer, which also backs itself up. The hub mainly holds who has which course and a copy of everyone's progress.
- **Changing things later:** everything the owner does is in the Owner page. The SQL file is only for setting up, and safe to run again.
