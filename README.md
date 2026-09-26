# Lantern

**A learning app that runs on your own computer.** Take courses at your own pace, fully offline. The person who shares them with you can see how you're doing, and your progress follows you between computers.

- **Courses work offline:** lessons, exercises that check themselves, projects and unit checks.
- **Your work is safe:** saved on your computer as you go, backed up before every update, and synced to your account whenever you're online. It never goes backwards.
- **Sharing is simple:** a course owner sends you a course; you see it under **Invitations** and press **Accept**.
- **For course owners:** see everyone who uses your courses, who's online, what they're studying and how far they've got. Send courses to people or groups, and publish new versions with one command.
- **Updates itself:** carefully, when you choose, with a rollback if anything goes wrong.
- **Works with [Dayspring](https://github.com/juggernautjake/dayspring):** invitations announced out loud, your progress on your study cards, study time on your schedule. Each app works fine alone.

## ⬇️ Install

1. Download **[Lantern.zip](https://github.com/juggernautjake/lantern/releases/latest/download/Lantern.zip)**.
2. Right-click it, choose **Extract All…**, and pick a folder such as `C:\Lantern`.
3. Double-click **Install Lantern.cmd**. It installs Node.js for you if it's missing.
4. Open **Lantern** from your desktop.

The step-by-step guide is [docs/install.md](docs/install.md).

## Guides

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Your first course |
| [Sharing courses](docs/sharing-courses.md) | Getting a course, and sending them (owners) |
| [Setting up your hub](docs/setup-supabase.md) | A free Supabase project that holds accounts and shared courses. About 15 minutes, once |
| [Updates and your data](docs/updates-and-your-data.md) | How updates work and how your data is kept safe |
| [Questions](docs/faq.md) | Answers to common questions |

## For developers and course authors

| | |
|---|---|
| [How Lantern is built](docs/dev/architecture.md) | Modes, the data folder, packs, progress and sync, the hub |
| [Making a course](docs/dev/authoring-courses.md) | The course-pack contract and a template course (`courses/_template`) |
| [The ecosystem](docs/dev/ecosystem.md) | How Lantern and Dayspring work together; [the Dayspring side](docs/dev/dayspring-bridge.md) |
| [Testing](docs/dev/testing.md) / [Releasing](docs/dev/releasing.md) | The test suites, and publishing a version |

Lantern has **no dependencies** beyond Node.js 22.13+: `node:sqlite`, `node:http` and `fetch`.

```
node server/src/index.js              run it
node server/test/test-foundation.mjs  the foundation tests
node scripts/build-pack.mjs _template build the template course into a pack
```

MIT licensed. See [LICENSE](LICENSE).
