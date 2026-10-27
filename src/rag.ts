// Retrieval-augmented answering over the user's own notes, fully on-device.
import type { StoredChunk } from './store';

export type Hit = { chunk: StoredChunk; score: number; docName: string };

const STOP = new Set(
  'a an the of to in on for and or is are was were be been what which who whom why how when where does do did can could should would about with from by as at it its this that these those into than then there their my your our explain define describe tell me'.split(
    ' ',
  ),
);

function keywords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

function dot(a: number[], b: number[]) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(v: number[]) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Hybrid search: cosine similarity on embeddings + a small keyword-overlap boost. */
export function search(
  queryVec: number[],
  query: string,
  chunks: StoredChunk[],
  docNames: Record<string, string>,
  k = 4,
): Hit[] {
  const q = norm(queryVec);
  const kws = keywords(query);
  const scored = chunks.map((c) => {
    let s = dot(q, c.vec);
    if (kws.length) {
      const lower = c.text.toLowerCase();
      const hits = kws.filter((w) => lower.includes(w)).length;
      s += 0.08 * (hits / kws.length);
    }
    return { chunk: c, score: s, docName: docNames[c.docId] ?? 'Notes' };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export const NOT_FOUND = "I couldn't find that in your notes.";

/**
 * Keeps only the passages that are really about the question: the best one, plus any others
 * that score almost as well. Fewer, sharper passages = shorter prompt (faster on a phone) and
 * answers that stick to exactly what was asked.
 */
export function focusHits(hits: Hit[], max = 3, margin = 0.06): Hit[] {
  if (!hits.length) return hits;
  const best = hits[0].score;
  return hits.filter((h, i) => i === 0 || h.score >= best - margin).slice(0, max);
}

export function buildAnswerPrompt(question: string, hits: Hit[]) {
  const context = hits
    .map((h, i) => `[${i + 1}] ${h.chunk.text}`)
    .join('\n\n');
  const system =
    'You are Ofunca, a study tutor. Answer ONLY the exact question asked, using ONLY the numbered note excerpts. ' +
    'Be short and direct: 1-3 sentences. Do not add other facts from the excerpts that the question did not ask about. ' +
    'Put the excerpt number in square brackets after the fact it supports, e.g. "It happens in the stroma [2]." ' +
    `If no excerpt answers the question, reply exactly: "${NOT_FOUND}"`;
  const user = `Note excerpts:\n${context}\n\nQuestion: ${question}\nShort answer:`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

/** Follow-up on an earlier answer ("make it shorter", or any reply), using the same passages. */
export function buildFollowUpPrompt(prevQuestion: string, prevAnswer: string, followUp: string, hits: Hit[]) {
  const context = hits.map((h, i) => `[${i + 1}] ${h.chunk.text}`).join('\n\n');
  const system =
    'You are Ofunca, a study tutor. The student is replying to your earlier answer. Use ONLY the note excerpts and your earlier answer. ' +
    'Do exactly what the student asks (for example: shorter, simpler, one point only). Keep it brief. ' +
    `If the excerpts cannot answer it, reply exactly: "${NOT_FOUND}"`;
  const user =
    `Note excerpts:\n${context}\n\nEarlier question: ${prevQuestion}\nYour earlier answer: ${prevAnswer}\n\n` +
    `Student's reply: ${followUp}\nAnswer:`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export const SHORTER = 'Give me a shorter version, in one simple sentence.';

export const QUIZ_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          source: { type: 'integer' },
        },
        required: ['question', 'answer', 'source'],
      },
    },
  },
  required: ['questions'],
};

export type QuizItem = { question: string; answer: string; source: number };

