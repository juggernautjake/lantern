# FS course: user-interface audit (2026-10-22)

The owner's brief: every panel, hub, navigation item and control should make sense and look good. Every button should work. Things should render where they belong. After any click, answer or finished set, the view should land where the learner needs it, so they never have to scroll for the next thing. The owner wants **no new features or elements, only consolidation and smoothing**. Each item below fixes an existing behaviour or merges existing elements.

**Nothing has been fixed yet.** Other agents are changing `app/course/study.js`, `shell.js`, `notes.js`, `insights.js` and the study-flow, mock-exam and reorder designs in parallel. Line numbers are from the working tree on 2026-10-22, so search by the function named next to each one.

## How it was checked

- **Crawler:** `scripts/qa-ui.mjs`. It covers every one of the 241 navigation pages: start, 13 module overviews, 189 lessons, 13 summary sheets, 13 module checks and the standing pages. It also covers the header, the rail, the four floating panels, the glossary popup and the phone drawer.
- **Configurations:** 1280×800 desktop and 390×844 phone, each in light and dark (system colour scheme, Automatic palette). That makes four runs.
- **Clicks:** 3,679 controls were clicked, each one logged with its effect.
  - A control whose first click changed nothing was clicked again with a real pointer before it was reported.
  - Repeated copies of the same component (glossary terms, "Keys for …", video controls) were sampled: at most 4 per page and 40 per run.
