// Every edit organization mode can make to its piles. Pure, so this is the half of
// stage 4 that doesn't need a browser — `SegmentCanvas.tsx` is left with the pointers
// and the pixels, and the rules are pinned here.
//
// What's pinned, in the order it matters:
//
//   1. THE EMPTY RULE, which is the one that looks like it needs a flag and doesn't:
//      a circle emptied by an edit disappears, a circle that has never held anything
//      stays. Both, from the same comparison.
//   2. colours are handed out in RAMP ORDER — next unused slot, restarting past the
//      last hue — because a colour out of ramp order reads as meaning something;
//   3. a document is in at most one pile, so filing it again MOVES it;
//   4. positions are what rank a pile, so moving a circle is an edit like any other;
//   5. what goes to the server: never-filled circles don't, because `save` would
//      strip them and the reply is not adopted.

import { describe, it, expect } from 'vitest'
import {
  assignDocs, countBySegment, createSegment, forSave, moveSegment, nextColor,
  patchSegment, unassignDocs,
} from './segmentEdit'
import { ROOT_COLORS } from './palette'
import type { SegmentState } from './types'

const EMPTY: SegmentState = { segments: [], members: {} }

/** A canvas with `n` circles at descending heights, the first holding `d1`. Built by
 *  the real transitions rather than by hand, so a fixture can't hold a state the
 *  module would never produce. */
const canvas = (): SegmentState => {
  let s = createSegment(EMPTY, { x: 100, y: 100 }, 'seg-a')
  s = createSegment(s, { x: 400, y: 300 }, 'seg-b')
  return assignDocs(s, ['d1', 'd2'], 'seg-a')
}

const ids = (s: SegmentState) => s.segments.map((x) => x.id)

describe('creating a circle', () => {
  it('lands where it was dropped, unnamed', () => {
    const s = createSegment(EMPTY, { x: 240, y: 90 }, 'seg-a')
    expect(s.segments).toEqual([
      { id: 'seg-a', name: '', note: '', color: 0, x: 240, y: 90 },
    ])
    // A circle is dropped first and named after, if at all — position and colour
    // already identify it.
    expect(s.members).toEqual({})
  })

  it('takes the next unused colour in ramp order, not a free one', () => {
    let s = createSegment(EMPTY, { x: 0, y: 0 }, 'a')
    s = createSegment(s, { x: 0, y: 0 }, 'b')
    s = createSegment(s, { x: 0, y: 0 }, 'c')
    expect(s.segments.map((x) => x.color)).toEqual([0, 1, 2])
  })

  it('fills a slot the curator freed by overriding a colour', () => {
    let s = createSegment(EMPTY, { x: 0, y: 0 }, 'a')
    s = createSegment(s, { x: 0, y: 0 }, 'b')
    // The curator recoloured the second pile to the far end of the ramp; slot 1 is
    // free again, and the next circle takes it rather than counting on to 2.
    s = patchSegment(s, 'b', { color: 8 })
    s = createSegment(s, { x: 0, y: 0 }, 'c')
    expect(s.segments.map((x) => x.color)).toEqual([0, 8, 1])
  })

  it('restarts the ramp past the last circle instead of running out', () => {
    // COUNTED OFF `ROOT_COLORS`, never off a literal. The ramp was nine hues until
    // 2026-09 and is sixteen now; the rule being pinned is "restarts when it runs out",
    // which is true at any length, so spelling the length here would mean this test
    // fails the next time the palette grows without the behaviour having changed.
    const n = ROOT_COLORS.length
    let s = EMPTY
    for (let i = 0; i < n + 2; i++) s = createSegment(s, { x: 0, y: 0 }, `s${i}`)
    const colors = s.segments.map((x) => x.color)
    expect(colors.slice(0, n)).toEqual([...Array(n).keys()])
    // The last two reuse the first two hues. Allowed here and forbidden in the
    // ontology table: there a hue is the only carrier; here a circle also has a name
    // and a place on the canvas.
    expect(colors.slice(n)).toEqual([0, 1])
    expect(nextColor(s.segments)).toBe((n + 2) % n)
  })
})

