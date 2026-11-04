// @vitest-environment jsdom
//
// The concept editor, which doubles as the concept *creator*.
//
// A concept is the search unit: its `semantic_query` is the OpenAlex query and its
// `keywords` are the arXiv boolean one, so what gets typed here decides what
// discovery goes looking for. `description` is the reader's definition and searches
// for nothing -- the split is asserted below, because the whole point of it is that
// a definition can quote and cite a source without that citation text landing in a
// vector query. That is also why the keyword hint is asserted below rather
// than treated as decoration -- the comma separates ALTERNATIVE queries, each
// searched independently, and a curator who doesn't know that writes one long AND
// that matches almost nothing. A silent version of exactly that turned three
// alternative queries into one impossible conjunction and cut 623 arXiv hits to 3.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConceptPanel from './components/ConceptPanel'
import { installFakeServer, installBroadcastChannel, type FakeServer } from './testHarness'

const noop = () => {}
const props = {
  draft: null, docTitle: null, assigned: false,
  onAssign: noop, onShowDocuments: noop, onCreated: noop, onChanged: noop,
  onDirtyChange: noop, onError: noop,
}

const MEMORY = {
  concept: {
    id: 'concept-memory', label: 'Memory', type: 'concept',
    attributes: { description: 'How things are retained.',
                  semantic_query: 'Studies of human memory and retention.',
                  keywords: 'memory AND retention', criteria: 'Must study memory.' },
  },
  documents: [
    { id: 'doc-1', label: 'A Paper', type: 'document',
      attributes: { title: 'A Paper About Memory' } },
  ],
  people: [], related: [],
} as any

