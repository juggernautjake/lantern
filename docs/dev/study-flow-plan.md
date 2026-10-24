# FS course: study sessions, weak spots and practice — one study flow

**Status (2026-10-23): built, for the next versions (not released).** One Study page with Up next, one ranking (`insights.rank()`), one builder (`sessions.topicSet`), one runner (sessions.js), Weak spots as the record, the weak-spot paper as a Mock exam length, Progress's one module table. Where the build differs from the design below:
- **Capabilities kept as options** (`consolidation-plan.md` a1), not dropped: Study's folded *Options* line holds Material, Difficulty and Source (mixed / generated / bank / my weak questions, chosen inside the module before ranking); *Solve-only equation drill* is in the picker's *Drills* group (generator topics only, no refreshers); *Why these topics* is folded under Up next; *Topics I choose* is the tick column in Weak spots' *Every topic you have answered*; the timed weak-spot paper is a length on Mock exam *and* a quiet button on Weak spots.
- **Practice** is a route that opens Study with the picker on that module (`go('practice')`); it is hidden from the rail. Its hint is `sessions.hint()`.
- **`study.nextUp()` is unchanged.** Lantern's own continue point reads it (test-progress); Up next calls it for its "next lesson" rule, and the start page shows Up next.
- **Phone:** instead of a sticky *Next* row, the way on sits directly under the verdict (ui-audit B1), and an equation drill's *Next* is sticky above the tool dock.
- The picker's *Start* is disabled until something is chosen. Length is 10 / 20 / 30 / 40.

Written 2026-10-22. It answers the owner's question: "We have stuff for studying our weak areas, and we have the weak spots part that tests us over what we need to get better on. Perhaps there is a way to merge these a bit?"

It also follows the owner's rule: "What I don't want is increased complication of features and navigation and elements … I want all of the panels and hubs and navigation and UI elements and everything to make complete sense and look good." So every change here **removes** a page, a mode, a button or a choice, or replaces two with one.

The plan is applied **after** the module reorder (`fs-reorder-plan.md`, approach B):
- module ids (`n`) stay the identity in every key below;
- any "Module N" shown uses `C.label(n)` / `m.num`;
- every `<select>` keeps `n` as its value.

Screenshots of every surface as it is today, at desktop (1366 px) and phone (390 px) sizes, with a seeded record of 360 answers, are in a temporary working folder (not kept) (`desktop-NN-*.png`, `phone-NN-*.png`; `shots.mjs` re-takes them).

## Summary

**Today** there are ten ways to practise, on four pages:
- **Starting a practice set** happens in three places: *Study sessions*, *Practice*, and the *Make a weak-spot set* box on *Weak spots*.
- **"What am I weak at"** is worked out by three different formulas and listed in four places.
- **"Practise my weak areas"** exists three times, under three names, with three different answers.
- **The home page's *Continue*** never points at a weak spot, a check or a study session.

**The proposal:**
1. **Study** (the old *Study sessions*, same id) is the **only place a practice set starts**.
   - Its one primary button is **Up next**: the single thing to do now.
   - Below it are three sessions and one picker.
   - The *Practice* page goes; its module practice becomes an entry in the picker.
2. **Weak spots** is the **record**: weak topics, weak equations, mistakes to fix, answer history.
   - Its one primary button is **Work on these**.
   - Its set builder (four drop-downs) and its own quiz runner go; every set it starts runs on Study.
3. **One ranking of weakness** is used everywhere.
4. The timed **weak-spot paper** becomes one more length option on **Mock exam**, beside the other timed papers. No new control is added.
5. The duplicate **Where you stand** table merges into Progress's module table.

**Nothing a learner has done is lost.** Every answer, mistake, card box, equation record, check run and paper carries over. No saved key changes, and no new state field is added.

### Before and after, counted

