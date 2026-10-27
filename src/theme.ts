export type Palette = typeof LIGHT;

export const LIGHT = {
  bg: '#FFF4FB',
  card: '#FFFFFF',
  border: '#F5D9EC',
  text: '#2A1145',
  muted: '#8A6FA3',
  primary: '#8B2CF5',
  primaryDeep: '#5B12B8',
  primarySoft: '#F1E4FF',
  pink: '#FF4FA3',
  pinkDeep: '#C81E74',
  accent: '#FF9F1C',
  accentText: '#9A4A00',
  quote: '#FFF4E0',
  track: '#F5D9EC',
  ok: '#D9FBE8',
  okText: '#0E7A43',
  warnBg: '#FFF1C7',
  warnText: '#8A5A00',
  danger: '#E5294F',
  header: '#8B2CF5',
};

export const DARK: Palette = {
  bg: '#170A2E',
  card: '#26134A',
  border: '#3D2470',
  text: '#F7EEFF',
  muted: '#B9A3DA',
  primary: '#A855F7',
  primaryDeep: '#6D1FC9',
  primarySoft: '#3A1E6B',
  pink: '#FF5FB0',
  pinkDeep: '#B3175F',
  accent: '#FFB23F',
  accentText: '#FFD38A',
  quote: '#33204F',
  track: '#3D2470',
  ok: '#123D2A',
  okText: '#7CF0B0',
  warnBg: '#3E2C0A',
  warnText: '#FFD38A',
  danger: '#FF6B86',
  header: '#3A1677',
};

/** Candy colours for subject chips, one per subject. [face, bottom edge] */
export const CANDY: [string, string][] = [
  ['#FF4FA3', '#C81E74'], // bubblegum
  ['#22B8F0', '#0B7FB0'], // blue raspberry
  ['#FF9F1C', '#C46A00'], // orange drop
  ['#2ECC71', '#1A8E4D'], // lime
  ['#FFC83D', '#C79200'], // lemon
  ['#8B2CF5', '#5B12B8'], // grape
];

/** The live palette. Its values are swapped in place when the theme changes. */
export const C: Palette = { ...LIGHT };
