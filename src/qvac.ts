// All AI in this app runs through the QVAC SDK, on the phone itself.
//  - EmbeddingGemma 300M (Q4_0) turns note chunks and questions into vectors.
//  - Llama 3.2 1B Instruct (Q4_0) writes answers and quiz questions.
// Models are downloaded once (the only time the network is used) and then
// loaded from the local QVAC cache, so every feature works in airplane mode.
import {
  cancel,
  completion,
  downloadAsset,
  embed,
  getModelInfo,
  getSystemResources,
  loadModel,
  unloadModel,
  EMBEDDINGGEMMA_300M_Q4_0,
  LLAMA_3_2_1B_INST_Q4_0,
  OCR_CRAFT,
  OCR_LATIN,
  VERBOSITY,
} from '@qvac/sdk';
import * as FS from 'expo-file-system/legacy';
import NetInfo from '@react-native-community/netinfo';
import {
  ensureModel,
  matchBySize,
  savedBytes,
  type Deps,
  type DlState,
  type ModelKey,
  type ModelSpec,
} from './modelDownload';

export const LLM_MODEL = LLAMA_3_2_1B_INST_Q4_0;
export const EMBED_MODEL = EMBEDDINGGEMMA_300M_Q4_0;

function spec(key: ModelKey, desc: any, mirrorUrl: string | null, mirrorCacheHash: string | null, optional: boolean): ModelSpec {
  return {
    key,
    name: desc.name,
    desc,
    fileName: desc.modelId,
    expectedSize: desc.expectedSize,
    sha256: desc.sha256Checksum,
    mirrorUrl,
    mirrorCacheHash,
    optional,
  };
}

// Mirrors: the same Hugging Face repo + commit the QVAC catalog entry points at (registryPath), served over
// HTTPS with Range support. Verified: x-linked-size and x-linked-etag (SHA-256) equal the catalog's
// expectedSize and sha256Checksum, and a full download hashed to the catalog checksum.
// mirrorCacheHash = sha256(url).slice(0, 16), the prefix the QVAC SDK gives its HTTP cache file.
export const MODEL_SPECS: ModelSpec[] = [
  spec(
    'embed',
    EMBEDDINGGEMMA_300M_Q4_0,
    'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/6661a6504c30d8304af13455cb4a5d4f5bc6011f/embeddinggemma-300m-Q4_0.gguf',
    '72c38be9867f8d88',
    false,
  ),
  spec(
    'llm',
    LLAMA_3_2_1B_INST_Q4_0,
    'https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/b69aef112e9f895e6f98d7ae0949f72ff09aa401/Llama-3.2-1B-Instruct-Q4_0.gguf',
    'ca1a6d15daaa09d4',
    false,
  ),
  // QVAC-compiled OCR models live only in the QVAC registry (no public mirror of these exact files).
  spec('ocrRec', OCR_LATIN, null, null, true),
  spec('ocrDet', OCR_CRAFT, null, null, true),
];

export const MODEL_GROUPS = [
  { id: 'embed', label: 'EmbeddingGemma 300M (Q4_0)', role: 'Understands your notes', keys: ['embed'] as ModelKey[] },
  { id: 'llm', label: 'Llama 3.2 1B Instruct (Q4_0)', role: 'Writes answers & quizzes', keys: ['llm'] as ModelKey[] },
  { id: 'ocr', label: 'QVAC OCR (Latin + text detector)', role: 'Reads photos of notes (optional)', keys: ['ocrRec', 'ocrDet'] as ModelKey[] },
];

export const MODELS = MODEL_GROUPS.slice(0, 2).map((g) => ({ ...g, approxMB: Math.round(MODEL_SPECS.find((m) => m.key === g.keys[0])!.expectedSize / 1e6) }));

export const specOf = (k: ModelKey) => MODEL_SPECS.find((m) => m.key === k)!;

export type Device = 'cpu' | 'gpu';

let llmId: string | null = null;
let embedId: string | null = null;
let loadedDevice: Device | null = null;

const toUri = (p: string) => (p.startsWith('file://') ? p : 'file://' + p);

/**
 * Runtime QVAC config, read by the SDK from <documents>/qvac.config.json when its worker starts.
 * Must be written before the first SDK call. Longer registry stall timeout + more retries for slow
 * mobile networks, longer HTTP connect timeout, HTTPS only.
 */
export async function writeQvacRuntimeConfig() {
  const cfg = {
    registryStreamTimeoutMs: 120000,
    registryDownloadMaxRetries: 6,
    httpConnectionTimeoutMs: 30000,
    requireSecureTransport: true,
    loggerLevel: 'warn',
  };
  try {
    await FS.writeAsStringAsync((FS.documentDirectory ?? '') + 'qvac.config.json', JSON.stringify(cfg));
  } catch {}
}