export function buildQuizPrompt(excerpts: StoredChunk[], count = 4) {
  const context = excerpts.map((c, i) => `[${i + 1}]\n${c.text}`).join('\n\n');
  const system =
    'You write short revision quizzes for students. Every question must be answerable from the given note excerpts alone. ' +
    'Keep questions specific and answers short (one sentence). Reply with JSON only.';
  const user =
    `Note excerpts:\n\n${context}\n\nWrite ${count} quiz questions that test understanding of these notes. ` +
    'For each, give the question, the correct short answer, and the excerpt number it comes from as "source". ' +
    'Return JSON like {"questions":[{"question":"...","answer":"...","source":1}]}';
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export function parseQuiz(raw: string, nExcerpts: number): QuizItem[] {
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let obj = tryParse(raw);
  if (!obj) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  const arr: any[] = Array.isArray(obj) ? obj : obj?.questions ?? [];
  return arr
    .filter((q) => q && typeof q.question === 'string' && typeof q.answer === 'string' && q.question.trim())
    .map((q) => ({
      question: q.question.trim(),
      answer: q.answer.trim(),
      source: Math.min(Math.max(1, Number(q.source) || 1), Math.max(1, nExcerpts)),
    }))
    .slice(0, 5);
}

/** Picks spread-out, content-rich chunks so quizzes cover more of the notes. */
export function pickQuizExcerpts(chunks: StoredChunk[], n = 4): StoredChunk[] {
  const rich = chunks.filter((c) => c.text.length > 200);
  const pool = rich.length >= n ? rich : chunks;
  if (pool.length <= n) return pool.slice();
  const start = Math.floor(Math.random() * pool.length);
  const step = Math.max(1, Math.floor(pool.length / n));
  const out: StoredChunk[] = [];
  for (let i = 0; i < n; i++) out.push(pool[(start + i * step) % pool.length]);
  return Array.from(new Set(out));
}

// One question per excerpt keeps a 1B model accurate and makes the source exact.
export const ONE_QUESTION_SCHEMA = {
  type: 'object',
  properties: { question: { type: 'string' }, answer: { type: 'string' } },
  required: ['question', 'answer'],
};

export function buildOneQuestionPrompt(excerpt: string, avoid: string[] = []) {
  const system =
    'You write revision quiz questions for students. The question must be answerable from the note excerpt alone. ' +
    'Ask about a key fact or idea, keep the answer short (one sentence). Reply with JSON only.';
  const user =
    `Note excerpt:\n${excerpt}\n\n` +
    (avoid.length ? `Do not repeat these questions: ${avoid.map((q) => `"${q}"`).join('; ')}\n\n` : '') +
    'Write one quiz question about this excerpt. Return JSON like {"question":"...","answer":"..."}';
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export function parseOneQuestion(raw: string): { question: string; answer: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const o = JSON.parse(m ? m[0] : raw);
    if (typeof o?.question === 'string' && typeof o?.answer === 'string' && o.question.trim()) {
      return { question: o.question.trim(), answer: o.answer.trim() };
    }
  } catch {}
  return null;
}

/** Tidies small-model quirks: a stray leading "[n]" and duplicated citations. */
export function cleanAnswer(text: string): string {
  // The chat shows plain answers: excerpt numbers like [1] are removed.
  return text
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Splits a message that asks several things ("What is osmosis? And what is inflation?")
 * into separate questions, so each one is searched and answered from its own notes.
 */
export function splitQuestions(text: string, max = 3): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  // 1) Numbered or bulleted lists: "1. ... 2) ... - ..."
  let parts = t.split(/\s*(?:^|\s)(?:\d+[.)]|[-•])\s+/).map((s) => s.trim()).filter(Boolean);
  // 2) Several question marks.
  if (parts.length < 2) parts = (t.match(/[^?]+\?/g) ?? []).map((s) => s.trim());
  const tail = t.replace(/[^?]*\?/g, '').trim();
  if (parts.length >= 2 && tail.length > 3 && !/^\d/.test(tail)) parts.push(tail);
  // 3) "... and what/how/why ..." joining two questions in one sentence.
  if (parts.length < 2) {
    parts = t.split(/\s*(?:,|;)?\s+(?:and|also|then)\s+(?=(?:what|how|why|who|whom|when|where|which|define|explain|describe|list|state|name|give)\b)/i);
  }
  const clean = parts
    .map((s) => s.replace(/^(?:and|also|then)\s+/i, '').trim())
    .filter((s) => s.replace(/[^a-z0-9]/gi, '').length >= 4);
  return clean.length >= 2 ? clean.slice(0, max) : [t];
}

/** Keeps the passages from the single note that best answers the question, so notes never blend. */
export function bestDocHits(hits: Hit[], max = 3): Hit[] {
  if (!hits.length) return hits;
  const doc = hits[0].chunk.docId;
  return focusHits(hits.filter((h) => h.chunk.docId === doc), max);
}
