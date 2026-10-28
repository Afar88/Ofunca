// Local, on-device persistence for imported notes and their embeddings.
// Everything lives in the app's private document directory; nothing is uploaded.
import * as FS from 'expo-file-system/legacy';

export type NoteDoc = {
  id: string;
  name: string;
  kind: 'pdf' | 'text' | 'pasted';
  addedAt: number;
  chunkCount: number;
  charCount: number;
  subject?: string; // e.g. "Biology". Questions can be limited to one subject so notes never mix.
  factCount?: number; // distinct quiz-able facts, counted once when the note is added (v1.0.16)
};

export const GENERAL = 'General';
export const subjectOf = (d: NoteDoc) => (d.subject && d.subject.trim()) || GENERAL;

/** Subjects in the library, most recently used first. */
export function subjectsOf(docs: NoteDoc[]): string[] {
  const out: string[] = [];
  for (const d of docs) {
    const s = subjectOf(d);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export type StoredChunk = {
  id: string;
  docId: string;
  page?: number;
  text: string;
  vec: number[]; // L2-normalised embedding
};

type DB = { version: 1; docs: NoteDoc[]; chunks: StoredChunk[] };

const DIR = (FS.documentDirectory ?? '') + 'ofunca/';
const FILE = DIR + 'library.json';

let cache: DB | null = null;

async function ensureDir() {
  const info = await FS.getInfoAsync(DIR);
  if (!info.exists) await FS.makeDirectoryAsync(DIR, { intermediates: true });
}

let loading: Promise<DB> | null = null;
/** One read at a time: two screens asking at startup must share one library object. */
export function loadDB(): Promise<DB> {
  if (cache) return Promise.resolve(cache);
  if (!loading) loading = readDB().finally(() => (loading = null));
  return loading;
}

async function readDB(): Promise<DB> {
  if (cache) return cache;
  await ensureDir();
  const info = await FS.getInfoAsync(FILE);
  if (info.exists) {
    try {
      const db: any = JSON.parse(await FS.readAsStringAsync(FILE));
      // A half-written or older library file must never crash the app: keep only well-formed entries.
      cache = {
        version: 1,
        docs: Array.isArray(db?.docs) ? db.docs.filter((d: any) => d && typeof d.id === 'string') : [],
        chunks: Array.isArray(db?.chunks)
          ? db.chunks.filter((c: any) => c && typeof c.docId === 'string' && typeof c.text === 'string' && Array.isArray(c.vec))
          : [],
      };
      return cache;
    } catch {
      // fall through to a fresh library if the file is corrupt
    }
  }
  cache = { version: 1, docs: [], chunks: [] };
  return cache;
}

// Saves run one after another: two at once (a note being indexed while another is moved or removed) wrote the
// same temp file and could leave a broken library (v1.0.16).
let saving: Promise<void> = Promise.resolve();
function save(): Promise<void> {
  const job = async () => {
    if (!cache) return;
    await ensureDir();
    const tmp = FILE + '.tmp';
    await FS.writeAsStringAsync(tmp, JSON.stringify(cache));
    await FS.moveAsync({ from: tmp, to: FILE }).catch(async () => {
      await FS.writeAsStringAsync(FILE, JSON.stringify(cache));
    });
  };
  const p = saving.then(job, job);
  saving = p.catch(() => {});
  return p;
}

/** Saves fact counts for notes added before v1.0.16 (worked out once, then kept). */
export async function setDocFactCounts(counts: Record<string, number>) {
  const db = await loadDB();
  let changed = false;
  for (const d of db.docs) {
    if (typeof counts[d.id] === 'number' && d.factCount !== counts[d.id]) {
      d.factCount = counts[d.id];
      changed = true;
    }
  }
  if (changed) await save();
}

export async function addDoc(doc: NoteDoc, chunks: StoredChunk[]) {
  const db = await loadDB();
  db.docs.unshift(doc);
  db.chunks.push(...chunks);
  await save();
}

export async function removeDoc(docId: string) {
  const db = await loadDB();
  db.docs = db.docs.filter((d) => d.id !== docId);
  db.chunks = db.chunks.filter((c) => c.docId !== docId);
  await save();
}

export async function setDocSubject(docId: string, subject: string) {
  const db = await loadDB();
  const d = db.docs.find((x) => x.id === docId);
  if (d) d.subject = subject.trim() || GENERAL;
  await save();
}

export async function clearAll() {
  cache = { version: 1, docs: [], chunks: [] };
  await save();
}

export function roundVec(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => Math.round((x / n) * 1e4) / 1e4);
}

export function makeId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Saved chat & quiz history (survives closing the app) ----------
const HISTORY = DIR + 'history.json';
export async function loadHistory<T = any>(): Promise<T | null> {
  try {
    const info = await FS.getInfoAsync(HISTORY);
    if (!info.exists) return null;
    return JSON.parse(await FS.readAsStringAsync(HISTORY)) as T;
  } catch {
    return null;
  }
}
let historySaving: Promise<void> = Promise.resolve();
/** Written to a temp file first, one save at a time, so closing the app mid-save never leaves broken history. */
export function saveHistory(data: unknown): Promise<void> {
  const job = async () => {
    try {
      await ensureDir();
      const tmp = HISTORY + '.tmp';
      await FS.writeAsStringAsync(tmp, JSON.stringify(data));
      await FS.moveAsync({ from: tmp, to: HISTORY }).catch(() => FS.writeAsStringAsync(HISTORY, JSON.stringify(data)));
    } catch {}
  };
  const p = historySaving.then(job, job);
  historySaving = p;
  return p;
}
