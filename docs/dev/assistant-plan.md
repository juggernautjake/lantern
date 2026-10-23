# Lantern as a course-aware FS tutor: the plan

Written 22 Oct 2026 for the owner's request:

> "We need the AI lantern assistant to be able to be fully familiar with the handbook, all material, what the student is currently working on in the course and even immediately looking at on their page, what is in the glossary and videos and flashcards and all of that. It needs to be able to know what the student needs to work on and what they are doing well. It needs to be able to offer both online videos from youtube and khanacademy, as well as any videos within the course itself. […] if it is a video that is from the modules, then the user needs to be able to play the video from the chat history panel, with all of the controls […] and a button to open up the lesson where that video is found […] auto scrolled to the video."

And the addition: *"Make sure we can talk to the AI assistant to better help us understand everything in the codes and standards and handbook."*

**The constraint:** no added clutter. The panel keeps its two tabs (Talk, Resources), its one message box and its buttons. Everything new appears **inside a reply**, only when the reply needs it: a video card, a short list of outside links, an *Open in the handbook* button.

How it is built is in [assistant.md](assistant.md). This file is the why and the what.

---

## 1. What the assistant knows and can do today

**Where it lives:**
- the server: `server/src/assistant/` (`context.js`, `tools.js`, `prompts.js`, `chat.js`, `study.js`, `review.js`, `resources.js`);
- the panel: `server/public/shell/assistant.js`.

**Context it is given on every turn** (`context.describe` → `prompts.system`):

| What | Where from | Notes |
|---|---|---|
| Course, unit and lesson open, kind of page | the course's `nav` message → shell → `POST /api/assistant/here` | page id only: no video, no position on the page |
| The reading on screen | the same `nav` message carries the section's markdown (up to 24,000 chars) and, once its video loads, its transcript | readings only. Checks and exams carry no text. |
| Progress | `progress.overview` from the saved state | percent, current, next, minutes left |
| Quiz record | `review.summary`: strongest and weakest topics from the reviews of finished checks, practice sets and exams | built from **reviews**, not from the course's own topic ranking |
| Notes | the learner's notes (names, starts; `read_notes` gives the whole) | |
| Notation | `assets/notation.json`, up to 200 lines, current module first | |
| The lesson's video | its title and chapters | `lesson_video` gives the script |

**Tools:**
- `lesson_context`, `next_hint`, `course_progress`, `open_course`, `review_code` (CFML);
- `find_resources`: live web and YouTube searches, filtered to an allow-list and cached for a week;
- `play_video`: a YouTube search, played in the mini player;
- `lesson_video`: a course video's script and its questions *with answers*. These are ungraded teaching questions, so this is allowed; see §7.
- `read_notes`, `save_note`, `look_up`, `media_control`;
- Claude's own `web_search`, at most 3 uses per turn.

**The guardrail.** On a graded item the answer key is absent: it is not merely forbidden.
- `context/exercises.json` holds prompts and hints only.
- `build-pack` refuses a context that leaks an answer (`contextLeak`).
- Hints come one rung at a time, and never on a check.

**Built-in commands without an AI:** hints, progress, navigation, the player and resources (`skills.js`).

## 2. The gaps against the owner's list

| The owner asked for | Today | Gap |
|---|---|---|
| Fully familiar with the handbook | the notation list only; no page map; it cannot cite a page reliably | the handbook inventory (464 items, pages) and map are not in the pack |
| Codes and standards | nothing beyond what a reading says | the inventory's 31 standards entries and the library's 38 documents, with the public-domain ones' page text, are not used |
| All material: glossary, flashcards, videos | the page on screen only, plus video scripts by id | no search over readings, glossary, flashcards, formulas or video chapters |
| What the student is working on now | page id | — |
| …and *immediately looking at* | nothing below page level | which video, its time and chapter; the question in front of them; the open panel; the part of the reading in view |
| What to work on and what is going well | review summaries | not the course's own ranking (`sessions.weakness`, becoming `insights.rank` in study-flow-plan §2.6) |
| YouTube and Khan Academy videos | live searches; the model can also write any URL it likes | no checked list; nothing stops an invented link |
| Course videos in the chat, playable with all controls | none; lessons open in the course frame only | a playable card, using the course's own player |
| An *Open lesson* button that scrolls to the video | `open_course` opens the page at its top | no scroll to a video; formula and example videos sit far down a page or inside a folded card |
| Click an outside link and it opens in the browser | `target="_blank"` links in replies | kept as it is: the app runs in the system browser, so `_blank` *is* the system browser. Nothing new is needed. |

