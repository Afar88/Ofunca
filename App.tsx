import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system/legacy';
import NetInfo from '@react-native-community/netinfo';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { C, DARK, LIGHT, CANDY } from './src/theme';
import { PdfExtractor, type PdfExtractorHandle } from './src/pdf/PdfExtractor';
import { chunkPages, chunkText, type RawChunk } from './src/chunk';
import { GENERAL, loadHistory, saveHistory, addDoc, clearAll, loadDB, makeId, removeDoc, roundVec, setDocSubject, subjectOf, subjectsOf, type NoteDoc, type StoredChunk } from './src/store';
import {
  MODELS,
  MODEL_GROUPS,
  MODEL_SPECS,
  downloadModels,
  embedDocuments,
  embedQuery,
  generate,
  importPickedModel,
  isEmbedReady,
  isReady,
  loadEmbedModel,
  loadLlmModel,
  stopGenerating,
  unloadAll,
  warmUp,
  modelsCached,
  savedProgress,
  specOf,
  writeQvacRuntimeConfig,
  type Device,
} from './src/qvac';
import { friendlyError, type DlState, type ModelKey } from './src/modelDownload';
import { OCR_APPROX_MB, downloadOcr, ocrCached, recognise, type OcrResult } from './src/ocr';
import {
  NOT_FOUND,
  cleanAnswer,
  buildFollowUpPrompt,
  SHORTER,
  focusHits,
  ONE_QUESTION_SCHEMA,
  buildAnswerPrompt,
  buildOneQuestionPrompt,
  parseOneQuestion,
  pickQuizExcerpts,
  search,
  type Hit, splitQuestions, bestDocHits } from './src/rag';
import { SAMPLE_NOTES, SAMPLE_TITLE } from './src/sample';

type Tab = 'notes' | 'ask' | 'quiz';
type Phase = 'checking' | 'needDownload' | 'downloading' | 'loading' | 'ready' | 'error';
type QA = { id: string; question: string; answer: string; hits: Hit[]; done: boolean; ms?: number; subject?: string; replyTo?: { id: string; question: string } };
type AiState = 'off' | 'loading' | 'embed' | 'ready';
const AUTO = '__auto__';
type QuizCard = { id: string; question: string; answer: string; source: StoredChunk; docName: string; revealed: boolean };

