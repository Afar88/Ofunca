import React, { useCallback, useEffect, useRef, useState } from 'react';
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
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system/legacy';
import NetInfo from '@react-native-community/netinfo';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { C } from './src/theme';
import { PdfExtractor, type PdfExtractorHandle } from './src/pdf/PdfExtractor';
import { chunkPages, chunkText, type RawChunk } from './src/chunk';
import { addDoc, clearAll, loadDB, makeId, removeDoc, roundVec, type NoteDoc, type StoredChunk } from './src/store';
import {
  MODELS,
  MODEL_GROUPS,
  MODEL_SPECS,
  downloadModels,
  embedDocuments,
  embedQuery,
  generate,
  importPickedModel,
  isReady,
  loadModels,
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
  ONE_QUESTION_SCHEMA,
  buildAnswerPrompt,
  buildOneQuestionPrompt,
  parseOneQuestion,
  pickQuizExcerpts,
  search,
  type Hit,
} from './src/rag';
import { SAMPLE_NOTES, SAMPLE_TITLE } from './src/sample';

type Tab = 'notes' | 'ask' | 'quiz';
type Phase = 'checking' | 'needDownload' | 'downloading' | 'loading' | 'ready' | 'error';
type QA = { id: string; question: string; answer: string; hits: Hit[]; done: boolean; ms?: number };
type QuizCard = { id: string; question: string; answer: string; source: StoredChunk; docName: string; revealed: boolean };

