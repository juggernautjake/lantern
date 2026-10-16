# What's new

## 0.1.8

- **Lantern on your phone.** Turn on Settings → Phone and open Lantern in Safari or Chrome on your phone, anywhere, while your computer is on. It goes through Tailscale, a private network between your own devices; nothing is opened to the internet, and only your own account gets in. The whole app is laid out for a phone: a tab bar, full-screen panels, the assistant as a sheet above the keyboard, and Add to Home Screen.
- **Narrated lesson videos.** Courses can now carry videos that Lantern plays as drawn, narrated lessons: figures, a board of working and a virtual calculator that presses every key. Watch straight through or step by step, with captions, a transcript, chapters and a few questions at the end. Lantern knows every video's script and can send you to the right part.
- **Search the videos.** A course's Videos page now searches every video by topic, term, symbol or equation, including what the narrator says and what the board shows. It points you to the chapter to start from and the lessons that teach it. Filter by module or kind; the box at the top of the lesson list searches from any page.
- **Study sessions.** A separate page for focused practice: your weak spots, an equation drill or a mixed review, with Lantern's suggested plan.
- **Links between lessons stay in the course**, instead of opening a new tab.
- **Lantern says it the way the lessons do.** The assistant writes every equation in the course's own symbols and says numbers, symbols, units and formulas the same way the lesson narrator does.
- **FS Exam Prep 1.2.0:** all eleven modules rebuilt into 96 one-topic lessons, each with a video, interactive demos in the readings, and a video for every formula and every worked example. See the course's own notes.

## 0.1.7

- **Lantern reviews every quiz.** When a module check, a practice set or a mock exam ends, Lantern looks over every answer on its own: it writes a short review (what went well, which topics to work on and which reading to go back to), says it aloud, and finds videos for your weak spots. The same review shows under your score in the course. Lantern also remembers how your quizzes have gone, so you can ask it what to work on.
- **Your notes, and Lantern knows them.** Courses can now keep notes that save with your progress. Lantern's assistant sees your notes, can read any of them in full ("quiz me on my curves notes"), and can write one down when you ask.
- **FS Exam Prep 1.1.4:** the quiz review, strong and weak topics on the Progress page, practice aimed at your weak spots, and a Notes panel. See the course's own notes.

## 0.1.6

- **The voice reads calculator keys.** Arrow keys are said as presses ("math, right, right, six"), the HP shift keys as "left shift" and "right shift", and the empty boxes on template keys as "box".
- **FS Exam Prep 1.1.1:** a second, independent review of the whole course: corrected answer keys, readings and generated problems. See the course's own notes.

## 0.1.5

- **Maths reads as maths, and the voice says it in words.** Powers are raised and subscripts lowered everywhere a course shows maths, including formula cards, flashcards, the glossary and answer units. The voice now also says frequencies, times, fractions of an inch, PLSS aliquot parts ("the northeast quarter of the southwest quarter") and per-degree rates in full.
- **FS Exam Prep 1.1.0:** every question taught by its module, every answer worked in full with calculator keys for all ten approved calculators, a complete searchable reference sheet (press R), and many corrections. See the course's own notes.

## 0.1.4

- **A refresh comes back to the page you were on.** Refreshing Lantern while in a course used to reopen the page you first went in by, even after you had moved on. It now returns to the page you were on, a half-done quiz included.
- **FS Exam Prep 1.0.3: module checks keep your place.** Leave, refresh or close Lantern partway through a check, and you pick up on the same question with your answers so far. Each check opens on a Start button, can be restarted with new questions at any time, and keeps an attempt history: every finished run with its date, score and result, and every question marked right or wrong with your answer and the working.

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
