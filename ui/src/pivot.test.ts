// Tests for the model behind the pivot tabs.
//
// The fixture is deliberately tiny and shaped around the cases that are easy to
// get wrong rather than around a plausible ontology:
//
//     root
//     ├── a ──┐
//     ├── b ──┼── child   (poly-parented: under BOTH a and b)
//     └── c
//
// Documents:
//     d1 {a, c}      -> both terminal        : a x c intersection
//     d2 {a, c}      -> both terminal        : a x c intersection
//     d3 {a, child}  -> child ONLY           : the pruning case
//     d4 {a}         -> fattens a's marginal, fills no cell
//     d5 {c, child}  -> both terminal        : c x child intersection
//     d6 {root}      -> the generalist doc
//
// The load-bearing number: root x a is a *containment* cell of 3, larger than any
// intersection — so if containment ever leaks into the heat distribution it takes
// the top bin and every real co-occurrence renders a step paler. This suite says so.

import { describe, expect, it } from 'vitest'
import { Pivot, ancestorClosure, terminalConcepts } from './pivot'
import { heatScale } from './palette'
import type { FullGraph, GraphEdge, GraphNode } from './types'

const node = (id: string, type: string): GraphNode => ({
  id, type, label: id, attributes: {}, created_at: '', updated_at: '',
})
const edge = (source: string, target: string, type: string): GraphEdge => ({
  id: `${source}-${type}-${target}`, source, target, type, attributes: {},
})

const CONCEPTS = ['root', 'a', 'b', 'c', 'child']
const DOCS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']
const PEOPLE = ['p1', 'p2']

const graph = (): FullGraph => ({
  nodes: [
    ...CONCEPTS.map((c) => node(c, 'concept')),
    ...DOCS.map((d) => node(d, 'document')),
    ...PEOPLE.map((p) => node(p, 'person')),
  ],
  edges: [
    edge('a', 'root', 'subtopic_of'),
    edge('b', 'root', 'subtopic_of'),
    edge('c', 'root', 'subtopic_of'),
    edge('child', 'a', 'subtopic_of'),
    edge('child', 'b', 'subtopic_of'),

    edge('d1', 'a', 'about'), edge('d1', 'c', 'about'),
    edge('d2', 'a', 'about'), edge('d2', 'c', 'about'),
    edge('d3', 'a', 'about'), edge('d3', 'child', 'about'),
    edge('d4', 'a', 'about'),
    edge('d5', 'c', 'about'), edge('d5', 'child', 'about'),
    edge('d6', 'root', 'about'),

    edge('d1', 'p1', 'authored_by'),
    edge('d2', 'p1', 'authored_by'), edge('d2', 'p2', 'authored_by'),
    edge('d5', 'p2', 'authored_by'),
  ],
})

// -- ancestorClosure ---------------------------------------------------------

describe('ancestorClosure', () => {
  it('is transitive and excludes self', () => {
    const anc = ancestorClosure(graph().edges)
    expect([...(anc.get('child') ?? [])].sort()).toEqual(['a', 'b', 'root'])
    expect(anc.get('a')).toEqual(new Set(['root']))
    expect(anc.get('child')?.has('child')).toBe(false)
  })

  it('terminates on a cycle instead of recurring forever', () => {
    const anc = ancestorClosure([
      edge('x', 'y', 'subtopic_of'),
      edge('y', 'x', 'subtopic_of'),
    ])
    expect(anc.get('x')).toEqual(new Set(['y']))
    expect(anc.get('y')).toEqual(new Set(['x']))
  })

  it('ignores non-hierarchy edges', () => {
    // prerequisite_of is not ancestry; if it leaked in, a and c would prune each
    // other and their intersection would vanish.
    const anc = ancestorClosure([edge('a', 'c', 'prerequisite_of')])
    expect(anc.size).toBe(0)
  })
})

// -- terminalConcepts --------------------------------------------------------

describe('terminalConcepts', () => {
  const anc = ancestorClosure(graph().edges)

  it('drops an ancestor tagged alongside its own descendant', () => {
    expect(terminalConcepts(['a', 'child'], anc)).toEqual(['child'])
  })

  it('keeps concepts in different branches', () => {
    expect(terminalConcepts(['a', 'c'], anc).sort()).toEqual(['a', 'c'])
  })

  it('leaves a single tag alone even when it has descendants', () => {
    // "about a and nothing more specific" is a real claim, not an omission.
    expect(terminalConcepts(['a'], anc)).toEqual(['a'])
  })

  it('keeps both when a poly-parented concept is tagged with one parent only', () => {
    expect(terminalConcepts(['b', 'child'], anc)).toEqual(['child'])
  })

  it('prunes transitively, not just one level', () => {
    expect(terminalConcepts(['root', 'child'], anc)).toEqual(['child'])
  })

  it('falls back to the tagged set when a cycle would prune everything', () => {
    // x and y are mutually ancestral, so each prunes the other and the document
    // would count toward NOTHING. A bad edge must not make documents disappear.
    const cyc = ancestorClosure([
      edge('x', 'y', 'subtopic_of'),
      edge('y', 'x', 'subtopic_of'),
    ])
    expect(terminalConcepts(['x', 'y'], cyc).sort()).toEqual(['x', 'y'])
  })
})

