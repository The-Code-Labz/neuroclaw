// Stateless text-fit estimator. Flags box overflow BEFORE a translation is
// locked/rendered, instead of discovering it in a Canva/design QA pass.
//
// Model: charCount(candidate text) × per-script width multiplier vs. box
// pixel dimensions, wrapped line-by-line. No network/DB — pure function, safe
// to call as many times as needed while iterating on a translation.
//
// Multiplier table = the standard localization expansion/contraction ratio
// relative to English (not raw glyph width): CJK conveys the same meaning in
// notably fewer/denser characters (~0.55x), French/German commonly run
// 15-20% longer than English for equivalent meaning, everything else is
// treated as Latin/English baseline (1.0x).
const SCRIPT_MULTIPLIERS: Record<string, number> = {
  ja: 0.55, zh: 0.55, 'zh-cn': 0.55, 'zh-tw': 0.55, ko: 0.55,
  fr: 1.15,
  de: 1.20,
  en: 1.0,
};
const DEFAULT_MULTIPLIER = 1.0;

// Average proportional-font glyph advance width as a fraction of font size
// (em), calibrated against common UI/display webfonts. Combined with the
// script multiplier to approximate rendered width per character.
const DEFAULT_CHAR_WIDTH_EM = 0.55;
const DEFAULT_LINE_HEIGHT_MULTIPLIER = 1.2;

function resolveLocaleKey(locale: string): string {
  const l = (locale ?? '').trim().toLowerCase();
  if (SCRIPT_MULTIPLIERS[l] != null) return l;
  const base = l.split('-')[0];
  return SCRIPT_MULTIPLIERS[base] != null ? base : l;
}

export interface TextFitInput {
  text: string;
  locale: string;
  boxWidthPx: number;
  boxHeightPx: number;
  fontSizePx: number;
  lineHeightMultiplier?: number;
  charWidthEm?: number;
}

export interface TextFitResult {
  ok: boolean;
  fits: boolean;
  charCount: number;
  locale: string;
  multiplier: number;
  multiplierResolved: boolean; // false when locale had no table entry (fell back to 1.0)
  charsPerLine: number;
  linesNeeded: number;
  linesAvailable: number;
  overflowRatio: number;       // 0 when it fits; else (linesNeeded/linesAvailable - 1)
  recommendation: string;
  error?: string;
}

export function estimateTextFit(input: TextFitInput): TextFitResult {
  const {
    text, locale, boxWidthPx, boxHeightPx, fontSizePx,
    lineHeightMultiplier = DEFAULT_LINE_HEIGHT_MULTIPLIER,
    charWidthEm = DEFAULT_CHAR_WIDTH_EM,
  } = input;

  const base: Omit<TextFitResult, 'ok' | 'error'> = {
    fits: false, charCount: 0, locale, multiplier: DEFAULT_MULTIPLIER, multiplierResolved: false,
    charsPerLine: 0, linesNeeded: 0, linesAvailable: 0, overflowRatio: 0, recommendation: '',
  };

  if (!text || !text.trim()) return { ...base, ok: false, error: 'text is empty' };
  if (boxWidthPx <= 0 || boxHeightPx <= 0) return { ...base, ok: false, error: 'boxWidthPx/boxHeightPx must be > 0' };
  if (fontSizePx <= 0) return { ...base, ok: false, error: 'fontSizePx must be > 0' };

  const localeKey = resolveLocaleKey(locale);
  const multiplierResolved = SCRIPT_MULTIPLIERS[localeKey] != null;
  const multiplier = multiplierResolved ? SCRIPT_MULTIPLIERS[localeKey] : DEFAULT_MULTIPLIER;

  const charCount = text.length;
  const effectiveCharWidthPx = fontSizePx * charWidthEm * multiplier;
  const charsPerLine = Math.max(1, Math.floor(boxWidthPx / effectiveCharWidthPx));
  const linesNeeded = Math.max(1, Math.ceil(charCount / charsPerLine));
  const linesAvailable = Math.max(1, Math.floor(boxHeightPx / (fontSizePx * lineHeightMultiplier)));
  const fits = linesNeeded <= linesAvailable;
  const overflowRatio = fits ? 0 : Number(((linesNeeded / linesAvailable) - 1).toFixed(3));

  const recommendation = fits
    ? 'Fits within the box at the given font size.'
    : `Overflow: needs ${linesNeeded} line(s), box fits ${linesAvailable}. Shorten by ~${Math.round(overflowRatio * 100)}%, reduce font size, or resize the box before locking this translation.`;

  return {
    ok: true, fits, charCount, locale, multiplier, multiplierResolved,
    charsPerLine, linesNeeded, linesAvailable, overflowRatio, recommendation,
  };
}
