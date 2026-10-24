# Releasing Lantern

The public repo holds the **platform only**, and it's made from the private working copy by an allow-list export with a privacy scan.

1. **Version.** Raise `version` in `package.json`, and add a section to `repo/CHANGELOG.md` (`## 0.2.0`).
2. **Tests.** Run the three suites in [testing.md](testing.md) and the course checks. All must pass.
3. **Release zip.** From PowerShell or cmd (Git Bash's `tar` can't write zips):
   ```
   node scripts/release.mjs
   ```
   It:
   - exports to `../lantern-app` and runs the privacy scan (it stops if the scan fails)
   - adds `release.json` inside the zip only
   - writes `dist-out/Lantern.zip` and checks what's in it
4. **Publish** from `../lantern-app`:
   ```
   git add -A && git commit -m "Lantern 0.2.0" && git push
   gh release create v0.2.0 ../lantern/dist-out/Lantern.zip --title "Lantern 0.2.0" --notes-file notes.md
   ```
   The asset must be named **Lantern.zip**: `…/releases/latest/download/Lantern.zip` is the permanent download link. The release text is what people read under "What's new".
5. **Installed copies** see it within about 6 hours (sooner with Settings → Updates → Check now), then install it the way each person chose: ask, next launch, or when idle.

## A default hub for your learners (optional)

If you run a hub, you can make it the default in **your** release, so the people you send the download to are connected without pasting anything:

1. Put the hub's address and its **public** key in a private file on your computer: `%LOCALAPPDATA%\Lantern\release-hub.json` (or point `LANTERN_RELEASE_HUB` at another file):
   ```json
   { "url": "https://<your-project>.supabase.co", "anonKey": "<the anon or publishable key>" }
   ```
   Add `"emailCode": true` only if your hub's sign-in email includes a 6-digit code (custom SMTP plus `{{ .Token }}` in the Magic link template; see setup-supabase.md). Without it, Lantern offers an emailed sign-in link.
2. Run `node scripts/release.mjs` as usual. It puts that into the zip only, as `config/hub.json`, and says so. The public repo keeps an empty `config/hub.json`, so the privacy scan still passes.

A secret or `service_role` key stops the release, and the app refuses one in `config/hub.json` anyway. The public key is safe to ship: your hub's rules decide what each person may see. A learner can still connect to a different hub in Settings → Account & hub; their choice wins over the default.

## Big media on Cloudflare R2

A course with hours of narration is too big for the free hub (1 GB in all). Its audio lives on Cloudflare R2 instead, and the course pack holds only the pages and a list of the audio files. `courses/fs` does this: the pack is about 185 MB, the 766 MB of `.mp4` audio is on R2.

**One-time setup** (Cloudflare dashboard)
1. Create an R2 bucket named `lantern-media`.
2. Switch on public read through r2.dev (the bucket's *Settings*, *Public access*), and copy the `https://pub-….r2.dev` address.
3. Create an API token with *Object Read & Write* on that bucket.
4. Put these in `.env` at the repo root (never committed, never printed by the scripts):
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET` (`lantern-media`)
   - `R2_PUBLIC_URL` (the `https://pub-….r2.dev` address)

**Each release of a course with media**
```
node scripts/build-pack.mjs fs             the pack lists every media file with its key, size and sha256
node scripts/upload-media.mjs fs           HEADs each key, uploads only the missing ones; prints counts and bytes
node scripts/publish-course.mjs fs         refuses until every media file answers at the public URL
```
Keys are `<keyPrefix>/<sha256>.mp4`, so a file is uploaded once, an unchanged file is never uploaded again, and older versions of the course keep working because their keys still exist. Never delete keys from the bucket while a published version still uses them. `publish-course` has `--skip-media-check` for the rare case you must publish before uploading.

**What an installed copy does.** After the pack installs (from the hub, a file or the bundled folder) the app downloads every media file into the pack's own folder in the background, checks each sha256, and carries on after a restart or a lost connection. Files the previous version already holds are linked, not downloaded again, so an update fetches only new audio. Until a file is saved, `/packs/<id>/<path>` redirects to the public URL so the video plays at once; once saved, it plays from the computer, offline. The course list shows `media: { have, total, bytes }` and the bus carries a `media` event; the home page shows it as one quiet line on the course card.

A Lantern older than 0.2.1 does not know about `media`, so the course's `minPlatform` is 0.2.1.

## What the export takes

Only the paths in `ALLOW` in `scripts/export.mjs`:
- the server and the app pages
- the hub SQL
- the course tools and the template course
- the public docs and the dev docs
- `vendor/ecosystem-core` (the shared package) and `config/hub.json` (empty)
- the repo files in `repo/`

Never exported:
- course content (`courses/<id>`, `app/cfml`)
- the private plans (`docs/*.md` at the top level), the catalogue and frameworks
- data, `.env`, builds and packs

## The privacy scan

`scripts/privacy-scan.mjs` fails on:
- keys, JWTs and private keys
- a real Supabase project address
- personal email addresses, phone numbers, user-folder paths
- course content
- any term from your private list: `%LOCALAPPDATA%\Lantern\privacy-terms.json`, shaped `{ "terms": [...], "words": [...] }`. It stays on your computer and is never exported.