describe('the empty rule', () => {
  it('keeps a circle that has never held anything', () => {
    // The whole reason this rule is stated as a property of the EDIT and not of the
    // segment: a just-dropped circle is empty, and has to survive to catch something.
    const s = createSegment(EMPTY, { x: 10, y: 10 }, 'fresh')
    expect(ids(unassignDocs(s, ['d9']))).toEqual(['fresh'])
    expect(ids(assignDocs(s, [], 'fresh'))).toEqual(['fresh'])
  })

  it('deletes a circle whose last member is dragged out', () => {
    const s = assignDocs(createSegment(EMPTY, { x: 10, y: 10 }, 'a'), ['d1'], 'a')
    expect(ids(unassignDocs(s, ['d1']))).toEqual([])
  })

  it('deletes a circle whose last member is dragged onto another', () => {
    let s = canvas()
    s = unassignDocs(s, ['d2'])
    expect(ids(s)).toEqual(['seg-a', 'seg-b'])   // seg-a still has d1
    s = assignDocs(s, ['d1'], 'seg-b')
    // seg-a was emptied by this edit and is gone; seg-b caught its first document
    // and is no longer a bare circle.
    expect(ids(s)).toEqual(['seg-b'])
    expect(s.members).toEqual({ d1: 'seg-b' })
  })

  it('leaves a circle alone when the edit did not empty it', () => {
    const s = unassignDocs(canvas(), ['d1'])
    expect(ids(s)).toEqual(['seg-a', 'seg-b'])
    expect(s.members).toEqual({ d2: 'seg-a' })
  })
})

describe('filing documents', () => {
  it('moves a document rather than filing it twice', () => {
    // `members` is keyed by document, so there is nowhere to write a second
    // membership — this pins that the model, not the caller, is what enforces it.
    const s = assignDocs(canvas(), ['d1'], 'seg-b')
    expect(s.members).toEqual({ d1: 'seg-b', d2: 'seg-a' })
    expect(countBySegment(s)).toEqual(new Map([['seg-a', 1], ['seg-b', 1]]))
  })

  it('catches a marked set whole', () => {
    const s = assignDocs(canvas(), ['d3', 'd4', 'd5'], 'seg-b')
    expect(countBySegment(s).get('seg-b')).toBe(3)
  })

  it('does nothing when the target circle is not on the canvas', () => {
    // The reading `orderQueue` gives a membership whose segment has gone: not an
    // error, just not a place to put anything.
    const s = canvas()
    expect(assignDocs(s, ['d3'], 'seg-gone')).toBe(s)
  })

  it('counts a never-filled circle as zero rather than leaving it out', () => {
    const counts = countBySegment(createSegment(EMPTY, { x: 0, y: 0 }, 'fresh'))
    expect(counts.get('fresh')).toBe(0)
  })

  it('mutates nothing it was given', () => {
    const before = canvas()
    const snapshot = JSON.parse(JSON.stringify(before))
    assignDocs(before, ['d1'], 'seg-b')
    unassignDocs(before, ['d1'])
    moveSegment(before, 'seg-a', 9, 9)
    patchSegment(before, 'seg-a', { name: 'x' })
    expect(before).toEqual(snapshot)
  })
})

describe('editing a circle', () => {
  it('moves it, which is how a pile is ranked', () => {
    // Position is the only ordering control: `queueSegments.segmentOrder` reads the
    // queue's block order off exactly these numbers.
    const s = moveSegment(canvas(), 'seg-a', 600, 20)
    expect(s.segments.find((x) => x.id === 'seg-a')).toMatchObject({ x: 600, y: 20 })
    expect(s.segments.find((x) => x.id === 'seg-b')).toMatchObject({ x: 400, y: 300 })
  })

  it('takes a name, a note and a colour through one form', () => {
    let s = patchSegment(canvas(), 'seg-a', { name: 'Neurorights & law' })
    s = patchSegment(s, 'seg-a', { note: 'Read after the policy pile.', color: 5 })
    expect(s.segments[0]).toMatchObject({
      name: 'Neurorights & law', note: 'Read after the policy pile.', color: 5,
    })
  })

  it('ignores an id that is not on the canvas', () => {
    const s = canvas()
    expect(patchSegment(s, 'seg-gone', { name: 'x' }).segments).toEqual(s.segments)
    expect(moveSegment(s, 'seg-gone', 1, 1).segments).toEqual(s.segments)
  })
})

describe('what goes to the server', () => {
  it('leaves out the circles that have never held anything', () => {
    // `save` would drop them anyway. Not sending them is what keeps the client and
    // the file from disagreeing about segments that don't exist — the reply is
    // deliberately not adopted, because adopting it would delete the circle the
    // curator just dropped.
    const body = forSave(canvas())
    expect(body.segments.map((s) => s.id)).toEqual(['seg-a'])
    expect(body.members).toEqual({ d1: 'seg-a', d2: 'seg-a' })
  })

  it('sends an empty canvas as empty rather than as nothing', () => {
    expect(forSave(createSegment(EMPTY, { x: 0, y: 0 }, 'fresh')))
      .toEqual({ segments: [], members: {} })
  })
})
