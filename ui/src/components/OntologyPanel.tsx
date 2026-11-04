import {
  Fragment, useEffect, useMemo, useRef, useState,
  type DragEvent, type ReactNode,
} from 'react'
import { edgeVelocity } from '../dragScroll'
import { OntologyTable, rowIsWithin, type TableRow } from '../ontologyTable'
import { heatScale } from '../palette'
import { Pivot, type PivotCell, type PivotColumn, type TabKey } from '../pivot'
import type { FullGraph, Ontology } from '../types'

/** Editing mode for the ontology table. 'add' lights up insertion lines; 'delete'
 *  turns a row click into a delete. */
export type OntMode = 'normal' | 'add' | 'delete'

interface Props {
  ontology: Ontology
  /** The whole graph — the pivots are built from `about` edges, which the ontology
   *  map doesn't carry. */
  graph: FullGraph
  /** UNDER CONSTRUCTION — pinned to 'default' by App while the pivot tabs are off
   *  (see TABS below). Kept on the interface, not deleted, because the pivot
   *  renderer downstream is still live code that reads it. */
  tab: TabKey
  onTabChange: (t: TabKey) => void
  /** Structure-editing mode, owned by App (which guards an in-progress draft). */
  mode: OntMode
  onToggleAdd: () => void
  onToggleDelete: () => void
  /** Click on an insertion line: create a concept under `parentId` (null = a new
   *  top-level concept). */
  onClickInsert: (parentId: string | null, parentLabel: string | null) => void
  /** Click on a row while in delete mode. */
  onDeleteRow: (conceptId: string, label: string) => void
  /** The line the in-progress draft belongs to, so it can be marked. `undefined`
   *  when no draft; `null` means the top (new-root) line. */
  draftParentId?: string | null
  /** Concepts on the selected doc (unsaved-inclusive). Read-only here: the ticks
   *  reflect the left side's state, they don't control it. Worth showing anyway —
   *  seeing a document's concepts lit up in the hierarchy is how you notice it's
   *  been tagged at two levels of the same branch. */
  selectedIds: Set<string>
  /** Which row is focused. Owned by App, which guards the swap against an unsaved
   *  edit in the concept panel below. */
  focusedKey: string | null
  onClickRow: (row: TableRow) => void
  /** A cell click does two things, one per side: its documents fill the left
   *  column, and its COLUMN node (not the row's) opens in the panel below. */
  onClickCell: (row: TableRow, col: PivotColumn, cell: PivotCell) => void
  /** A column header is a node too, so it behaves like one: every document under
   *  it fills the left column, and the node itself opens below. */
  onClickColumn: (col: PivotColumn, docIds: string[]) => void
  /** The open cell, so it can be marked. Keyed row-concept|column. */
  activeCell: string | null
  /** A row was dragged onto another level. `from` is the parent of the row that
   *  was dragged, not "the concept's parent" — a poly-parented concept is drawn
   *  under each of its parents and only the dragged instance moves. `to` is null
   *  for the top level. */
  onReparent: (conceptId: string, from: string | null, to: string | null) => void
  /** Opens the chat shell, which replaces both this box and the concept box
   *  below it — owned by App, not by this panel, since the switch has to
   *  reach both. */
  onOpenChat: () => void
}

/* UNDER CONSTRUCTION — the pivot tabs are switched off in the UI.
 *
 * `co-occurrence` waits on the rework that decides what a cell says about an
 * artifact spanning more than two concepts (see pivot.ts PivotCell.related);
 * `authored_by` waits on that same cell vocabulary; `funds` was never modelled at
 * all — reaching a funder from a concept is a union of two paths, which is a
 * modelling decision nobody has made.
 *
 * Off means off *at the tab bar only*. Everything below — Pivot, heatScale, the
 * column heads, the marginals strip, the cell grid — is untouched, typechecked,
 * and covered by pivot.test.ts. `tab` never leaves 'default', so `pivot` is
 * always null and the pivoted branch never renders. Restoring the tabs is
 * uncommenting this array and the bar in the header.
 *
 * There is deliberately no bar with 'Concepts' alone in it: one view is not a
 * choice, and a tab bar that can't be used says otherwise.
 *
 * const TABS: { key: TabKey; label: string }[] = [
 *   { key: 'default', label: 'Concepts' },
 *   { key: 'concept', label: 'co-occurrence' },
 *   { key: 'authored_by', label: 'authored_by' },
 *   { key: 'funds', label: 'funds' },
 * ]
 */

