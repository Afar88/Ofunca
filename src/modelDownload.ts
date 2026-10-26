// Resilient one-time model download, written for slow or flaky mobile networks.
//
// How a model gets onto the phone (first step that works wins):
//  1. Already in the QVAC cache -> nothing to do (finished models are never downloaded again).
//  2. HTTPS mirror (Hugging Face, pinned to the exact commit the QVAC catalog uses), downloaded by the
//     QVAC SDK's HTTP loader: it resumes from the partial file with HTTP Range requests, retries on its own
//     after a stall, and verifies the file against the Hub's SHA-256 (which equals the QVAC catalog
//     checksum; see MIRRORS below). The finished file is then moved to the exact path the QVAC registry
//     cache uses, so every later load is a normal catalog load: offline, size + SHA-256 checked by QVAC.
//  3. The QVAC registry (P2P), with longer stall timeouts and more retries (see qvac.config.json written
//     at startup). Used when a model has no mirror (OCR) or the mirror is refused.
// Each attempt that fails on a network error waits (backoff + until the phone is back online) and tries
// again. Partial mirror downloads stay on disk, so a retry continues from where it stopped.
//
// This file has no React Native imports so it can be tested in Node with the real SDK.

export type ModelKey = 'embed' | 'llm' | 'ocrRec' | 'ocrDet';

export type ModelSpec = {
  key: ModelKey;
  /** QVAC catalog name, e.g. EMBEDDINGGEMMA_300M_Q4_0 */
  name: string;
  /** QVAC catalog descriptor (registry source) */
  desc: any;
  fileName: string;
  expectedSize: number;
  sha256: string;
  /** Exact-same-file HTTPS mirror, or null when there is none. */
  mirrorUrl: string | null;
  /** First 16 hex chars of sha256(mirrorUrl): the QVAC SDK names its HTTP cache file `${hash}_${fileName}`. */
  mirrorCacheHash: string | null;
  /** Optional models (OCR) never block the app from starting. */
  optional: boolean;
};

export type DlStatus = 'idle' | 'checking' | 'downloading' | 'waiting' | 'verifying' | 'done' | 'paused';

export type DlState = {
  status: DlStatus;
  downloaded: number;
  total: number;
  source?: 'mirror' | 'registry' | 'file';
  note?: string;
  error?: string;
};

export type Deps = {
  getModelInfo: (name: string) => Promise<{ isCached: boolean; cachePath: string | null; partialSize?: number }>;
  downloadAsset: (opts: any) => Promise<string>;
  /** Absolute paths. Resolves false when `from` does not exist. */
  moveFile: (from: string, to: string) => Promise<boolean>;
  fileSize: (path: string) => Promise<number | null>;
  isOnline: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
};

export const RETRY_DELAYS_S = [3, 8, 15, 30, 45, 60, 60, 90];

export function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function mirrorPartialPath(spec: ModelSpec, cachePath: string): string | null {
  if (!spec.mirrorUrl || !spec.mirrorCacheHash) return null;
  return `${dirname(cachePath)}/${spec.mirrorCacheHash}_${spec.fileName}`;
}

function errText(e: any): string {
  return String(e?.message ?? e ?? 'Unknown error');
}

/** Errors where retrying the same source cannot help (bad bytes, refused source, 4xx). */
export function isHardError(e: any): boolean {
  const s = (errText(e) + ' ' + String(e?.name ?? '') + ' ' + String(e?.code ?? '')).toLowerCase();
  if (/checksum|insecure|not found|\b(401|403|404|410)\b|no space|enospc/.test(s)) return true;
  return false;
}

export function isCancelError(e: any): boolean {
  const s = (errText(e) + ' ' + String(e?.name ?? '')).toLowerCase();
  return s.includes('cancel');
}

