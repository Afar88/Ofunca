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
};

export type StoredChunk = {
  id: string;
  docId: string;
  page?: number;
  text: string;
  vec: number[]; // L2-normalised embedding
};

type DB = { version: 1; docs: NoteDoc[]; chunks: StoredChunk[] };

const DIR = (FS.documentDirectory ?? '') + 'study-tutor/';
const FILE = DIR + 'library.json';

let cache: DB | null = null;

async function ensureDir() {
  const info = await FS.getInfoAsync(DIR);
  if (!info.exists) await FS.makeDirectoryAsync(DIR, { intermediates: true });
}

export async function loadDB(): Promise<DB> {
  if (cache) return cache;
  await ensureDir();
  const info = await FS.getInfoAsync(FILE);
  if (info.exists) {
    try {
      cache = JSON.parse(await FS.readAsStringAsync(FILE)) as DB;
      return cache;
    } catch {
      // fall through to a fresh library if the file is corrupt
    }
  }
  cache = { version: 1, docs: [], chunks: [] };
  return cache;
}

async function save() {
  if (!cache) return;
  await ensureDir();
  const tmp = FILE + '.tmp';
  await FS.writeAsStringAsync(tmp, JSON.stringify(cache));
  await FS.moveAsync({ from: tmp, to: FILE }).catch(async () => {
    await FS.writeAsStringAsync(FILE, JSON.stringify(cache));
  });
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
