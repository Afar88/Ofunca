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

// v1.0.15: the keyboard top comes from the native IME inset on every change (same math as src/keyboard.tsx).
const imeTop = (h: number | null | undefined, wh: number | null | undefined) =>
  typeof h !== 'number' || !(h > 1) || typeof wh !== 'number' || !(wh > 0) ? null : Math.max(0, wh - h);
const GAP = 6;
const padFor = (bottom: number, h: number) => { const t = imeTop(h, 800); return t == null ? 0 : keyboardPad(bottom, t - GAP); };
// Keyboard opens at 300 dp, then the suggestion strip appears and it grows to 344 dp: no RN event, but a native one.
check(padFor(776, 300) === 776 - (500 - GAP), 'keyboard 300dp: bar sits 6dp above it');
check(776 - padFor(776, 344) <= 800 - 344 - GAP, 'suggestion strip (+44dp): bar moves up with it, fully visible');
check(776 - padFor(776, 380) <= 800 - 380 - GAP, 'clipboard/emoji strip (+80dp): still fully visible');
check(imeTop(0, 800) === null && padFor(740, 0) === 0, 'keyboard closed (inset 0): no padding');
if (!ok) process.exit(1);
