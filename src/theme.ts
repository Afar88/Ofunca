export type Palette = typeof LIGHT;

export const LIGHT = {
  bg: '#F5F6FB',
  card: '#FFFFFF',
  border: '#E5E7F0',
  text: '#141A2E',
  muted: '#6B7189',
  primary: '#4338CA',
  primarySoft: '#E8E7FB',
  accent: '#F59E0B',
  accentText: '#92400E',
  quote: '#FFF8EB',
  track: '#E5E7F0',
  ok: '#DCFCE7',
  okText: '#166534',
  warnBg: '#FEF3C7',
  warnText: '#92400E',
  danger: '#DC2626',
};

export const DARK: Palette = {
  bg: '#0B1020',
  card: '#151B2E',
  border: '#262E47',
  text: '#E8EBF7',
  muted: '#98A0BD',
  primary: '#6366F1',
  primarySoft: '#242B55',
  accent: '#F59E0B',
  accentText: '#FCD34D',
  quote: '#221D10',
  track: '#262E47',
  ok: '#123522',
  okText: '#86EFAC',
  warnBg: '#3A2E0A',
  warnText: '#FCD34D',
  danger: '#F87171',
};

/** The live palette. Its values are swapped in place when the theme changes. */
export const C: Palette = { ...LIGHT };