- **Static checks on every page, top to bottom:**
  - horizontal overflow;
  - controls covered at every scroll position (`elementFromPoint` at the control's centre);
  - unlabelled controls;
  - overlapping text;
  - broken images and empty blocks;
  - template leftovers (`undefined`, raw markdown or LaTeX, entities);
  - text contrast;
  - console errors and failed requests.
- **Flows:**
  - lesson "Try it", module check, practice, every study-session card, equation drill, flashcards;
  - mock exam: Begin, Next, Map, map cell, Finish;
  - each panel, opened with Enter and with its letter key, then closed;
  - glossary popup, rail and drawer, prev/next, Back and Forward, the five search boxes;
  - a phone keyboard over the answer box;
  - findability from the start page.
- **Re-test:** every defect listed below was reproduced at least twice: once in the crawl, and again in an isolated re-test from a fresh learner. The re-test scripts are in the scratchpad (`uiaudit/verify.mjs`, `v2`–`v6.mjs`). Anything that did not reproduce, or was a crawler artefact, was dropped. See "Checked and fine" at the end.
- **Evidence:** screenshots are in `dist/qa-ui/evidence/` (git-ignored, local). The full crawl output, findings JSON and click logs are in the session scratchpad under `uiaudit/run`, `uiaudit/flows` and `uiaudit/verify`. `node scripts/qa-ui.mjs --out <dir>` regenerates everything.

**Counts:** 10 broken, 13 confusing, 8 cosmetic. 11 simplifications.

---

## Broken

### B1. After "Check answer", the Next button is off-screen

- **Where:** every quiz runner (module checks, practice, lesson "Try it", every study session), on both devices.
- **What happens:**
  - The verdict is scrolled into view (`nearest`), but the worked solution under it is typically 450–1,350 px tall.
  - "Next question" / "Next problem" / "See results" sits under the working, 300–1,250 px below the window.
  - Module check 1 had the button out of view on 14 of 20 questions on desktop and 18 of 20 on the phone. Study sessions had it out of view on almost every question.
  - The learner scrolls past the whole working to go on.
- **Should:** the verdict and the way on are both in view the moment it is marked.
- **Evidence:** `B1-desktop-check-next-below.png` (button at y = 1,601 in an 800 px window), `B1-phone-check-next-below.png`.
- **Code:** `app/course/quiz.js` `card()` → `finish()`.
  - The `after` actions (Try another / Next) are appended to the end of `resultBox`, after `solutionNode()` (around line 640–680).
  - The only scroll is `Course.reveal(head, 'nearest')` (line 687).
- **Fix:** no new element. Put the existing `after` row directly under the verdict line, above "Expected …" and the working, so the working reads below it. Then reveal the verdict with `block: 'start'`. The same change fixes B1 in sessions and equation practice, because they reuse `card()`.

### B2. Finishing a set leaves the score off-screen

- **Where:** Module check, practice, lesson "Try it". On the phone, the study-session review too.
- **What happens:**
  - The runner replaces the card with the result, so the page shrinks under the reader.
  - The score lands 450–1,360 px **above** the window, and the reader sees the middle of the review list.
  - Focus is on `<body>`.
- **Should:** the score ("70% · Passed") is at the top of the view, with focus on it.
- **Evidence:** `B2-desktop-tryit-results-above.png`, `B2-phone-check-results-above.png`.
- **Code:** `app/course/quiz.js` `runner()` → `done()` (line 785 on) never scrolls or focuses. Sessions only call `Course.reveal(stage,'start')` 30 ms later (`sessions.js` line 461).
- **Fix:** at the end of `done()`, `Course.reveal(resultEl, 'start')` and focus the result block (`tabindex=-1`).

### B3. Mock exam: "Next →" leaves the new question above the window

- **Where:** Mock exam (and weak-spot papers), desktop. It also happens on the phone whenever the reader had scrolled past the question.
- **What happens:**
  - Question 2 is drawn, but the view stays at the bottom: the map, the course prev/next and the footer.
  - The question text is at y = −276.
- **Should:** each new question starts at the top of the view, under the sticky exam bar, with focus on it.
- **Evidence:** `B3-desktop-exam-next.png`.
- **Code:** `app/course/shell.js` `sit()` → `move()` (line 1608–1614). The guard `bar.getBoundingClientRect().top < 0` never fires, because `.xbar` is sticky. When it does fire, it scrolls the bar, not the question.
- **Fix:** scroll the question card (`body`) to `start`, with a `scroll-margin-top` equal to header + exam bar, then focus the card or its first input.

### B4. Mock exam: a map cell jumps to a question that is not shown

- **Where:** Mock exam map (question number buttons), desktop and phone.
- **What happens:** pressing "5" draws question 5 above the window (−193 px on desktop, −571 px on the phone). The reader still sees the map. Focus stays on the "Map" button.
- **Should:** same as B3.
- **Evidence:** `B4-desktop-exam-mapcell.png`, `B4-phone-exam-mapcell.png`.
- **Code:** same `move()`. The map buttons call it (`paintMap()`, line 1625 on).
- **Fix:** same as B3.

### B5. Phone: "Begin" a mock exam and the first question is above the window

- **Where:** Mock exam intro, phone.
- **What happens:** Begin sits under the plan table, so the page is scrolled about 745 px. `sit()` replaces the intro but keeps the scroll, so question 1 is at y = −347 and the reader sees its answer buttons.
- **Should:** the paper starts at the top.
- **Evidence:** `B5-phone-exam-begin.png`, `B5-phone-exam-begin-retest.png`.
- **Code:** `shell.js` `renderExam()` → `start()` / `sit()` (lines 1442–1460). There is no scroll after the paper is drawn.
- **Fix:** `window.scrollTo(0,0)` (or reveal the exam bar) at the end of `sit()`, then focus question 1.

### B6. The Formula sheet's module headings are dead links

- **Where:** Formula sheet. All 13 headings ("Module 1 — Fundamentals of Surveying" …) are styled as links.
- **What happens:** clicking does nothing: no navigation, no scroll. Each heading calls `go('m' + n + '-formulas')`, but modules no longer have a `-formulas` page. `navById['m2-formulas']` is undefined and `go()` returns silently.
- **Should:** open that module's formulas (its Summary sheet holds "Every formula in this module"), or not look like a link.
- **Evidence:** `B6-formula-sheet-dead-heading.png`. The crawler found it 4× per run (sampled); the re-test confirmed `#formulas → #formulas`.
- **Code:** `shell.js` `renderFormulas()`, line 2008.
- **Fix:** `go('m' + mod.n + '-summary')`, or render a plain heading.

### B7. "Check answer" with nothing entered is marked wrong and counted as a miss

- **Where:** every quiz card. Numeric: "Not quite — That is not a number I can read." Choice: "Not quite — 3 not selected." Plain "Not quite" also occurs.
- **What happens:** the blank is graded, the card locks, the working is shown, and the miss goes into the topic tally and the answer log. That pollutes Weak spots and the "best session" choice. (The page does not jump, which is good.)
- **Should:** an empty Check says "Enter an answer first (or press Show me how)" in the existing live region and does nothing else.
- **Evidence:** `B7-desktop-blank-check.png`.
- **Code:** `app/course/quiz.js` `doCheck()` (line 601). `Course.study.isBlank` already exists.
- **Fix:** `if (S.isBlank(r)) { resultBox.textContent = '…'; return; }` before `finish()`.

### B8. The Notes panel does not close on Escape

- **Where:** Notes panel, both devices.
- **What happens:** Escape closes the calculator, the reference sheet, the handbook and the glossary popup, but not Notes.
- **Should:** Escape closes it, like the other three panels. Flush what was typed first.
- **Evidence:** `B8-notes-panel.png`. Re-test: still open after Escape, on desktop and on the phone.
- **Code:** `app/course/notes.js` `install()` keydown handler (line 605 on). It handles Ctrl+S and N, never Escape.
- **Fix:** `if (e.key === 'Escape' && panel) { flush(); close(); }`. Skip it when an IME is composing.

### B9. Starting a study session lands below the question

- **Where:** Study sessions: every card except Best and Weak (which open with a refresher). That is Mixed review, Exam formats, Land law, GNSS, Terms and Solve-only drill.
- **What happens:**
  - The first question's header and opening lines are above the window. The worst case was −522 px for Land law: the reader sees only the answer choices, the course prev/next and the footer.
  - The first input is auto-focused without `preventScroll`.
  - `Course.reveal(stage,'start')` uses `scrollIntoView` with no offset for the 53 px sticky header.
  - The two scrolls fight.
- **Should:** the session title and question 1 at the top of the view.
- **Evidence:** `B9-session-start-law.png`, `B9-session-start-gnss.png`.
- **Code:**
  - `app/course/sessions.js` `step()`: `Course.reveal(stage, 'start')` (line 439). The stage has no class, so no `scroll-margin-top`; only `.sess` has one, in `styles-eq.css` line 219.
  - `quiz.js` line 700: `setTimeout(input.focus, 30)`.
  - `Course.reveal` (`quiz.js` line 65).
- **Fix:**
  - One global rule: `html { scroll-padding-top: <header height + 12px> }`, with a phone `scroll-padding-bottom` for the tool bar. Every `scrollIntoView` then respects the bars.
  - Focus inputs with `{ preventScroll: true }` and let `reveal` do the scrolling.
  - This also fixes C8 and part of B3/B4.

### B10. "Watch it taught" / "Watch that part" throws away the set in progress

- **Where:** Practice, lesson "Try it" and study sessions. Shown after a miss, and on the session refresher cards. Only module checks and the mock exam are saved.
- **What happens:** the button navigates to the lesson page. Back returns to an empty Practice or Study sessions page.
  - Practice "3 of 10" was lost.
  - A weak-spot session at "Problem 10 of 22" was lost; Back showed the session menu.
- **Should:** watching the explanation must not lose the set. Either play the chapter in place (the player already embeds anywhere: `Course.video.embed`), or keep the run so Back resumes it.
- **Evidence:** `B10-practice-watch-offer.png`, `B10-session-gone-after-back.png`.
- **Code:**
  - `quiz.js` `finish()` → the `qvideo` button `onclick: vid.open` (around line 655).
  - `sessions.js` refresher "▶ Watch it taught" (line 404).
  - `vid.open` → `shell.js` `openVideo` / `go()`.
- **Fix:** smallest change, no new element: open the chapter inline under the verdict (the same embed the Videos page uses for formula videos). Alternatively, save practice and session runs the way checks are saved (`S.saveCheck`). The study-flow merge design should own that choice.

---

## Confusing

### C1. Focus falls to `<body>` after Check, Show the answer and finishing a set

- **What happens:**
  - "Check answer" and "Show me how" remove themselves, so keyboard focus drops to `<body>` (32 of 32 runs). Tab restarts from the header.
  - The same happens in flashcards ("Show the answer" removes itself) and at the end of every set.
- **Should:** focus moves to the Next button, or to the verdict.
- **Code:** `quiz.js` `finish()` (`checkBtn.remove()`, line 608); `shell.js` `renderCards()` → `reveal()` (line 1278); runner `done()`.
- **Fix:** focus the primary button in the (moved, see B1) `after` row with `preventScroll`. The equation drill already does this (`equations.js` line 932).

### C2. After Next, focus sometimes is not in the new question

- **What happens:** focus lands in the new question for most types, but in about 1 question in 10–20 it is on `<body>`. Seen in checks, practice, sessions, and flashcards (where it happens on every card).
- **Code:**
  - `quiz.js` `buildInput()`: some input kinds (hotspot, ordering, matching) have no working `focus()`.
  - Flashcards `step()` never focuses.
- **Fix:** each input kind's `focus()` falls back to the card (`tabindex=-1`). Flashcards focus "Show the answer".

### C3. The panels neither take focus nor give it back

- **Where:** Calculator, Notes and Handbook panels; Reference sheet on return.
- **What happens:**
  - Opening with Enter leaves focus behind. On desktop it falls to `<body>`, because the floating button hides itself while its panel is open.
  - Closing never returns focus to the opener, for all four panels.
  - The Reference sheet is the only one that focuses its search box.
- **Evidence:** `C3-calculator-panel.png`. The findings JSON records `panel-focus` and `panel-focus-return` in all four runs.
- **Code:** `app/fs/calculator.js` `open()` / `close()` (lines 523/552); `app/course/notes.js` `open()` / `close()` (lines 215/221); `app/course/library.js` `openHandbook()` / `closePanel()` (lines 344/337); `app/fs/refsheet.js` `close()`.
- **Fix:** one shared pattern. Remember `document.activeElement` on open, focus the panel's first control (or its title, `tabindex=-1`), and on close focus the remembered element (or the floating button).

### C4. The glossary popup does not return focus

- **What happens:** the popup focuses its × (good). Escape or × closes it, but focus goes to `<body>`, not back to the term.
- **Code:** `app/course/glossary.js` `show()` / `close()` (line 158).
- **Fix:** keep the anchor in `show()`, and `anchor.focus({ preventScroll: true })` in `close()` when the popup held focus.

### C5. On desktop the rail never shows where you are

- **What happens:** the rail is a 241-item list that keeps its own scroll. Open Weak spots, Mock exam, Glossary, a Module 8 lesson or a check from anywhere other than the rail (start page, prev/next, a "Read the lesson" button, search), and the highlighted item is 6,000–11,000 px down the rail, out of sight. The phone drawer already centres it on open.
- **Evidence:** `C5-rail-weak-spots.png`. Re-test: Weak spots item at 10,831 px, rail visible area 53–800.
- **Code:** `shell.js` `renderRail()` / `go()`. Only `openRail()` (the drawer, line 263) scrolls `aria-current` into view.
- **Fix:** after `renderRail()` in `go()`, scroll the current item into the rail's own view (`block: 'nearest'`, rail only, not the page).

### C6. The study tools are hard to find

The owner's checklist was run as a findability pass from the start page.

| Thing the learner wants | Shortest way in today (desktop / phone) |
| --- | --- |
| Lessons, videos (in the lesson), "Try it" practice | Easy: Continue, the rail, the module table on the start page |
| Search any topic or video | Easy on desktop (rail box at the top); on the phone, ☰ first. Searches **videos and lesson headings only**: glossary, formulas and the library each have their own box |
| Module checks (quizzes) | Rail, end of each module (labelled only "◆ Module check": see C10) |
| Calculators, handbook viewer, reference sheet | Easy: floating buttons on every page (C / H / R keys) |
| Study sessions, Practice, Weak spots, Videos page, Flashcards, Mock exam, Calculator page, Formula sheet, Glossary, Library (codes and standards) | **Hard.** Only at the very bottom of the rail, after all 189 lessons: about 14.5 rail-heights of scrolling on desktop, about 15 screens in the phone drawer (☰, then scroll). The start page names "Practice" and "mock exam" in bold text that is not linked. |

- **Evidence:** `C6-phone-drawer.png`. Findability data is in each findings JSON (`info-findability`): Study sessions at 12,555 px of an 844 px drawer.
- **Code:** `shell.js` `railRows()` (line 177: modules first, then `PAGE_NAV` appended last); `renderStart()`.
- **Fix:** no new elements. Move the existing "Anytime" group (the standing pages) to the top of the rail, above Module 1, and collapse modules other than the current one (see S5). Make the existing bold words on the start page links.

### C7. Equation drill: after a choice, the Next / Check button is just below the window

- **What happens:** on desktop the button is at 804–842 in an 800 px window. In round 2 on the phone, the feedback and Next were both below.
- **Evidence:** `C7-eqdrill-next-below.png`.
- **Code:** `app/course/equations.js` `step()` (lines 925–939). It focuses Next with `preventScroll` but never reveals it.
- **Fix:** `Course.reveal(after, 'nearest')` after the feedback is drawn. The global scroll padding from B9 keeps it clear of the bars.

### C8. Phone: the verdict and "Knew it" land under the bottom tool bar

- **What happens:** `Course.reveal(…,'nearest')` aligns to the bottom of the window, which is under the 58 px Notes / Handbook / Reference / Calculator bar. The verdict was at 816–844 behind the bar, and flashcards "Knew it" at 800–844.
- **Evidence:** `C8-phone-verdict-under-bar.png`, `C8-phone-flashcards-knew-under-bar.png`.
- **Code:** `quiz.js` `Course.reveal` (uses `innerHeight - 60`); `styles-mobile.css` lines 306–326 (the bar).
- **Fix:** add `scroll-padding-bottom` for the bar's height (B9), and make `reveal` measure the same band.

### C9. Mock exam: Map moves the page but not the focus

- **What happens:** Map scrolls to the map, but focus stays on the Map button, so a keyboard user Tabs back through the whole question. After a map cell or Next, focus is on `<body>` or the Map button.
- **Code:** `shell.js` `sit()` Map button (line 1474); `move()`.
- **Fix:** focus the map (`tabindex=-1`) after the scroll. After `move()`, focus the question (B3).

### C10. Module checks go by three names, and all 13 look the same in the rail

- **What happens:**
  - The rail says "◆ Module check" 13 times, with no number or module.
  - Every check page's h1 is "Module check".
  - The navigation title (prev/next buttons) is "<Module title> check", e.g. "← Descriptions, Conveyances and Boundary Disputes check".
  - The crumb carries the module, but the rail does not.
- **Evidence:** `info-names` in every findings JSON.
- **Code:** `shell.js` NAV build (line 54), `railRows()`, `renderCheck()`.
- **Fix:** one name everywhere: "Module 7 check".

### C11. "Solve-only equation drill" serves land-law questions and reading refreshers

- **What happens:** started fresh, it opened with a reading refresher. Its questions included "The east half of a farm was deeded to Ames …" (priority of conveyances), which needs no equation. The name promises solving equations.
- **Evidence:** `C11-solve-only-drill-law-question.png` (the Ames/Burke choices).
- **Code:** `sessions.js` `run()` with `kind: 'drill'`:
  - `pickTopics('drill', …)` picks from all weak topics;
  - `questionsFor(..., { generatedOnly: true })` falls back to non-generated questions when a topic has no generator;
  - refreshers are queued for every non-mixed kind.
- **Fix:** restrict drill topics to ones with generators (`withGen`, already computed at line 105), and skip refreshers for `drill`. Or remove this third drill button (S2).

### C12. The exam's course navigation stays live during a timed sitting

- **What happens:** under the question map, the page's prev/next ("← Flashcards", "Calculator →") and the whole rail remain. One click leaves the paper mid-sitting. It is saved, so nothing is lost, but it is the opposite of an exam rehearsal and there is no "you are in an exam" state.
- **Evidence:** `B3-desktop-exam-next.png` (prev/next under the map).
- **Code:** `shell.js` `renderExam()` line 1770: `prevNext(navById.exam)` is appended regardless of state.
- **Fix:** omit prev/next while a paper is being sat, and restore it on the intro and results. (The mock-exam design doc may already cover the CBT-style shell.)

### C13. Notes still mention an assistant the studio does not have

- **What happens:** the empty state says "You can also ask Lantern to write something down for you." In the standalone FS studio there is no assistant.
- **Evidence:** `C13-notes-mentions-lantern.png`.
- **Code:** `app/course/notes.js` line 321 (empty-state tip).
- **Fix:** show that sentence only when `hosted()` (as `weakspots.js` already does for "Ask Lantern to explain").

---

## Cosmetic

### K1. Desktop: the floating-button stack overlaps the content column

- **What happens:** at 1280×800 the four floating buttons (x 1131–1262, y 580–782) overlap the right edge of the content (to x 1156). They partly cover "Module overview →" / "Practice →" at the page end and the video's "Step by step" toggle. Scrolling frees every control (no control was covered at every position), so this is cosmetic.
- **Evidence:** `K1-fab-over-next-button.png`, `K1-fab-over-video-toggle.png`.
- **Code:** `app/fs/styles.css` `.calcfab` rules; the `.main` width.
- **Fix:** below about 1,400 px wide, show the icon-only round buttons that the phone breakpoint already uses (`styles-mobile.css` lines 415–424). Or reserve a right gutter on `.main`.

### K2. The "Anytime" crumb on the 14 standing pages

- **What happens:** the eyebrow over "Weak spots", "Mock exam" etc. reads "ANYTIME". It mirrors the rail group heading but means nothing on the page.
- **Evidence:** `K2-anytime-crumb.png`.
- **Code:** `shell.js`: `pageHead('Anytime', …)` ×14; the rail `h4 'Anytime'` (line 195).
- **Fix:** use the course name, or no crumb.

### K3. Two wordings for the same "done" button

- **What happens:** lessons say "Mark this lesson done" / "Done ✓ — click to unmark". Overviews and summaries say "Mark this read" / "Read ✓ — click to unmark".
- **Code:** `shell.js` lines 530 and 589.
- **Fix:** one wording.

### K4. Videos page: an empty status line holds a gap

- **What happens:** `p.vlib-status` is empty until a search runs.
- **Evidence:** `K4-videos-empty-status.png`.
- **Code:** `shell.js` `renderVideos()`.
- **Fix:** add it only with text, or set `min-height: 0`.

### K5. Weak-topic cards: "Find videos" looks like a link inside a button

- **What happens:** it is underlined and bordered, unlike its sibling buttons.
- **Evidence:** `B2-phone-check-results-above.png`.
- **Code:** `app/course/insights.js` line 582. It is an `<a class="btn" target="_blank">` to an outside video search, so it picks up link underline.
- **Fix:** add `text-decoration: none` to `a.btn`. Also mark that it opens outside the course (↗), because it is the only control in the review that leaves it.

### K6. Phone keyboard: "Check answer" sits just below the visible area

- **What happens:** with the keyboard up (viewport about 508 px), the answer box is visible (it is not hidden, and `inputmode="decimal"` is right), but Check is at 548–592. Enter works, so this is minor.
- **Evidence:** `K6-phone-keyboard.png`.
- **Code:** `quiz.js` numeric input.
- **Fix:** on focus, `scrollIntoView` the `.qactions` row (`block: 'nearest'`) after the resize.

### K7. Phone calculator panel: tabs clipped, desktop-only instructions

- **What happens:** the tab strip shows "TI-30Xa · Videos · Button…" cut off. The help reads "Right-click a key … or type on your keyboard" on a touch phone.
- **Evidence:** `K7-phone-calculator-tabs.png`.
- **Code:** `app/fs/calculator.js` panel header; the help text is at line 158.
- **Fix:** fade-hint the tab scroller (the shell's `hintScrollers` already does this for tables), and use touch wording when `(pointer: coarse)`.

### K8. The empty Handbook panel promises search

- **What happens:** with no PDF added, the subtitle "search on the left, as on exam day" sits over an "Add your handbook" card.
- **Evidence:** `K8-handbook-panel-empty.png`.
- **Code:** `app/course/library.js` `openPanel()` (line 321).
- **Fix:** show the subtitle only when the handbook is present.

---

## Simplifications (fewer, clearer elements; nothing new)

### S1. Four separate builders of question sets: merge into one

- **Practice:** module, difficulty, source ("Mixed / Generated only / Bank only / **My weak areas**"), count.
- **Study sessions:** material, length, and 9 cards, including "**Strengthen my weak spots**".
- **Weak spots:** focus, "Quiz or timed paper", length 10–110, and "**Practise — 10 questions**" on each topic.
- **Mock exam:** length.
- Practising weak areas is reachable three ways under three names.
- **Evidence:** click logs for `practice`, `study`, `weak (with answers)`; `weakspots.js` lines 429–448.
- **Proposal:** Practice's selects become the "Custom" card on Study sessions, and the Practice page goes. Weak spots stays the record; its Start hands its selection to the same session runner. Feed this into `docs/dev/study-flow-plan.md`.

### S2. The equation drill has three buttons, and "Best session" is a fourth way in

- The buttons are "Set up a drill", "Quick drill · 10" and "Solve-only drill" (which is not an equation drill: C11). "Best session for me now" also starts an equation drill ("Round 1 of 20").
- **Proposal:** one "Equation drill" button that opens the set-up with Quick as the default. Drop Solve-only (Mixed review with "Generated only" covers it, after S1).

### S3. Reference material under five names

- The names are "Formula sheet" (page), "Reference" (floating button, panel titled "Reference sheet", **also embedded inside the Formula sheet page** as "Search the reference sheet"), "Handbook" (floating button), "Library" (rail; page id `refs`, the code still says "Reference library"), and "Calculator" (rail page) next to "Calculator" (floating button, panel titled "Calculators").
- In FS, "Reference" also means the NCEES *Reference Handbook*.
- **Proposal:**
  - Call the formula/conversion sheet "Formula sheet" everywhere, and let the R button open it.
  - Keep "Handbook" for the NCEES PDF only.
  - Name the Library "Codes & standards" (that is what it holds).
  - Fold the Calculator *page* into the calculator panel (S4).

### S4. The Calculator page duplicates the Calculator panel

- **Evidence:** the click log shows the page's main buttons ("Open the calculator", "Look up a key", "Guided routines", "Which calculator?") only open tabs of the floating panel. The routines list is Module 9's job.
- **Proposal:** remove the rail page. The panel (C key / floating button) is the calculator's one home, and Module 9 teaches it.

### S5. The rail has 241 rows, all expanded

- Every lesson of all 13 modules is always listed. That is why the standing pages are 14–15 screens down (C6), and why the current item is out of sight (C5).
- **Proposal:** the existing "Anytime" group first; modules as collapsible groups with only the current module open. Same items, same order inside each group.

### S6. The header repeats Progress and Appearance

- **Progress** is the header progress bar, the header "Progress" button and the rail "Progress".
- **Appearance** is the header text-size control, six palette swatches and an "Open Appearance" swatch, plus the rail page "Appearance" with the same controls. The header already hides most of this on the phone.
- **Proposal:** make the header progress bar the link to Progress and drop the separate button. Keep text size in the header; move palettes to the Appearance page only.

### S7. Three study surfaces for the same idea: "where am I weak?"

- They are the Weak spots page, the "Where to focus" box on Study sessions, and the after-session review panel (each lists weak topics with Practise / Watch / Read buttons).
- **Proposal:** fold into S1. The review panel and the Study sessions box link to Weak spots, rather than repeating its cards.

### S8. Module check: one name

See C10. Use "Module N check" in the rail, h1 and prev/next.

### S9. Lesson completion: one button, one rule

- "Mark this lesson done" and "Mark this read" (K3) differ.
- Lessons also mark themselves done after the video and its questions, which the button's caption explains in a second sentence.
- **Proposal:** one wording, one sentence.

### S10. Four floating panels, but only one can be open

- Only one panel shows at a time. With all four buttons pressed in turn, only the last (Calculator) was showing, in every run.
- On the phone the bar of four takes 58 px (7%) of every screen.
- **Proposal:** after S3, Reference and Formula sheet are the same thing, so only three buttons are needed: Notes, Handbook / Formula sheet, Calculator.

### S11. Search is split across five boxes

- The boxes are: the rail ("videos & topics"), Videos, Formula sheet, Glossary and Library. The rail box goes to the Videos page.
- **Proposal:** keep the rail box as the one way in. On its results page, add the glossary, formula and library hits as more groups in the existing result list (the Videos page already groups "lesson headings"). Leave the per-page boxes as filters.

---

## Checked and fine (not defects)

- **Rendering:** no horizontal overflow, no console errors, no failed requests, no broken images, no template leftovers, no unlabelled controls, on any of the 241 pages in all four runs.
- **Contrast:** the only low-contrast hits were the video's own caption layer under its poster, which is not visible.
- **Controls:** no control is covered at every scroll position. The phone bar hides while an input has focus, which is good.
- **Phone keyboard:** the answer box stays visible with the keyboard up, and numeric boxes use `inputmode="decimal"`.
- **History:** Back and Forward follow pages correctly. Back restores the reading position. Back into a module check resumes it.
- **Next question in checks and practice:** the new question's start is in view, and the first input is focused (except C2).
- **Phone drawer:** opens with focus on its ×, centres the current item, closes on Escape and the scrim, and returns focus to ☰. Choosing an item closes it and lands at the top of the page.
- **Mock exam Finish:** "Finish and mark" scrolls its confirmation into view.
- **Crawler artefacts, discarded after re-test:**
  - radio and checkbox options in a locked or already-chosen answer;
  - the interactive figures' drag stages (`role="application"`);
  - video seek bars (JS clicks have no coordinates);
  - empty cells in field-note tables;
  - the video scene layers' overlap;
  - the Handbook panel's visually hidden file input.

## Re-running

```
node scripts/build-fs-studio.mjs
node scripts/serve-dir.mjs dist 4719
node scripts/qa-ui.mjs --out <dir>                                    # everything, ~1 h per configuration
node scripts/qa-ui.mjs --out <dir> --pages none --clicks none        # flows only, ~5 min each
node scripts/qa-ui.mjs --out <dir> --device phone --theme dark --shard 0/2   # split a configuration across processes
```

Useful flags:

- `--only m4-` restricts the crawl to one module.
- `--clicks standing` clicks only the standing pages and checks.
- `--sample-page` / `--sample-all` set how many copies of one component are clicked.

The exit code is 1 while anything is found.
