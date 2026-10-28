// v1.0.16 quiz engine. Pure TypeScript (no React, no QVAC imports) so the exact same code runs in the app and in
// node tests with the real model.
//
// How a quiz is written:
//  1. Facts. Every note is split (at import time, cheaply, no AI) into distinct "facts": one full sentence that
//     states something, or one short list ("Challenges of Public Affairs: Financial constraints; Political
//     interference; …"). Overlapping passages and repeated sentences count once.
//  2. Capacity. The number of facts, scaled down a little, is how many different questions the notes can carry.
//     The quiz screen shows it and never offers more.
//  3. One question per fact. The model sees only that fact and a little context, so each question is about a
//     different thing, prompts are short (faster on a phone), and the answer key is checked against that fact.
//  4. Clean options. Leading "A." / "b)" / "3." markers the model copies are stripped, the correct answer is kept
//     about as long as the wrong ones (a long answer is a giveaway), and the right letter is spread evenly.
import type { StoredChunk } from './store';
import { checkMcqKey, commonEntities, isNearDuplicate, sentencesOf, tidyQuestion } from './rag';
import { Preempted } from './llmLock';
export { Preempted };

// ---------------------------------------------------------------- facts ----------------------------------------
const FACT_STOP = new Set(
  'a an the of to in on for and or is are was were be been being what which who whom why how when where does do did can could should would about with from by as at it its this that these those into than then there their they them he she his her we our you your i also such other some any all more most very has have had will may must not no only so but if each every both either one two'.split(' '),
);
const words = (t: string) => (t.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const contentWords = (t: string) => words(t).filter((w) => (w.length > 2 || /\d/.test(w)) && !FACT_STOP.has(w));
const factKey = (t: string) => contentWords(t).slice(0, 14).join(' ');

/** A list marker inside running text: "1." "2)" "a." "(b)" "iv." "•" "-". Group 1 = the label. */
const MARKER = /(?:^|\s)\(?(\d{1,2}|[a-hA-H]|i{1,3}|iv|v|vi{1,3}|ix|x|[•▪●◦*]|-(?=\s))[.)]?\s+/g;
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

export type Fact = { text: string; context: string; chunkId: string; kind: 'sentence' | 'list' };

type Mark = { at: number; end: number; label: string };
/** True when `b` continues the numbering of `a` (1→2, a→b, ii→iii, •→•). */
function follows(a: string, b: string) {
  if (/^[•▪●◦*-]$/.test(a)) return a === b;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(b) === Number(a) + 1;
  const ra = ROMAN.indexOf(a.toLowerCase()), rb = ROMAN.indexOf(b.toLowerCase());
  if (ra >= 0 && rb === ra + 1) return true;
  return a.length === 1 && b.length === 1 && /[a-h]/i.test(a) && b.charCodeAt(0) === a.charCodeAt(0) + 1;
}
const isFirst = (l: string) => /^(?:1|a|A|i|[•▪●◦*-])$/.test(l);

/** Numbered / lettered / bulleted lists inside running text (line breaks are gone by now). A run is 2+ markers that
 *  count up from 1 / a / i. A marker needs a real punctuation mark ("1." "a)"), except bullets. */
function listRuns(t: string): Mark[][] {
  const marks: Mark[] = [];
  for (const m of t.matchAll(MARKER)) {
    const raw = m[0];
    const label = m[1];
    if (!/^[•▪●◦*-]$/.test(label) && !/[.)]\s+$/.test(raw)) continue;
    // "a." must be followed by a capital ("a. Low-cost"), so words like "a" in "a. m." don't count
    const after = t.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 1);
    if (/^[a-z]$/i.test(label) && !/[A-Z0-9"“(]/.test(after)) continue;
    marks.push({ at: (m.index ?? 0) + (raw.startsWith(' ') ? 1 : 0), end: (m.index ?? 0) + raw.length, label });
  }
  const runs: Mark[][] = [];
  let cur: Mark[] = [];
  for (const mk of marks) {
    if (cur.length && follows(cur[cur.length - 1].label, mk.label)) cur.push(mk);
    else {
      if (cur.length >= 2) runs.push(cur);
      cur = isFirst(mk.label) ? [mk] : [];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** Last short piece of a text: the heading a list belongs to ("…community. Challenges of Public Affairs"). */
function splitHeading(t: string): { prose: string; heading: string } {
  const s = t.trim();
  const i = Math.max(s.lastIndexOf('. '), s.lastIndexOf('? '), s.lastIndexOf('! '));
  const last = (i >= 0 ? s.slice(i + 2) : s).replace(/[:\s-]+$/, '').trim();
  if (last && last.length <= 90 && !/[.!?]$/.test(last)) return { prose: i >= 0 ? s.slice(0, i + 1) : '', heading: last };
  return { prose: s, heading: '' };
}

const LABEL = /^(?:answer|ans|note|nb|n\.b|solution|explanation)\s*[:.\-–]\s*/i;
const isFactSentence = (s: string) => contentWords(s).length >= 5 && s.length >= 30 && /[a-z]/.test(s);

/** Joins a note's overlapping passages back into its full text (each passage starts with the end of the last). */
export function mergeChunks(texts: string[]): string {
  let acc = '';
  for (const raw of texts) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!acc) {
      acc = t;
      continue;
    }
    const probe = t.slice(0, 16);
    const from = Math.max(0, acc.length - 400);
    let joined = false;
    for (let p = acc.indexOf(probe, from); p >= 0; p = acc.indexOf(probe, p + 1)) {
      if (t.startsWith(acc.slice(p))) {
        acc = acc.slice(0, p) + t;
        joined = true;
        break;
      }
    }
    if (!joined) acc += ' ' + t;
  }
  return acc;
}

type RawFact = { text: string; context: string; kind: 'sentence' | 'list' };

/** Distinct facts of one note's full text: full sentences that state something, and short lists. */
export function factsOfText(full: string): RawFact[] {
  const text = String(full ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const out: RawFact[] = [];
  const prose: string[] = [];
  const runs = listRuns(text);
  let pos = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const { prose: before, heading } = splitHeading(text.slice(pos, run[0].at));
    if (before) prose.push(before);
    const items = run.map((m, i) => text.slice(m.end, i + 1 < run.length ? run[i + 1].at : runs[r + 1]?.[0].at ?? text.length).trim());
    // The last item runs on until the next list or the end: keep its first sentence, the rest is prose again.
    const shortList = items.slice(0, -1).filter((x) => contentWords(x).length <= 5).length >= Math.max(1, (items.length - 1) / 2);
    let last = items[items.length - 1] ?? '';
    let tail = '';
    const firstSent = sentencesOf(last)[0] ?? last;
    if (shortList) {
      // "Misinformation and fake news A broader communication function." -> the item ends where a new capitalised phrase starts
      const m = last.match(/^(\S+(?:\s+[a-z0-9][^\s]*)+?)\s+(?=[A-Z]\w*\b)/);
      const cut = m && contentWords(m[1]).length <= 6 ? m[1] : firstSent;
      tail = last.slice(cut.length).trim();
      last = cut;
    } else {
      tail = last.slice(firstSent.length).trim();
      last = firstSent;
    }
    items[items.length - 1] = last;
    pos = run[run.length - 1].end + (text.slice(run[run.length - 1].end).indexOf(last) >= 0 ? text.slice(run[run.length - 1].end).indexOf(last) : 0) + last.length;
    const short: string[] = [];
    for (const it0 of items) {
      const it = it0.replace(LABEL, '').trim();
      const sents = sentencesOf(it);
      const first = (sents[0] ?? it).trim();
      if (isFactSentence(first)) out.push({ text: heading ? `${heading}: ${first}` : first, context: '', kind: 'sentence' });
      else if (first) short.push(first.replace(/[.;,:\s]+$/, ''));
      if (sents.length > 1) prose.push(sents.slice(1).join(' '));
    }
    const shortItems = short.filter((x) => contentWords(x).length >= 1 && x.length <= 80);
    if (shortItems.length >= 3) out.push({ text: `${heading || 'List'}: ${shortItems.join('; ')}.`, context: '', kind: 'list' });
    if (tail && pos < text.length) {
      // leave the tail for the next round (it may hold the next list's heading)
      pos = text.indexOf(tail, Math.max(0, pos - 2)) >= 0 ? text.indexOf(tail, Math.max(0, pos - 2)) : pos;
    }
  }
  if (pos < text.length) prose.push(text.slice(pos));
  const sents = prose.flatMap((p) => sentencesOf(p)).map((x) => x.replace(LABEL, '').trim()).filter(Boolean);
  sents.forEach((x, i) => {
    if (!isFactSentence(x)) return;
    out.push({ text: x.length > 360 ? x.slice(0, 360).replace(/\s+\S*$/, '') + '…' : x, context: [sents[i - 1], sents[i + 1]].filter(Boolean).join(' ').slice(0, 400), kind: 'sentence' });
  });
  // Distinct only: the same sentence twice, or one that repeats 80% of another's words, counts once.
  const seen: Set<string>[] = [];
  const keys = new Set<string>();
  return out.filter((f) => {
    const core = f.text.replace(/^[^:]{1,90}:\s+/, ''); // compare without the list heading
    const k = factKey(core);
    if (!k || keys.has(k)) return false;
    const ws = new Set(contentWords(core));
    if (seen.some((s) => { let both = 0; for (const w of ws) if (s.has(w)) both++; return both / Math.max(1, Math.min(ws.size, s.size)) >= 0.8; })) return false;
    keys.add(k);
    seen.push(ws);
    return true;
  });
}

/** Distinct facts of the given passages, note by note, each tied to the passage it sits in (for "From your notes"). */
export function factsOf(chunks: Pick<StoredChunk, 'id' | 'text' | 'docId'>[]): Fact[] {
  const byDoc = new Map<string, Pick<StoredChunk, 'id' | 'text' | 'docId'>[]>();
  for (const c of chunks) {
    if (!c || typeof c.text !== 'string' || !c.text.trim()) continue;
    const k = c.docId ?? '';
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k)!.push(c);
  }
  const out: Fact[] = [];
  for (const list of byDoc.values()) {
    const norm = list.map((c) => ({ id: c.id, text: c.text.replace(/\s+/g, ' ') }));
    for (const f of factsOfText(mergeChunks(list.map((c) => c.text)))) {
      const core = f.text.replace(/^[^:]{1,90}:\s+/, '');
      const probe = (f.kind === 'list' ? core.split(';')[0] : core).slice(0, 40).replace(/…$/, '');
      const home = norm.find((c) => c.text.includes(probe)) ?? norm.find((c) => c.text.includes(probe.slice(0, 20))) ?? norm[0];
      out.push({ ...f, chunkId: home.id });
    }
  }
  return out;
}

/** Facts in one note's passages (done once when the note is added; the count is saved with the note). */
export function countFacts(texts: string[]): number {
  return factsOfText(mergeChunks(texts)).length;
}

/** Share of facts the quiz can reliably turn into good, different questions (measured with the real model on
 *  short lecture notes; kept low on purpose so the promised number is met). */
export const CAPACITY_YIELD = 0.6;

/** How many different questions a number of facts supports (conservative). */
export function capacityFromFacts(nFacts: number): number {
  return Math.max(0, Math.floor(nFacts * CAPACITY_YIELD));
}

// ---------------------------------------------------------------- options --------------------------------------
/** "A. B. Online security", "(c) 3) Money", "a - Trust", "Option B: x", "Answer: x" -> the option text itself. */
export function stripOptionMarker(s: string): string {
  let t = String(s ?? '').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t
      .replace(/^["'“‘`]+|["'”’`]+$/g, '')
      .replace(/^(?:option|choice|answer|ans)\s*(?:[A-Da-d1-4]\b)?\s*[:.)\-–]\s*/i, '')
      .replace(/^(?:option|choice)\s+[A-Da-d1-4]\b\s*/i, '')
      .replace(/^\(?[A-Da-d][.)\]:]\s*(?=\S)/, '') // "A." "b)" "(c)" "D:"
      .replace(/^\(?[A-Da-d]\s+[-–—]\s+/, '') // "a - Trust"
      .replace(/^\(?\d{1,2}[.)\]:](?!\d)\s*(?=\S)/, '') // "3." "1)" but not "2.5"
      .replace(/^\(?(?:i{1,3}|iv|v|vi{1,3}|ix|x)[.)\]]\s+/i, '') // "ii)" roman numerals
      .replace(/^[•▪●◦*\-–—]\s+/, '')
      .trim();
    if (t === before) break;
  }
  t = t.replace(/\s*[.;,]+$/, '').replace(/\s{2,}/g, ' ').trim(); // "Money." vs "Politics": no telltale full stop
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

