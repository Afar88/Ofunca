// Run: node --experimental-strip-types scripts/check-mcq-key.ts
import { checkMcqKey, tidySnippetStart } from '../src/rag.ts';
const excerpt = 'out. 3. Continuous engagement with stakeholders. 4. Promotes public interest. The communication strategy of an organization sets how it informs the public.';
const options = ['Promotes public interest', 'Encourages dialogue', 'Focus on public relations', 'Encourages feedback'];
const q = { question: "What is the primary goal of an organization's communication strategy?", answer: 'Encourages dialogue', options, correct: 1 };
const r = checkMcqKey(q, excerpt);
let ok = true;
const check = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); ok &&= c; };
check(!!r && r.correct === 0 && r.answer === 'Promotes public interest' && r.options[r.correct] === r.answer, 'bad key B re-keyed to A');
check(checkMcqKey({ ...q, answer: options[0], correct: 0 }, excerpt)?.correct === 0, 'correct key A kept');
check(checkMcqKey(q, excerpt + ' It also encourages dialogue.') === null, 'two verbatim options -> discarded');
check(checkMcqKey(q, 'Nothing related here at all.') === null, 'no support for any option -> dropped (v1.0.15)');
check(tidySnippetStart('out. 3. Continuous engagement') === '3. Continuous engagement', 'snippet starts at boundary');
if (!ok) process.exit(1);

// Short-notes quiz: revisits read a different slice and carry a different focus hint.
import { buildMcqPrompt, excerptWindow } from '../src/rag.ts';
const long = Array.from({ length: 12 }, (_, i) => `Point ${i + 1} explains public affairs topic number ${i + 1}.`).join(' ');
const w0 = excerptWindow(long, 0), w1 = excerptWindow(long, 1), w2 = excerptWindow(long, 2);
check(w0 === long && w1 !== w0 && w2 !== w1 && /^[A-Z]/.test(w1), 'revisits use different passage slices');
const p1 = buildMcqPrompt(long, ['Q?'], 1)[1].content, p0 = buildMcqPrompt(long, [], 0)[1].content;
check(p1.includes('different item') && !p0.includes('different item'), 'revisit prompt has a focus hint');
const target = 10, budget = Math.max(target * 3, 12);
check(budget === 30 && Math.max(1 * 3, 12) === 12, 'attempt budget = max(target*3, 12)');
if (!ok) process.exit(1);

// ---------- v1.0.15: stricter key check (same place in the passage, dates/numbers must match) ----------
import { isNearDuplicate, commonEntities, quizPassage, supportingSentence, cleanAnswer, dropNotFoundTail, isNotFound, isSummaryRequest, endAtSentence, NOT_FOUND } from '../src/rag.ts';
const olx =
  'OLX shut down its Nigerian operations in 2020 and its users were directed to Jiji. ' +
  'Jiji had acquired OLX Nigeria in 2019 to grow its market share in the country. ' +
  'The move helped Jiji become the largest online marketplace in Nigeria. ' +
  'Meanwhile, OLX Group said it wanted to focus on its core markets in Europe and Asia.';
const mk = (question: string, options: string[], correct: number) => ({ question, options, correct, answer: options[correct] });
// Q1-style: key built from scattered words ("online", "OLX") with nothing saying "bolster online presence".
const q1 = mk('Why did OLX Group shut down its Nigerian operations?', ["Bolster OLX's online presence", 'Focus on its core markets', 'Reduce taxes', 'Hire more staff'], 0);
const r1 = checkMcqKey(q1, olx);
check(!!r1 && r1.answer === 'Focus on its core markets', 'OLX Q1: unsupported key re-keyed to the stated reason');
check(checkMcqKey(mk('Why did OLX Group shut down its Nigerian operations?', ["Bolster OLX's online presence", 'Reduce costs', 'Reduce taxes', 'Hire more staff'], 0), olx) === null, 'OLX Q1: no option stated -> dropped');
// Q4-style: dates.
const q4 = mk('In what year did OLX shut down its Nigerian operations?', ['2019', '2020', '2018', '2021'], 0);
const r4 = checkMcqKey(q4, olx);
check(!!r4 && r4.answer === '2020', 'OLX Q4: 2019 keyed, passage says 2020 for the shutdown -> re-keyed');
check(checkMcqKey(mk('In what year did OLX shut down its Nigerian operations?', ['2019', '2017', '2018', '2021'], 0), olx) === null, 'date not in passage for that fact -> dropped');
check(checkMcqKey(mk('What happened to OLX in 2016?', ['It shut down', 'It grew', 'It merged', 'It moved'], 0), olx) === null, 'question built on a date the notes do not have -> dropped');
check(checkMcqKey(mk('Who acquired OLX Nigeria in 2019?', ['Jiji', 'Jumia', 'Konga', 'Amazon'], 0), olx)?.answer === 'Jiji', 'correct key with matching date kept');

