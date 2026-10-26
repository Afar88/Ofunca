// All AI in this app runs through the QVAC SDK, on the phone itself.
//  - EmbeddingGemma 300M (Q4_0) turns note chunks and questions into vectors.
//  - Llama 3.2 1B Instruct (Q4_0) writes answers and quiz questions.
// Models are downloaded once (the only time the network is used) and then
// loaded from the local QVAC cache, so every feature works in airplane mode.
import {
  completion,
  downloadAsset,
  embed,
  getModelInfo,
  loadModel,
  unloadModel,
  EMBEDDINGGEMMA_300M_Q4_0,
  LLAMA_3_2_1B_INST_Q4_0,
  VERBOSITY,
  type ModelProgressUpdate,
} from '@qvac/sdk';

export const LLM_MODEL = LLAMA_3_2_1B_INST_Q4_0;
export const EMBED_MODEL = EMBEDDINGGEMMA_300M_Q4_0;

export const MODELS = [
  { key: 'embed', label: 'EmbeddingGemma 300M (Q4_0)', role: 'Understands your notes', src: EMBED_MODEL, approxMB: 278 },
  { key: 'llm', label: 'Llama 3.2 1B Instruct (Q4_0)', role: 'Writes answers & quizzes', src: LLM_MODEL, approxMB: 773 },
] as const;

export type Device = 'cpu' | 'gpu';

let llmId: string | null = null;
let embedId: string | null = null;
let loadedDevice: Device | null = null;

function registryName(src: unknown): string {
  const s = src as { name?: string; registryPath?: string };
  return s?.name ?? s?.registryPath ?? String(src);
}

/** True when both model files are already on the device (no network needed). */
export async function modelsCached(): Promise<{ embed: boolean; llm: boolean }> {
  const check = async (src: unknown) => {
    try {
      const info = await getModelInfo({ name: registryName(src) } as any);
      return !!info?.isCached;
    } catch {
      return false;
    }
  };
  const [e, l] = await Promise.all([check(EMBED_MODEL), check(LLM_MODEL)]);
  return { embed: e, llm: l };
}

/** One-time download of both models (requires internet). Safe to call again: cached files are reused. */
export async function downloadModels(onProgress: (key: 'embed' | 'llm', pct: number, mb?: string) => void) {
  for (const m of MODELS) {
    await downloadAsset({
      assetSrc: m.src,
      onProgress: (p: ModelProgressUpdate) => {
        const mb = p.total ? `${(p.downloaded / 1e6).toFixed(0)} / ${(p.total / 1e6).toFixed(0)} MB` : undefined;
        onProgress(m.key, Math.round(p.percentage ?? 0), mb);
      },
    });
    onProgress(m.key, 100);
  }
}

/** Loads both models into memory from the local cache. Works offline once downloaded. */
export async function loadModels(device: Device, onStatus?: (s: string) => void) {
  if (llmId && embedId && loadedDevice === device) return;
  await unloadAll();
  onStatus?.('Loading embedding model…');
  embedId = await loadModel({
    modelSrc: EMBED_MODEL,
    modelType: 'embeddings',
    modelConfig: { device, verbosity: VERBOSITY.ERROR } as any,
  });
  onStatus?.('Loading language model…');
  llmId = await loadModel({
    modelSrc: LLM_MODEL,
    modelType: 'llm',
    modelConfig: { device, ctx_size: 4096, verbosity: VERBOSITY.ERROR } as any,
  });
  loadedDevice = device;
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
  const BATCH = 8;
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
    generationParams: { temp: opts.temp ?? 0.2, predict: opts.maxTokens ?? 400, top_p: 0.9 },
    ...(opts.jsonSchema
      ? { responseFormat: { type: 'json_schema', json_schema: { name: 'quiz', schema: opts.jsonSchema } } }
      : {}),
  } as any);
  let acc = '';
  for await (const ev of (run as any).events as AsyncIterable<any>) {
    if (ev?.type === 'contentDelta' && typeof ev.text === 'string') {
      acc += ev.text;
      onToken(acc);
    }
  }
  try {
    const fin = await (run as any).final;
    if (fin?.content && fin.content.length >= acc.length) acc = fin.content;
  } catch {}
  return acc.trim();
}
