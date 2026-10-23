# Mock exam: make it sit like the real FS exam

Written 2026-10-22. **Design only.** Nothing in the code has changed. Implement this **after** the module renumbering and reorder (`docs/dev/fs-reorder-plan.md`), because both touch `shell.js`, `content.js` and `pages.js`. This plan names functions, not line numbers, so the reorder does not invalidate it. Where the reorder adds `num` / `C.label(n)`, use it.

The owner asked that "mock exams actually feel like and resemble the real exam as closely as possible". Two further rules apply:
- **No added complication.** The exam screen carries only the controls the real CBT has, plus our results report afterwards. Every button works. Nothing on the screen exists only for us.
- **Never scroll to find the question.** After every action, the stem and its answer choices are in view (§3.4 specifies scroll and focus for every action).

Copyright: resemble the experience; do not reproduce NCEES or Pearson VUE material. No NCEES logos, screenshots, tutorial text, NDA text, item text, or handbook text in the course. The handbook and the copyrighted standards stay the learner's own copies (library.js `license: 'yours'`, IndexedDB, never shipped). The layout and wording below are our own.

Screenshots of the current mock (desktop, 1440×900) are in a temporary working folder (not kept):
- `01-intro`
- `02-question-1`
- `03-type-*` (one for each of the 8 formats drawn)
- `04-map`
- `05-handbook-panel`
- `06-calculator-open`
- `07-refsheet-open`
- `08-paused`
- `09-confirm`
- `10-report-*`

---

## 1. The real exam (NCEES's own sources)

Sources:
- **[FS]** FS exam page: https://ncees.org/exams/fs-exam/
- **[SPEC]** FS CBT exam specifications: https://ncees.org/wp-content/uploads/2026/08/FS-CBT-specs-2024.pdf (4 pp.). The header reads "Effective Beginning with the July 2020 Examinations". The text is identical to the April 2024 copy.
- **[EG]** NCEES Examinee Guide, May 2026: https://ncees.org/wp-content/uploads/2026/05/NCEESExamGuide_May-2026-1.pdf (linked from https://ncees.org/exams/examinee-guide/)
- **[CBT]** Computer-based testing: https://ncees.org/computer-based-testing-cbt/ (alternative item types at `#ait`)
- **[SCORE]** Exam scoring: https://ncees.org/exams/exam-scoring/
- **[DIAG]** Sample diagnostic report: https://ncees.org/wp-content/uploads/2023/02/CBT-Diagnostic-for-the-web-site_October-2018.pdf
- **[PV]** Pearson VUE NCEES page: https://www.pearsonvue.com/us/en/ncees.html
- **[VID]** NCEES exam-day video playlist (linked from [FS]): https://www.youtube.com/playlist?list=PLiZ0hjHNi9jwKIYzX6dyB6rhiEPOP9o87. It did not load for research.
- **[DEMO]** Pearson's demo (linked from [PV]): https://www.pearsonvue.com/us/en/redirects/demo-test.html. It is a generic Pearson demo, not NCEES-specific, and it did not load.