// ---------- duplicates by topic / entities ----------
const prior = [{ q: 'Why were OLX users in Nigeria directed to Jiji?', a: 'OLX shut down its Nigerian operations' }];
check(isNearDuplicate('What was the relationship between OLX and Jiji in Nigeria?', prior, 'Jiji acquired OLX Nigeria'), 'two OLX–Jiji questions -> duplicate');
const pa = [{ q: 'What is the relationship between PA and stakeholders?', a: 'Continuous engagement' }];
check(isNearDuplicate('How does PA build relationships with its stakeholders?', pa, 'Through dialogue'), 'two PA–stakeholder relationship questions -> duplicate');
check(!isNearDuplicate('What does a press release announce?', pa, 'News to the media'), 'different topic -> kept');
const notes = ['Public Affairs (PA) informs citizens.', 'Public Affairs manages media.', 'Public Affairs works with government.', 'Press releases go to the media.'];
const common = commonEntities(notes);
check(common.has('public') && common.has('affair'), 'subject name is a common entity');
check(!isNearDuplicate('How does Public Affairs work with Government ministries?', [{ q: 'Why does Public Affairs talk to the Media?', a: 'To inform citizens' }], 'By advising them', common), 'shared subject name alone is not a duplicate');
check(isNearDuplicate('Which company did Jiji take over?', prior, 'OLX Nigeria'), 'same entity pair from answer side -> duplicate');

// ---------- steering to a new fact ----------
const used = supportingSentence('2020', olx, 'In what year did OLX shut down its Nigerian operations?');
check(!!used && used.startsWith('OLX shut down'), 'supporting sentence found');
const next = quizPassage(olx, 0, used ? [used] : []);
check(!next.includes('shut down its Nigerian operations in 2020') && next.includes('Jiji had acquired'), 'used fact removed from the next prompt');

// ---------- Summarise answers ----------
const leaked = 'The notes cover public affairs [1. Public affairs is the management of relations] and media work [2]. However, I couldn’t find a direct answer in your notes.';
const clean = cleanAnswer(dropNotFoundTail(leaked));
check(!/[\[\]]/.test(clean) && !/couldn/i.test(clean) && clean.length > 30, `summary cleaned: "${clean}"`);
check(isNotFound(NOT_FOUND) && isNotFound("I couldn't find a direct answer in your notes.") && !isNotFound(clean), 'not-found detection');
check(isSummaryRequest('Summarise the main ideas') && isSummaryRequest('give me an overview') && !isSummaryRequest('What is osmosis?'), 'summary requests detected');
check(endAtSentence('First idea. Second idea is cut') === 'First idea.', 'summary ends at a full sentence');
check(cleanAnswer('Osmosis moves water [2].') === 'Osmosis moves water.', 'normal [n] citation removed');
if (!ok) process.exit(1);
import { parseMcq } from '../src/rag.ts';
check(parseMcq('{"question":"OLX Nigeria was acquired by Jiji in 2019.","answer":"OLX Nigeria was acquired by Jiji in 2019.","wrong":["a","b","c"]}') === null, 'statement instead of a question -> skipped');
check(parseMcq('{"question":"In 2020, when did OLX shut down?","answer":"2020","wrong":["2019","2018","2021"]}') === null, 'answer given away in the question -> skipped');
check(parseMcq(JSON.stringify({ question: "What is the leaf shape also known as the 'heliotrope leaf'?", answer: 'Heliotrope leaf', wrong: ['x y', 'c d', 'e f'] })) === null, 'quoted answer inside the question -> skipped');
check(parseMcq('{"question":"Who acquired OLX Nigeria?","answer":"To promote x","wrong":["promote x","b","c"]}')?.options.length === 3, '"To promote x" and "promote x" are one option');
if (!ok) process.exit(1);
const bio = 'Aerobic respiration releases energy from glucose using oxygen, producing carbon dioxide, water and about 38 ATP molecules per glucose. It occurs in the mitochondria. Anaerobic respiration in muscles produces lactic acid and much less energy (2 ATP).';
check(checkMcqKey(mk('Where is lactic acid produced during anaerobic respiration?', ['Mitochondria', 'Nucleus', 'Ribosome', 'Vacuole'], 0), bio) === null, 'neighbouring-sentence answer (mitochondria) -> dropped');
check(checkMcqKey(mk('Where does aerobic respiration occur?', ['Mitochondria', 'Nucleus', 'Ribosome', 'Vacuole'], 0), bio)?.answer === 'Mitochondria', 'same-sentence short answer kept');
check(checkMcqKey(mk('How many ATP does anaerobic respiration in muscles make?', ['38', '2', '12', '4'], 0), bio)?.answer === '2', 'number from the wrong sentence re-keyed');
if (!ok) process.exit(1);
const leaf = 'Carbon dioxide enters the leaf through tiny pores called stomata, and water is absorbed by the roots and carried up through the xylem.';
check(checkMcqKey(mk('What is the purpose of stomata in plant cells?', ['To regulate temperature', 'Root', 'Xylem cells', 'Seeds'], 0), leaf) === null, 'single-word distractor in the right sentence is not re-keyed (dropped)');
if (!ok) process.exit(1);
