import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Image,
  Modal,
  Platform,
  Pressable as RNPressable,
  Vibration,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  LayoutAnimation,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
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
import { ocrCached, recognise, releaseOcr, type OcrResult } from './src/ocr';
import { installBundledOcr, unloadLlm, reloadLlm } from './src/qvac';
import { checkForUpdate } from './src/update';
import { Ionicons } from '@expo/vector-icons';
import { Camera } from 'expo-camera';
import SnapCamera, { type SnapResult } from './src/SnapCamera';
import { Intro } from './src/Intro';
import { noteError, lastErrorLine } from './src/lastError';
import { Confetti } from './src/Confetti';
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
  buildMcqPrompt,
  parseMcq,
  MCQ_SCHEMA,
  quizExcerpts,
  search,
  type Hit, splitQuestions, bestDocHits } from './src/rag';
import { SAMPLE_NOTES, SAMPLE_TITLE } from './src/sample';

// Every button answers the finger at once: a soft dim while pressed (plus the Android ripple), so taps
// feel instant even when the work behind them takes a moment. Full-screen backdrops are left alone.
function Pressable(props: React.ComponentProps<typeof RNPressable>) {
  const { style, android_ripple, ...rest } = props;
  return (
    <RNPressable
      {...rest}
      android_ripple={android_ripple}
      style={(st) => {
        const base = typeof style === 'function' ? style(st) : style;
        const flat: any = StyleSheet.flatten(base) || {};
        if (!st.pressed || props.disabled || flat.flex === 1) return base;
        return [base, { opacity: 0.72, transform: [...(flat.transform ?? []), { scale: 0.97 }] }];
      }}
    />
  );
}

/** Throttles progress text so long jobs don't redraw the whole screen dozens of times a second. */
function throttled(fn: (t: string) => void, ms = 250) {
  let last = 0;
  return (t: string, force = false) => {
    const now = Date.now();
    if (force || now - last >= ms) {
      last = now;
      fn(t);
    }
  };
}

type Tab = 'notes' | 'ask' | 'quiz';
type Phase = 'checking' | 'needDownload' | 'downloading' | 'loading' | 'ready' | 'error';
type QA = { id: string; question: string; answer: string; hits: Hit[]; done: boolean; ms?: number; subject?: string; replyTo?: { id: string; question: string } };
type AiState = 'off' | 'loading' | 'embed' | 'ready';
const AUTO = '__auto__';
type QuizCard = {
  id: string;
  question: string;
  answer: string;
  source: StoredChunk;
  docName: string;
  revealed: boolean;
  options?: string[];
  correct?: number;
  picked?: number;
};
const QUIZ_SIZES = [5, 10, 15, 20];
const LETTERS = ['A', 'B', 'C', 'D'];

const SETTINGS_FILE = (FS.documentDirectory ?? '') + 'ofunca-settings.json';
type ThemePref = 'system' | 'light' | 'dark';
type Settings = { device?: Device; setupDone?: boolean; theme?: ThemePref; hideGuide?: boolean };
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

const APP_VERSION: string = require('./app.json').expo.version;

const BUILT_WITH: [string, string][] = [
  ['Tether QVAC SDK', 'runs every AI model on the phone'],
  ['Llama 3.2 1B Instruct', 'the tutor that answers and writes quizzes'],
  ['EmbeddingGemma 300M', 'finds the right part of your notes'],
  ['QVAC OCR', 'reads photos of handwritten and printed notes'],
  ['Expo + React Native', 'the app itself'],
];

// Developer card. Every link opens outside the app; nothing is sent automatically.
const DEV: { name: string; links: { icon: string; label: string; hint?: string; url: string }[] } = {
  name: 'Avie',
  links: [
    { icon: 'mail-outline', label: 'Email', hint: 'destinymomobu@gmail.com', url: 'mailto:destinymomobu@gmail.com?subject=Ofunca%20feedback' },
    { icon: 'logo-whatsapp', label: 'WhatsApp', hint: '+234 704 017 5686', url: 'https://wa.me/2347040175686?text=Hi%20Avie%2C%20about%20Ofunca%3A%20' },
    { icon: 'logo-x', label: 'X (Twitter)', hint: '@AVIEHUB', url: 'https://x.com/AVIEHUB' },
    { icon: 'logo-github', label: 'GitHub', hint: 'Afar88', url: 'https://github.com/Afar88' },
  ],
};