Copies of the pages and PDFs are in the scratchpad `ncees\` folder.

### 1.1 Paper

**Questions and sections**
- 110 questions [FS; SPEC p.1; EG p.16].
- A limited number are unscored pretest items. They are placed at random and cannot be identified. NCEES does not publish how many [EG p.11, p.20].
- The exam is in **two sections** of "approximately half of the questions" each. The sections are not timed separately: the whole exam time is given at the start [EG p.11 §4].
  - 55/55 is our assumption. NCEES does not publish an exact split.

**How forms are built**
- Year-round exams use linear-on-the-fly testing (LOFT). Every examinee gets the same number of questions per topic and the same relative difficulty, but a different set of questions [CBT, "Year-Round and Single-Day Exams"].

**Units and reference**
- Units are SI and U.S. Customary. The exam is closed book with an electronic reference [SPEC p.1].

**Knowledge areas**

All ranges are numbers of questions [SPEC pp.1–3]:

| # | Area | Range | Subtopics |
|---|---|---|---|
| 1 | Surveying Processes and Methods | 16–24 | A instrumentation · B GNSS/GPS surveys · C control · D cadastral · E topographic · F construction · G land development · H field records |
| 2 | Mapping Processes and Methods | 14–21 | A basic mapping · B types of maps · C CAD/BIM · D GIS · E digital terrain models · F photogrammetry/remote sensing |
| 3 | Boundary Law and Real Property Principles | 19–29 | A public records/descriptions · B common law · C easements · D simultaneous/sequential conveyances · E metes and bounds · F PLSS · G water law · H sources of law · I encumbrances · J real property law |
| 4 | Surveying Principles | 13–20 | A basic surveying · B geodesy · C applied geodesy |
| 5 | Survey Computations and Computer Applications | 17–26 | A COGO · B traverse · C leveling · D least squares · E area · F horizontal curves · G vertical curves · H volume · I spreadsheets · J slopes/grades |
| 6 | Business Concepts | 11–17 | A planning · B safety · C liabilities · D contracts · E supervision · F documentation · G ethics · H communication |
| 7 | Applied Mathematics and Statistics | 10–15 | A college math · B probability/statistics · C measurement science · D quantitative reasoning |

### 1.1a Re-check against the spec, 22 Oct 2026

Fetched [SPEC] again (https://ncees.org/wp-content/uploads/2024/04/FS-CBT-specs-2024.pdf; "Effective Beginning with the July 2020 Examinations"; "6 hours to complete the exam, which contains 110 questions ... includes a tutorial and an optional scheduled break") and the [FS] page (NDA 2 min, tutorial 8 min, exam 5 h 20 min, break 25 min). Areas 1-7, their numbering, all subtopic letters and the ranges (16-24, 14-21, 19-29, 13-20, 17-26, 11-17, 10-15; the minimums sum to 100 and the maximums to 152, so any 110 is a draw inside the ranges) already matched `AREAS`. Fixed: wording only. Area 3 is "Boundary Law and Real Property Principles", area 5 is "Survey Computations and Computer Applications", and the subtopic names now follow the spec (1D Cadastral, 1H Field record keeping and documentation, 2A Basic mapping concepts, 2E Digital terrain model, 3B Common law principles, 5B Traverse closure and adjustments, 6A Project planning, 6F Project documentation and record management). `buildExam` now draws each paper's area counts anywhere in those ranges (summing to 110) instead of one fixed paper, and shares each area's questions evenly between its subtopics, capped by what the bank can serve over 50 papers without a repeat (`node scripts/fs-pools-check.mjs` prints the table and the thin subtopics). The spec prints no section split or per-subtopic quotas; the owner's 56/54 sitting (7a) is kept.

### 1.2 Appointment and time

- **Appointment length.** The sources disagree:
  - [FS] and [SPEC p.1] say **6 h**. The spec adds that this "also includes a tutorial and an optional scheduled break".
  - [EG p.16] says **5 h 55 min**, which is the sum of the parts below.
- **Parts of the appointment** [FS; EG p.16]:
  - **Nondisclosure agreement, 2 min.** Declining ends the exam and forfeits the fee [EG p.10, p.19].
  - **Tutorial, 8 min.** It covers moving between questions, flagging, opening the handbook and other exam tasks [EG p.10].
  - **Exam, 5 h 20 min** (320 min, 2.9 min per question).
  - **Scheduled break, 25 min.**
- **Section 1 ends.** After about half the questions you are "prompted to review and then submit them. You will no longer have access to those questions after you submit them" [EG p.11]. The break may be requested "after completing approximately half of the questions and clicking 'End Review'" [EG p.18].
- **The scheduled break:**
  - It is optional.
  - Unused break time is not added to exam time [EG p.12].
  - When the break expires, the exam clock restarts automatically [EG p.12].
  - Returning late reduces the time left for section 2 by the time you were late [EG p.18].
- **Unscheduled breaks** are allowed at any time, but the **clock keeps running** [EG p.12, p.18]. There is no pause.
- **When time runs out**, "any answers you have marked will still be submitted and scored" [EG p.11].
- **Scoring:** only correct answers count, with no deduction for wrong ones [EG p.14; SCORE]. A blank is simply not correct.

### 1.3 Questions and the screen

- "Most questions on exams are in traditional multiple-choice format with a single correct answer" [EG p.11]. The FS includes alternative item types (AITs) [FS].
- **The AITs, as NCEES describes them** [CBT #ait]:
  - **Multiple correct:** select multiple answers.
  - **Point and click:** click on part of a graphic.
  - **Drag and drop:** click and drag items to match, sort, rank or label.
  - **Fill in the blank:** enter a response. The guide says a *numerical* response [EG p.11].
- **No partial credit.** "All questions, including AITs, are scored as either correct or incorrect" [CBT; EG p.11].
- **Navigation.** NCEES says the tutorial covers advancing through questions and flagging items for review, and that each section ends with a review step and "End Review" [EG p.10–11, p.18].
- **Not documented by NCEES:**
  - the exact navigation controls;
  - the layout of the review screen;
  - highlight or strikethrough tools;
  - how the timer is shown.

  The usual Pearson VUE pattern is Previous / Next / Flag for Review, and a review screen listing every item as complete, incomplete or flagged with "review all / incomplete / flagged". This plan follows that pattern, but **the owner should confirm it from his sitting on 21 Oct** (§6).

### 1.4 References, calculator, scratch

**Handbook**
- The current FS Reference Handbook is an on-screen, searchable PDF.
- Every examinee has a **24-inch monitor so the question and the handbook fit side by side** [EG p.10].
- Search is the box on the left of the reference. **Ctrl+F is not available.** Zoom works [EG p.10].
- The handbook is free from MyNCEES. No printed copies are sold [EG p.10; SPEC p.4].
- NCEES's public pages do not name the version (2.5 is what the course uses).

**Supplied standards** ([EG p.16] "Design standards: yes"; [SPEC p.4])
- The six standards:
  - ALTA/NSPS Minimum Standard Detail Requirements, 2021
  - FEMA Elevation Certificate and Instructions, 2023
  - FGCS §3.5 Geodetic Leveling, 2004
  - FGDC Geospatial Positioning Accuracy Standards, Parts 1–5 (1998/2002/2005)
  - NSPS Model Standards A–H, 2002
  - U.S. National Map Accuracy Standards, 1947
- Each is a separate searchable PDF, and only **one is open at a time**. They are available throughout the exam. Answers are scored against these editions.

**Calculator**
- One approved handheld is allowed [EG p.8; FS]:
  - Casio fx-115 / fx-991
  - HP 33s / 35s
  - TI-30X / TI-36X
- **There is also an on-screen calculator: "A TI-30XS calculator can be accessed for on-screen use during the exam"** [EG p.8].

**Scratch materials**
- Two reusable booklets and three markers. No pens or paper [EG p.8–10].

### 1.5 Result

- Results arrive in about 7–10 days [EG p.14; SCORE].
- **Pass or fail only.** No score and no published cut score. The raw count of correct answers is converted to a scaled score [EG p.14; SCORE].
- **Failing candidates get a diagnostic report** [FS; EG p.14, pp.20–21; DIAG]. For each knowledge area it shows:
  - the number of questions;
  - "Your Performance" as a scaled 0–15 score, from which the number right cannot be worked out;
  - a bar comparing **your performance (solid line)** with **the average of passing examinees (dashed line)**.
- No questions or answers are released [EG p.14].
- Retakes: one attempt per quarter-year window, at most 3 in 12 months [EG p.5].

---

## 2. Current mock compared with the real exam

The current mock is built by `content.js buildExam()` and sat by `shell.js renderExam()`, with `sit()` and `examReport()`. It is saved by `study.js startMock()`, `saveMock()` and `recordExam()`. I measured over 10 simulated full papers (`scratchpad\simexam.mjs`).

| Point | Real exam | Lantern now | Gap |
|---|---|---|---|
| Paper size | 110 | 110 (or 55 / 20) | ok |
| Blueprint | 7 areas, fixed counts per form (LOFT) | 17/15/22/14/19/12/11, every area within range | ok. **Subtopics not balanced**: `ncees-sub` tags exist but are unused. 29 items tagged `ncees-sub:4E`, which doesn't exist (area 4 is A–C only). Thin subtopics: 1D 1 item, 2C 3, 5I 3, 6E 7 |
| Format mix | "Most" single-answer MC; AITs; numeric fill-in | per paper: 40.8 MC, **37.7 fill-in**, 9.2 multi-select, 7.2 hotspot, 4.6 match, 3.0 order, **6.2 true/false**, **1.3 multi-stage** | Fill-in is a third of the paper. True/false and "worked in stages" are not NCEES formats. MC is under half |
| Computations as MC | numeric MC ("most nearly") is the norm | generated questions (17.7 per paper) are always fill-in; only 8 of 1,087 generators have mistake-based distractors | needs distractors (§5) |
| Item hygiene | stems give no hints | 31 stems cite "(Handbook p. N)"; 220 start "True or False"; 3 MC have 3 or 5 options | exclude from the exam |
| Partial credit | none | `grader.gradeSet` percent adds partial credit (multi-select, order, match, stages); `correct` doesn't | percent inflated vs the real score |
| Difficulty | equal relative difficulty for every form | per paper 36 easy / 61 medium / 12 hard, random, not controlled | too easy, varies between papers |
| Repeats | new questions | papers are independent draws; `opts.exclude` exists but the shell never passes it. Nothing avoids items already seen in practice | add history-aware draw |
| Time | 320 min, wall clock, no pause | 320 min (`pages.js examMinutes`), **Pause** button and P key; leaving the page **stops** the clock; ticks capped at 5 s ("a sleeping laptop is not exam time") | unfaithful |
| Sections and break | 2 sections; section 1 reviewed and submitted, then locked; optional 25-min break, no carry-over, late return costs section-2 time | one 110-question run, no break | missing |
| NDA, tutorial | 2 min + 8 min, before the clock | none | missing |
| Screen | full-screen CBT: question, nav bar, timer; handbook side by side | course page: rail with every lesson (study material one click away), header search, theme and size controls, Notes, Reference sheet, Glossary, the course's own formula sheet (R), video search, and the Lantern assistant | far too much help is reachable; not CBT-like |
| Question header | item number | shows **type label and "Module N · title"**, which gives the topic away | remove |
| Controls | Previous, Next, Flag, Review screen, Handbook, Calculator, End review / submit | plus Pause, Map, "I don't know" (K), Clear answer, "Keep this order", Finish-and-mark in two places, key-hint text | extras to remove (owner rule) |
| Review | review screen of all items, then End Review | map grid always printed **below** the question (`04-map`), "Map" scrolls to it | turn into the review screen |
| Handbook | side by side, search on the left, one standard at a time | `library.js` panel **over** the question, 860 px wide, pinned left (`05-handbook-panel`). The supplied standards are in the library (`exam: true`) but not reachable from the mock | dock it beside the question; add the standards |
| Calculator | on-screen TI-30XS + own handheld | course TI-30Xa panel floats over the question (`06-calculator-open`) | keep an on-screen calculator but never over the question. A TI-30XS MultiView emulator is optional later (§3.7) |
| Feedback | none until the result | none until hand-in | ok |
| Result | pass/fail; failing: diagnostic by area (0–15, you vs passing average) | big percent + "pass mark 70%", Lantern review, grid, IDK gaps, **by module** table, weak tags, every question | lead with pass/fail and a diagnostic **by knowledge area**; keep our review below it |

---

## 3. The design

### 3.1 Flow of a full paper

These screens run in order. Each is one screen with one or two buttons:

1. **Intro** (the existing page). The paper-length select and **Begin**, as now. The past-papers table stays. The "How this paper is built" text is rewritten to describe the real structure in our own words: 2 sections, 25-min break, handbook and standards, on-screen calculator, pass/fail plus a diagnostic.
2. **Agreement, 2:00.** Our own two sentences, along the lines of: "This paper is sat under exam conditions: only the handbook, the supplied standards and a calculator. The clock does not stop."
   - Buttons: **I agree** / **I do not agree**. Declining returns to the intro, and no paper is saved.
   - When the 2 minutes run out, it returns to the intro.
3. **Tutorial, 8:00 countdown.** Our own one-page walkthrough of *this* screen: Previous / Next, Flag, Review, Handbook, Calculator, End review.
   - Buttons: **Start the exam** (starts early).
   - When the time runs out, the exam starts.
   - The tutorial time is not taken from exam time.
4. **Section 1** (questions 1–55) on the CBT screen (§3.3).
5. **Section 1 review screen** (§3.5). Its **End review** button opens a confirmation: "Submit section 1? You cannot return to these questions." The buttons are **Submit section** / **Return to review**.
6. **Break offer.** Buttons: **Take the 25-minute break** / **Continue to section 2**.
7. **Break screen.** A 25:00 countdown and one button: **Return to the exam**.
   - When the break expires, section 2 starts by itself and its clock runs.
   - Unused break time is not banked.
   - If the learner has left the page, the clock restarts at expiry anyway (wall clock), which matches "late return costs section-2 time".
8. **Section 2** (56–110), then its review screen. **End review** opens the confirmation "Submit the exam?" with **Submit exam** / **Return to review**.
9. **Result** (§3.6).

**Time runs out** in either section: the paper is submitted with whatever is answered, and the result opens. If time ends in section 1, section 2 is not offered. That is faithful: the time is one pool, and the guide's half-split is not separately timed.

**Shorter papers:**
- **Half paper (55):** one section of 160 min, no break.
- **Quick sit (20):** one section of 58 min, no break.
- Both still get the agreement and the tutorial. The tutorial has a **Start the exam** button, so it costs a returning learner one click.
- **Weak-spot papers** (`sitPaper`) use the same CBT screen as one section, with no agreement, tutorial or break.

### 3.2 Exam conditions everywhere (no "practice mode")

There is no conditions toggle, because it would be an extra control.

**The clock.** It is a wall clock, so `elapsed = usedBefore + (now − runningSince)`.
- No Pause button. No P key.
- No 5-second cap.
- Leaving the page does not stop it.

**Returning to the page:**
- If the section's time has expired, the paper is submitted as timed out and the result is shown.
- If the break has expired, section 2 resumes with its clock already running.

This replaces the current "pause / sleeping laptop" behaviour. The intro text says so in one sentence.

**While a paper is in progress** (`body.exam-mode`):
- The course rail, header search, theme/size controls, progress pill, **Notes**, **Reference sheet** (R), **Glossary**, video links and the Lantern assistant hand-off are hidden, and their keyboard shortcuts do nothing.
- Only the exam screen's own Handbook and Calculator remain.
- The host is told `kind: 'exam'` already (`HOST_KIND`). The assistant must also refuse to help mid-exam: tell the host `{lantern:'nav', kind:'exam', locked:true}`.

**Leaving.** There is no exit button. Closing the tab or using browser Back keeps the paper and the clock running, exactly like walking out on an unscheduled break.
- Going to `#exam` again resumes the paper.
- Any other route while a paper is live first shows the intro's existing resume card ("A paper in progress … Resume / Discard it"). That card exists today, so nothing new is added.

