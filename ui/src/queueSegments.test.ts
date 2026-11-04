// The queue's ordering pass under organization mode. Like `canvasOrder.test.ts`, this
// is the half of the feature a browser isn't needed for: a permutation of the queue
// plus a colour per row, both pure functions of the canvas.
//
// What's pinned here is what the pass is FOR:
//
//   1. the queue comes out in SEGMENT order, and segment order is read off the
//      circles' positions — top-to-bottom, then left-to-right, with nothing else
//      allowed to influence it (not the blob's listing order, not the name);
//   2. inside a block the SERVER's order survives — venue tier then arrival, which is
//      the order the curator works a pile in;
//   3. unsegmented documents come last, in server order, with no colour;
//   4. it is a permutation: every document in, every document out, exactly once, so
//      the header and list counts keep agreeing;
//   5. the degenerate blobs — no state, nothing segmented, a member naming a segment
//      that isn't on the canvas, a member naming a document that has left the queue.

import { describe, it, expect } from 'vitest'
import { orderQueue, segmentColor, segmentOrder, type Row } from './queueSegments'
import { ROOT_COLORS } from './palette'
import type { GraphNode, Segment, SegmentState } from './types'

const doc = (id: string): GraphNode => ({
  id, type: 'document', label: id, attributes: {},
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

// The server's order. Read it as tier-then-arrival: whatever it is, this pass must
// not reshuffle it except by block.
const DOCS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(doc)

const seg = (id: string, x: number, y: number, color = 0): Segment =>
  ({ id, name: id, note: '', color, x, y })

// Three circles, deliberately listed in an order that is NOT their reading order:
//   safety  top-left      (100, 100)
//   evals   top-right     (400, 100)   — same row, so only x separates it
//   policy  below both    (250, 400)
// A pass that ordered on the array would give safety, evals, policy by luck; one that
// ordered on `name` would give evals, policy, safety. Only position gives the right
// answer here, and the listing below is scrambled so that luck can't.
const SAFETY = seg('s-safety', 100, 100, 0)
const EVALS = seg('s-evals', 400, 100, 3)
const POLICY = seg('s-policy', 250, 400, 8)

const STATE: SegmentState = {
  segments: [POLICY, EVALS, SAFETY],
  members: {
    d5: SAFETY.id,
    d2: EVALS.id,
    d1: SAFETY.id,
    d6: POLICY.id,
    // d3 and d4 are unsegmented on purpose.
  },
  updated_at: '2026-08-25T12:00:00Z',
}

const ids = (rows: Row[]) => rows.map((r) => r.doc.id)

describe('segmentOrder', () => {
  it('reads top-to-bottom, then left-to-right', () => {
    expect(segmentOrder([POLICY, EVALS, SAFETY]).map((s) => s.id))
      .toEqual([SAFETY.id, EVALS.id, POLICY.id])
  })

  it('puts a higher circle first even when it is further right', () => {
    const high = seg('high', 900, 10)
    const low = seg('low', 0, 20)
    expect(segmentOrder([low, high]).map((s) => s.id)).toEqual(['high', 'low'])
  })

  it('breaks an exact tie on id, so a reload never re-orders two stacked circles', () => {
    const a = seg('aaa', 50, 50)
    const b = seg('bbb', 50, 50)
    expect(segmentOrder([b, a]).map((s) => s.id)).toEqual(['aaa', 'bbb'])
    expect(segmentOrder([a, b]).map((s) => s.id)).toEqual(['aaa', 'bbb'])
  })

  it('does not mutate what it was given', () => {
    const given = [POLICY, EVALS, SAFETY]
    segmentOrder(given)
    expect(given.map((s) => s.id)).toEqual([POLICY.id, EVALS.id, SAFETY.id])
  })
})

describe('segmentColor', () => {
  it('indexes the ontology ramp', () => {
    expect(segmentColor(0)).toBe(ROOT_COLORS[0])
    expect(segmentColor(8)).toBe(ROOT_COLORS[8])
  })

  it('RESTARTS the ramp past the last segment rather than running out', () => {
    // Off `ROOT_COLORS.length`, not off a literal nine — see the note on the matching
    // test in segmentEdit.test.ts. The restart is the rule; the ramp's length is not.
    const n = ROOT_COLORS.length
    expect(segmentColor(n)).toBe(ROOT_COLORS[0])
    expect(segmentColor(n + 2)).toBe(ROOT_COLORS[2])
  })

  it('never yields undefined for a slot no picker could have produced', () => {
    for (const slot of [-1, -9, 100, 3.7]) expect(segmentColor(slot)).toBeTruthy()
  })
})

describe('orderQueue', () => {
  it('blocks the queue by segment, in canvas reading order', () => {
    // safety (d1, d5), then evals (d2), then policy (d6), then the unsegmented.
    expect(ids(orderQueue(DOCS, STATE))).toEqual(['d1', 'd5', 'd2', 'd6', 'd3', 'd4'])
  })

  it('keeps the server order inside a block', () => {
    // d5 was listed BEFORE d1 in `members`; the queue's own order decides, not the blob's.
    const rows = orderQueue(DOCS, STATE).filter((r) => r.segmentId === SAFETY.id)
    expect(ids(rows)).toEqual(['d1', 'd5'])
  })

  it('puts unsegmented documents last, in server order, with no colour', () => {
    const rows = orderQueue(DOCS, STATE).slice(-2)
    expect(ids(rows)).toEqual(['d3', 'd4'])
    expect(rows.map((r) => r.segmentId)).toEqual([null, null])
    expect(rows.map((r) => r.color)).toEqual([null, null])
  })

  it('colours each row with its segment hue', () => {
    const rows = orderQueue(DOCS, STATE)
    const colorOf = (id: string) => rows.find((r) => r.doc.id === id)!.color
    expect(colorOf('d1')).toBe(ROOT_COLORS[0])
    expect(colorOf('d2')).toBe(ROOT_COLORS[3])
    expect(colorOf('d6')).toBe(ROOT_COLORS[8])
  })

  it('is a permutation — every document out exactly once', () => {
    const out = ids(orderQueue(DOCS, STATE))
    expect(out.slice().sort()).toEqual(DOCS.map((d) => d.id).slice().sort())
  })

  it('leaves the queue alone when there is no state at all', () => {
    for (const state of [null, { segments: [], members: {} }]) {
      const rows = orderQueue(DOCS, state)
      expect(ids(rows)).toEqual(DOCS.map((d) => d.id))
      expect(rows.every((r) => r.segmentId === null && r.color === null)).toBe(true)
    }
  })

  it('leaves the queue alone when the canvas has circles but nothing is in them', () => {
    // Not a state the file can hold — `drop_empty_segments` runs on save — but it is
    // exactly the state the client is in while a brand-new circle is still empty.
    const rows = orderQueue(DOCS, { segments: [SAFETY, EVALS], members: {} })
    expect(ids(rows)).toEqual(DOCS.map((d) => d.id))
  })

  it('reads a membership naming a segment that is not on the canvas as unsegmented', () => {
    const stale: SegmentState = {
      segments: [SAFETY],
      members: { d2: 'a-circle-that-was-dragged-away', d5: SAFETY.id },
    }
    const rows = orderQueue(DOCS, stale)
    expect(ids(rows)).toEqual(['d5', 'd1', 'd2', 'd3', 'd4', 'd6'])
    expect(rows.find((r) => r.doc.id === 'd2')!.segmentId).toBeNull()
    expect(rows.find((r) => r.doc.id === 'd2')!.color).toBeNull()
  })

  it('grows no row for a member that has left the queue', () => {
    // The server prunes these on read; the client can still be holding one when a
    // document is reviewed mid-sitting.
    const rows = orderQueue(DOCS, {
      segments: [SAFETY],
      members: { d1: SAFETY.id, 'd-reviewed-an-hour-ago': SAFETY.id },
    })
    expect(rows).toHaveLength(DOCS.length)
    expect(ids(rows)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6'])
  })

  it('handles an empty queue', () => {
    expect(orderQueue([], STATE)).toEqual([])
  })

  it('does not mutate the queue it was given', () => {
    const given = DOCS.slice()
    orderQueue(given, STATE)
    expect(given.map((d) => d.id)).toEqual(DOCS.map((d) => d.id))
  })
})
