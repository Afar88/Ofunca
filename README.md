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
| **Job queue** | Snap, Import and Paste always stay tappable; jobs queue one after another so the phone never runs two AI jobs at once |
| **On-device indexing** | Notes are split into overlapping, sentence-aware passages and embedded with **EmbeddingGemma 300M** via QVAC `embed()` |
| **Ask** | Hybrid search (cosine + keyword boost) finds the top passages; **Llama 3.2 1B Instruct** via QVAC `completion()` streams an answer citing `[1]`, `[2]` with "Where from?" source cards. A watchdog stops stalled answers and puts the question back for a retry |
| **Honest "not in your notes"** | Off-topic questions are refused instead of made up |
| **Quiz** | Objective A to D questions (5, 10, 15, 20, 50 or **All**, one per usable passage) from one subject or a mix, with a **Stop** button while it writes, with instant right/wrong feedback, haptics and a score |
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

## Install (Android phone, arm64, Android 10+)

1. Download `Ofunca-v1.0.6.apk` to the phone.
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
src/rag.ts                 hybrid retrieval, grounded answer prompt, quiz prompts and parsing
src/chunk.ts               sentence-aware overlapping chunker
src/store.ts               on-device library (docs + passages + vectors)
src/pdf/                   offline pdf.js WebView extractor (generated page + bridge)
plugins/withReleaseHardening.js   unsigned release, not debuggable, no cleartext/backup
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
