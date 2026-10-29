// v1.0.17: reads a note as an outline (headings, sub-labels, lists and prose), so lists keep their headings.
//
// "Importance of Public Affairs / To Government / 1. Encourages citizen participation / … / To Organizations / 1. …"
// becomes one heading with two labelled lists. Sub-labels like "To Government" are context, never facts: the quiz
// asks "which of these is an importance of Public Affairs to government?" and Ask answers the whole list at once.
// Works on text with line breaks (v1.0.17 keeps them) and, as well as it can, on older flattened notes.
// Pure TypeScript (no React, no QVAC) so node tests run the same code.

export type OutlineItem = { name: string; expl: string; raw: string };
export type OutlineList = { heading: string; sub: string; items: OutlineItem[] };
export type Prose = { text: string; heading: string };
export type Outline = { lists: OutlineList[]; prose: Prose[] };

const MARK = /^\s*\(?(\d{1,2}|[a-hA-H]|i{1,3}|iv|vi{0,3}|ix|x)[.)]\s+(?=\S)|^\s*[•▪●◦*\-–]\s+(?=\S)/;
const SEP = /^\s*(?:-{3,}|_{3,}|\*{3,}|={3,})\s*$/;

/** Older notes were saved with line breaks turned into spaces: put a break back before each list marker
 *  ("… participation 2. Promotes …") and before "---" separators. */
