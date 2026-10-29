// Run: node --import ./scripts/ts-resolve.mjs --experimental-strip-types scripts/check-quiz.ts
// v1.0.16 checks: option labels, answer length, even answer letters, facts/capacity, the model lock (Ask first,
// quiz paused and resumed), and the keyboard offset.
import { stripOptionMarker, balanceOptions, parseFactMcq, positionBag, factsOfText, factsOf, countFacts, capacityFromFacts, mergeChunks, listQuestion, parseListMcq, writeQuiz, Preempted as QuizPreempted } from '../src/quizGen.ts';
import { PriorityLock, Preempted, PRI } from '../src/llmLock.ts';
import { chunkText } from '../src/chunk.ts';
import { outlineOf } from '../src/outline.ts';
import { memberQuestion, properWords, makeMemberMcq, questionProblem, inNotes, answerStated } from '../src/quizGen.ts';
import { listAnswer, stripListNumbers } from '../src/rag.ts';
// same math as src/keyboard.tsx (node can't load .tsx)
const KEYBOARD_GAP = 10;
const keyboardPad = (b: number | null, t: number | null) => (b == null || t == null ? 0 : Math.max(0, Math.round(b - t)));
function imeTop(height: any, windowHeight: any, offsetTop: any = 0): number | null {
  if (typeof height !== 'number' || !(height > 1) || typeof windowHeight !== 'number' || !(windowHeight > 0)) return null;
  const off = typeof offsetTop === 'number' && offsetTop > 0 && offsetTop < 200 ? offsetTop : 0;
  return Math.max(0, windowHeight - height - off);
}

let ok = true;
const check = (c: boolean, m: string) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  ok &&= c;
};

// 1. Doubled labels from the v1.0.15 test
for (const [i, o] of [
  ['A. B. Online security measures', 'Online security measures'],
  ['C. A. User retention strategy', 'User retention strategy'],
  ['A. 3. Negative media coverage', 'Negative media coverage'],
  ['B. 1. Financial constraints', 'Financial constraints'],
  ['(c) Money.', 'Money'],
  ['a - Trust', 'Trust'],
  ['Option B: Cats', 'Cats'],
  ['iv) Strategic', 'Strategic'],
  ['2.5 million users', '2.5 million users'],
  ['1990s growth', '1990s growth'],
  ['A broader function', 'A broader function'],
]) check(stripOptionMarker(i) === o, `strip "${i}" -> "${o}" (got "${stripOptionMarker(i)}")`);

// 2. A long, copied answer is trimmed to its clause or the question is dropped
const long = 'Trust must be treated as a core product feature: Digital businesses need strong systems for verification, fraud prevention and dispute handling';
const b1 = balanceOptions(long, ['Online security measures', 'Business model diversification', 'User retention strategy']);
check(b1 === null || b1.answer.split(' ').length <= Math.ceil(3 * 1.8), 'giveaway-long answer trimmed or dropped');
const b2 = balanceOptions('Managing external relationships', ['Building bridges', 'Facilitating dialogue', 'Stabilizing relationships']);
check(!!b2 && b2.answer === 'Managing external relationships', 'normal answer kept');
const p = parseFactMcq('{"question":"Which challenge?","answer":"B. 1. Financial constraints","wrong":["A. 3. Negative media coverage","C. 2. Political interference","D. 4. Misinformation"]}', 2, () => 0.3);
check(!!p && p.options[p.correct] === 'Financial constraints' && p.correct === 2 && p.options.every((o) => !/^[A-D1-4]\./.test(o)), 'parsed options clean, key at the asked slot');

// 3. Even spread of the right letter
const bag = positionBag(() => 0.42);
const counts = [0, 0, 0, 0];
for (let i = 0; i < 400; i++) counts[bag(4)]++;
check(counts.every((c) => c === 100), `answer letters evenly spread ${counts.join('/')}`);

