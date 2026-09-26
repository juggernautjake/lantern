# Updates and your data

## Your data is safe

- **Where it lives:** everything you do is saved in `%LOCALAPPDATA%\Lantern`, a folder of its own, apart from the program. Updates replace the program and never touch that folder.
- **Saved as you go:** there's no Save button to forget.
- **Backups:** before every update, Lantern copies your whole database into `backups\`. The newest 10 are kept. **Settings → Your data → Back up now** makes one whenever you like.
- **Replaced progress is kept:** when your progress in a course is replaced (you imported a backup, or a newer copy came from another computer), the old one is kept. Open the course and choose **Saved copies** to go back to it.
- **Synced:** when you're signed in to a hub, your progress is also kept there, so a new computer gets it back.

## How Lantern updates

When a new version is ready you'll see a bar at the top: **Lantern 0.2.0 is ready.**, with these buttons:

| Button | What it does |
|---|---|
| **What's new** | What changed |
| **Update now** | Updates while you wait (about half a minute), then the page reloads |
| **Next time I open Lantern** | Updates quietly the next time it starts |

You can also choose, under **Settings → Updates**, what happens by itself:
- **Ask me first**
- **Next time I open Lantern** (the default)
- **When I'm not using Lantern:** after a while with no use, it updates in the background. Never while you're in a call, while an alarm is ringing, or while Dayspring is talking.

**Every update**
- is checked before anything changes, and then again after installing
- puts everything back exactly as it was if something goes wrong. You'll see a message, and you can keep using the version you had.
- is listed under **What's new**, with its notes

**Courses** update separately, from your hub. You see "*… was updated. Your progress is kept.*", and your progress is always kept because each lesson keeps its id.