const wc = (s: string) => (s.match(/\S+/g) ?? []).length;

/** Shortens a long option to its first clause ("Trust must be a core feature: digital businesses need …" ->
 *  "Trust must be a core feature"). Returns null when no clause fits. */
export function shortenOption(s: string, maxWords: number): string | null {
  if (wc(s) <= maxWords) return s;
  const cands = new Set<string>();
  for (const re of [/\s*[:;]\s*/, /\s+[-–—]\s+/, /\s*\(\s*/, /,\s+/, /\s+(?:because|which|who|so that|in order to|by|through|while|whereas|since|as well as|such as|especially|including|e\.g\.|i\.e\.)\s+/i, /\s+(?:and|or)\s+/i]) {
    const first = s.split(re)[0]?.trim();
    if (first && first !== s) cands.add(first);
  }
  const ok = [...cands].filter((c) => wc(c) <= maxWords && contentWords(c).length >= 1 && c.length >= 3);
  if (!ok.length) return null;
  ok.sort((a, b) => wc(b) - wc(a)); // the longest clause that fits keeps the most meaning
  return stripOptionMarker(ok[0]);
}

export const OPTION_MAX_WORDS = 10;
export const LENGTH_RATIO = 1.8;

/** Cleans options and keeps the correct one from standing out by length. Returns null when it can't be fixed. */
export function balanceOptions(answer: string, wrong: string[]): { answer: string; wrong: string[] } | null {
  let a = stripOptionMarker(answer);
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(?:to|the|a|an)\s+/, '');
  let ws: string[] = [];
  for (const w of wrong) {
    const t = stripOptionMarker(w);
    if (t && norm(t) && norm(t) !== norm(a) && !ws.some((x) => norm(x) === norm(t))) ws.push(t);
  }
  if (!a || !norm(a)) return null;
  // Hard cap for every option (a sentence copied from the notes is not an option).
  const capA = shortenOption(a, OPTION_MAX_WORDS);
  if (!capA) return null;
  a = capA;
  ws = ws.map((w) => shortenOption(w, OPTION_MAX_WORDS)).filter((w): w is string => !!w && norm(w) !== norm(a));
  ws = ws.filter((w, i) => ws.findIndex((x) => norm(x) === norm(w)) === i).slice(0, 3);
  if (ws.length < 2) return null;
  const avg = ws.reduce((s, w) => s + wc(w), 0) / ws.length;
  const maxA = Math.max(3, Math.ceil(avg * LENGTH_RATIO));
  if (wc(a) > maxA) {
    const short = shortenOption(a, maxA);
    if (!short) return null; // can't trim without losing the answer: a give-away question, skip it
    a = short;
  }
  // A wrong option far longer than everything else is just as odd; trim it or drop it.
  const maxW = Math.max(3, Math.ceil(Math.max(wc(a), avg) * LENGTH_RATIO));
  ws = ws.map((w) => (wc(w) > maxW ? shortenOption(w, maxW) : w)).filter((w): w is string => !!w && norm(w) !== norm(a));
  if (ws.length < 2) return null;
  const avg2 = ws.reduce((s, w) => s + wc(w), 0) / ws.length;
  if (wc(a) > Math.max(3, avg2 * LENGTH_RATIO)) return null;
  return { answer: a, wrong: ws };
}

