# 🍬 Ofunca

**Ask your class notes anything, even in airplane mode.**
An Android app that turns your own notes (PDFs, text files, pasted text or photos of handouts) into a private AI tutor. Every answer is grounded in *your* notes and shows the exact passages it came from. All the AI runs **on the phone** through [Tether's QVAC SDK](https://docs.qvac.tether.io). There is no cloud, no account and no data leaving the device.

Built for the **AI Yako hackathon (Tether QVAC × DoraHacks)**. Suggested track: **Offline AI apps** (also eligible for the overall prize).

---

## Why

Students in places with expensive or unreliable data, like much of Nigeria where this was built, still have phones and class notes. Cloud AI tutors need a constant connection, cost data, and send private study material to someone else's servers. Ofunca needs the internet **once**, to download the models. After that it works anywhere: in a lecture hall with no signal, on a bus, or during a power cut when the router is off.

## What it does

| Feature | How |
|---|---|
| **Add notes bar** | Three compact, flat buttons (PDF / file, Snap photo, Paste text): small icon badge, short label, thin border |
| **Import notes** | PDF (text extracted on-device with an inlined pdf.js, no network), `.txt` / `.md`, or pasted text, filed under a subject |
| **Snap notes** | Opens Ofunca's own full-screen camera (built in with `expo-camera`, so Android never closes the app for a separate camera app and the photo can't get lost). Page-frame guides, flash, a big shutter, a Gallery shortcut, then a crop screen: drag the four corner handles (or the whole box) to trim the photo to just your notes, with **Retake** or **Read it**. Gallery photos go through the same crop. **QVAC OCR** (bundled in the APK, no extra download) reads the photo on-device; the text opens in an editable box with a low-confidence warning. If camera access is refused, Snap goes straight to the gallery |
| **Subjects** | Pick an existing subject from the chips or type a new one. Nothing is pre-filled: chips stay separate from the typing box, and an empty choice files notes under *General*. Subject comes above Title in the Paste/Snap editor |
| **No size limits** | No caps on PDF pages, pasted text, subjects or library size. Very large imports simply take longer to read and index |
| **Job queue** | Snap, Import and Paste always stay tappable; jobs queue one after another. Ask and Quiz are not in that line: they share the tutor model through a priority lock, so Ask always works, even while a quiz is being written (v1.0.16) |
| **On-device indexing** | Notes are split into overlapping, sentence-aware passages and embedded with **EmbeddingGemma 300M** via QVAC `embed()` |
| **Ask** | Hybrid search (cosine + keyword boost) finds the top passages; **Llama 3.2 1B Instruct** via QVAC `completion()` streams an answer citing `[1]`, `[2]` with "Where from?" source cards. A watchdog stops stalled answers and puts the question back for a retry |
| **Honest "not in your notes"** | Off-topic questions are refused instead of made up |
| **Quiz** | Objective A to D questions from one subject or a mix. The quiz screen says how many different questions your notes can make (*"Your notes can make about N questions"*) and only offers sizes up to that, with **All (N)**. One question per distinct fact in your notes, short options of similar length, the right letter spread evenly. **Stop** button while it writes, instant right/wrong feedback, haptics and a score |
| **Review my mistakes** | Wrong answers are saved (no cap; each question once) and all of them are replayed in a shuffled review round; get one right and it leaves the list |
| **History** | Ask and Quiz history survive app restarts |
| **Intro** | The bare Ofunca O pops in (the launch screen shows the same bare O, so there's no jump), then its purple graduation hat streaks in from the top corner like a shooting star with a sparkly tail, rolls and loops around the O, swells as it climbs and drops onto the O with a bounce, completing the logo. The letters of *Ofunca* then fall in one by one, followed by the tagline *Study. Anywhere. No connection.* The full show (about 5 seconds, holding the finished logo for a moment) plays on every launch while the app loads (since v1.0.12); tap anywhere to skip it |
| **Menu** | Left drawer (two-line button, top left) opens as a short, clean list: **Study**, **Look & speed**, **My data**, **About** and **Report a problem**. Each section stays folded until tapped; tap it again to fold it, or it folds by itself when you open another section or close the menu. Look & speed holds theme (Auto, Light, Dark) and AI speed (CPU, GPU) as full-width buttons. About holds **About Ofunca** (ⓘ: what the app does plus the developer card and links), Privacy & offline, Built with and Check for updates. Report a problem opens the SMS report sheet straight away |
| **Report a problem** | Users type the issue and send it by **SMS, so no internet data is needed**, or by WhatsApp or email when online. App version, Android version and the app's last error are added automatically. No length limit since v1.0.12; a long report goes out as several SMS |
| **Status dot** | The header shows "On-device AI" (or "Offline · on-device AI") for a few seconds, then shrinks to a green dot; tap the dot to see it again, and tap the badge to tuck it away at once. Everything works offline |

## How it uses QVAC

All inference goes through `@qvac/sdk` (v0.22) running in a Bare worker inside the app (`react-native-bare-kit`), set up with the official **Expo** path (`@qvac/sdk/expo-plugin`). See `src/qvac.ts` and `src/ocr.ts`.

| QVAC API | Used for |
|---|---|
| `downloadAsset()` | One-time model download with per-model progress (setup screen). Llama and EmbeddingGemma come from a commit-pinned Hugging Face HTTPS mirror of the exact catalog file (QVAC's HTTP loader resumes with Range requests and verifies the Hub SHA-256, which equals the catalog checksum), with the QVAC registry as the second route. OCR comes from the QVAC registry. See `src/modelDownload.ts` |
| `getModelInfo()` | Checks whether models are already cached, so later launches skip the network entirely |
| `loadModel({ modelType: 'embeddings' })` + `embed()` | EmbeddingGemma 300M Q4_0 (768-dim) for passages (`title: none \| text:` prompt) and questions (`task: search result \| query:` prompt) |
| `loadModel({ modelType: 'llm' })` + `completion()` | Llama 3.2 1B Instruct Q4_0, 4k context, streaming tokens via `run.events` |
| `completion({ responseFormat: { type: 'json_schema' } })` | Grammar-constrained quiz generation, so the output is always valid JSON |
| `loadModel({ modelType: 'ocr' })` + `ocr()` | QVAC OCR (CRAFT detector + Latin recogniser) for "Snap notes", with per-line confidence |
| `qvac.config.json` plugins | Only the `llamacpp-completion`, `llamacpp-embedding` and `ggml-ocr` plugins are bundled (tree-shaken worker) |

### Models (downloaded once, then cached on the phone)

| Model | QVAC constant | Size |
|---|---|---|
| Llama 3.2 1B Instruct Q4_0 | `LLAMA_3_2_1B_INST_Q4_0` | 773 MB |
| EmbeddingGemma 300M Q4_0 | `EMBEDDINGGEMMA_300M_Q4_0` | 278 MB |
| QVAC OCR Latin + CRAFT detector | `OCR_LATIN` + `OCR_CRAFT` | ~98 MB |
| **Total** | | **≈ 1.15 GB** |

### Slow or flaky networks (v1.0.3)

- Finished models are never downloaded again; a partly downloaded model continues from the bytes already saved (HTTP Range resume), including after the app is closed.
- Automatic retries with backoff (3 s up to 90 s), waiting for the phone to come back online; the screen is kept awake while downloading.
- Longer QVAC timeouts for mobile data (`registryStreamTimeoutMs` 120 s, `registryDownloadMaxRetries` 6, `httpConnectionTimeoutMs` 30 s), written to the runtime `qvac.config.json` before the SDK starts.
- **Import model file:** download the `.gguf` in Chrome (links on the setup screen), then pick it with the system file picker. The app matches it by exact size, copies it into the QVAC cache and QVAC checks the catalog SHA-256 before it is used. No storage permission needed.
- OCR is optional for setup: if it fails, the app still starts and fetches OCR the first time you tap *Snap notes*.

The models load comfortably side by side on a phone with 8 GB of RAM (tested target: Redmi Note 13, 8 GB).

## Offline guarantees

- **Internet is used for exactly one thing:** the first-run model download (`downloadAsset`). After that, `loadModel` loads from the local QVAC cache: the SDK checks the cached files on disk before touching the network.
- Notes, passages, embeddings, questions and answers are stored only in the app's private storage (`ofunca/library.json`). Nothing is uploaded, and there is no analytics or telemetry.
- The PDF reader is a hidden WebView with pdf.js **inlined** and a strict Content-Security-Policy (`default-src 'none'`), so it cannot fetch anything. If its renderer dies on a huge PDF, the app restarts the reader instead of closing (v1.0.12).
- `android:usesCleartextTraffic="false"`, `android:allowBackup="false"`.

## Permissions and security (clean sideload)

The release APK requests only:

- `INTERNET` for the one-time model download
- `ACCESS_NETWORK_STATE` for the offline indicator
- `CAMERA` for Ofunca's in-app camera in *Snap notes* (asked the first time you snap)
- `VIBRATE` for the short haptic tick (right) or double buzz (wrong) when you answer a quiz question. It is a normal permission with no prompt. Without it Android stopped the app on the first quiz answer, fixed in v1.0.12.

Files and gallery photos are opened with the Android system picker (Storage Access Framework), so the app needs **no storage or media permissions**. Storage, media, microphone, overlay, SMS, contacts, location and install-packages permissions are all explicitly removed in `app.json` (`blockedPermissions`). The release build is not debuggable. It is signed with APK Signature Scheme v2 + v3, with no packers and no downloaded executable code (only model weights are downloaded). R8 shrinking is enabled by QVAC's official Expo plugin; this is the standard Android Gradle tool, not an obfuscating packer.

> Sideloaded apps still show Android's normal *"install unknown apps"* prompt, and Xiaomi/Play Protect may run a routine scan of an app they have not seen before. That is expected for any APK installed outside the Play Store.

## Stability fixes (v1.0.12)

A full pass over every tap, saved file and native call, so a real phone never closes on its own:

- **Quiz answer closed the app:** the vibration permission was blocked; it is now allowed and the buzz can never take the quiz down.
- **Friendly error instead of a crash:** a top-level error screen with *Try again* (your notes are kept) catches drawing errors, and in release builds any stray JavaScript error shows a short message instead of closing Ofunca. Development builds still show the normal red error screen. If the opening animation itself ever fails, it is simply skipped.
- **Big PDFs:** if the hidden PDF reader runs out of memory, Android used to close the whole app; now that PDF fails with a clear message and a fresh reader starts.
- **Old saved history:** quizzes, mistakes and answers saved by earlier versions are cleaned on load (missing options, answer, source or passages), so they can't crash the Quiz or Ask tabs. A damaged notes library file is also cleaned instead of breaking start-up.
- **Double taps:** Ask, Quiz me, Save, Snap, Download and Import model ignore a second tap while the first is starting, so nothing is asked, saved or generated twice. A quiz answer counts once.
- **Review my mistakes:** old mistakes without A–D options are skipped instead of showing an empty question.
- **Quiz edge cases:** notes with no usable text, or a model that writes no valid question, now give a clear message instead of an empty quiz.
- **Start-up:** a failure while opening the library or checking models shows the *Couldn't start* screen with *Try again* instead of hanging on the loading screen; *Try again* and CPU/GPU switching can't load the models twice.
- **Camera and crop:** a failed shot or gallery pick no longer leaves an error behind, and the crop box is kept inside the photo so it can't ask for a negative or zero size.
- **Links and deletes:** the model download links, *Remove notes*, *Delete all notes* and *Move to subject* show a message if they fail instead of failing silently.

### Caps removed (v1.0.12)

- **Quiz size:** 50 and **All** join 5/10/15/20. *All* writes one question per usable passage in the chosen notes. If the notes run out first (or a few questions can't be written), the quiz stops cleanly and says how many were made. Questions are written one at a time in the background, so the screen stays usable, and **Stop** in the progress bar keeps the questions already written. Saved history stores quizzes without embeddings, so big quizzes stay light.
- **Mistakes list:** no longer trimmed to the last 60; each question is still kept only once.
- **Review my mistakes:** replays every replayable mistake, not just 20.
- **Report a problem:** the 300-character limit is gone (the message box scrolls; long SMS are split by the phone).
- Kept on purpose, because they protect the 1B on-device model and keep answers fast: 2048-token context, answer/quiz token budgets, 3 passages per answer (from the top 8 matches), excerpts trimmed to 650 characters in the quiz prompt (520 since v1.0.13), the last 4 questions in the "don't repeat" list (since v1.0.13: earlier questions up to ~450 characters, plus a code check against every question), up to 3 questions per message, 3 source cards per answer, 5 uncertain OCR lines previewed in the review box, and the 90-character last-error line added to reports.

## Fixes (v1.0.13)

- **Keyboard goes away when you send.** Asking a question, *Shorter*, sending a *Reply*, *Save & index* in Paste notes, the subject *Continue* button and *Quiz me* now close the keyboard, so the answer being written is visible instead of hidden behind it.
- **Quiz score no longer says "Done" too early.** While questions are still being written the score shows *right / answered* only. *🎉 Done!* and the perfect-score confetti appear only after the last question has been written **and** every question is answered (or after Stop).
- **No repeated quiz questions.** Each new question is compared with every question already in the quiz: wording is normalised (case, punctuation, spacing) and a question with the same opening or heavy word overlap counts as a repeat. A repeat is thrown away and the next passage is tried, with a few spare tries for short notes. The model is also shown the earlier questions (same passage first, then newest, kept short for the 2048-token context) and told to ask about something different.
- **Cleaner question wording.** The quiz prompt asks for exam-style questions that never mention "the excerpt" or "the notes", and filler such as ", as mentioned in the note excerpt" or "According to the notes," is removed from questions in code.
- **Faster answers and quizzes (same model, same quality target).** Quiz passages are trimmed to ~520 characters (from 650), so the phone reads ~20% fewer tokens per question; the quiz token budget is 100 (a question plus four short options needs ~70, and the JSON format ends it as soon as it is complete); the repeat penalty is off for quiz JSON, which repeats quotes and commas by design. Ask answers are capped at 160 tokens (110 per part when one message asks several things; replies 150), still well above the 1–3 sentences the tutor is told to write, so this only cuts off rambling. The model stays loaded between questions and nothing is re-embedded during a quiz. Expected effect: modestly shorter waits per quiz question, and no more long run-ons in answers; the biggest wait on GPU phones is the phone itself, so CPU mode may be faster on some phones (worth trying in *Look & speed*).

## Fixes (v1.0.14)

- **Wrong quiz answer keys caught.** The small on-device model sometimes marks the wrong option as correct (e.g. the notes list "Promotes public interest" but the key said "Encourages dialogue"). Every question is now checked against its source passage: each option is scored by how much of it appears in the notes (content words, or the exact phrase). If the key is clearly unsupported and exactly one other option is clearly supported, the key is fixed; if it is unclear, or two options are equally supported, the question is dropped and the next passage is tried. Check: `node --experimental-strip-types scripts/check-mcq-key.ts`.
- **Quizzes no longer end early on short notes.** A 10-question quiz on one short note used to stop after 2–3 questions. When the passages run out, the app now revisits them with a different slice of the passage and a different focus (another list item, a number or term, a purpose or example), with an attempt budget of 3× the questions asked (at least 12). Only when that budget is spent does it stop, and it says so: "Made 4 of 10 — your notes on this subject are short…". "All" uses the same rule (one question per passage, same budget). Stop and partial quizzes work as before.
- **Visible progress while the quiz is written.** A row under the last question shows a spinner, "Writing question 3 of 10…" and Stop. The top button reads "Writing quiz…" while busy instead of looking faded with no reason, and the end-of-quiz message also appears under the questions.
- **Keyboard no longer covers the Ask box.** With Android edge-to-edge, the system no longer resizes the screen for the keyboard, so the app does it itself: the Ask screen pads its bottom to the keyboard's top edge on every show/hide (re-measured each time, so it works after long chats and repeated focus), scrolls the chat to the bottom, and hides the tab bar while typing. Same for Paste notes, Report a problem and the subject picker. Check: `node --experimental-strip-types scripts/check-keyboard.ts`.
- **Cleaner "From your notes" snippets:** they start at a sentence or word boundary instead of mid-word.
- **Small audit fixes:** the quiz note is cleared when a mistakes round starts or the quiz is cleared; the floating progress bar no longer hides the last quiz question. Checked and already fine: mistakes are not double-added (same question text counts once), Android back closes the drawer and every sheet, empty notes show a clear message.

## Fixes (v1.0.15)

From a phone test of v1.0.14 on a Redmi Note 13.

- **Ask bar always fully above the keyboard, suggestion strip included.** React Native only reports the keyboard when it opens or closes, not when it grows afterwards (the word-suggestion / clipboard strip that appears above the keys), so the Ask bar ended up half under that strip. A small config plugin (`plugins/withImeInsets.js`) now listens to the keyboard's real window insets in `MainActivity` and sends its exact height to the app on **every** change; `src/keyboard.tsx` lifts the Ask bar (and Paste notes, Report a problem, the subject picker) to the keyboard's actual top edge plus a 6 dp gap, re-measured on every change. React Native's own keyboard events remain as a fallback. Check: `node --experimental-strip-types scripts/check-keyboard.ts`.
- **"Summarise" gives clean, quick summaries.** Requests like *Summarise the main ideas*, *key points*, *overview* or *recap* now use their own short prompt: the best note's top three passages (trimmed), unnumbered so there is nothing to cite, answered in 2–4 plain sentences with a 110-token budget (it was 160, plus numbered excerpts). The answer is cleaned in code: citation fragments such as `[1. …`, `[2]`, `Excerpt 1:` and stray brackets are removed, a "couldn't find a direct answer" line tacked onto an answer that did use the notes is dropped, and the summary ends at its last full sentence. Sources still show as cards under the answer (before, the stray "couldn't find" line also hid them). The "not found" fallback line is now only shown when nothing was answered. In a sandbox test with the real Llama 3.2 1B model the summary came out as clean prose in ~5 s on CPU.
- **Stricter quiz answer keys.** Each option is now checked against the **one place** in the passage the question is about (the sentences that share the question's words, plus their neighbours), not words scattered across the passage, and words an option merely repeats from the question (e.g. "OLX") earn nothing. Dates and numbers must match the sentence about that fact (e.g. "2019" is rejected when that sentence says 2020); a question that itself contains a date or number not in the notes is dropped. A one- or two-word answer must be in that very sentence ("It occurs in the mitochondria" no longer backs a question about lactic acid). A key the passage does not back is re-keyed only when exactly one other option is clearly stated there (a number, or 2+ of its own words); otherwise the question is dropped and the next passage is tried. Statements posing as questions and questions that give the answer away are skipped too. The key is checked against the exact passage text the model was shown.
- **No more near-duplicate questions.** Repeats are now caught by topic, not just wording: shared topic words (with simple stemming, so *relationship/relationships*), the same pair of names (two OLX–Jiji questions), and the same correct answer all count. Names that run through the whole subject (e.g. "Public Affairs") don't count as a match. Each accepted question's source sentence is taken out of the passage for later questions, so the next question has to use a different fact. The "already asked" list is no longer put in the prompt: tested with the real model, the 1B model copied the listed question back (7 of 9 attempts asked about stomata); without it questions spread across passages. Check: `node --experimental-strip-types scripts/check-mcq-key.ts`.
- **Trade-off:** the stricter checks throw away more of the small model's weak questions, so a quiz may need more attempts (the existing budget of 3× the questions, at least 12, still applies and the app still says "Made X of Y" when notes are short).

## Fixes and features (v1.0.16)

From a phone test of v1.0.15 on a Redmi Note 13 (GPU), plus a full code audit.

**Quiz questions**
- **No more doubled option labels** ("A. B. Online security measures", "C. A. User retention strategy", "A. 3. Negative media coverage"). Letters, numbers and list markers the model copies from the notes ("A.", "b)", "(c)", "3.", "iv)", "a -", "Option B:", "Answer:", bullets, even repeated) are stripped from every option before the app adds its own A–D. Numbers that are part of the answer ("2.5 million") are kept. The correct answer is placed after cleaning, so the key always points at the right option. Old saved quizzes and the mistakes list are cleaned the same way when they load.
- **The correct answer no longer gives itself away by length.** The prompt now asks for 1–6 word options of similar length and shows the model one worked example; the JSON grammar caps every option at 60 characters (a paragraph can't be written), and in code the correct answer may be at most 1.8× the average wrong option (and never over 10 words). A long answer is cut to its first clause when that still makes sense ("Trust must be a core product feature: digital businesses need…" → its first part); otherwise the question is thrown away. Over-long wrong options are trimmed or dropped, options cut off by the cap are dropped, a wrong option that contains the whole right answer (two right answers) is dropped, and Title Case options are put in normal sentence case so all four look alike. A trailing full stop on only one option is removed too.
- **Right letter spread evenly.** The correct answer's position comes from a shuffled bag of A/B/C/D, so over a quiz each letter is the answer about equally often.
- **One question per fact.** When a note is added, Ofunca splits it (instantly, no AI) into distinct facts: full sentences that state something, and short lists such as *"Challenges of Public Affairs: Financial constraints; Political interference; …"* (numbered, lettered and bulleted lists are found even after line breaks are lost, together with their heading). Overlapping passages and repeated sentences count once. Each quiz question is written from one fact plus its neighbouring sentences, so questions cover different things, the prompt is much shorter, and the answer key is checked against that fact. A list becomes *"Which of these is one of the challenges of public affairs?"* with a listed item as the answer and three model-written wrong answers that are checked not to be on the list.
- **Quiz capacity estimate.** The fact count is saved with each note when it is added (notes added before v1.0.16 are counted once, then saved). The quiz screen shows *"Your notes can make about N questions"* for the chosen subject or Mix all, only offers sizes below N, and the last chip reads **All (N)**. N is deliberately conservative (60% of the facts, from tests with the real model on short lecture notes), and if the notes are too short for even one question the Quiz button explains that instead of failing.
- **Requested count met.** Every fact gets up to three tries with a different angle, spread out (all facts first, then the ones that failed), within a budget of 4× the questions (at least 12). Mix all takes turns between subjects. In a sandbox test with the real Llama 3.2 1B model on two short notes (Public Affairs + an OLX digital-marketing case study, 19 facts → "about 11 questions"), 11 of 11 were delivered. The "Made X of Y" note now only appears when the model really couldn't write more good, different questions.
- **Faster per question.** Shorter prompts (one fact instead of a whole passage), capped option lengths (no wasted tokens on paragraph answers or cut-off JSON), list questions where the model writes only three short wrong answers (50 tokens), and fewer thrown-away attempts thanks to the fixes above. Questions still appear one by one while you answer the earlier ones. Duplicate checks also ignore words that run through the whole subject ("public", "affairs"), which used to reject good questions.

**Ask always works**
- **Ask no longer freezes while a quiz is being written.** Before, the quiz ran in the same one-job-at-a-time line as imports, so the Ask box was locked until the whole quiz finished. Now Ask and Quiz have their own state, and the on-device model is shared through a small priority lock (`src/llmLock.ts`): a question you ask goes first. If a quiz question is being written at that moment it is paused (stopped and written again right after your answer, without counting as a failed try), and the quiz carries on by itself. The Ask tab shows *"Quiz paused · answering your question…"* and the quiz row shows the same. The Ask box is always editable; you can type the next question while an answer is written. Searches made while a note is being indexed slip in between indexing batches.
- **Other global locks removed.** The quiz screen's buttons no longer depend on an import or snap being in progress, the floating progress bar no longer sits over the Ask box (and ignores touches), and Shorter / Reply / Clear only wait for the answer being written. Snap notes, which takes the tutor model out of memory for a moment, waits for an answer being written and pauses a quiz instead of breaking it. Switching CPU/GPU while something is running now says so instead of silently doing nothing.

**Keyboard**
- **Ask bar fully above the keyboard.** On the Redmi the bottom of the Ask box was hidden behind the keyboard's suggestion strip by about a status bar's height: React Native measures the screen from below the status bar, while the keyboard height counts from the screen edge. The native keyboard listener now also sends that offset, so both are compared in the same coordinates, and the gap above the keyboard is 10 dp (was 6).

**Audit fixes**
- Library saves run one at a time (a note being indexed while another was moved or removed could write the same temp file twice); history is saved through a temp file too, so closing the app mid-save can't corrupt it; the library is read once even when two screens ask at startup.
- Stopping an Ask answer no longer stops a quiz question and vice versa (each request has its own stop); a stop while waiting for the model returns at once; after a stop or a stall the engine gets a moment to finish before the next job starts.
- The warm-up run at startup waits its turn for the model instead of racing the first question.
- Check for updates: "no release published yet" (404) now says you're up to date instead of "connect to the internet"; a GitHub rate limit says so and doesn't block the next check for a day.
- Quiz cards from old versions with non-text options are skipped safely instead of shifting the answer index.
- New logic checks run in CI before every build: `scripts/check-quiz.ts` (labels, lengths, letters, facts, capacity, the lock and quiz resume, keyboard offset), plus the existing answer-key and keyboard checks.

**Trade-offs**
- Questions whose correct answer can't be shortened without losing its meaning are skipped, and the capacity estimate is kept low on purpose, so very short notes offer fewer questions than before (but the number offered is delivered).
- When you ask something while a quiz question is being written, that question's work so far is thrown away and redone after your answer.
- The keyboard offset fix could not be tried on a real phone from the build machine; if a phone measures differently, the worst case is a slightly larger gap above the keyboard, never a hidden box.

## Install (Android phone, arm64, Android 10+)

1. Download `Ofunca-v1.0.16.apk` to the phone.
2. Open it. If asked, allow your browser or file manager to *install unknown apps*, then tap **Install**.
3. Open **Ofunca**. On **Wi‑Fi**, tap **Download AI models** (≈1.05 GB, one time; the photo reader is built into the app).
4. When you see **"All set!"** you can switch on airplane mode. Everything keeps working.

## Build from source

Requirements: Node 22.21+, JDK 17, Android SDK, **NDK 29.0.14206865**, and a Linux or macOS x86_64 host (or just use the included GitHub Actions workflow).

```bash
npm ci
node scripts/build-pdf-html.js          # inlines pdf.js into src/pdf/pdfHtml.generated.ts
npx expo prebuild --platform android    # QVAC plugin bundles the worker + links native addons
cd android && ./gradlew assembleRelease # -> app/build/outputs/apk/release/app-release-unsigned.apk
# sign (v2+v3) with your own keystore:
KEYSTORE=release.keystore KS_PASS_FILE=pass.txt scripts/sign-apk.sh \
  android/app/build/outputs/apk/release/app-release-unsigned.apk Ofunca.apk
```

No Expo/EAS account is needed. CI: `.github/workflows/android-release.yml` builds the unsigned APK on every push to `main`. Signing happens offline with a private key that is never committed.

Note: QVAC/llama.cpp does not run on Android emulators. Use a physical arm64 device.

## Project layout

```
App.tsx                    UI: setup/download, Notes, Ask, Quiz, paste and OCR editor
src/qvac.ts                QVAC: model list + mirrors, cache check, load, embed, streaming completion, file import
src/modelDownload.ts       Resilient download: cache check, HTTPS mirror with resume, registry fallback, retries
src/SnapCamera.tsx         in-app camera for Snap notes (frame guides, flash, retake)
src/ocr.ts                 QVAC OCR "Snap notes" with line grouping and confidence
src/rag.ts                 hybrid retrieval, grounded answer prompt, answer-key check, duplicate check
src/quizGen.ts             quiz engine: facts + capacity, option cleaning/length balance, one question per fact
src/llmLock.ts             priority lock: Ask goes before quiz questions, Snap pauses a quiz
src/chunk.ts               sentence-aware overlapping chunker
src/store.ts               on-device library (docs + passages + vectors)
src/pdf/                   offline pdf.js WebView extractor (generated page + bridge)
plugins/withReleaseHardening.js   unsigned release, not debuggable, no cleartext/backup
plugins/withImeInsets.js   sends the keyboard's real height (IME insets) to JS on every change
qvac.config.json           QVAC plugins bundled into the mobile worker
```

## Demo script (airplane-mode recording)

Record with the phone's built-in screen recorder (it records offline). Aim for 2 to 3 minutes.

1. **Before recording (on Wi‑Fi):** install the APK, open the app and download the models until you see *All set!*. Have a class-notes PDF in Downloads and a photo of a printed handout in the gallery.
2. **Start recording.** Pull down quick settings and **turn on airplane mode**, with Wi‑Fi and mobile data visibly off. Say: *"No internet at all from here."*
3. Open **Ofunca**. Point at the header chip: **✈ Offline · on-device AI**.
4. **Notes → Import PDF / text**, pick the PDF. Show *Reading PDF… page x/y* and *Indexing on-device…*.
5. **Notes → Snap notes**, pick the handout photo. Show the OCR text in the editable box (and the low-confidence hint if it appears), fix a word, then tap **Save & index on-device**.
6. **Ask** tab: ask a question from the PDF, e.g. *"Where does the Calvin cycle take place?"* Show the answer streaming, the `[1]` citations, and the **Sources from your notes** cards (document + page). Point at *"Answered on-device in x s"*.
7. Ask something **not** in the notes, e.g. *"Who won the 2018 World Cup?"* It replies *"I couldn't find that in your notes."*
8. **Quiz** tab → **Quiz me**. Reveal one answer and its source passage.
9. Pull down quick settings again to show **airplane mode is still on**. End the recording.

(Tip: if you have no PDF handy, tap **Try sample biology notes** on the Notes tab.)

## Known limitations

- A 1B model is fast but small. Answers are short and best on clear, factual notes. Very long or vague questions may get partial answers, though the source passages are always shown so you can check.
- Scanned PDFs (images without a text layer) are not OCR'd automatically. Use *Snap notes* on a photo of the page.
- OCR is tuned for printed English/Latin text. Handwriting is best effort, which is why the editable review box exists.
- The first answer after launch is slower while the models warm up. CPU is the default; GPU can be tried in Notes → Compute.
- arm64 Android 10+ only (QVAC ships arm64 Android binaries).

## License

MIT for the app code. Models are under their own licenses (Llama 3.2 Community License, Gemma Terms of Use). QVAC SDK is Apache-2.0.
