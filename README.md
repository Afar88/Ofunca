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
| **Import notes** | PDF (text extracted on-device with an inlined pdf.js, no network), `.txt` / `.md`, or pasted text |
| **📷 Snap notes** | Pick a photo of a printed handout or textbook page. **QVAC OCR** reads it on-device, and the text opens in an **editable box** with a **low-confidence warning** so mistakes can be fixed before indexing. Handwriting is best effort. |
| **On-device indexing** | Notes are split into overlapping, sentence-aware passages and embedded with **EmbeddingGemma 300M** via QVAC `embed()` |
| **Ask** | The question is embedded, then a hybrid search (cosine + keyword boost) finds the top passages. **Llama 3.2 1B Instruct** via QVAC `completion()` streams an answer that cites `[1]`, `[2]`, and the quoted source cards (document + page) are shown under it |
| **Honest "not in your notes"** | Off-topic questions are refused (*"I couldn't find that in your notes."*) instead of made up |
| **🧠 Quiz me** | Generates 4 revision questions from different parts of your notes using QVAC structured output (JSON-schema constrained generation). Tap to reveal the answer and the source passage. |
| **Offline indicator** | The header shows **✈ Offline · on-device AI** when the phone has no connection |

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
- The PDF reader is a hidden WebView with pdf.js **inlined** and a strict Content-Security-Policy (`default-src 'none'`), so it cannot fetch anything.
- `android:usesCleartextTraffic="false"`, `android:allowBackup="false"`.

## Permissions and security (clean sideload)

The release APK requests only:

- `INTERNET` for the one-time model download
- `ACCESS_NETWORK_STATE` for the offline indicator

Files and photos are opened with the Android system picker (Storage Access Framework), so the app needs **no storage, camera or media permissions**. Storage, media, camera, microphone, overlay, SMS, contacts, location and install-packages permissions are all explicitly removed in `app.json` (`blockedPermissions`). The release build is not debuggable. It is signed with APK Signature Scheme v2 + v3, with no packers and no downloaded executable code (only model weights are downloaded). R8 shrinking is enabled by QVAC's official Expo plugin; this is the standard Android Gradle tool, not an obfuscating packer.

> Sideloaded apps still show Android's normal *"install unknown apps"* prompt, and Xiaomi/Play Protect may run a routine scan of an app they have not seen before. That is expected for any APK installed outside the Play Store.

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
