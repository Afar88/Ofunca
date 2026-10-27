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
    'You are Ofunca, a tutor. Answer ONLY the exact question asked, using ONLY the numbered note excerpts. ' +
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
    'You are Ofunca, a tutor. The student is replying to your earlier answer. Use ONLY the note excerpts and your earlier answer. ' +
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

// Multiple choice: the model writes the right answer plus 3 wrong ones, the app shuffles and marks taps.
export const MCQ_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
    wrong: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
  },
  required: ['question', 'answer', 'wrong'],
};

function trimExcerpt(t: string, max = 520) {
  // ~520 characters (~120 tokens) is enough for one question and keeps the phone's reading time short.
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut;
}

const MCQ_ANGLES = [
  'Ask about a different item, term or list entry than the questions already asked.',
  'Ask about a number, name, date or definition in these notes.',
  'Ask about a purpose, cause, effect or example in these notes.',
];

/** Later visits to the same passage read a different slice of it, starting at a sentence boundary. */
export function excerptWindow(t: string, round: number, size = 520): string {
  if (!round || t.length <= size) return t;
  const step = Math.max(160, Math.floor((t.length - size) / 2) || 160);
  let start = (round * step) % Math.max(1, t.length - Math.floor(size / 2));
  const dot = t.slice(start, start + 160).search(/[.!?\n]\s+/);
  if (dot >= 0) start += dot + 1;
  return t.slice(start).trimStart();
}

export function buildMcqPrompt(excerpt: string, avoid: string[] = [], round = 0) {
  // Short prompt + trimmed excerpt: on CPU most of the wait is the phone reading the prompt.
  const system =
    'Write one multiple-choice revision question answerable from the notes. Ask it directly, like an exam question: never mention "the excerpt", "the notes" or "the text". ' +
    'Correct answer plus three believable wrong ones, each a few words. JSON only.';
  const user =
    `Notes:\n${trimExcerpt(excerptWindow(excerpt, round))}\n\n` +
    (round ? `${MCQ_ANGLES[(round - 1) % MCQ_ANGLES.length]}\n\n` : '') +
    (avoid.length ? `Already asked (ask about something different): ${avoid.map((q) => `"${q}"`).join('; ')}\n\n` : '') +
    'Write one new multiple-choice question about these notes. Return JSON like {"question":"...","answer":"...","wrong":["...","...","..."]}';
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

const DUP_STOP = new Set(
  'a an the of to in on for and or is are was were be been what which who whom why how when where does do did can could should would about with from by as at it its this that these those into than then there their according mentioned stated described note notes excerpt text passage primary main'.split(' '),
);
const normQ = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const qTokens = (q: string) => new Set(normQ(q).split(' ').filter((w) => (w.length > 1 || /\d/.test(w)) && !DUP_STOP.has(w)));

/** True when a new quiz question is the same as (or a light rewording of) one already in the quiz. */
export function isNearDuplicate(q: string, prior: string[]): boolean {
  const n = normQ(q);
  if (!n) return true;
  const t = qTokens(q);
  const stem = n.split(' ').slice(0, 7).join(' ');
  for (const p of prior) {
    const pn = normQ(p);
    if (pn === n) return true;
    if (stem.split(' ').length >= 5 && pn.split(' ').slice(0, 7).join(' ') === stem) return true; // same question opening
    const pt = qTokens(p);
    if (!t.size || !pt.size) continue;
    let both = 0;
    for (const w of t) if (pt.has(w)) both++;
    const jaccard = both / (t.size + pt.size - both);
    const overlap = both / Math.min(t.size, pt.size);
    if (jaccard >= 0.6 || (overlap >= 0.85 && Math.min(t.size, pt.size) >= 3)) return true;
  }
  return false;
}

/** Earlier questions to show the model: ones from the same passage first (most likely to repeat), then the
 *  newest, trimmed to ~450 characters so the prompt stays small. Every question is still checked in code. */
export function quizAvoidList(asked: { q: string; src: string }[], src: string, maxChars = 450): string[] {
  const order = [...asked.filter((a) => a.src === src).reverse(), ...asked.filter((a) => a.src !== src).reverse()];
  const out: string[] = [];
  let len = 0;
  for (const a of order) {
    if (len + a.q.length > maxChars) break;
    out.push(a.q);
    len += a.q.length + 4;
  }
  return out;
}

/** Removes small-model filler like ", as mentioned in the note excerpt" from a question. */
export function tidyQuestion(q: string): string {
  return q
    .replace(/,?\s*(?:as\s+)?(?:mentioned|stated|described|given|discussed|explained|outlined)\s+in\s+the\s+(?:note\s+|given\s+)?(?:excerpts?|notes?|text|passage)\b/gi, '')
    .replace(/^\s*(?:according\s+to|based\s+on|in)\s+the\s+(?:note\s+|given\s+)?(?:excerpts?|notes?|text|passage)\s*,\s*/i, '')
    .replace(/\s+([?.!,])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function parseMcq(raw: string): { question: string; answer: string; options: string[]; correct: number } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const o = JSON.parse(m ? m[0] : raw);
    const q = typeof o?.question === 'string' ? tidyQuestion(o.question.trim()) : '';
    const a = typeof o?.answer === 'string' ? o.answer.trim() : '';
    if (!q || !a) return null;
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const wrong: string[] = [];
    for (const w of Array.isArray(o.wrong) ? o.wrong : []) {
      const t = typeof w === 'string' ? w.trim() : '';
      if (t && norm(t) !== norm(a) && !wrong.some((x) => norm(x) === norm(t))) wrong.push(t);
    }
    if (wrong.length < 2) return null;
    const options = [a, ...wrong.slice(0, 3)];
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    return { question: q, answer: a, options, correct: options.indexOf(a) };
  } catch {
    return null;
  }
}

/** n excerpts for an n-question quiz. When groupOf is given (mixed subjects), takes turns between
 *  subjects so every subject gets a fair share; repeats excerpts when the notes are short. */
export function quizExcerpts(chunks: StoredChunk[], n: number, groupOf?: (c: StoredChunk) => string): StoredChunk[] {
  const shuffle = <T,>(a: T[]) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const groups = new Map<string, StoredChunk[]>();
  for (const c of chunks) {
    const k = groupOf ? groupOf(c) : '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  const pools = shuffle([...groups.values()]).map((g) => {
    const rich = g.filter((c) => c.text.length > 200);
    return shuffle((rich.length ? rich : g).slice());
  });
  const out: StoredChunk[] = [];
  for (let i = 0; out.length < n && pools.length; i++) {
    const pool = pools[i % pools.length];
    out.push(pool[Math.floor(i / pools.length) % pool.length]);
  }
  return out;
}