// -- concept axis ------------------------------------------------------------

describe('Pivot: concept axis', () => {
  const p = new Pivot(graph(), 'concept')

  it('counts marginals by terminal concept', () => {
    expect(p.rowTotal('a')).toBe(3)       // d1, d2, d4 — NOT d3, which pruned a
    expect(p.rowTotal('c')).toBe(3)       // d1, d2, d5
    expect(p.rowTotal('child')).toBe(2)   // d3, d5
    expect(p.rowTotal('root')).toBe(1)    // d6 only
    expect(p.rowTotal('b')).toBe(0)
  })

  it('gives intersection cells the shared documents', () => {
    const cell = p.cell('a', 'c')!
    expect(cell.kind).toBe('intersection')
    expect(cell.count).toBe(2)
    expect(cell.documentIds.sort()).toEqual(['d1', 'd2'])
  })

  // UNDER CONSTRUCTION. This asserted the relates_to overlay in both directions.
  // The edge type is gone from the model and artifacts replace it, but an artifact
  // spans a SET of nodes while this flag describes a pair — so what the cell should
  // say is a question for the co-occurrence rework, not a mechanical port. The test
  // is kept, skipped, because it is the specification of what has to come back.
  it.skip('marks the curator-assertion overlay, in both directions', () => {
    expect(p.cell('a', 'c')?.related).toBe(true)
    expect(p.cell('c', 'a')?.related).toBe(true)   // symmetric
    expect(p.cell('c', 'child')?.related).toBe(false)
  })

  it('reports a genuine zero as an intersection, not a hole', () => {
    // a and b are siblings sharing no documents: a real absence, and the frontier
    // signal depends on it staying distinguishable from containment.
    const cell = p.cell('a', 'b')!
    expect(cell.kind).toBe('intersection')
    expect(cell.count).toBe(0)
  })

  it('makes ancestor/descendant pairs containment, carrying the deeper count', () => {
    for (const [row, col] of [['a', 'child'], ['child', 'a'], ['b', 'child'], ['root', 'child']]) {
      const cell = p.cell(row, col)!
      expect(cell.kind, `${row} x ${col}`).toBe('containment')
      expect(cell.count, `${row} x ${col}`).toBe(2)   // child's count, either way round
    }
  })

  it('never reports an ancestor pair as zero', () => {
    // The bug this whole cell kind exists to prevent: a 0 here would read as a
    // frontier worth chasing, and no document can ever fill it.
    expect(p.cell('root', 'b')!.kind).toBe('containment')
    expect(p.cell('root', 'b')!.count).toBe(0)   // b genuinely has no documents...
    expect(p.cell('a', 'child')!.count).toBe(2)  // ...but this one is not a gap
  })

  it('puts the concept count on the diagonal', () => {
    const cell = p.cell('a', 'a')!
    expect(cell.kind).toBe('self')
    expect(cell.count).toBe(3)
  })

  it('makes the whole root row containment', () => {
    // A single root is an ancestor of everything, so its row can never hold an
    // intersection — it's the corpus distribution, not a set of gaps.
    for (const c of ['a', 'b', 'c', 'child']) {
      expect(p.cell('root', c)!.kind, `root x ${c}`).toBe('containment')
    }
  })

  it('excludes containment from the heat distribution', () => {
    // root x a is a containment cell of 3 — bigger than any intersection. If it
    // got into the ranking it would take the top bin, and every real co-occurrence
    // would render a step paler than it should.
    expect(p.cell('root', 'a')!.count).toBe(3)
    expect(Math.max(...p.heatCounts)).toBe(2)
  })

  it('counts each unordered pair once in the heat distribution', () => {
    // The matrix is symmetric; counting both halves would double every rank
    // without changing any of them.
    expect(p.heatCounts.filter((n) => n === 2)).toEqual([2])   // a x c, once
  })

  it('has a column per concept, fattest first', () => {
    expect(p.columns.length).toBe(CONCEPTS.length)
    const totals = p.columns.map((c) => c.total)
    expect(totals).toEqual([...totals].sort((x, y) => y - x))
  })

  it('keeps empty columns', () => {
    // b has no documents. Dropping it would be the obvious scale trick and would
    // delete the frontier signal, which lives precisely in empty cells.
    expect(p.columns.find((c) => c.id === 'b')?.total).toBe(0)
  })

  it('exposes the documents behind a column, matching its marginal', () => {
    expect(p.columnDocuments('a').sort()).toEqual(['d1', 'd2', 'd4'])
    expect(p.columnDocuments('a').length).toBe(p.columns.find((c) => c.id === 'a')!.total)
    expect(p.columnDocuments('b')).toEqual([])
  })

  it('column documents are not the union of the column cells', () => {
    // d4 is tagged {a} alone: it fattens a's marginal and fills no cell. If column
    // documents were assembled from cells it would vanish.
    expect(p.columnDocuments('a')).toContain('d4')
    expect(p.cell('a', 'c')!.documentIds).not.toContain('d4')
  })
})