const SETTINGS_FILE = (FS.documentDirectory ?? '') + 'study-tutor-settings.json';
type ThemePref = 'system' | 'light' | 'dark';
type Settings = { device?: Device; setupDone?: boolean; theme?: ThemePref };
async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await FS.readAsStringAsync(SETTINGS_FILE));
  } catch {
    return {};
  }
}
async function saveSettings(patch: Settings) {
  const cur = await readSettings();
  await FS.writeAsStringAsync(SETTINGS_FILE, JSON.stringify({ ...cur, ...patch })).catch(() => {});
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  // Light / dark mode: follows the phone by default, or the user's choice in Settings.
  const sys = useColorScheme();
  const [themePref, setThemePref] = useState<ThemePref>('system');
  useEffect(() => {
    readSettings().then((st) => st.theme && setThemePref(st.theme));
  }, []);
  const dark = themePref === 'dark' || (themePref === 'system' && sys === 'dark');
  const themeKey = dark ? 'dark' : 'light';
  if (applied !== themeKey) applyTheme(dark);
  function chooseTheme(t: ThemePref) {
    setThemePref(t);
    saveSettings({ theme: t });
  }

  const [phase, setPhase] = useState<Phase>('checking');
  const [phaseMsg, setPhaseMsg] = useState('Starting on-device AI…');
  const [dl, setDl] = useState<Partial<Record<ModelKey, DlState>>>({});
  const [ocrMissing, setOcrMissing] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const setKey = useCallback((k: ModelKey, st: DlState) => setDl((d) => ({ ...d, [k]: st })), []);
  const [device, setDevice] = useState<Device>('cpu');
  const [online, setOnline] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('notes');
  const [docs, setDocs] = useState<NoteDoc[]>([]);
  const [chunks, setChunks] = useState<StoredChunk[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [justDownloaded, setJustDownloaded] = useState(false);
  const pdf = useRef<PdfExtractorHandle>(null);

  const docNames = Object.fromEntries(docs.map((d) => [d.id, d.name]));

  const refreshLibrary = useCallback(async () => {
    const db = await loadDB();
    setDocs([...db.docs]);
    setChunks([...db.chunks]);
  }, []);

  // Network indicator (only used to show that everything runs offline).
  useEffect(() => {
    const unsub = NetInfo.addEventListener((s) => setOnline(!!(s.isConnected && s.isInternetReachable !== false)));
    return () => unsub();
  }, []);

  // The app opens straight away; the AI models load in the background (search model first,
  // then the tutor) and anything that needs them waits for them instead of blocking the screen.
  const [ai, setAi] = useState<AiState>('off');
  const modelsReady = useRef<Promise<boolean> | null>(null);
  const bootModels = useCallback((dev: Device) => {
    const p = (async () => {
      try {
        setPhase('ready');
        setAi('loading');
        await loadEmbedModel(dev);
        setAi('embed');
        await loadLlmModel(dev);
        setAi('ready');
        await saveSettings({ device: dev, setupDone: true });
        warmUp().catch(() => {});
        return true;
      } catch (e: any) {
        setAi('off');
        setPhase('error');
        setPhaseMsg(e?.message ?? String(e));
        return false;
      }
    })();
    modelsReady.current = p;
    return p;
  }, []);

  const refreshSaved = useCallback(async () => {
    const saved = await savedProgress();
    setDl((d) => {
      const out = { ...d };
      for (const m of MODEL_SPECS) {
        const sv = saved[m.key];
        out[m.key] = sv.done
          ? { status: 'done', downloaded: m.expectedSize, total: m.expectedSize }
          : { ...(d[m.key] ?? { status: 'idle' }), downloaded: Math.max(sv.bytes, 0), total: m.expectedSize } as DlState;
      }
      return out;
    });
    return saved;
  }, []);

  useEffect(() => {
    (async () => {
      // Must run before the first QVAC call: the SDK reads this file when its worker starts.
      await writeQvacRuntimeConfig();
      await refreshLibrary();
      const st = await readSettings();
      const dev: Device = st.device === 'gpu' ? 'gpu' : 'cpu';
      setDevice(dev);
      if (st.setupDone) {
        // Fast start: models were set up before, so open the app now and load them behind the scenes.
        const ok = await bootModels(dev);
        if (ok) {
          modelsCached().then((c) => setOcrMissing(!(c.ocrRec && c.ocrDet))).catch(() => {});
          return;
        }
      }
      setPhaseMsg('Checking AI models on this phone…');
      const cached = await modelsCached();
      setOcrMissing(!(cached.ocrRec && cached.ocrDet));
      if (cached.embed && cached.llm) await bootModels(dev);
      else {
        await refreshSaved().catch(() => {});
        setPhase('needDownload');
      }
    })();
  }, [bootModels, refreshLibrary, refreshSaved]);

  async function startDownload() {
    setPhase('downloading');
    activateKeepAwakeAsync('model-download').catch(() => {});
    try {
      // Finished models are skipped; a partial download continues from the bytes already saved.
      const r = await downloadModels(['embed', 'llm', 'ocrRec', 'ocrDet'], setKey);
      setOcrMissing(r.failedOptional.length > 0);
      setJustDownloaded(true);
      await bootModels(device);
    } catch (e: any) {
      setPhase('needDownload');
      await refreshSaved().catch(() => {});
      Alert.alert(
        'Download paused',
        `${friendlyError(e)}\n\nYour progress is saved. Tap "Resume download" when the connection is better (Wi‑Fi helps). You can also download the files in Chrome and use "Import model file".`,
      );
    } finally {
      deactivateKeepAwake('model-download').catch(() => {});
    }
  }

  async function importModel() {
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: false, multiple: false });
    if (res.canceled || !res.assets?.length) return;
    const f = res.assets[0];
    setImporting('Preparing…');
    try {
      const m = await importPickedModel({ uri: f.uri, size: f.size, name: f.name }, setImporting);
      setKey(m.key, { status: 'done', downloaded: m.expectedSize, total: m.expectedSize, source: 'file' });
      const c = await modelsCached();
      setOcrMissing(!(c.ocrRec && c.ocrDet));
      if (c.embed && c.llm) {
        setJustDownloaded(true);
        await bootModels(device);
      } else {
        Alert.alert('Model imported', `${m.fileName} is ready. ${!c.embed || !c.llm ? 'Import or download the other model to finish setup.' : ''}`);
      }
    } catch (e: any) {
      Alert.alert('Import failed', e?.message ?? String(e));
    } finally {
      setImporting(null);
    }
  }

  async function switchDevice(dev: Device) {
    if (dev === device || busy) return;
    setDevice(dev);
    await saveSettings({ device: dev });
    await unloadAll();
    await bootModels(dev);
  }

  // ---------- Indexing ----------
  async function indexDoc(name: string, kind: NoteDoc['kind'], raw: RawChunk[], subject: string) {
    if (!raw.length) throw new Error('No readable text found.');
    const vecs = await embedDocuments(
      raw.map((c) => c.text),
      (d, t) => setBusy(`Indexing on-device… ${d}/${t}`),
    );
    const docId = makeId('d');
    const stored: StoredChunk[] = raw.map((c, i) => ({ id: makeId('c'), docId, page: c.page, text: c.text, vec: roundVec(vecs[i]) }));
    await addDoc(
      { id: docId, name, kind, subject: subject.trim() || GENERAL, addedAt: Date.now(), chunkCount: stored.length, charCount: raw.reduce((s, c) => s + c.text.length, 0) },
      stored,
    );
    await refreshLibrary();
  }

  async function guarded(label: string, fn: () => Promise<void>, needs: 'embed' | 'llm' = 'embed') {
    if (busy) return;
    const ready = () => (needs === 'llm' ? isReady() : isEmbedReady());
    setBusy(label);
    try {
      if (!ready()) {
        setBusy('Getting the AI ready… (only takes a moment)');
        const ok = await (modelsReady.current ?? Promise.resolve(false));
        if (!ok || !ready()) throw new Error('The AI models could not be loaded. Restart the app and try again.');
        setBusy(label);
      }
      await fn();
    } catch (e: any) {
      Alert.alert('Something went wrong', e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  // ---------- Subjects ----------
  const subjects = subjectsOf(docs);
  const [picker, setPicker] = useState<null | { title: string; value: string; resolve: (v: string | null) => void }>(null);
  function pickSubject(title: string, initial = ''): Promise<string | null> {
    return new Promise((resolve) => setPicker({ title, value: initial || (subjects[0] ?? ''), resolve }));
  }
  function closePicker(v: string | null) {
    picker?.resolve(v == null ? null : v.trim() || GENERAL);
    setPicker(null);
  }
  async function moveDoc(d: NoteDoc) {
    const sub = await pickSubject(`Move "${d.name}" to…`, subjectOf(d));
    if (!sub) return;
    await setDocSubject(d.id, sub);
    await refreshLibrary();
  }

  async function importFile() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'text/plain', 'text/markdown', 'text/*'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled || !res.assets?.length) return;
    const f = res.assets[0];
    const isPdf = (f.mimeType ?? '').includes('pdf') || f.name.toLowerCase().endsWith('.pdf');
    const subject = await pickSubject('Which subject is this for?');
    if (!subject) return;
    await guarded('Reading file…', async () => {
      let raw: RawChunk[];
      if (isPdf) {
        const b64 = await FS.readAsStringAsync(f.uri, { encoding: FS.EncodingType.Base64 });
        const pages = await pdf.current!.extract(b64, (p, t) => setBusy(`Reading PDF… page ${p}/${t}`));
        raw = chunkPages(pages);
        if (!raw.length) throw new Error('This PDF has no selectable text (it may be scanned). Try "Snap notes" on a photo of the page instead.');
      } else {
        raw = chunkText(await FS.readAsStringAsync(f.uri));
      }
      await indexDoc(f.name.replace(/\.(pdf|txt|md)$/i, ''), isPdf ? 'pdf' : 'text', raw, subject);
      FS.deleteAsync(f.uri, { idempotent: true }).catch(() => {});
    });
  }

  // ---------- Paste & Snap modals ----------
  const [editor, setEditor] = useState<null | { mode: 'paste' | 'ocr'; title: string; text: string; subject: string; ocr?: OcrResult }>(null);

  async function snapNotes() {
    // Uses the system file/gallery picker (no camera or storage permission needed).
    if (ocrMissing && !(await ocrCached())) {
      if (online === false) {
        Alert.alert('OCR model not downloaded', `Snap notes needs a one-time ${OCR_APPROX_MB} MB download. Connect to the internet once, then try again.`);
        return;
      }
      let ok = false;
      await guarded('Downloading OCR model…', async () => {
        activateKeepAwakeAsync('ocr-download').catch(() => {});
        try {
          await downloadOcr((k, st) => {
            setKey(k, st);
            const mb = `${(st.downloaded / 1e6).toFixed(0)} / ${(st.total / 1e6).toFixed(0)} MB`;
            setBusy(st.status === 'waiting' ? `OCR download: ${st.note ?? 'retrying…'}` : `Downloading OCR model (${k === 'ocrRec' ? '1' : '2'}/2)… ${mb}`);
          });
          ok = true;
          setOcrMissing(false);
        } finally {
          deactivateKeepAwake('ocr-download').catch(() => {});
        }
      });
      if (!ok) return;
    }
    const res = await DocumentPicker.getDocumentAsync({ type: ['image/*'], copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets?.length) return;
    const f = res.assets[0];
    await guarded('Reading photo…', async () => {
      const r = await recognise(f.uri, setBusy);
      if (!r.text.trim()) throw new Error('No text was found in this photo. Try a sharper, well-lit photo taken straight on.');
      setEditor({ mode: 'ocr', title: 'Snapped notes ' + new Date().toLocaleDateString(), text: r.text, subject: subjects[0] ?? '', ocr: r });
    });
  }

  async function saveEditor() {
    if (!editor) return;
    const { title, text, mode, subject } = editor;
    if (text.trim().length < 30) {
      Alert.alert('Too short', 'Add a bit more text (at least a couple of sentences).');
      return;
    }
    setEditor(null);
    await guarded('Indexing…', async () => {
      await indexDoc(title.trim() || 'Pasted notes', mode === 'ocr' ? 'text' : 'pasted', chunkText(text), subject);
    });
  }

  async function addSample() {
    await guarded('Adding sample notes…', async () => {
      await indexDoc(SAMPLE_TITLE, 'text', chunkText(SAMPLE_NOTES), 'Biology');
    });
  }

  // ---------- Ask ----------
  const [qas, setQas] = useState<QA[]>([]);
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<string>(AUTO); // AUTO = pick the subject that best matches the question
  const [generating, setGenerating] = useState(false);
  const listRef = useRef<FlatList<QA>>(null);
  const subjectByDoc = Object.fromEntries(docs.map((d) => [d.id, subjectOf(d)]));
  const scopeValid = scope === AUTO || subjects.includes(scope) ? scope : AUTO;
  const chunksIn = (sub: string) => (sub === AUTO ? chunks : chunks.filter((c) => subjectByDoc[c.docId] === sub));

  const [replyTo, setReplyTo] = useState<QA | null>(null);

  // A reply to an earlier answer reuses that answer's passages, so it stays on the same topic.
  async function followUp(prev: QA, text: string) {
    setReplyTo(null);
    const id = makeId('q');
    const t0 = Date.now();
    await guarded('Thinking…', async () => {
      setQas((p) => [...p, { id, question: text === SHORTER ? 'Shorter, please' : text, answer: '', hits: prev.hits, done: false, subject: prev.subject, replyTo: { id: prev.id, question: prev.question } }]);
      setBusy(null);
      setGenerating(true);
      let answer = '';
      try {
        answer = cleanAnswer(
          await generate(
            buildFollowUpPrompt(prev.question, prev.answer, text, prev.hits),
            (txt) => setQas((p) => p.map((x) => (x.id === id ? { ...x, answer: cleanAnswer(txt) } : x))),
            { maxTokens: 200 },
          ),
        );
      } finally {
        setGenerating(false);
      }
      setQas((p) => p.map((x) => (x.id === id ? { ...x, answer: answer || NOT_FOUND, done: true, ms: Date.now() - t0 } : x)));
    }, 'llm');
    setQas((p) => p.map((x) => (x.id === id ? { ...x, done: true } : x)));
  }

  async function ask() {
    const q = question.trim();
    if (!q) return;
    if (replyTo) {
      setQuestion('');
      await followUp(replyTo, q);
      return;
    }
    if (!chunks.length) {
      Alert.alert('No notes yet', 'Add some notes first (or try the sample notes).');
      return;
    }
    setQuestion('');
    const id = makeId('q');
    const t0 = Date.now();
    await guarded('Searching your notes…', async () => {
      setQas((prev) => [...prev, { id, question: q, answer: '', hits: [], done: false }]);
      // Each question in the message gets its own search, subject and note, so answers never mix.
      const parts = splitQuestions(q);
      const multi = parts.length > 1;
      const done: string[] = [];
      const allHits: Hit[] = [];
      const subs: string[] = [];
      const show = (cur = '') => {
        const list = cur ? [...done, cur] : done;
        return multi ? list.map((a, i) => `${i + 1}. ${a}`).join('\n\n') : list[0] ?? '';
      };
      for (const part of parts) {
        const qv = await embedQuery(part);
        let hits = search(qv, part, chunksIn(scopeValid), docNames, 8);
        const subject = scopeValid === AUTO ? subjectByDoc[hits[0]?.chunk.docId] : scopeValid;
        hits = bestDocHits(hits.filter((h) => subjectByDoc[h.chunk.docId] === subject), 3);
        const best = hits[0]?.score ?? 0;
        let answer: string;
        if (best < 0.22) { // off-topic questions score ~0.18 with EmbeddingGemma; on-topic ≥0.3
          answer = NOT_FOUND;
        } else {
          setBusy(null);
          setGenerating(true);
          try {
            answer = cleanAnswer(
              await generate(
                buildAnswerPrompt(part, hits),
                (txt) => setQas((prev) => prev.map((x) => (x.id === id ? { ...x, answer: show(cleanAnswer(txt)) } : x))),
                { maxTokens: multi ? 140 : 220 },
              ),
            );
          } finally {
            setGenerating(false);
          }
          if (answer.replace(/[^a-z0-9]/gi, '').length < 3) {
            answer = `From your notes: “${hits[0]?.chunk.text.slice(0, 300) ?? ''}”`;
          }
        }
        if (!answer.toLowerCase().includes("couldn't find that in your notes")) {
          allHits.push(...hits);
          if (subject && !subs.includes(subject)) subs.push(subject);
        }
        done.push(answer || NOT_FOUND);
        setQas((prev) => prev.map((x) => (x.id === id ? { ...x, answer: show(), hits: allHits.slice(), subject: subs.join(' · ') || undefined } : x)));
      }
      setQas((prev) =>
        prev.map((x) => (x.id === id ? { ...x, answer: show() || NOT_FOUND, hits: allHits, subject: subs.join(' · ') || undefined, done: true, ms: Date.now() - t0 } : x)),
      );
    }, 'llm');
    setQas((prev) => prev.map((x) => (x.id === id ? { ...x, done: true } : x)));
  }

  // ---------- Quiz ----------
  const [quiz, setQuiz] = useState<QuizCard[]>([]);

  // ---------- Saved history: answers and quizzes are still there after closing the app ----------
  const historyLoaded = useRef(false);
  useEffect(() => {
    loadHistory<{ qas?: QA[]; quiz?: QuizCard[] }>().then((h) => {
      if (h?.qas) setQas(h.qas.map((x) => ({ ...x, done: true, answer: x.answer || NOT_FOUND })));
      if (h?.quiz) setQuiz(h.quiz);
      historyLoaded.current = true;
    });
  }, []);
  useEffect(() => {
    if (!historyLoaded.current || generating) return;
    const t = setTimeout(() => {
      // Embeddings are dropped from the saved copy: they're big and not needed to show past answers.
      const lite = (c: StoredChunk) => ({ ...c, vec: [] as number[] });
      saveHistory({
        qas: qas.filter((x) => x.done).map((x) => ({ ...x, hits: x.hits.map((h) => ({ ...h, chunk: lite(h.chunk) })) })),
        quiz: quiz.map((z) => ({ ...z, source: lite(z.source) })),
      });
    }, 400);
    return () => clearTimeout(t);
  }, [qas, quiz, generating]);

  function confirmClear(what: 'chat' | 'quiz') {
    Alert.alert(what === 'chat' ? 'Clear all questions?' : 'Clear this quiz?', 'This only removes the history. Your notes stay.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => (what === 'chat' ? setQas([]) : setQuiz([])) },
    ]);
  }
  function deleteQa(id: string) {
    Alert.alert('Delete this question?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => setQas((prev) => prev.filter((x) => x.id !== id)) },
    ]);
  }

  async function makeQuiz() {
    const pool = chunksIn(scopeValid);
    if (!pool.length) {
      Alert.alert('No notes yet', 'Add some notes first (or try the sample notes).');
      return;
    }
    setQuiz([]);
    await guarded('Writing quiz…', async () => {
      const excerpts = pickQuizExcerpts(pool, 4);
      const asked: string[] = [];
      for (let i = 0; i < excerpts.length; i++) {
        setBusy(`Writing question ${i + 1} of ${excerpts.length}…`);
        const raw = await generate(buildOneQuestionPrompt(excerpts[i].text, asked), () => {}, {
          maxTokens: 120,
          temp: 0.5,
          jsonSchema: ONE_QUESTION_SCHEMA,
        });
        const q = parseOneQuestion(raw);
        if (!q) continue;
        asked.push(q.question);
        setQuiz((prev) => [
          ...prev,
          { id: makeId('z'), ...q, source: excerpts[i], docName: docNames[excerpts[i].docId] ?? 'Notes', revealed: false },
        ]);
      }
    }, 'llm');
  }

  // ---------- Render ----------
  if (phase !== 'ready') {
    return (
      <SafeAreaView style={[s.safe, s.hero]}>
        <StatusBar style="light" />
        <ScrollView contentContainerStyle={s.setup}>
          <BrandMark />
          <Text style={s.title}>Ofunca</Text>
          <Text style={s.tagline}>Your notes. Your tutor. No signal needed.</Text>
          <Text style={s.sub}>Ask your class notes anything and get answers straight from them, with the AI running entirely on your phone.</Text>
          {phase === 'needDownload' || phase === 'downloading' ? (
            <View style={s.card}>
              <Text style={s.h2}>One-time setup</Text>
              <Text style={s.body}>
                Download the on-device AI models once (about {Math.round((MODELS.reduce((a, m) => a + m.approxMB, 0) + OCR_APPROX_MB) / 10) / 100} GB, Wi‑Fi
                recommended). After that the app works with no internet, even in airplane mode.
              </Text>
              {MODEL_GROUPS.map((g) => {
                const v = groupView(g.keys, dl);
                return (
                  <View key={g.id} style={s.modelRow}>
                    <Text style={s.modelName}>
                      {v.done ? '✅ ' : ''}
                      {g.label}
                    </Text>
                    <Text style={s.small}>
                      {g.role} · {v.sizeText}
                      {v.line ? ` · ${v.line}` : ''}
                    </Text>
                    {v.error ? <Text style={[s.small, { color: C.danger }]}>{v.error}</Text> : null}
                    <View style={s.bar}>
                      <View style={[s.barFill, { width: `${v.pct}%` }]} />
                    </View>
                  </View>
                );
              })}
              <Pressable
                style={[s.btn, (phase === 'downloading' || !!importing) && s.btnDisabled]}
                disabled={phase === 'downloading' || !!importing}
                onPress={startDownload}
              >
                <Text style={s.btnText}>
                  {phase === 'downloading' ? 'Downloading… (keep the app open)' : hasProgress(dl) ? 'Resume download' : 'Download AI models'}
                </Text>
              </Pressable>
              {phase !== 'downloading' && (
                <>
                  <Pressable style={[s.btnGhost, !!importing && s.btnDisabled]} disabled={!!importing} onPress={importModel}>
                    <Text style={s.btnGhostText}>{importing ?? 'Import model file (.gguf)'}</Text>
                  </Pressable>
                  <Pressable onPress={() => setShowLinks((x) => !x)} hitSlop={8}>
                    <Text style={[s.small, { color: C.primary, marginTop: 12, textAlign: 'center', fontWeight: '600' }]}>
                      {showLinks ? 'Hide download links' : 'Slow network? Download the files in your browser'}
                    </Text>
                  </Pressable>
                  {showLinks && (
                    <View style={{ marginTop: 8 }}>
                      <Text style={s.small}>
                        Open each link in Chrome (it can pause and resume), then come back and tap "Import model file". The app checks each file's
                        SHA-256 before using it.
                      </Text>
                      {MODEL_SPECS.filter((m) => m.mirrorUrl).map((m) => (
                        <Pressable key={m.key} style={s.suggest} onPress={() => Linking.openURL(m.mirrorUrl!)}>
                          <Text style={s.suggestText}>
                            ⬇ {m.fileName} ({Math.round(m.expectedSize / 1e6)} MB)
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </>
              )}
              {online === false && <Text style={s.warn}>You're offline. Connect to the internet for this one-time download.</Text>}
            </View>
          ) : phase === 'error' ? (
            <View style={s.card}>
              <Text style={s.h2}>Couldn't start the AI</Text>
              <Text style={s.body}>{phaseMsg}</Text>
              <Pressable style={s.btn} onPress={() => bootModels(device)}>
                <Text style={s.btnText}>Try again</Text>
              </Pressable>
              <Pressable style={s.btnGhost} onPress={() => switchDevice(device === 'cpu' ? 'gpu' : 'cpu')}>
                <Text style={s.btnGhostText}>Try with {device === 'cpu' ? 'GPU' : 'CPU'} instead</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ alignItems: 'center', marginTop: 28 }}>
              <ActivityIndicator color="#A5B4FC" />
              <Text style={[s.heroSmall, { marginTop: 10 }]}>{phaseMsg}</Text>
            </View>
          )}
          <Credit dark />
        </ScrollView>
        <PdfExtractor ref={pdf} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['left', 'right', 'bottom']}>
      <StatusBar style="light" />
      <View style={[s.header, { paddingTop: insets.top + 12 }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Ofunca</Text>
          <Text style={[s.small, { color: 'rgba(255,255,255,0.8)', fontWeight: '700' }]}>
            {subjects.length} subject{subjects.length === 1 ? '' : 's'} · {docs.length} note{docs.length === 1 ? '' : 's'} · {device.toUpperCase()}
          </Text>
        </View>
        {ai !== 'ready' ? (
          <View style={[s.chip, s.chipOnline, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
            <ActivityIndicator size="small" color="#FFFFFF" />
            <Text style={s.chipText}>AI warming up</Text>
          </View>
        ) : (
          <View style={[s.chip, online === false ? s.chipOffline : s.chipOnline]}>
            <Text style={s.chipText}>
              {online === false ? '✈ Offline · on-device AI' : '● On-device AI'}
            </Text>
          </View>
        )}
      </View>

      {ocrMissing && !justDownloaded && tab === 'notes' && (
        <Text style={[s.small, { paddingHorizontal: 16, paddingTop: 8 }]}>
          Photo reading (OCR) isn't downloaded yet. It downloads when you first tap "Snap notes".
        </Text>
      )}
      {justDownloaded && (
        <Pressable style={s.banner} onPress={() => setJustDownloaded(false)}>
          <Text style={s.bannerText}>✅ All set! Models are on your phone. You can switch on airplane mode now. (tap to dismiss)</Text>
        </Pressable>
      )}

      <View style={{ flex: 1 }}>
        {tab === 'notes' && (
          <ScrollView contentContainerStyle={s.pad}>
            <View style={s.actions}>
              <ActionBtn icon="📄" label="Import PDF / text" onPress={importFile} disabled={!!busy} />
              <ActionBtn icon="📷" label="Snap notes" onPress={snapNotes} disabled={!!busy} />
              <ActionBtn icon="📋" label="Paste text" onPress={() => setEditor({ mode: 'paste', title: '', text: '', subject: subjects[0] ?? '' })} disabled={!!busy} />
            </View>
            {docs.length === 0 ? (
              <View style={s.card}>
                <Text style={s.h2}>No notes yet</Text>
                <Text style={s.body}>Import a PDF or text file, snap a photo of a handout, or paste text. Everything is processed and stored only on this phone.</Text>
                <Pressable style={s.btnGhost} onPress={addSample} disabled={!!busy}>
                  <Text style={s.btnGhostText}>Try sample biology notes</Text>
                </Pressable>
              </View>
            ) : (
              subjects.map((sub) => (
                <View key={sub} style={{ marginTop: 16 }}>
                  <Text style={s.groupHead}>{sub}</Text>
                  {docs.filter((d) => subjectOf(d) === sub).map((d) => (
                    <Pressable key={d.id} style={s.docRow} onPress={() => moveDoc(d)}>
                      <Text style={s.docIcon}>{d.kind === 'pdf' ? '📄' : d.kind === 'pasted' ? '📋' : '📝'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={s.docName} numberOfLines={2}>{d.name}</Text>
                        <Text style={s.small}>{d.chunkCount} passages · tap to change subject</Text>
                      </View>
                      <Pressable
                        hitSlop={10}
                        onPress={() =>
                          Alert.alert('Remove notes?', d.name, [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Remove', style: 'destructive', onPress: async () => { await removeDoc(d.id); await refreshLibrary(); } },
                          ])
                        }
                      >
                        <Text style={s.del}>✕</Text>
                      </Pressable>
                    </Pressable>
                  ))}
                </View>
              ))
            )}
            <View style={[s.card, { marginTop: 18 }]}>
              <Text style={s.h3}>Privacy & offline</Text>
              <Text style={s.small}>
                Notes, embeddings and answers never leave this phone. The models ({MODELS.map((m) => m.label).join(', ')} and QVAC OCR) run locally through
                Tether's QVAC SDK. Internet is only used once, to download the models. If answers feel slow, try GPU.
              </Text>
              <View style={s.segment}>
                <Text style={[s.small, { marginRight: 8 }]}>Compute:</Text>
                {(['cpu', 'gpu'] as Device[]).map((d) => (
                  <Pressable key={d} onPress={() => switchDevice(d)} style={[s.segBtn, device === d && s.segBtnOn]}>
                    <Text style={[s.segText, device === d && s.segTextOn]}>{d.toUpperCase()}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={s.segment}>
                <Text style={[s.small, { marginRight: 8 }]}>Theme:</Text>
                {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
                  <Pressable key={t} onPress={() => chooseTheme(t)} style={[s.segBtn, themePref === t && s.segBtnOn]}>
                    <Text style={[s.segText, themePref === t && s.segTextOn]}>{t === 'system' ? 'Auto' : t === 'light' ? '☀ Light' : '☾ Dark'}</Text>
                  </Pressable>
                ))}
              </View>
              {docs.length > 0 && (
                <Pressable
                  onPress={() =>
                    Alert.alert('Delete all notes?', 'This removes every imported note from this phone.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete all', style: 'destructive', onPress: async () => { await clearAll(); await refreshLibrary(); setQas([]); setQuiz([]); } },
                    ])
                  }
                >
                  <Text style={[s.small, { color: C.danger, marginTop: 10 }]}>Delete all notes</Text>
                </Pressable>
              )}
            </View>
            <Credit />
          </ScrollView>
        )}

        {tab === 'ask' && (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            {subjects.length > 0 && <SubjectChips subjects={subjects} value={scopeValid} onChange={setScope} />}
            {qas.length > 0 && !busy && !generating && (
              <View style={s.histBar}>
                <Text style={s.small}>{qas.length} saved question{qas.length === 1 ? '' : 's'} · hold one to delete it</Text>
                <Pressable onPress={() => confirmClear('chat')} hitSlop={8}>
                  <Text style={s.clearLink}>Clear all</Text>
                </Pressable>
              </View>
            )}
            <FlatList
              ref={listRef}
              data={qas}
              keyExtractor={(x) => x.id}
              contentContainerStyle={s.pad}
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
              ListEmptyComponent={
                <View style={s.card}>
                  <Text style={s.h2}>Ask your notes</Text>
                  <Text style={s.body}>
                    Pick a subject above, or leave it on Auto and the tutor finds the right subject for each question. Answers never mix subjects. Tap Shorter or Reply under any answer to follow up.
                  </Text>
                  {chunks.length > 0 &&
                    ['Summarise the main ideas', 'What are the key definitions?'].map((ex) => (
                      <Pressable key={ex} onPress={() => setQuestion(ex)} style={s.suggest}>
                        <Text style={s.suggestText}>{ex}</Text>
                      </Pressable>
                    ))}
                </View>
              }
              keyboardShouldPersistTaps="handled"
              extraData={`${themeKey}${busy}${generating}`}
              renderItem={({ item }) => (
                <QACard
                  theme={themeKey}
                  qa={item}
                  onLongPress={deleteQa}
                  onShorter={busy || generating ? undefined : (qa) => followUp(qa, SHORTER)}
                  onReply={busy || generating ? undefined : setReplyTo}
                />
              )}
            />
            {replyTo && (
              <View style={s.replyBar}>
                <Text style={s.small} numberOfLines={1}>
                  ↩ Replying to: <Text style={{ fontWeight: '700', color: C.text }}>{replyTo.question}</Text>
                </Text>
                <Pressable onPress={() => setReplyTo(null)} hitSlop={10}>
                  <Text style={s.del}>✕</Text>
                </Pressable>
              </View>
            )}
            <View style={s.inputRow}>
              <TextInput
                style={s.input}
                value={question}
                onChangeText={setQuestion}
                placeholder={replyTo ? 'Reply to that answer…' : chunks.length ? 'Ask about your notes…' : 'Add notes first'}
                placeholderTextColor={C.muted}
                editable={!busy && !generating}
                multiline
                onSubmitEditing={ask}
                returnKeyType="send"
                blurOnSubmit
              />
              {generating ? (
                <Pressable style={[s.send, { backgroundColor: C.danger }]} onPress={stopGenerating}>
                  <Text style={s.sendText}>Stop</Text>
                </Pressable>
              ) : (
                <Pressable style={[s.send, (!question.trim() || !!busy) && s.btnDisabled]} disabled={!question.trim() || !!busy} onPress={ask}>
                  <Text style={s.sendText}>Ask</Text>
                </Pressable>
              )}
            </View>
          </KeyboardAvoidingView>
        )}

        {tab === 'quiz' && (
          <ScrollView contentContainerStyle={s.pad}>
            {subjects.length > 1 && <SubjectChips subjects={subjects} value={scopeValid} onChange={setScope} autoLabel="All" inline />}
            <Pressable style={[s.btn, (!!busy || !chunks.length) && s.btnDisabled]} disabled={!!busy || !chunks.length} onPress={makeQuiz}>
              <Text style={s.btnText}>{quiz.length ? '🔄 New quiz' : '🧠 Quiz me'}</Text>
            </Pressable>
            {quiz.length > 0 && !busy && (
              <Pressable onPress={() => confirmClear('quiz')} hitSlop={8} style={{ alignSelf: 'center', marginTop: 10 }}>
                <Text style={s.clearLink}>Clear quiz</Text>
              </Pressable>
            )}
            {!quiz.length && !busy && (
              <Text style={[s.small, { textAlign: 'center', marginTop: 12 }]}>
                {chunks.length ? `Generates 4 questions from ${scopeValid === AUTO ? 'all your notes' : scopeValid}.` : 'Add notes first.'}
              </Text>
            )}
            {quiz.map((q, i) => (
              <View key={q.id} style={s.card}>
                <Text style={s.qNum}>Question {i + 1}</Text>
                <Text style={s.qText}>{q.question}</Text>
                {q.revealed ? (
                  <>
                    <Text style={s.answerLabel}>Answer</Text>
                    <Text style={s.body}>{q.answer}</Text>
                    <SourceCard n={i + 1} docName={q.docName} page={q.source.page} text={q.source.text} />
                  </>
                ) : (
                  <Pressable style={s.btnGhost} onPress={() => setQuiz((prev) => prev.map((x) => (x.id === q.id ? { ...x, revealed: true } : x)))}>
                    <Text style={s.btnGhostText}>Show answer</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </ScrollView>
        )}
      </View>

      {busy && (
        <View style={s.busy}>
          <ActivityIndicator color="#fff" />
          <Text style={s.busyText}>{busy}</Text>
        </View>
      )}

      <View style={s.tabs}>
        {(
          [
            ['notes', '📚', 'Notes'],
            ['ask', '💬', 'Ask'],
            ['quiz', '🧠', 'Quiz'],
          ] as [Tab, string, string][]
        ).map(([k, icon, label]) => (
          <Pressable key={k} style={s.tab} onPress={() => setTab(k)}>
            <Text style={[s.tabIcon, tab !== k && { opacity: 0.45 }]}>{icon}</Text>
            <Text style={[s.tabLabel, tab === k && s.tabLabelOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Modal visible={!!editor} animationType="slide" onRequestClose={() => setEditor(null)}>
        <SafeAreaView style={s.safe}>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={[s.header, { backgroundColor: C.card, borderBottomWidth: 2, borderBottomColor: C.border }]}>
              <Text style={[s.headerTitle, { flex: 1, color: C.text }]}>{editor?.mode === 'ocr' ? 'Check snapped text' : 'Paste notes'}</Text>
              <Pressable onPress={() => setEditor(null)} hitSlop={10}>
                <Text style={s.del}>✕</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
              {editor?.mode === 'ocr' && editor.ocr && (
                <View style={[s.hint, editor.ocr.avgConfidence < 0.75 || editor.ocr.lowConfidenceLines.length ? s.hintWarn : s.hintOk]}>
                  <Text style={s.hintText}>
                    {editor.ocr.avgConfidence < 0.75 || editor.ocr.lowConfidenceLines.length
                      ? `⚠️ The OCR wasn't sure about ${editor.ocr.lowConfidenceLines.length || 'some'} of ${editor.ocr.lineCount} lines (confidence ${Math.round(editor.ocr.avgConfidence * 100)}%). Please check and fix the text below before saving. Handwriting is best effort.`
                      : `✓ Text read with good confidence (${Math.round(editor.ocr.avgConfidence * 100)}%). You can still edit it before saving.`}
                  </Text>
                  {editor.ocr.lowConfidenceLines.slice(0, 5).map((l, i) => (
                    <Text key={i} style={s.lowLine} numberOfLines={1}>• {l}</Text>
                  ))}
                </View>
              )}
              <Text style={s.label}>Title</Text>
              <TextInput
                style={s.field}
                value={editor?.title ?? ''}
                onChangeText={(t) => setEditor((e) => (e ? { ...e, title: t } : e))}
                placeholder="e.g. Week 3 — Cell biology"
                placeholderTextColor={C.muted}
              />
              <Text style={s.label}>Subject</Text>
              <SubjectSelect subjects={subjects} value={editor?.subject ?? ''} onChange={(v) => setEditor((e) => (e ? { ...e, subject: v } : e))} />
              <Text style={s.label}>Text</Text>
              <TextInput
                style={[s.field, s.area]}
                value={editor?.text ?? ''}
                onChangeText={(t) => setEditor((e) => (e ? { ...e, text: t } : e))}
                placeholder="Paste or type your notes here…"
                placeholderTextColor={C.muted}
                multiline
                textAlignVertical="top"
              />
              <Pressable style={s.btn} onPress={saveEditor}>
                <Text style={s.btnText}>Save & index on-device</Text>
              </Pressable>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      <Modal visible={!!picker} transparent animationType="fade" onRequestClose={() => closePicker(null)}>
        <Pressable style={s.scrim} onPress={() => closePicker(null)}>
          <Pressable style={s.sheet} onPress={() => {}}>
            <Text style={s.h2}>{picker?.title}</Text>
            <SubjectSelect subjects={subjects} value={picker?.value ?? ''} onChange={(v) => setPicker((p) => (p ? { ...p, value: v } : p))} />
            <Pressable style={s.btn} onPress={() => closePicker(picker?.value ?? '')}>
              <Text style={s.btnText}>Continue</Text>
            </Pressable>
            <Pressable style={{ alignItems: 'center', marginTop: 12 }} onPress={() => closePicker(null)} hitSlop={8}>
              <Text style={[s.small, { fontWeight: '600' }]}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <PdfExtractor ref={pdf} />
    </SafeAreaView>
  );
}

function BrandMark() {
  return (
    <View style={s.brand}>
      <Text style={s.brandText}>O</Text>
      <View style={s.brandDot} />
    </View>
  );
}

function Credit({ dark }: { dark?: boolean }) {
  return (
    <View style={{ alignItems: 'center', marginTop: 28, marginBottom: 8 }}>
      <Text style={[s.credit, dark && { color: '#C7D2FE' }]}>
        Created by <Text style={{ fontWeight: '800', color: dark ? '#FFFFFF' : C.primary }}>Avie</Text>
      </Text>
      <Text style={[s.creditSub, dark && { color: '#7C86B2' }]}>Powered by Tether QVAC · 100% on-device</Text>
    </View>
  );
}

function SubjectChips({
  subjects,
  value,
  onChange,
  autoLabel = 'Auto',
  inline,
}: {
  subjects: string[];
  value: string;
  onChange: (v: string) => void;
  autoLabel?: string;
  inline?: boolean;
}) {
  return (
    <View style={inline ? undefined : s.chipBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: inline ? 0 : 16, paddingVertical: inline ? 0 : 10 }}>
        {[AUTO, ...subjects].map((sub, i) => {
          const on = value === sub;
          const [face, edge] = sub === AUTO ? [C.primary, C.primaryDeep] : CANDY[(i - 1) % CANDY.length];
          return (
            <Pressable key={sub} onPress={() => onChange(sub)} style={({ pressed }) => [s.pill, on && { backgroundColor: face, borderColor: edge }, pressed && { transform: [{ translateY: 2 }], borderBottomWidth: 2 }]}>
              <Text style={[s.pillText, on && s.pillTextOn]}>{sub === AUTO ? (autoLabel === 'Auto' ? '✨ Auto' : autoLabel) : sub}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function SubjectSelect({ subjects, value, onChange }: { subjects: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <View>
      {subjects.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {subjects.map((sub) => (
            <Pressable key={sub} onPress={() => onChange(sub)} style={[s.pill, value === sub && s.pillOn]}>
              <Text style={[s.pillText, value === sub && s.pillTextOn]}>{sub}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <TextInput
        style={s.field}
        value={value}
        onChangeText={onChange}
        placeholder={subjects.length ? 'Or type a new subject' : 'e.g. Biology, Economics, Maths'}
        placeholderTextColor={C.muted}
        autoCapitalize="words"
      />
    </View>
  );
}

function groupView(keys: ModelKey[], dl: Partial<Record<ModelKey, DlState>>) {
  let total = 0;
  let got = 0;
  let allDone = true;
  let active: DlState | undefined;
  let err: string | undefined;
  for (const k of keys) {
    const sz = specOf(k).expectedSize;
    const st = dl[k];
    total += sz;
    got += st?.status === 'done' ? sz : Math.min(st?.downloaded ?? 0, sz);
    if (st?.status !== 'done') allDone = false;
    if (st && ['downloading', 'waiting', 'verifying', 'checking'].includes(st.status)) active = st;
    if (st?.status === 'paused' && st.error) err = st.error;
  }
  const mb = (n: number) => (n / 1e6).toFixed(0);
  const pct = total ? Math.floor((got / total) * 100) : 0;
  let line = '';
  if (allDone) line = 'on your phone';
  else if (active?.status === 'waiting') line = active.note ?? 'retrying…';
  else if (active?.status === 'verifying') line = 'checking file…';
  else if (active?.status === 'downloading') line = `${pct}%${active.source === 'registry' ? ' · QVAC registry' : ''}${active.note ? ' · ' + active.note : ''}`;
  else if (got > 0) line = `paused at ${pct}%`;
  return {
    done: allDone,
    pct: allDone ? 100 : pct,
    sizeText: got > 0 && !allDone ? `${mb(got)} / ${mb(total)} MB` : `~${mb(total)} MB`,
    line,
    error: active?.status === 'waiting' ? active.error : err,
  };
}

function hasProgress(dl: Partial<Record<ModelKey, DlState>>) {
  return Object.values(dl).some((st) => st && (st.status === 'done' || st.downloaded > 0 || st.status === 'paused'));
}

function ActionBtn({ icon, label, onPress, disabled }: { icon: string; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[s.action, disabled && s.btnDisabled]} onPress={onPress} disabled={disabled}>
      <Text style={s.actionIcon}>{icon}</Text>
      <Text style={s.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function SourceCard({ n, docName, page, text }: { n: number; docName: string; page?: number; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable style={s.source} onPress={() => setOpen((o) => !o)}>
      <Text style={s.sourceHead}>
        From your notes: {docName}
        {page ? ` · p.${page}` : ''}
      </Text>
      <Text style={s.sourceText} numberOfLines={open ? undefined : 4}>
        “{text}”
      </Text>
    </Pressable>
  );
}

const QACard = memo(function QACard({
  qa,
  onLongPress,
  onShorter,
  onReply,
}: {
  qa: QA;
  theme?: string;
  onLongPress?: (id: string) => void;
  onShorter?: (qa: QA) => void;
  onReply?: (qa: QA) => void;
}) {
  const answered = qa.done && !!qa.answer && qa.answer !== NOT_FOUND && qa.hits.length > 0;
  const [showSrc, setShowSrc] = useState(false);
  return (
    <Pressable style={{ marginBottom: 14 }} onLongPress={() => qa.done && onLongPress?.(qa.id)} delayLongPress={450}>
      {qa.replyTo ? (
        <Text style={[s.small, { alignSelf: 'flex-end', marginBottom: 4 }]} numberOfLines={1}>
          ↩ {qa.replyTo.question}
        </Text>
      ) : null}
      <View style={s.qBubble}>
        <Text style={s.qBubbleText}>{qa.question}</Text>
      </View>
      <View style={s.aBubble}>
        {qa.subject && !qa.replyTo ? <Text style={s.fromTag}>{qa.subject}</Text> : null}
        {qa.answer ? (
          <Text style={s.body}>{qa.answer}</Text>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator color={C.primary} size="small" />
            <Text style={s.small}>{qa.hits.length ? 'Writing answer…' : 'Searching your notes…'}</Text>
          </View>
        )}
        {answered && (onShorter || onReply) ? (
          <View style={s.qaActions}>
            {onShorter && (
              <Pressable style={s.qaAction} onPress={() => onShorter(qa)} hitSlop={6}>
                <Text style={s.qaActionText}>✂ Shorter</Text>
              </Pressable>
            )}
            {onReply && (
              <Pressable style={s.qaAction} onPress={() => onReply(qa)} hitSlop={6}>
                <Text style={s.qaActionText}>↩ Reply</Text>
              </Pressable>
            )}
            <Pressable style={s.qaAction} onPress={() => setShowSrc((x) => !x)} hitSlop={6}>
              <Text style={s.qaActionText}>{showSrc ? 'Hide' : 'Where from?'}</Text>
            </Pressable>
            {qa.ms ? <Text style={[s.meta, { marginTop: 0, marginLeft: 'auto' }]}>{(qa.ms / 1000).toFixed(1)}s</Text> : null}
          </View>
        ) : null}
        {answered && showSrc && (
          <>
            {qa.hits
              .filter((h, i, a) => a.findIndex((x) => x.chunk.docId === h.chunk.docId) === i)
              .slice(0, 3)
              .map((h, i) => (
                <SourceCard key={h.chunk.docId + i} n={i + 1} docName={h.docName} page={h.chunk.page} text={h.chunk.text} />
              ))}
          </>
        )}
      </View>
    </Pressable>
  );
});

let applied = 'light';
function applyTheme(dark: boolean) {
  Object.assign(C, dark ? DARK : LIGHT);
  s = makeStyles();
  applied = dark ? 'dark' : 'light';
}

const makeStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  hero: { backgroundColor: '#2B0B5E' },
  setup: { padding: 22, paddingTop: 56, flexGrow: 1 },
  brand: { width: 84, height: 84, borderRadius: 28, backgroundColor: '#FF4FA3', alignSelf: 'center', alignItems: 'center', justifyContent: 'center', borderBottomWidth: 6, borderBottomColor: '#C81E74', transform: [{ rotate: '-6deg' }] },
  brandText: { color: '#fff', fontSize: 44, fontWeight: '900', letterSpacing: -1, textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 3 }, textShadowRadius: 0 },
  brandDot: { position: 'absolute', right: 12, top: 10, width: 16, height: 9, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.6)', transform: [{ rotate: '-25deg' }] },
  title: { fontSize: 36, fontWeight: '900', color: '#FFFFFF', textAlign: 'center', marginTop: 20, letterSpacing: -0.5, textShadowColor: '#C81E74', textShadowOffset: { width: 0, height: 4 }, textShadowRadius: 0 },
  tagline: { fontSize: 17, fontWeight: '800', color: '#FFC83D', textAlign: 'center', marginTop: 8 },
  sub: { fontSize: 14.5, color: '#E3CCFF', textAlign: 'center', marginTop: 10, marginBottom: 20, lineHeight: 21, paddingHorizontal: 8 },
  heroSmall: { fontSize: 13.5, color: '#E3CCFF', textAlign: 'center' },
  credit: { fontSize: 13, color: C.muted },
  creditSub: { fontSize: 11, color: C.muted, marginTop: 3, opacity: 0.8 },
  chipBar: { borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.card },
  pill: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 22, backgroundColor: C.card, borderWidth: 2, borderColor: C.border, borderBottomWidth: 4, marginBottom: 4 },
  pillOn: { backgroundColor: C.primary, borderColor: C.primaryDeep },
  pillText: { fontSize: 13.5, fontWeight: '800', color: C.text },
  pillTextOn: { color: '#fff' },
  groupHead: { fontSize: 12, fontWeight: '800', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.8 },
  fromTag: { alignSelf: 'flex-start', fontSize: 11.5, fontWeight: '800', color: '#fff', backgroundColor: C.pink, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, marginBottom: 8, overflow: 'hidden' },
  replyBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.primarySoft, borderTopWidth: 1, borderTopColor: C.border },
  qaActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  qaAction: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: C.primarySoft, borderBottomWidth: 3, borderBottomColor: C.border },
  qaActionText: { fontSize: 12.5, fontWeight: '800', color: C.primary },
  histBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 },
  clearLink: { fontSize: 13, fontWeight: '700', color: C.danger },
  moreLink: { fontSize: 12.5, fontWeight: '700', color: C.primary, marginTop: 8 },
  scrim: { flex: 1, backgroundColor: 'rgba(14,19,48,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 28 },
  card: { backgroundColor: C.card, borderRadius: 24, padding: 18, marginTop: 14, borderWidth: 2, borderColor: C.border, borderBottomWidth: 5 },
  h2: { fontSize: 19, fontWeight: '900', color: C.text, marginBottom: 6 },
  h3: { fontSize: 15.5, fontWeight: '800', color: C.text, marginBottom: 4 },
  body: { fontSize: 15, color: C.text, lineHeight: 22 },
  small: { fontSize: 12.5, color: C.muted, lineHeight: 18 },
  warn: { color: C.danger, marginTop: 10, fontSize: 13 },
  modelRow: { marginTop: 14 },
  modelName: { fontSize: 14, fontWeight: '600', color: C.text },
  bar: { height: 12, backgroundColor: C.track, borderRadius: 6, overflow: 'hidden', marginTop: 6 },
  barFill: { height: '100%', backgroundColor: C.pink, borderRadius: 6 },
  btn: { backgroundColor: C.pink, borderRadius: 22, paddingVertical: 15, alignItems: 'center', marginTop: 16, borderBottomWidth: 5, borderBottomColor: C.pinkDeep },
  btnText: { color: '#fff', fontWeight: '900', fontSize: 17, letterSpacing: 0.3 },
  btnDisabled: { opacity: 0.45 },
  btnGhost: { borderWidth: 2, borderColor: C.primary, borderBottomWidth: 4, borderRadius: 22, paddingVertical: 11, alignItems: 'center', marginTop: 12, backgroundColor: C.card },
  btnGhostText: { color: C.primary, fontWeight: '900', fontSize: 15 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: C.header, borderBottomLeftRadius: 22, borderBottomRightRadius: 22 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: '#FFFFFF' },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  chipOnline: { backgroundColor: 'rgba(255,255,255,0.18)' },
  chipOffline: { backgroundColor: '#2ECC71' },
  chipText: { fontSize: 12, fontWeight: '800', color: '#FFFFFF' },
  banner: { backgroundColor: C.ok, padding: 12 },
  bannerText: { color: C.okText, fontWeight: '600', fontSize: 13 },
  pad: { padding: 16, paddingBottom: 30 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, backgroundColor: C.card, borderRadius: 22, paddingVertical: 16, alignItems: 'center', borderWidth: 2, borderColor: C.border, borderBottomWidth: 5 },
  actionIcon: { fontSize: 28 },
  actionLabel: { fontSize: 12.5, fontWeight: '800', color: C.text, marginTop: 4, textAlign: 'center' },
  docRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 20, padding: 14, marginTop: 10, borderWidth: 2, borderColor: C.border, borderBottomWidth: 4 },
  docIcon: { fontSize: 22, marginRight: 12 },
  docName: { fontSize: 15, fontWeight: '800', color: C.text },
  del: { fontSize: 18, color: C.muted, paddingHorizontal: 6 },
  segment: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  segBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, borderWidth: 2, borderColor: C.border, borderBottomWidth: 4, marginRight: 8 },
  segBtnOn: { backgroundColor: C.primary, borderColor: C.primaryDeep },
  segText: { fontSize: 12.5, fontWeight: '800', color: C.muted },
  segTextOn: { color: '#fff' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card, gap: 8 },
  input: { flex: 1, maxHeight: 110, backgroundColor: C.bg, borderRadius: 22, borderWidth: 2, borderColor: C.border, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: C.text },
  send: { backgroundColor: C.pink, borderRadius: 22, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 4, borderBottomColor: C.pinkDeep },
  sendText: { color: '#fff', fontWeight: '900' },
  suggest: { backgroundColor: C.primarySoft, borderRadius: 18, padding: 12, marginTop: 10, borderBottomWidth: 3, borderBottomColor: C.border },
  suggestText: { color: C.primary, fontWeight: '800' },
  qBubble: { alignSelf: 'flex-end', backgroundColor: C.primary, borderRadius: 22, borderBottomRightRadius: 6, borderBottomWidth: 4, borderBottomColor: C.primaryDeep, padding: 12, maxWidth: '88%' },
  qBubbleText: { color: '#fff', fontSize: 15, lineHeight: 21, fontWeight: '600' },
  aBubble: { alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 22, borderBottomLeftRadius: 6, padding: 16, marginTop: 8, borderWidth: 2, borderColor: C.border, borderBottomWidth: 5 },
  sourcesLabel: { fontSize: 12, fontWeight: '700', color: C.muted, marginTop: 14, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  source: { backgroundColor: C.quote, borderLeftWidth: 5, borderLeftColor: C.accent, borderRadius: 14, padding: 10, marginTop: 8 },
  sourceHead: { fontSize: 12, fontWeight: '700', color: C.accentText, marginBottom: 4 },
  sourceText: { fontSize: 13, color: C.text, lineHeight: 19, fontStyle: 'italic' },
  meta: { fontSize: 11, color: C.muted, marginTop: 10 },
  qNum: { fontSize: 12, fontWeight: '900', color: C.pink, textTransform: 'uppercase', letterSpacing: 0.5 },
  qText: { fontSize: 18, fontWeight: '800', color: C.text, marginTop: 6, lineHeight: 24 },
  answerLabel: { fontSize: 12, fontWeight: '700', color: C.muted, marginTop: 14, marginBottom: 4, textTransform: 'uppercase' },
  busy: { position: 'absolute', left: 16, right: 16, bottom: 78, backgroundColor: 'rgba(59,15,120,0.95)', borderRadius: 20, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  busyText: { color: '#fff', fontSize: 14, flex: 1 },
  tabs: { flexDirection: 'row', borderTopWidth: 2, borderTopColor: C.border, backgroundColor: C.card, paddingBottom: 6, paddingTop: 2, borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  tabIcon: { fontSize: 24 },
  tabLabel: { fontSize: 12, color: C.muted, marginTop: 2, fontWeight: '800' },
  tabLabelOn: { color: C.pink },
  hint: { borderRadius: 12, padding: 12, marginBottom: 6 },
  hintWarn: { backgroundColor: C.warnBg },
  hintOk: { backgroundColor: C.ok },
  hintText: { fontSize: 13.5, color: C.text, lineHeight: 19 },
  lowLine: { fontSize: 12.5, color: C.warnText, marginTop: 4 },
  label: { fontSize: 13, fontWeight: '700', color: C.muted, marginTop: 14, marginBottom: 6 },
  field: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, fontSize: 15, color: C.text },
  area: { minHeight: 260 },
});
let s = makeStyles();
