// The model behind the ontology table's pivot tabs. No React in here — pure
// derivation, same bet as ontologyTable.ts: it can be reasoned about on its own.
//
// One rule holds the whole thing up:
//
//     Row and column headers are always NODES. Cells are always DOCUMENTS.
//
// The tab picks how you get from the row concept to the column node; the
// documents found on the way are the cell. That is what makes every axis
// heat-mappable — a cell is a document count, never an edge-presence flag — and
// it is why an axis is only legal if its path runs *through* a document.
// (`works_on`, person -> concept with nothing in between, can never be an axis.)
//
// Because cells are document SETS, `count` is just `|set|`: no path multiplicity
// to dedupe, no canonical-route rule to invent.
//
// See PIVOT_DESIGN.md for the reasoning; this file is the consequence.

import type { FullGraph, GraphEdge, GraphNode } from './types'

export type AxisKey = 'concept' | 'authored_by' | 'funds'

/** The tab bar's options. `default` is the plain one-column table — not an axis at
 *  all, so Pivot never sees it. */
export type TabKey = 'default' | AxisKey

/** What a cell counts. These are different *questions*, not different sizes of
 *  the same one, so they neither interchange nor share a heat scale. */
export type CellKind =
  /** Documents at the junction of two independent things. The real signal, and
   *  the only kind that gets heat. */
  | 'intersection'
  /** One concept is inside the other (ancestor/descendant), so the cell is the
   *  DEEPER concept's document count. No document can co-occur a concept with its
   *  own ancestor — terminal pruning guarantees it — so the honest answer is not
   *  zero, it is "these two are not independent". Drawn as a bare number: a zero
   *  here would read as a gap worth chasing, and it can never be one. */
  | 'containment'
  /** The diagonal: the concept's own document count. */
  | 'self'

export interface PivotCell {
  kind: CellKind
  documentIds: string[]
  count: number
  /** UNDER CONSTRUCTION — always undefined; the overlay is switched off pending
   *  the co-occurrence rework.
   *
   *  This used to be "is there a relates_to edge for this pair?": a curator
   *  assertion the co-occurrence data could support or contradict, the value being
   *  in the disagreement. `relates_to` has been removed from the model, and what
   *  replaces it is an artifact — the curator's prose about a SET of nodes, which
   *  is not pairwise and so cannot be read off a pair the way an edge could. What
   *  a cell should say about a remark spanning three concepts is a real question
   *  and belongs to the rework, not to a mechanical port of the old flag.
   *
   *  Kept in the type rather than deleted so the reader below stays legible: the
   *  field is what the intersection cell is *missing*, not a leftover. */
  related?: boolean
}

export interface PivotColumn {
  id: string
  label: string
  /** The marginal: documents in this column across all rows. An empty cell only
   *  means something next to fat marginals, so this has to stay visible — it is
   *  also why empty columns can't be filtered away as a scale trick. */
  total: number
}

interface Built {
  columns: PivotColumn[]
  cells: Map<string, PivotCell>
  heatCounts: number[]
  /** The documents behind each column's marginal — the same rule as a cell, one
   *  level up: a column header is a node, so what's under it is documents. */
  columnDocs: Map<string, string[]>
}