/** Human-friendly one-liner for the UI. */
export function friendlyError(e: any): string {
  const s = errText(e);
  const l = s.toLowerCase();
  if (l.includes('enospc') || l.includes('no space')) return 'Not enough free storage on the phone.';
  if (l.includes('checksum')) return 'The downloaded file failed its integrity check and was discarded.';
  if (/timeout|timed out|stalled|econn|socket|network|connection|enotfound|eai_again|getaddrinfo/.test(l))
    return 'The network is too slow or dropped. Progress is saved.';
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

/**
 * Makes sure one model is in the QVAC cache. Resolves when it is; throws (after all retries) with the
 * last error otherwise. Safe to call again: completed models return at once and partial mirror downloads
 * are continued.
 */
export async function ensureModel(
  spec: ModelSpec,
  deps: Deps,
  onState: (s: DlState) => void,
  opts: { maxAttempts?: number; preferRegistry?: boolean; shouldStop?: () => boolean } = {},
): Promise<void> {
  const log = deps.log ?? (() => {});
  const total = spec.expectedSize;
  onState({ status: 'checking', downloaded: 0, total });
  let info = await deps.getModelInfo(spec.name);
  if (info.isCached) {
    onState({ status: 'done', downloaded: total, total });
    return;
  }
  const cachePath = info.cachePath;
  const partial = cachePath ? mirrorPartialPath(spec, cachePath) : null;

  // Mirror first (resumable over HTTP Range), registry as the second route.
  let sources: ('mirror' | 'registry')[] = spec.mirrorUrl && cachePath ? ['mirror', 'registry'] : ['registry'];
  if (opts.preferRegistry) sources = sources.slice().reverse();
  let srcIdx = 0;
  const bad = new Set<string>();
  const maxAttempts = opts.maxAttempts ?? RETRY_DELAYS_S.length + 1;
  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.shouldStop?.()) break;
    const source = sources[srcIdx];
    // Wait for a connection before spending an attempt.
    if (!(await deps.isOnline())) {
      for (let w = 0; w < 120 && !(await deps.isOnline()); w++) {
        if (opts.shouldStop?.()) break;
        onState({ status: 'waiting', downloaded: 0, total, source, note: 'Waiting for internet…' });
        await deps.sleep(2000);
      }
    }
    let start = 0;
    if (source === 'mirror' && partial) start = (await deps.fileSize(partial)) ?? 0;
    onState({
      status: 'downloading',
      downloaded: start,
      total,
      source,
      note: start > 0 ? `Resuming from ${(start / 1e6).toFixed(0)} MB` : attempt > 1 ? `Attempt ${attempt}` : undefined,
    });
    try {
      const onProgress = (p: any) => {
        const t = p?.total || total;
        onState({ status: 'downloading', downloaded: Math.min(p?.downloaded ?? 0, t), total: t, source });
      };
      if (source === 'mirror') {
        await deps.downloadAsset({
          assetSrc: spec.mirrorUrl,
          requireHttpChecksum: true, // Hugging Face exposes the SHA-256; refuse the file if it is missing or wrong
          requireSecureTransport: true,
          onProgress,
        });
        onState({ status: 'verifying', downloaded: total, total, source, note: 'Saving to model cache…' });
        const size = partial ? await deps.fileSize(partial) : null;
        if (size !== spec.expectedSize) throw new Error(`Mirror file has the wrong size (${size} bytes, expected ${spec.expectedSize}). checksum`);
        const moved = await deps.moveFile(partial!, cachePath!);
        if (!moved) throw new Error('Downloaded file not found where expected');
      } else {
        await deps.downloadAsset({ assetSrc: spec.desc, onProgress });
      }
      info = await deps.getModelInfo(spec.name);
      if (!info.isCached) throw new Error('Model file is incomplete after download');
      onState({ status: 'done', downloaded: total, total, source });
      return;
    } catch (e: any) {
      lastErr = e;
      log(`[${spec.key}] ${source} attempt ${attempt} failed: ${errText(e)}`);
      if (isCancelError(e) && opts.shouldStop?.()) break;
      if (isHardError(e)) {
        bad.add(source);
        const next = sources.findIndex((x) => !bad.has(x));
        if (next >= 0) {
          srcIdx = next; // this source cannot work; switch to the other one right away
          continue;
        }
      }
      if (attempt >= maxAttempts) break;
      const delay = RETRY_DELAYS_S[Math.min(attempt - 1, RETRY_DELAYS_S.length - 1)];
      const now = source === 'mirror' && partial ? (await deps.fileSize(partial)) ?? 0 : 0;
      for (let s = delay; s > 0; s--) {
        if (opts.shouldStop?.()) break;
        onState({ status: 'waiting', downloaded: now, total, source, note: `Network problem. Retrying in ${s}s…`, error: friendlyError(e) });
        await deps.sleep(1000);
      }
      // After several failed mirror tries, give the registry one go, then come back to the mirror.
      if (sources.length > 1 && attempt % 4 === 0) {
        const next = (srcIdx + 1) % sources.length;
        if (!bad.has(sources[next])) srcIdx = next;
      }
    }
  }
  const saved = partial ? (await deps.fileSize(partial)) ?? 0 : 0;
  onState({ status: 'paused', downloaded: saved, total, error: friendlyError(lastErr) });
  throw lastErr ?? new Error('Download stopped');
}

/** Bytes already saved for a model (finished = full size; partial mirror file otherwise). */
export async function savedBytes(spec: ModelSpec, deps: Deps): Promise<{ done: boolean; bytes: number }> {
  const info = await deps.getModelInfo(spec.name);
  if (info.isCached) return { done: true, bytes: spec.expectedSize };
  const partial = info.cachePath ? mirrorPartialPath(spec, info.cachePath) : null;
  const b = partial ? (await deps.fileSize(partial)) ?? 0 : 0;
  return { done: false, bytes: Math.max(b, 0) };
}

/** Match a user-picked file to a model by its exact byte size. */
export function matchBySize(specs: ModelSpec[], size: number | null | undefined): ModelSpec | null {
  if (!size) return null;
  return specs.find((s) => s.expectedSize === size) ?? null;
}
