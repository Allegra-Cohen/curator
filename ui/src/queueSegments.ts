// WHAT ORDER THE REVIEW QUEUE IS IN once the curator has organized it — the one
// piece of organization mode that can be checked without a browser, kept out of the
// canvas for the reason `canvasOrder.ts` gives about the reader's.
//
// The mode itself is a canvas of circles (see
// `writeups/design/QUEUE_ORGANIZATION_DESIGN.md`); this module is the pass that turns
// a canvas into a list. Three rules, and they compose in this order:
//
//   BLOCKS    a segment's documents sit together, in segment order;
//   WITHIN    a block keeps the order the server sent (venue tier, then arrival) —
//             the working order is preserved INSIDE each pile, because the pile says
//             what to read next and the tier still says where to start within it;
//   TRAILING  unsegmented documents last, also in server order. They are what is
//             left to think about, and they don't get a colour.
//
// SEGMENT ORDER COMES FROM THE CIRCLE'S POSITION, top-to-bottom then left-to-right on
// its centre, and from nothing else. That is `canvasOrder`'s principle applied to the
// queue: position carries information, so where the curator put a pile IS how it
// ranks, and a second ranking control would only be something for the canvas to
// disagree with.
//
// The comparison is strict (y, then x) — no row banding (curator's call, 2026-08-25).
// One consequence to know rather than to fix: two circles side by side rank adjacently
// only while no third circle's centre sits between them in y. Drop a pile halfway down
// the gap between two others and it lands between them in the queue, which is what
// dropping it there meant.
//
// EVERY DOCUMENT COMES OUT EXACTLY ONCE. This is a permutation of `docs` and never a
// filter: the queue's badge counts pending documents (`DocumentList.tsx` — the header
// and list counts were deliberately made to agree), and a pass that could drop one
// would make them disagree for a reason no one could see. So a membership naming a
// segment that isn't on the canvas reads as unsegmented rather than as an error, and a
// membership naming a document that has left the queue contributes no row at all.

import type { GraphNode, Segment, SegmentState } from './types'
import { ROOT_COLORS } from './palette'

/** One queue row: the document, and which pile it is in — `null` for both when it is
 *  in none. `color` is resolved here rather than in the list, so exactly one place
 *  maps a stored colour slot onto a hue. */
export interface Row {
  doc: GraphNode
  segmentId: string | null
  color: string | null
}

/** The hue for a stored colour slot. `% ROOT_COLORS.length` is the ramp RESTART the
 *  design settles on: past the last hue one is reused, which the ontology
 *  table forbids and this canvas allows — there a hue is the only carrier, here a
 *  circle also has a name and a position. The server already validates the slot, so
 *  the modulo is a belt: a blob edited by hand can't paint a row `undefined`. */
export function segmentColor(color: number): string {
  const n = ROOT_COLORS.length
  return ROOT_COLORS[((Math.trunc(color) % n) + n) % n]
}

/** Segments in canvas reading order: top-to-bottom, then left-to-right on centre.
 *  Id last, so two circles dropped at the very same point still order the same way on
 *  every reload rather than on whatever order the blob happened to list them in. */
export function segmentOrder(segments: Segment[]): Segment[] {
  return segments.slice().sort((a, b) =>
    a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
}

/** Which pile each document is in, as a hue — the tint and rail on a queue row.
 *
 *  Separate from `orderQueue` because the two halves run off DIFFERENT states while
 *  the mode is open: the list must not re-sort under the curator on every drop, so
 *  its ORDER comes from the canvas as it stood at entry, while its COLOUR comes from
 *  the canvas as it stands right now. A document dropped on a circle therefore takes
 *  that circle's hue immediately and does not move — the tint says "filed", the order
 *  is the last committed answer. Outside the mode both states are the same one and
 *  the split costs nothing.
 *
 *  A membership naming a segment that isn't on the canvas gets no colour, which is
 *  the same reading `orderQueue` gives it: unsegmented, not an error. */
export function colorsByDocument(state: SegmentState | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!state) return out
  const hue = new Map<string, string>()
  for (const s of state.segments) hue.set(s.id, segmentColor(s.color))
  for (const [docId, segmentId] of Object.entries(state.members)) {
    const h = hue.get(segmentId)
    if (h) out.set(docId, h)
  }
  return out
}

/** The queue as organization mode leaves it. `docs` arrives in the server's order and
 *  that order survives inside every block — the sort key is (block, arrival), with the
 *  arrival index explicit rather than leaning on the sort being stable. */
export function orderQueue(docs: GraphNode[], state: SegmentState | null): Row[] {
  const segments = state ? segmentOrder(state.segments) : []
  const rank = new Map<string, number>()
  segments.forEach((s, i) => rank.set(s.id, i))
  const hue = new Map<string, string>()
  for (const s of segments) hue.set(s.id, segmentColor(s.color))

  // Unsegmented sorts after every real block, so this is one past the last of them.
  const trailing = segments.length

  const rows = docs.map((doc, arrival) => {
    const segmentId = state?.members[doc.id] ?? null
    // A membership naming a segment the canvas no longer has reads as unsegmented.
    const block = segmentId !== null ? rank.get(segmentId) : undefined
    return {
      row: block === undefined
        ? { doc, segmentId: null, color: null }
        : { doc, segmentId, color: hue.get(segmentId as string) as string },
      block: block ?? trailing,
      arrival,
    }
  })

  return rows
    .sort((a, b) => a.block - b.block || a.arrival - b.arrival)
    .map((r) => r.row)
}