// 4. Facts and capacity
const pa = `Meaning of Public Affairs\n\nPublic Affairs is the management of communication between an organization and its various publics on matters such as public interest, government policies, community development, and social responsibility.\n\nChallenges of Public Affairs\n1. Financial constraints\n2. Political interference\n3. Negative media coverage\n4. Misinformation and fake news\nA broader communication function. Deals with all publics, especially external stakeholders.`;
const chunks = chunkText(pa).map((c, i) => ({ id: 'c' + i, docId: 'd', text: c.text, vec: [] as number[] }));
const facts = factsOf(chunks);
check(facts.some((f) => f.kind === 'member' && f.text.startsWith('Challenges of Public Affairs: Financial constraints; Political interference; Negative media coverage; Misinformation and fake news')), 'numbered list found with its heading');
check(countFacts(chunks.map((c) => c.text)) > 0 && countFacts(chunks.map((c) => c.text)) <= facts.length, 'expected question count at import is at most the facts at quiz time');
check(capacityFromFacts(10.9) === 10 && capacityFromFacts(0.5) === 0, 'capacity is the stored expected count, rounded down');
check(parseFactMcq('{"question":"Why does anaerobic respiration occur when oxygen is scarce?","answer":"Anaerobic respiration happens when oxygen is scarce","wrong":["It is a backup","It makes heat","It is faster"]}') === null, 'answer that only repeats the question is dropped');
check(mergeChunks(['alpha beta gamma delta epsilon zeta eta theta', 'delta epsilon zeta eta theta iota kappa']) === 'alpha beta gamma delta epsilon zeta eta theta iota kappa', 'overlapping passages merge');
check(listQuestion('Challenges of Public Affairs') === 'Which of these is one of the challenges of public affairs?', 'list question wording');
const lq = parseListMcq('{"wrong":["Political interference","Staff shortages","Weak branding","Poor timing"]}', { text: 'Challenges of PA: Financial constraints; Political interference; Negative media coverage.' }, 0, 1, () => 0.5);
check(!!lq && lq.answer === 'Financial constraints' && !lq.options.includes('Political interference') && lq.options[lq.correct] === lq.answer, 'list question: listed item is the key, listed items never wrong options');
check(factsOfText('Short.').length === 0, 'tiny note has no facts');

// 5. The model lock: Ask preempts a quiz question; the quiz resumes and still reaches its target
const lock = new PriorityLock();
const order: string[] = [];
{
  let preempted = false;
  const q = lock.acquire(PRI.quiz, () => (preempted = true));
  const rq = await q.ready;
  const a = lock.acquire(PRI.ask);
  check(preempted, 'a waiting Ask preempts the quiz holder');
  rq();
  const ra = await a.ready;
  order.push('ask');
  ra();
  check(!lock.busy, 'lock released');
  const w1 = lock.acquire(PRI.quiz);
  const r1 = await w1.ready;
  const w2 = lock.acquire(PRI.quiz);
  const w3 = lock.acquire(PRI.ask);
  let first = '';
  w2.ready.then((r) => { if (!first) first = 'quiz'; r(); });
  w3.ready.then((r) => { if (!first) first = 'ask'; r(); });
  r1();
  await new Promise((r) => setTimeout(r, 10));
  check(first === 'ask', 'Ask jumps ahead of waiting quiz questions');
  const w4 = lock.acquire(PRI.quiz);
  const r4 = await w4.ready;
  const w5 = lock.acquire(PRI.quiz);
  let cancelled = false;
  w5.ready.catch(() => (cancelled = true));
  w5.cancel();
  await new Promise((r) => setTimeout(r, 5));
  r4();
  check(cancelled && !lock.busy, 'Stop cancels a waiting quiz question');
}
{
  // writeQuiz with a fake model that gets preempted twice: preempted attempts are retried and not counted.
  let calls = 0;
  const things = [
    ['The heart', 'pumps blood around the whole body through arteries'],
    ['The lungs', 'take in oxygen and release carbon dioxide during breathing'],
    ['The kidneys', 'filter waste from the blood and produce urine daily'],
    ['The liver', 'stores glycogen and breaks down harmful toxins quickly'],
    ['The stomach', 'mixes food with acid and enzymes before digestion continues'],
    ['The skin', 'protects inner organs and helps control body temperature'],
    ['The brain', 'controls thinking, memory, movement and the senses'],
    ['Bones', 'support the body, protect organs and make red blood cells'],
  ];
  const text = things.map(([a, b]) => `${a} ${b}.`).join(' ');
  const cs = chunkText(text).map((c, i) => ({ id: 'k' + i, docId: 'e', text: c.text, vec: [] as number[] }));
  const got: string[] = [];
  const res = await writeQuiz(cs, 5, {
    generate: async (h) => {
      calls++;
      if (calls === 2 || calls === 4) throw new QuizPreempted();
      const t = things.find(([a]) => h[1].content.includes(a + ' '))!;
      const others = things.filter((x) => x !== t).map(([a]) => a).slice(0, 3);
      return JSON.stringify({ question: `Which organ ${t[1].split(' ').slice(0, 4).join(' ')}?`, answer: t[0], wrong: others });
    },
    shouldStop: () => false,
    onQuestion: (q) => got.push(q.question),
  });
  check(res.made === 5 && got.length === 5, `quiz reached 5 of 5 despite 2 Ask interruptions (made ${res.made}, attempts ${res.attempts})`);
  check(res.attempts === calls - 2, `interrupted attempts are not counted against the budget (${res.attempts} counted of ${calls} calls)`);
}