// ---------- Answer-key check (v1.0.14) ----------
// The small on-device model sometimes keys the wrong option. Each option is scored by how much of it
// appears in the source excerpt (content words only); a clearly unsupported key next to one clearly
// supported option is re-keyed, and anything ambiguous is dropped so the quiz moves to the next passage.
const KEY_STOP = new Set([
  ...DUP_STOP,
  'not', 'no', 'all', 'none', 'only', 'more', 'most', 'less', 'very', 'also', 'such', 'other', 'some', 'any', 'has', 'have', 'had', 'will', 'may', 'must',
]);
const keyStem = (w: string) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const keyNorm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyWords = (t: string) => keyNorm(t).split(' ').filter((w) => (w.length > 2 || /\d/.test(w)) && !KEY_STOP.has(w)).map(keyStem);

/** 0..1 share of an option's content words found in the excerpt; 1.05 when the option appears verbatim. */
export function optionSupport(option: string, excerpt: string): number {
  const ex = ` ${keyNorm(excerpt)} `;
  const on = keyNorm(option);
  const words = keyWords(option);
  if (on && on.split(' ').length >= 2 && ex.includes(` ${on} `)) return 1.05;
  if (!words.length) return 0;
  const exSet = new Set(keyWords(excerpt));
  return words.filter((w) => exSet.has(w)).length / words.length;
}

const STRONG = 0.8;
const WEAK = 0.5;

/** Checks an MCQ's answer key against its source excerpt. Returns the question (re-keyed if needed) or null to discard. */
export function checkMcqKey<T extends { answer: string; options: string[]; correct: number }>(q: T, excerpt: string): T | null {
  if (q.correct < 0 || q.correct >= q.options.length) return null;
  const scores = q.options.map((o) => optionSupport(o, excerpt));
  const strong = scores.map((s, i) => (s >= STRONG ? i : -1)).filter((i) => i >= 0);
  const top = Math.max(...scores);
  const tied = strong.filter((i) => top - scores[i] < 0.05);
  if (tied.length >= 2) return null; // two or more options equally backed by the notes: ambiguous
  const key = scores[q.correct];
  if (key >= STRONG) return strong.length === 1 || scores[q.correct] === top ? q : null;
  if (strong.length === 1) {
    if (key < WEAK) return { ...q, answer: q.options[strong[0]], correct: strong[0] }; // re-key to the one supported option
    return null; // key half-supported while another option is fully supported: unclear, skip
  }
  if (strong.length >= 2) return null;
  return q; // nothing clearly supported (paraphrased idea): keep the model's key
}

/** Starts a shown excerpt at a sentence or word boundary instead of mid-word. */
export function tidySnippetStart(t: string): string {
  const s = t.trimStart();
  if (!s || /^[A-Z0-9“"(\-•]/.test(s)) return s;
  const head = s.slice(0, 120);
  const m = head.match(/[.!?;:]\s+(?=[A-Z0-9“"(])/);
  if (m && m.index !== undefined) return s.slice(m.index + m[0].length);
  const sp = s.indexOf(' ');
  return sp > 0 && sp < 25 ? s.slice(sp + 1) : s;
}
