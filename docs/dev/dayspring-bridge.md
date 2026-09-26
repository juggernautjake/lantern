# The Dayspring side: implementation checklist

This is everything Dayspring has to build so the two apps work as one. Lantern's side is built and tested. The protocol is [ecosystem.md](ecosystem.md) plus `ecosystem-core/docs/ECOSYSTEM.md`, and this page is the to-do list. **Don't change Lantern's side to fit; change this page and Lantern together.**

## 1. Discovery and events

- [ ] **Presence:** write `%LOCALAPPDATA%\Ecosystem\apps\dayspring.json` at start and remove it at exit: `{ app: "dayspring", version, port: 4747, pid, startedAt, token, api: "/api/eco", schema: 1, dataDir, handoff }`. The token is 48 random hex characters, new every start.
- [ ] **Hello:** serve `GET /api/eco/hello`, answering `{ app: "dayspring", version, schema: 1 }`.
- [ ] **Events in:** serve `POST /api/eco/event`:
  - require `x-eco-token` to equal Dayspring's own token (401 otherwise)
  - check the `Host` header (421) and `Origin` (403)
  - validate the schema (400 with a list of problems)
- [ ] **Find Lantern:** read `apps/lantern.json`, check `GET /api/eco/hello`, and cache the answer for 30 seconds.
- [ ] **Events out:** send to `http://127.0.0.1:<lantern.port>/api/eco/event` with `x-eco-token: <lantern.token>`.
- [ ] **Send these:**
  - `dnd {on, until}` when quiet hours start and end
  - `call.state {inCall}` when a call starts and ends (Tune in or Discord)
  - `alarm` when the alarm rings
  - `speaking.start/stop {app}` around every spoken line
  - `mic.owner {app: "dayspring"}` at start, and `{app: "lantern"}` when handing Lantern the mic
  - `schedule.block.started {title, course?, lesson?}` when a block linked to a course begins
- [ ] **Handle these:** `course.offered`, `course.accepted`/`declined`, `course.updated`, `lesson.started`, `lesson.completed`, `unit.completed`, `reminder.due`, `app.update.available`, `schedule.block.request` (details below).

## 2. Identity (one account)

The Lantern account is the ecosystem account (Supabase Auth).

