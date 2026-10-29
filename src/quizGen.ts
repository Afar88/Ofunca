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
import { outlineOf, restoreLines, listTitle, lowerFirst, type OutlineList } from './outline';
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

export type Fact = {
  text: string;
  context: string;
  chunkId: string;
  kind: 'sentence' | 'member' | 'define';
  lead?: string;
  heading?: string;
  list?: OutlineList;
  item?: number;
  docKey?: string;
  notes?: string[];
  /** member question asked the other way round: "which of these is NOT one of …" */
  neg?: boolean;
  /** every list of the same note (wrong options for list questions come from these or the model) */
  lists?: OutlineList[];
  /** names and acronyms of the note, kept capitalised in questions */
  keep?: Set<string>;
};

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

/** Joins a note's overlapping passages back into its full text (each passage starts with the end of the last).
 *  Line breaks are kept (v1.0.17), so lists keep their headings and sub-labels. */
export function mergeChunks(texts: string[]): string {
  let acc = '';
  for (const raw of texts) {
    const t = String(raw ?? '').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
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
    if (!joined) acc += '\n' + t;
  }
  return acc;
}

type RawFact = Omit<Fact, 'chunkId'>;

/** Distinct quiz facts of one note's full text, read as an outline (v1.0.17):
 *  - 'member': "Which of these is one of the challenges of Public Affairs?" (one listed item is the key; a list
 *    under a sub-label keeps it: "…an importance of Public Affairs to government?"). Sub-labels are never facts.
 *  - 'define': "Which of the objectives … is explained as “…”?" (the item's own explanation; the other items of the
 *    same list are the wrong options, so the key is right by construction and no model is needed).
 *  - 'sentence': a full sentence of prose, which the model turns into a question (then checked hard). */
export function factsOfText(full: string): RawFact[] {
  const text = String(full ?? '').trim();
  if (!text) return [];
  const ol = outlineOf(text);
  const out: RawFact[] = [];
  for (const L of ol.lists) {
    const usable = L.items.filter((it) => it.name && wordsN(it.name) <= 10);
    const long = L.items.filter((it) => !(it.name && wordsN(it.name) <= 10));
    for (const it of long) if (isFactSentence(it.raw)) out.push({ text: `${listTitle(L)}: ${it.raw}`, context: '', kind: 'sentence' });
    if (usable.length < 2) continue;
    const title = listTitle(L);
    let members = 0;
    const listText = `${title}: ${usable.map((x) => x.name).join('; ')}.`;
    usable.forEach((it, i) => {
      const canDefine = usable.length >= 3 && !!it.expl && wordsN(it.expl) >= 4 && !explGivesAway(it.name, it.expl);
      // every item is used once: even items are "member" keys, odd items with an explanation are "define" ones
      const fact = (kind: 'member' | 'define'): RawFact =>
        kind === 'member'
          ? { text: listText, context: it.expl ? `${it.name} – ${it.expl}` : '', kind, list: L, item: L.items.indexOf(it) }
          : { text: `${title}: ${it.name} – ${it.expl}`, context: listText, kind, list: L, item: L.items.indexOf(it) };
      if (i % 2 === 1) {
        if (canDefine) out.push(fact('define'));
      } else if (L.heading) {
        // first key: "which of these is one of …"; second: "which of these is NOT one of …" (the key comes from
        // outside the list); more would repeat the same question, so later even items are left out
        if (members === 0) out.push(fact('member'));
        else if (members === 1 && usable.length >= 3) out.push({ ...fact('member'), neg: true });
        members++;
      }
      else if (canDefine) out.push(fact('define'));
    });
  }
  for (const P of ol.prose) {
    const sents = sentencesOf(P.text).map((x) => x.replace(LABEL, '').trim()).filter(Boolean);
    sents.forEach((x, i) => {
      if (!isFactSentence(x)) return;
      const lead = /^(?:it|they|this|these|that|those|he|she|its|their|such)\b/i.test(x) && sents[i - 1] ? sents[i - 1].slice(0, 300) : undefined;
      out.push({
        text: x.length > 360 ? x.slice(0, 360).replace(/\s+\S*$/, '') + '…' : x,
        context: [sents[i - 1], sents[i + 1]].filter(Boolean).join(' ').slice(0, 400),
        kind: 'sentence',
        lead,
        heading: P.heading,
      });
    });
  }
  // Distinct only: the same sentence twice, or one that repeats 80% of another's words, counts once.
  const seen: Set<string>[] = [];
  const keys = new Set<string>();
  return out.filter((f) => {
    if (f.kind !== 'sentence') return true;
    const core = f.text.replace(/^[^:]{1,90}:\s+/, '');
    const k = factKey(core);
    if (!k || keys.has(k)) return false;
    const ws = new Set(contentWords(core));
    if (seen.some((st) => { let both = 0; for (const w of ws) if (st.has(w)) both++; return both / Math.max(1, Math.min(ws.size, st.size)) >= 0.8; })) return false;
    keys.add(k);
    seen.push(ws);
    return true;
  });
}