export const deps: Deps = {
  getModelInfo: async (name) => {
    const info: any = await getModelInfo({ name } as any);
    const f = info?.cacheFiles?.[0];
    return { isCached: !!info?.isCached, cachePath: f?.path ?? null, partialSize: f?.actualSize };
  },
  downloadAsset: (o) => downloadAsset(o),
  moveFile: async (from, to) => {
    const f = await FS.getInfoAsync(toUri(from));
    if (!f.exists) return false;
    await FS.deleteAsync(toUri(to), { idempotent: true });
    await FS.moveAsync({ from: toUri(from), to: toUri(to) });
    return true;
  },
  fileSize: async (p) => {
    try {
      const f: any = await FS.getInfoAsync(toUri(p));
      return f.exists ? f.size ?? 0 : null;
    } catch {
      return null;
    }
  },
  isOnline: async () => {
    try {
      const s = await NetInfo.fetch();
      return !!s.isConnected && s.isInternetReachable !== false;
    } catch {
      return true;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Which models are already complete on the device (no network needed). */
export async function modelsCached(): Promise<Record<ModelKey, boolean>> {
  const out: any = {};
  for (const m of MODEL_SPECS) {
    try {
      out[m.key] = (await deps.getModelInfo(m.name)).isCached;
    } catch {
      out[m.key] = false;
    }
  }
  return out;
}

/** Bytes already on the phone per model (finished or partial), for "Resume" UI. */
export async function savedProgress(): Promise<Record<ModelKey, { done: boolean; bytes: number }>> {
  const out: any = {};
  for (const m of MODEL_SPECS) {
    try {
      out[m.key] = await savedBytes(m, deps);
    } catch {
      out[m.key] = { done: false, bytes: 0 };
    }
  }
  return out;
}

let stopRequested = false;
export function stopDownloads() {
  stopRequested = true;
}

/**
 * Downloads every missing model, one at a time, with retries + resume (see modelDownload.ts).
 * Required models throw on failure; optional ones (OCR) are reported in the result instead.
 */
export async function downloadModels(
  keys: ModelKey[],
  onState: (key: ModelKey, s: DlState) => void,
): Promise<{ failedOptional: ModelKey[] }> {
  stopRequested = false;
  const failedOptional: ModelKey[] = [];
  for (const k of keys) {
    const m = specOf(k);
    try {
      await ensureModel(m, deps, (s) => onState(k, s), { shouldStop: () => stopRequested });
    } catch (e) {
      if (m.optional) failedOptional.push(k);
      else throw e;
    }
  }
  return { failedOptional };
}

/**
 * Loads a model file the user downloaded themselves (e.g. in Chrome) through the system file picker.
 * The file is identified by its exact size, copied into the QVAC cache path, then checked by QVAC
 * against the catalog SHA-256. No storage permission is needed (Storage Access Framework).
 */
export async function importPickedModel(
  picked: { uri: string; size?: number | null; name?: string },
  onStatus: (s: string) => void,
): Promise<ModelSpec> {
  const m = matchBySize(MODEL_SPECS, picked.size ?? null);
  if (!m) {
    throw new Error(
      `"${picked.name ?? 'This file'}" is not one of the model files (sizes don't match). Pick ${MODEL_SPECS.filter((x) => x.mirrorUrl)
        .map((x) => x.fileName)
        .join(' or ')}.`,
    );
  }
  const info = await deps.getModelInfo(m.name);
  if (info.isCached) return m;
  if (!info.cachePath) throw new Error('QVAC cache path unavailable');
  const tmp = info.cachePath + '.import';
  onStatus(`Copying ${m.fileName}…`);
  await FS.deleteAsync(toUri(tmp), { idempotent: true });
  await FS.copyAsync({ from: picked.uri, to: toUri(tmp) });
  const size = await deps.fileSize(tmp);
  if (size !== m.expectedSize) {
    await FS.deleteAsync(toUri(tmp), { idempotent: true });
    throw new Error('The copy is incomplete. Please try again.');
  }
  await deps.moveFile(tmp, info.cachePath);
  onStatus(`Checking ${m.fileName} (SHA-256)…`);
  // A cache hit makes QVAC hash the file against the catalog and report 100% at once. A mismatch makes it
  // delete the file and start a registry download, which we cancel and report as a bad file.
  let mismatch = false;
  const op = downloadAsset({
    assetSrc: m.desc,
    onProgress: (p: any) => {
      if (!mismatch && p.total && p.downloaded < p.total) {
        mismatch = true;
        cancel({ requestId: op.requestId } as any).catch(() => {});
      }
    },
  });
  try {
    await op;
  } catch {
    // reported below from the cache state
  }
  if (mismatch || !(await deps.getModelInfo(m.name)).isCached) {
    throw new Error(`${m.fileName} did not match the expected checksum and was removed. Download it again.`);
  }
  return m;
}

// Phone CPUs mix fast and slow cores. 4 threads keeps llama.cpp on the fast cores, which is
// usually much quicker than spreading work over all 8 (the slow cores hold everyone back).
// Never use more threads than the phone has cores: oversubscribing made answers ~15x slower in tests.
async function cpuThreads(): Promise<number> {
  try {
    const r: any = await getSystemResources();
    const cpu = r?.capabilities?.cpu?.value;
    const cores = Number(cpu?.physicalCores?.value || cpu?.logicalCores?.value || 0);
    if (cores > 0) return cores >= 6 ? 4 : Math.max(1, cores);
  } catch {}
  return 4;
}

/** Loads the small embedding model first (fast) so notes can be added while the LLM loads. */
export async function loadEmbedModel(device: Device) {
  if (embedId && loadedDevice === device) return;
  if (loadedDevice && loadedDevice !== device) await unloadAll();
  embedId = await loadModel({
    modelSrc: EMBED_MODEL,
    modelType: 'embeddings',
    modelConfig: { device, verbosity: VERBOSITY.ERROR } as any,
  });
  loadedDevice = device;
}

export async function loadLlmModel(device: Device) {
  if (llmId && loadedDevice === device) return;
  const threads = await cpuThreads();
  llmId = await loadModel({
    modelSrc: LLM_MODEL,
    modelType: 'llm',
    // 2048 tokens is plenty for 3 short passages + answer, and halves memory/setup vs 4096.
    modelConfig: { device, ctx_size: 2048, threads, verbosity: VERBOSITY.ERROR } as any,
  });
  loadedDevice = device;
}

/** Runs one tiny generation so the first real question doesn't pay the warm-up cost. */
export async function warmUp() {
  if (!llmId) return;
  try {
    const run: any = completion({
      modelId: llmId,
      history: [{ role: 'user', content: 'Hi' }],
      stream: true,
      generationParams: { predict: 1, temp: 0 },
    } as any);
    for await (const _ of run.events) {
    }
  } catch {}
}

/** Loads both models into memory from the local cache. Works offline once downloaded. */
export async function loadModels(device: Device, onStatus?: (s: string) => void) {
  onStatus?.('Preparing note search…');
  await loadEmbedModel(device);
  onStatus?.('Preparing the tutor…');
  await loadLlmModel(device);
}

export function isEmbedReady() {
  return !!embedId;
}

let activeRequest: string | null = null;
/** Stops the answer that is being written right now (keeps what was written so far). */
export function stopGenerating() {
  if (activeRequest) cancel({ requestId: activeRequest } as any).catch(() => {});
}

export async function unloadAll() {
  const ids = [llmId, embedId].filter(Boolean) as string[];
  llmId = embedId = null;
  loadedDevice = null;
  for (const id of ids) {
    try {
      await unloadModel({ modelId: id, clearStorage: false });
    } catch {}
  }
}

export function isReady() {
  return !!llmId && !!embedId;
}

// EmbeddingGemma was trained with task prompts; using them improves retrieval.
const DOC_PREFIX = 'title: none | text: ';
const QUERY_PREFIX = 'task: search result | query: ';

export async function embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
  if (!embedId) throw new Error('Models are not loaded yet');
  const out: number[][] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => DOC_PREFIX + t);
    const { embedding } = await embed({ modelId: embedId, text: batch });
    out.push(...embedding);
    onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
  }
  return out;
}

