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

export function buildAnswerPrompt(question: string, hits: Hit[]) {
  const context = hits
    .map((h, i) => `[${i + 1}] (${h.docName}${h.chunk.page ? `, p.${h.chunk.page}` : ''})\n${h.chunk.text}`)
    .join('\n\n');
  const system =
    'You are a friendly study tutor. Answer the student\'s question using ONLY the numbered note excerpts provided. ' +
    'Be clear and concise (2-5 sentences or a short list). After each fact, cite the excerpt number in square brackets like [1]. ' +
    `If the excerpts do not contain the answer, reply exactly: "${NOT_FOUND}" Do not use outside knowledge.`;
  const user = `Note excerpts:\n\n${context}\n\nQuestion: ${question}\n\nAnswer using only the excerpts, with [n] citations:`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

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
