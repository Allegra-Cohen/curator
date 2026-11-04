import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { api } from '../api'
import DocumentViewer from './DocumentViewer'
import { DOCS_DND } from './DocumentList'
import { ROOT_COLORS, fillFor } from '../palette'
import { segmentColor } from '../queueSegments'
import {
  assignDocs, countBySegment, createSegment, forSave, moveSegment, newSegmentId,
  patchSegment, unassignDocs,
} from '../segmentEdit'
import type { DocumentNode, GraphNode, SegmentState } from '../types'

// ORGANIZATION MODE'S CANVAS: piles of queue documents, made by hand, over the
// workspace. Nothing in here writes the graph — not a node, not an edge, not a
// revision. See writeups/design/QUEUE_ORGANIZATION_DESIGN.md; the state transitions
// are `segmentEdit.ts` and the ordering they imply is `queueSegments.ts`.
//
// Hand-rolled rather than React Flow. A circle is not a React Flow node — it has no
// ports, no edges and no handles — and pan/zoom is the only thing that library would
// have been giving us, which is the twenty lines below.
//
// A CIRCLE IS A PILE, NOT A CONTAINER OF CARDS. It shows its name, its count and its
// note; its radius grows as the square root of its count. Drawing three hundred title
// chips inside circles is noise exactly when the feature is most needed, so the
// members live in the ROSTER, a popover you open by clicking the circle.
//
// FOUR GESTURES, and three of them are HTML5 drag-and-drop because the queue rows on
// the left already are:
//
//   drag the + onto the canvas   -> a new circle, where it lands  (SEGMENT_NEW_DND)
//   drag queue rows onto a circle -> caught, the marked set whole (DOCS_DND)
//   drag a roster row out         -> onto another circle, or onto bare canvas to
//                                    unfile it                    (DOCS_DND)
//   drag the circle itself        -> plain mousedown, NOT HTML5 DnD: an HTML5 drag of
//                                    an absolutely-positioned element gives no live
//                                    position and a drag image we would have to fight.
//
// Catching is tested AT DROP ONLY. Moving a circle across the canvas never swallows
// anything and never releases anything — membership changes only by a drag the
// curator aimed.

/** The drag payload for a not-yet-existing circle. Its own type rather than a flag on
 *  `DOCS_DND`, so the canvas's one drop handler can branch on `dataTransfer.types` —
 *  which is all a `dragover` is allowed to see. */
export const SEGMENT_NEW_DND = 'application/x-fg-new-segment'

// Radius from count: √, with a floor so a one-document pile is still a target, and a
// ceiling so a two-hundred-document pile doesn't eat the canvas. 1 -> 41, 16 -> 74,
// 42 and up -> 96.
const R_MIN = 30
const R_STEP = 11
const R_MAX = 96

export function radiusFor(count: number): number {
  return Math.min(R_MAX, R_MIN + R_STEP * Math.sqrt(Math.max(0, count)))
}

// How long a drag has to stand still before it is written. Long enough that dragging
// a circle across the canvas is one save and not sixty; short enough that letting go
// and reaching for the mouse again is not a race.
export const SAVE_DEBOUNCE = 700

const ZOOM_MIN = 0.35
const ZOOM_MAX = 2.5

// Below this, a mouseup is a click and not a move. Without it every click on a circle
// would nudge it by a pixel or two and quietly re-rank its pile.
const MOVE_SLOP = 4

interface View { x: number; y: number; k: number }

interface Props {
  /** The live canvas. Held by App, because the queue's tint reads off it too. */
  state: SegmentState
  onChange: (next: SegmentState) => void
  /** The queue in the order the list is showing it — the roster lists a pile's members
   *  in that same order, so reading down a roster and reading down the list are the
   *  same walk. */
  docs: GraphNode[]
  /** A save that failed has to be seen: the curator's whole afternoon is in this
   *  canvas and the queue looks exactly the same whether it was written or not. */
  onError: (e: unknown) => void
  selectedId: string | null
  onSelect: (id: string) => void
  /** The open document, for the floating viewer. Fetched by App exactly as it is for
   *  the docked one — the overlay renders its own viewer rather than trying to punch
   *  a hole through to the one underneath. */
  doc: DocumentNode | null
  onCloseDoc: () => void
  onExit: () => void
}