/** ChatGPT-style menu: slides in from the left over a dimmed screen; tap outside or swipe the scrim to close. */
function SideDrawer(p: { open: boolean; onClose: () => void; C: any; topInset: number; bottomInset: number; children: React.ReactNode }) {
  const W = Math.min(Dimensions.get('window').width * 0.84, 360);
  const x = useRef(new Animated.Value(-W)).current;
  const [shown, setShown] = useState(p.open);
  useEffect(() => {
    if (p.open) {
      setShown(true);
      Animated.timing(x, { toValue: 0, duration: 230, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else if (shown) {
      Animated.timing(x, { toValue: -W, duration: 190, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setShown(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open]);
  if (!shown) return null;
  const dim = x.interpolate({ inputRange: [-W, 0], outputRange: [0, 1] });
  return (
    <Modal visible transparent animationType="none" onRequestClose={p.onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(14,19,48,0.55)', opacity: dim }]}>
        <Pressable style={{ flex: 1 }} onPress={p.onClose} />
      </Animated.View>
      <Animated.View
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: W,
          backgroundColor: p.C.card, borderTopRightRadius: 24, borderBottomRightRadius: 24,
          paddingTop: p.topInset + 16, paddingBottom: p.bottomInset + 8, paddingHorizontal: 16,
          transform: [{ translateX: x }], elevation: 16,
        }}
      >
        {p.children}
      </Animated.View>
    </Modal>
  );
}

/** A drawer section that stays folded until tapped, so the menu opens as a short clean list. */
function MenuSection(p: { C: any; icon: string; title: string; hint?: string; open?: boolean; onToggle: () => void; children?: React.ReactNode }) {
  const { C } = p;
  return (
    <View style={{ marginTop: 10, borderRadius: 16, borderWidth: 1, borderColor: p.open ? C.primary : C.border, backgroundColor: C.bg, overflow: 'hidden' }}>
      <Pressable onPress={p.onToggle} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14, opacity: pressed ? 0.6 : 1 })} accessibilityRole="button" accessibilityState={{ expanded: p.open }}>
        <Ionicons name={p.icon as any} size={20} color={p.open ? C.primary : C.text} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: 15, fontWeight: '800' }}>{p.title}</Text>
          {!!p.hint && <Text style={{ color: C.muted, fontSize: 12, marginTop: 1 }}>{p.hint}</Text>}
        </View>
        <Ionicons name={p.children ? (p.open ? 'chevron-up' : 'chevron-down') : 'chevron-forward'} size={18} color={C.muted} />
      </Pressable>
      {p.open && !!p.children && <View style={{ paddingHorizontal: 12, paddingBottom: 8, borderTopWidth: 1, borderTopColor: C.border }}>{p.children}</View>}
    </View>
  );
}

function MenuRow(p: { C: any; icon: string; label: string; hint?: string; onPress: () => void; danger?: boolean; disabled?: boolean; last?: boolean }) {
  return (
    <Pressable
      onPress={p.onPress}
      disabled={p.disabled}
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 10, opacity: p.disabled ? 0.4 : pressed ? 0.6 : 1 },
        !p.last && { borderBottomWidth: 1, borderBottomColor: p.C.border },
      ]}
    >
      <Ionicons name={p.icon as any} size={20} color={p.danger ? p.C.danger : p.C.primary} style={{ width: 26, textAlign: 'center' }} />
      <Text style={{ flex: 1, color: p.danger ? p.C.danger : p.C.text, fontSize: 15, fontWeight: '700' }}>{p.label}</Text>
      {p.hint ? <Text style={{ color: p.C.muted, fontSize: 12, maxWidth: 170 }} numberOfLines={1}>{p.hint}</Text> : null}
      <Ionicons name="chevron-forward" size={16} color={p.C.muted} />
    </Pressable>
  );
}

export default function App() {
  const [intro, setIntro] = useState(true);
  return (
    <SafeAreaProvider>
      <Main />
      {intro && <Intro onDone={() => setIntro(false)} />}
    </SafeAreaProvider>
  );
}

