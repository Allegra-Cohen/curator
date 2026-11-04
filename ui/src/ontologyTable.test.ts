// The concepts pane: an ontology flattened into one column of rows.
//
// Pure derivation, so no DOM here. The pivot COLUMNS (co-occurrence, authored_by)
// are tested in `pivot.test.ts` and are being rewritten, so nothing below reaches
// into them -- this is only the spine every tab shares.
//
// The thing worth pinning is what happens when the ontology isn't a tree, because
// nothing guarantees it is one. A concept can sit under two parents, and
// `subtopic_of` can contain a cycle. The old graph layout showed a poly-parented
// concept once, under whichever parent happened to come first, which quietly hid
// the fact that it was filed twice. This emits it under every parent instead, so
// rows are keyed by path rather than by concept id, and selection stays keyed by
// concept id so lighting one instance lights them all.

import { describe, it, expect } from 'vitest'
import { OntologyTable } from './ontologyTable'
import type { Ontology } from './types'

/** `subtopic_of` runs child -> parent: source is the child. Getting that backwards
 *  inverts the whole table, so the fixtures spell it out. */
const subtopicOf = (child: string, parent: string) =>
  ({ source: child, target: parent, type: 'subtopic_of' })

function ontology(labels: string[], edges: any[] = []): Ontology {
  return {
    nodes: labels.map((l) => ({ id: l, label: l.toUpperCase(), type: 'concept',
                                attributes: {} })),
    edges,
  } as Ontology
}

const shape = (t: OntologyTable) =>
  t.rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`)

describe('the concepts pane', () => {
  it('lists roots in the order the ontology gave them', () => {
    // Insertion order throughout, matching how the API reads. Sorting
    // alphabetically here would fight the curator's own arrangement.
    const t = new OntologyTable(ontology(['memory', 'attention', 'insight']))
    expect(shape(t)).toEqual(['MEMORY', 'ATTENTION', 'INSIGHT'])
  })

  it('nests children under their parent, deepest last', () => {
    const t = new OntologyTable(ontology(
      ['memory', 'working', 'chunking'],
      [subtopicOf('working', 'memory'), subtopicOf('chunking', 'working')]))
    expect(shape(t)).toEqual(['MEMORY', '  WORKING', '    CHUNKING'])
    expect(t.rows.map((r) => r.depth)).toEqual([0, 1, 2])
  })

  it('sorts siblings by their position in the ontology, not by name', () => {
    const t = new OntologyTable(ontology(
      ['memory', 'zebra', 'alpha'],
      [subtopicOf('zebra', 'memory'), subtopicOf('alpha', 'memory')]))
    expect(shape(t)).toEqual(['MEMORY', '  ZEBRA', '  ALPHA'])
  })

  it('shows a concept under EVERY parent it has', () => {
    // The case the old layout hid. `child` is filed under both, and a table that
    // showed it once would make one of those filings invisible.
    const t = new OntologyTable(ontology(
      ['memory', 'attention', 'child'],
      [subtopicOf('child', 'memory'), subtopicOf('child', 'attention')]))

    expect(shape(t)).toEqual(['MEMORY', '  CHILD', 'ATTENTION', '  CHILD'])
    // Two rows, one concept: keys differ, `conceptId` does not. That is what lets
    // selection stay keyed by concept and light both.
    const [a, b] = t.rowsFor('child')
    expect(a.key).not.toBe(b.key)
    expect(a.conceptId).toBe(b.conceptId)
    expect(t.isDuplicated('child')).toBe(true)
    expect(t.isDuplicated('memory')).toBe(false)
  })

  it('tells each instance where else the concept is filed', () => {
    // Without this the duplicate rows look like two different concepts that happen
    // to share a name.
    const t = new OntologyTable(ontology(
      ['memory', 'attention', 'child'],
      [subtopicOf('child', 'memory'), subtopicOf('child', 'attention')]))

    const [underMemory, underAttention] = t.rowsFor('child')
    expect(underMemory.alsoIn).toEqual(['ATTENTION'])
    expect(underAttention.alsoIn).toEqual(['MEMORY'])
    // A concept with one parent has nowhere else to be.
    expect(t.rowsFor('memory')[0].alsoIn).toEqual([])
  })

  it('carries the root colour down the whole branch', () => {
    // The rail is what makes a deep row legible as belonging to its root, so it is
    // the ROOT's hue at every depth; only the fill tint varies.
    const t = new OntologyTable(ontology(
      ['memory', 'working', 'attention'],
      [subtopicOf('working', 'memory')]))
    const [memory, working, attention] = t.rows

    expect(working.rail).toBe(memory.rail)
    expect(working.fill).not.toBe(memory.fill)
    expect(attention.rail).not.toBe(memory.rail)   // a different root, a different hue
  })

  it('keeps concepts caught in a cycle visible', () => {
    // Every member of a `subtopic_of` cycle has a parent, so none of them is a root
    // and the ordinary walk never reaches them. A bad edge must not make concepts
    // vanish from the curator's table -- that is how the bad edge gets fixed.
    const t = new OntologyTable(ontology(
      ['a', 'b'],
      [subtopicOf('a', 'b'), subtopicOf('b', 'a')]))

    expect(t.rows.length).toBeGreaterThan(0)
    expect(new Set(t.rows.map((r) => r.conceptId))).toEqual(new Set(['a', 'b']))
  })

  it('does not recur forever on a self-parented concept', () => {
    const t = new OntologyTable(ontology(['a'], [subtopicOf('a', 'a')]))
    expect(t.rows.map((r) => r.conceptId)).toEqual(['a'])
  })

  it('ignores edges pointing at concepts that are not there', () => {
    // The ontology endpoint and the graph endpoint are separate reads, so an edge
    // can outlive its endpoint by one refetch. Dropping it beats rendering a row
    // labelled with a raw id.
    const t = new OntologyTable(ontology(
      ['memory'],
      [subtopicOf('ghost', 'memory'), subtopicOf('memory', 'ghost')]))
    expect(shape(t)).toEqual(['MEMORY'])
  })

  it('degrades rather than hanging on a pathological ontology', () => {
    // Many concepts with many parents each duplicate their way into exponentially
    // many rows. The cap keeps the panel responsive, and `truncated` is how it
    // admits to the shortfall instead of quietly showing a partial table.
    const labels = Array.from({ length: 22 }, (_, i) => `c${i}`)
    const edges = []
    for (let i = 1; i < labels.length; i++)
      for (let j = 0; j < i; j++) edges.push(subtopicOf(labels[i], labels[j]))

    const t = new OntologyTable(ontology(labels, edges))
    expect(t.truncated).toBe(true)
    expect(t.rows.length).toBeLessThanOrEqual(4000)
  })

  it('reports how many roots outran the palette', () => {
    const many = Array.from({ length: 40 }, (_, i) => `root${i}`)
    const t = new OntologyTable(ontology(many))
    // Not an error -- they fall back to neutral grey -- but the panel needs to know
    // it can no longer tell those roots apart by colour.
    expect(t.uncoloredRoots).toBeGreaterThan(0)
    expect(t.rows.length).toBe(40)
  })

  it('handles an empty ontology', () => {
    const t = new OntologyTable(ontology([]))
    expect(t.rows).toEqual([])
    expect(t.truncated).toBe(false)
  })
})