const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`)
const cellKey = (row: string, col: string) => `${row}|${col}`

// --------------------------------------------------------------------------
// Terminal concepts — what a document actually counts toward.
// --------------------------------------------------------------------------

/** Every concept's subtopic_of ancestors, transitively. Self excluded.
 *
 *  Cycle-safe by construction: the visited set terminates a loop instead of
 *  recurring forever. It has to be — `relate()` refuses new cycles, but
 *  `merge_concepts` can still build one (see README TODO), and older data predates
 *  the check entirely. */
export function ancestorClosure(edges: GraphEdge[]): Map<string, Set<string>> {
  const parents = new Map<string, string[]>()
  for (const e of edges) {
    if (e.type !== 'subtopic_of') continue   // source = child, target = parent
    const a = parents.get(e.source)
    if (a) a.push(e.target)
    else parents.set(e.source, [e.target])
  }

  const out = new Map<string, Set<string>>()
  for (const id of parents.keys()) {
    const seen = new Set<string>()
    const stack = [...(parents.get(id) ?? [])]
    while (stack.length) {
      const p = stack.pop()!
      if (seen.has(p)) continue
      seen.add(p)
      for (const g of parents.get(p) ?? []) stack.push(g)
    }
    seen.delete(id)   // a cycle can walk back around to where it started
    out.set(id, seen)
  }
  return out
}

/** The concepts a document counts toward: its tagged set, minus any concept that
 *  is an ancestor of another concept tagged on the same document.
 *
 *  A document tagged {AI Governance, Misinformation}, where Misinformation sits
 *  under AI Governance, counts toward Misinformation ONLY. That is what makes a
 *  parent's number mean "documents about this and nothing more specific" — the
 *  generalist count — rather than being inflated by every paper filed beneath it.
 *
 *  Derived, never trusted: nothing in the UI stops a curator ticking both levels,
 *  and nothing on the document could stay correct anyway, since re-parenting a
 *  concept changes this answer without touching the document. */
export function terminalConcepts(
  tagged: string[], ancestors: Map<string, Set<string>>,
): string[] {
  const kept = tagged.filter(
    (c) => !tagged.some((o) => o !== c && ancestors.get(o)?.has(c)),
  )
  // A subtopic_of cycle makes two concepts mutually ancestral, which would prune
  // BOTH and drop the document out of every row. A bad edge must not make
  // documents disappear — the rule ontologyTable.ts already applies to concepts.
  return kept.length > 0 ? kept : tagged
}

// --------------------------------------------------------------------------
// Axes
// --------------------------------------------------------------------------

/** concept × concept: a co-occurrence matrix. The curator-assertion overlay that
 *  used to sit on top of it is UNDER CONSTRUCTION — see PivotCell.related.
 *
 *  Columns are every concept, not just the ones something has been said about. That
 *  is the whole point: the finding worth having is a pair whose documents keep
 *  co-occurring that nobody has written about, and selecting columns by what has
 *  been written would hide exactly that. It held for `relates_to` edges and holds
 *  unchanged for artifacts. */
function buildConcept(
  concepts: GraphNode[],
  terminals: Map<string, string[]>,
  rowDocs: Map<string, string[]>,
  ancestors: Map<string, Set<string>>,
  _edges: GraphEdge[],
): Built {
  const pairs = new Map<string, string[]>()
  for (const [doc, ts] of terminals) {
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) push(pairs, pairKey(ts[i], ts[j]), doc)
    }
  }

  const cells = new Map<string, PivotCell>()
  const heatCounts: number[] = []
  for (const a of concepts) {
    for (const b of concepts) {
      if (a.id === b.id) {
        const docs = rowDocs.get(a.id) ?? []
        cells.set(cellKey(a.id, b.id), { kind: 'self', documentIds: docs, count: docs.length })
        continue
      }
      // Ancestry is a shadow diagonal spreading through the matrix — not just the
      // literal one. A root concept is an ancestor of everything below it, so with
      // a single root its entire row is containment.
      const deeper = ancestors.get(a.id)?.has(b.id) ? a.id
        : ancestors.get(b.id)?.has(a.id) ? b.id
        : null
      if (deeper) {
        const docs = rowDocs.get(deeper) ?? []
        cells.set(cellKey(a.id, b.id), {
          kind: 'containment', documentIds: docs, count: docs.length,
        })
        continue
      }
      const docs = pairs.get(pairKey(a.id, b.id)) ?? []
      cells.set(cellKey(a.id, b.id), {
        kind: 'intersection', documentIds: docs, count: docs.length,
        // related: <the artifact overlay goes here> — see PivotCell.related.
      })
      // Each unordered pair once: the matrix is symmetric, and counting both
      // halves would just double every rank without changing any of them.
      if (a.id < b.id) heatCounts.push(docs.length)
    }
  }

  const columns = concepts.map((c) => ({
    id: c.id, label: c.label, total: (rowDocs.get(c.id) ?? []).length,
  }))
  // A concept column's documents are the concept's own — the same set its row
  // marginal counts, since the matrix is symmetric.
  const columnDocs = new Map(concepts.map((c) => [c.id, rowDocs.get(c.id) ?? []]))
  return { columns: sortByTotal(columns), cells, heatCounts, columnDocs }
}

/** concept × person: `concept <-about- document -authored_by-> person`.
 *  The document in the middle is the junction and the cell. */
function buildAuthoredBy(
  nodes: Map<string, GraphNode>,
  terminals: Map<string, string[]>,
  authors: Map<string, string[]>,
): Built {
  const cellDocs = new Map<string, string[]>()
  const columnDocs = new Map<string, Set<string>>()

  for (const [doc, ts] of terminals) {
    for (const p of authors.get(doc) ?? []) {
      for (const c of ts) push(cellDocs, cellKey(c, p), doc)
      let set = columnDocs.get(p)
      if (!set) columnDocs.set(p, (set = new Set()))
      // Only counts toward the column if the document lands in some row at all.
      if (ts.length > 0) set.add(doc)
    }
  }

  const cells = new Map<string, PivotCell>()
  const heatCounts: number[] = []
  for (const [k, docs] of cellDocs) {
    cells.set(k, { kind: 'intersection', documentIds: docs, count: docs.length })
    heatCounts.push(docs.length)
  }

  const columns: PivotColumn[] = []
  const colDocs = new Map<string, string[]>()
  for (const [pid, docs] of columnDocs) {
    const n = nodes.get(pid)
    if (!n) continue
    columns.push({ id: pid, label: n.label, total: docs.size })
    colDocs.set(pid, [...docs])
  }
  return { columns: sortByTotal(columns), cells, heatCounts, columnDocs: colDocs }
}

// --------------------------------------------------------------------------

export class Pivot {
  readonly columns: PivotColumn[]
  /** Every INTERSECTION cell's count, for palette.heatScale to rank against — the
   *  distribution, not a maximum, because a max-normalized scale lets one outlier
   *  flatten the tail where the findings are.
   *
   *  Intersections only. Containment cells are marginals rather than
   *  intersections and run systematically larger, so letting them into the ranking
   *  would spend the ramp on a quantity that is tautological. */
  readonly heatCounts: number[]

  private readonly cells: Map<string, PivotCell>
  private readonly rowDocs: Map<string, string[]>
  private readonly colDocs: Map<string, string[]>

  constructor(graph: FullGraph, readonly axis: AxisKey) {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
    const ancestors = ancestorClosure(graph.edges)

    const tagged = new Map<string, string[]>()
    const authors = new Map<string, string[]>()
    for (const e of graph.edges) {
      if (e.type === 'about') push(tagged, e.source, e.target)
      else if (e.type === 'authored_by') push(authors, e.source, e.target)
    }

    const terminals = new Map<string, string[]>()
    for (const [doc, cs] of tagged) terminals.set(doc, terminalConcepts(cs, ancestors))

    // Row marginals: the documents counting toward each concept. Identical on every
    // axis — it's the concept's document count, not a sum of its cells (a document
    // with one terminal concept fattens a marginal while filling no cell at all).
    const rowDocs = new Map<string, string[]>()
    for (const [doc, ts] of terminals) for (const c of ts) push(rowDocs, c, doc)
    this.rowDocs = rowDocs

    const built: Built =
      axis === 'concept'
        ? buildConcept(graph.nodes.filter((n) => n.type === 'concept'),
                       terminals, rowDocs, ancestors, graph.edges)
      : axis === 'authored_by'
        ? buildAuthoredBy(nodes, terminals, authors)
      // `funds` isn't modelled yet: the route from a concept to a funder is a union
      // of two paths (fund the author, or fund an org the author sits in), which is
      // a modelling decision rather than a rendering one. An empty tab beats a
      // confidently wrong one.
        : { columns: [], cells: new Map(), heatCounts: [], columnDocs: new Map() }

    this.columns = built.columns
    this.cells = built.cells
    this.heatCounts = built.heatCounts
    this.colDocs = built.columnDocs
  }

  /** The cell at (row concept, column node), or null if there is none. */
  cell(conceptId: string, columnId: string): PivotCell | null {
    return this.cells.get(cellKey(conceptId, columnId)) ?? null
  }

  /** Documents counting toward this concept — the row marginal. */
  rowTotal(conceptId: string): number {
    return (this.rowDocs.get(conceptId) ?? []).length
  }

  /** Every document under a column, across all rows — what its marginal counts.
   *  Not the union of its cells: a document with a single terminal concept fattens
   *  a marginal while filling no cell at all. */
  columnDocuments(columnId: string): string[] {
    return this.colDocs.get(columnId) ?? []
  }
}

function sortByTotal(cols: PivotColumn[]): PivotColumn[] {
  // Fattest first, so the frontier — an empty cell between two fat marginals —
  // shows up in the top-left where the eye already is.
  return cols.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
}

function push<T>(m: Map<string, T[]>, k: string, v: T) {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}