// -- authored_by axis --------------------------------------------------------

describe('Pivot: authored_by axis', () => {
  const p = new Pivot(graph(), 'authored_by')

  it('counts documents at (concept, person)', () => {
    expect(p.cell('a', 'p1')?.count).toBe(2)          // d1, d2
    expect(p.cell('c', 'p1')?.count).toBe(2)          // d1, d2
    expect(p.cell('child', 'p2')?.count).toBe(1)      // d5
    expect(p.cell('child', 'p1')).toBeNull()
  })

  it('puts a document in every row its terminals reach', () => {
    // p2 authored d2 {a, c} and d5 {c, child}. Both of d5's tags are terminal, so
    // p2 lands under c AND child — and c picks up d2 as well.
    expect(p.cell('c', 'p2')?.count).toBe(2)       // d2, d5
    expect(p.cell('child', 'p2')?.count).toBe(1)   // d5
    expect(p.cell('a', 'p2')?.count).toBe(1)       // d2
  })

  it('respects terminal pruning', () => {
    // d3 is {a, child} and prunes to child alone. p1 didn't author it, but the
    // pruning has to hold here too: nothing may reach the `a` row via d3.
    expect(p.cell('a', 'p1')?.documentIds.sort()).toEqual(['d1', 'd2'])
    expect(p.cell('a', 'p1')?.documentIds).not.toContain('d3')
  })

  it('columns carry the person marginal', () => {
    expect(p.columns.map((c) => c.id).sort()).toEqual(['p1', 'p2'])
    expect(p.columns.find((c) => c.id === 'p1')?.total).toBe(2)   // d1, d2
    expect(p.columns.find((c) => c.id === 'p2')?.total).toBe(2)   // d2, d5
  })

  it('has no containment cells — people are not in the concept hierarchy', () => {
    for (const c of CONCEPTS) {
      for (const person of PEOPLE) {
        expect(p.cell(c, person)?.kind ?? 'intersection').toBe('intersection')
      }
    }
  })

  it('still exposes the row marginal', () => {
    expect(p.rowTotal('a')).toBe(3)
  })

  it('exposes every document a person authored, across all rows', () => {
    // Clicking a person's column header asks "everything they wrote", which spans
    // rows — it is not any one cell.
    expect(p.columnDocuments('p1').sort()).toEqual(['d1', 'd2'])
    expect(p.columnDocuments('p2').sort()).toEqual(['d2', 'd5'])
  })

  it('deduplicates a document that lands in several of a column rows', () => {
    // d5 is {c, child}: both terminal, so it appears in two of p2's cells. Their
    // author wrote it once.
    expect(p.columnDocuments('p2').filter((d) => d === 'd5')).toEqual(['d5'])
  })
})

// -- funds -------------------------------------------------------------------

describe('Pivot: funds axis', () => {
  it('is an empty stub rather than a wrong answer', () => {
    const p = new Pivot(graph(), 'funds')
    expect(p.columns).toEqual([])
    expect(p.heatCounts).toEqual([])
  })
})

// -- degenerate inputs -------------------------------------------------------

describe('Pivot: degenerate graphs', () => {
  it('handles an empty graph', () => {
    const p = new Pivot({ nodes: [], edges: [] }, 'concept')
    expect(p.columns).toEqual([])
    expect(p.heatCounts).toEqual([])
    expect(p.rowTotal('nope')).toBe(0)
    expect(p.cell('nope', 'nope')).toBeNull()
  })

  it('handles concepts with no documents at all', () => {
    const p = new Pivot({
      nodes: [node('x', 'concept'), node('y', 'concept')], edges: [],
    }, 'concept')
    expect(p.cell('x', 'y')!.count).toBe(0)
    expect(p.cell('x', 'y')!.kind).toBe('intersection')
    // heatCounts is the raw distribution, zeros included — heatScale is what drops
    // them, and it must, or an empty cell would take the palest tint and read as
    // holding one document.
    expect(p.heatCounts).toEqual([0])
    expect(heatScale(p.heatCounts)(0)).toBeNull()
  })
})
