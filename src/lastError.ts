let last = '';
let at = 0;

export function noteError(e: any, where = '') {
  const msg = String(e?.message ?? e ?? '').replace(/\s+/g, ' ').trim();
  if (!msg) return;
  last = `${where ? where + ': ' : ''}${msg}`.slice(0, 90);
  at = Date.now();
}

export function lastErrorLine(): string {
  if (!last) return '';
  const mins = Math.round((Date.now() - at) / 60000);
  return `Last error (${mins < 1 ? 'just now' : mins + ' min ago'}): ${last}`;
}

// A stray JS error outside React rendering (a timer, a native callback, an event handler) normally kills a
// release app. In release builds Ofunca notes it and shows a friendly message instead; in development the
// normal red screen still appears so bugs are never hidden.
type Listener = (err: any) => void;
let listener: Listener | null = null;
export function onStrayError(l: Listener | null) {
  listener = l;
}

const EU: any = (globalThis as any).ErrorUtils;
if (EU?.getGlobalHandler) {
  const prev = EU.getGlobalHandler();
  EU.setGlobalHandler((err: any, fatal?: boolean) => {
    noteError(err, fatal ? 'crash' : '');
    if (typeof __DEV__ !== 'undefined' && __DEV__) return prev?.(err, fatal);
    try {
      listener?.(err);
    } catch {}
  });
}