function Main() {
  // Light / dark mode: follows the phone by default, or the user's choice in Settings.
  const sys = useColorScheme();
  const [themePref, setThemePref] = useState<ThemePref>('system');
  useEffect(() => {
    readSettings().then((st) => {
      if (st.theme) setThemePref(st.theme);
      if (st.hideGuide) setHideGuide(true);
    });
  }, []);
  const [hideGuide, setHideGuideState] = useState(false);
  const setHideGuide = (v: boolean) => {
    setHideGuideState(v);
    saveSettings({ hideGuide: v });
  };
  const [menu, setMenu] = useState(false);
  // The three add-notes buttons always stay bright. While one is working, the others politely say "one moment".
  const [lastAction, setLastAction] = useState<'import' | 'snap' | 'paste' | null>(null);
  function act(which: 'import' | 'snap' | 'paste', fn: () => Promise<void> | void) {
    if (!busy) setLastAction(which);
    fn();
  }
  const [menuSec, setMenuSec] = useState<null | 'study' | 'look' | 'data' | 'about'>(null);
  function toggleSec(k: 'study' | 'look' | 'data' | 'about') {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setMenuSec((v) => (v === k ? null : k));
  }
  useEffect(() => {
    if (!menu) {
      setMenuSec(null);
      setAboutOpen(null);
    }
  }, [menu]);
  const [aboutOpen, setAboutOpen] = useState<null | 'app' | 'privacy' | 'built'>(null);
  const [report, setReport] = useState<string | null>(null);
  const sendReport = (via: 'sms' | 'wa' | 'mail') => {
    const err = lastErrorLine();
    const body = `${(report ?? '').trim()}\n\n— Ofunca v${APP_VERSION}, Android ${Platform.Version}${err ? '\n' + err : ''}`;
    const enc = encodeURIComponent(body);
    const url = via === 'sms' ? `sms:+2347040175686?body=${enc}` : via === 'wa' ? `https://wa.me/2347040175686?text=${enc}` : `mailto:destinymomobu@gmail.com?subject=${encodeURIComponent('Ofunca problem report')}&body=${enc}`;
    Linking.openURL(url).then(() => setReport(null)).catch(() => Alert.alert('Could not open', 'No app on this phone can send that. Try another option.'));
  };
  const [stash, setStash] = useState(false);
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
  const [chipOpen, setChipOpen] = useState(true);
  const chipTimer = useRef<any>(null);
  const flashChip = useCallback((ms: number) => {
    setChipOpen(true);
    clearTimeout(chipTimer.current);
    chipTimer.current = setTimeout(() => setChipOpen(false), ms);
  }, []);
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
  useEffect(() => {
    if (ai === 'ready') flashChip(4000);
    return () => clearTimeout(chipTimer.current);
  }, [ai, online, flashChip]);

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
        noteError(e);
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
          installBundledOcr().catch(() => {});
          setTimeout(() => checkForUpdate(), 4000);
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
      const r = await downloadModels(['embed', 'llm'], setKey);
      setOcrMissing(r.failedOptional.length > 0);
      setJustDownloaded(true);
      await bootModels(device);
      installBundledOcr().catch(() => {});
    } catch (e: any) {
      noteError(e);
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
        installBundledOcr().catch(() => {});
      } else {
        Alert.alert('Model imported', `${m.fileName} is ready. ${!c.embed || !c.llm ? 'Import or download the other model to finish setup.' : ''}`);
      }
    } catch (e: any) {
      noteError(e);
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
    const say = throttled((t) => setBusy(t));
    const vecs = await embedDocuments(
      raw.map((c) => c.text),
      (d, t) => say(`Learning your notes… ${Math.round((d / t) * 100)}%`, d === t),
    );
    const docId = makeId('d');
    const stored: StoredChunk[] = raw.map((c, i) => ({ id: makeId('c'), docId, page: c.page, text: c.text, vec: roundVec(vecs[i]) }));
    await addDoc(
      { id: docId, name, kind, subject: subject.trim() || GENERAL, addedAt: Date.now(), chunkCount: stored.length, charCount: raw.reduce((s, c) => s + c.text.length, 0) },
      stored,
    );
    await refreshLibrary();
  }

  // Jobs line up instead of being refused: tap Snap, Import and Paste in any order and each one
  // runs as soon as the one before it finishes. (One AI job at a time keeps the phone from crashing.)
  const jobChain = useRef<Promise<void>>(Promise.resolve());
  const [queued, setQueued] = useState(0);
  const running = useRef(0);
  function guarded(label: string, fn: () => Promise<void>, needs: 'embed' | 'llm' = 'embed', onFail?: () => void): Promise<void> {
    const waiting = running.current > 0;
    if (waiting) setQueued((q) => q + 1);
    running.current++;
    const go = async () => {
      if (waiting) setQueued((q) => Math.max(0, q - 1));
      try {
        await runJob(label, fn, needs, onFail);
      } finally {
        running.current--;
      }
    };
    const p = jobChain.current.then(go, go);
    jobChain.current = p.catch(() => {});
    return p;
  }
  async function runJob(label: string, fn: () => Promise<void>, needs: 'embed' | 'llm', onFail?: () => void) {
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
      noteError(e);
      onFail?.();
      Alert.alert('Something went wrong', e?.message ?? String(e));
    } finally {
      setBusy(null);
      setGenerating(false);
    }
  }

  // ---------- Subjects ----------
  const subjects = subjectsOf(docs);
  const [picker, setPicker] = useState<null | { title: string; value: string; resolve: (v: string | null) => void }>(null);
  function pickSubject(title: string, initial = ''): Promise<string | null> {
    return new Promise((resolve) => setPicker({ title, value: initial, resolve }));
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
        const say = throttled((t) => setBusy(t));
        const pages = await pdf.current!.extract(b64, (p, t) => say(`Reading PDF… page ${p}/${t}`, p === t));
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
  type EditorState = { mode: 'paste' | 'ocr'; title: string; text: string; subject: string; ocr?: OcrResult };
  const [editor, setEditor] = useState<null | EditorState>(null);
  const [snapCam, setSnapCam] = useState<null | ((v: SnapResult) => void)>(null);
  // If Android closed Ofunca while the camera was open, finish reading that photo once the AI is ready.
  const pendingChecked = useRef(false);
  useEffect(() => {
    if (ai !== 'ready' || pendingChecked.current || Platform.OS !== 'android') return;
    pendingChecked.current = true;
    ImagePicker.getPendingResultAsync()
      .then(async (r: any) => {
        const uri = r && !r.canceled && r.assets?.[0]?.uri;
        if (!uri) return;
        if (!(await ocrCached())) await installBundledOcr(setBusy);
        await readPhoto(uri);
      })
      .catch((e) => noteError(e, 'pending photo'));
  }, [ai]);
  const editorOpen = useRef(false);
  const editorQueue = useRef<EditorState[]>([]);
  useEffect(() => {
    editorOpen.current = !!editor;
    if (!editor && editorQueue.current.length) {
      const next = editorQueue.current.shift()!;
      setTimeout(() => setEditor(next), 350); // let the closing sheet finish sliding away
    }
  }, [editor]);
  /** Opens the review box, or lines it up if another one is open (e.g. a photo finished while pasting). */
  function openEditor(e: EditorState) {
    if (editorOpen.current) editorQueue.current.push(e);
    else setEditor(e);
  }

  async function snapNotes() {
    // Uses the system file/gallery picker (no camera or storage permission needed).
    if (!(await ocrCached())) {
      // The photo reader ships inside the app: copy it into place once (no internet needed).
      let ok = false;
      await guarded('Setting up photo reader…', async () => {
        await installBundledOcr(setBusy);
        ok = true;
        setOcrMissing(false);
      });
      if (!ok) return;
    }
    // Ofunca's own in-app camera: no separate camera app, so Android has no reason to close Ofunca.
    let uri: string | undefined;
    try {
      const perm = await Camera.requestCameraPermissionsAsync();
      if (perm.granted) {
        // Camera, gallery shortcut and crop all happen inside Ofunca's own camera screen.
        const pick = await new Promise<SnapResult>((resolve) => setSnapCam(() => resolve));
        setSnapCam(null);
        if (!pick) return;
        uri = pick.uri;
      } else {
        const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, allowsEditing: true });
        if (r.canceled || !r.assets?.length) return;
        uri = r.assets[0].uri;
      }
    } catch (e: any) {
      noteError(e);
      Alert.alert('Could not open the camera', String(e?.message ?? e));
      return;
    }
    await readPhoto(uri);
  }

  async function readPhoto(photo: string) {
    await guarded('Reading photo…', async () => {
      try {
        // Make room: the tutor model steps aside while the photo reader works, then comes back.
        setBusy('Making room for the photo reader…');
        await unloadLlm();
        const r = await recognise(photo, setBusy);
        await releaseOcr();
        setBusy('Getting the tutor ready again…');
        await reloadLlm(device);
        if (!r.text.trim()) throw new Error('No text was found in this photo. Try a sharper, well-lit photo taken straight on.');
        openEditor({ mode: 'ocr', title: 'Snapped notes ' + new Date().toLocaleDateString(), text: r.text, subject: '', ocr: r });
      } finally {
        releaseOcr().catch(() => {});
        reloadLlm(device).catch(() => {});
      }
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
    }, 'llm', () => {
      // Failed: say so on the card and put the question back in the box so one tap retries it.
      setQas((prev) => prev.map((x) => (x.id === id ? { ...x, answer: x.answer || '⚠️ Something went wrong while answering. Your question is back in the box: tap Ask to try again.', done: true } : x)));
      setQuestion((cur) => cur || q);
    });
    setGenerating(false);
    setQas((prev) => prev.map((x) => (x.id === id ? { ...x, done: true } : x)));
  }

  // ---------- Quiz ----------
  const [quiz, setQuiz] = useState<QuizCard[]>([]);
  const [quizSize, setQuizSize] = useState(10);
  const [party, setParty] = useState(false);
  // Questions answered wrong are kept (across restarts) for a "Review my mistakes" round.
  const [mistakes, setMistakes] = useState<QuizCard[]>([]);
  const [reviewing, setReviewing] = useState(false);
  function pick(q: QuizCard, oi: number) {
    setQuiz((prev) => prev.map((x) => (x.id === q.id ? { ...x, picked: oi, revealed: true } : x)));
    Vibration.vibrate(oi === q.correct ? 12 : [0, 35, 70, 35]); // tiny tick for right, double buzz for wrong
    const key = q.question.toLowerCase();
    if (oi !== q.correct) {
      setMistakes((prev) => (prev.some((m) => m.question.toLowerCase() === key) ? prev : [...prev, { ...q, picked: undefined, revealed: false }].slice(-60)));
    } else if (reviewing) {
      setMistakes((prev) => prev.filter((m) => m.question.toLowerCase() !== key)); // got it right now: mastered
    }
  }
  function startReview() {
    const shuffle = <T,>(a: T[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const round = shuffle(mistakes.slice()).slice(0, 20).map((m) => {
      const opts = m.options ?? [];
      const order = shuffle(opts.map((_, i) => i));
      return { ...m, id: makeId('r'), options: order.map((i) => opts[i]), correct: order.indexOf(m.correct ?? 0), picked: undefined, revealed: false };
    });
    setReviewing(true);
    setQuiz(round);
  }
  const celebrated = useRef('');
  useEffect(() => {
    const mcq = quiz.filter((q) => q.options);
    if (!mcq.length || busy) return;
    const key = mcq.map((q) => q.id).join(',');
    if (celebrated.current === key) return;
    if (mcq.every((q) => q.picked !== undefined && q.picked === q.correct)) {
      celebrated.current = key;
      setParty(true);
    }
  }, [quiz, busy]);

  // ---------- Saved history: answers and quizzes are still there after closing the app ----------
  const historyLoaded = useRef(false);
  useEffect(() => {
    loadHistory<{ qas?: QA[]; quiz?: QuizCard[]; mistakes?: QuizCard[]; reviewing?: boolean }>().then((h) => {
      if (h?.mistakes) setMistakes(h.mistakes);
      if (h?.reviewing) setReviewing(true);
      if (h?.qas) setQas(h.qas.map((x) => ({ ...x, done: true, answer: x.answer || NOT_FOUND })));
      if (h?.quiz) {
        setQuiz(h.quiz);
        celebrated.current = h.quiz.filter((q) => q.options).map((q) => q.id).join(',');
      }
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
        mistakes: mistakes.map((z) => ({ ...z, source: lite(z.source) })),
        reviewing,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [qas, quiz, mistakes, reviewing, generating]);

  function confirmClear(what: 'chat' | 'quiz') {
    Alert.alert(what === 'chat' ? 'Clear all questions?' : 'Clear this quiz?', 'This only removes the history. Your notes stay.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => (what === 'chat' ? setQas([]) : (setQuiz([]), setReviewing(false))) },
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
    setReviewing(false);
    await guarded('Writing quiz…', async () => {
      const excerpts = quizExcerpts(pool, quizSize, scopeValid === AUTO ? (c) => subjectByDoc[c.docId] ?? '' : undefined);
      const asked: string[] = [];
      let made = 0;
      for (let i = 0; i < excerpts.length + 4 && made < quizSize; i++) {
        const ex = excerpts[i % excerpts.length];
        setBusy(`Writing question ${made + 1} of ${quizSize}…`);
        let raw = '';
        try {
          raw = await generate(buildMcqPrompt(ex.text, asked), () => {}, {
            maxTokens: 120,
            firstTokenMs: 60000,
          temp: 0.6,
            jsonSchema: MCQ_SCHEMA,
          });
        } catch {
          continue; // one stuck question never stops the whole quiz
        }
        const q = parseMcq(raw);
        if (!q || asked.some((x) => x.toLowerCase() === q.question.toLowerCase())) continue;
        asked.push(q.question);
        made++;
        setQuiz((prev) => [
          ...prev,
          { id: makeId('z'), ...q, source: ex, docName: docNames[ex.docId] ?? 'Notes', revealed: false },
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
                Download the on-device AI models once (about {Math.round(MODELS.reduce((a, m) => a + m.approxMB, 0) / 10) / 100} GB, Wi‑Fi
                recommended). After that the app works with no internet, even in airplane mode.
              </Text>
              {MODEL_GROUPS.filter((g) => g.id !== 'ocr').map((g) => {
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
        <Pressable onPress={() => setMenu(true)} hitSlop={12} style={s.moreBtn} accessibilityLabel="Open menu">
          <View style={s.lines}>
            <View style={[s.line, { width: 18 }]} />
            <View style={[s.line, { width: 12 }]} />
          </View>
        </Pressable>
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
          <Pressable onPress={() => { if (chipOpen) { clearTimeout(chipTimer.current); setChipOpen(false); } else flashChip(3000); }} hitSlop={12} accessibilityLabel="On-device AI status">
            {chipOpen ? (
              <View style={[s.chip, online === false ? s.chipOffline : s.chipOnline]}>
                <Text style={s.chipText}>{online === false ? '✈ Offline · on-device AI' : '● On-device AI'}</Text>
              </View>
            ) : (
              <View style={s.aiDot} />
            )}
          </Pressable>
        )}
      </View>

      {justDownloaded && (
        <Pressable style={s.banner} onPress={() => setJustDownloaded(false)}>
          <Text style={s.bannerText}>✅ All set! Models are on your phone. You can switch on airplane mode now. (tap to dismiss)</Text>
        </Pressable>
      )}

      <View style={{ flex: 1 }}>
        {tab === 'notes' && (
          <ScrollView contentContainerStyle={s.pad}>
            <View style={s.actions}>
              <ActionBtn icon="document-text-outline" label="Import PDF / text" active={busy ? lastAction === 'import' : false} onPress={() => act('import', importFile)} />
              <ActionBtn icon="camera-outline" label="Snap notes" active={busy ? lastAction === 'snap' : false} onPress={() => act('snap', snapNotes)} />
              <ActionBtn icon="clipboard-outline" label="Paste text" onPress={() => act('paste', async () => openEditor({ mode: 'paste', title: '', text: '', subject: '' }))} />
            </View>
            {!hideGuide && (
              <View style={s.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={[s.h2, { flex: 1 }]}>How Ofunca works</Text>
                  <Pressable onPress={() => setHideGuide(true)} hitSlop={10}>
                    <Text style={s.clearLink}>Hide ✕</Text>
                  </Pressable>
                </View>
                {[
                  ['1', 'Add your notes', 'Import a PDF, snap a photo of your notebook or handout, or paste text. Put each one under a subject.'],
                  ['2', 'Ask anything', 'Type your question, even two or three at once. Answers come only from your notes, with “Where from?” showing the exact part.'],
                  ['3', 'Quiz yourself', 'Pick a subject or mix them all, choose 5 to 20 questions, tap A to D and see right or wrong with your score.'],
                ].map(([n, t, d]) => (
                  <View key={n} style={{ flexDirection: 'row', gap: 12, marginTop: 14 }}>
                    <View style={s.stepNum}>
                      <Text style={s.stepNumText}>{n}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.body, { fontWeight: '900' }]}>{t}</Text>
                      <Text style={s.small}>{d}</Text>
                    </View>
                  </View>
                ))}
                <Text style={[s.small, { marginTop: 14 }]}>Everything runs and stays on this phone. No internet needed.</Text>
              </View>
            )}
            {docs.length === 0 ? (
              <View style={s.card}>
                <Text style={s.h2}>No notes yet</Text>
                <Text style={s.small}>Use Import, Snap or Paste above to add your first notes.</Text>
              </View>
            ) : (
              <Pressable style={s.stashTile} onPress={() => setStash(true)}>
                <Ionicons name="library" size={30} color={C.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={s.stashTitle}>My Study Stash</Text>
                  <Text style={s.small}>
                    {docs.length} note{docs.length === 1 ? '' : 's'} in {subjects.length} subject{subjects.length === 1 ? '' : 's'} · tap to open
                  </Text>
                </View>
                <Text style={s.stashArrow}>›</Text>
              </Pressable>
            )}
            <Credit />
          </ScrollView>
        )}

        {tab === 'ask' && (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
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
            {subjects.length > 1 && (
              <>
                <Text style={[s.small, { textAlign: 'center', marginBottom: 6 }]}>Quiz me on one subject, or mix them all:</Text>
                <SubjectChips subjects={subjects} value={scopeValid} onChange={setScope} autoLabel="Mix all" inline />
              </>
            )}
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 10, alignItems: 'center' }}>
              <Text style={s.small}>Questions:</Text>
              {QUIZ_SIZES.map((n) => (
                <Pressable
                  key={n}
                  onPress={() => setQuizSize(n)}
                  disabled={!!busy}
                  style={[s.sizeChip, quizSize === n && s.sizeChipOn]}
                >
                  <Text style={[s.sizeChipText, quizSize === n && s.sizeChipTextOn]}>{n}</Text>
                </Pressable>
              ))}
            </View>
            {quiz.some((q) => q.picked !== undefined) && (
              <Text style={s.score}>
                Score: {quiz.filter((q) => q.picked !== undefined && q.picked === q.correct).length} / {quiz.filter((q) => q.picked !== undefined).length}
                {quiz.every((q) => !q.options || q.picked !== undefined) ? ` 🎉 Done!` : ''}
              </Text>
            )}
            <Pressable style={[s.btn, (!!busy || !chunks.length) && s.btnDisabled]} disabled={!!busy || !chunks.length} onPress={makeQuiz}>
              <Text style={s.btnText}>{quiz.length ? 'New quiz' : 'Quiz me'}</Text>
            </Pressable>
            {mistakes.length > 0 && (
              <Pressable style={[s.btnGhost, !!busy && s.btnDisabled]} disabled={!!busy} onPress={startReview}>
                <Text style={s.btnGhostText}>Review my mistakes ({mistakes.length})</Text>
              </Pressable>
            )}
            {reviewing && quiz.length > 0 && (
              <Text style={[s.small, { textAlign: 'center', marginTop: 8 }]}>
                Mistakes round: get one right and it leaves your list. {mistakes.length ? `${mistakes.length} left.` : 'All mastered! 🌟'}
              </Text>
            )}
            {quiz.length > 0 && !busy && (
              <Pressable onPress={() => confirmClear('quiz')} hitSlop={8} style={{ alignSelf: 'center', marginTop: 10 }}>
                <Text style={s.clearLink}>Clear quiz</Text>
              </Pressable>
            )}
            {!quiz.length && !busy && (
              <Text style={[s.small, { textAlign: 'center', marginTop: 12 }]}>
                {chunks.length ? `Pick an answer A to D for each question from ${scopeValid === AUTO ? 'all your notes' : scopeValid}.` : 'Add notes first.'}
              </Text>
            )}
            {quiz.map((q, i) => (
              <View key={q.id} style={s.card}>
                <Text style={s.qNum}>Question {i + 1}{scopeValid === AUTO && subjects.length > 1 ? ` · ${subjectByDoc[q.source.docId] ?? ''}` : ''}</Text>
                <Text style={s.qText}>{q.question}</Text>
                {q.options ? (
                  <>
                    {q.options.map((opt, oi) => {
                      const done = q.picked !== undefined;
                      const isRight = oi === q.correct;
                      const isPicked = oi === q.picked;
                      return (
                        <Pressable
                          key={oi}
                          disabled={done}
                          onPress={() => pick(q, oi)}
                          style={[s.opt, done && isRight && s.optRight, done && isPicked && !isRight && s.optWrong]}
                        >
                          <Text style={s.optText}>
                            {LETTERS[oi]}. {opt}
                            {done && isRight ? '  ✅' : ''}
                            {done && isPicked && !isRight ? '  ❌' : ''}
                          </Text>
                        </Pressable>
                      );
                    })}
                    {q.picked !== undefined && (
                      <>
                        <Text style={[s.answerLabel, { color: q.picked === q.correct ? C.okText : C.danger }]}>
                          {q.picked === q.correct ? 'Correct! 🎉' : `Wrong. The answer is ${LETTERS[q.correct ?? 0]}. ${q.answer}`}
                        </Text>
                        <SourceCard n={i + 1} docName={q.docName} page={q.source.page} text={q.source.text} />
                      </>
                    )}
                  </>
                ) : q.revealed ? (
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

      {party && <Confetti onDone={() => setParty(false)} />}
      {busy && (
        <View style={s.busy}>
          <ActivityIndicator color="#fff" />
          <Text style={s.busyText}>{busy}{queued > 0 ? `  ·  ${queued} more lined up` : ''}</Text>
        </View>
      )}

      <View style={s.tabs}>
        {(
          [
            ['notes', 'library', 'Notes'],
            ['ask', 'chatbubble-ellipses', 'Ask'],
            ['quiz', 'school', 'Quiz'],
          ] as [Tab, string, string][]
        ).map(([k, icon, label]) => (
          <Pressable key={k} style={s.tab} onPress={() => setTab(k)}>
            <Ionicons name={(tab === k ? icon : `${icon}-outline`) as any} size={24} color={tab === k ? C.primary : C.muted} />
            <Text style={[s.tabLabel, tab === k && s.tabLabelOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Modal visible={!!editor} animationType="slide" onRequestClose={() => setEditor(null)}>
        <SafeAreaView style={s.safe}>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
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
              <Text style={s.label}>Subject</Text>
              <SubjectSelect subjects={subjects} value={editor?.subject ?? ''} onChange={(v) => setEditor((e) => (e ? { ...e, subject: v } : e))} />
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

      <Modal visible={stash} transparent animationType="slide" onRequestClose={() => setStash(false)}>
        <Pressable style={s.scrim} onPress={() => setStash(false)}>
          <Pressable style={s.sheet} onPress={() => {}}>
            <Text style={s.h2}>My Study Stash</Text>
            <Text style={s.small}>Tap a note to move it to another subject, ✕ to remove it.</Text>
            <ScrollView style={{ maxHeight: 480 }}>
              {docs.length === 0 ? <Text style={[s.small, { marginTop: 12 }]}>No notes yet.</Text> : (
              subjects.map((sub) => (
                <View key={sub} style={{ marginTop: 16 }}>
                  <Text style={s.groupHead}>{sub}</Text>
                  {docs.filter((d) => subjectOf(d) === sub).map((d) => (
                    <Pressable key={d.id} style={s.docRow} onPress={() => moveDoc(d)}>
                      <Ionicons name={d.kind === 'pdf' ? 'document-outline' : d.kind === 'pasted' ? 'clipboard-outline' : 'camera-outline'} size={22} color={C.primary} style={{ width: 28 }} />
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
            </ScrollView>
            <Pressable style={s.btn} onPress={() => setStash(false)}>
              <Text style={s.btnText}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <SideDrawer open={menu} onClose={() => setMenu(false)} C={C} topInset={insets.top} bottomInset={insets.bottom}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <Image source={require('./assets/icon.png')} style={{ width: 40, height: 40, borderRadius: 12 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.h2, { marginBottom: 0 }]}>Ofunca</Text>
                  <Text style={s.small}>Your offline study buddy · v{APP_VERSION}</Text>
                </View>
                <Pressable onPress={() => setMenu(false)} hitSlop={12} accessibilityLabel="Close menu">
                  <Text style={{ color: C.muted, fontSize: 22, fontWeight: '800' }}>✕</Text>
                </Pressable>
              </View>

              <MenuSection C={C} icon="school-outline" title="Study" open={menuSec === 'study'} onToggle={() => toggleSec('study')}>
                <MenuRow C={C} icon="library-outline" label="My Study Stash" hint={`${docs.length} note${docs.length === 1 ? '' : 's'}`} onPress={() => { setMenu(false); setStash(true); }} />
                <MenuRow C={C} icon="book-outline" label={`${hideGuide ? 'Show' : 'Hide'} “How Ofunca works”`} onPress={() => { setHideGuide(!hideGuide); setMenu(false); setTab('notes'); }} last />
              </MenuSection>

              <MenuSection C={C} icon="color-palette-outline" title="Look & speed" open={menuSec === 'look'} onToggle={() => toggleSec('look')}>
                <Text style={s.segLabel}>Theme</Text>
                <View style={s.segment}>
                  {([
                    ['system', 'phone-portrait-outline', 'Auto'],
                    ['light', 'sunny-outline', 'Light'],
                    ['dark', 'moon-outline', 'Dark'],
                  ] as [ThemePref, string, string][]).map(([t, icon, label]) => (
                    <Pressable key={t} onPress={() => chooseTheme(t)} style={[s.segBtn, themePref === t && s.segBtnOn]}>
                      <Ionicons name={icon as any} size={15} color={themePref === t ? '#fff' : C.muted} />
                      <Text style={[s.segText, themePref === t && s.segTextOn]} numberOfLines={1}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={s.segLabel}>AI runs on</Text>
                <View style={s.segment}>
                  {([
                    ['cpu', 'hardware-chip-outline'],
                    ['gpu', 'flash-outline'],
                  ] as [Device, string][]).map(([d, icon]) => (
                    <Pressable key={d} onPress={() => { setMenu(false); switchDevice(d); }} style={[s.segBtn, device === d && s.segBtnOn]}>
                      <Ionicons name={icon as any} size={15} color={device === d ? '#fff' : C.muted} />
                      <Text style={[s.segText, device === d && s.segTextOn]} numberOfLines={1}>{d.toUpperCase()}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={[s.small, { marginTop: 8 }]}>Answers feel slow? Try GPU.</Text>
              </MenuSection>

              <MenuSection C={C} icon="folder-outline" title="My data" open={menuSec === 'data'} onToggle={() => toggleSec('data')}>
                <MenuRow C={C} icon="chatbubble-outline" label="Clear Ask history" disabled={!qas.length} onPress={() => { setMenu(false); confirmClear('chat'); }} />
                <MenuRow C={C} icon="school-outline" label="Clear quiz" disabled={!quiz.length} onPress={() => { setMenu(false); confirmClear('quiz'); }} />
                <MenuRow
                  C={C}
                  icon="trash-outline"
                  label="Delete all notes"
                  danger
                  last
                  disabled={!docs.length}
                  onPress={() => {
                    setMenu(false);
                    Alert.alert('Delete all notes?', 'This removes every imported note from this phone.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete all', style: 'destructive', onPress: async () => { await clearAll(); await refreshLibrary(); setQas([]); setQuiz([]); } },
                    ]);
                  }}
                />
              </MenuSection>

              <MenuSection C={C} icon="information-circle-outline" title="About" open={menuSec === 'about'} onToggle={() => toggleSec('about')}>
                <MenuRow C={C} icon="information-circle-outline" label="About Ofunca" hint={`v${APP_VERSION}`} onPress={() => setAboutOpen(aboutOpen === 'app' ? null : 'app')} />
                {aboutOpen === 'app' && (
                  <View style={s.menuNote}>
                    <Text style={[s.small, { marginBottom: 10 }]}>
                      Ofunca is an offline AI study tutor. Add your notes by PDF, photo or paste, then ask questions and take quizzes that come only from your own notes. Everything runs on your phone with Tether QVAC, even in airplane mode.
                    </Text>
                    <Text style={[s.menuText, { marginBottom: 2 }]}>Made by {DEV.name}</Text>
                    <Text style={[s.small, { marginBottom: 6 }]}>Built for students who study without steady internet. Feedback welcome!</Text>
                    {DEV.links.map((l, i) => (
                      <MenuRow C={C} key={l.url} icon={l.icon} label={l.label} hint={l.hint} onPress={() => Linking.openURL(l.url).catch(() => {})} last={i === DEV.links.length - 1} />
                    ))}
                  </View>
                )}
                <MenuRow C={C} icon="refresh-outline" label="Check for updates" onPress={() => { setMenu(false); checkForUpdate(true); }} />
                <MenuRow C={C} icon="lock-closed-outline" label="Privacy & offline" onPress={() => setAboutOpen(aboutOpen === 'privacy' ? null : 'privacy')} />
                {aboutOpen === 'privacy' && (
                  <Text style={[s.small, s.menuNote]}>
                    Your notes, searches and answers never leave this phone. Internet is used only once, to download the AI models. After that Ofunca works in airplane mode.
                  </Text>
                )}
                <MenuRow C={C} icon="construct-outline" label="Built with" onPress={() => setAboutOpen(aboutOpen === 'built' ? null : 'built')} last={aboutOpen !== 'built'} />
                {aboutOpen === 'built' && (
                  <View style={s.menuNote}>
                    {BUILT_WITH.map(([k, v]) => (
                      <Text key={k} style={s.small}>
                        <Text style={{ fontWeight: '800', color: C.text }}>{k}</Text> · {v}
                      </Text>
                    ))}
                  </View>
                )}
              </MenuSection>
              <MenuSection C={C} icon="chatbox-ellipses-outline" title="Report a problem" hint="Works by SMS, no data needed" onToggle={() => { setMenu(false); setReport(''); }} />

            </ScrollView>
      </SideDrawer>

      <Modal visible={!!picker} transparent animationType="fade" onRequestClose={() => closePicker(null)}>
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
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
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={report !== null} transparent animationType="fade" onRequestClose={() => setReport(null)}>
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          <Pressable style={s.scrim} onPress={() => setReport(null)}>
            <Pressable style={s.sheet} onPress={() => {}}>
              <Text style={s.h2}>Report a problem</Text>
              <Text style={[s.small, { marginBottom: 10 }]}>Say what happened and what you were doing. SMS works without internet data (normal SMS rate).</Text>
              <TextInput
                style={[s.input, { minHeight: 110, maxHeight: 200, borderRadius: 14, textAlignVertical: 'top', flex: 0 }]}
                multiline
                autoFocus
                placeholder="e.g. The app closed when I tapped Snap notes"
                placeholderTextColor={C.muted}
                value={report ?? ''}
                onChangeText={setReport}
                maxLength={300}
              />
              <Text style={[s.small, { textAlign: 'right', marginTop: 4 }]}>{(report ?? '').length}/300{lastErrorLine() ? ' · last error attached' : ''}</Text>
              <Pressable style={[s.btn, !report?.trim() && { opacity: 0.5 }]} disabled={!report?.trim()} onPress={() => sendReport('sms')}>
                <Text style={s.btnText}>Send by SMS</Text>
              </Pressable>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable style={[s.btnGhost, { flex: 1 }, !report?.trim() && { opacity: 0.5 }]} disabled={!report?.trim()} onPress={() => sendReport('wa')}>
                  <Text style={s.btnGhostText}>WhatsApp</Text>
                </Pressable>
                <Pressable style={[s.btnGhost, { flex: 1 }, !report?.trim() && { opacity: 0.5 }]} disabled={!report?.trim()} onPress={() => sendReport('mail')}>
                  <Text style={s.btnGhostText}>Email</Text>
                </Pressable>
              </View>
              <Text style={[s.small, { marginTop: 8, textAlign: 'center' }]}>WhatsApp and email need internet.</Text>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <SnapCamera visible={!!snapCam} accent={C.primary} onDone={(r) => snapCam?.(r)} />

      <PdfExtractor ref={pdf} />
    </SafeAreaView>
  );
}

function BrandMark() {
  return (
    <View style={{ alignItems: 'center' }}>
      <Image source={require('./assets/splash-icon.png')} style={{ width: 120, height: 120 }} resizeMode="contain" />
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
        value={subjects.includes(value) ? '' : value}
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

function ActionBtn({ icon, label, onPress, active }: { icon: string; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable style={[s.action, active && { borderColor: C.accent, borderWidth: 2 }]} onPress={onPress}>
      {active ? <ActivityIndicator color={C.accent} style={{ height: 28 }} /> : <Ionicons name={icon as any} size={28} color={C.primary} />}
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
  pickTile: { flex: 1, alignItems: 'center', paddingVertical: 18, borderRadius: 18, borderWidth: 2, borderColor: C.border, backgroundColor: C.bg },
  pickIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' },
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
  sizeChip: { minWidth: 40, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 16, borderWidth: 2, borderColor: C.primary, alignItems: 'center', backgroundColor: C.card },
  sizeChipOn: { backgroundColor: C.primary },
  sizeChipText: { color: C.primary, fontWeight: '800' },
  sizeChipTextOn: { color: '#fff' },
  score: { textAlign: 'center', fontSize: 18, fontWeight: '900', color: C.primaryDeep, marginBottom: 8 },
  opt: { borderWidth: 2, borderColor: C.border, borderBottomWidth: 4, borderRadius: 16, paddingVertical: 11, paddingHorizontal: 14, marginTop: 8, backgroundColor: C.card },
  optRight: { backgroundColor: C.ok, borderColor: C.okText },
  optWrong: { backgroundColor: C.warnBg, borderColor: C.danger },
  optText: { color: C.text, fontSize: 15, fontWeight: '600' },
  stepNum: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.pink, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 3, borderBottomColor: C.pinkDeep },
  stepNumText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  stashTile: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderRadius: 22, padding: 16, marginTop: 16, borderWidth: 2, borderColor: C.border, borderBottomWidth: 5 },
  stashTitle: { color: C.text, fontSize: 18, fontWeight: '900' },
  stashArrow: { color: C.primary, fontSize: 30, fontWeight: '900' },
  moreBtn: { marginRight: 10, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  moreText: { color: '#fff', fontSize: 22, fontWeight: '900', marginTop: -4 },
  lines: { gap: 5, alignItems: 'flex-start' },
  line: { height: 2.5, borderRadius: 2, backgroundColor: '#fff' },
  dots: { alignItems: 'center', justifyContent: 'center', gap: 3 },
  dot: { width: 4.5, height: 4.5, borderRadius: 3, backgroundColor: '#fff' },
  menuHead: { color: C.muted, fontSize: 12, fontWeight: '900', letterSpacing: 1, marginTop: 16, marginBottom: 6, textTransform: 'uppercase' },
  menuGroup: { backgroundColor: C.bg, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: C.border },
  menuNote: { paddingBottom: 10, gap: 3 },
  menuRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 10 },
  menuItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  menuText: { color: C.text, fontSize: 16, fontWeight: '700' },
  btnGhost: { borderWidth: 2, borderColor: C.primary, borderBottomWidth: 4, borderRadius: 22, paddingVertical: 11, alignItems: 'center', marginTop: 12, backgroundColor: C.card },
  btnGhostText: { color: C.primary, fontWeight: '900', fontSize: 15 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: C.header, borderBottomLeftRadius: 22, borderBottomRightRadius: 22 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: '#FFFFFF' },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  chipOnline: { backgroundColor: 'rgba(255,255,255,0.18)' },
  chipOffline: { backgroundColor: '#2ECC71' },
  chipText: { fontSize: 12, fontWeight: '800', color: '#FFFFFF' },
  aiDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#2ECC71', borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', margin: 6 },
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
  segLabel: { fontSize: 12.5, fontWeight: '700', color: C.muted, marginTop: 12, marginBottom: 6 },
  segment: { flexDirection: 'row', gap: 6 },
  segBtn: { flex: 1, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 14, borderWidth: 2, borderColor: C.border, borderBottomWidth: 4 },
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
