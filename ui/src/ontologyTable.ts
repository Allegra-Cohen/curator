// The model behind the right panel: an ontology flattened into one column of
// rows. No React in here — this is pure derivation, so it can be reasoned about
// and tested on its own.
//
// The spine is `subtopic_of` alone; `prerequisite_of` is a cross-link and plays no
// part in the table.
//
// A hierarchy only nests cleanly when each concept has one parent, which an
// ontology does not guarantee. Rather than pick a winning parent and hide the
// rest (the old graph layout showed such a concept once, under whichever parent
// came first), a poly-parented concept is emitted *under every parent*. Rows are
// therefore keyed by path, not by concept id: the same concept can be several
// rows. Selection stays keyed by concept id, so selecting one instance lights
// them all — which is what tells the curator the concept is poly-parented.

import type { Ontology } from './types'
import { ROOT_COLORS, fillFor, rootColor } from './palette'

export interface TableRow {
  /** Unique per row. The same concept under two parents yields two keys. */
  key: string
  conceptId: string
  label: string
  /** Depth in the subtopic_of tree; 0 is a root. Drives indent and tint. */
  depth: number
  /** The parent this row hangs under; null for a root. Not the concept's only
   *  parent — a poly-parented concept is one row per parent, and this is the one
   *  THIS row is drawn beneath. Dragging a row moves exactly this edge, which is
   *  why it has to be on the row rather than looked up from the concept. */
  parentId: string | null
  /** Root hue, at full chroma — the rail down the row's left edge. */
  rail: string
  /** Row background: the rail's hue, tinted for this depth. */
  fill: string
  /** Labels of this concept's *other* parents; empty unless poly-parented. */
  alsoIn: string[]
}

// A pathological ontology (many concepts with many parents each) can duplicate
// its way into exponentially many rows. Cap it so the panel degrades instead of
// hanging the browser; `truncated` lets the UI admit it rather than quietly lie.
const MAX_ROWS = 4000

export class OntologyTable {
  readonly rows: TableRow[] = []
  readonly truncated: boolean
  /** Roots that exhausted the palette and fell back to neutral grey. */
  readonly uncoloredRoots: number

  private readonly instances = new Map<string, TableRow[]>()

  constructor(ontology: Ontology) {
    const order = new Map(ontology.nodes.map((n, i) => [n.id, i]))
    const label = new Map(ontology.nodes.map((n) => [n.id, n.label]))
    const children = new Map<string, string[]>()
    const parents = new Map<string, string[]>()

    for (const e of ontology.edges) {
      if (e.type !== 'subtopic_of') continue   // source = child, target = parent
      if (!label.has(e.source) || !label.has(e.target)) continue
      push(children, e.target, e.source)
      push(parents, e.source, e.target)
    }

    // Insertion order throughout, matching how the ontology reads in the API.
    const rank = (id: string) => order.get(id) ?? 0
    for (const kids of children.values()) kids.sort((a, b) => rank(a) - rank(b))
    const roots = ontology.nodes
      .filter((n) => !parents.has(n.id))
      .sort((a, b) => rank(a.id) - rank(b.id))

    let overflow = false
    const emit = (id: string, depth: number, rail: string, parentId: string | null, path: string, seen: Set<string>) => {
      if (this.rows.length >= MAX_ROWS) { overflow = true; return }
      // Guard the *current path* only: revisiting a concept on another branch is
      // the duplication we want, but revisiting one already on this path is a
      // cycle and would recur forever.
      if (seen.has(id)) return

      const key = `${path}/${id}`
      const row: TableRow = {
        key,
        conceptId: id,
        label: label.get(id) ?? id,
        depth,
        parentId,
        rail,
        fill: fillFor(rail, depth),
        alsoIn: (parents.get(id) ?? [])
          .filter((p) => p !== parentId)
          .sort((a, b) => rank(a) - rank(b))
          .map((p) => label.get(p) ?? p),
      }
      this.rows.push(row)
      push(this.instances, id, row)

      const next = new Set(seen).add(id)
      for (const c of children.get(id) ?? []) emit(c, depth + 1, rail, id, key, next)
    }

    let hue = 0
    const emitRoot = (id: string) => emit(id, 0, rootColor(hue++), null, '', new Set())
    roots.forEach((r) => emitRoot(r.id))

    // Every member of a `subtopic_of` cycle has a parent, so none of them counts
    // as a root and the walk above never reaches them. Surface whatever is still
    // unplaced as its own root — a bad edge should not make concepts disappear
    // from the curator's table.
    for (const n of ontology.nodes) if (!this.instances.has(n.id)) emitRoot(n.id)

    this.truncated = overflow
    this.uncoloredRoots = Math.max(0, hue - ROOT_COLORS.length)
  }

  /** Every row showing this concept — one unless it is poly-parented. */
  rowsFor(conceptId: string): TableRow[] {
    return this.instances.get(conceptId) ?? []
  }

  /** True when this concept sits under more than one parent. */
  isDuplicated(conceptId: string): boolean {
    return this.rowsFor(conceptId).length > 1
  }
}

/** Is `conceptId` on this row's path — the row itself, or any ancestor of it?
 *
 *  What a drop has to refuse: putting a concept under something already inside
 *  its own subtree would close a `subtopic_of` cycle. `relate` rejects that
 *  server-side, but a drag that is going to fail should never look droppable.
 *
 *  Needs no traversal, because `key` already IS the ancestor chain — it is built
 *  as `${parentPath}/${id}` on the way down. Ids are uuids, so exact segment
 *  matching can't collide.
 */
export function rowIsWithin(row: TableRow, conceptId: string): boolean {
  return row.key.split('/').includes(conceptId)
}

function push<T>(m: Map<string, T[]>, k: string, v: T) {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}
