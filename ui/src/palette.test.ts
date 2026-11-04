// The palette makes a measured promise in its header comment — "worst ink-on-fill
// contrast 6.35 (need 4.5)" — over the sixteen root hues. Heat adds another hue and a
// second ramp, and cells carry a NUMBER that has to be read, so the promise has to
// hold there too. These tests are that promise, executable.

import { describe, expect, it } from 'vitest'
import {
  HEAT_HUE, MAX_TINT_DEPTH, ROOT_COLORS, ROW_INK, fillFor, heatScale, rootColor,
} from './palette'

// WCAG relative luminance + contrast ratio.
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

// OKLab ΔE ×100 — the units palette.ts's header comment measures in ("worst
// rail-vs-its-own-fill ΔE 6.5, min adjacent depth step ΔE 4.1").
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function deltaE(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100
}

describe('contrast: dark ink on every fill', () => {
  it('clears 4.5:1 on every depth step of every root hue', () => {
    for (const root of [...ROOT_COLORS, rootColor(99)]) {
      for (let d = 0; d <= MAX_TINT_DEPTH; d++) {
        const ratio = contrast(ROW_INK, fillFor(root, d))
        expect(ratio, `${root} @ depth ${d} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('clears 4.5:1 on every heat step', () => {
    // The reason heat can't go darker than FILL_L[0]: the number in the cell has
    // to be legible on it.
    const counts = Array.from({ length: 40 }, (_, i) => i + 1)
    const heat = heatScale(counts)
    for (const n of counts) {
      const fill = heat(n)!
      const ratio = contrast(ROW_INK, fill)
      expect(ratio, `heat ${n} -> ${fill} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the hottest cell above the ramp floor', () => {
    expect(heatScale([1, 50, 100])(100)).toBe(fillFor(HEAT_HUE, 0))
  })
})

describe('heatScale', () => {
  it('draws nothing at zero', () => {
    // Load-bearing: an empty cell between two fat marginals is the frontier. If
    // zero got the palest tint it would read as "one document", and the finding
    // the table exists for would be invisible.
    const heat = heatScale([1, 2, 5])
    expect(heat(0)).toBeNull()
    expect(heat(-1)).toBeNull()
  })

  it('draws nothing when there is nothing to scale', () => {
    expect(heatScale([])(3)).toBeNull()
    expect(heatScale([0, 0])(0)).toBeNull()
  })

  it('treats a lone level as its own maximum', () => {
    expect(heatScale([1, 1, 1])(1)).toBe(fillFor(HEAT_HUE, 0))
  })

  it('is monotonic: more documents never render paler', () => {
    const counts = Array.from({ length: 30 }, (_, i) => i + 1)
    const heat = heatScale(counts)
    let prev = Infinity
    for (const n of counts) {
      const l = luminance(heat(n)!)
      expect(l, `count ${n}`).toBeLessThanOrEqual(prev + 1e-9)
      prev = l
    }
  })

  it('uses the full ramp: the smallest count is palest, the largest darkest', () => {
    const heat = heatScale([1, 4, 9, 20])
    expect(heat(1)).toBe(fillFor(HEAT_HUE, MAX_TINT_DEPTH))
    expect(heat(20)).toBe(fillFor(HEAT_HUE, 0))
  })

  it('survives a skewed corpus: one outlier cannot collapse the tail', () => {
    // The bug that killed log-to-max. With a popular pair at 80 against a tail of
    // 1-3, ANY max-normalized scale renders the whole tail identically -- and the
    // tail is where the findings are. Rank binning is immune: 80 is just the
    // highest of four distinct values.
    const heat = heatScale([1, 1, 1, 2, 2, 3, 80])
    const tail = [1, 2, 3].map(heat)
    expect(new Set(tail).size, `1/2/3 against an 80 -> ${tail}`).toBe(3)
    expect(heat(1)).toBe(fillFor(HEAT_HUE, MAX_TINT_DEPTH))
    expect(heat(80)).toBe(fillFor(HEAT_HUE, 0))
  })

  it('spends the ramp on the spread the data has, not the range', () => {
    // 1,2,3 and 1,50,900 have the same three ranks, so they get the same shades.
    // Colour shows the pattern; the printed number carries the magnitude.
    expect([1, 2, 3].map(heatScale([1, 2, 3])))
      .toEqual([1, 50, 900].map(heatScale([1, 50, 900])))
  })

  it('colours an unranked count rather than dropping its fill', () => {
    // An unfilled cell means "empty". A count the scale never saw must not be
    // able to impersonate one.
    expect(heatScale([1, 2])(7)).not.toBeNull()
  })

  // No test that heat is a distinct hue from the sixteen roots. Heat is blue and three
  // roots are blues, so at the pale end they coincide (heat@4 vs #3e67ed@4 measures
  // ΔE 0.26) — but that's true of any two hues at depth 4, where everything has
  // converged to off-white. Colour was never what separates a cell from a band:
  // POSITION is. Cells sit right of the sticky label column, bands sit inside it,
  // and you always know which one you're looking at.
})
