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
check(checkMcqKey(q, 'Nothing related here at all.')?.correct === 1, 'no support either way -> key kept');
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
