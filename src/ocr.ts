// "Snap notes": on-device OCR of a photographed page via QVAC's OCR engine.
// The detector + Latin recogniser models ship inside the app (no download)
// and run locally, so this works in airplane mode too.
import { loadModel, ocr, unloadModel, OCR_LATIN } from '@qvac/sdk';
import * as ImageManipulator from 'expo-image-manipulator';
import { modelsCached } from './qvac';

export const OCR_MODEL = OCR_LATIN;
export const OCR_APPROX_MB = 98; // recogniser (~15 MB) + CRAFT text detector (~83 MB)

let ocrId: string | null = null;

/** True when both OCR files (recogniser + detector) are on the phone. */
export async function ocrCached() {
  const c = await modelsCached();
  return c.ocrRec && c.ocrDet;
}

async function ensureOcr() {
  if (ocrId) return ocrId;
  ocrId = await loadModel({
    modelSrc: OCR_MODEL,
    modelType: 'ocr',
    modelConfig: {
      langList: ['en'],
      magRatio: 1.0,
      canvasSize: 1280, // keeps the text detector's memory small so phones don't run out
      backendDevice: 'cpu',
      nThreads: 4,
      defaultRotationAngles: [], // photos are usually upright; skipping rotations is much faster
      contrastRetry: false,
      lowConfidenceThreshold: 0.5,
      recognizerBatchSize: 1,
    },
  } as any);
  return ocrId;
}

export async function releaseOcr() {
  if (!ocrId) return;
  const id = ocrId;
  ocrId = null;
  try {
    await unloadModel({ modelId: id, clearStorage: false });
  } catch {}
}

export type OcrResult = {
  text: string;
  avgConfidence: number;
  lowConfidenceLines: string[];
  lineCount: number;
};

type Block = { text: string; confidence?: number; bbox?: number[] };

/** Groups word blocks into reading-order lines using their bounding boxes. */
function toLines(blocks: Block[]): { text: string; conf: number }[] {
  const items = blocks
    .filter((b) => b.text && b.text.trim())
    .map((b) => {
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = b.bbox ?? [];
      return { text: b.text.trim(), conf: b.confidence ?? 1, x: x1, cy: (y1 + y2) / 2, h: Math.max(1, y2 - y1) };
    })
    .sort((a, b) => a.cy - b.cy || a.x - b.x);
  const lines: { parts: typeof items; cy: number; h: number }[] = [];
  for (const it of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(it.cy - line.cy) < Math.max(line.h, it.h) * 0.55) {
      line.parts.push(it);
    } else {
      lines.push({ parts: [it], cy: it.cy, h: it.h });
    }
  }
  return lines.map((l) => {
    const parts = l.parts.sort((a, b) => a.x - b.x);
    const conf = parts.reduce((s, p) => s + p.conf, 0) / parts.length;
    return { text: parts.map((p) => p.text).join(' '), conf };
  });
}

export async function recognise(imageUri: string, onStatus?: (s: string) => void): Promise<OcrResult> {
  onStatus?.('Preparing photo…');
  // Downscale big camera photos: faster OCR and lower memory, with no visible accuracy loss on pages.
  const small = await ImageManipulator.manipulateAsync(imageUri, [{ resize: { width: 1280 } }], {
    compress: 0.9,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  onStatus?.('Loading OCR model…');
  const modelId = await ensureOcr();
  onStatus?.('Reading text on your phone…');
  const path = decodeURI(small.uri.replace(/^file:\/\//, ''));
  const { blocks } = ocr({ modelId, image: path, options: { paragraph: false } } as any);
  const result = (await blocks) as Block[];
  const lines = toLines(result);
  const avg = lines.length ? lines.reduce((s, l) => s + l.conf, 0) / lines.length : 0;
  return {
    text: lines.map((l) => l.text).join('\n'),
    avgConfidence: avg,
    lowConfidenceLines: lines.filter((l) => l.conf < 0.6).map((l) => l.text),
    lineCount: lines.length,
  };
}