### 3.3 The CBT screen

It is a fixed, full-viewport layout (`position: fixed; inset: 0`) that covers the course chrome. It uses a plain, neutral skin that ignores the course theme: white/grey surfaces, system sans-serif, a dark title bar. It resembles a test-centre screen without copying Pearson's artwork, logo or exact colours. It still respects the size slider value (`--fs`) for accessibility.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ FS mock exam · Section 1 of 2          Question 12 of 55    Time  4:51:07 │  title bar
├──────────────────────────────────────┬───────────────────────────────────┤
│ 12.                                  │ [Handbook ▾ / standards]  search  │
│ Stem text …                          │                                   │
│ [figure, fitted]                     │    reference PDF (when open)      │
│ ( ) A   ( ) B   ( ) C   ( ) D        │                                   │
│                    (scrolls inside)  │                                   │
├──────────────────────────────────────┴───────────────────────────────────┤
│ ◂ Previous   ⚑ Flag for review   Review   Calculator   Handbook   Next ▸ │  nav bar
└──────────────────────────────────────────────────────────────────────────┘
```

**Nav bar.** Seven controls, each doing exactly one thing:

| Control | What it does |
|---|---|
| Previous | goes back one question |
| Flag for review | toggles the flag; `aria-pressed`, label "Flagged" when on |
| Review | opens the review screen |
| Calculator | toggles the on-screen calculator |
| Handbook | toggles the reference pane |
| Next | goes forward one question |
| End review | appears only on the review screen |

Next on the last question of a section opens the review screen. That is the usual CBT behaviour and adds no control.

**Removed from the exam screen:**
- Pause.
- Map.
- "I don't know" and the K key.
- Clear answer. A radio choice is changed by picking another; a typed answer is cleared by deleting it.
- "Keep this order". An ordering answer is recorded once moved. One that is never moved is blank, as now.
- Finish-and-mark in the bar and under the grid.
- The `xkeys` hint line.
- The type and module line.

**The stem carries its own instruction when needed.** The input already shows one for multi-select ("Select all that apply") and hotspot ("Click the part…"). Nothing else is printed above the question.

**Keys:** ← → move, 1–6 choose. These are kept, but there is no on-screen hint. Shortcut keys are no extra control, and they are disabled while typing.

**Reference pane:**
- **≥ 1200 px wide:** the pane docks to the right, and the question pane narrows. The split is 55/45 by default; the divider can be dragged. The pane is closed by default.
- **Narrower screens:** the pane opens as a full-width sheet over the question, with a Close × button, as now.
- **The doc menu** at the top lists the **Handbook** and the supplied standards: library docs with `exam: true`, excluding `nmas-fs` (the 1999 fact sheet is not on the NCEES list). It shows one doc at a time, as in [SPEC p.4].
- **Missing documents.** A doc not yet added (`license: 'yours'`) shows the existing "Add your copy" card. On the **intro** the learner sees which of these are missing *before* beginning ("Your handbook isn't added yet — add it first so the exam has it"). Adding a document mid-exam is impossible at a test centre and would cost exam time.

**Calculator:**
- It is the existing calculator panel in a compact floating window.
- **≥ 1200 px:** it is placed over the reference pane's area (bottom right), never over the question pane.
- **Narrower screens:** it is a bottom sheet with Close ×.
- Its tabs (Videos, Buttons, Routines, "Which calculator") are hidden in exam mode: only the keypad.

### 3.4 Scroll and focus after every action

These rules apply throughout:
- The question pane is the **only** scroller for the question. The page itself never scrolls (`body.exam-mode { overflow: hidden }`).
- Every new question sets the pane's `scrollTop = 0`.
- Figures are fitted: `max-height: clamp(220px, calc(100dvh - 330px), 560px)`, with the width scaled to match. On 1440×900 and 1280×800 the stem, figure and every choice fit without scrolling (enforced by QA, §4.3). Only an unusually long stem may make the pane scroll; in that case the stem's first line is still in view.

| Action | View | Focus |
|---|---|---|
| Exam / section starts, Next, Previous, ← → | pane `scrollTop = 0` | the question number heading (`h2.cbt-qn`, `tabindex=-1`), announced by screen readers. Arrow-key navigation keeps focus on the heading, so 1–6 work at once |
| Choose an answer (click, 1–6, type) | unchanged | stays on the input |
| Flag / unflag | unchanged | stays on the Flag button |
| Open Review | the review screen replaces the question pane, `scrollTop = 0` | the review heading |
| Review → a question number, or "Review flagged / incomplete" | back to the question pane, `scrollTop = 0` | the question heading. For "Review flagged/incomplete", Next/Previous step only through that filtered set until Review is opened again (the usual CBT behaviour) |
| Handbook opens | the pane opens beside the question (wide) or as a sheet (narrow). The question pane keeps its scroll position | the reference's **search box** |
| Handbook closes (button again, × or Esc) | the question pane is unchanged | back to the **Handbook** button |
| Switch document in the reference pane | the new doc at page 1 | the search box |
| Calculator opens / closes | opens without moving the question pane | open: the calculator display. Close: the **Calculator** button |
| End review → confirmation | a modal dialog | its primary button. Esc = "Return to review" |
| Section submitted → break offer → break → section 2 | each screen at its top | that screen's primary button. Section 2 starts with focus on question 56's heading |
| Time runs out | everything closes (reference, calculator, dialogs). A modal "Time is up — your answers have been submitted" with one button, **See your result** | that button. The result opens at its top with focus on the result heading |
| Submit exam | the result at its top | the result heading |
| Resume a paper (intro card or reload) | the question that was open, `scrollTop = 0` | the question heading |

### 3.5 Review screen

It shows a heading ("Section 1 review"), then three counts (Answered · Unanswered · Flagged), then a numbered list of the section's questions. Each row shows:
- the number;
- the first ~80 characters of the stem;
- "Unanswered" (no answer) and/or "Flagged".

Above the list are three buttons: **Review all**, **Review unanswered**, **Review flagged**. Clicking a row opens that question.

The bottom nav bar on this screen shows **End review** in place of Next. Calculator and Handbook stay available.

This replaces today's `paintMap()` grid under the question. Whether the real screen is a list or a grid is for the owner to confirm (§6).

### 3.6 Result: our version of NCEES's diagnostic

**Screen 1. Result.**
- A large **Pass** or **Fail**, labelled "Lantern's estimate". NCEES does not publish the cut.
- One line underneath: "*N* of 110 correct (*p* %). All-or-nothing scoring, as on the exam."
- The time used.

**The cut.** `pages.js` gets `examCut: 0.70` (the current 70 %, still an estimate). Scoring is **without partial credit** (§4.1), so the percent is the real raw percentage.

**Screen 1 continues. Diagnostic by knowledge area.** It is a table with one row per area:

| Column | Content |
|---|---|
| Area | its name |
| Questions | the number of questions in it |
| Your performance | a 0–15 score: `round(15 × right/total)` |
| Bar | a horizontal bar on 0–15, with a **solid line** at you and a **dashed line** at the estimated passing average (`15 × examPassAvg`, `pages.js`, default 0.75, labelled "estimated passing average") |

- The table is drawn in grayscale, like NCEES's, in our own layout. It shows for **every** result (NCEES gives it only on a fail; we always do, because the point of a mock is to learn).
- A one-line legend explains both lines.

**Below it: our results report.** These parts are kept, in this order:
1. Lantern's review (`insights.afterSession`, unchanged).
2. The results grid.
3. Filters (All / Wrong or blank / Right / Flagged).
4. Every question with its working.

These change:
- **"By module" → "By knowledge area"** (rows from `C.areaOf(q)`; the module table goes).
- **"Knowledge gaps"** (I-don't-know) is dropped for new papers. Papers saved before the change still show it when `idk` is present.
- The `Didn't know` facts and filter show only when `idkN > 0`.
- The "Weak areas" callout lists NCEES subtopic names (`ncees-sub`) rather than raw tags.