/** Indent per level *inside a card*. Smaller than the flat table's 18px because
 *  the card already spends the first level of nesting: a child at depth 1 sits
 *  flush against the card's left edge, not one step in from a root row. */
const CARD_INDENT = 14

/** Where a card head's ✓ gutter starts: 4px rail + 8px padding (.ont-cardhead).
 *  A banded row's gutter starts at its own indent instead, so only the head needs
 *  a constant. Both are the grip's `left` — one gutter, two marks. */
const HEAD_GUTTER_X = 12

/** How long a column's full name stays up after the mouse leaves, and how long it
 *  then takes to fade. A column header is truncated to ~8 characters, so the name
 *  IS the header — it has to survive the mouse moving away to read the row you were
 *  aiming at. */
const HEADER_LINGER_MS = 5000
const HEADER_FADE_MS = 400

/** Drop-target key for the "make it a root" strip. Rows key on their path, which
 *  no concept id can collide with. */
const TOP_LEVEL = 'top-level'

// Rows are always concepts, drawn by the same hierarchy model as the plain table —
// the pivot tabs bolt columns onto that, they don't replace it. The label column is
// fixed-width so every grid starts at the same x whatever the indent, and sticky so
// it survives a horizontal scroll.
export default function OntologyPanel(props: Props) {
  const {
    ontology, graph, tab, onTabChange, selectedIds, focusedKey, onClickRow,
    onClickCell, onClickColumn, activeCell, onReparent,
    mode, onToggleAdd, onToggleDelete, onClickInsert, onDeleteRow, draftParentId,
    onOpenChat,
  } = props

  const hasDraft = draftParentId !== undefined

  // What a row click means. Two claimants, resolved in one place so the button
  // handlers below can't drift from each other: delete mode, then the ordinary
  // open-this-concept.
  const clickRowAction = (row: TableRow) => {
    if (mode === 'delete') { onDeleteRow(row.conceptId, row.label); return }
    onClickRow(row)
  }

  // -- dragging a concept between levels ------------------------------------
  //
  // The row being dragged, and the drop target under the cursor. Dragging is off
  // in add/delete mode: those modes have already redefined what a click on a row
  // means, and a third gesture on the same rows would be one too many.
  //
  // The handle exists so a drag has to be deliberate. Rows are click-to-select,
  // and a whole-row drag turns an imprecise click into a silent restructuring of
  // the ontology — the kind of edit you don't notice until much later.
  const [drag, setDrag] = useState<
    { conceptId: string; parentId: string | null; label: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const dragging = mode === 'normal' && drag !== null

  // Holding ⌘ turns the drop from a move into an ADD: the concept gains this
  // parent and keeps the ones it had. Read live from the drag events rather than
  // captured at dragstart, so the curator can change their mind mid-gesture and
  // watch the ghost change wording under the cursor.
  const [adding, setAdding] = useState(false)
  const dragAdds = dragging && adding
  // The same answer in a ref, because the DROP has to read it and state may not
  // have re-rendered between the last dragover and the release. Refs update in the
  // handler itself, so this is always the value the ghost was drawn from.
  const addingRef = useRef(false)
  // Promotion is a MOVE out of every level, so it has no meaning while ⌘ is held —
  // "also file this under nothing" is not an edit. The bar stays, as the label for
  // what is being dragged; it just stops accepting a drop.
  const topLevelOffered = dragging && !adding && drag!.parentId !== null

  /** Every concept's parents, by id. `TableRow.alsoIn` carries labels, which is
   *  enough to tell a curator where else something lives but not enough to decide
   *  whether a drop is redundant. */
  const parentsOf = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of ontology.edges) {
      if (e.type !== 'subtopic_of') continue
      const set = m.get(e.source) ?? new Set<string>()
      set.add(e.target)
      m.set(e.source, set)
    }
    return m
  }, [ontology])
  // Is a drag still live? Set on dragstart, cleared on dragend. The deferred
  // setDrag below reads it so a drag the browser aborted before the timer ran
  // can't leave the panel stuck in a moving state with nothing being moved.
  const dragLive = useRef(false)

  // -- autoscroll ------------------------------------------------------------
  //
  // Reaching a target that is off screen without letting go. The wheel still works
  // mid-drag, so this is an alternative to it rather than a rescue from it — it
  // keeps a long drag one gesture instead of two. Driven by rAF rather than by
  // dragover, because dragover only fires when the pointer MOVES, and holding
  // still at the edge waiting for the list to come to you is the whole point.
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const scrollSpeed = useRef(0)
  const scrollRaf = useRef<number | null>(null)

  const stepScroll = () => {
    const el = rowsRef.current
    if (!el || scrollSpeed.current === 0) { scrollRaf.current = null; return }
    el.scrollTop += scrollSpeed.current
    scrollRaf.current = requestAnimationFrame(stepScroll)
  }
  const stopAutoscroll = () => {
    scrollSpeed.current = 0
    if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current)
    scrollRaf.current = null
  }
  /** Aim the autoscroll from wherever the cursor is. Bound on the wrapper, not on
   *  the rows: the drag bar floats over the top edge, which is precisely where the
   *  "scroll up" zone lives, and events over the bar don't reach the list. */
  const aimAutoscroll = (clientY: number) => {
    const el = rowsRef.current
    if (!el || !dragLive.current) return
    const r = el.getBoundingClientRect()
    scrollSpeed.current = edgeVelocity(clientY, r.top, r.bottom)
    if (scrollSpeed.current !== 0 && scrollRaf.current === null) {
      scrollRaf.current = requestAnimationFrame(stepScroll)
    }
  }
  // A drag can end anywhere — off the window, on another element, in a tab switch
  // — so the loop must not depend on our own handlers being the ones to stop it.
  useEffect(() => {
    if (!dragging) { stopAutoscroll(); return }
    window.addEventListener('dragend', stopAutoscroll)
    window.addEventListener('drop', stopAutoscroll)
    return () => {
      window.removeEventListener('dragend', stopAutoscroll)
      window.removeEventListener('drop', stopAutoscroll)
      stopAutoscroll()
    }
  }, [dragging])

  // `leftPx` is where the row's own ✓ gutter starts. The grip has to be told,
  // because it is out of flow: it hangs off the wrapper, which knows nothing about
  // the indent the button inside it was given. Pinning it to a constant put every
  // handle in a straight column while the labels stepped in beneath them.
  const gripFor = (row: TableRow, leftPx: number) => (
    <span
      className="ont-grip"
      style={{ left: leftPx }}
      draggable
      role="button"
      aria-label={`Move ${row.label} to another level`}
      title={`Drag ${row.label} onto another concept to move it there`}
      onDragStart={(e) => {
        // 'copyMove', not 'move': a drop may turn out to be either, and the choice
        // isn't made until ⌘ is up or down at the moment of release. Declaring
        // 'move' here makes dropEffect = 'copy' an invalid assignment later, and a
        // dropEffect the browser won't accept can end as 'none' — which cancels
        // the drop rather than merely mislabelling it.
        e.dataTransfer.effectAllowed = 'copyMove'
        // Firefox won't start a drag unless some data is set.
        e.dataTransfer.setData('text/plain', row.conceptId)
        // Deferred out of the handler, and this is load-bearing in Safari.
        //
        // dragstart is a discrete event, so React flushes a setState inside it
        // SYNCHRONOUSLY — the re-render lands while the browser is still setting
        // the drag up. That render inserts the top-level strip above the cards,
        // which shifts the drag source itself, and Safari responds by aborting the
        // drag: dragend fires at once, onDragEnd clears the state, and the whole
        // gesture is over within a frame. What the curator sees is a grab cursor
        // and nothing else. One task later, the drag is already underway and the
        // same render is harmless.
        //
        // jsdom cannot reproduce any of this (it has no drag machinery), so the
        // tests below drive it through a helper that waits a tick, and they are
        // not evidence on their own that this works in a browser.
        const started = { conceptId: row.conceptId, parentId: row.parentId, label: row.label }
        dragLive.current = true
        setTimeout(() => { if (dragLive.current) setDrag(started) }, 0)
      }}
      onDragEnd={() => { dragLive.current = false; setDrag(null); setOver(null) }}
      // The grip sits inside the row's click target; without this, picking it up
      // would also select the row underneath.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >⠿</span>
  )

  /** Can the dragged row land on this one? Three refusals, all of which would
   *  otherwise be a drop that either fails server-side or does nothing:
   *  onto itself, onto something inside its own subtree (a cycle), or back onto
   *  the parent it already hangs under. */
  const canDropOn = (target: TableRow) =>
    dragging
    && target.conceptId !== drag!.conceptId
    && !rowIsWithin(target, drag!.conceptId)
    && (adding
      // Filing it somewhere it already lives would add nothing. In move mode only
      // THIS row's parent is refused — the same concept under another parent is a
      // legitimate destination, because moving one instance leaves the rest alone.
      ? !parentsOf.get(drag!.conceptId)?.has(target.conceptId)
      : target.conceptId !== drag!.parentId)

  // A drop target's handlers. `key` identifies it only so `over` can mark the one
  // under the cursor; TOP_LEVEL is the strip rather than a row.
  const dropProps = (key: string, toConceptId: string | null, valid: boolean) => ({
    onDragOver: (e: DragEvent) => {
      // Tracked even for an invalid target: releasing ⌘ over a row that is only
      // refused *because* ⌘ is held has to make that row become valid again.
      addingRef.current = e.metaKey
      setAdding(e.metaKey)
      if (!valid) return
      e.preventDefault()          // without this the browser refuses the drop
      e.dataTransfer.dropEffect = e.metaKey ? 'copy' : 'move'
      setOver(key)
    },
    // Only a leave that actually exits the wrapper counts. Without the containment
    // check, moving the cursor from the wrapper onto its own child button fires
    // dragleave and drops the outline and the destination ghost while the pointer
    // is still over a valid target — which reads as "nothing is happening". Same
    // guard the document drop zone uses in App.tsx.
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return
      setOver((k) => (k === key ? null : k))
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      if (!valid || !drag) return
      // `from` is what makes this a move: naming the edge to drop. For an add
      // there is no edge to drop, so null — the service adds the new parent and
      // removes nothing, which is exactly "file it here as well".
      //
      // Which one it is comes from the last dragover, not from this event. Reading
      // e.metaKey here meant ⌘ had to survive the mouse release to the millisecond:
      // let go a hair early and a duplicate silently became a move. The ghost has
      // already said which drop this is, so the ghost is what happens — `|| e.metaKey`
      // only catches ⌘ pressed at the very last instant, with no dragover after it.
      const isAdd = addingRef.current || e.metaKey
      onReparent(drag.conceptId, isAdd ? null : drag.parentId, toConceptId)
      dragLive.current = false
      addingRef.current = false
      setDrag(null); setOver(null); setAdding(false)
    },
  })

  /** The level cue, and now the ONLY cue: a ghost row at the depth the concept
   *  would land at, drawn under the target it would land beneath. Showing the
   *  destination *level* is the point — a ring round the target says which concept
   *  becomes the parent, but not what the result looks like, and "one level down"
   *  is exactly what a curator is trying to judge mid-drag. The rings are gone
   *  (they marked nearly every row, then landed a hard black outline on one), so
   *  this line carries the whole answer: what is moving, and where it lands.
   *
   *  `leftPx` is absolute within the row's wrapper, because the ghost is now
   *  positioned rather than in flow. */
  const dropGhost = (targetLabel: string, leftPx: number) => (
    <div className={`ont-dropghost${dragAdds ? ' adding' : ''}`} style={{ paddingLeft: leftPx }}>
      <span className="ont-dropghost-arrow">{dragAdds ? '＋' : '↳'}</span>
      <span className="ont-dropghost-label">{drag!.label}</span>
      {/* "also under" vs "under" is the whole difference between the two drops,
          so it is said in words rather than left to the arrow alone. */}
      <span className="ont-dropghost-under">
        {dragAdds ? 'also under' : 'under'} {targetLabel}
      </span>
    </div>
  )

  // An insertion line in add mode: a thin target under a row, inside its card.
  // Indent hints the depth the new concept will land at, in card-body units.
  const insertLine = (parentId: string, parentLabel: string, indentDepth: number) => (
    <button
      className={`ont-insert${hasDraft && draftParentId === parentId ? ' active' : ''}`}
      style={{ paddingLeft: 8 + indentDepth * CARD_INDENT }}
      title={`New subtopic of ${parentLabel}`}
      onClick={() => onClickInsert(parentId, parentLabel)}
    >
      <span className="ont-insert-plus">＋</span>
      <span className="ont-insert-label">subtopic of {parentLabel}</span>
    </button>
  )

  // A new *root* has no row to hang a line under, so it gets a card of its own —
  // an outline where a card would be, at the top of the stack, where you can reach
  // it without scrolling past every existing card first.
  const newRootCard = (
    <button
      className={`ont-newroot${hasDraft && draftParentId === null ? ' active' : ''}`}
      title="New top-level concept"
      onClick={() => onClickInsert(null, null)}
    >
      <span className="ont-insert-plus">＋</span>
      <span>top-level concept</span>
    </button>
  )

  // What a concept looks like as a row, shared by the card bodies and the pivot
  // grid so the two renderers can't drift on it. They differ only in the indent
  // unit and in what trails the label.
  const conceptButton = (row: TableRow, indentPx: number, trailing?: ReactNode) => {
    const selected = selectedIds.has(row.conceptId)
    return (
      <button
        className={`ont-rowlabel${selected ? ' sel' : ''}${row.key === focusedKey ? ' focus' : ''}${mode === 'delete' ? ' deletable' : ''}`}
        style={{ paddingLeft: indentPx }}
        onClick={() => clickRowAction(row)}
        title={mode === 'delete' ? `Delete ${row.label}`
          : (row.alsoIn.length ? `Also in: ${row.alsoIn.join(', ')}` : row.label)}
      >
        {/* Colour is spoken for by the hierarchy, so assignment gets its own
            channel: a mark, not a hue. It sits in a fixed gutter outside the
            band, so a tick appearing never resizes the colour. */}
        <span className="ont-check">{selected ? '✓' : ''}</span>
        {/* The band is the only coloured thing — it hugs the label rather than
            filling the row. The rail is the card head's job now, so a band inside
            a card never carries one; in the pivot grid, where there are no cards,
            roots still do. */}
        <span
          className="ont-band"
          style={{
            background: row.fill,
            borderLeftColor: row.depth === 0 ? row.rail : 'transparent',
          }}
        >
          <span className="ont-label">{row.label}</span>
          {row.alsoIn.length > 0 && <span className="ont-dup" title="Appears under more than one parent">⧉</span>}
        </span>
        {trailing}
      </button>
    )
  }

  // A root, as the head of its card: a full-bleed bar rather than a band hugging
  // the label. Ragged right edges are most of what made the flat list read as
  // unarranged, and a root is the one row that can afford the width.
  const cardHead = (row: TableRow) => {
    const selected = selectedIds.has(row.conceptId)
    return (
      <button
        className={`ont-cardhead${selected ? ' sel' : ''}${row.key === focusedKey ? ' focus' : ''}${mode === 'delete' ? ' deletable' : ''}`}
        style={{ background: row.fill, borderLeftColor: row.rail }}
        onClick={() => clickRowAction(row)}
        title={mode === 'delete' ? `Delete ${row.label}` : row.label}
      >
        <span className="ont-check">{selected ? '✓' : ''}</span>
        <span className="ont-cardtitle">{row.label}</span>
        {/* A root normally has no other parent — but a concept recovered from a
            subtopic_of cycle is emitted as its own root and does. */}
        {row.alsoIn.length > 0 && <span className="ont-dup" title="Appears under more than one parent">⧉</span>}
      </button>
    )
  }

  const table = useMemo(() => new OntologyTable(ontology), [ontology])

  // Cards are a *view* of the flat row list, not a second model: a depth-0 row
  // opens one and the rows after it collect into it until the next root. So
  // poly-parenting (a concept appearing under several parents), cycle recovery
  // (an unreachable concept surfaced as its own root) and the MAX_ROWS cap all
  // keep behaving exactly as OntologyTable already decided they should — a
  // poly-parented concept simply shows up in each card whose branch reaches it.
  const cards = useMemo(() => {
    const out: { root: TableRow; children: TableRow[] }[] = []
    for (const row of table.rows) {
      // The `!out.length` arm can't fire — emit() always starts a branch at
      // depth 0 — but a row with nowhere to go would silently vanish from the
      // curator's table, and a stray card is a far better failure than that.
      if (row.depth === 0 || !out.length) out.push({ root: row, children: [] })
      else out[out.length - 1].children.push(row)
    }
    return out
  }, [table])

  // Recomputes exactly when the graph object changes — which is the whole cache
  // policy. A refetch makes a new object; nothing else does.
  const pivot = useMemo(
    () => (tab === 'default' ? null : new Pivot(graph, tab)),
    [graph, tab],
  )
  const heat = useMemo(
    () => heatScale(pivot?.heatCounts ?? []),
    [pivot],
  )

  // The "also in" notice belongs to the row that was clicked, not the concept —
  // it names the parents *other than* the one you clicked under.
  const focused = table.rows.find((r) => r.key === focusedKey)
  const notice = focused && focused.alsoIn.length > 0 ? focused : null

  // Columns follow the ROW order on the concept axis, so the diagonal actually
  // runs diagonally. (Pivot sorts by marginal, which is right for people and
  // funders — they have no hierarchy to echo — and wrong here, where the columns
  // are the same concepts as the rows and should line up with them.)
  //
  // It can't be a perfect diagonal: a poly-parented concept is several rows but one
  // column, so the run breaks after each duplicate. Ranking by first appearance
  // keeps everything above the first duplicate exactly on the diagonal.
  const columns = useMemo(() => {
    if (!pivot) return []
    if (tab !== 'concept') return pivot.columns
    const rank = new Map<string, number>()
    table.rows.forEach((r, i) => { if (!rank.has(r.conceptId)) rank.set(r.conceptId, i) })
    return [...pivot.columns].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
    )
  }, [pivot, table, tab])

  // Truncated headers need their full name on hover, and it has to linger: the
  // native `title` tooltip vanishes the instant you move toward the cell you were
  // reading the header for, which is exactly when you still need it.
  const [namedCol, setNamedCol] = useState<string | null>(null)
  const [fading, setFading] = useState(false)
  const timers = useRef<number[]>([])
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = [] }
  useEffect(() => clearTimers, [])

  const showName = (id: string) => {
    clearTimers()
    setFading(false)
    setNamedCol(id)
  }
  const hideName = () => {
    clearTimers()
    timers.current.push(window.setTimeout(() => {
      setFading(true)
      timers.current.push(window.setTimeout(() => setNamedCol(null), HEADER_FADE_MS))
    }, HEADER_LINGER_MS))
  }

  return (
    <div className="ont">
      <div className="ont-head">
        <strong>Ontology</strong>
        {/* UNDER CONSTRUCTION — the pivot tab bar was here. See TABS above.
        <div className="ont-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={t.key === tab}
              className={t.key === tab ? 'sel' : ''}
              onClick={() => onTabChange(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div> */}
        {/* Structure editing sits where the row count used to: + places a new
            concept on a dividing line, − deletes the concept you click. Mutually
            exclusive toggles. */}
        <div className="ont-editbtns" title={`${table.rows.length} rows`}>
          <button
            className={`ont-editbtn${mode === 'add' ? ' on-add' : ''}`}
            title="Add a concept — then click a dividing line"
            aria-pressed={mode === 'add'}
            onClick={onToggleAdd}
          >＋</button>
          <button
            className={`ont-editbtn${mode === 'delete' ? ' on-delete' : ''}`}
            title="Delete a concept — then click it"
            aria-pressed={mode === 'delete'}
            onClick={onToggleDelete}
          >－</button>
        </div>
        {/* A poly-parented concept is drawn under each of its parents; clicking one
            instance names the others here. */}
        {notice && (
          <span className="ont-alsoin" title={`${notice.label} also in: ${notice.alsoIn.join(', ')}`}>
            <strong>{notice.label}</strong> also in: {notice.alsoIn.join(', ')}
          </span>
        )}
        {/* Right-justified at the header's own right edge — deliberately away
            from the +/− structure-editing buttons, which are a different kind
            of control. Opens the chat shell (see App), which takes over both
            this box and the concept box below it. */}
        <button
          type="button"
          className="chat-toggle"
          title="Open curation assistant"
          aria-pressed={false}
          onClick={onOpenChat}
        >💬</button>
      </div>

      {pivot && tab !== 'funds' && (
        <div className="ont-legend">
          <span><i className="lg-sw lg-heat" />documents about both — darker is more</span>
          {/* UNDER CONSTRUCTION — the curator-assertion swatch. `relates_to` is
              gone from the model and artifacts replace it, but an artifact spans a
              SET of nodes and this legend describes a pair. Restored with the
              co-occurrence rework; see pivot.ts PivotCell.related.
          <span><i className="lg-sw lg-dot-sw"><i /></i>the curator has written about this pair</span> */}
          <span><i className="lg-sw lg-plain">5</i>a concept’s own documents, not a co-occurrence</span>
        </div>
      )}

      {table.truncated && (
        <div className="ont-notice">
          Too many rows to show — the table is cut off at {table.rows.length}.
        </div>
      )}

      {mode === 'add' && (
        <div className="ont-modehint">Adding — click a dividing line to place a new concept.</div>
      )}
      {mode === 'delete' && (
        <div className="ont-modehint danger">Deleting — click a concept to remove it.</div>
      )}
      {tab === 'funds' && (
        <div className="ont-notice">
          Not modelled yet — reaching a funder from a concept is a union of two
          paths (fund the author, or fund an org the author sits in), and that's a
          modelling decision. Empty beats wrong.
        </div>
      )}

      {/* The wrapper exists so the drag bar can be pinned over the top of the list
          without being IN the list. `.ont-rows` is the scroller, so an overlay
          inside it would scroll away with the content. */}
      <div
        className="ont-rowswrap"
        onDragOver={(e) => aimAutoscroll(e.clientY)}
        onDragLeave={(e) => {
          // Only when the cursor actually leaves the region — the same containment
          // check the drop targets use, for the same reason.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) stopAutoscroll()
        }}
        onDrop={stopAutoscroll}
      >
      {/* Says what is moving, and — for a concept that has a parent — doubles as
          the target that promotes it to the top level. Floated rather than
          inserted: this used to be two boxes pushed into the flow at dragstart,
          which shoved the whole ontology ~40px down at the exact moment the
          curator was aiming at it. Displacing the drag source this way is also
          what made Safari abort the drag outright (see gripFor). */}
      {dragging && (
        <div
          className={`ont-dragbar${over === TOP_LEVEL ? ' over' : ''}`
            + `${topLevelOffered ? ' targetable' : ''}`}
          {...(topLevelOffered ? dropProps(TOP_LEVEL, null, true) : {})}
        >
          {dragAdds
            ? <>Filing <strong>{drag!.label}</strong> in a second place</>
            : <>Moving <strong>{drag!.label}</strong></>}
          {topLevelOffered && <> · ↑ drop here to make it top-level</>}
          {/* An invisible modifier is unfindable, so the bar has to say it. Not
              shown once ⌘ is down — by then it is the bar's first clause. */}
          {!dragAdds && <> · hold ⌘ to file it somewhere as well</>}
        </div>
      )}
      <div className={`ont-rows${pivot ? ' pivoted' : ''}`} ref={rowsRef}>
        {pivot && (
          <div className="ont-colheads">
            <div className="ont-corner" />
            {columns.map((c) => (
              <button
                key={c.id}
                className="ont-colhead"
                onMouseEnter={() => showName(c.id)}
                onMouseLeave={hideName}
                onClick={() => onClickColumn(c, pivot!.columnDocuments(c.id))}
                disabled={c.total === 0}
              >
                <span className="ont-colhead-label">{c.label}</span>
                {namedCol === c.id && (
                  <span className={`ont-colname${fading ? ' fading' : ''}`}>
                    {c.label} <span className="muted">· {c.total}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {pivot && (
          <div className="ont-row ont-marginals">
            <div className="ont-rowlabel ont-marginal-label muted">documents</div>
            {columns.map((c) => (
              <div key={c.id} className="ont-cell ont-marginal" title={`${c.label}: ${c.total} documents`}>
                {c.total || ''}
              </div>
            ))}
          </div>
        )}

        {/* The pivot grid: one flat table, every row the same shape, cells aligned
            down the whole thing under a sticky label column. Cards can't do that —
            a card boundary breaks the column alignment the grid exists for — so the
            two renderers stay separate rather than one trying to be both. Dormant
            while the tabs are off; see TABS. */}
        {pivot && table.rows.map((row) => (
            <div className="ont-row" key={row.key}>
              {conceptButton(
                row,
                row.depth * 18,
                <span className="ont-rowtotal">{pivot.rowTotal(row.conceptId) || ''}</span>,
              )}

              {columns.map((col) => {
                const cell = pivot.cell(row.conceptId, col.id)
                if (!cell) return <div key={col.id} className="ont-cell" />
                // Only intersections get heat. Containment cells are marginals, not
                // intersections — colouring them would answer a different question
                // in the same channel, and they'd win, being systematically larger.
                const fill = cell.kind === 'intersection' ? heat(cell.count) : null
                const active = activeCell === `${row.conceptId}|${col.id}`
                return (
                  <button
                    key={col.id}
                    className={`ont-cell ${cell.kind}${cell.related ? ' related' : ''}${active ? ' active' : ''}`}
                    style={fill ? { background: fill } : undefined}
                    title={cellTitle(row.label, col.label, cell)}
                    // An empty cell has no documents to show, so there's nothing to
                    // open. It still says something (it's the frontier) — it just
                    // says it by being empty.
                    disabled={cell.count === 0}
                    onClick={() => onClickCell(row, col, cell)}
                  >
                    {cell.count || ''}
                  </button>
                )
              })}
            </div>
        ))}

        {!pivot && mode === 'add' && newRootCard}

        {/* The live path: one card per root concept. The card carries the branch's
            hue in its head, which is what lets the rows inside stop competing —
            no hairline between them, no rail on each band, because the container
            is already saying "these belong together". */}
        {!pivot && cards.map(({ root, children }) => {
          const rootDroppable = canDropOn(root)
          return (
          <div className="ont-card" key={root.key}>
            <div
              className={`ont-dropwrap${rootDroppable ? ' droppable' : ''}`
                + `${over === root.key ? ' over' : ''}`}
              {...dropProps(root.key, root.conceptId, rootDroppable)}
            >
              {mode === 'normal' && gripFor(root, HEAD_GUTTER_X)}
              {cardHead(root)}
              {/* A drop onto the card head lands at the top of its body. The ghost
                  hangs off the head's wrapper and floats over that spot rather than
                  being inserted into the body — see .ont-dropghost. 20px = the card
                  body's 12px padding plus the 8px every ghost carries, so it lands
                  where it did when it was a child of the body. */}
              {over === root.key && dropGhost(root.label, 20)}
            </div>
            <div className="ont-cardbody">
              {/* Directly under the head: a subtopic of the root itself. */}
              {mode === 'add' && insertLine(root.conceptId, root.label, 0)}
              {children.map((row) => {
                const droppable = canDropOn(row)
                return (
                <Fragment key={row.key}>
                  {/* depth-1 sits flush left: the card spent the first level. */}
                  <div
                    className={`ont-dropwrap${droppable ? ' droppable' : ''}`
                      + `${over === row.key ? ' over' : ''}`}
                    {...dropProps(row.key, row.conceptId, droppable)}
                  >
                    {/* Same expression twice on purpose: the grip's left and the
                        button's padding are the same gutter. */}
                    {mode === 'normal' && gripFor(row, (row.depth - 1) * CARD_INDENT)}
                    {conceptButton(row, (row.depth - 1) * CARD_INDENT)}
                    {/* Inside the wrapper, so it floats under this row instead of
                        prising the rows below it apart as the cursor moves. */}
                    {over === row.key && dropGhost(row.label, 8 + row.depth * CARD_INDENT)}
                  </div>
                  {mode === 'add' && insertLine(row.conceptId, row.label, row.depth)}
                </Fragment>
                )
              })}
              {children.length === 0 && mode !== 'add' && !dragging && (
                <p className="ont-cardempty muted">No subtopics.</p>
              )}
            </div>
          </div>
          )
        })}

        {table.rows.length === 0 && mode !== 'add' && <p className="muted">No concepts yet.</p>}
      </div>
      </div>
    </div>
  )
}

function cellTitle(
  row: string, col: string, cell: { kind: string; count: number; related?: boolean },
): string {
  if (cell.kind === 'self') return `${row}: ${cell.count} documents`
  if (cell.kind === 'containment') {
    return `${col} is inside ${row} (or the reverse) — ${cell.count} documents at the `
      + `deeper one. They can't co-occur, so this isn't a gap.`
  }
  const n = `${cell.count} document${cell.count === 1 ? '' : 's'} about both ${row} and ${col}`
  // UNDER CONSTRUCTION. `cell.related` is always undefined until the co-occurrence
  // rework decides what a cell should say about an artifact spanning more than two
  // concepts — so the captions below would all read "nobody has drawn the link",
  // which is now false for any pair a curator HAS remarked on. Saying nothing beats
  // saying that. See pivot.ts PivotCell.related.
  //
  // if (cell.related) return `${n} · the curator has written about this pair`
  // if (cell.count === 0) return `Nothing links ${row} and ${col}, and nothing written`
  // return `${n} · they keep co-occurring but nobody has said why`
  if (cell.count === 0) return `Nothing links ${row} and ${col}`
  return n
}
