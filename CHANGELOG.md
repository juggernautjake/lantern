# What's new

## 0.1.3

- **Saying "Lantern" works every time.** Lantern now hears its name anywhere in what you say, and forgives the usual mishearings ("lanterns", "lan tern"). Say the name on its own and it records your request on its own session. It chimes only when it is really recording, it waits until you have finished (pauses mid-sentence are fine), and it shows your words as you speak. If it hears nothing, it says so. If the browser stops listening, Lantern starts it again, and a watchdog checks every few seconds. You can also interrupt it by saying its name while it talks.
- **You can see what Lantern is doing.** While it hears you, the flame and a small indicator move with your voice. While it works on the answer it shows thinking, and while it talks it shows speaking. Waiting for its name looks calm, so you can tell the difference.
- **Lantern reads math and numbers out in full.** Equations, decimals, powers, roots, units, bearings and stations are turned into words before they're spoken: "x² + √(a² + b²)" becomes "x squared plus the square root of the quantity a squared plus b squared", and "N 45°30'15\" E" becomes "north forty-five degrees, thirty minutes, fifteen seconds east". The browser voice no longer breaks a decimal like 3.5 into "three… five".
- **Lantern can read anything in a course aloud.** Every symbol, subscript and number is spoken as words: σ, Σ and Δ, subscripts ("sigma sub m"), long decimals ("zero point, four zeros, then eight three three"), large numbers, angles, bearings, stations, units, tables and calculator key names. The test suite checks every piece of text in the FS course.
- **Math in replies is written plainly**, with the symbols you'd see in a textbook, not LaTeX code.
- **A rejected AI key says so clearly.** When the key has expired or been turned off, Lantern tells you to paste a new one in Settings → Assistant. It no longer adds unrelated search results.

## 0.1.2

- **Lantern knows the page you're on.** Courses can now send the reading that's open, so the assistant can teach from it: explain it in its own words, go deeper, work a fresh example and check your understanding. On checks and exams it gets nothing and gives no help with the questions.
- **Links in Lantern's replies are clickable** and open in a new tab. Bold and `code` show properly too.
- **Better "find me a video about this".** Readings with general names like "Key concepts" or "Essential formulas" are now searched by their unit and subject, so the results are about the actual topic. Courses can add their own trusted docs and blog sites, and Khan Academy results are checked for relevance, with a link to Khan's own search when nothing fits.

## 0.1.1

- **Videos pop out.** The ↗ button on the mini player (or "pop it out") pauses the video and opens it in your browser at the same second.
- **Better video search, no key needed.** Lantern now reads YouTube's own search results directly, so "find me a video about this" gets real YouTube results without an API key, and nothing opens on screen while it looks.
- A video that can't play inside other apps now says so and offers ↗ instead of skipping ahead.
- Lantern notices when your role changes on the hub (for example, becoming the owner) without signing out and back in.

## 0.1.0

The first version of Lantern as an app.

- Courses are packs that work fully offline: lessons, self-checking exercises, projects and unit checks.
- Your progress is saved on your computer as you go, and synced to your account when you're online. Work from two computers merges without losing anything.
- Getting a course: invitations with Accept and Decline, invite codes, and requesting listed courses.
- For course owners: who's using Lantern, who's online, what they're studying and how far they've got. Send courses to people, email addresses or groups; answer requests; publish new versions.
- Updates from GitHub, when you choose (now, next time, or when you're not using it), with a backup first and a rollback if anything fails.
- Bring your progress over from the web version of a course.
- Works with Dayspring when both are on your computer.
- One way of counting progress everywhere (the course page, the player, Lantern the assistant, the owner's dashboard and Dayspring): steps (every lesson, exercise, project milestone and unit check) and lessons.
- Inside the app a course has one header, with a Lessons button for the lesson list. "What's next" means what comes after where you are.
- A welcome on first start that explains hubs, friend codes and using Lantern on your own.
- Works on a phone-sized window: the menu gets its own row and Lantern (the assistant) opens when you ask.
- Sturdier: a damaged database is replaced from its backup (the damaged file is kept), a full disk gets a plain message and nothing saved is lost, a cut-off course download is retried by itself, a computer with a wrong clock cannot make old progress look new, and double clicks never send anything twice.