## 3. The design: what the assistant sees, and how

### 3.1 Exactly what the learner is looking at: the *look*

When the learner sends a message, the panel first asks the open course page:

> what is in front of them?

- The ask is `postMessage {lantern:'look-request'}`, answered by `{lantern:'look'}` within 400 ms.
- If the course does not answer, the message goes without it.
- The answer goes to the server in the chat request (`POST /api/assistant/chat {text, look}`).
- It is taken **at the moment of asking**, so it is never stale and costs nothing between messages.

The course side is one new kit file, `app/course/host.js`. It is the only course-kit change. It reads the page; it does not change how the page works.

| Part of the look | What it holds | What it never holds |
|---|---|---|
| `page` | id, kind (lesson, check, exam, practice, study, weak, cards, videos, formulas, glossary…), title, module | |
| `inView` | the heading of the reading card at the top of the screen | |
| `video` | the video playing, or the one most in view: id, title, time, length, chapter, playing or not | |
| `question` | the question card in view: its stem and choices as shown, its type, *n of N*, answered or not | the answer, the working, the explanation. It is read from the question's own text, never from the result box. **On a check or an exam the question is not sent at all**, only "a check question is open (3 of 20)". |
| `panels` | open panels by name: Calculator, Reference sheet, the Handbook at page *N*, a library document, Notes, a glossary pop-up (its term) | panel contents |
| `card` | on Flashcards: the front of the card shown | the back, unless the learner has turned it over |
| `standing` | the course's own weakness ranking: the weakest 8 topics (title, module, % right, answers, last answers, lesson) and the strongest 6 | |

The server cleans the look in `context.setLook`:
- It is cut to size, and every string is capped.
- **Question text is dropped again on any check or exam kind**, whatever the page sent: a second guard behind the first.
- The look is fenced as data in the prompt.
- `standing` is also kept, per course, as the last known standing, so a learner who asks "what should I work on?" from the home page is answered from the course's own numbers.

### 3.2 Retrieval over all course material

`structure.mjs` gains a `knowledge()` export. `build-pack` writes it to the pack as `context/knowledge.json`. It goes through the same `contextLeak` check as the exercises, and it never holds a question.

