// Splits note text into overlapping, sentence-aware chunks sized for a small
// on-device embedding model and a ~4k-token LLM context.

export type RawChunk = { text: string; page?: number };

const TARGET = 700; // characters per chunk (≈ 150–180 tokens)
const MAX = 1000;
const OVERLAP = 120;

export function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/(\w)-\n(\w)/g, '$1$2') // join hyphenated line breaks
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitSentences(paragraph: string): string[] {
  const parts = paragraph.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g);
  return (parts ?? [paragraph]).map((s) => s.trim()).filter(Boolean);
}

export function chunkText(text: string, page?: number): RawChunk[] {
  const clean = normalise(text);
  if (!clean) return [];
  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const chunks: RawChunk[] = [];
  let buf = '';

  const flush = () => {
    const t = buf.trim();
    if (t.length > 20) chunks.push({ text: t, page });
    // keep a tail for overlap so ideas split across chunks still match
    buf = t.length > OVERLAP ? t.slice(t.length - OVERLAP).replace(/^\S*\s/, '') : '';
  };

  for (const para of paragraphs) {
    for (let sentence of splitSentences(para)) {
      while (sentence.length > MAX) {
        // very long run-on text: hard-split
        if (buf) flush();
        buf = sentence.slice(0, MAX);
        sentence = sentence.slice(MAX);
        flush();
      }
      if (buf.length + sentence.length + 1 > TARGET && buf.length > OVERLAP + 40) flush();
      buf += (buf ? ' ' : '') + sentence;
    }
    if (buf.length > TARGET * 0.6) flush();
  }
  if (buf.trim().length > 20) chunks.push({ text: buf.trim(), page });
  // drop exact duplicates created by overlap at the very end
  return chunks.filter((c, i) => i === 0 || c.text !== chunks[i - 1].text);
}

export function chunkPages(pages: string[]): RawChunk[] {
  const out: RawChunk[] = [];
  pages.forEach((p, i) => out.push(...chunkText(p, i + 1)));
  return out;
}
