# Lantern, your study companion

Beside every course sits **Lantern**: a warm, glowing lantern you can talk to or type to. It knows which lesson you have open, gives you the course's own hints one at a time, finds videos and articles about what you are learning, and plays music while you study.

The lantern shows what it is doing: a soft flicker when it's ready, it leans in when it's listening, embers drift up while it's thinking, and the flame brightens with its voice while it speaks.

## Things to say (or type)

| Say | What happens |
| --- | --- |
| "Give me a hint" | The next of the exercise's own hints: a nudge, then the idea, then where to look, then the shape of it. Never the answer, and none on a unit check. |
| "What's next?" | The next lesson, with a button to open it |
| "How far am I?" | Your percent, the steps and lessons done ("12 of 165 steps · 8 of 54 lessons") and the time left. A step is one lesson, exercise, project milestone or unit check |
| "Open unit 3" · "Go to unit 2 lesson 4" · "Open the next lesson" | Opens it |
| "Find me a video about this" · "Resources" | Videos, articles, docs and discussions about the lesson, as cards |
| "Play some focus music" · "Play lo-fi" · "Play jazz" | Music in the mini player |
| "Play *anything* on YouTube" | That video in the mini player |
| "Pause" · "Next" · "Louder" · "Quieter" · "Stop the music" | Controls the player |
| "Stop" (or the ■ button, or Esc) | Lantern stops talking straight away |

With an AI set up (below), you can also ask anything: "explain this lesson another way", "why is my code failing?", "what does cfqueryparam protect against?", "look up the difference between arrays and structs".

## Talking out loud

- **The wake word.** Say "**Lantern**" before your question: "Lantern, give me a hint." You can change the word in **Settings → Assistant**. Listening works in Microsoft Edge and Google Chrome; the first time, the browser asks to use the microphone.
- **Push to talk.** Press 🎙️ in the panel, then speak. This always works.
- **Only one app listens at a time.** If Dayspring is running on the same computer, it listens for *its* name and Lantern waits, so the two never both answer. Push to talk still works in Lantern.
- **Only one app talks at a time.** If Dayspring is speaking, Lantern waits for it to finish. A Dayspring alarm or a call pauses Lantern.
- Lantern never changes which speakers or microphone the computer uses.

## Setting up an AI (optional)

Hints, progress, opening lessons, videos and music all work without one. An AI adds explanations in its own words, code reviews and web answers.

1. Open **Settings → Assistant**.
2. **Already set up an AI in Dayspring?** Lantern says so. Tick **Use the AI key from Dayspring**, and you're done.
3. Otherwise pick **Which AI**. **Claude** is recommended; ChatGPT, Grok, or a free local model through Ollama also work.
4. Follow the "Get a key" link, create a key, paste it into **Key**, and press **Save**. **Test** checks that it works.

Your key is saved **encrypted for your Windows user** (the same place Dayspring keeps its key, so the two apps can share it if you allow). It's never shown again, never sent between the apps, and never synced to your account.

**What the AI is sent:** the lesson you are on (its title, goals and key words), your progress, and your question. Your code is sent only when you ask about it ("why is my code failing?", "review my code"). The answers to exercises are never sent: the AI helps you think, and it can't hand you the solution to something you haven't passed. Once you've passed an exercise, it can walk you through a good solution.

## The voice

**Settings → Voice.** Lantern's voice is warm and friendly (a male voice; Dayspring's is female, so you always know which one is talking).

- **Free:** the best voice on your computer. Microsoft Edge's "Natural" voices sound great; Lantern picks Andrew, Brian or Guy if they're there. Choose any voice and a speed.
- **ElevenLabs:** very natural voices, Will by default (Daniel is another good one). Paste your ElevenLabs key there.
- **OpenAI:** paste an OpenAI key.
- **Preview** plays a sample. Turn off **Say replies out loud** in Settings → Assistant to only read them.

## Sound

The 🔊 button in the top bar (and **Settings → Sound**) sets how loud Lantern's voice, chimes, music and videos are, each on its own, with mute and a test button. Music and videos get quieter by themselves while Lantern is talking.

## How it looks

**Settings → Assistant appearance:** six lanterns (Classic amber, Candle, Moonlight blue, Emerald, Rose, Aurora), or your own flame, glass and glow colours, a brass, iron, silver or copper frame, how bright and wide the glow is, how much it flickers, its size, light rays while speaking and embers while thinking, and a calm mode for less motion.

**Settings → Assistant → Where it sits:** on the right, on the left, along the bottom, or hidden (the **Lantern** button at the top brings it back).

**Settings → Appearance:** Lantern evening (dark) or Lantern day (light), high contrast, and less motion for the whole app. **Settings → Display:** bigger or smaller everything and text, and room at the edges for a TV that cuts them off (**Fit to screen** walks you through it).

## Resources

Press **Resources** above a lesson (or ask). Lantern searches places that are good for learning, about the lesson you have open:

- **Videos:** YouTube (and Crash Course for general subjects). **Play here** plays one in the mini player; **Open in browser** opens it in a tab.
- **Reading and discussion:** freeCodeCamp, Codecademy, MDN, Khan Academy, Wikipedia, the course's reference docs and blogs, and the course's subreddits.
- **Reference (works offline too):** for the ColdFusion course, the reference page for every tag the lesson uses, and the course's reading list.

Only learning sites on Lantern's list are shown. Results are remembered for a week, so they are still there offline. Lantern searches with the lesson's own words, never with anything you typed into the editor.

## If something is off

- **Lantern doesn't hear me:** check the browser allowed the microphone (the icon in the address bar), use Edge or Chrome, and check Dayspring isn't the one listening (then use 🎙️). The wake word is heard only while the Lantern window is open.
- **It says the AI key wasn't accepted:** paste the key again in Settings → Assistant and press **Test**.
- **No videos appear:** you may be offline; the offline reference links still work, and the search runs again when you're back.
- **Too chatty:** turn off **Say replies out loud**, or say "stop".
