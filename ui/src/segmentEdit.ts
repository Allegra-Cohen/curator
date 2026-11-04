// WHAT THE CANVAS DOES TO A CANVAS. Every edit organization mode can make to its
// piles, as a pure function from one `SegmentState` to the next — so the rules can
// be checked without a browser, and `SegmentCanvas.tsx` is left holding only the
// pointers and the pixels.
//
// The ordering half of this feature lives in `queueSegments.ts`; this is the editing
// half. Neither of them touches the graph, which is the whole point of the mode
// (writeups/design/QUEUE_ORGANIZATION_DESIGN.md).
//
// TWO RULES CARRY THE WEIGHT, and they are the reason this is a module rather than a
// handful of setState calls:
//
// AN EMPTIED CIRCLE DISAPPEARS, A NEVER-FILLED ONE STAYS. Drag the last document out
// of a pile and the pile is gone — there is nothing to clean up later and no empty
// ring left behind to wonder about. But a circle the curator has just dropped on the
// canvas is also empty, and it has to survive long enough to catch something.
//
// Those two look like they need a flag in the data ("has this ever held anything?"),
// and the design refuses to put one there. They don't: the difference is not a
// property of the segment, it is a property of the EDIT. A circle disappears when a
// change EMPTIES it — when it had members before the change and has none after.
// A never-filled circle is never emptied by anything, because it was already empty.
// So the rule is one comparison, made here, and the word "fresh" never has to exist.
//
// It also lines up with the file on disk without a special case: the server drops
// empty segments on save, so every segment that ever comes back from a GET has at
// least one member — which makes "had members before" true for all of them, and
// dragging out the last one deletes them.
//
// A DOCUMENT IS IN AT MOST ONE PILE. `members` is keyed by document, so assigning
// a document that is already filed moves it; there is nowhere to write a second
// membership even by accident.

import type { Segment, SegmentState } from './types'
import { ROOT_COLORS } from './palette'

/** A fresh segment id. A real UUID because the server's model says `UUID` — the
 *  canvas is the only thing that ever mints one. */
export function newSegmentId(): string {
  return crypto.randomUUID()
}

/** The colour slot a new circle takes: the first one nobody is using, in RAMP ORDER.
 *
 *  First segment slot 0, second slot 1, and so on. Not "a colour that stands out",
 *  and not random: colours out of ramp order read as meaning something (curator,
 *  2026-08-25, on seeing a fixture that had picked 0, 3, 8). The picker in the roster
 *  is for overriding this, not for supplying it.
 *
 *  Past the last hue the ramp RESTARTS rather than running out — `% length`, counted
 *  off how many circles there are, so the next one takes the first hue and the one
 *  after it the second. The ontology table forbids reusing a hue; this canvas allows it, because
 *  there a hue is the only carrier and here a circle also has a name and a position. */
export function nextColor(segments: Segment[]): number {
  const used = new Set(segments.map((s) => s.color))
  for (let i = 0; i < ROOT_COLORS.length; i++) if (!used.has(i)) return i
  return segments.length % ROOT_COLORS.length
}

/** Drop the piles this edit emptied — and only those.
 *
 *  `before` is what the state looked like going in. A segment goes if it had members
 *  then and has none now; a segment that was already empty is left alone, which is
 *  what lets a just-dropped circle wait around for its first document. See the header. */
function settle(before: SegmentState, segments: Segment[],
                members: Record<string, string>): SegmentState {
  const had = new Set(Object.values(before.members))
  const has = new Set(Object.values(members))
  return {
    segments: segments.filter((s) => has.has(s.id) || !had.has(s.id)),
    members,
    updated_at: before.updated_at,
  }
}

/** A new circle, centred where it was dropped. Unnamed and unnoted: a circle is
 *  dropped first and named after, if at all — the colour and the position already
 *  identify it. The id is passed in rather than minted here so the transitions stay
 *  pure and a test can name what it made. */
export function createSegment(
  state: SegmentState, at: { x: number; y: number }, id: string,
): SegmentState {
  return {
    ...state,
    segments: [...state.segments,
               { id, name: '', note: '', color: nextColor(state.segments), ...at }],
  }
}

/** File `docIds` into `segmentId`, taking each out of whatever pile it was in.
 *
 *  A segment that isn't on the canvas is not a place to put anything, so an id that
 *  names none is a no-op rather than an error — the same reading `orderQueue` gives a
 *  membership whose segment has gone. Documents already in the target stay put, and
 *  the target can't be emptied by an edit that only adds to it. */
export function assignDocs(
  state: SegmentState, docIds: string[], segmentId: string,
): SegmentState {
  if (!state.segments.some((s) => s.id === segmentId)) return state
  const members = { ...state.members }
  for (const id of docIds) members[id] = segmentId
  return settle(state, state.segments, members)
}

/** Take `docIds` out of whatever pile they are in, back to unsegmented — the drag out
 *  of a roster onto bare canvas. Ids that were in no pile change nothing. */
export function unassignDocs(state: SegmentState, docIds: string[]): SegmentState {
  const members = { ...state.members }
  for (const id of docIds) delete members[id]
  return settle(state, state.segments, members)
}

/** Move a circle. Load-bearing rather than decorative: the queue's segment order is
 *  read off these positions (`queueSegments.segmentOrder`), so this is how a pile is
 *  ranked, and there is no separate order field for the canvas to disagree with. */
export function moveSegment(
  state: SegmentState, id: string, x: number, y: number,
): SegmentState {
  return {
    ...state,
    segments: state.segments.map((s) => (s.id === id ? { ...s, x, y } : s)),
  }
}

/** Edit a pile's name, note or colour — the three things its roster offers. One
 *  function rather than three, because they are one form and arrive the same way. */
export function patchSegment(
  state: SegmentState, id: string,
  patch: Partial<Pick<Segment, 'name' | 'note' | 'color'>>,
): SegmentState {
  return {
    ...state,
    segments: state.segments.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  }
}

/** How many documents are in each pile — the circle's radius, and the number it
 *  prints. Segments with nothing in them are present with a 0, deliberately: a
 *  just-dropped circle has to be drawable before it has caught anything. */
export function countBySegment(state: SegmentState): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of state.segments) counts.set(s.id, 0)
  for (const segmentId of Object.values(state.members)) {
    const n = counts.get(segmentId)
    if (n !== undefined) counts.set(segmentId, n + 1)
  }
  return counts
}

/** What gets sent to the server: the canvas without the circles that have never held
 *  anything. `save` would strip them anyway — sending them and then not adopting the
 *  reply would leave the client and the file disagreeing about segments that don't
 *  exist. Not adopting the reply is the point: it is correct, and it would delete the
 *  circle the curator just dropped. */
export function forSave(state: SegmentState): SegmentState {
  const live = new Set(Object.values(state.members))
  return {
    segments: state.segments.filter((s) => live.has(s.id)),
    members: state.members,
  }
}