// 6. Keyboard: native offset brings the IME top into measureInWindow coordinates
// Redmi: window 873 dp, status bar 32 dp, keyboard + strip 330 dp. measureInWindow y = screen y - 32.
const top = imeTop(330, 873, 32)!;
check(top === 873 - 330 - 32, 'keyboard top in RN window coordinates');
const containerBottom = 873 - 32 - 48; // bottom of the Ask area in RN coordinates (above the nav bar)
const pad = keyboardPad(containerBottom, top - KEYBOARD_GAP);
check(containerBottom - pad + 32 <= 873 - 330 - KEYBOARD_GAP + 0.5, 'input bar bottom sits fully above the keyboard on screen');
check(imeTop(330, 873, undefined) === 873 - 330, 'old native event without offset still works');

// 7. v1.0.17: list labels, superlatives, list answers
{
  const notes = `Importance of Public Affairs\nTo Government\n1. Encourages citizen participation\n2. Promotes transparency\n3. Improves communication\nTo Organizations\n1. Protects corporate reputation\n2. Prevents conflict\n3. Supports business growth\n\nObjectives of Public Affairs\n1. To inform the public – Organizations explain their policies to the people.\n2. To influence public policy – Practitioners present the organization's position to lawmakers.\n3. To build goodwill – A good reputation makes it easier to operate.`;
  const ol = outlineOf(notes);
  check(ol.lists.length === 3 && ol.lists[0].sub === 'To Government' && ol.lists[1].sub === 'To Organizations', 'sub-labels are labels of their lists');
  check(!ol.lists.flatMap((l) => l.items.map((x) => x.name)).some((n) => /^To (Government|Organizations)/.test(n)), 'sub-labels are never items');
  const flat = outlineOf(notes.replace(/\s+/g, ' '));
  check(flat.lists.length === 3 && flat.lists[1].sub === 'To Organizations', 'flattened (pre-1.0.17) notes keep their sub-labels');
  check(memberQuestion(ol.lists[0], properWords(notes)) === 'According to your notes, which of these is an importance of Public Affairs to government?', `member question wording (${memberQuestion(ol.lists[0], properWords(notes))})`);
  const fs = factsOf(chunkText(notes).map((c, i) => ({ id: 'n' + i, docId: 'n', text: c.text })));
  const gov = fs.find((f) => f.kind === 'member' && f.list?.sub === 'To Government' && !f.neg)!;
  const mq = makeMemberMcq(gov, [], 0, () => 0.3);
  check(!!mq && mq.answer === 'Encourages citizen participation' && mq.options.filter((o) => ['Encourages citizen participation', 'Promotes transparency', 'Improves communication'].includes(o)).length === 1, 'list question: exactly one option from the key list');
  check(questionProblem("What does 'To Government' in the notes imply?", 'To Government: encourages citizen participation') !== null, 'rejects "what does X imply"');
  check(questionProblem('What is the primary objective of Public Affairs?', 'Objectives of Public Affairs: To inform the public') !== null, 'rejects "primary" when the notes do not say it');
  check(questionProblem('What is the main purpose of OLX?', 'The main purpose of OLX was to connect buyers and sellers.') === null, 'keeps "main" when the notes say it');
  check(inNotes('To promote the public interest', ['Public Affairs deals with issues of public interest.']), 'a paraphrase of the notes is not a safe wrong option');
  const la = listAnswer('Importance of public affairs', notes);
  check(!!la && la.answer.includes('To Government: encourages citizen participation') && la.answer.includes('To Organizations:') && !/\d\./.test(la.answer), 'Ask: whole list with sub-labels, no "1." fragments');
  check(stripListNumbers('To Government 1. Encourages citizen participation 2. Promotes transparency') === 'To Government Encourages citizen participation Promotes transparency', 'stray list numbers stripped');
  check(answerStated('Jiji', 'In 2019 Jiji acquired OLX Nigeria.') && !answerStated('Jumia', 'In 2019 Jiji acquired OLX Nigeria.'), 'key must be stated in the fact');
}

if (!ok) process.exit(1);
console.log('ALL OK');
