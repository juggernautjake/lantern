# Contributing

Thanks for helping. A few ground rules:

- **No dependencies.** Lantern runs on Node.js built-ins only. If you think something needs a package, open an issue first.
- **Offline first.** Nothing a learner does may wait for the network.
- **Never lose progress.** Changes to the database go in `server/src/db/migrations.js` as a new numbered migration. Don't edit a released one. Lesson ids in course packs never change.
- **Tests:** run `node server/test/test-foundation.mjs`, `node server/test/test-ecosystem.mjs` and `node server/test/e2e-offer-flow.mjs` before sending a change (see `docs/dev/testing.md`).
- **Plain language** in everything a learner reads.