export function restoreLines(text: string): string {
  let t = String(text ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(/[ \t]+(-{3,}|_{3,})[ \t]+/g, '\n$1\n');
  t = t.replace(/([^\n])[ \t]+(?=\(?(?:\d{1,2}|[a-h])[.)][ \t]+[A-Z“"(])/g, '$1\n');
  t = t.replace(/([^\n])[ \t]+(?=[•▪●◦][ \t]+)/g, '$1\n');
  return t;
}

const wordsOf = (t: string) => t.match(/[A-Za-z0-9'’]+/g) ?? [];

/** A short line that names a section: "Challenges of Public Affairs", "To Government", "BACKGROUND:". */
export function isHeadingLine(t: string): boolean {
  const s = t.trim().replace(/[:\-–]\s*$/, '');
  if (!s || s.length > 80) return false;
  const w = wordsOf(s);
  if (!w.length || w.length > 9) return false;
  if (/[.!?;,]$/.test(s)) return false;
  if (!/^[A-Z0-9“"(]/.test(s)) return false;
  // a wrapped line of prose (photos and PDFs break lines mid-sentence) is not a heading
  if (/\s(?:of|the|and|to|a|an|in|is|are|with|for|that|which|or|by|as|on|its|their|from)$/i.test(s)) return false;
  if (w.length > 4 && /\s(?:is|are|was|were|has|have|can|will|must)\s/i.test(s)) return false;
  return true;
}

const PREP = /^(?:to|for|in|on|at|among|within|under|by|from|with)\b/i;
/** A sub-label inside a list section: "To Government", "For the Public", "In Organisations". */
const isSubLabel = (t: string, parentHasSubs: boolean) => {
  const w = wordsOf(t);
  if (w.length > 6) return false;
  if (PREP.test(t.trim())) return true;
  return parentHasSubs && w.length <= 3 && !/\bof\b/i.test(t);
};

/** "To inform the public – Organizations explain …" / "Low-cost promotion: Small businesses …" -> name + explanation. */
export function splitItem(raw: string): OutlineItem {
  const r = raw.trim().replace(/\s+/g, ' ');
  const m = r.match(/^(.{2,70}?)\s*(?:\s[–—-]\s|:\s)\s*(.+)$/);
  if (m && wordsOf(m[1]).length <= 9 && wordsOf(m[2]).length >= 3) return { name: clean(m[1]), expl: m[2].trim(), raw: r };
  return { name: clean(r), expl: '', raw: r };
}
const clean = (s: string) => s.trim().replace(/[.;,:\s]+$/, '');

/** Splits "…Supports business growth. To Government" into the item text and a trailing label. */
function trailingLabel(t: string): { body: string; label: string } {
  const i = Math.max(t.lastIndexOf('. '), t.lastIndexOf('? '), t.lastIndexOf('! '));
  if (i < 0) return { body: t, label: '' };
  const tail = t.slice(i + 2).trim();
  if (tail && isHeadingLine(tail) && wordsOf(tail).length <= 6) return { body: t.slice(0, i + 1).trim(), label: tail };
  return { body: t, label: '' };
}

export function outlineOf(text: string): Outline {
  const lines = restoreLines(text)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const lists: OutlineList[] = [];
  const prose: Prose[] = [];
  let top = '';
  let sub = '';
  let topHasSubs = false;
  let lastKind: 'head' | 'item' | 'text' | 'sep' = 'sep';
  let cur: OutlineList | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) prose.push({ text: para.join(' ').replace(/\s+/g, ' ').trim(), heading: top });
    para = [];
  };
  const setHead = (h: string) => {
    let head = h.replace(/[:\-–]\s*$/, '').trim();
    // "Importance of Public Affairs To Government" (flattened): a heading followed by its first sub-label
    const sm = head.match(/^(.{6,}?\S)\s+((?:To|For|Among|Within)\s(?:the\s)?[A-Z][\w'’-]*(?:\s[A-Z][\w'’-]*)?)$/);
    if (sm && /\bof\b/i.test(sm[1])) {
      setHead(sm[1]);
      head = sm[2];
    }
    flushPara();
    cur = null;
    if (top && (lastKind === 'head' || lastKind === 'item') && isSubLabel(head, topHasSubs)) {
      sub = head;
      topHasSubs = true;
    } else {
      top = head;
      sub = '';
      topHasSubs = false;
    }
    lastKind = 'head';
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (SEP.test(line)) {
      flushPara();
      cur = null;
      top = '';
      sub = '';
      topHasSubs = false;
      lastKind = 'sep';
      continue;
    }
    const m = line.match(MARK);
    if (m) {
      flushPara();
      let body = line.slice(m[0].length).trim();
      // a label stuck to the end of an item in flattened text: "4. Supports business growth. To Government"
      const tl = trailingLabel(body);
      const nm = (lines[li + 1] ?? '').match(MARK);
      let label = tl.label && nm ? tl.label : '';
      if (label) body = tl.body;
      // flattened notes: numbering starts again at 1 -> the words before it were a label ("… growth To the Public 1. …")
      if (!label && nm && /^(?:1|a|A|i)$/.test(nm[1] ?? '') && cur && cur.items.length) {
        const lm = body.match(/\s((?:To|For|In|On|Among|Under|At|Within)\s(?:the\s)?[A-Z][\w'’-]*(?:\s[A-Z][\w'’-]*)?)$/);
        if (lm && wordsOf(body).length - wordsOf(lm[1]).length >= 1) {
          label = lm[1];
          body = body.slice(0, body.length - lm[0].length).trim();
        } else {
          // "… Supports business growth Objectives of Public Affairs 1. …": a new section's heading
          const hm = body.match(/\s((?:[A-Z][\w'’\/-]*\s)+(?:of|for|to|in|faced|used)\s(?:the\s)?[A-Z]?[\w'’-]*(?:\s[A-Z][\w'’-]*)*)$/);
          if (hm && /[a-z]$/.test(body.slice(0, body.length - hm[0].length)) && wordsOf(body).length - wordsOf(hm[1]).length >= 1) {
            label = hm[1];
            body = body.slice(0, body.length - hm[0].length).trim();
          }
        }
      }
      // flattened notes: the last item runs on into the next sentence ("… from Jiji In 2019 Jiji acquired …")
      let rest = '';
      if ((!nm || label) && wordsOf(body).length > 9 && !/[–—:]/.test(body.slice(0, 60))) {
        const cm = body.match(/^(\S+(?:\s+\S+){1,8}?)\s+(?=(?:In|On|The|This|It|They|However|Meanwhile|A|An|Its|These|By)\s)/);
        if (cm) {
          rest = body.slice(cm[0].length).trim();
          body = cm[1];
        }
      }
      if (!cur) {
        cur = { heading: top, sub, items: [] };
        lists.push(cur);
      }
      cur.items.push(splitItem(body));
      lastKind = 'item';
      if (label) setHead(label);
      if (rest) {
        cur = null;
        para.push(rest);
        lastKind = 'text';
      }
      continue;
    }
    const next = lines[li + 1] ?? '';
    const nextIsList = MARK.test(next);
    // a list item wrapped onto the next line (photos, PDFs): "3. Improves communication between government and" +
    // "citizens" belongs to the item
    if (lastKind === 'item' && cur && cur.items.length) {
      const last = cur.items[cur.items.length - 1];
      if (/^[a-z(]/.test(line) || (!/[.!?:]$/.test(last.raw) && !isHeadingLine(line) && wordsOf(line).length <= 8)) {
        cur.items[cur.items.length - 1] = splitItem(`${last.raw} ${line}`);
        continue;
      }
    }
    if (isHeadingLine(line) && (nextIsList || !/^[a-z]/.test(next)) && (nextIsList || isHeadingLine(next) || lastKind !== 'text' || /:\s*$/.test(line) || /^[A-Z0-9 ()/&,-]+$/.test(line))) {
      setHead(line);
      continue;
    }
    // prose that ends with a heading for the list below it: "…stakeholders. Challenges of Public Affairs"
    if (nextIsList) {
      const tl = trailingLabel(line);
      if (tl.label) {
        if (tl.body) {
          cur = null;
          para.push(tl.body);
        }
        setHead(tl.label);
        continue;
      }
    }
    cur = null;
    para.push(line);
    lastKind = 'text';
  }
  flushPara();
  return { lists: lists.filter((l) => l.items.length >= 2), prose };
}

/** "Importance of Public Affairs" + "To Government" -> "Importance of Public Affairs (to government)". */
export function listTitle(l: Pick<OutlineList, 'heading' | 'sub'>): string {
  const h = l.heading || 'List';
  return l.sub ? `${h} (${lowerFirst(l.sub)})` : h;
}
export const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) && !/^[A-Z][a-z]+[A-Z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