describe('the concept editor', () => {
  let server: FakeServer

  beforeEach(() => {
    installBroadcastChannel()
    server = installFakeServer({
      concepts: { 'concept-memory': MEMORY },
      // What the ⌘K picker searches over.
      linkHits: [{ id: 'doc-cited', type: 'document', label: 'Working Memory Revisited' }],
    })
  })

  it('loads the concept and writes nothing while it is being edited', async () => {
    const onDirty = vi.fn()
    const user = userEvent.setup()
    render(<ConceptPanel {...props} conceptId="concept-memory" onDirtyChange={onDirty} />)

    await screen.findByDisplayValue('Memory')
    expect(screen.getByDisplayValue('memory AND retention')).toBeTruthy()
    server.reset()

    await user.type(screen.getByDisplayValue('Memory'), ' and forgetting')

    expect(server.writes).toEqual([])
    // App uses this to guard a click that would swap the edit away unsaved.
    expect(onDirty).toHaveBeenLastCalledWith(true)
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })

  it('spells out that a comma separates alternative queries', async () => {
    render(<ConceptPanel {...props} conceptId="concept-memory" />)
    await screen.findByDisplayValue('Memory')

    // Not guessable from a text box that looks like any keyword list.
    expect(screen.getByText(/Comma to separate, AND\/OR\/NOT and parentheses to define/))
      .toBeTruthy()
  })

  it('saves every field in one write and tells App the label may have moved', async () => {
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(<ConceptPanel {...props} conceptId="concept-memory" onChanged={onChanged} />)
    await screen.findByDisplayValue('Memory')
    server.reset()

    await user.clear(screen.getByDisplayValue('memory AND retention'))
    await user.type(screen.getByPlaceholderText(/e.g. AI AND literacy/),
                    'memory AND retention, chunking')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('button', { name: 'Save' })
    expect(server.writes.map((w) => `${w.method} ${w.path}`))
      .toEqual(['PATCH /concepts/concept-memory'])
    expect(server.writes[0].body.keywords).toBe('memory AND retention, chunking')
    // Both text fields ride along on the one write, and stay distinct in it.
    expect(server.writes[0].body.description).toBe('How things are retained.')
    expect(server.writes[0].body.semantic_query)
      .toBe('Studies of human memory and retention.')
    // A rename moves the ontology table, every chip and every pivot row bearing it,
    // so App has to refetch rather than trust this panel's local copy.
    expect(onChanged).toHaveBeenCalled()
  })

  it('keeps the reader description and the search prose in separate boxes', async () => {
    // One field used to be both, so a citation added for the viewer went straight
    // into the OpenAlex vector query as noise. Two boxes, and only the description
    // reaches a reader.
    const user = userEvent.setup()
    render(<ConceptPanel {...props} conceptId="concept-memory" />)
    await screen.findByDisplayValue('Memory')

    const desc = screen.getByDisplayValue('How things are retained.')
    const semantic = screen.getByDisplayValue('Studies of human memory and retention.')
    expect(desc).not.toBe(semantic)
    expect(screen.getByText(/not shown to readers/)).toBeTruthy()
    server.reset()

    await user.type(desc, ' (Smith 2023)')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('button', { name: 'Save' })
    // The citation lands in the definition and nowhere near the query.
    expect(server.writes[0].body.description)
      .toBe('How things are retained. (Smith 2023)')
    expect(server.writes[0].body.semantic_query)
      .toBe('Studies of human memory and retention.')
  })

  it('cites a document from the description, and only from the description', async () => {
    // The third piece of guide prose that renders through markdown.tsx, so it gets the
    // same ⌘K the summary and remark editors have. The search box gets none: nothing
    // reads it but a vector index.
    const user = userEvent.setup()
    render(<ConceptPanel {...props} conceptId="concept-memory" />)
    await screen.findByDisplayValue('Memory')
    const desc = screen.getByDisplayValue('How things are retained.') as HTMLTextAreaElement

    expect(screen.getByText(/select text and press ⌘K to link to anything in the guide/))
      .toBeTruthy()

    // Nothing highlighted: the keystroke is swallowed, no picker.
    desc.focus()
    desc.setSelectionRange(0, 0)
    await user.keyboard('{Meta>}k{/Meta}')
    expect(screen.queryByText(/Link “/)).toBeNull()

    // "retained" highlighted: the picker opens on those words.
    desc.setSelectionRange(15, 23)
    await user.keyboard('{Meta>}k{/Meta}')
    expect(screen.getByText(/Link “/)).toBeTruthy()
    server.reset()

    await user.type(screen.getByPlaceholderText(/Search by title, author, or venue/), 'Working')
    await user.click(await screen.findByRole('button', { name: /Working Memory Revisited/ }))

    // The highlighted words survive as the anchor; the uuid is machine-written.
    expect(desc.value).toBe('How things are [retained](node:doc-cited).')
    // Not saved by the insert — a citation nobody saved must not be a citation.
    expect(server.writes).toEqual([])
  })

  it('creates nothing until Create is pressed on a new concept', async () => {
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<ConceptPanel {...props} conceptId={null} onCreated={onCreated}
                         draft={{ parentId: 'concept-memory', parentLabel: 'Memory' }} />)

    // Where in the hierarchy it will be born, said before it exists.
    expect(await screen.findByText(/Subtopic of/)).toBeTruthy()
    server.reset()

    await user.type(screen.getByPlaceholderText('Concept name…'), 'Chunking')
    await user.type(screen.getByPlaceholderText(/What this concept covers/),
                    'Grouping items to hold more of them.')
    await user.type(screen.getByPlaceholderText(/Describe the work you want found/),
                    'Research on grouping information into larger units.')
    expect(server.writes).toEqual([])
    expect(screen.getByText(/not created until you save/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(server.writes.map((w) => `${w.method} ${w.path}`)).toEqual(['POST /concepts'])
    expect(server.writes[0].body).toMatchObject({
      label: 'Chunking', parent_id: 'concept-memory',
      description: 'Grouping items to hold more of them.',
      semantic_query: 'Research on grouping information into larger units.',
    })
    expect(onCreated).toHaveBeenCalled()
  })

  it('will not create a concept with no name', async () => {
    render(<ConceptPanel {...props} conceptId={null}
                         draft={{ parentId: null, parentLabel: null }} />)
    // Substring: the context line now also carries the "Make parent of…" control,
    // so the paragraph says more than where the concept will sit.
    await screen.findByText(/New top-level concept/)

    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('sends a concept its documents rather than opening one in place', async () => {
    // The left column ends up holding the list either way, so whatever you read has
    // its siblings beside it.
    const onShow = vi.fn()
    const user = userEvent.setup()
    render(<ConceptPanel {...props} conceptId="concept-memory" onShowDocuments={onShow} />)
    await screen.findByDisplayValue('Memory')

    await user.click(screen.getByRole('button', { name: 'A Paper About Memory' }))

    expect(onShow).toHaveBeenCalledWith('Memory', MEMORY.documents, 'doc-1')
    expect(server.writes).toEqual([])
  })

  it('does not offer to assign when no document is open', async () => {
    const { rerender } = render(<ConceptPanel {...props} conceptId="concept-memory" />)
    await screen.findByDisplayValue('Memory')
    expect(screen.queryByRole('button', { name: /Assign to/ })).toBeNull()

    rerender(<ConceptPanel {...props} conceptId="concept-memory" docTitle="A Paper" />)
    expect(await screen.findByRole('button', { name: /Assign to/ })).toBeTruthy()
  })
})