- [ ] **Store:** keep Dayspring's session in its own data folder (`data/lantern-session.json`), never in `.env`. It holds the hub URL, the anon key, and the access and refresh tokens.
- [ ] **"Connect to Lantern" (password or emailed link)**, when Lantern isn't installed yet:
  1. Ask for the email.
  2. `POST <hub>/auth/v1/otp { email, create_user: true, data: { display_name } }` with header `apikey: <anonKey>`.
  3. Sign in by email + password (or create the account), or send a sign-in link whose redirect is `http://127.0.0.1:4747/lantern/auth/callback` (the page reads the tokens from the #fragment and posts them to Dayspring). A 6-digit code only if the hub config says `emailCode: true` (the owner added custom SMTP and `{{ .Token }}` to the email).
  4. `POST <hub>/auth/v1/verify { type: "email", email, token }` returns the session.
  5. Call `POST <hub>/rest/v1/rpc/lantern_me {}` once; this also attaches offers that were waiting for that email.
- [ ] **Which hub:** the hub URL and anon key come from the invitation or the owner. Dayspring needs them before Lantern exists: take them from the invite link/code the owner sent, or from Dayspring's settings.
- [ ] **Hub calls while Lantern is absent:** `POST <hub>/rest/v1/rpc/<fn>` with `apikey` and `authorization: Bearer <access>`, refreshing with `POST <hub>/auth/v1/token?grant_type=refresh_token`.

| Function | Who | What |
|---|---|---|
| `lantern_my_offers()` | anyone | Waiting offers: `[{ id, course_id, course_title, from_name, message }]` |
| `lantern_accept_offer(p_offer)` / `lantern_decline_offer(p_offer)` | anyone | Answer an offer |
| `lantern_people_list()` | owner | Everyone, including email invitees |
| `lantern_send_offer(p_to, p_course, p_message)` | owner | `p_to` is an account id or an email |

- [ ] **Poll** `lantern_my_offers()` every 60 seconds while signed in and Lantern isn't running. Realtime isn't needed at this scale.
- [ ] **Hand over when Lantern is installed or started:**
  1. Refresh Dayspring's session.
  2. Write the handoff file (format in [ecosystem.md](ecosystem.md#one-account-the-sign-in-handoff)) into the path from Lantern's presence file, or `%LOCALAPPDATA%\Lantern\handoff.json` before its first run.
  3. **Delete Dayspring's own session** and use Lantern's local API from then on.

## 3. Sending a course (the owner, in Dayspring)

- [ ] **Voice:** "send the ColdFusion course to Sam", "send ColdFusion to sam@example.com with the message have fun".
  - [ ] Find the person: `GET /api/local/people` (with Lantern's token) or `lantern_people_list()`. Match by display name, first name or email. Several matches → ask which one. None → "I don't see Sam. What's their email address? I'll send it there, and they'll get it when they join."
  - [ ] Find the course by title: `GET /api/local/status` `courses`, or the owner's course list.
  - [ ] Confirm: "Send *ColdFusion (CFML) 501* to *Sam Carter*?" and say yes to send.
  - [ ] `POST /api/local/send { to, course, message }` (Lantern's token), or `lantern_send_offer`.
  - [ ] Say "Sent. I'll tell you when Sam answers."
- [ ] **When they answer:** on `course.accepted`/`course.declined`, or when the owner's Offers list changes, say: "*Sam accepted ColdFusion.*" / "*Sam declined ColdFusion.*"

## 3b. Friends (both sides)

Friends come before courses: the owner sends courses to friends. All rules are on the hub (`supabase/migrations/0002_friends.sql`).

- [ ] **Lantern installed and running:** use its local API (token from the presence file for changes):
  - `GET /api/local/friends` → `{ signedIn, online, owner, me { friend_code }, friends[{ id, display_name, online, current_course_title }], received[{ id, from_name, message, status: pending|ignored }], sent[...], waiting }`
  - `POST /api/local/friends/request { to, message }` (`to` = friend code, email or account id)
  - `POST /api/local/friend-requests/<id>/accept|decline|ignore|cancel`
  - Events on `GET /api/eco/events`: `friend.request { requestId, from, message }` and `friend.accepted { name, userId }`. Also `friend-request` / `friend-accepted` / `friends` on `/api/local/events`.
- [ ] **Lantern NOT installed:** Dayspring's "Connect to Lantern" (password or emailed link, §2) gives Dayspring its own hub session. Call the hub directly:
  - `lantern_my_friend_requests()` → `{ received, sent, blocked }`; `lantern_respond_friend_request(p_request, p_action)`; `lantern_my_friends()`; `lantern_send_friend_request(p_to, p_message)`; `lantern_find_people(p_query)`.
  - Poll every 60 s while signed in (or on start and when the screen wakes). Requests to the person's **email** made before they had an account attach automatically on the first `lantern_me()` or `lantern_my_friend_requests()` after they verify.
- [ ] **Announce a request:** a card with the Lantern chip: "*Riley wants to be friends on Lantern.*" + the note. Buttons: **Accept**, **Decline**, **Ignore**. Voice: "Riley sent you a friend request on Lantern. Want to accept it?" → yes = accept, no = decline, "later"/"not now" = ignore.
- [ ] **After accepting, when Lantern isn't installed:** say "You're friends with Riley now. Riley can send you courses in Lantern. Want me to install Lantern so you're ready?" → §5. A course offer that arrives before Lantern is installed follows §4 ("Install Lantern to open it").
- [ ] **The owner, by voice:** "add Sam as a friend on Lantern" / "send a friend request to sam@example.com" → `POST /api/local/friends/request` (or `lantern_send_friend_request`). "Who are my Lantern friends?" → the friends list with who's online and what they're studying.
- [ ] **Accepted:** on `friend.accepted`, say "*Sam accepted your friend request. Want to send Sam a course?*" (owner only) → §3.

## 4. Receiving a course (the learner)

- [ ] **Notification card** (Dayspring's toast style with a Lantern chip): "*[Owner name] wants to send you a course on Lantern: ColdFusion (CFML) 501.*", plus the message if there is one.
  - **Lantern installed:** Accept, Decline, Open Lantern.
  - **Not installed:** Install Lantern, Show me the steps, Not now.
- [ ] **Voice:** read the same line, then ask "Want to accept it?" (installed) or "Want me to install Lantern for you?" (not installed).
- [ ] **Accept:**
  1. `POST /api/local/offers/<id>/accept` (Lantern's token). Without Lantern, use `lantern_accept_offer`, then install.
  2. Lantern opens at the course list while the course downloads, then at the course.
  3. Say "Done. It's downloading so it works offline."
- [ ] **Decline:** `POST /api/local/offers/<id>/decline`, then say "Okay, I've let [owner] know."

## 5. Installing Lantern for someone

1. [ ] Ask: "Lantern is a free learning app. I'll put it in *%LOCALAPPDATA%\Programs\Lantern*. Okay?" Show the path, with a Change button.
2. [ ] Download `https://github.com/<owner>/lantern/releases/latest/download/Lantern.zip` into Dayspring's temp folder, showing progress. Don't run anything from the zip.
3. [ ] Extract it into the folder with `tar -xf` (Windows' own `%WINDIR%\System32\tar.exe`).
4. [ ] Run `Install Lantern.cmd --quiet --no-start` with a hidden window, polling `%LOCALAPPDATA%\Lantern\install-status.json` every 500 ms for a progress bar and the voice lines:

| step | Say |
|---|---|
| `node` | "Checking your computer…" |
| `data` | "Making a place for your courses…" |
| `selftest` | "Making sure it starts…" |
| `shortcuts` | "Adding Lantern to your Start menu…" |
| `done` | "Lantern is installed." |

5. [ ] Handle the exit codes:
   - **10:** ask "Lantern needs a free program called Node.js. Install it now?" If yes, rerun with `--install-node` and say "This can take a couple of minutes."
   - **11:** say "I can't install Node.js on this computer by myself." Open https://nodejs.org and say "Press the LTS button, install it, then tell me."
   - **12:** download again and retry once, then show the message.
   - **13:** same as 11.
   - **14:** show the message.
6. [ ] Write the sign-in handoff (section 2), then start Lantern: `node <folder>\scripts\launch.mjs --open <course>`, hidden.
7. [ ] **"Show me the steps instead"** opens Lantern's install guide (`docs/install.md` in the repo).
8. [ ] **If anything fails:** nothing is left half-installed that matters. Offer "Try again" and "Show me the steps". Never delete the person's `%LOCALAPPDATA%\Lantern` folder.

## 6. Joined features

- [ ] **Study cards:** show `GET /api/local/status` `courses[].percent` and `next.title`. Clicking one calls `POST /api/local/open { course, lesson: next.id }`. With Lantern absent, the card offers to install it.
- [ ] **Voice commands:**
  - "what's my next lesson": answer with `next.title`
  - "open ColdFusion": `/api/local/open`
  - "how far am I": answer with `percent` and `minutesLeft`
  - "what courses do I have": list `courses[]`
  - "accept the course" / "open my course"
  - "I finished lesson 3": `POST /api/local/report` and read back `message`
- [ ] **"Remind me to study at 7":** create a Dayspring schedule block linked to the course (`{ course, lesson? }` on the block). When it starts, send `schedule.block.started`. The block shows the course's % from `/api/local/status`.
- [ ] **`schedule.block.request`** (from Lantern's "Add study time"): create a repeating block (`days`, `time`, `minutes`, `title`, `course`), confirm it on screen, and say "I've added study time for ColdFusion at 7 on weekdays."
- [ ] **`reminder.due`:** show it in Dayspring's reminders; Snooze works as for any reminder.
- [ ] **`unit.completed`:** a celebration: "You finished Unit 3 of ColdFusion. Nice work!"
- [ ] **`course.updated`:** optionally mention "ColdFusion was updated. Your progress is kept."
- [ ] **`app.update.available` (Lantern):** show the shared "What's new" card with Update now / Next time / When idle. Pressing Update calls `node <Lantern>\scripts\update.mjs --yes`, or asks Lantern.
- [ ] **Quiet:** Lantern respects Dayspring's quiet hours and call state once Dayspring sends `dnd`/`call.state` (section 1).
- [ ] **Voices:** each app speaks with its own voice (Lantern: Will, male; Dayspring: Matilda, female), one at a time, via `speaking.start/stop`.

## 7. Errors

| Situation | What Dayspring does |
|---|---|
| Lantern not running | `GET /api/eco/hello` fails. Start it with `launch.mjs --hidden`, or say "Lantern isn't open. Want me to open it?" |
| Hub offline or down | Say "I can't reach Lantern's service right now; I'll try again." Keep polling with back-off. Lantern itself keeps working offline |
| 401 from Lantern | The token changed because Lantern restarted: reread the presence file once, then retry |
| 403 "Only the owner…" | "Only the owner of your Lantern hub can send courses." |
| The install fails | See section 5. Never leave a half-extracted folder: extract into a temp folder, then rename into place |
| An update fails | Lantern rolls itself back. Report its message |

## 8. Tests for Dayspring's side

- [ ] **Presence:** the file is written with a 48-character token and removed at exit.
- [ ] **Security:** `/api/eco/event` refuses a missing token, a bad `Host` or a foreign `Origin`, and refuses bad schemas with a list.
- [ ] **A mock Lantern peer** (a presence file plus a tiny server):
  - Dayspring discovers it
  - `course.offered` makes the card appear, with the owner's name and the message
  - Accept calls `/api/local/offers/<id>/accept` with the token
- [ ] **Quiet:** entering quiet hours sends `dnd {on: true}` to the mock.
- [ ] **Installer (with a fake zip and a fake `install-status.json`):**
  - progress lines are spoken
  - exit 10 asks about Node.js, and yes reruns with `--install-node`
  - exit 11 opens nodejs.org
- [ ] **Handoff:** the file has the right shape, is under 5 minutes old, and Dayspring's own session is deleted after writing it.
- [ ] **Voice parsing:** "send the ColdFusion course to Sam" becomes `{ to: "Sam", course: "ColdFusion" }`, and an ambiguous name asks which one.