export default function SegmentCanvas({
  state, onChange, docs, onError, selectedId, onSelect, doc, onCloseDoc, onExit,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  // Which pile's roster is open. One at a time: two rosters over a canvas is two
  // lists of documents with nothing saying which circle either belongs to.
  const [roster, setRoster] = useState<string | null>(null)
  // The circle under a drag right now, for the catch highlight. Members aren't drawn,
  // so without this a drop has no feedback until the count ticks over.
  const [over, setOver] = useState<string | null>(null)

  const counts = countBySegment(state)

  // --- saving ---------------------------------------------------------------
  //
  // A debounced whole-blob PUT. Debounced because a circle dragged across the canvas
  // is one intention and sixty renders, and the endpoint replaces the file each time.
  //
  // THE REPLY IS NOT ADOPTED. The server drops empty segments before writing, so
  // adopting its answer would delete the circle the curator just dropped and has not
  // filled yet — the answer would be correct and the canvas would be wrong. `forSave`
  // is the other half of that: never-filled circles are not SENT either, so what the
  // client holds and what the file holds disagree about nothing. Local state is
  // authoritative for the length of the mode; `App.loadQueue` refuses a fetched canvas
  // while it is on, for the same reason.
  //
  // These are refs and not state because none of them is drawn. `flush` is built once
  // and never rebuilt, so the unmount effect below can depend on nothing and still be
  // the last thing that runs.
  const latest = useRef(state)
  latest.current = state
  const errored = useRef(onError)
  errored.current = onError
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unsaved = useRef(false)
  const flush = useRef(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (!unsaved.current) return
    unsaved.current = false
    api.saveQueueSegments(forSave(latest.current)).catch((e) => errored.current(e))
  }).current

  const firstRender = useRef(true)
  useEffect(() => {
    // Entering the mode is not an edit. Without this, opening the canvas and closing
    // it again would write the file for no reason — and on a guide that has never
    // been organized, would create it.
    if (firstRender.current) { firstRender.current = false; return }
    unsaved.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DEBOUNCE)
  }, [state])

  // Leaving the mode unmounts this component mid-debounce more often than not — the
  // last drop and the Escape that follows it are half a second apart. So the last
  // edit is written on the way out rather than lost.
  useEffect(() => () => flush(), [])

  /** A client point in canvas coordinates — what gets stored, so it must not depend
   *  on the zoom. */
  const toCanvas = (clientX: number, clientY: number) => {
    const r = surfaceRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k }
  }

  // Wheel zoom about the pointer, so the thing under the cursor stays under it. A
  // native non-passive listener rather than React's onWheel: React binds wheel
  // passively at the root, and a passive handler may not preventDefault — without
  // which the page behind scrolls while you zoom.
  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      setView((v) => {
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * Math.exp(-e.deltaY / 400)))
        const s = k / v.k
        return { k, x: px - (px - v.x) * s, y: py - (py - v.y) * s }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Esc leaves the mode — the same gesture that leaves ontology edit mode. It closes
  // an open roster first: one Esc, one layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (roster) { setRoster(null); return }
      onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [roster, onExit])

  // --- panning and moving ---------------------------------------------------

  /** Drag the empty canvas to pan it. Mousedown on a circle stops before this. */
  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    setRoster(null)   // clicking away from a pile closes its roster
    const from = { x: e.clientX, y: e.clientY }
    const at = { ...view }
    const onMove = (ev: MouseEvent) =>
      setView({ ...at, x: at.x + (ev.clientX - from.x), y: at.y + (ev.clientY - from.y) })
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'grabbing'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Drag a circle to move it — which is how a pile is RANKED, since the queue's
   *  block order is read off these positions. A mouseup that never travelled
   *  `MOVE_SLOP` is a click, and opens the roster instead. */
  const startMove = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const seg = state.segments.find((s) => s.id === id)
    if (!seg) return
    const from = { x: e.clientX, y: e.clientY }
    const at = { x: seg.x, y: seg.y }
    let moved = false
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - from.x
      const dy = ev.clientY - from.y
      if (!moved && Math.hypot(dx, dy) < MOVE_SLOP) return
      moved = true
      onChange(moveSegment(state, id, at.x + dx / view.k, at.y + dy / view.k))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (!moved) setRoster((r) => (r === id ? null : id))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // --- dropping -------------------------------------------------------------

  const draggedDocs = (e: React.DragEvent): string[] => {
    const raw = e.dataTransfer.getData(DOCS_DND)
    if (!raw) return []
    try { return JSON.parse(raw) as string[] } catch { return [] }
  }

  const onCanvasDragOver = (e: React.DragEvent) => {
    const t = e.dataTransfer.types
    if (t.includes(SEGMENT_NEW_DND) || t.includes(DOCS_DND)) e.preventDefault()
  }

  /** A drop on BARE canvas. The new circle lands where it was dropped — position is
   *  what this canvas is for, so the creating gesture is the one that puts it
   *  somewhere. Documents dropped here go back to unsegmented, which is what dragging
   *  one out of a roster means. */
  const onCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(null)
    if (e.dataTransfer.types.includes(SEGMENT_NEW_DND)) {
      const id = newSegmentId()
      onChange(createSegment(state, toCanvas(e.clientX, e.clientY), id))
      setRoster(id)   // a circle is dropped first and named after — offer the field
      return
    }
    const ids = draggedDocs(e)
    if (ids.length) onChange(unassignDocs(state, ids))
  }

  /** A drop on a CIRCLE: caught, the marked set whole. Stops the event, or the canvas
   *  underneath would immediately unfile what was just filed. */
  const onCircleDrop = (e: React.DragEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(null)
    const ids = draggedDocs(e)
    if (ids.length) onChange(assignDocs(state, ids, id))
  }

  // --- pieces ---------------------------------------------------------------

  const openSeg = state.segments.find((s) => s.id === roster) ?? null
  const members = openSeg
    ? docs.filter((d) => state.members[d.id] === openSeg.id)
    : []

  // The roster is rendered OUTSIDE the transformed plane and positioned in screen
  // coordinates, so it stays the same size and stays readable at any zoom — a
  // popover that shrank with the canvas would be unreadable exactly when a pile got
  // big enough to need one.
  const rosterAt = openSeg
    ? {
        left: view.x + openSeg.x * view.k + radiusFor(counts.get(openSeg.id) ?? 0) * view.k + 14,
        top: Math.max(8, view.y + openSeg.y * view.k - 40),
      }
    : null

  return (
    <div className="seg-canvas">
      <div
        className="seg-surface"
        ref={surfaceRef}
        onMouseDown={startPan}
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
        // The dot grid travels with the pan, so dragging the background reads as
        // moving the canvas rather than as nothing happening on an empty pile.
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
        }}
      >
        <div
          className="seg-plane"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          {state.segments.map((s) => {
            const n = counts.get(s.id) ?? 0
            const r = radiusFor(n)
            const hue = segmentColor(s.color)
            return (
              <div
                key={s.id}
                className={`seg-circle${over === s.id ? ' catching' : ''}${roster === s.id ? ' open' : ''}`}
                style={{
                  left: s.x - r, top: s.y - r, width: r * 2, height: r * 2,
                  '--pile-rail': hue, '--pile-fill': fillFor(hue, 2),
                } as CSSProperties}
                onMouseDown={(e) => startMove(e, s.id)}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(DOCS_DND)) return
                  e.preventDefault()
                  e.stopPropagation()
                  setOver(s.id)
                }}
                onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
                onDrop={(e) => onCircleDrop(e, s.id)}
                title={s.name || 'Unnamed pile'}
              >
                <span className="seg-count">{n}</span>
                <span className="seg-name">{s.name}</span>
              </div>
            )
          })}
          {/* The note sits UNDER the circle rather than inside it: a circle's inside is
              spoken for by the count and the name, and a note long enough to be worth
              writing never fits in one. */}
          {state.segments.filter((s) => s.note).map((s) => {
            const r = radiusFor(counts.get(s.id) ?? 0)
            return (
              <div key={`${s.id}-note`} className="seg-note"
                   style={{ left: s.x - r, top: s.y + r + 6, width: r * 2 }}>
                {s.note}
              </div>
            )
          })}
        </div>
      </div>

      {/* Fixed to the canvas, not to the plane, so they don't pan away. */}
      <div className="seg-tools">
        <span
          className="seg-new"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SEGMENT_NEW_DND, '1')
            e.dataTransfer.effectAllowed = 'copy'
          }}
          title="Drag onto the canvas to make a pile"
        >
          +
        </span>
        <span className="muted seg-zoom">{Math.round(view.k * 100)}%</span>
        <button onClick={() => setView({ x: 0, y: 0, k: 1 })} title="Back to 100%">
          Reset
        </button>
        <button className="save" onClick={onExit} title="Leave — the queue re-orders">
          Done
        </button>
      </div>

      {openSeg && rosterAt && (
        <Roster
          key={openSeg.id}
          segment={openSeg}
          members={members}
          taken={state.segments}
          at={rosterAt}
          selectedId={selectedId}
          onSelect={onSelect}
          onPatch={(patch) => onChange(patchSegment(state, openSeg.id, patch))}
          onClose={() => setRoster(null)}
        />
      )}

      {doc && (
        <div className="seg-viewer">
          <button className="seg-viewer-close" onClick={onCloseDoc} title="Close">✕</button>
          {/* READ-ONLY, abstract editing included. The mode's promise is that nothing
              done in it touches the graph, and a promise with one exception in it is
              one nobody can rely on. */}
          <DocumentViewer doc={doc} readOnly />
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// The roster: a pile's members, and the three things about the pile that are
// editable. Rows are CLICKABLE and open the document in the floating viewer — that
// is what makes a pile reviewable as a pile: click down the roster reading
// abstracts, and drag out the one that doesn't belong without leaving the mode.
// --------------------------------------------------------------------------

interface RosterProps {
  segment: { id: string; name: string; note: string; color: number }
  members: GraphNode[]
  taken: { id: string; name: string; color: number }[]
  at: { left: number; top: number }
  selectedId: string | null
  onSelect: (id: string) => void
  onPatch: (patch: { name?: string; note?: string; color?: number }) => void
  onClose: () => void
}

function Roster({
  segment, members, taken, at, selectedId, onSelect, onPatch, onClose,
}: RosterProps) {
  return (
    <div className="seg-roster" style={at} onMouseDown={(e) => e.stopPropagation()}>
      <div className="seg-roster-head">
        <input
          className="concept-name"
          value={segment.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="Name this pile…"
          autoFocus
        />
        <button className="seg-roster-close" onClick={onClose} title="Close">✕</button>
      </div>

      {/* The nine hues the ontology table uses. A new circle already took the next
          unused one in ramp order (`segmentEdit.nextColor`) — this is for overriding
          that, not for supplying it, which is why the taken ones are marked rather
          than removed. */}
      <div className="seg-swatches">
        {ROOT_COLORS.map((hex, i) => {
          const owner = taken.find((s) => s.color === i && s.id !== segment.id)
          return (
            <button
              key={hex}
              className={`seg-swatch${segment.color === i ? ' sel' : ''}${owner ? ' taken' : ''}`}
              style={{ background: hex }}
              onClick={() => onPatch({ color: i })}
              title={owner ? `Also ${owner.name || 'an unnamed pile'}` : `Colour ${i + 1}`}
              aria-pressed={segment.color === i}
            />
          )
        })}
      </div>

      <textarea
        className="concept-name seg-roster-note"
        value={segment.note}
        onChange={(e) => onPatch({ note: e.target.value })}
        placeholder="Why this pile…"
        rows={2}
      />

      <div className="seg-roster-count muted">
        {members.length} document{members.length === 1 ? '' : 's'} — drag one out to
        unfile it
      </div>
      <ul className="plain-list seg-roster-list">
        {members.map((d) => (
          <li
            key={d.id}
            className={d.id === selectedId ? 'sel' : ''}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DOCS_DND, JSON.stringify([d.id]))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => onSelect(d.id)}
            title={d.attributes.title || d.label}
          >
            {d.attributes.title || d.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
