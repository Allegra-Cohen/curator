// @vitest-environment jsdom
//
// ⌘K: linking the guide's prose to the guide.
//
// It was a citation picker — documents only, `[anchor](doc:<id>)` — which left the
// curator unable to point at half of their own guide from their own writing. Now one
// picker serves all three editors (a document's summary, a concept's description, a
// remark's body) and offers anything with a reader surface.
//
// Two things here are easy to break and expensive to notice:
//
//   * WHAT THE TOKEN SAYS. It carries an id and no type (see links.ts), because a
//     node's type can change under it. Every insertion is asserted verbatim.
//   * WHAT THE REFERENCES BLOCK COUNTS. It is documents only — the set the server
//     turns into `cites` edges — and it flags an id that resolves to nothing. Those
//     are two different states that a type-free link makes look identical, and
//     getting it wrong reddens every concept link in the editor.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import ArtifactsPanel from './components/ArtifactsPanel'
import {
  installFakeServer, installBroadcastChannel, queuedDocument, conceptNode, remark,
  type FakeServer,
} from './testHarness'

const MEMORY = conceptNode('concept-memory', 'Memory')

let container: HTMLElement
const panel = () => within(container.querySelector('.left-bottom') as HTMLElement)
// The open picker. Scoped, because the ontology table on the right lists the same
// concepts as buttons — an unscoped query for "Memory" matches both and fails on
// ambiguity rather than on behaviour.
const picker = () => within(document.querySelector('.cite-dialog') as HTMLElement)

/** Open the queued document and select some words in its Summary box, which is what
 *  ⌘K acts on. Returns the textarea so a test can assert the token that lands in it. */
async function selectInSummary(user: ReturnType<typeof userEvent.setup>, text: string,
                               anchor: string) {
  await user.click(await screen.findByTitle(/A Paper About Cognitive Atrophy/))
  await screen.findByRole('heading', { name: /A Paper About Cognitive Atrophy/ })
  const box = panel().getByPlaceholderText(/Write the curator summary/) as HTMLTextAreaElement
  await user.type(box, text)
  const start = text.indexOf(anchor)
  // userEvent has no drag-select, and the component reads the selection off the
  // element, so setting it IS the gesture.
  box.setSelectionRange(start, start + anchor.length)
  await user.keyboard('{Meta>}k{/Meta}')
  return box
}

describe('linking from a document summary', () => {
  let server: FakeServer

  beforeEach(() => {
    installBroadcastChannel()
    const doc = queuedDocument({ proposals: [{ id: MEMORY.id, label: MEMORY.label }] })
    server = installFakeServer({
      queue: [doc], documents: { [doc.id]: doc },
      graphNodes: [MEMORY], ontologyNodes: [MEMORY],
      linkHits: [
        { id: 'concept-memory', type: 'concept', label: 'Memory' },
        { id: 'artifact-1', type: 'artifact', label: 'What I make of Literacy',
          visibility: 'private' },
        { id: 'doc-baddeley', type: 'document', label: 'A Forgettable Title',
          via: 'Alan Baddeley' },
      ],
    })
  })

  it('links a summary to a concept, with the id and no type in the token', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    const box = await selectInSummary(user, 'It bears on memory.', 'memory')

    await user.type(picker().getByPlaceholderText(/Search by title, author, or venue/), 'Mem')
    await user.click(await picker().findByRole('button', { name: /Memory/ }))

    expect(box.value).toBe('It bears on [memory](node:concept-memory).')
  })

  it('finds a paper by its author, and says that is why it is there', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    const box = await selectInSummary(user, 'It answers earlier work.', 'earlier work')

    await user.type(picker().getByPlaceholderText(/Search by title, author, or venue/),
                    'Baddeley')
    // The hit's own words are nowhere in what was typed, so the picker has to say
    // where the match came from or the result reads as a bug in the search.
    expect(await picker().findByText(/via Alan Baddeley/)).toBeTruthy()

    await user.click(picker().getByRole('button', { name: /A Forgettable Title/ }))
    expect(box.value).toBe('It answers [earlier work](node:doc-baddeley).')
  })

  it('offers an unpublished remark, and warns that readers lose the link', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    const box = await selectInSummary(user, 'As argued elsewhere.', 'elsewhere')

    await user.type(picker().getByPlaceholderText(/Search by title, author, or venue/),
                    'What I make')
    // Offered, not hidden: you write the sentence before you publish the thing it
    // points at. But a reader gets the words with no link until then.
    expect(await picker().findByText(/readers won’t see the link/)).toBeTruthy()

    await user.click(picker().getByRole('button', { name: /What I make of Literacy/ }))
    expect(box.value).toBe('As argued [elsewhere](node:artifact-1).')
  })

  it('inserts nothing until Save, like every other edit in the panel', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await selectInSummary(user, 'It bears on memory.', 'memory')
    server.reset()

    await user.type(picker().getByPlaceholderText(/Search by title, author, or venue/), 'Mem')
    await user.click(await picker().findByRole('button', { name: /Memory/ }))

    // Searching the corpus is the only thing that reached the server; the link lands
    // with the summary at Save.
    expect(server.writes).toEqual([])
  })
})

describe('the References block in the remark editor', () => {
  const DOC = { id: 'doc-1', type: 'document', label: 'Cited Paper' }
  const CONCEPT = { id: 'concept-memory', type: 'concept', label: 'Memory' }

  beforeEach(() => { installBroadcastChannel() })

  /** Open the ARTIFACTS window on one saved remark, in its editor state. */
  async function openTheRemark(user: ReturnType<typeof userEvent.setup>, r = remark()) {
    installFakeServer({ artifacts: [r] })
    render(<ArtifactsPanel />)
    await user.click(await screen.findByText(r.label))
    return within(document.querySelector('.artifact-refs') as HTMLElement)
  }

  it('lists the documents a body links to, and not the concepts', async () => {
    const user = userEvent.setup()
    const refs = await openTheRemark(user, remark({
      body: 'On [memory](node:concept-memory), as [this paper](node:doc-1) shows.',
      links: [CONCEPT, DOC],
    }))

    // References means the papers the prose rests on — the set that becomes `cites`.
    expect(refs.getByText('Cited Paper')).toBeTruthy()
    expect(refs.queryByText('Memory')).toBeNull()
    // And emphatically NOT flagged: a live concept link is a link, not a broken one.
    expect(refs.queryByText(/broken link/)).toBeNull()
  })

  it('still flags an id that resolves to nothing', async () => {
    const user = userEvent.setup()
    const refs = await openTheRemark(user, remark({
      body: '[a ghost](node:doc-gone) and [this paper](node:doc-1)',
      links: [DOC],          // the server could resolve only one of the two
    }))

    // The reason this block exists: a broken link has nothing anywhere else to appear
    // in, so dropping it would make it look like it had never been written.
    expect(refs.getByText(/broken link/)).toBeTruthy()
    expect(refs.getByText('doc-gone')).toBeTruthy()
  })
})