| What a learner faces | Today | Proposed |
|---|---:|---:|
| Pages where a practice set can start | 3 (Study sessions, Practice, Weak spots) | **1** (Study), plus Flashcards and Mock exam for their own jobs |
| Rail pages under "Anytime" | 12 | **11** (Practice gone) |
| Study page: buttons / drop-downs | 23 / 3 (10 cards, 6 "Work on this", 6 "Watch it taught") | **5 / 2** (Up next, 3 sessions, picker + Start; Length) |
| Study page height on a phone | 5.8 screens | **about 2** |
| Practice page | 4 drop-downs + Start | **gone** (one entry in Study's picker) |
| Weak spots: controls above the list | 4 drop-downs + Start | **1 button** |
| Weak spots, topics tab: buttons shown (seeded record) | about 130 (22 cards × 5–6) | **9** (Work on these, then Practise × 8); the rest one tap away under *More* |
| Weak spots topics tab on a phone | 11.5 screens | **about 3** |
| Names for "practise my weak areas" | 3 | **1** ("Weak topics") |
| Ways of working out "weak" | 3 (+1 for equations) | **1** (+1 for equations, a different record) |
| Equation-drill buttons on the Study card | 3 + Best session | **1** + a "Choose…" link |
| Review panel after a run: practise buttons | 3 kinds, 3 destinations | **1 primary** (*Practise these*) + *Open Weak spots* |
| Mock exam controls | length select + Begin | the same (one more option in the select) |
| New state fields | — | **none** |

---

## 1. The current map

### 1.1 Every way to practise today

| # | Where (page id) | Name on screen | Draws from | Chooses questions by | Records (log `s`) |
|---|---|---|---|---|---|
| 1 | Lesson (`mN-lK`) | *Try it — Try 5 problems on this lesson* | the lesson's topics | `insights.questionsFor(topics, 5)`, round-robin | `lesson` |
| 2 | Module check (`check-N`) | *Module check*, 20 questions | the module | `content.pick({ module, exclude: last run })` | `check`, plus `checks[n]` |
| 3 | Practice (`practice`) | module · difficulty · *Mixed / Generated only / Bank only / My weak areas* · count | bank and generators | `content.pick`, `engine.generateMixed`, or **`study.weakQuestions`** (per *question*: misses ×2, never seen 1) | `practice` |
| 4 | Practice via `practiseTopics(ids)` | "Aimed at your weak spots" | topics from the review, Progress or the Mock review | `insights.questionsFor(ids, 10)` | `practice` |
| 5 | Study sessions (`study`) | *Best session for me now* | weakest 3 topics + weakest equations | `equations.recommendPlan`: 40% problems, the rest drill rounds | `session` |
| 6 | Study sessions | *Strengthen my weak spots*, *Mixed review*, *One topic*, *Solve-only drill* | topics ranked by **`sessions.weakness()`** | blocks per topic with a refresher (the lesson's words + video); a miss adds another | `session` |
| 7 | Study sessions (FS `sessionSets`) | *Exam formats*, *Law and water*, *Field GNSS*, *Terms sprint* | a filter over bank + generators | shuffled, a third generated | `session` |
| 8 | Study sessions (`equations.js`) | *Set up a drill*, *Quick drill · 10*; *Drill these 8* from Weak spots | equations by **`equations.strength()`** | 10 round kinds, weakest first, a miss returns another way | `eq`, `eqRuns`; problems `session` |
| 9 | Weak spots (`weak`) | *Make a weak-spot set*: *My 5 weakest / Every weak topic / The questions I got wrong / Topics I choose* × *Quiz / Timed paper* × 10–110 × module | topics by **`insights.overall(3)`** rules + "early warnings"; open mistakes from the log | `topicSet`: weighted share, **missed first, then unseen**, generators spread through | `weak`, or `weak-exam` (paper kept in `exams`, `kind: 'weak'`) |
| 9b | Weak spots, per topic or mistake | *Practise — 10 questions*, *Try it again now*, *Retry N as a quiz* | one topic, one question, open mistakes | `topicSet([id], 10)`, `mistakeSet` | `weak` |
| 10 | Flashcards (`cards`) | *Start reviewing* | cards by module | Leitner boxes (1, 3, 7, 21, 60 days) | `cards[i]` |
| 11 | Mock exam (`exam`) | *Full / Half paper / Quick sit* | the NCEES blueprint | `content.buildExam` | `exam`, `exams[]` |

Weakness is also **shown** on:
- Progress (*Strong and weak topics*, `insights.overall(3)`, whose button goes to Practice);
- the rail badge ("85 weak");
- the review panel after every run.

### 1.2 The overlaps

| Overlap | Today | Why it matters |
|---|---|---|
| Three "practise my weak areas" | *Strengthen my weak spots* (#6), *My 5 weakest topics* (#9), *My weak areas* (#3) | One promise, three engines. They disagree on what is weak. In the screenshots, the second-weakest topic is *Weights from standard deviations* on Study sessions but *Ground to grid* on Weak spots. |
| Three formulas | `sessions.weakness()`, the `insights.overall()` rules (+ `weakspots` "early"), `study.weakQuestions()` | The badge, the focus list, Progress and the review cannot be reconciled. |
| Four weak-topic lists | Sessions *Where to focus*, Weak spots *Needs work* + *Early warnings*, Progress, the review | The same list four times, with different contents. |
| Two runners | Sessions' loop (refreshers, adaptive extras); Weak spots' `quiz.runner` (*another like this*, end-of-set review list) | Small, unexplained differences. |
| Two set builders | `insights.questionsFor` (random round-robin) on most pages; `weakspots.topicSet` (missed first, weighted) on one | The better builder is on the less-used page. |
| Four equation buttons | *Set up a drill*, *Quick drill*, *Solve-only drill*, *Best session* | "Solve-only" repeats the drill's own *Solve it* kind. |
| Filters three times | Material/Length (10–40); Module/Length (10–110); Module/Difficulty/Source/Count (5–40) | Three sets of choices for one job. |
| A timed paper on Weak spots | It runs on the Mock exam screen and is kept with the papers | Learners look for timed papers on Mock exam. |
| Two module tables | *Where you stand* on Study sessions; *By module* on Progress | Two progress tables on two pages. |

### 1.3 Where a learner gets confused

- **"Which one do I press?"**
  - Study sessions is 10 cards and 23 buttons (5.8 phone screens).
  - Practice is a bare filter row.
  - Weak spots opens with four drop-downs above an 11.5-screen list on a phone.
- ***Continue* on Start here** (`study.nextUp`) only knows due cards, unread lessons, thin modules and "sit a mock". Its `kind: 'weak'` falls through to the plain Practice page (shell.js:391).
- **The review panel sends "practise" three ways:**
  - per-topic *Practise it* → Practice;
  - *Start a study session on these* → Study sessions;
  - *Open Weak spots* → Weak spots.
- **The Weak spots badge** says "85 weak" after 360 answers. That is alarming, and it does not go down when the learner works.
- **The practice pages sit at the bottom of the rail**, under about 230 lesson and check entries. On a phone that is a long scroll inside the drawer.

**Focus and scroll today:**
- After an answer, `Course.reveal(head, 'nearest')` (head is the verdict line) scrolls just far enough to show the verdict at the bottom of the screen. On a phone the working and *Next* are then below the fold, and the learner scrolls to find them.
- A finished `quiz.runner` set (Practice, Weak spots, lesson) draws its score without scrolling to it. The learner is left at the bottom of the last working.
- Nothing moves focus to the verdict, the score or the next button.

---

## 2. The proposed design

### 2.1 Three places, one job each

| Job | Page | Its one primary action |
|---|---|---|
| Learn | Modules → lessons (*Try it*) → **Module check** | (unchanged) |
| Practise | **Study** | **Up next** |
| See what keeps going wrong | **Weak spots** | **Work on these** |
| Remember | **Flashcards** | *Start reviewing* (unchanged) |
| Rehearse the paper | **Mock exam** | *Begin* (unchanged) |

### 2.2 Navigation

The rail **moves** four existing items up; it adds none. *Start here* is followed by a **Study** heading with **Study · Weak spots · Flashcards · Mock exam**, then the modules. The remaining pages stay under *Anytime*: Videos · Formula sheet · Glossary · Reference library · Calculator · Progress · Appearance.

On a phone the drawer opens with these four at the top, instead of after about 230 entries.

Badges, on the same three items as today:
- **Weak spots** changes from "85 weak" to "**12 to fix**" (open mistakes). That number falls as the learner works.
- **Flashcards** ("27 due") and **Mock exam** (papers sat) are unchanged.

*Practice* leaves the rail. Its id stays a **route**, so old links, a saved `lastPage: 'practice'`, other courses and the kit test still work. It opens Study with the picker set to that module.

### 2.3 Study (`study`)

Desktop, top to bottom. The phone shows the same, stacked:

```
Study
Practice built from your own answers

┌ UP NEXT ─────────────────────────────────────────────┐
│ 7 questions you missed since Monday. Put them right   │
│ while they are fresh.                                 │
│ [ Fix my mistakes ]                       (primary)   │
│ Lantern: "…" (inside Lantern only, one line)          │
└───────────────────────────────────────────────────────┘

Or choose                                  Length [20 ▾]
  Weak topics      Your weakest topics, each with a short refresher.   [Start]
  Mixed review     A bit of everything you have studied.               [Start]
  Equation drill   Which equation, what it means, how to write it.     [Start]  Choose…
  Something specific  [ Pick… ▾ ]                                      [Start]
```

- **Up next** (2.4) is the page's only primary button. It always says *why* in one sentence.
- **Three sessions**, one row each, each with one *Start* button:
  - **Weak topics**: the old *Strengthen my weak spots*, now drawn with the better builder.
  - **Mixed review**: unchanged.
  - **Equation drill**: *Start* is the old quick weakest-10. *Choose…* is a quiet link to the existing setup, so nothing is lost. *Solve-only drill* and the separate *Best session* card go: *Best session* becomes Up next's "Today's session".
- **Something specific**: one native drop-down (a full-screen picker on a phone) with three groups:
  - *Exam-heavy*: Law and water · Field GNSS · Exam formats · Terms sprint (the FS `sessionSets`);
  - *A whole module*: Module 1 … (the old Practice page, mixed bank and generated);
  - *One topic*: every topic, by module, with its %.

  This one control replaces four cards, the *One topic* card and the whole Practice page.
- **Length** (10 · 20 · 40) applies to everything on the page. The *Material* select goes: scoping to a module is the picker's *A whole module* group.

Removed from Study:
- *Where to focus* (6 rows × 2 buttons): Up next gives the reason, and Weak spots has the list;
- *Where you stand*: moved to Progress;
- *Solve-only drill*;
- the *Best session* card.

### 2.4 Up next: "what should I study next"

One function, `Course.sessions.upNext()`, returns **one** item, `{ kind, label, button, start() }`. It is shown on Study and in *Start here* → *Pick up where you left off*. `study.nextUp()` keeps its name and shape for old callers, built from it.

There is no date to enter. The plan changes on its own once every exam-weighted lesson has been read: from then on the learner is in the final stretch, and Up next turns to papers and mistakes.

**While there are lessons left** (the first rule that applies wins):

| # | When | Up next says | Button |
|---|---|---|---|
| 1 | a paper in progress | "You have a mock exam in progress — question 34 of 110." | *Resume the paper* |
| 2 | a module check in progress | "Your Module 3 check is half done." | *Resume the check* |
| 3 | ≥ 15 flashcards due | "27 flashcards are due — about 9 minutes." | *Review due cards* |
| 4 | ≥ 5 open mistakes from the last 3 days | "7 questions you missed since Monday. Put them right while they are fresh." | *Fix my mistakes* |
| 5 | a module's lessons all read, its check not passed | "You have read every Module 3 lesson. Take its check to see what stuck." | *Take the check* |
| 6 | no practice today and weak topics exist | "Today's session: problems on Temperature correction and Ground to grid, and drills on the combined factor." | *Start today's session* |
| 7 | an unread lesson | "Next lesson: Taping corrections (Module 3)." | *Open the lesson* |
| 8 | otherwise | "Nothing stands out. A mixed review keeps everything fresh." | *Start mixed review* |

Rule 6 gives each day the rhythm *cards → today's session → next lesson*. Once a session has been answered today, rule 7 takes over.

**Final stretch** (every exam-weighted lesson read):

| # | When | Up next |
|---|---|---|
| 1–2 | anything in progress | resume it |
| 3 | ≥ 10 cards due | *Review due cards* |
| 4 | no full mock in 7 days | "It has been 9 days since your last mock. Sit a full paper." → *Start a mock exam* |
| 5 | open mistakes from the last paper | "14 questions from Saturday's mock still to put right." → *Fix my mistakes* |
| 6 | a check not yet passed | *Take the check* |
| 7 | otherwise | *Start today's session* |

"Today's session" is the existing *Best session for me now*: weakest topics and weakest equations in one set.

*Fix my mistakes* runs a mistakes session (2.6). It is reached only from Up next and from Weak spots → *Mistakes to fix*. It adds no row to Study.

### 2.5 Weak spots (`weak`)

```
Weak spots
360 answers kept · 8 weak topics · 12 to fix
[ 360 answers ] [ 59% right ] [ 8 weak topics ] [ 12 to fix ]

[ Work on these ]  (primary: a Weak topics session on the top five)

Weak topics (8) | Weak equations (40) | Mistakes to fix (12) | Answer history (360)

1  Temperature correction · Module 3 · 0% · ●●●           [Practise]   More ▾
2  Ground to grid … · Module 6 · 25% · ●●●●                [Practise]   More ▾
…  (8 rows)
▸ Early warnings (14)
▸ Turning the corner (3)
▸ Every topic you have answered (236)
```

- **One primary button:** *Work on these*.
- **Each topic is one row** with one button, *Practise* (10 questions). *More* (`<details>`) holds what the big card shows today: *Watch*, *Read the lesson*, *Your answers*, *Explain what is going wrong*. No feature goes; it is one tap away.
- **Early warnings** and **Turning the corner** are folded, with their counts.
- **Weak equations:** unchanged. *Drill these 8* runs on Study, as it does today.
- **Mistakes to fix:**
  - unchanged, including *Try it again now* in place;
  - *Retry N as a quiz* is renamed **Fix these N**, is the tab's primary button, and runs a mistakes session on Study.
- **Answer history:** unchanged, including the spreadsheet download.
- **Removed:** *Make a weak-spot set* (four drop-downs + Start) and its runner. Each choice has a home:
  - *My 5 weakest* → *Work on these*;
  - *Every weak topic* → *Weak topics* on Study at Length 40;
  - *The questions I got wrong* → *Fix these N*;
  - *Topics I choose* → *Practise* on each row, or Study's picker;
  - *Timed paper* → Mock exam (2.7).

Every set started here runs in Study's runner. Its end screen offers **Back to Weak spots** as the second button.

### 2.6 One runner, one builder, one ranking

- **Runner.** Every set runs in the sessions runner, whether it starts from Study, Weak spots, Up next, the review panel or Progress. It keeps:
  - the refresher before each weak topic;
  - one more problem after a miss;
  - *Another like this*;
  - Lantern's review at the end.

  From Weak spots' runner it gains *Your answers*, the review list, folded under the score.
- **Builder.** `topicSet` (missed first, then unseen, weighted share, generators spread through) moves from weakspots.js to sessions.js and builds every topic-based set. There is one new internal kind, `mistakes`: open mistakes, then topped up from their topics.
- **Ranking.** `insights.rank()` serves every page, the badge and Today's session:
  - the **order** is the current `sessions.weakness()` (smoothed accuracy, recent misses, decay with days unseen, unsure counts half);
  - the **"weak" label** is the current `insights.overall` rule (under 60% solid, last three missed, or a third or more "I don't know" / marked), from 3 answers, or 2 if one was marked;
  - **"early"** and **"better"** follow today's `weakspots.topicRows`.

  `study.weakQuestions()` stays exported for tests and other courses. No FS page uses it.

### 2.7 Mock exam, Progress, lessons, the review panel

- **Mock exam.** The length select gains one option. It becomes: *Full paper — 110 · 5 h 20 min* / *Half paper — 55* / *Quick sit — 20* / **Weak-spot paper — 20 from your weakest topics and mistakes**.
  - No new control.
  - It still sits with `kind: 'weak'`, logs `weak-exam`, and is not counted as the best mock.
  - Marking it ends with *Back to Weak spots*, as today.
- **Progress.**
  - *By module* absorbs *Where you stand*: one table, Read · Answered · Accuracy · Equations · Flashcards · Best check · Last mock · Videos. On a phone it scrolls sideways inside its frame, as tables already do.
  - *Strong and weak topics* uses `rank()`. It has one primary, *Work on my weak topics*, and *Open Weak spots*.
- **Lessons.** *Try it* is unchanged. *Practise module N* (reading sections, module overview) opens Study with the picker set to that module and its *Start* focused.
- **Review panel** after a run:
  - per topic: *Watch* and *Read the lesson* only (the per-topic *Practise it* goes);
  - one primary: **Practise these** (a session on the focus topics);
  - one secondary: *Open Weak spots*.

### 2.8 Focus and scroll, page by page

One rule, shared by every runner and panel: **after any action, the thing the learner needs next is in view at the top (under the sticky header), and focus is on it.**

It is built from:
- the existing `Course.reveal(node, 'start')`, which scrolls only when the node is out of view;
- a `focusQuiet(node)` helper: `tabindex="-1"`, then `focus({ preventScroll: true })`, so a screen reader announces it without a second jump.

| Page / moment | Scrolls to | Focus on |
|---|---|---|
| **Any page opened** (rail, Up next, a button that changes page) | top (`go()` already does `scrollTo(0,0)`) | the page's primary button: Study → Up next button; Weak spots → *Work on these*; Mock exam → length select; Flashcards → *Start reviewing* |
| **A set starts** (any page) | the session head (title + progress bar) | the first answer control (`autofocus`, as today); a refresher card focuses *Start the problems* |
| **Answer checked** | the **verdict line** (Right / Not right), reveal `start` (today the same line with `nearest`, which leaves it at the bottom) | the verdict (`focusQuiet`, `aria-live` already there) |
| **…on a phone** | the same; the result box's action row (*Next* / *Another like this*) is `position: sticky; bottom: 0` within the card, so *Next* is always on screen while the working is read | — |
| **Next problem** | the session head (unchanged: `reveal(slot, 'start')`) | the new question's first control |
| **Set finished** (every runner: sessions, lesson *Try it*, check) | the **score** (today `quiz.runner` does not scroll) | the primary end button (*Another session like this* / *Retake*); the review panel and *Your answers* follow below |
| **End the session early** | the score, as above | as above |
| **Back to Study / Back to Weak spots** | top | that page's primary |
| **Weak spots: tab change** | none (the tab row stays put) | the tab (arrow keys, as today) |
| **Weak spots: open *More* / *Early warnings* / a mistake** | the opened panel's top, only if it opened off-screen | the first button inside it |
| **…close** | none | the `summary` that closed it |
| **Mistakes: *Try it again now*** | the question that appears under the mistake | its first control; once answered, follows "answer checked" |
| **Equation drill round** | the round (unchanged) | *Next* after each round (unchanged) |
| **Flashcards: *Show the answer*** | the definition | *Knew it* |
| **…*Knew it* / *Missed it*** | the next card | *Show the answer* |
| **Mock exam** | unchanged (its own map and clock) | unchanged |
| **Study picker changed** | none | its *Start* button |

### 2.9 Phone

- Every page is one column at 390 px with no sideways scroll. Tables scroll inside `.tablewrap`.
- Buttons are full width when they stand alone. Row buttons (*Start*, *Practise*) keep at least a 44 px tap target.
- **Study** fits Up next and the four rows in about 2 screens, and Up next is in the first screen.
- **Weak spots** topics tab is about 3 screens: 8 one-line rows, the rest folded.
- The sticky *Next* row (2.8) sits above the course's bottom toolbar (Notes · Handbook · Reference · Calculator): `bottom` equals the toolbar height, so neither hides the other.
- The picker is a native `<select>`, so the phone shows its own full-screen list.

---

## 3. Exact code changes

All in `app/course/` unless noted. Three phases, each leaving the course working.

### Phase 1: one ranking, one builder, one runner, focus rules (no layout change)

| File | Change |
|---|---|
| `insights.js` | Add `rank()` (2.6). Move `weakness()` here from sessions.js, and the early/better split from `weakspots.topicRows`. `overall()` stays for the review panel's per-run report. |
| `sessions.js` | `ranked()` returns `Course.insights.rank()`, in the same shape. Move `topicSet`, `mistakeSet` and `realiseKey` here from weakspots.js and export them. In `run()`, kinds `weak`/`topic` fill blocks with `topicSet([id], per, missedKeys)`. Add kind `mistakes` (`opts.keys` or every open mistake; topped up by `topicSet`; no refreshers). Add kind `module` (`opts.module`: `content.pick` mixed with generated, as the Practice page did). Add `opts.back` (`'weak'`), which adds *Back to Weak spots* at the end. `finish()` adds *Your answers* (`quiz.review`) folded under the score. Log source stays `session`. |
| `quiz.js` | After an answer (quiz.js:687), `Course.reveal(head, 'start')` and `focusQuiet(head)` (head is the verdict), where it was `reveal(head, 'nearest')`. Runner `done()`: `reveal(score, 'start')`, then focus the first `.qactions` button. Add the `focusQuiet` helper. |
| `weakspots.js` | `topicRows()` → `insights.rank()`. `quickTopic(id)` → `sessions.start({ kind: 'topic', topics: [id], length: 10, back: 'weak' })`. The mistakes *Retry* → `start({ kind: 'mistakes', keys, back: 'weak' })`. Keep `mistakes`, `entries` and `plan` exported (tests). |
| `insights.js` `panel` | Remove the per-topic *Practise it*. The bottom row becomes *Practise these* (`lr-session`, primary) → `sessions.start({ kind: 'topic', topics: focusIds, length: 15 })`, plus *Open Weak spots* (`lr-open-weak`). Without sessions (other courses), today's `lr-practise` stays. |
| `app/fs/styles.css`, `styles-mobile.css` | Add a `--toolbar-h` variable for the phone bottom toolbar, and `.qresult .qactions { position: sticky; bottom: var(--toolbar-h, 0) }` on phones; focus rings on `[tabindex="-1"]:focus` kept subtle. |

### Phase 2: Study and Up next

| File | Change |
|---|---|
| `sessions.js` `home()` | Rebuild as 2.3: the Up next card (`session-upnext`, button `session-upnext-go`); the rows *Weak topics* (`session-weak`), *Mixed review* (`session-mixed`) and *Equation drill* (`session-eqquick`, link `session-eqsetup`); the picker (`session-pick`, Start `session-pick-go`) with optgroups for `sessionSets`, modules and topics; Length (`session-length`). Remove `session-focus`, `session-best` (its run becomes Up next's "Today's session"), `session-drill`, `session-material`, `session-topic`, the per-set cards and `standingTable`. |
| `sessions.js` | Add `upNext()` (2.4). It reads `S.currentMock()`, `S.currentCheck(n)`, `S.cardCounts(null).due`, `weakspots.mistakes(entries())`, `S.isRead`, `S.checkHistory(n)`, `insights.rank()`, `S.snapshot().exams` and today's log. Export it. `start(opts)` accepts `{ kind: 'module', module }` for the `practice` route. |
| `study.js` | `nextUp()` returns `upNext()` mapped to `{ kind, label, module, section }` when `Course.sessions` exists; otherwise it is unchanged. No state change. |
| `shell.js` `renderStart` | *Pick up where you left off*: Up next's label, and a button that runs its `start()`. This fixes the shell.js:391 fall-through. |
| `shell.js` `CORE_PAGES`, `railRows()` | `study` is titled **Study**. Put `study`, `weak`, `cards` and `exam` under a "Study" heading after `start`. `practice` gets `hidden: true` when `Course.sessions` exists: it stays in `NAV`/`navById`, but `railRows` skips it. The `weak` badge becomes open mistakes, "N to fix". |
| `shell.js` `renderPractice` | With sessions: `Course.sessions.start({ kind: 'module', module: practiceModule, pickOnly: true })`, which renders Study with the picker on that module and focuses its *Start*. Without sessions it is unchanged. `practiseTopics(ids)` → `sessions.start({ kind: 'topic', topics: ids, length: 15 })` when sessions exist. |
| `server/src/assistant/study.js` | SYSTEM prompt: "The learner opened Study sessions" → "The learner opened Study". The reply shows inside the Up next card. |
| `app/fs/styles-weak.css`, `styles-mobile.css` | `.sess-next` (Up next), `.sess-rows` (one-line rows), and the phone layout of 2.9. Remove `.sess-grid`/`.sess-card` rules that are no longer used. |

### Phase 3: Weak spots, Mock exam, Progress

| File | Change |
|---|---|
| `weakspots.js` | Remove `builder()` (`ws-build`, `ws-focus`, `ws-style`, `ws-length`, `ws-start`), `startQuiz` and `running`. Add *Work on these* (`ws-work`). `topicCard` → a one-line row: `ws-topic`, `ws-practise`, and `<details class="ws-more">` holding `ws-watch`, `ws-read`, `ws-topic-answers`, `ws-explain`. Top 8 *Needs work*; *Early warnings* and *Turning the corner* in `<details>`. Mistakes tab: the retry button becomes *Fix these N* (`ws-fix`, primary). Empty state: *Take the Module 1 check* (primary), *Open Study*. |
| `shell.js` `renderExam` | Add the length option `value="weak"`: *Weak-spot paper — 20 from your weakest topics and mistakes*. *Begin* with it builds `sessions.paperSet(20)` (the old `weakspots.plan` "top" logic plus open mistakes, missed first) and calls `sitPaper({ kind: 'weak', title: 'Weak-spot paper · My weakest topics' })`. |
| `shell.js` `renderProgress` | One *By module* table with `equations.standing()` merged in. *Strong and weak topics* from `rank()`. Buttons: *Work on my weak topics* (primary) → `sessions.start({ kind: 'weak' })`, and *Open Weak spots*. Remove the `weakTags` fallback's *Practise these* (→ Practice). |
| `shell.js` | *Practise module N* at :574 and in reading sections → `go('practice')` with `practiceModule` set (the route of Phase 2). |

### Data and history: what carries over

**No migration, and no new field.**

| State | After |
|---|---|
| `log` (`s` = check · practice · exam · session · weak · weak-exam · lesson) | Unchanged. Old `weak` and `practice` answers keep their *Where* labels in History; new sets log `session`. *Everywhere* shows all of them. |
| `questions`, `topics` (`recent`, `unsure`, `flag`) | Unchanged. `rank()` reads exactly these. |
| `cards`, `eq`, `eqRuns`, `eqSetup` | Unchanged. |
| `checks`, `exams` (incl. `kind: 'weak'`), `mock` in progress | Unchanged. A weak-spot paper in progress resumes on Mock exam, as now. |
| `practice[n]` | Unchanged. Every session already counts into it. |
| `lastPage` = `practice` / `study` / `weak` | All three still route. |

The reorder's topic-id snapshot test (`fs-reorder-plan.md` §2.6) already guards the topic ids that hold every weak-spot record.

### Tests and QA

| Test | Change |
|---|---|
| `app/fs/test/test-weakspots.mjs` | :53 `W.plan` kept. :223–228 now go through `rank()`; same assertions. **Add:** one ranking (`sessions.ranked().weak` = `weakspots.topicRows().weak` = Progress's list, as ids); `sessions.topicSet` puts a missed question first; a `mistakes` session takes only open mistakes, then tops up; a set from Weak spots logs `session`, and old `weak` entries still list in History. |
| `app/fs/test/test-insights.mjs` | :234+ unchanged. **Add:** `rank()` puts a marked-right topic below a sure one; a topic unseen for 30 days drifts up; early/better match the old `topicRows`. |
| `app/fs/test/test-fs.mjs` | :585 `nextUp()` still labelled. **Add an Up next table:** seeded states give, in order, resume paper → resume check → due cards → fresh mistakes → check ready → today's session (no practice today) → next lesson → mixed review; with every exam lesson read, the final-stretch order (mock after 7 days, then the paper's mistakes). |
| `app/fs/test/test-checks.mjs` | **Add:** a check in progress is Up next. |
| `app/course/test/test-kit.mjs` | :273 still passes (`practice` stays in `NAV`). **Add:** the rail hides `practice` only when sessions are loaded. |
| `scripts/qa-weakspots.mjs` | :134–164: replace the builder. Test that `ws-work` starts a 20-problem session on Study (`.sess-head`) that ends with *Back to Weak spots*; that `ws-fix` takes at most the open count; that the weak-spot paper starts from `exam-length` = `weak`, is handed in, and returns to Weak spots. Topic rows: `ws-practise` visible; open `.ws-more` before `ws-read` / `ws-explain` / `ws-topic-answers`. |
| `scripts/qa-practice.mjs` | :182 `go('practice')` → Study, with `session-pick` on the module. `session-eqsetup` is unchanged (now a link). |
| `scripts/qa-equations.mjs` | :97–106: `session-best` → `session-upnext` (Today's session when nothing else is due), and `session-eqquick`. The *Where you stand* checks move to Progress. |
| `scripts/qa-phone-course.mjs` | :135, :374 `practice` → Study. **Add (phone):** Up next in the first screen of Study; no sideways scroll on Study, Weak spots, Mock exam or Progress; Study ≤ 2.5 screens and the Weak spots topics tab ≤ 4 with the seeded record. After an answer: the verdict's top is within the viewport, `document.activeElement` is the verdict, and the sticky *Next* is visible. After the last answer: the score is in view and focus is on the first end button. |
| `scripts/qa-phone-shell.mjs` / `qa-shell.mjs` | The Study group follows *Start here*; *Practice* is not in the rail; `#practice` still routes. |
| Screenshots | Re-run `scratchpad\studyflow\shots.mjs` and compare with today's set (counts in "Before and after"). |

Run order:
1. `node app/fs/test/test-weakspots.mjs`, `test-insights.mjs`, `test-checks.mjs`, `test-fs.mjs`, `node app/course/test/test-kit.mjs`.
2. `node scripts/build-fs-studio.mjs`, then serve `dist` on 4714.
3. `qa-weakspots`, `qa-practice`, `qa-equations`, `qa-exam`, `qa-phone-course`, `qa-phone-shell`.

---

## 4. Wording for the UI

**Rail:** heading **Study**; items **Study**, **Weak spots** ("12 to fix"), **Flashcards** ("27 due"), **Mock exam**.

**Study:**
- Title **Study**; subtitle "Practice built from your own answers".
- **Up next.** The lines in 2.4. For an empty record: "Start with the first lesson. After a few answers this will say what to work on next, worked out from what you get right and wrong." → *Open the first lesson*.
- **Or choose**, with **Length** *10 / 20 / 40 problems*:
  - **Weak topics** — "Your weakest topics, each with a short refresher, then problems." [Start]
  - **Mixed review** — "A bit of everything you have studied, the long-unseen first." [Start]
  - **Equation drill** — "Which equation, what it means, how to write it. Weakest first." [Start] *Choose…*
  - **Something specific** — [Pick… ▾] [Start]. Groups: *Exam-heavy* (Law and water · Field GNSS · Exam formats · Terms sprint), *A whole module*, *One topic*.

**Weak spots:**
- Subtitle "360 answers kept · 8 weak topics · 12 to fix".
- Primary **Work on these**.
- Rows: [Practise] *More*. Folded: "Early warnings (14)", "Turning the corner (3)", "Every topic you have answered (236)".
- Mistakes tab primary: **Fix these 12**.
- Empty state: "Every answer you give is kept here. After a few, this page shows what keeps going wrong and sets to put it right." [Take the Module 1 check] [Open Study]

**End of any set:** **Another session like this** (primary), *Back to Study* or *Back to Weak spots*; *Your answers* (folded); Lantern's review.

**Review panel:** **Practise these** (primary), *Open Weak spots*.

**Mock exam, length select:** *Full paper — 110 questions · 5 h 20 min*, *Half paper — 55 · …*, *Quick sit — 20 · …*, *Weak-spot paper — 20 from your weakest topics and mistakes*. Under it, only when that option is chosen: "Timed and marked like a mock, but not counted as your best mock."

**Progress:** **Work on my weak topics** (primary), *Open Weak spots*.

**History *Where* labels:** unchanged, because old answers carry them: Module check · Practice · Mock exam · Study session · Weak-spot quiz · Weak-spot paper · Lesson practice.

---

## 5. What this deliberately does not do

- It adds no page, no rail item, no badge, no state field and no settings control.
- It does not merge Flashcards into Study (spaced repetition keeps its own rhythm; Up next schedules it), and it does not change module checks, lesson *Try it* or the mock exam's own screen.
- It drops two Practice-page filters, **difficulty** and **written/generated only**. They are rarely the right choice for exam preparation, and *Another like this* already gives endless generated problems. If the owner wants them back, they belong under the picker's *A whole module* entry as one *Options* line, not as a page.