| Source | What goes in |
|---|---|
| Readings | every section of every module, split at its idea cards (heading and plain text): about 190 lessons |
| Glossary | every term and its definition, plus aliases |
| Flashcards | term, definition, module (1,338) |
| Formulas | each key formula: id, name, form, video, and from `equations.json` its *means*, *use*, *derive*, *when*, *how*, symbols and memory hook. **Not** its drill decoys. |
| Video chapters | every video's title, kind, module, chapters (title, start time, what each teaches), topics and **home** (the lesson where it is shown: lesson top, in the reading, or in the module's formula cards) |
| Handbook inventory | all 464 items (equations, symbols, constants, tables, figures, standards) with printed page, section, form, symbols and meanings, how it is said, what the exam asks, and the lessons that teach it. These are our own words and notation; the inventory says so itself. |
| Handbook page map | page → chapter and section, from `fs-handbook.md` §1 |
| Library | the 38 documents: title, publisher, year, what each is for, whether it is supplied on exam day, the modules it serves, and whose copy it is (public domain or the learner's own) |

A transcript search is also used at run time when the pack has it: `assets/videos/search.json`, the deep index the Videos page already uses.

**Public-domain standards:** `assets/library/index.json` holds the page text of the 32 public-domain documents (BLM Manual, FGDC, NGS, OSHA 2226, tidal datums…). It is searched for exact quotes and page numbers.

**The search** is `server/src/assistant/knowledge.js`:
- a small BM25 index built once per pack version;
- it runs in a few milliseconds, with no embeddings and no network.

**The tools:**
- **`search_course {query, kinds?}`**: the best 8 passages, each with where it is, and a page cite for handbook items.
- **`handbook {query | id | page}`**: an inventory item (equation, symbol, constant, table, figure or standard) with its page, its symbols, the formula's *derive / when / how* when the course has one, and the lessons and videos that teach it.
- **`standard {query | id}`**: a code or standard: who publishes it, what it requires (our words), whether it is supplied on exam day, the lessons, and, for a public-domain document, the matching pages of its text.
- **`find_videos {topic}`** returns course videos and checked outside videos that fit. **`show_videos {ids}`** puts the chosen ones in the chat as cards. Both are covered in §4.
- **`my_standing`**: §3.4.

The page reading stays in the prompt as it is now; retrieval adds the rest of the course *on demand*. With retrieval in place, the per-turn prompt shrinks:
- notation: only the module in view and the symbols named in the question, not 200 lines every turn;
- the reading: 12,000 characters instead of 24,000;
- `search_course` finds anything further.

### 3.3 The handbook: what the assistant may use

| Source | Used? | Why |
|---|---|---|
| `docs/dev/fs-handbook-inventory.json` and the `fs-handbook.md` map | **Always.** They ship in the pack as part of `context/knowledge.json`. | Notation, page numbers and our own descriptions. No handbook prose. The inventory's own header says so. |
| The course's readings, formulas and *derive / when / how* | Always | The course's own material |
| **The learner's own copy of the handbook PDF** | **Never read, never sent.** The assistant points to the page and offers *Open in the handbook*, which opens the learner's own copy at that page in the course's library panel, on their device. | `fs-handbook.md` (Copyright): NCEES allows printing for personal use only, *no electronic distribution, not to be stored in a retrieval system*. The library entry says *"NCEES does not allow it to be shared or stored anywhere else, so it stays on this device."* Extracting its text into a model prompt means sending the handbook's text to a third-party AI service: that is electronic distribution, and building a search over it is a retrieval system. The research note says *link to MyNCEES, don't host*. Exact lookups are served instead by the inventory's notation, which records each equation in the handbook's own form, every symbol and its printed page. |
| The other "your own copy" documents (ALTA/NSPS 2021 and 2026, the FEMA Elevation Certificate, ASPRS, NSPS model standards) | Not read. The inventory's `about` and `examAsks` (our words), the course's lessons, and *Open your copy*. | They are copyrighted, and the course already asks the learner to add their own copy |
| The public-domain documents (BLM Manual, FGDC, NGS, OSHA, NOAA…) | Yes: their shipped page text is searched and quoted, with pages | Public domain, and already shipped in the pack |

**Opening the right detail view.** A handbook item in a reply carries an **Open** button. It is the only new control, and it appears only in a reply that cites an item. It asks the course, in this order:

1. `Course.reference.open(id, part)`. Another agent is making every reference equation and diagram clickable, with parts that can be inspected. This is the **hook**. `host.js` calls it when it exists, with the inventory id (`eq.6.line-general`) and, when known, the course equation id (`m1-f26`) and part.
2. Otherwise, the learner's own handbook at the printed page (`Course.library.openHandbook(page)`). If they have not added their copy, the panel shows how to get it from MyNCEES.

**Status:** `Course.reference.open(id, part)` landed in `app/fs/refsheet.js` while this was built (22 Oct 2026), with the same contract: an inventory id (`eq.10.tangent`, `fig.10.horizontal-curve`) or a key-formula id (`m5-f19`), a symbol or figure part, and `false` for an unknown id. `host.js` calls it first; the handbook tool passes the part the assistant names.

A plain "Handbook p. 10" in any reply becomes the same button.

### 3.4 The learner's strengths and weaknesses

- **One ranking.** The look's `standing` is computed **in the course page by the course's own code**:
  - `Course.insights.rank()` once study-flow-plan §2.6 lands;
  - `Course.sessions.ranked()` until then.

  So *"what should I work on?"* in the chat names the same topics, in the same order, as Study, Weak spots and Progress. The server never computes a second ranking.
- **`my_standing`** returns that standing (live, or the last known one with its date) together with:
  - the review record (`review.summary`): runs, latest scores and the topics weak this time;
  - progress: lessons read, videos watched, checks passed, the best mock.

  For each weak topic it names the lesson that teaches it and the course video and chapter for it, ready for `show_videos`.
- The prompt asks the assistant to:
  - say what is going well first, in a sentence;
  - name the two or three weakest topics with their numbers;
  - offer one concrete next step: a video card, the lesson, or a *Strengthen my weak spots* session.

### 3.5 Videos in the chat

**Course videos.**
- `find_videos` searches the pack's video index (titles, chapters, topics, home lesson) and the transcript index.
- `show_videos` sends an action `{type:'course-video', id, title, minutes, chapter, t, home:{ref,title}}`.

**The card:**
- It shows the title, its length, *Module N · lesson title*, **▶ Play** and **Open lesson**.
- **▶ Play** puts the course's own player into the card. It is the same pack page in a frame, at `index.html?host=lantern&lantern-video=<id>&t=<s>`. In that mode `host.js` boots only the player (`Course.video.embed`): stage, captions, chapters, speed, step-by-step, transcript, full screen and its questions. There is no second player.
- Only one card plays at a time. Pressing ▶ on another card moves the one frame there.
- The frame is sized to its content (the page posts its height).
- **Watching counts.** The embedded page never saves the state. Each watch record it makes is sent to the shell, which hands it to the open course page (`{lantern:'absorb', state:{videos}}`). That page merges it with `Course.study.absorb` (watched seconds OR-ed, *done* kept) and saves as usual. One writer, no lost progress. When the course is not open, the card still plays but the watching is not counted. The card says so in its small print.

**Open lesson** calls `LanternShell.openVideo(course, home, id, t)`:
- if the course is open: `{lantern:'go-video', id: home, video, t}`;
- otherwise: the course is opened at that lesson and the same message is sent once it says where it is.

`host.js` then:
- goes to the page;
- finds the player (`[data-video=id]`), opening the folded formula card around it when needed;
- builds it if it is still a poster;
- scrolls it to the top under the sticky header, cues it at *t*, and focuses it.

It is ready to play: Space or ▶ starts it.

### 3.6 Outside videos: a checked catalogue

**The file** is `courses/fs/outside-videos.json`. It ships as `context/outside-videos.json`.
- **Topics** are keyed to lesson ids, which survive the module reorder.
- Each **video** records: provider (YouTube or Khan Academy), canonical URL, exact title, channel, length in seconds, topics, level, why, and the date checked.

**The check** is `scripts/check-outside-videos.mjs`:
- **YouTube:** oEmbed must answer, and the title and channel must be identical; the watch page must say *playable* and give the length.
- **Khan Academy:** the page must open in headless Chrome, must not be "Page not found", and its title must match. Its length comes from the page or from the YouTube video it plays.
- A candidate is accepted only when the live title matches the title it was found under.

**The rule: only links from the catalogue.**
- `find_videos` returns only catalogue entries for outside videos.
- `show_videos` accepts only their ids.
- `chat.js` checks every reply. Any `youtube.com`, `youtu.be` or `khanacademy.org` link that is not in the catalogue loses its link and keeps its words. Any other link that did not come from a tool result or a web-search citation this turn is unlinked too.
- `find_resources` for a course with a catalogue shows catalogue videos instead of live YouTube results.
- `play_video` stays for music and for a video the learner names.

**Outside cards** are one compact row each: ▶ title — channel · 9 min ↗. They are links with `target="_blank"`, which opens the system browser. There is no embed, thumbnail or rehosting. YouTube and Khan Academy allow linking.

## 4. What the prompt adds (in short)

- **Use the look.** "This question", "this video", "this part" mean what is in the look. On a check or an exam, the guardrail applies unchanged.
- **Ground answers in the course.** Use `search_course` or `handbook` before explaining a formula, symbol or standard. Write symbols as the course does, and cite **Handbook p. N — Section** whenever the handbook gives it.
- **Videos.** When a video would help, use `find_videos` and then `show_videos`, rather than writing links. Never write a YouTube or Khan Academy URL.
- **Practice questions.** On a practice question the learner has not answered yet, coach the method (which formula, which handbook page, what to watch for) before giving a final number.

## 5. Cost and context limits

**Today's turn.** The persona is about 1.2k tokens. The reading can add up to about 6k tokens (24,000 chars), notation about 3k, notes and quizzes about 1k, and the tool list about 1.5k. Over up to 6 rounds that is roughly **10–14k input tokens per round** on a reading page.

**After the change:**
- The stable part is sent as the first system block with `cache_control`: the persona, the rules, and the course notation for the module in view. The tool list is cached too. The look, the reading and the record come after the breakpoint.
- The reading drops to 12,000 chars, and notation to the module in view.
- Tool results are capped: 8 passages of about 600 chars each.
- The result is about **6–9k input tokens on the first round, mostly cache reads on rounds 2–6**, and 1,200 output tokens at most.

**Prices** (Anthropic list, Oct 2026). Cache writes cost about 1.25× input and reads about 0.1×.

| Model | Input $/1M | Output $/1M |
|---|---|---|
| Claude Sonnet 5 (Lantern's default) | 2 | 10 |
| Claude Opus 5.5 | 4 | 20 |
| Claude Haiku 4.5 | 1 | 5 |
| Claude Haiku 5.5 | 0.10 | 0.50 |

**A typical tutoring turn** is 2 rounds, about 12k input (half cached) and 400 output. That costs about **$0.02 on Sonnet 5**, or about $0.04 on Opus 5.5. A heavy study evening of 60 questions is about $1–2.

**Limits:**
- Per turn: 6 rounds, 60 s and 1,200 output tokens, as today. The look is at most about 3 KB.
- There is no monthly budget in app mode (platform-inventory §1). Deciding one is the owner's call (§7).

## 6. Tests

**Unit (`server/test/test-assistant-fs.mjs`, the FS pack):**
- the look is cleaned, and has no question on a check or an exam;
- `knowledge.json` passes `contextLeak` and contains no question stem and no stored worked answer;
- `search_course` finds a glossary term, a flashcard, a video chapter and a reading;
- `handbook` answers with the right page, and a standards question names the publisher and the requirement;
- `my_standing` reproduces the course's ranking it was given;
- the catalogue's shape and topics are valid and every lesson id exists;
- invented YouTube and Khan links are stripped, and catalogue links are kept;
- `show_videos` refuses an id that is not in the index or the catalogue.

**End to end (`server/test/e2e-assistant-fs.mjs`, headless Chrome, a fake Claude, no network):**
- "find me a video on the two-peg test" puts a course video card in the chat, and ▶ plays the course's own player inside the panel;
- **Open lesson** lands on the lesson, scrolled to that video, cued;
- an outside link opens a new browser tab, outside the app;
- the look is sent with the message, and the AI never receives a question on a check page;
- a handbook question shows the page cite and the **Open** button.

## 7. For the owner to decide

1. **Model.** Sonnet 5 stays the default. Opus 5.5 costs about twice as much and is a better tutor on hard derivations. Haiku 5.5 is very cheap, but weaker at multi-step reasoning. Lantern already lets the learner choose (Settings, Assistant).
2. **A monthly cap** in app mode, as demo mode has, if packs go to paying learners on a shared key.
3. **`lesson_video`** returns the video's end-questions with their answers. They are ungraded, so this is allowed and kept. Say if you want them withheld until answered.
4. **Video thumbnails.** The outside cards show none, to keep the panel quiet and to avoid any question of displaying YouTube artwork. Say if you want them.
5. **Watching in the chat while the course is closed** is not counted (§3.5). Counting it would need the server to merge course state, which belongs to the progress-tracking work.

---

## 8. Teaching with the course's own visuals (FS course)

Added 22 Oct 2026 for the owner's request: the tutor should *teach with* the course's figures, equations, demonstrations and videos inside the chat, paced with its words; draw a simple new illustration only when nothing built fits; take every shown number from the course's own engine; and stay strictly on the course.

**The constraint is unchanged:** one simple chat. Visuals appear inline in the reply; the only new controls are *Open in the lesson* on a card and, under a reply that has cues, a quiet ◀ step ▶ and ↻ Replay.

### 8.1 How it fits together

```
 learner ─▶ POST /api/assistant/chat-stream ─▶ chat.js
                                                 1 skills (instant, as before)
                                                 2 scope gate  (teach/scope.js)       off / injection → redirect, no model
                                                 3 Claude, streamed (teach/stream.js) ◀── tools (tools.js → teach/*)
 ◀─ {t:'action'} a visual, the moment its tool returns
 ◀─ {t:'text'}   the words, as written (cue markers inside)
 ◀─ {t:'done'}   the whole turn: reply with only the cues that work, actions, timing
```

- **The course's own code does the drawing.** A card is the pack's page in a small frame (`?host=lantern&lantern-teach=1`, the same trick as the video card). `app/course/teach.js` boots only that card and draws it with `Course.video.renderFigure`, the figure's own `opts.demo`, and the course's markdown and equation data. Nothing is re-drawn by the shell. The frame follows the app's light or dark theme (palettes `parchment` and `lamplight`) and reports its height.
- **Server side, the same kit runs in Node** (`teach/course.js`): the figure registry (738 figures; parts and steps are read by rendering), `equations.json`, `modules.json` and the 1,087 generators (`Course.engine`). It is loaded from `app/` (shipped with Lantern), never from a pack: a friend's pack cannot run code in the server. Only the FS course has it.
- **Graded pages:** `worked_example` refuses on a check or an exam (the page's kind, or the look's `question.graded`), so the guardrail of §1 is unchanged.

### 8.2 Tools (offered only on the FS course)

| Tool | Does | Card id and cues it returns |
|---|---|---|
| `find_visuals {query}` | what is built for a topic: figures (with `demo`, step count and the lesson that shows each), equations, lesson passages; local | ids for the tools below |
| `show_figure {id, params?}` | a course figure, every part shown | `cN`, its **parts** (with the words drawn in each) and **steps** (with the lesson's own words for each) |
| `show_demo {id, params?}` | the figure's interactive version (its own buttons, sliders, modes); refused for a figure with no demo | same |
| `show_equation {id or words}` | equation card from `equations.json`: form, symbols and meanings, why, when, how | `cN`, the symbols |
| `show_passage {ref, heading?}` | the part of a lesson reading as the lesson prints it | `cN` |
| `show_videos {ids, t?, end?}` (extended) | a course video; `t` starts it at a chapter or second, `end` plays only that **recorded segment with its recorded voice** | `cN` |
| `worked_example {topic or key}` | runs a course generator (`Course.engine.generateValid`): question, every step's computed result, the answer, the generator's own diagram; also lists figures that fit | `cN` (steps) |
| `law_basis {topic}` | the lessons to rest a land-law or boundary scenario on, `texasSpecific` marked, `jurisdiction:TX` practice items, and how to write the scenario | none |
| `draw_figure {title, spec}` | §8.4; only when nothing built fits | `cN`, parts, steps |
| `draw_derivation {title, steps}` | an equation derivation as ordered steps | `cN` |

Every visual card carries an **Open in the lesson** link, using the existing navigation: `LanternShell.deliver(course, ref, {lantern:'go-part', figure | heading})` for figures and passages (`host.js` scrolls to the figure and flashes it), and `open-reference` for equations. Videos keep **Open lesson** (`go-video`).

**Numbers.** The model is told, in the prompt and in each result, never to do the arithmetic of a shown answer. `worked_example` returns the engine's `answer` and each step's `result`; the test recomputes the answer from the template's `answer_formula` and the drawn numbers and compares. For land law and boundaries the model writes a short scenario from `law_basis`, cites the lesson, and says what is US-general and what is Texas-specific.

### 8.3 Cue format

Same style as the lesson videos' cues (`fs-videos.md`): `[[<card>:<action> <args>]]`, written in the reply right after the words it goes with. Not spoken, not shown.

| Card kind | Cues |
|---|---|
| figure, demo | `show P` · `hide P` · `hl P` · `unhl [P]` · `draw P` · `step N` · `reset` |
| draw | `show P` · `hide P` · `hl P` · `unhl [P]` · `step N` · `reset` |
| equation | `sym S` (emphasise a symbol in the equation and its row) · `unsym` · `open derive`, `open when` or `open how` |
| derivation, example | `step N` (the first N lines) · `hl N` (derivation) · `reset` |
| video | `play T [END]` · `seek T` · `pause` (seconds) |

- **The reader** (`shell/teach.js` `CueReader`) is incremental: a marker split across stream chunks is held back, never shown, and fires once, whole, when the text reaches it. So a cue fires as the words appear.
- **Checked twice.** The server (`teach/cues.js`) keeps only cues that name a card on screen and a part, step, symbol or second it really has; the reply that comes back in `done` has only those. The frame ignores a cue that does not apply.
- **State.** A card starts whole (every part of a figure, the whole equation, the whole sketch). The first `step` cue turns a figure, sketch or derivation into a walkthrough (a figure as authored with its hidden parts hidden, steps 1..N applied, with the lesson's own words for the step). A card nobody cued is left whole.
- **Replay.** Under a reply with cues: ◀ and ▶ step cue by cue (reset, then re-fire cues 1..i, marking the words that led to cue i with the CSS Custom Highlight and a dot), and ↻ Replay runs them paced (1.6 s apiece). The buttons stay focusable at the ends (`aria-disabled`), so keyboard focus is never dropped.
- **Prefer the recorded video.** The prompt tells the model to use `find_videos` and `show_videos` with `t` and `end` when a recorded segment explains the point, rather than repeat it; `[[cN:play 95 140]]` starts the card's player there and it stops at the end second (`host.js` `stopAt`).
- **Speech** and the reply's replay button read the words with cues stripped.

### 8.4 Drawing spec (data, never code)

Validated in `teach/draw.js`, re-checked in the page by `app/course/drawing.js`, which draws with `Course.video.F` (the same strokes, halos, tags and palette tokens as the course figures, so light and dark both read; the viewBox is 480 wide so labels stay readable at phone width).

```
{ view?: {x,y,w,h},                       default 0 0 400 300; y points up; angles in degrees CCW from +x
  items: [ { t, part?, … } ],             at most 80
  steps?: [ { show?:[part], hl?:[part], say? } ] }   at most 16
t = point{x,y,label} | line{x1,y1,x2,y2,dash} | arc{cx,cy,r,from,to} | polygon{pts:[[x,y]],fill}
  | dim{x1,y1,x2,y2,text,off} | angle{x,y,r,from,to,text} | label{x,y,text,anchor}
  | symbol{kind: instrument|rod|north|monument|benchmark|tripod|target|pin, x,y,size}
  | grid{x,y,w,h,step} | axes{x,y,w,h,xlabel,ylabel}
```

- **Limits:** 9 KB serialised, 80 items, 16 steps, 40 parts, 40 polygon points, coordinates within ±5,000, text 60 chars (step words 200), at most 60 grid lines per direction.
- **Refused with a reason the model can fix:** an unknown `t`, a non-number, NaN, out of range, a part name with odd characters, a step naming a part no item has, too big. Text is stripped of control characters and `<>`; the renderer builds SVG only from numbers and its own text through `F.text` (escaped).
- **Parts and steps:** parts named in some step's `show` start hidden; `step N` shows the parts of steps 1..N and highlights step N's `hl`, with `say` as the caption. `show P`, `hide P`, `hl P` work directly.
- **Derivation:** `{steps:[{math, say?}]}`, at most 12 steps, `math` at most 140 chars, set with the course's own `Course.md.inline` (subscripts, powers, symbols).

### 8.5 Scope gate (on-topic only)

`teach/scope.js`, run in `chat.js` before the model, tools or any visual, on the FS course:

1. **Injection** patterns (ignore previous instructions, reveal the system prompt, you are now…, fake system tags) get a one-sentence refusal. No model call.
2. **Local, instant heuristic:** the course's own vocabulary (about 300 surveying and exam words plus every glossary term) means *on*; a clearly unrelated pattern (recipes, sports, poems, other programming, medical or investing advice, translation…) with no course words means *off*, with a short polite redirect to what the tutor can do. No model call.
3. A short follow-up ("why?", "show me") in a conversation already on the course is *on*.
4. **Only when still unclear:** one Claude Haiku 5.5 call (`claude-haiku-5-5`, one word back, `max_tokens` 200 with `effort: low`, 3.5 s timeout). *OFF* and *INJECTION* are turned away. If the call fails or times out the question goes through: the system prompt repeats the scope (its SCOPE paragraph), and a missing classifier must not lock the learner out.
5. Off-topic turns use **no tools**: they never reach the model, so no video, figure or search can be offered for an unrelated topic. Text inside tool results, notes and pages is data, as in §1.

### 8.6 Latency budget and measurements

| Step | Budget | Notes |
|---|---|---|
| Scope gate, local | under 5 ms | measured about 0 to 1 ms; a Haiku call (rare) adds a few hundred ms and is bounded at 3.5 s |
| Tool (find, show_*) | under 50 ms warm; the first call in a session 150 to 400 ms | the figure registry loads once (738 figures); `worked_example` loads the 3 MB generator file once |
| Visual to the page | the moment the tool returns | streamed as an `action` line, before the model writes a word of the reply |
| Card paint | page load of the pack in a frame (cached after the first) | the video card's cost today |
| First token | the model's first output plus one round trip for tools | streamed, not buffered |
| Context | retrieve, don't stuff | tools return ids and part lists (a figure's parts and steps are 0.5 to 1 KB); the whole teaching rule is about 3.3 KB, in the cached system block with the tools |

Measured with the scripted streaming model (120 ms to its first output): see the QA script's *Speed* table and the unit test's one-line summary (first visual, first token, whole turn).

### 8.7 Files

| | |
|---|---|
| server | `server/src/assistant/teach/{course,visuals,examples,draw,cues,scope,stream}.js`; `tools.js` (9 tools, `show_videos` end); `chat.js` (gate, streaming, hooks); `prompts.js` (VISUALS); `routes.js` (`/api/assistant/chat-stream`, newline-delimited JSON) |
| shell | `server/public/shell/teach.js` (cue reader, stream client, cards, replay); `assistant.js` (the streamed turn); `assistant.css` |
| course kit | `app/course/teach.js` (the card page), `app/course/drawing.js` (the sketch renderer), `app/course/host.js` (`go-part`, the video segment cue and `end`); both new files are in the build list of `scripts/build-fs-studio.mjs` |
| tests | `server/test/test-assistant-teach.mjs`, `server/test/fake-claude.mjs` (scripted streaming Claude), `scripts/qa-assistant-teach.mjs` (browser: desktop and phone, light and dark, port 4781) |

### 8.8 Left for the owner

1. **Voice and cues.** The reply is spoken whole while cues fire as the text is read; they are not synchronised to the voice's position. That needs per-sentence speech timing.
2. **Demos and steps.** A demonstration's own sliders redraw its figure, which clears a highlight; `step N` on a demo only shows and highlights the step's parts.
3. **Haiku cost and latency** is paid only on unclear questions; if you would rather never call it, the gate falls back to the local verdict.
4. **Other courses.** Only FS has the kit; CFML keeps its tutor as it was.

### 8.9 Explaining every term, figure and equation (added 23 Oct 2026)

- **`glossary {term}`** (`teach/glossary.js`, data read once from `app/fs/data/glossary.json`, `acronyms.json`, `refsheet.json`): term, alias, acronym or rough spelling → definition, every other field the entry carries (example, usage, confused-with, related), the acronym entry, `taught_in` (lessons with their own sentence and how to open them) and the `show_figure` (with `cue_part`) / `show_equation` handles from the reference sheet. About 5 ms a lookup.
- **Teaching rule** (`prompts.js`, EXPLAIN A TERM…): plain definition, one concrete example (deed or report sentence; `worked_example` numbers), the card with cues, when used and confused with, the lesson, then "want another example?".
- **`handbook`** now also returns `show` (equation card, figure, labelled parts, when/how) and `worked_example` keys, and falls back to the reference sheet's lesson.
- **Drawing spec** gained `arrow`, `circle`, `curve`, `table`, `timeline`, hatched polygons, text along a line and the `satellite`, `prism`, `antenna` symbols (`teach/draw.js` + `app/course/drawing.js`). `server/test/draw-specs.mjs` has one of each need.
- **Speech and text of math**: replies are said through `tutorSpeech` (assistant-only, `shell/tutor-speech.js`) then `courseSpeech` then `spoken`, the videos' own path; `spoken.js` is untouched. Replies are shown with `shell/math-text.js` (the readings' subscript and superscript rules). Tests: `test-assistant-speech.mjs`, the coverage section of `test-assistant-teach.mjs`, and `scripts/qa-assistant-teach.mjs` (port 4783).

### 8.10 Answer first, reference, and few visuals (owner's correction, 23 Oct 2026)

The owner: the tutor "shouldn't jump into all of that on a whim. It should respond to the user's question, referencing a video or lesson if possible. If it thinks a demonstration or illustration would be helpful in explaining what is going on, then it will create it and render it for the user." This **overrides** the earlier "show what is built first / pair the video with a figure, demo and equation card" habit of 8.1 to 8.9.

- **Answer the question first**, directly and concisely, in words.
- **Reference, don't dump.** Usually one compact course video card (two at most) that starts at the chapter that answers it (`show_videos` with `t` and `end`) and waits for Play, or a lesson link. The learner chooses to play or open it.
- **Visuals only when they help**: a figure, demo, equation card or drawing only for geometry, a mechanism, a derivation or the setup of a worked number. The default is **0 or 1 visual cards per reply**. A definition ("what does NGS stand for?") gets words and a reference, no visual, unless the term is inherently a picture.
- **Ask instead of piling on**: end with a short offer ("Want me to show it on the figure?", "Shall I work an example?").
- **Enforced softly in code**: `tools.dispatch` counts visual cards per reply (`S.visuals`; videos do not count); a second visual card returns a note telling the model to hold back and offer it. The prompt carries the rule (`prompts.js` VISUALS: ANSWER FIRST, VIDEO CHOICE, VISUALS ONLY WHEN THEY HELP).
- **Video choice**: worked-example video for "how do I solve / compute", formula video for "what does this equation mean / why", lesson video for a concept; the chapter, not the whole video; if nothing fits, explain in words (a figure or drawing only if the idea needs it) rather than force a video.

**Retrieval (`teach/videoindex.js`, replaces the old keyword match in `knowledge.findVideos`).** An in-memory index built once per pack version, lazily (warmed after the first chat message; about 1.8 s once, then about 7 ms a question), from the pack's own `assets/videos/<id>.json` timelines (so it follows the recording runs; nothing is stored or edited) and `context/knowledge.json`. Each of the 900 videos and each of its chapters is indexed by: title, formula name and form, chapter titles, `teaches` headings, module and kind, the handbook items and equations it covers, glossary and acronym terms found in its captions, the board text shown (scenario words and numbers), and the captions. Scoring is BM25 over a video document and over its chapters (sublinear term frequency, word pairs for phrases), a title/chapter coverage bonus, an exact title or formula-name bonus, query widening by the glossary's aliases and a few everyday synonyms, and a small nudge by question kind. `find_videos` returns each hit with `chapter {title, t, end}`. Tests: `server/test/test-assistant-teach.mjs` ("Finding the most helpful video"), questions in `server/test/video-queries.mjs`.