export async function embedQuery(q: string): Promise<number[]> {
  if (!embedId) throw new Error('Models are not loaded yet');
  const { embedding } = await embed({ modelId: embedId, text: QUERY_PREFIX + q });
  return embedding;
}

export type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

/** Streams an answer token by token. */
export async function generate(
  history: ChatMsg[],
  onToken: (fullText: string) => void,
  opts: { maxTokens?: number; temp?: number; jsonSchema?: object } = {},
): Promise<string> {
  if (!llmId) throw new Error('Models are not loaded yet');
  const run = completion({
    modelId: llmId,
    history,
    stream: true,
    generationParams: { temp: opts.temp ?? 0.2, predict: opts.maxTokens ?? 400, top_p: 0.9, repeat_penalty: 1.15 },
    ...(opts.jsonSchema
      ? { responseFormat: { type: 'json_schema', json_schema: { name: 'quiz', schema: opts.jsonSchema } } }
      : {}),
  } as any);
  activeRequest = (run as any).requestId ?? null;
  let acc = '';
  let last = 0;
  try {
    for await (const ev of (run as any).events as AsyncIterable<any>) {
      if (ev?.type === 'contentDelta' && typeof ev.text === 'string') {
        acc += ev.text;
        // Repaint at most ~12 times a second: smoother scrolling, less work for the phone.
        const now = Date.now();
        if (now - last > 80) {
          last = now;
          onToken(acc);
        }
      }
    }
    try {
      const fin = await (run as any).final;
      if (fin?.content && fin.content.length >= acc.length) acc = fin.content;
    } catch {}
  } finally {
    activeRequest = null;
  }
  onToken(acc);
  return acc.trim();
}