/** Even spread of the correct letter: a shuffled bag of positions, refilled when empty. */
export function positionBag(rand: () => number = Math.random) {
  let bag: number[] = [];
  return (n: number) => {
    if (n <= 1) return 0;
    if (!bag.length) {
      bag = [0, 1, 2, 3];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    const i = bag.findIndex((p) => p < n);
    return i >= 0 ? bag.splice(i, 1)[0] : Math.floor(rand() * n);
  };
}

export type Mcq = { question: string; answer: string; options: string[]; correct: number };

/** "Sell Goods Without Intermediaries" -> "Sell goods without intermediaries". Names and acronyms (capitalised in the
 *  notes, or ALL CAPS) keep their capitals. Options in a mix of styles look like a give-away. */
export function sentenceCase(opt: string, notes = ''): string {
  const ws = opt.split(' ');
  const caps = ws.filter((w) => /^[A-Z][a-z]/.test(w)).length;
  if (ws.length < 2 || caps < Math.max(2, ws.length - 1)) return opt;
  const keep = new Set((notes.match(/(?<![.!?:]\s)(?<!^)\b[A-Z][a-zA-Z]+/g) ?? []).map((w) => w.toLowerCase()));
  return ws.map((w, i) => (i === 0 || /^[A-Z0-9]{2,}$/.test(w) || keep.has(w.toLowerCase()) ? w : w.toLowerCase())).join(' ');
}

/** Parses the model's JSON into a clean MCQ with the correct option at `slot` (or a random one). */
export function parseFactMcq(raw: string, slot?: number, rand: () => number = Math.random, factText = ''): Mcq | null {
  const m = String(raw ?? '').match(/\{[\s\S]*\}/);
  let o: any;
  try {
    o = JSON.parse(m ? m[0] : raw);
  } catch {
    return null;
  }
  if (typeof o?.question === 'string' && o.question.trim().length >= FACT_MCQ_SCHEMA.properties.question.maxLength - 2 && !/\?\s*$/.test(o.question)) return null; // cut off by the length cap
  let q = typeof o?.question === 'string' ? tidyQuestion(o.question.trim().replace(/^(?:q(?:uestion)?\s*\d*\s*[:.)-]\s*|\d{1,2}[.)]\s+)/i, '')) : '';
  if (!q) return null;
  if (!/\?\s*$/.test(q)) {
    if (/^(?:what|which|who|whom|whose|why|how|when|where|name|identify|choose|select)\b/i.test(q)) q = q.replace(/[.\s]*$/, '?');
    else return null; // a statement, not a question
  }
  const cap = FACT_MCQ_SCHEMA.properties.answer.maxLength - 2;
  const ansRaw = typeof o?.answer === 'string' ? o.answer.trim() : '';
  if (ansRaw.length >= cap) return null; // the answer was cut off by the length cap
  // Wrong options cut off by the cap ("…between the C&") are dropped; so are ones that contain the answer or say
  // the same thing ("To connect buyers with sellers" next to "To connect buyers and sellers"): two right answers.
  const ansWords = new Set(contentWords(ansRaw));
  const wrongIn = (Array.isArray(o?.wrong) ? o.wrong : []).filter((x: any) => typeof x === 'string' && x.trim() && x.trim().length < cap).filter((x: string) => {
    const ws = contentWords(x);
    if (!ansWords.size || !ws.length) return true;
    const hasAll = [...ansWords].every((w) => ws.includes(w));
    return !hasAll;
  });
  const bal = balanceOptions(ansRaw, wrongIn);
  if (!bal) return null;
  bal.answer = sentenceCase(bal.answer, factText);
  bal.wrong = bal.wrong.map((w) => sentenceCase(w, factText));
  const qn = ` ${q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const an = bal.answer.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (an.split(' ').length >= 2 && qn.includes(` ${an} `)) return null; // the question gives the answer away
  const wrong = bal.wrong.slice();
  for (let i = wrong.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [wrong[i], wrong[j]] = [wrong[j], wrong[i]];
  }
  const n = wrong.length + 1;
  const at = slot != null && slot >= 0 && slot < n ? slot : Math.floor(rand() * n);
  const options = [...wrong.slice(0, at), bal.answer, ...wrong.slice(at)];
  return { question: q, answer: bal.answer, options, correct: at };
}

// ---------------------------------------------------------------- prompt ---------------------------------------
// maxLength makes the JSON grammar end each string in time: no paragraph-long options, no cut-off JSON, fewer tokens.
export const FACT_MCQ_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', minLength: 8, maxLength: 160 },
    answer: { type: 'string', minLength: 1, maxLength: 60 },
    wrong: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 60 } },
  },
  required: ['question', 'answer', 'wrong'],
};

const ANGLES = [
  '',
  'Ask with "Why" or "Which" this time.',
  'Ask about a different detail.',
];

// A list fact ("Challenges of Public Affairs: Financial constraints; Political interference; …") becomes a fixed
// question ("Which of these is one of the challenges of public affairs?") with one listed item as the answer; the
// model only writes the three wrong answers, which must NOT be on the list.
export const WRONG_ONLY_SCHEMA = {
  type: 'object',
  properties: { wrong: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 2, maxLength: 50 } } },
  required: ['wrong'],
};

export function listParts(f: Pick<Fact, 'text'>): { heading: string; items: string[] } {
  const i = f.text.indexOf(': ');
  const heading = i > 0 ? f.text.slice(0, i).trim() : '';
  const items = (i > 0 ? f.text.slice(i + 2) : f.text).replace(/\.$/, '').split(/;\s*/).map((x) => stripOptionMarker(x)).filter(Boolean);
  return { heading, items };
}

/** "Challenges of Public Affairs" -> "Which of these is one of the challenges of public affairs?" (acronyms kept). */
export function listQuestion(heading: string): string {
  const h = heading.replace(/^the\s+/i, '').replace(/[:\s]+$/, '').trim();
  if (!h || /^list$/i.test(h) || h.length > 80) return '';
  const fixed = h.split(/\s+/).map((w) => (/^[A-Z0-9]{2,}$/.test(w) || /[A-Z].*[A-Z]/.test(w.slice(1)) ? w : w.toLowerCase())).join(' ');
  return `Which of these is one of the ${fixed}?`;
}

export function buildListWrongPrompt(f: Pick<Fact, 'text'>) {
  const { heading, items } = listParts(f);
  const system = 'You write wrong answers for a multiple-choice exam question. Each is a short phrase of 1 to 5 words that sounds believable but is NOT in the given list. JSON only.';
  const user = `Topic: ${heading}\nThe list: ${items.join('; ')}\n\nWrite three believable wrong answers that are not in the list. Return JSON like {"wrong":["…","…","…"]}`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

/** Builds a list question from the model's wrong answers; null when they repeat the list or are unusable. */
export function parseListMcq(raw: string, f: Pick<Fact, 'text'>, pickItem: number, slot?: number, rand: () => number = Math.random): Mcq | null {
  const { heading, items } = listParts(f);
  const question = listQuestion(heading);
  if (!question || items.length < 2) return null;
  const m = String(raw ?? '').match(/\{[\s\S]*\}/);
  let o: any;
  try {
    o = JSON.parse(m ? m[0] : raw);
  } catch {
    return null;
  }
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const itemWords = items.map((x) => new Set(contentWords(x)));
  const onList = (w: string) => {
    const ws = contentWords(w);
    return items.some((x) => norm(x) === norm(w)) || itemWords.some((st) => ws.length > 0 && ws.filter((x) => st.has(x)).length / ws.length >= 0.6);
  };
  const answer = items[((pickItem % items.length) + items.length) % items.length];
  const wrongRaw = (Array.isArray(o?.wrong) ? o.wrong : [])
    .filter((x: any) => typeof x === 'string')
    .map((x: string) => sentenceCase(stripOptionMarker(x), f.text))
    .filter((x: string) => x && !onList(x));
  const bal = balanceOptions(answer, wrongRaw);
  if (!bal || bal.answer !== answer) return null;
  const wrong = bal.wrong.slice();
  const n = wrong.length + 1;
  const at = slot != null && slot >= 0 && slot < n ? slot : Math.floor(rand() * n);
  const options = [...wrong.slice(0, at), answer, ...wrong.slice(at)];
  return { question, answer, options, correct: at };
}

// One worked example teaches the 1B model the exact shape (a real question, short options of equal length) far
// better than rules alone; it costs ~70 prompt tokens.
const EXAMPLE_NOTE = 'Photosynthesis takes place in the chloroplasts of plant cells, using light energy.';
const EXAMPLE_JSON = '{"question":"Where does photosynthesis take place?","answer":"In the chloroplasts","wrong":["In the nucleus","In the mitochondria","In the cell wall"]}';

export function buildFactMcqPrompt(f: Pick<Fact, 'text' | 'context' | 'kind'>, attempt = 0) {
  const system =
    'You write one multiple-choice exam question from a student\'s notes. The question ends with "?" and asks directly, like an exam; never mention "the notes" or "the text". ' +
    'The correct answer is stated in the notes. The three wrong answers are believable but wrong, and different from each other. ' +
    'Every answer is a short phrase of 1 to 6 words, all about the same length. JSON only.\n\n' +
    `Example notes: ${EXAMPLE_NOTE}\nExample JSON: ${EXAMPLE_JSON}`;
  const angle = ANGLES[attempt % ANGLES.length];
  const user = `Notes: ${f.text}\n\n${angle ? angle + '\n' : ''}Write one multiple-choice question about these notes. JSON:`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

// ---------------------------------------------------------------- the quiz loop --------------------------------

export type QuizGenDeps = {
  /** Runs the model; throws Preempted when an Ask took the model (the attempt is retried, not counted). */
  generate: (history: { role: 'system' | 'user' | 'assistant'; content: string }[], opts: { maxTokens: number; temp: number; jsonSchema: object }) => Promise<string>;
  shouldStop: () => boolean;
  onQuestion: (q: Mcq & { source: StoredChunk; fact: string }) => void;
  onProgress?: (made: number, target: number) => void;
  /** Why a written question was not used (tests / diagnostics). */
  onReject?: (reason: string, raw: string, fact: Fact) => void;
  rand?: () => number;
};

export type QuizGenResult = { made: number; target: number; stopped: boolean; attempts: number };

/** Writes up to `target` questions from the given passages. Mixed subjects (groupOf) take turns fairly. */
export async function writeQuiz(chunks: StoredChunk[], target: number, deps: QuizGenDeps, groupOf?: (c: StoredChunk) => string): Promise<QuizGenResult> {
  const rand = deps.rand ?? Math.random;
  const shuffle = <T,>(a: T[]) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const facts = factsOf(chunks);
  // Round-robin over subjects so "Mix all" covers every subject evenly.
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    const c = byId.get(f.chunkId);
    const g = c && groupOf ? groupOf(c) : '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  const lanes = shuffle([...groups.values()].map((g) => shuffle(g.slice())));
  const order: Fact[] = [];
  for (let i = 0; order.length < facts.length; i++) {
    const lane = lanes[i % lanes.length];
    const k = Math.floor(i / lanes.length);
    if (k < lane.length) order.push(lane[k]);
    if (i > facts.length * (lanes.length + 1)) break;
  }
  const goal = Math.min(target, facts.length);
  const slot = positionBag(rand);
  const asked: { q: string; a: string; src: string }[] = [];
  const common = commonEntities(chunks.map((c) => c.text));
  // Each fact gets up to 3 tries (a different wording angle each time), spread out: first pass over every fact,
  // then the facts that failed get their next try. Total attempts are capped so a hopeless note ends.
  const tries = new Map<Fact, number>();
  const budget = Math.max(goal * 4, 12);
  let made = 0;
  let attempts = 0;
  let queue = order.slice();
  for (let pass = 0; pass < 3 && made < goal && queue.length; pass++) {
    const failed: Fact[] = [];
    for (const f of queue) {
      if (made >= goal || attempts >= budget || deps.shouldStop()) break;
      const n = tries.get(f) ?? 0;
      deps.onProgress?.(made, goal);
      let raw = '';
      let failedRun = false;
      for (;;) {
        try {
          raw = await deps.generate(
            f.kind === 'list' ? buildListWrongPrompt(f) : buildFactMcqPrompt(f, n),
            f.kind === 'list' ? { maxTokens: 50, temp: 0.7, jsonSchema: WRONG_ONLY_SCHEMA } : { maxTokens: 120, temp: n ? 0.75 : 0.5, jsonSchema: FACT_MCQ_SCHEMA },
          );
        } catch (e) {
          // An Ask took the model: wait our turn and write this same question again (the attempt doesn't count).
          if (e instanceof Preempted && !deps.shouldStop()) continue;
          failedRun = true;
        }
        break;
      }
      if (deps.shouldStop()) break;
      if (failedRun) {
        attempts++;
        tries.set(f, n + 1);
        if (n + 1 < 3) failed.push(f);
        continue;
      }
      attempts++;
      tries.set(f, n + 1);
      if (deps.shouldStop()) break;
      const src = byId.get(f.chunkId)!;
      const at = slot(4);
      const parsed = f.kind === 'list' ? parseListMcq(raw, f, Math.floor(rand() * 8), at, rand) : parseFactMcq(raw, at, rand, `${f.text} ${f.context}`);
      // List questions are built from the list itself, so their key is right by construction.
      const keyed = !parsed ? null : f.kind === 'list' ? parsed : checkMcqKey(parsed, `${f.text} ${f.context}`.trim());
      const dup = !!keyed && isNearDuplicate(keyed.question, asked, keyed.answer, common);
      if (!keyed || dup) {
        deps.onReject?.(!parsed ? 'format/length' : !keyed ? 'answer key' : 'duplicate', raw, f);
        if ((tries.get(f) ?? 0) < 3) failed.push(f);
        continue;
      }
      asked.push({ q: keyed.question, a: keyed.answer, src: f.chunkId });
      made++;
      deps.onQuestion({ ...keyed, source: src, fact: f.text });
    }
    queue = failed;
    if (attempts >= budget || deps.shouldStop()) break;
  }
  return { made, target: goal, stopped: deps.shouldStop(), attempts };
}