---

## 4. Code changes by file

### 4.1 `app/course/grader.js`

- **`gradeSet(questions, responses, opts)`.** Add `opts.allOrNothing`. When it is set:
  - `earned` counts `result.correct ? 1 : 0`;
  - `percent = correct/total`.
  - Also return `byArea` when a classifier is supplied: `opts.areaOf` gives `[{ area, right, total }]`.
  - Leave `grade()` and its partial `score` unchanged, because practice uses them.

### 4.2 `app/fs/content.js`

- **`isExamReady(q)`**, a new export. A question is exam-ready when:
  - its type is in `multiple_choice` (exactly 4 options), `multi_select`, `ordering`, `drag_label`, `hotspot`, `numeric_input`;
  - its stem has no `Handbook p.` and doesn't start with "True or False";
  - it is not training, and is not a figure that shows its answer (existing figure masks).
  - `true_false` and `multi_step` are never exam-ready.
- **`examFormatOf(q)`**: `'mc' | 'fib' | 'ait'`, where `numeric_input` is `fib` and the four AIT types are `ait`.
- **`examBlueprint(total)`.** Keep the area counts (they are already inside the ranges). Add, per area:
  - `sections: [n1, n2]`, splitting each area's count across the two halves (for example 17 → 9 + 8), so both sections carry every area;
  - `subs`, a per-subtopic quota proportional to the subtopic's bank share, at least 1 for every subtopic with ≥ 6 exam-ready items, capped at 40 % of the area.