const wordsN = (t: string) => (t.match(/\S+/g) ?? []).length;
/** "Two-way communication – Two-way communication means…" would hand the answer over. */
function explGivesAway(name: string, expl: string) {
  const nw = contentWords(name);
  if (!nw.length) return true;
  const ew = new Set(contentWords(expl).map(stem));
  return nw.filter((w) => ew.has(stem(w))).length / nw.length >= 0.5;
}
const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/, '');

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
  for (const [docId, list] of byDoc) {
    const norm = list.map((c) => ({ id: c.id, text: c.text.replace(/\s+/g, ' ') }));
    const full = mergeChunks(list.map((c) => c.text));
    const lines = notesLines(full);
    const lists = outlineOf(full).lists;
    const keep = properWords(full);
    for (const f of factsOfText(full)) {
      const probeSrc = f.kind === 'sentence' ? f.text.replace(/^[^:]{1,90}:\s+/, '') : f.list!.items[f.item!].raw;
      const probe = probeSrc.replace(/\s+/g, ' ').slice(0, 40).replace(/…$/, '');
      const home = norm.find((c) => c.text.includes(probe)) ?? norm.find((c) => c.text.includes(probe.slice(0, 20))) ?? norm[0];
      out.push({ ...f, chunkId: home.id, docKey: docId, notes: lines, lists, keep });
    }
  }
  return out;
}

/** Lines and sentences of a whole note (used to prove a made-up wrong option is NOT in the notes). */
export function notesLines(full: string): string[] {
  return restoreLines(full)
    .split('\n')
    .flatMap((l) => sentencesOf(l.replace(/^\s*\(?(?:\d{1,2}|[a-hA-H]|[ivx]{1,4})[.)]\s+/, '')))
    .map((x) => x.trim())
    .filter(Boolean);
}

/** True when an option says (nearly) what some line of the notes says: then it is not safely wrong. */
export function inNotes(opt: string, lines: string[]): boolean {
  const ow = [...new Set(contentWords(opt).map(stem))];
  if (!ow.length) return false;
  for (const l of lines) {
    const lw = new Set(contentWords(l).map(stem));
    const hit = ow.filter((w) => lw.has(w)).length;
    if (ow.length === 1 ? hit === 1 && contentWords(l).length <= 6 : hit / ow.length >= 0.75 || (ow.length >= 3 && hit >= ow.length - 1)) return true;
  }
  return false;
}

const YIELD: Record<Fact['kind'], number> = { define: 0.95, member: 0.9, sentence: 0.5 };
/** How many different questions one note's passages can carry (worked out once when the note is added). */
export function countFacts(texts: string[]): number {
  const fs = factsOfText(mergeChunks(texts));
  return Math.floor(fs.reduce((n, f) => n + YIELD[f.kind], 0) * 100) / 100;
}

/** v1.0.17: the stored number is already the expected question count (each kind has its own measured yield). */
export const CAPACITY_YIELD = 1;
export const CAPACITY_VERSION = 2;