const SETTINGS_FILE = (FS.documentDirectory ?? '') + 'study-tutor-settings.json';

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
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

  const bootModels = useCallback(async (dev: Device) => {
    try {
      setPhase('loading');
      await loadModels(dev, setPhaseMsg);
      setPhase('ready');
    } catch (e: any) {
      setPhase('error');
      setPhaseMsg(e?.message ?? String(e));
    }
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
      let dev: Device = 'cpu';
      try {
        const s = JSON.parse(await FS.readAsStringAsync(SETTINGS_FILE));
        if (s.device === 'gpu' || s.device === 'cpu') dev = s.device;
      } catch {}
      setDevice(dev);
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
    await FS.writeAsStringAsync(SETTINGS_FILE, JSON.stringify({ device: dev })).catch(() => {});
    await bootModels(dev);
  }

  // ---------- Indexing ----------
  async function indexDoc(name: string, kind: NoteDoc['kind'], raw: RawChunk[]) {
    if (!raw.length) throw new Error('No readable text found.');
    const vecs = await embedDocuments(
      raw.map((c) => c.text),
      (d, t) => setBusy(`Indexing on-device… ${d}/${t}`),
    );
    const docId = makeId('d');
    const stored: StoredChunk[] = raw.map((c, i) => ({ id: makeId('c'), docId, page: c.page, text: c.text, vec: roundVec(vecs[i]) }));
    await addDoc(
      { id: docId, name, kind, addedAt: Date.now(), chunkCount: stored.length, charCount: raw.reduce((s, c) => s + c.text.length, 0) },
      stored,
    );
    await refreshLibrary();
  }

  async function guarded(label: string, fn: () => Promise<void>) {
    if (busy) return;
    if (!isReady()) {
      Alert.alert('Models not ready', 'Please wait for the AI models to finish loading.');
      return;
    }
    setBusy(label);
    try {
      await fn();
    } catch (e: any) {
      Alert.alert('Something went wrong', e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
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
      await indexDoc(f.name.replace(/\.(pdf|txt|md)$/i, ''), isPdf ? 'pdf' : 'text', raw);
      FS.deleteAsync(f.uri, { idempotent: true }).catch(() => {});
    });
  }

  // ---------- Paste & Snap modals ----------
  const [editor, setEditor] = useState<null | { mode: 'paste' | 'ocr'; title: string; text: string; ocr?: OcrResult }>(null);

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
      setEditor({ mode: 'ocr', title: 'Snapped notes ' + new Date().toLocaleDateString(), text: r.text, ocr: r });
    });
  }

  async function saveEditor() {
    if (!editor) return;
    const { title, text, mode } = editor;
    if (text.trim().length < 30) {
      Alert.alert('Too short', 'Add a bit more text (at least a couple of sentences).');
      return;
    }
    setEditor(null);
    await guarded('Indexing…', async () => {
      await indexDoc(title.trim() || 'Pasted notes', mode === 'ocr' ? 'text' : 'pasted', chunkText(text));
    });
  }

  async function addSample() {
    await guarded('Adding sample notes…', async () => {
      await indexDoc(SAMPLE_TITLE, 'text', chunkText(SAMPLE_NOTES));
    });
  }

  // ---------- Ask ----------
  const [qas, setQas] = useState<QA[]>([]);
  const [question, setQuestion] = useState('');
  const listRef = useRef<FlatList<QA>>(null);

  async function ask() {
    const q = question.trim();
    if (!q) return;
    if (!chunks.length) {
      Alert.alert('No notes yet', 'Import some notes first (or add the sample notes).');
      return;
    }
    setQuestion('');
    const id = makeId('q');
    const t0 = Date.now();
    await guarded('Thinking…', async () => {
      setQas((prev) => [...prev, { id, question: q, answer: '', hits: [], done: false }]);
      const qv = await embedQuery(q);
      const hits = search(qv, q, chunks, docNames, 3);
      setQas((prev) => prev.map((x) => (x.id === id ? { ...x, hits } : x)));
      const best = hits[0]?.score ?? 0;
      let answer: string;
      if (best < 0.22) { // off-topic questions score ~0.18 with EmbeddingGemma; on-topic ≥0.3
        answer = NOT_FOUND;
        setQas((prev) => prev.map((x) => (x.id === id ? { ...x, answer } : x)));
      } else {
        answer = cleanAnswer(
          await generate(buildAnswerPrompt(q, hits), (txt) =>
            setQas((prev) => prev.map((x) => (x.id === id ? { ...x, answer: cleanAnswer(txt) } : x))),
          ),
        );
      }
      if (answer.replace(/[^a-z0-9]/gi, '').length < 3) {
        // Rare empty reply from the small model: fall back to the best passage, clearly labelled.
        answer = `Here is the most relevant part of your notes [1]:\n“${hits[0]?.chunk.text.slice(0, 400) ?? ''}”`;
      }
      const notFound = answer.toLowerCase().includes("couldn't find that in your notes");
      setQas((prev) =>
        prev.map((x) => (x.id === id ? { ...x, answer: answer || NOT_FOUND, hits: notFound ? [] : hits, done: true, ms: Date.now() - t0 } : x)),
      );
    });
    setQas((prev) => prev.map((x) => (x.id === id ? { ...x, done: true } : x)));
  }

  // ---------- Quiz ----------
  const [quiz, setQuiz] = useState<QuizCard[]>([]);

  async function makeQuiz() {
    if (!chunks.length) {
      Alert.alert('No notes yet', 'Import some notes first (or add the sample notes).');
      return;
    }
    setQuiz([]);
    await guarded('Writing quiz…', async () => {
      const excerpts = pickQuizExcerpts(chunks, 4);
      const asked: string[] = [];
      for (let i = 0; i < excerpts.length; i++) {
        setBusy(`Writing question ${i + 1} of ${excerpts.length}…`);
        const raw = await generate(buildOneQuestionPrompt(excerpts[i].text, asked), () => {}, {
          maxTokens: 160,
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
    });
  }

  // ---------- Render ----------
  if (phase !== 'ready') {
    return (
      <SafeAreaView style={s.safe}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={s.setup}>
          <Text style={s.logo}>📘</Text>
          <Text style={s.title}>Offline Study Tutor</Text>
          <Text style={s.sub}>Ask your class notes anything. Answers come only from your notes, and the AI runs entirely on your phone.</Text>
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
            <View style={[s.card, { alignItems: 'center' }]}>
              <ActivityIndicator color={C.primary} size="large" />
              <Text style={[s.body, { marginTop: 12 }]}>{phaseMsg}</Text>
            </View>
          )}
        </ScrollView>
        <PdfExtractor ref={pdf} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="dark" />
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Study Tutor</Text>
          <Text style={s.small}>
            {docs.length} note{docs.length === 1 ? '' : 's'} · {chunks.length} passages · {device.toUpperCase()}
          </Text>
        </View>
        <View style={[s.chip, online === false ? s.chipOffline : s.chipOnline]}>
          <Text style={[s.chipText, online === false ? { color: C.okText } : null]}>
            {online === false ? '✈ Offline · on-device AI' : '● On-device AI'}
          </Text>
        </View>
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
              <ActionBtn icon="📋" label="Paste text" onPress={() => setEditor({ mode: 'paste', title: '', text: '' })} disabled={!!busy} />
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
              docs.map((d) => (
                <View key={d.id} style={s.docRow}>
                  <Text style={s.docIcon}>{d.kind === 'pdf' ? '📄' : d.kind === 'pasted' ? '📋' : '📝'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.docName} numberOfLines={2}>{d.name}</Text>
                    <Text style={s.small}>{d.chunkCount} passages · {(d.charCount / 1000).toFixed(1)}k chars</Text>
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
                </View>
              ))
            )}
            <View style={[s.card, { marginTop: 18 }]}>
              <Text style={s.h3}>Privacy & offline</Text>
              <Text style={s.small}>
                Notes, embeddings and answers never leave this phone. The models ({MODELS.map((m) => m.label).join(', ')} and QVAC OCR) run locally through
                Tether's QVAC SDK. Internet is only used once, to download the models.
              </Text>
              <View style={s.segment}>
                <Text style={[s.small, { marginRight: 8 }]}>Compute:</Text>
                {(['cpu', 'gpu'] as Device[]).map((d) => (
                  <Pressable key={d} onPress={() => switchDevice(d)} style={[s.segBtn, device === d && s.segBtnOn]}>
                    <Text style={[s.segText, device === d && s.segTextOn]}>{d.toUpperCase()}</Text>
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
          </ScrollView>
        )}

        {tab === 'ask' && (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <FlatList
              ref={listRef}
              data={qas}
              keyExtractor={(x) => x.id}
              contentContainerStyle={s.pad}
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
              ListEmptyComponent={
                <View style={s.card}>
                  <Text style={s.h2}>Ask your notes</Text>
                  <Text style={s.body}>Questions are answered only from your notes, with the exact passages shown as sources.</Text>
                  {chunks.length > 0 &&
                    ['Summarise the main ideas', 'What are the key definitions?'].map((ex) => (
                      <Pressable key={ex} onPress={() => setQuestion(ex)} style={s.suggest}>
                        <Text style={s.suggestText}>{ex}</Text>
                      </Pressable>
                    ))}
                </View>
              }
              renderItem={({ item }) => <QACard qa={item} />}
            />
            <View style={s.inputRow}>
              <TextInput
                style={s.input}
                value={question}
                onChangeText={setQuestion}
                placeholder={chunks.length ? 'Ask about your notes…' : 'Import notes first'}
                placeholderTextColor={C.muted}
                editable={!busy}
                multiline
                onSubmitEditing={ask}
                returnKeyType="send"
                blurOnSubmit
              />
              <Pressable style={[s.send, (!question.trim() || !!busy) && s.btnDisabled]} disabled={!question.trim() || !!busy} onPress={ask}>
                <Text style={s.sendText}>Ask</Text>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        )}

        {tab === 'quiz' && (
          <ScrollView contentContainerStyle={s.pad}>
            <Pressable style={[s.btn, (!!busy || !chunks.length) && s.btnDisabled]} disabled={!!busy || !chunks.length} onPress={makeQuiz}>
              <Text style={s.btnText}>{quiz.length ? '🔄 New quiz' : '🧠 Quiz me'}</Text>
            </Pressable>
            {!quiz.length && !busy && (
              <Text style={[s.small, { textAlign: 'center', marginTop: 12 }]}>
                {chunks.length ? 'Generates 4 questions from different parts of your notes.' : 'Import notes first.'}
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
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={s.header}>
              <Text style={[s.headerTitle, { flex: 1 }]}>{editor?.mode === 'ocr' ? 'Check snapped text' : 'Paste notes'}</Text>
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

      <PdfExtractor ref={pdf} />
    </SafeAreaView>
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
        [{n}] {docName}
        {page ? ` · p.${page}` : ''}
      </Text>
      <Text style={s.sourceText} numberOfLines={open ? undefined : 4}>
        “{text}”
      </Text>
    </Pressable>
  );
}

function QACard({ qa }: { qa: QA }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <View style={s.qBubble}>
        <Text style={s.qBubbleText}>{qa.question}</Text>
      </View>
      <View style={s.aBubble}>
        {qa.answer ? <Text style={s.body}>{qa.answer}</Text> : <ActivityIndicator color={C.primary} />}
        {qa.done && qa.hits.length > 0 && (
          <>
            <Text style={s.sourcesLabel}>Sources from your notes</Text>
            {qa.hits.map((h, i) => (
              <SourceCard key={h.chunk.id} n={i + 1} docName={h.docName} page={h.chunk.page} text={h.chunk.text} />
            ))}
          </>
        )}
        {qa.done && qa.ms ? <Text style={s.meta}>Answered on-device in {(qa.ms / 1000).toFixed(1)}s</Text> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  setup: { padding: 22, paddingTop: 40 },
  logo: { fontSize: 54, textAlign: 'center' },
  title: { fontSize: 26, fontWeight: '800', color: C.text, textAlign: 'center', marginTop: 8 },
  sub: { fontSize: 15, color: C.muted, textAlign: 'center', marginTop: 8, marginBottom: 20, lineHeight: 21 },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, marginTop: 12, borderWidth: 1, borderColor: C.border },
  h2: { fontSize: 18, fontWeight: '700', color: C.text, marginBottom: 6 },
  h3: { fontSize: 15, fontWeight: '700', color: C.text, marginBottom: 4 },
  body: { fontSize: 15, color: C.text, lineHeight: 22 },
  small: { fontSize: 12.5, color: C.muted, lineHeight: 18 },
  warn: { color: C.danger, marginTop: 10, fontSize: 13 },
  modelRow: { marginTop: 14 },
  modelName: { fontSize: 14, fontWeight: '600', color: C.text },
  bar: { height: 8, backgroundColor: C.track, borderRadius: 4, overflow: 'hidden', marginTop: 6 },
  barFill: { height: '100%', backgroundColor: C.primary },
  btn: { backgroundColor: C.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnDisabled: { opacity: 0.45 },
  btnGhost: { borderWidth: 1.5, borderColor: C.primary, borderRadius: 12, paddingVertical: 11, alignItems: 'center', marginTop: 12 },
  btnGhostText: { color: C.primary, fontWeight: '700', fontSize: 15 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.card },
  headerTitle: { fontSize: 20, fontWeight: '800', color: C.text },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  chipOnline: { backgroundColor: C.primarySoft },
  chipOffline: { backgroundColor: C.ok },
  chipText: { fontSize: 12, fontWeight: '700', color: C.primary },
  banner: { backgroundColor: C.ok, padding: 12 },
  bannerText: { color: C.okText, fontWeight: '600', fontSize: 13 },
  pad: { padding: 16, paddingBottom: 30 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, backgroundColor: C.card, borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  actionIcon: { fontSize: 24 },
  actionLabel: { fontSize: 12.5, fontWeight: '600', color: C.text, marginTop: 4, textAlign: 'center' },
  docRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 14, marginTop: 10, borderWidth: 1, borderColor: C.border },
  docIcon: { fontSize: 22, marginRight: 12 },
  docName: { fontSize: 15, fontWeight: '600', color: C.text },
  del: { fontSize: 18, color: C.muted, paddingHorizontal: 6 },
  segment: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  segBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: C.border, marginRight: 8 },
  segBtnOn: { backgroundColor: C.primary, borderColor: C.primary },
  segText: { fontSize: 12, fontWeight: '700', color: C.muted },
  segTextOn: { color: '#fff' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card, gap: 8 },
  input: { flex: 1, maxHeight: 110, backgroundColor: C.bg, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: C.text },
  send: { backgroundColor: C.primary, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12 },
  sendText: { color: '#fff', fontWeight: '700' },
  suggest: { backgroundColor: C.primarySoft, borderRadius: 10, padding: 10, marginTop: 10 },
  suggestText: { color: C.primary, fontWeight: '600' },
  qBubble: { alignSelf: 'flex-end', backgroundColor: C.primary, borderRadius: 16, borderBottomRightRadius: 4, padding: 12, maxWidth: '88%' },
  qBubbleText: { color: '#fff', fontSize: 15, lineHeight: 21 },
  aBubble: { alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 16, borderBottomLeftRadius: 4, padding: 14, marginTop: 8, borderWidth: 1, borderColor: C.border },
  sourcesLabel: { fontSize: 12, fontWeight: '700', color: C.muted, marginTop: 14, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  source: { backgroundColor: C.quote, borderLeftWidth: 3, borderLeftColor: C.accent, borderRadius: 8, padding: 10, marginTop: 8 },
  sourceHead: { fontSize: 12, fontWeight: '700', color: C.accentText, marginBottom: 4 },
  sourceText: { fontSize: 13, color: C.text, lineHeight: 19, fontStyle: 'italic' },
  meta: { fontSize: 11, color: C.muted, marginTop: 10 },
  qNum: { fontSize: 12, fontWeight: '700', color: C.primary, textTransform: 'uppercase', letterSpacing: 0.5 },
  qText: { fontSize: 17, fontWeight: '600', color: C.text, marginTop: 6, lineHeight: 24 },
  answerLabel: { fontSize: 12, fontWeight: '700', color: C.muted, marginTop: 14, marginBottom: 4, textTransform: 'uppercase' },
  busy: { position: 'absolute', left: 16, right: 16, bottom: 78, backgroundColor: 'rgba(17,24,39,0.92)', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  busyText: { color: '#fff', fontSize: 14, flex: 1 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card, paddingBottom: 4 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  tabIcon: { fontSize: 22 },
  tabLabel: { fontSize: 12, color: C.muted, marginTop: 2, fontWeight: '600' },
  tabLabelOn: { color: C.primary },
  hint: { borderRadius: 12, padding: 12, marginBottom: 6 },
  hintWarn: { backgroundColor: C.warnBg },
  hintOk: { backgroundColor: C.ok },
  hintText: { fontSize: 13.5, color: C.text, lineHeight: 19 },
  lowLine: { fontSize: 12.5, color: C.warnText, marginTop: 4 },
  label: { fontSize: 13, fontWeight: '700', color: C.muted, marginTop: 14, marginBottom: 6 },
  field: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, fontSize: 15, color: C.text },
  area: { minHeight: 260 },
});
