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

/** Tidies small-model quirks: excerpt numbers and raw citation fragments like "[1. ..." never reach the chat. */
export function cleanAnswer(text: string): string {
  // The chat shows plain prose; sources are shown as cards under the answer.
  return String(text ?? '')
    .replace(/\s*\[\s*\d+(?:\s*[,;&-]\s*\d+)*\s*\]/g, '') // [1], [1, 2], [1-3]
    .replace(/\[\s*(?:excerpt|note|source|passage)?\s*\d+\s*[.:)\-]\s*/gi, '') // opening "[1. " / "[Excerpt 2: " of a quoted fragment
    .replace(/\(\s*(?:excerpt|source)\s*\d+\s*\)/gi, '')
    .replace(/\b(?:note\s+)?excerpts?\s*\d+\s*[:,-]?\s*/gi, '')
    .replace(/[\[\]]/g, '') // any bracket left over from a fragment
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
}

const NOT_FOUND_RE = /\s*(?:however,?\s*|but\s+)?(?:i\s+)?(?:couldn[’']?t|could\s+not|cannot|can[’']?t|was\s+unable\s+to|am\s+unable\s+to|did\s+not|didn[’']?t)\s+find\b[^.!?\n]*(?:[.!?]|$)/gi;

/** True when an answer says nothing but "not in your notes". */
export function isNotFound(answer: string): boolean {
  const a = String(answer ?? '').trim();
  if (!a) return true;
  return a.replace(NOT_FOUND_RE, '').replace(/[^a-z0-9]/gi, '').length < 3;
}

/** Removes a "couldn't find a direct answer" line that a small model tacks onto an answer that DID use the notes. */
export function dropNotFoundTail(answer: string): string {
  const a = String(answer ?? '').trim();
  if (isNotFound(a)) return a;
  const rest = a.replace(NOT_FOUND_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  return rest.replace(/[^a-z0-9]/gi, '').length >= 12 ? rest : a;
}

/** Ends a summary at its last full sentence (the token budget can cut the final one mid-way). */
export function endAtSentence(t: string): string {
  const s = t.trim();
  if (/[.!?]["”’)]?$/.test(s)) return s;
  const i = Math.max(s.lastIndexOf('. '), s.lastIndexOf('! '), s.lastIndexOf('? '));
  return i > 0 && i + 1 >= Math.min(40, s.length * 0.25) ? s.slice(0, i + 1) : s.replace(/[,;:\s]+$/, '') + '.';
}

const SUMMARY_RE = /\b(?:summar(?:y|i[sz]e|i[sz]ing)|sum\s+(?:it|this|them|up)|main\s+(?:ideas?|points?)|key\s+(?:ideas?|points?|takeaways?)|overview|gist|outline\s+(?:of|the)|in\s+brief|recap)\b/i;

/** "Summarise the main ideas", "give me an overview", "key points of chapter 2"… */
export function isSummaryRequest(q: string): boolean {
  return SUMMARY_RE.test(String(q ?? ''));
}

/** Summary prompt: unnumbered passages (nothing to cite, so no "[1. …" fragments), short plain prose, no refusal line. */
export function buildSummaryPrompt(request: string, hits: Hit[], perPassage = 520) {
  const context = hits.map((h) => trimExcerpt(tidySnippetStart(h.chunk.text), perPassage)).join('\n\n');
  const system =
    'You are Ofunca, a tutor. Summarise the notes for a student in 2-4 short, plain sentences of your own words. ' +
    'Cover only the main ideas in the notes. No lists, no numbers in brackets, no quotes, no headings. Never say you could not find something.';
  const user = `Notes:\n${context}\n\nRequest: ${request}\nSummary:`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
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

/** The exact passage text one quiz question is written from: a slice of the passage (different on revisits),
 *  with the sentences earlier questions already used taken out, so each question has to use a new fact. */
export function quizPassage(text: string, round = 0, used: string[] = []): string {
  const win = excerptWindow(text, round);
  if (!used.length) return trimExcerpt(win);
  const usedSet = new Set(used.map(keyNorm));
  const strip = (t: string) => sentencesOf(t).filter((x) => !usedSet.has(keyNorm(x))).join(' ');
  let fresh = strip(win);
  if (fresh.length < 160) fresh = strip(text); // this slice is used up: try the whole passage
  return trimExcerpt(fresh.length >= 120 ? fresh : win);
}

/** Builds the prompt from the passage text exactly as quizPassage() returns it (the key is checked against the same text). */
export function buildMcqPrompt(passage: string, avoid: string[] = [], round = 0) {
  // Short prompt + trimmed excerpt: on a phone most of the wait is reading the prompt.
  const system =
    'Write one multiple-choice revision question answerable from the notes. Ask it directly, like an exam question: never mention "the excerpt", "the notes" or "the text". ' +
    'Correct answer plus three believable wrong ones, each a few words, using the exact names, dates and numbers in the notes. JSON only.';
  const user =
    `Notes:\n${passage}\n\n` +
    (round ? `${MCQ_ANGLES[(round - 1) % MCQ_ANGLES.length]}\n\n` : '') +
    (avoid.length ? `Already asked, so pick a different fact and topic: ${avoid.map((q) => `"${q}"`).join('; ')}\n\n` : '') +
    'Write one new multiple-choice question about these notes. Return JSON like {"question":"...","answer":"...","wrong":["...","...","..."]}';
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

const BASE_STOP =
  'a an the of to in on for and or is are was were be been what which who whom why how when where does do did can could should would about with from by as at it its this that these those into than then there their according mentioned stated described note notes excerpt text passage primary main';
const DUP_STOP = new Set(`${BASE_STOP} following true correct best one two role purpose important key used use mean means meaning define definition type types example examples way ways part`.split(' '));
const dupStem = (w: string) =>
  w.length > 5 && w.endsWith('ing') ? w.slice(0, -3)
  : w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 4 && /(?:ss|sh|ch|x)es$/.test(w) ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1)
  : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2)
  : w;
const normQ = (q: string) => q.toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const qTokens = (q: string) => new Set(normQ(q).split(' ').filter((w) => (w.length > 1 || /\d/.test(w)) && !DUP_STOP.has(w)).map(dupStem));
/** Names, acronyms and numbers in a question ("OLX", "Jiji", "PA", "2019"): the entities it is about. */
// Names, acronyms and numbers. Each word maps to the capitalised run it came from, so "Public Affairs" counts
// as ONE entity when two questions are compared (a note that is all about one topic is not a "pair").
export function entitiesOf(q: string, skipFirst = true): Map<string, number> {
  const text = skipFirst ? String(q ?? '').replace(/^\s*\S+/, '') : String(q ?? ''); // a question's first word is capitalised anyway
  const runs = text.match(/\b[A-Z][a-zA-Z0-9]*(?:['’]s)?(?:\s+(?:of\s+|and\s+)?[A-Z][a-zA-Z0-9]*(?:['’]s)?)*|\b\d{2,}\b/g) ?? [];
  const out = new Map<string, number>();
  runs.forEach((r, i) => {
    for (const w of r.toLowerCase().replace(/['’]s\b/g, '').split(/\s+/)) {
      if (w.length > 1 && !DUP_STOP.has(w)) out.set(dupStem(w), i);
    }
  });
  return out;
}
const entities = entitiesOf;

/** Entities that appear in a large share of the passages (the subject itself, e.g. "Public Affairs"): sharing them
 *  says nothing about two questions being on the same topic. */
export function commonEntities(texts: string[], share = 0.4): Set<string> {
  const counts = new Map<string, number>();
  for (const t of texts) for (const e of entitiesOf(t, false).keys()) counts.set(e, (counts.get(e) ?? 0) + 1);
  const min = Math.max(2, Math.ceil(texts.length * share));
  return new Set([...counts].filter(([, c]) => c >= min).map(([e]) => e));
}

export type AskedQ = { q: string; a?: string; src?: string };

/** True when a new quiz question is the same as, a rewording of, or on the same topic/entities as one already in
 *  the quiz ("How did OLX and Jiji…" vs "What happened between OLX and Jiji…"). Answers count too. */
export function isNearDuplicate(q: string, prior: (string | AskedQ)[], answer = '', common: Set<string> = new Set()): boolean {
  const n = normQ(q);
  if (!n) return true;
  const t = qTokens(q);
  const tAll = qTokens(`${q} ${answer}`);
  const ent = entities(`${q} ${answer}`);
  const an = normQ(answer);
  const stem = n.split(' ').slice(0, 6).join(' ');
  for (const item of prior) {
    const p = typeof item === 'string' ? item : item.q;
    const pa = typeof item === 'string' ? '' : item.a ?? '';
    const pn = normQ(p);
    if (pn === n) return true;
    if (stem.split(' ').length >= 4 && pn.split(' ').slice(0, 6).join(' ') === stem) return true; // same question opening
    if (an && pa && an.length > 3 && normQ(pa) === an) return true; // same correct answer = same fact
    const pt = qTokens(p);
    if (t.size && pt.size) {
      let both = 0;
      for (const w of t) if (pt.has(w)) both++;
      const jaccard = both / (t.size + pt.size - both);
      const overlap = both / Math.min(t.size, pt.size);
      if (jaccard >= 0.5 || (both >= 2 && overlap >= 0.66)) return true; // same topic words, reworded
    }
    // Same pair of names/entities (two "OLX–Jiji" questions) = same topic.
    const pe = entities(`${p} ${pa}`);
    const runs = new Set<number>();
    for (const [e, run] of ent) if (pe.has(e) && !common.has(e)) runs.add(run);
    if (runs.size >= 2) return true;
    // Question + answer together share most of their topic words with an earlier question + answer.
    const pAll = qTokens(`${p} ${pa}`);
    if (tAll.size && pAll.size) {
      let both = 0;
      for (const w of tAll) if (pAll.has(w)) both++;
      if (both >= 3 && both / Math.min(tAll.size, pAll.size) >= 0.6) return true;
    }
  }
  return false;
}

/** Earlier questions to show the model: same passage first, then the newest, ~450 chars. Answers are NOT shown:
 *  the 1B model copies them into the next question. (Answers are still compared in code by isNearDuplicate.) */
export function quizAvoidList(asked: AskedQ[], src: string, maxChars = 450): string[] {
  const order = [...asked.filter((a) => a.src === src).reverse(), ...asked.filter((a) => a.src !== src).reverse()];
  const out: string[] = [];
  let len = 0;
  for (const a of order) {
    const line = a.q;
    if (len + line.length > maxChars) break;
    out.push(line);
    len += line.length + 4;
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
    // Not a question (a statement copied from the notes) or the answer is given away in the question: skip.
    const qn = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const an = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!/\?\s*$/.test(q) && !/^(?:what|which|who|whom|whose|why|how|when|where|name|define|state|list|give|identify|choose|select)\b/i.test(q)) return null;
    if (an && (qn === an || ` ${qn} `.includes(` ${an} `))) return null;
    // "To promote the public interest." and "Promote the public interest" are the same option.
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(?:to|the|a|an)\s+/, '');
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
  ...BASE_STOP.split(' '),
  'due', 'because', 'reason', 'order', 'so', 'help', 'helps',
  'not', 'no', 'all', 'none', 'only', 'more', 'most', 'less', 'very', 'also', 'such', 'other', 'some', 'any', 'has', 'have', 'had', 'will', 'may', 'must',
]);
// Light stemming so "promotes / promote / promoting" and "engage / engagement" meet.
const keyStem = (w: string) => {
  if (/^\d/.test(w)) return w;
  let x = w;
  if (x.length > 7 && x.endsWith('ment')) x = x.slice(0, -4);
  else if (x.length > 7 && /(?:ition|ation)$/.test(x)) x = x.slice(0, -5);
  else if (x.length > 6 && x.endsWith('ion')) x = x.slice(0, -3);
  else if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3);
  else if (x.length > 4 && x.endsWith('ies')) x = x.slice(0, -3) + 'y';
  else if (x.length > 4 && x.endsWith('ed')) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
  if (x.length > 3 && x.endsWith('e')) x = x.slice(0, -1);
  return x;
};
const keyNorm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyWords = (t: string) => keyNorm(t).split(' ').filter((w) => (w.length > 2 || /\d/.test(w)) && !KEY_STOP.has(w)).map(keyStem);

/** Sentences of a passage. Bare list numbers ("3.") and tiny fragments are joined to the next sentence. */
export function sentencesOf(t: string): string[] {
  const parts = (String(t ?? '').match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? []).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  let carry = '';
  for (const p of parts) {
    const x = carry ? `${carry} ${p}` : p;
    if (x.replace(/[^a-z]/gi, '').length < 6) carry = x;
    else {
      out.push(x);
      carry = '';
    }
  }
  if (carry) out.length ? (out[out.length - 1] += ` ${carry}`) : out.push(carry);
  return out;
}

const numsOf = (t: string) => new Set((String(t ?? '').replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []).map((x) => x.replace(/^0+(?=\d)/, '')));

/** 0..1 share of an option's content words found in a text; 1.05 when the option appears verbatim. */
function supportIn(option: string, text: string): number {
  const ex = ` ${keyNorm(text)} `;
  const on = keyNorm(option);
  const words = keyWords(option);
  if (on && on.split(' ').length >= 2 && ex.includes(` ${on} `)) return 1.05;
  if (!words.length) return 0;
  const exSet = new Set(keyWords(text));
  return words.filter((w) => exSet.has(w)).length / words.length;
}

/** Support for an option from ONE place in the passage (a sentence that talks about what the question asks, plus
 *  its neighbours), not from words scattered across the passage. Words the option merely repeats from the
 *  question ("OLX" in "Why did OLX…") earn nothing. A date or number in the option must sit in the sentence that
 *  best matches the question ("2019" when that sentence says 2020 is unsupported). */
export function optionSupport(option: string, excerpt: string, question = ''): number {
  const exNums = numsOf(excerpt);
  const optNums = numsOf(option);
  for (const n of optNums) if (!exNums.has(n)) return 0;
  const sents = sentencesOf(excerpt);
  const exWords = new Set(keyWords(excerpt));
  const qWords = new Set(keyWords(question));
  const optWords = keyWords(option);
  const anchors = [...qWords].filter((w) => exWords.has(w) && !optWords.includes(w));
  const sentWords = sents.map((x) => new Set(keyWords(x)));
  const rel = sentWords.map((ws) => (anchors.length ? anchors.filter((w) => ws.has(w)).length / anchors.length : 1));
  const bestRel = Math.max(0, ...rel);
  if (optNums.size && anchors.length) {
    // every number must appear in a sentence that is about the question's fact
    const ok = [...optNums].every((n) => sents.some((x, i) => rel[i] >= bestRel * 0.6 && numsOf(x).has(n)));
    if (!ok) return 0;
  }
  // Option words that only echo the question don't count (unless the option is nothing but those words).
  const own = optWords.filter((w) => !qWords.has(w));

  if (optWords.length && !own.length) return 0; // the option only repeats words from the question
  const score = (win: string) => {
    if (own.length === optWords.length) return supportIn(option, win);
    const ws = new Set(keyWords(win));
    const verbatim = supportIn(option, win) > 1 ? 1.05 : 0;
    return Math.max(verbatim, own.filter((w) => ws.has(w)).length / own.length);
  };

  if (sents.length <= 1) return score(excerpt);
  let best = 0;
  for (let i = 0; i < sents.length; i++) {
    // A one- or two-word answer ("Mitochondria") must be in the very sentence about the question's fact, not a
    // neighbouring one ("It occurs in the mitochondria." next to "Anaerobic respiration … lactic acid"). A sentence
    // that starts with "It/They/This…" is read together with the sentence before it (what "it" refers to).
    const short = own.length <= 2;
    const pronoun = i > 0 && /^(?:it|they|this|these|that|those|he|she|its|their)\b/i.test(sents[i]);
    const r = pronoun && short ? rel[i - 1] : rel[i];
    if (anchors.length && (short ? r < bestRel * 0.5 || r === 0 : rel[i] === 0)) continue;
    const win = short ? (pronoun ? `${sents[i - 1]} ${sents[i]}` : sents[i]) : sents.slice(Math.max(0, i - 1), i + 2).join(' ');
    best = Math.max(best, score(win));
  }
  return best;
}

const STRONG = 0.8;
const WEAK = 0.5;

/** Checks an MCQ's answer key against the passage it was written from. Returns the question (re-keyed when one
 *  other option is clearly the one the passage states) or null to discard it. A key the passage does not back,
 *  or a date/number in the question that is not in the passage, discards the question. */
export function checkMcqKey<T extends { question?: string; answer: string; options: string[]; correct: number }>(q: T, excerpt: string): T | null {
  if (q.correct < 0 || q.correct >= q.options.length) return null;
  const exNums = numsOf(excerpt);
  for (const n of numsOf(q.question ?? '')) if (!exNums.has(n)) return null; // question built on a date the notes don't have
  const scores = q.options.map((o) => optionSupport(o, excerpt, q.question ?? ''));
  const strong = scores.map((s, i) => (s >= STRONG ? i : -1)).filter((i) => i >= 0);
  const top = Math.max(...scores);
  const tied = strong.filter((i) => top - scores[i] < 0.05);
  if (tied.length >= 2) return null; // two or more options equally backed by the notes: ambiguous
  const key = scores[q.correct];
  if (key >= STRONG) return scores[q.correct] === top ? q : null;
  if (strong.length === 1) {
    // Re-key only when the passage clearly states that option: a number/date, or 2+ of its own words (a single
    // word like "Root" sitting in the right sentence is not proof it answers the question).
    const cand = q.options[strong[0]];
    const qW = new Set(keyWords(q.question ?? ''));
    const ownWords = keyWords(cand).filter((w) => !qW.has(w));
    const clear = numsOf(cand).size > 0 || ownWords.length >= 2 || scores[strong[0]] > 1;
    if (key < WEAK && clear) return { ...q, answer: cand, correct: strong[0] }; // re-key to the one supported option
    return null; // key half-supported while another option is fully supported: unclear, skip
  }
  if (strong.length >= 2) return null;
  // Nothing clearly stated: keep only a key that is mostly in the passage and clearly ahead of every other option.
  if (key >= WEAK && scores.every((s, i) => i === q.correct || s <= key - 0.2)) return q;
  return null;
}

/** The sentence a question's answer came from, so later questions are steered to other facts. */
export function supportingSentence(answer: string, excerpt: string, question = ''): string | null {
  const sents = sentencesOf(excerpt);
  let best = -1;
  let bestScore = 0;
  sents.forEach((x, i) => {
    const sc = supportIn(answer, x) + 0.3 * supportIn(question, x);
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  });
  return best >= 0 && bestScore >= 0.5 ? sents[best] : null;
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
