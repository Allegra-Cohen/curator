// Colour for the ontology table: one hue per top-level concept, tinted lighter
// the deeper a row sits in the hierarchy.
//
// ROOT_COLORS are the *darkest* step each hue is allowed to reach — they are the
// source of truth, and every tint below is derived from them at runtime, so
// editing a hex here re-derives the whole table. They are also the only hand-
// picked values: the ramp is computed, not eyeballed.
//
// Why tint the row rather than fill it with the root colour: all sixteen sit in
// the mid-lightness band where neither white nor dark text clears 4.5:1 (the
// greens want dark ink, the blues want white, and #bd51ab takes neither). So the row
// fill is a tint that always carries dark ink, and the saturated hue lives in the
// rail down the row's left edge, where it only has to be *seen*, not read on.
//
// Measured over all sixteen hues: worst ink-on-fill contrast 6.35 (need 4.5),
// worst rail-vs-its-own-fill ΔE 6.5, min adjacent depth step ΔE 4.0.

export const ROOT_COLORS = [
  '#049439', '#00945e', '#03ab89', '#02a89d', '#029bba',
  '#0276c9', '#3e67ed', '#7162bd', '#bd51ab',
  // Added 2026-09: loops magenta back round to the first green, interpolated in
  // OKLCH at the same lightness band so the tint ramps behave like the rest.
  '#cc4984', '#d34858', '#d0501e', '#b76700', '#a07502', '#897f01', '#668a05',
] as const

// Roots past the palette get neutral grey rather than a recycled hue: two roots
// sharing a colour would read as one group, which is worse than reading as none.
export const NEUTRAL_ROOT = '#64748b'

// Dark ink clears 4.5:1 on every step of every ramp, so row text never varies.
export const ROW_INK = '#0f172a'

// Lightness per depth. Index past the end clamps — a very deep branch stops
// getting lighter instead of fading into the page.
const FILL_L = [0.70, 0.79, 0.865, 0.925, 0.965]
const FILL_CHROMA = 0.72   // fills are tints; the rail keeps full chroma to stay distinct
const CHROMA_ANCHOR = 0.55 // roughly the lightness the given hues sit at

export const MAX_TINT_DEPTH = FILL_L.length - 1

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

interface Oklch { L: number; C: number; h: number }

function hexToOklch(hex: string): Oklch {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255)
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255)
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    C: Math.hypot(A, B),
    h: Math.atan2(B, A),
  }
}

function oklchToHex({ L, C, h }: Oklch): string {
  const A = C * Math.cos(h), B = C * Math.sin(h)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return '#' + [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255)
      .toString(16).padStart(2, '0')).join('')
}

const cache = new Map<string, string>()

/** The row background for `rootHex` at `depth`: same hue, lighter and less
 *  saturated the deeper it goes. */
export function fillFor(rootHex: string, depth: number): string {
  const key = `${rootHex}@${depth}`
  const hit = cache.get(key)
  if (hit) return hit

  const { C, h } = hexToOklch(rootHex)
  const L = FILL_L[Math.min(depth, MAX_TINT_DEPTH)]
  const t = (L - CHROMA_ANCHOR) / (1 - CHROMA_ANCHOR)
  const out = oklchToHex({ L, C: C * FILL_CHROMA * (1 - t) ** 0.6, h })
  cache.set(key, out)
  return out
}

/** The hue assigned to the nth root concept, in fixed order — never cycled. */
export function rootColor(index: number): string {
  return ROOT_COLORS[index] ?? NEUTRAL_ROOT
}

// --------------------------------------------------------------------------
// Heat, for the pivot tabs' cells.
//
// One fixed hue rather than the row's rail: a dark green and a dark purple don't
// read as equal magnitude, so per-row hues would make heat incomparable down a
// column — and the rail already carries the hierarchy over in the label column.
//
// Blue, and three of the sixteen ROOT_COLORS are also blues, so this hue does NOT get
// to be distinct by virtue of being unlike everything else. What separates a cell
// from a band is position (cells sit right of the sticky label column, bands sit
// inside it) plus the ΔE floor palette.test.ts enforces against every root tint.
// It's the app's existing accent (see .chip.selected, button.save), so heat reads
// as "this app's colour for a quantity" rather than as a tenth hierarchy hue.
//
// It reuses fillFor, so heat inherits the ramp's contrast guarantee for free:
// nothing goes darker than FILL_L[0], where ROW_INK still clears 4.5:1. That floor
// is not negotiable here — a cell contains a NUMBER, which has to be read.
// --------------------------------------------------------------------------

export const HEAT_HUE = '#2563eb'

/** Build a heat scale from the counts it will actually have to colour.
 *
 *  Bins by RANK, not by value. Any scale normalized against the maximum — linear
 *  or log — lets a single outlier set the range: with one popular pair at 80 and a
 *  long tail of 1–3, every cell in the tail renders the same shade, and the tail is
 *  where the findings are. (Log-to-max was measured doing exactly this; see
 *  palette.test.ts.) Ranking the DISTINCT counts spends the whole ramp on whatever
 *  spread the data actually has, at any corpus size, with nothing to hardcode.
 *
 *  What rank costs: two cells the same shade are adjacent in rank, not equal in
 *  count. That's affordable only because the cell prints its number — colour makes
 *  the pattern findable, the number says how many.
 *
 *  Returns null for a count of zero, and that is load-bearing: "no documents" must
 *  not look like "one document", because an empty cell between two fat marginals is
 *  the frontier — the finding the table exists for.
 */
export function heatScale(counts: number[]): (count: number) => string | null {
  const distinct = [...new Set(counts.filter((c) => c > 0))].sort((a, b) => a - b)
  const rank = new Map(distinct.map((v, i) => [v, i]));
  const steps = MAX_TINT_DEPTH + 1
  const last = Math.max(1, distinct.length - 1)

  return (count: number) => {
    if (count <= 0 || distinct.length === 0) return null
    const r = rank.get(count)
    // A count the scale never saw: treat it as the top rather than drop its fill,
    // so an unranked cell can't masquerade as an empty one.
    const bin = r === undefined || distinct.length === 1
      ? steps - 1
      : Math.round((r / last) * (steps - 1))
    return fillFor(HEAT_HUE, MAX_TINT_DEPTH - bin)   // FILL_L runs dark -> light
  }
}