/** How many different questions the notes support (conservative). */
export function capacityFromFacts(units: number): number {
  return Math.max(0, Math.floor(units * CAPACITY_YIELD));
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
  // two capitalised words are usually a name ("United States", "South Africa"): leave them alone
  if (ws.length < 3 || caps < Math.max(2, ws.length - 1)) return opt;
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
  // v1.0.17: a wrong option that shares a word (or a word stem: relations / relationships) with the answer is a
  // variant of it ("The Jiji app" next to "The Jiji platform", "Establishing relations" next to "Building
  // relationships"): a student could argue for it, so it is dropped. Numbers and dates are compared as wholes.
  const ansStems = [...ansWords].filter((w) => !/^\d+$/.test(w));
  const close = (a: string, b: string) => a === b || stem(a) === stem(b) || (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6));
  const wrongIn = (Array.isArray(o?.wrong) ? o.wrong : []).filter((x: any) => typeof x === 'string' && x.trim() && x.trim().length < cap).filter((x: string) => {
    const ws = contentWords(x);
    if (!ansWords.size || !ws.length) return true;
    return !ws.some((w) => !/^\d+$/.test(w) && ansStems.some((a) => close(a, w)));
  });
  const bal = balanceOptions(ansRaw, wrongIn);
  if (!bal) return null;
  bal.answer = sentenceCase(bal.answer, factText);
  bal.wrong = bal.wrong.map((w) => sentenceCase(w, factText));
  const qn = ` ${q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const an = bal.answer.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (an.split(' ').length >= 2 && qn.includes(` ${an} `)) return null; // the question gives the answer away
  // "Why does X happen when oxygen is scarce?" -> "X happens when oxygen is scarce": the answer only repeats the question
  const aw = contentWords(bal.answer);
  const qw = new Set(contentWords(q));
  if (aw.length >= 2 && aw.filter((w) => qw.has(w) || qw.has(w.replace(/s$/, '')) || qw.has(w + 's')).length / aw.length >= 0.75) return null;
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
    .filter((x: any) => typeof x === 'string' && x.trim().length < WRONG_ONLY_SCHEMA.properties.wrong.items.maxLength - 2) // cut off by the cap
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

// ---------------------------------------------------------------- list questions (v1.0.17) -----------------
/** Words written with a capital in the middle of a sentence (names, "Public Affairs") or in ALL CAPS stay that way. */
export function properWords(full: string): Set<string> {
  const keep = new Set<string>();
  for (const m of String(full ?? '').matchAll(/(?<=\b[a-z][a-z0-9]*[,;]?[ \t]+)([A-Z][A-Za-z'’-]+(?:[ \t]+[A-Z][A-Za-z'’-]+)*)/g))
    for (const w of m[1].split(/[ \t]+/)) keep.add(w.toLowerCase());
  for (const m of String(full ?? '').matchAll(/\b[A-Z]{2,}\b/g)) keep.add(m[0].toLowerCase());
  return keep;
}
const phrase = (t: string, keep: Set<string>) =>
  t
    .split(/\s+/)
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) || /[A-Z].*[A-Z]/.test(w.slice(1)) || keep.has(w.toLowerCase().replace(/[^a-z'’-]/g, '')) ? w : w.toLowerCase()))
    .join(' ');
const MASS = /^(importance|significance|relevance|role|purpose|scope|value|need)\s+(of|to|for)\s+(.+)$/i;
const STOPPER = /^(?:of|to|for|in|by|on|at|used|faced|with|from|among|between|and)$/i;
/** "Challenges of Public Affairs" -> "challenges of Public Affairs" when its head noun is plural, else null. */
function pluralPhrase(h: string, keep: Set<string>): string | null {
  const ws = h.split(/\s+/);
  for (const w of ws.slice(0, 5)) {
    if (STOPPER.test(w)) return null;
    if (/^[A-Za-z][a-z]{2,}s$/.test(w) && !/ss$/.test(w) && !keep.has(w.toLowerCase())) return phrase(h, keep);
  }
  return null;
}
const subOf = (L: Pick<OutlineList, 'sub'>, keep: Set<string>) => (L.sub ? ' ' + phrase(lowerFirst(L.sub), keep) : '');
const cleanHeading = (h: string) => {
  const t = h.replace(/^the\s+/i, '').replace(/[:\s-]+$/, '').trim();
  // "Nature/Characteristics of Public Affairs" -> "Characteristics of Public Affairs"
  const m = t.match(/^(\w+)\/(\w+)(\s.*)?$/);
  return m ? (/s$/.test(m[2]) ? m[2] : m[1]) + (m[3] ?? '') : t;
};

/** "According to your notes, which of these is an importance of Public Affairs to government?" */
export function memberQuestion(L: Pick<OutlineList, 'heading' | 'sub'>, keep: Set<string> = new Set(), neg = false): string {
  const h = cleanHeading(L.heading);
  if (!h || h.length > 80) return '';
  const not = neg ? 'NOT ' : '';
  const mass = h.match(MASS);
  if (mass) {
    const n = mass[1].toLowerCase();
    return `According to your notes, which of these is ${not}${/^[aeiou]/.test(n) ? 'an' : 'a'} ${n} ${mass[2].toLowerCase()} ${phrase(mass[3], keep)}${subOf(L, keep)}?`;
  }
  const pl = pluralPhrase(h, keep);
  if (pl) return `According to your notes, which of these is ${not}one of the ${pl}${subOf(L, keep)}?`;
  return `According to your notes, which of these is ${not}listed under “${h}${L.sub ? ` – ${L.sub}` : ''}”?`;
}

/** "Which of the objectives of Public Affairs in your notes is explained as “…”?" */
export function defineQuestion(L: Pick<OutlineList, 'heading' | 'sub'>, expl: string, keep: Set<string> = new Set()): string {
  const h = cleanHeading(L.heading);
  const e0 = (sentencesOf(expl)[0] ?? expl).trim().replace(/[.;:\s]+$/, '');
  const e = e0.length > 170 ? e0.slice(0, 170).replace(/\s+\S*$/, '') + '…' : e0;
  if (!e) return '';
  const pl = h ? pluralPhrase(h, keep) : null;
  if (pl && !MASS.test(h)) return `Which of the ${pl}${subOf(L, keep)} in your notes is explained as “${e}”?`;
  if (h) return `Which point under “${h}${L.sub ? ` – ${L.sub}` : ''}” in your notes is explained as “${e}”?`;
  return `Which point in your notes is explained as “${e}”?`;
}

const simW = (a: string, b: string) => {
  const aw = [...new Set(contentWords(a).map(stem))];
  const bw = new Set(contentWords(b).map(stem));
  if (!aw.length || !bw.size) return 0;
  return aw.filter((w) => bw.has(w)).length / Math.min(aw.length, bw.size);
};
const nearAny = (x: string, list: string[], t = 0.6) => list.some((y) => simW(x, y) >= t);
const styleOf = (x: string) => (/^to\s/i.test(x) ? 'to' : /^[A-Z][a-z]+s\s/.test(x) ? 'verb' : 'noun');

/** Wrong-option candidates for a list question that come from the notes themselves, best first:
 *  the same heading's other sub-lists ("To Organizations" items for a "To Government" question), then other
 *  lists written in the same style. None is close to anything on the key's list. */
export function listDistractors(f: Pick<Fact, 'list' | 'lists'>): { siblings: string[]; others: string[] } {
  const L = f.list!;
  const mine = L.items.map((x) => x.name);
  const lists = f.lists ?? [];
  const ok = (x: string) => !!x && wordsN(x) <= 10 && !nearAny(x, mine);
  const siblings = lists
    .filter((o) => o !== L && o.heading === L.heading && o.sub !== L.sub)
    .flatMap((o) => o.items.map((x) => x.name))
    .filter(ok);
  const style = styleOf(mine[0] ?? '');
  const others = lists
    .filter((o) => o !== L && o.heading !== L.heading)
    .flatMap((o) => o.items.map((x) => x.name))
    .filter((x) => ok(x) && styleOf(x) === style);
  return { siblings: [...new Set(siblings)], others: [...new Set(others)] };
}

/** How many made-up wrong options a list question still needs from the model (0 = no model call). */
export function memberNeedsModel(f: Fact): number {
  const { siblings, others } = listDistractors(f);
  const real = siblings.length + others.length;
  return f.neg ? (real >= 1 ? 0 : 3) : Math.max(0, 3 - real);
}

export function buildMemberWrongPrompt(f: Pick<Fact, 'list'>) {
  const L = f.list!;
  const items = L.items.map((x) => x.name);
  const system = 'You write wrong answers for a multiple-choice exam question. Each is a short phrase of 2 to 5 words: the same kind of thing as the list items, on the same topic, written in the same style, believable to a student, but NOT in the list. No jokes, names or places. JSON only.';
  const user = `Topic: ${listTitle(L)}\nThe list: ${items.join('; ')}\n\nWrite three believable wrong answers that are not in the list. JSON:`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

const pickN = <T,>(a: T[], n: number, rand: () => number) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b.slice(0, n);
};
const place = (answer: string, wrong: string[], slot: number | undefined, rand: () => number): Mcq => {
  const n = wrong.length + 1;
  const at = slot != null && slot >= 0 && slot < n ? slot : Math.floor(rand() * n);
  return { question: '', answer, options: [...wrong.slice(0, at), answer, ...wrong.slice(at)], correct: at };
};

/** Model's made-up wrong answers for a list question, kept only when they are not in (or close to) the notes. */
export function madeUpWrong(raw: string, f: Fact): string[] {
  let o: any;
  try {
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    o = JSON.parse(m ? m[0] : raw);
  } catch {
    return [];
  }
  const mine = f.list!.items.map((x) => x.name);
  const out: string[] = [];
  for (const x of Array.isArray(o?.wrong) ? o.wrong : []) {
    if (typeof x !== 'string' || x.trim().length >= WRONG_ONLY_SCHEMA.properties.wrong.items.maxLength - 2) continue;
    const t = sentenceCase(stripOptionMarker(x), f.text);
    if (!t || contentWords(t).length < 1 || wordsN(t) > 8) continue;
    if (nearAny(t, mine, 0.5) || inNotes(t, f.notes ?? []) || nearAny(t, out, 0.6)) continue;
    if ((styleOf(t) === 'to') !== (styleOf(mine[0] ?? '') === 'to')) continue; // "To reduce taxes" next to nouns is a give-away
    out.push(t);
  }
  return out;
}

/** A list question from a 'member' fact. `made` are the model's checked made-up wrong answers (may be empty). */
export function makeMemberMcq(f: Fact, made: string[], slot?: number, rand: () => number = Math.random): Mcq | null {
  const L = f.list!;
  const question = memberQuestion(L, f.keep, !!f.neg);
  if (!question) return null;
  const { siblings, others } = listDistractors(f);
  const mine = L.items.map((x) => x.name).filter((x) => wordsN(x) <= 10);
  if (f.neg) {
    // the key is the one option NOT on the list; the wrong ones are listed items
    // and shares no word with any listed item ("Mobile app" is not offered against "Mobile first")
    const clear = (x: string) => !nearAny(x, mine, 0.34);
    const key = pickN(siblings.filter(clear), 1, rand)[0] ?? pickN(others.filter(clear), 1, rand)[0] ?? made.filter(clear)[0];
    if (!key || mine.length < 3) return null;
    const wrong = pickN(mine, 3, rand);
    const bal = balanceOptions(key, wrong);
    if (!bal || bal.wrong.length < 3) return null;
    return { ...place(bal.answer, bal.wrong, slot, rand), question };
  }
  const key = L.items[f.item ?? 0]?.name;
  if (!key) return null;
  // real phrases from the notes' other lists first (never on this list, so never a second right answer), then
  // the model's made-up ones (already checked to be absent from the notes)
  const pool = [...pickN(siblings, 3, rand), ...pickN(others, 3, rand), ...made];
  const wrong: string[] = [];
  for (const w of pool) if (wrong.length < 3 && !nearAny(w, wrong, 0.6) && !nearAny(w, [key], 0.5)) wrong.push(w);
  const bal = balanceOptions(key, wrong);
  if (!bal || bal.wrong.length < 2) return null;
  return { ...place(bal.answer, bal.wrong, slot, rand), question };
}

/** A "which one is explained as …" question from a 'define' fact (no model needed). */
export function makeDefineMcq(f: Fact, slot?: number, rand: () => number = Math.random): Mcq | null {
  const L = f.list!;
  const it = L.items[f.item ?? 0];
  if (!it?.expl) return null;
  const question = defineQuestion(L, it.expl, f.keep);
  const others = L.items.filter((x) => x !== it && x.name && wordsN(x.name) <= 10).map((x) => x.name);
  if (!question || others.length < 2) return null;
  // another item whose own explanation says nearly the same thing would also fit: skip the question
  if (L.items.some((x) => x !== it && x.expl && simW(x.expl, it.expl) >= 0.6)) return null;
  const bal = balanceOptions(it.name, pickN(others, 3, rand));
  if (!bal || bal.wrong.length < 2) return null;
  return { ...place(bal.answer, bal.wrong, slot, rand), question };
}

// ---------------------------------------------------------------- guards for written questions (v1.0.17) ------
const SUPERLATIVE = /\b(primar(?:y|ily)|main(?:ly)?|most(?:ly)?|best|major|biggest|chief(?:ly)?|principal(?:ly)?|greatest|foremost|leading|central|ultimate|fundamental(?:ly)?|key|top|core|overall|largest|smallest|least|largely|predominant(?:ly)?)\b/i;
/** Why a model-written question must not be shown, or null. */
export function questionProblem(q: string, factText: string): string | null {
  const t = String(q ?? '');
  // "What does 'To Government' imply?": a label or short phrase is not a fact
  if (/\b(impl(?:y|ies|ied)|suggest(?:s|ed)?|connote|refers?\s+to|stands?\s+for|signif(?:y|ies))\b/i.test(t)) return 'asks what a phrase implies';
  if (/["“'‘][^"”'’]{1,40}["”'’]/.test(t) && /\b(mean|means|meant|meaning|imply|refer|indicate)\b/i.test(t)) return 'asks what a quoted phrase means';
  if (/\b(the|these|this)\s+(notes?|text|passage|excerpt|author|statement)\b/i.test(t)) return 'talks about "the notes"';
  // "primary / main / most important" only when the notes themselves say so
  const sup = t.match(SUPERLATIVE);
  if (sup && !new RegExp(`\\b${sup[1]}`, 'i').test(factText)) return `superlative "${sup[1]}" not in the notes`;
  if (/\b(?:most|least)\s+important\b/i.test(t) && !/\b(?:most|least)\s+important\b/i.test(factText)) return 'superlative not in the notes';
  const qw = contentWords(t).map(stem);
  const fw = new Set(contentWords(factText).map(stem));
  if (!qw.some((w) => fw.has(w))) return 'question is not about this fact';
  return null;
}

/** The key must be stated in the fact itself (most of its words, or verbatim), not guessed. */
export function answerStated(answer: string, factText: string): boolean {
  const aw = [...new Set(contentWords(answer).map(stem))];
  if (!aw.length) return false;
  const fw = new Set(contentWords(factText).map(stem));
  const nums = (answer.match(/\d+/g) ?? []).every((n) => factText.includes(n));
  return nums && aw.filter((w) => fw.has(w)).length / aw.length >= 0.7;
}

// One worked example teaches the 1B model the exact shape (a real question, short options of equal length) far
// better than rules alone; it costs ~70 prompt tokens.
const EXAMPLE_NOTE = 'Photosynthesis takes place in the chloroplasts of plant cells, using light energy.';
const EXAMPLE_JSON = '{"question":"Where does photosynthesis take place?","answer":"In the chloroplasts","wrong":["In the nucleus","In the mitochondria","In the cell wall"]}';

export function buildFactMcqPrompt(f: Pick<Fact, 'text' | 'context' | 'kind' | 'lead'>, attempt = 0) {
  const system =
    'Write one multiple-choice exam question from a student\'s notes. Ask about a fact the notes state; the correct answer is written in the notes. ' +
    'No "primary", "main" or "most important" unless the notes say it; never ask what a word or phrase means or implies. ' +
    'Three believable wrong answers, different from each other. Every answer is a short phrase of 1 to 6 words. JSON only.\n\n' +
    `Example notes: ${EXAMPLE_NOTE}\nExample JSON: ${EXAMPLE_JSON}`;
  const angle = ANGLES[attempt % ANGLES.length];
  const user = `Notes: ${f.lead ? f.lead + ' ' : ''}${f.text}\n\n${angle ? angle + '\n' : ''}Write one multiple-choice question about these notes. JSON:`;
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
  // Questions that need no model (or only a few words from it) are spread through each lane, first one first:
  // the first question shows almost at once and the next ones are written while the student answers.
  const free = (f: Fact) => f.kind === 'define' || (f.kind === 'member' && memberNeedsModel(f) === 0);
  const interleave = (g: Fact[]) => {
    const a = shuffle(g.filter(free)), b = shuffle(g.filter((x) => !free(x)));
    const out: Fact[] = [];
    while (a.length || b.length) {
      if (a.length) out.push(a.shift()!);
      if (b.length) out.push(b.shift()!);
    }
    return out;
  };
  const lanes = shuffle([...groups.values()].map((g) => interleave(g.slice())));
  const order: Fact[] = [];
  for (let i = 0; order.length < facts.length; i++) {
    const lane = lanes[i % lanes.length];
    const k = Math.floor(i / lanes.length);
    if (k < lane.length) order.push(lane[k]);
    if (i > facts.length * (lanes.length + 1)) break;
  }
  const goal = Math.min(target, facts.length);
  const slot = positionBag(rand);
  const asked: { q: string; a: string; src: string; kind: Fact['kind'] }[] = [];
  const common = commonEntities(chunks.map((c) => c.text));
  // Each fact gets up to 3 tries (a different wording angle each time), spread out: first pass over every fact,
  // then the facts that failed get their next try. Total attempts are capped so a hopeless note ends.
  const tries = new Map<Fact, number>();
  const budget = Math.max(goal * 5, 12);
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
      // List questions need the model only for made-up wrong answers, and only when the notes don't give enough.
      const need = f.kind === 'define' ? 0 : f.kind === 'member' ? memberNeedsModel(f) : 1;
      for (; need > 0; ) {
        try {
          raw = await deps.generate(
            f.kind === 'member' ? buildMemberWrongPrompt(f) : buildFactMcqPrompt(f, n),
            f.kind === 'member' ? { maxTokens: 45, temp: 0.7, jsonSchema: WRONG_ONLY_SCHEMA } : { maxTokens: 110, temp: n ? 0.75 : 0.5, jsonSchema: FACT_MCQ_SCHEMA },
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
      if (need > 0) attempts++;
      tries.set(f, n + 1);
      const src = byId.get(f.chunkId)!;
      const at = slot(4);
      let keyed: Mcq | null = null;
      let why = '';
      if (f.kind === 'define') {
        keyed = makeDefineMcq(f, at, rand);
        why = 'define: options';
      } else if (f.kind === 'member') {
        keyed = makeMemberMcq(f, need > 0 ? madeUpWrong(raw, f) : [], at, rand);
        why = 'list: not enough safe wrong options';
      } else {
        const parsed = parseFactMcq(raw, at, rand, `${f.text} ${f.context}`);
        const factOnly = `${f.lead ? f.lead + ' ' : ''}${f.text}`;
        const prob = parsed ? questionProblem(parsed.question, factOnly) : 'format/length';
        keyed = !parsed || prob ? null : checkMcqKey(parsed, `${f.text} ${f.context}`.trim());
        if (keyed && !answerStated(keyed.answer, factOnly)) {
          keyed = null;
          why = 'answer not stated in the fact';
        } else why = prob ?? 'answer key';
      }
      const dup = !!keyed && f.kind === 'sentence' && isNearDuplicate(keyed.question, asked.filter((x) => x.kind === 'sentence'), keyed.answer, common);
      const same = !!keyed && asked.some((x) => x.q === keyed!.question && x.a === keyed!.answer);
      if (!keyed || dup || same) {
        deps.onReject?.(!keyed ? why : 'duplicate', raw, f);
        if (f.kind === 'sentence' && (tries.get(f) ?? 0) < 3) failed.push(f);
        else if (f.kind === 'member' && need > 0 && (tries.get(f) ?? 0) < 2) failed.push(f);
        continue;
      }
      asked.push({ q: keyed.question, a: keyed.answer, src: f.chunkId, kind: f.kind });
      if (deps.shouldStop()) break;
      made++;
      deps.onQuestion({ ...keyed, source: src, fact: f.text });
    }
    queue = failed;
    if (attempts >= budget || deps.shouldStop()) break;
  }
  return { made, target: goal, stopped: deps.shouldStop(), attempts };
}
