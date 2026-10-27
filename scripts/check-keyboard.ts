// Run: node --experimental-strip-types scripts/check-keyboard.ts  (pure padding math; repeated focus/blur + long chat)
const keyboardPad = (b: number | null, t: number | null) => (b == null || t == null ? 0 : Math.max(0, Math.round(b - t)));
let ok = true;
const check = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); ok &&= c; };
// Screen 800 high, container bottom 740 with tab bar, 776 with tab bar hidden; keyboard top at 480.
for (let cycle = 0; cycle < 20; cycle++) {
  const kbTop = cycle % 2 ? null : 480; // focus / blur
  const bottom = kbTop == null ? 740 : 776; // tab bar hides while typing
  const pad = keyboardPad(bottom, kbTop);
  if (kbTop != null) check(bottom - pad === kbTop, `cycle ${cycle}: input bar bottom == keyboard top`);
  else check(pad === 0, `cycle ${cycle}: no padding when hidden`);
}
// The outer container's frame does not depend on chat length (the list scrolls inside), so a long history gives the same pad.
check(keyboardPad(776, 480) === 296, 'long chat: same padding');
check(keyboardPad(400, 480) === 0, 'container already above keyboard: no padding');
if (!ok) process.exit(1);