- **`buildExam(opts)`**, rewritten:
  1. The pool is `isExamReady` items plus generators that can be shown as exam items (below).
  2. Per area, fill the subtopic quotas. Within them, hit the **format mix** `META.examMix`, default `{ mc: 0.78, fib: 0.10, ait: 0.12 }`, and the **difficulty mix** `META.examDifficulty`, default `{ easy: 0.20, medium: 0.55, hard: 0.25 }`. Use the nearest available item when a cell runs dry; never fail short.
  3. **Generators** give about 15 % of each area as before. A generator whose template has `options_generator.method === 'formula'` (mistake distractors) is rendered **as multiple choice** with a "most nearly" stem: set `question_type: 'multiple_choice'` on the realised item, using `engine.generateOptions`. One without distractors counts toward the `fib` quota. Once the fib quota is full, it is skipped.
  4. **History-aware.** `opts.exclude` (questions on the learner's last 6 papers, from `S.examHistory()` items) is a hard exclusion. `opts.prefer` (keys the learner has never answered, from `S.answerLog()`) is drawn first, with seen keys as fallback. The same generator key is never used twice on a paper, and not again within the last 2 papers.
  5. **Order.** Shuffle within each section. Return `{ questions, sections: [55, 55], blueprint, minutes, breakMinutes: 25 }`, where `sections` is the item count of section 1 and section 2; one-section papers return `[n]`.
- Remove the `/(EXCEPT|NOT)/` heuristic from `isExamFormat`. An "EXCEPT" MC is ordinary single-answer MC.

### 4.3 `app/fs/pages.js`

- `Course.meta`: add the following, keeping `examMinutes: 320` and `examTotal: 110`:
  - `examSections: 2`
  - `examBreakMinutes: 25`
  - `examNdaMinutes: 2`
  - `examTutorialMinutes: 8`
  - `examCut: 0.70`
  - `examPassAvg: 0.75`
  - `examMix`, `examDifficulty`
  - `examRefs`: `['ncees-fs-handbook', 'alta-2021', 'fema-ec', 'fgcs-barcode', 'fgdc-1', 'fgdc-2', 'fgdc-3', 'fgdc-4', 'fgdc-5', 'nsps-model', 'nmas']`
- `Course.copy.examNote`: rewrite to describe the real structure (§3.1 step 1). Drop the claim "about a fifth in the exam's own formats".
- New copy strings: `examAgreement`, `examTutorial`, `examBreak`, `examTimeUp`. All are our own wording.

### 4.4 `app/course/study.js`

**Mock state** (`startMock` / `currentMock` / `saveMock`) gains:
- `sections: [55, 55]`
- `phase`: `'nda' | 'tutorial' | 's1' | 'review1' | 'breakOffer' | 'break' | 's2' | 'review2'`
- `secUsedMs: [ms, ms]` and `runningSince` (epoch ms, or null)
- `breakStartedAt`
- `submitted: [bool, bool]`

`elapsedMs` stays as the total, for history and older code. The old 5-second accumulation is replaced by `runningSince`. `currentMock()` computes the live elapsed time and returns `expired: true` when `secUsed + (now − runningSince) ≥ limit`.

Other changes:
- **Migration.** A saved mock with no `phase` is treated as `'s1'` with `sections: [n]` and its `elapsedMs` as used time. Nothing is lost.
- **`recordExam`** stores `sections`, `breakTakenMs` and `byArea`, plus `allOrNothing: true`, so a paper scored all-or-nothing can be told apart from an older one that gave partial credit.
- `idk` keeps being read from old records. New papers write none.

### 4.5 `app/course/shell.js`, `renderExam()` and helpers

**`intro()`:**
- New copy.
- Before **Begin**, a single line listing any `examRefs` the learner has not added, with the existing library "Add" action.
- Begin goes to the agreement.

**New small renderers inside `renderExam`.** Each is one screen, built with `el()`:
- `agreement(paper)`
- `tutorial(paper)`
- `reviewScreen(paper, sec)`
- `breakOffer(paper)`
- `breakScreen(paper)`
- `timeUp(paper)`

**`sit(paper)`, rewritten as the CBT screen:**
- Builds the title bar, the question pane, the reference pane slot and the nav bar (§3.3).
- Adds `document.body.classList.add('exam-mode')` and removes it on stop.
- **Delete:** `setPaused` and the cover, the `idk` UI and the K key, `paintMap()`, the `exam-map-jump` and Pause buttons, Clear answer, "Keep this order", and the `xkeys` text.
- **Kept:** `keepAnswer()`, autosave, `onHide` persist, the ←/→/1–6 keys.
- **Questions shown** are only those of the current section. Previous at the first question of section 2 does nothing (the button is disabled), because section 1 is locked.
- **The tick** uses wall time (§4.4). At expiry it calls `timeUp()`, then `finish(true)`.
- **Focus and scroll** exactly as in §3.4, via one helper `showQuestion(k)` that sets `pane.scrollTop = 0` and `heading.focus({ preventScroll: true })`.

**`finish()`:**
- Calls `Course.gradeSet(qs, responses, { allOrNothing: true, areaOf: C.areaOf, passingScore: META.examCut * 100 })`.

**`examReport()`:**
- New top: pass/fail + the diagnostic (§3.6), drawn by a new function `diagnostic(byArea)`.
- Below it, the existing review, grid, filters and items.
- Swap "By module" for "By knowledge area".
- The `xgaps` block only when `idkN > 0`.
- The `xfacts` row drops "didn't know" when 0.

**`acrossPapers()`.** Unchanged, but its `passMark` reads `META.examCut`.

**Routing and chrome:**
- While `S.currentMock()` is live and not on `#exam`, `go()` shows the exam route, which renders the resume card.
- `tellHost` adds `locked: true`.
- The rail, search and fabs are hidden by CSS under `body.exam-mode`. Their key handlers also check `document.body.classList.contains('exam-mode')` and return early. Those handlers are in:
  - `refsheet.js` (R)
  - `notes.js` (N)
  - `glossary.js`
  - `library.js` (H opens the **exam reference pane** instead of the free panel)
  - `calculator.js` (C toggles the exam calculator)

### 4.6 `app/course/library.js`

- New `dock(slot, ids, opts)`. It renders `viewer(id, { compact: true })` into a given element (the exam's reference pane) with a doc `<select>` limited to `ids`, one doc at a time.
- `openPanel` stays for the course.
- `Course.library.missing(ids)` returns the `'yours'` docs not yet added (for the intro line).

### 4.7 `app/fs/calculator.js`

- `open(which, { compact: true, host: el })`: keypad only, mounted in a given host. In exam mode the shell passes a floating host positioned over the reference area.
- No new controls.

### 4.8 `app/fs/styles-exam.css`

- Add a `.cbt` block:
  - fixed grid `grid-template-rows: auto 1fr auto`;
  - `grid-template-columns: 1fr var(--ref-w, 0)` on ≥ 1200 px;
  - neutral palette variables scoped to `.cbt` (light only, as a test centre is);
  - the figure-fit rule (§3.4);
  - the review-list styles;
  - the diagnostic bar (solid and dashed marker lines, grayscale).
- Add `body.exam-mode` rules hiding `.rail`, the header controls and every `.calcfab` / `.reffab` / `.notesfab` / `.hbfab`.
- Delete the `.xpaused`, `.xidk`, `.xmap`, `.xcounts`, `.xlegend` and `.xkeys` rules once unused. Keep the `.xgrid.xresults` and report styles.
- `styles-mobile.css`: below 1200 px the reference pane and calculator become sheets.

### 4.9 `app/course/insights.js`

`afterSession` gets `passMark` from the session (already passed). Make sure it reads `session.results[k].correct`, not `score`, for exam sessions, so partial credit doesn't leak into "what to work on".

---

## 5. Question-bank needs

Counts are measured on the current bank. A full paper needs per area 17/15/22/14/19/12/11. With the target mix (78 % MC, 10 % fill-in, 12 % AIT), the exam-ready pool per area and the number of **disjoint** papers it supports:

| Area | Exam-ready | MC (4-opt) | Fill-in | AIT | Hard | Disjoint papers (format-limited) | Numeric-option MC | "most nearly" stems |
|---|---|---|---|---|---|---|---|---|
| 1 | 1,416 | 638 | 312 | 466 | 129 | 49 | 126 | 13 |
| 2 | 706 | 292 | 230 | 184 | 64 | 26 | 35 | 10 |
| 3 | 1,977 | 964 | 308 | 705 | 262 | 56 | 39 | 1 |
| 4 | 603 | 266 | 204 | 133 | 74 | 24 | 69 | 8 |
| 5 | 1,404 | 462 | 646 | 296 | 177 | 33 | 196 | 57 |
| 6 | 675 | 384 | 97 | 194 | 77 | 42 | 25 | 0 |
| 7 | 729 | 269 | 296 | 164 | 93 | 33 | 110 | 8 |

**What this means:**
- **Count is not the problem.** Every area supports ≥ 24 disjoint papers.
- **The problem is that computation is mostly fill-in**, whereas on the real exam it is mostly 4-option "most nearly" MC. Area 5 has 646 fill-in items but only 196 numeric MC.

**Needs:**
1. **Numeric MC with real distractors.** Add `options_generator: { method: 'formula', formulas: [...] }` (each formula a named common mistake: wrong sign, degrees vs radians, chord vs arc, ft vs US survey ft, forgetting curvature and refraction, …) to at least:
   - **35 generators in area 5**;
   - 20 each in areas 7 and 4;
   - 15 each in areas 1 and 2;
   - 5 in area 6 (economics: present worth and so on).

   That is 115 generators. They give each full paper ~16 freshly numbered computational MC items with never-repeating numbers.
   - Priority list: the owner's priority topics (`docs/dev/fs-audit-brief.md`). GNSS/PDOP, convergence, photogrammetry scale/relief/parallax, curvature and refraction, vertical curves (sag/crest), traverse closure, curve layout, slope/grade.
   - The template's existing explanation must also say why each distractor is wrong. The grader already shows the explanation.
2. **Convert written fill-in to MC.** Mark 300 static `numeric_input` items (area 5: 120, area 7: 60, area 4: 50, area 2: 40, area 1: 30) as `exam_mc: [3 distractors]`, with the same "named mistake" rule. `buildExam` renders them as MC on the exam only; practice keeps fill-in.
3. **Difficulty calibration.** Re-grade difficulty on the exam-ready pool against one rule: easy = one step, recall; medium = 2–3 steps, or applying a rule to facts; hard = multi-step, or a judgement between competing rules. Then the hard pool should be at least 25 % × 10 papers per area. Needs: area 2 +30 hard, area 4 +20, area 6 +25 (current hard counts 64/74/77 allow only 16–25 papers).
4. **Subtopic coverage.**
   - Fix the 29 `ncees-sub:4E` tags: reassign them to 4A–4C.
   - Write at least 15 exam-ready items each for:
     - 1D cadastral (1 now; much cadastral material is tagged 3F/3E, so re-tag where the item is about *field procedure*);
     - 2C CAD/BIM (3);
     - 5I spreadsheets (3);
     - 6E supervision (7);
     - 3I encumbrances (13);
     - 1G/1H/1E (17/17/16).
   - Each needs ≥ 15 so 10 papers can carry one without repeats.
5. **Supplied-standard items.** Questions that send the examinee into ALTA 2021 Table A, NSPS model standards, FGDC Part 3 (NSSDA 1.7308·RMSE), NMAS 1947 (1/30 in, 1/50 in) and FGCS 3.5 leveling, answered from the standard's edition year, as NCEES scores them. Target ≥ 10 per standard, tagged `std:<library id>` so `buildExam` can place 3–5 on a paper.
6. **Hygiene, as data rules checked by tests (§6):**
   - no "(Handbook p. N)" in an exam-ready stem (31 to strip, or keep them out of the exam);
   - every MC has exactly 4 options;
   - no "True or False" stem;
   - every exam-ready item has `ncees-cat` and `ncees-sub`;
   - AIT instructions are in the stem.

Authoring follows the existing pipeline (`fs-wave4-brief.md` contract, `rebuild-check` / `merge-rebuild`, `apply-audit` for tag fixes). Never copy NCEES handbook text or exam items.

---

## 6. Tests and QA

### 6.1 `app/fs/test/test-fs.mjs`, section "Mock exam" (extend)

**Blueprint and draw:**
- Every area is in range; each section carries ≥ 40 % of every area's count.
- `buildExam` over 50 papers:
  - each has 110 items, 55/55 sections, no duplicates;
  - **every item `isExamReady`**: no true/false, no multi_step, no "Handbook p.";
  - the format mix is within ±4 items of `examMix`;
  - the difficulty is within ±4 of `examDifficulty`;
  - every subtopic with a quota appears;
  - the mean difficulty of papers varies by ≤ 0.1 (LOFT parity).
- **Repeats:** 10 papers drawn with `exclude` from the previous 6 share no key. With `prefer`, a paper uses unseen keys first.
- **Generated MC:** every generator rendered as MC has 4 distinct options, exactly one matching the answer, and the answer is gradable.

**Scoring:**
- `gradeSet(..., { allOrNothing: true })`: a half-right multi-select scores 0; `percent === correct/total`; `byArea` totals 110.

**State (`study.js`):**
- A mock that runs out in s1 records `timedOut` with section 2 blank.
- After s1 is submitted, s1 answers are frozen.
- Break: the clock is stopped during the break, restarts at expiry, and unused break time isn't added.
- Wall clock: `currentMock()` with `runningSince` 400 min ago gives `expired`.
- The old-format mock migrates.

**Data rules (§5.6):**
- Area 4 has no `ncees-sub:4E`.
- Every `examRefs` id exists in library.json with `exam: true`.

### 6.2 `scripts/qa-exam.mjs` (rewrite; desktop 1440×900 and 1280×800, plus phone)

**Before the exam:**
- Intro → Agree → Tutorial counts down → Start. The agreement's "I do not agree" returns to the intro with no paper saved.

**The exam screen:**
- No rail, no Notes, Reference or Glossary buttons. N, R and G do nothing.
- Only the seven nav controls exist, and every one works (click each, assert its effect).

**Scroll and focus (§3.4), asserted for every action:**
- After Next, Previous, ←/→, a review jump, and handbook open/close: `document.activeElement` is the expected element.
- The page `scrollY === 0`; the pane `scrollTop === 0` on a new question.
- **The last answer choice's bottom is ≤ the pane's bottom** (the "never scroll" check). Run it over 40 consecutive questions, all formats.
- A separate sweep (`--sweep`) renders 300 exam-ready items of every format at 1440×900 and 1280×800 and reports any that overflow.

**Review and sections:**
- Flag → the review shows it as flagged.
- "Review flagged" steps only through flagged items.
- Unanswered counts are right.
- End review → confirm → section 2. Previous is disabled at Q56. Section-1 items are unreachable.
- Break offer → take break → the countdown runs → Return → the clock is running.
- Second run: let the break expire by moving the clock (`Date.now` override). Section 2 starts by itself.

**Reference pane:**
- Handbook docked to the right at ≥ 1200 px and does not cover the question (bounding boxes don't overlap).
- The doc menu lists exactly the supplied set.
- Esc closes it and focus returns to the Handbook button.

**Calculator:**
- It never overlaps the question pane at ≥ 1200 px.

**Time and resuming:**
- Reload mid-exam → back at the same question with the clock having **kept running** across the reload (wall clock).
- Time up (override the clock) → the modal → See result.

**Result:**
- Pass/fail, the diagnostic table with 7 rows, the solid and dashed markers, "By knowledge area".
- No "Didn't know" UI for a new paper.
- An old saved paper with `idk` still shows its gaps.
- No horizontal scroll; no page errors.

### 6.3 Also re-run

`qa-weakspots` (weak papers on the CBT screen), `qa-library` (dock vs panel), `qa-phone-course`, `test-insights`, `test-weakspots`.

---

## 7. Open questions for the owner (he sat it on 21 Oct)

NCEES does not document these. Answers change details only, not the structure:
1. **Review screen.** Was it a list or a grid? Did it have Review all / incomplete / flagged buttons?
2. **Tools.** Was there a highlighter or strikethrough on choices? (If yes, we add exactly that.)
3. **Section split.** Was it really about 55/55? Did the review screen appear only at the end of each section?
4. **Format mix.** Roughly how many AITs and fill-ins did you see? (This sets `examMix`.)
5. **Calculator.** Was the on-screen TI-30XS useful? If so, a TI-30XS MultiView emulator (the keystroke data already exists in `keystrokes.js`) becomes worth building as the exam's calculator. If not, the TI-30Xa keypad stays.
6. **Timer.** Was it always visible, or could it be hidden?

## 7a. Owner's answers (from the 21 Oct 2026 sitting)

1. **Review screen:** a list of questions with Review all / Review incomplete / Review flagged filters. No highlighter and no strikethrough, so we add none.
2. **Sections:** two sections, **56 questions then 54**. Each ends with its own review screen, and the first section can't be reopened once it is submitted.
3. **Format mix:** mostly single-answer four-choice questions, with a handful each of the alternative item types and typed numbers. Set `examMix` heavily toward four-choice.
4. **Calculator:** the owner used their own approved calculator; the on-screen one wasn't useful. Keep the course's existing keypad as a convenience; no TI-30XS emulator is needed.
5. **Timer:** always visible, so no hide option.
