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

const EU: any = (globalThis as any).ErrorUtils;
if (EU?.getGlobalHandler) {
  const prev = EU.getGlobalHandler();
  EU.setGlobalHandler((err: any, fatal?: boolean) => {
    noteError(err, fatal ? 'crash' : '');
    prev?.(err, fatal);
  });
}
