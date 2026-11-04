// @vitest-environment jsdom
//
// What the curator app SENDS while a document is in the review queue.
//
// The rule these pin: a document in the review queue writes no nodes and no edges
// until Save is pressed. Ingestion stopped creating `person` nodes for exactly this
// reason -- 1022 of 1037 in the sandbox had no live edge at all, because candidates
// wrote to the graph before anyone reviewed them -- and the browser is the remaining
// place that rule can be broken, since only the browser decides whether a button
// press calls the API now or waits.
//
// Correcting the document's own scraped fields is deliberately exempt: the title,
// and the publication and date, each write immediately, because fixing bad metadata
// should not require deciding whether the document has been reviewed. Those add no
// node and no edge, and the last test pins them so the blanket assertion in the
// first can't quietly swallow the exception.
//
// Queries are scoped to `.left-bottom`, the document panel. The ontology table on
// the right lists the same concepts as buttons, so an unscoped query for a concept
// name matches both and fails on ambiguity rather than on behaviour.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import {
  installFakeServer, installBroadcastChannel, queuedDocument, conceptNode,
  personNode, type FakeServer,
} from './testHarness'

const MEMORY = conceptNode('concept-memory', 'Memory')
const ATTENTION = conceptNode('concept-attention', 'Attention')
const JANE = personNode('person-jane', 'Jane Doe')
// Not among the scraped names, so she is NOT already a chip -- which is what makes
// her usable for the "add someone already in the graph" step.
const BADDELEY = personNode('person-baddeley', 'Alan Baddeley')

/** A queued document with one scraped author already in the graph, one that isn't,
 *  and one concept proposal. Every path these tests walk starts here. */
function setUp() {
  const doc = queuedDocument({
    author_proposals: [
      { name: 'Jane Doe', orcid: null,
        match: { id: JANE.id, label: JANE.label, kind: 'person', via: 'name' } },
      { name: 'Sridevi C M', orcid: null, match: null },
    ],
    proposals: [{ id: MEMORY.id, label: MEMORY.label }],
  })
  return installFakeServer({
    queue: [doc],
    documents: { [doc.id]: doc },
    graphNodes: [MEMORY, ATTENTION, JANE, BADDELEY],
    ontologyNodes: [MEMORY, ATTENTION],
  })
}

let container: HTMLElement

/** The document panel -- metadata, authors, concepts, Save. */
const panel = () => within(container.querySelector('.left-bottom') as HTMLElement)

/** Click the document in the review queue and wait for it to be seeded. Nothing is
 *  open at page load -- the queue is a list you pick from. */
async function openTheDocument(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTitle(/A Paper About Cognitive Atrophy/))
  await screen.findByRole('heading', { name: /A Paper About Cognitive Atrophy/ })
  // The unmatched scraped author renders as a NEW chip; its presence means the
  // author proposals have been folded in and the panel is ready.
  await panel().findByText('Sridevi C M')
}

describe('a document in the review queue', () => {
  let server: FakeServer

  beforeEach(() => {
    installBroadcastChannel()
    server = setUp()
  })

  it('writes nothing until Save is pressed', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    server.reset()   // ignore the page-load reads; assert only about the gestures

    // Add an `authored_by` for someone already in the graph, then take it off again.
    await user.type(panel().getByPlaceholderText(/Search people and organizations/),
                    'Baddeley')
    await user.click(await panel().findByRole('button', { name: /Alan Baddeley/ }))
    const person = panel().getByText('Alan Baddeley').closest('.chip') as HTMLElement
    await user.click(within(person).getByTitle('Remove'))

    // Type an author who is NOT in the graph and complete the dialog box. "Done",
    // not "Create person": it stages the name and writes nothing, exactly as it
    // does for a scraped one.
    await user.type(panel().getByPlaceholderText(/Search people and organizations/),
                    'Barbara Tversky')
    await user.click(await panel().findByRole('button', { name: /New author/ }))
    await user.click(await screen.findByRole('button', { name: 'Done' }))

    // Open the NEW chip the scrape produced and change what it will be created as.
    await user.click(panel().getByText('Sridevi C M'))
    await user.click(await screen.findByRole('button', { name: 'Organization' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    // Accept one concept proposal, then assign another concept by hand and remove it.
    await user.click(panel().getByTitle('Accept this concept'))
    await user.type(panel().getByPlaceholderText(/Search concepts to assign/), 'Atten')
    await user.click(await panel().findByRole('button', { name: 'Attention' }))
    const concept = panel().getByText('Attention').closest('.chip') as HTMLElement
    await user.click(within(concept).getByTitle('Remove'))

    expect(server.writes).toEqual([])
  })

  it('leaves nothing behind when the document is abandoned', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    server.reset()

    // Type a new author and complete the dialog box, then walk away from the
    // document without saving. This is the shape that left 1022 `person` nodes
    // with no `authored_by` edge: a node created for a candidate nobody accepted.
    await user.type(panel().getByPlaceholderText(/Search people and organizations/),
                    'Barbara Tversky')
    await user.click(await panel().findByRole('button', { name: /New author/ }))
    await user.click(await screen.findByRole('button', { name: 'Done' }))

    expect(server.writes.filter((r) => r.path === '/people')).toEqual([])
    expect(server.writes.filter((r) => r.path === '/organizations')).toEqual([])
  })

  it('sends the whole decision on Save, concepts last', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)

    await user.type(panel().getByPlaceholderText(/Write the curator summary/),
                    'It says something about memory.')
    await user.click(panel().getByTitle('Accept this concept'))  // Save needs one
    server.reset()
    await user.click(panel().getByRole('button', { name: 'Save' }))

    await screen.findByTitle(/Show the documents awaiting review/)
    const writes = server.writes.map((w) => `${w.method} ${w.path}`)

    // The order is load-bearing, not incidental: `PUT .../concepts` is what sets
    // `status` to `reviewed` and takes the document out of the review queue, so
    // everything else has to already be written when it lands.
    expect(writes).toEqual([
      'PATCH /documents/doc-1/summary',
      'POST /people',                       // the NEW chip, created at the last moment
      'PUT /documents/doc-1/authors',
      'PUT /documents/doc-1/concepts',
    ])

    // The person created during Save is credited alongside the one who already
    // existed -- an id the panel never saw until this moment.
    const authors = server.writes.find((w) => w.path.endsWith('/authors'))!
    expect(authors.body.author_ids).toContain(JANE.id)
    expect(authors.body.author_ids).toContain('person-created-1')

    // Concept proposals are NOT sent back. Save consumes every one of them
    // server-side, so there is nothing for the client to reconcile.
    const concepts = server.writes.find((w) => w.path.endsWith('/concepts'))!
    expect(concepts.body).toEqual({ concept_ids: [MEMORY.id] })
  })

  // The summary is markdown read by the same renderer a remark's prose goes through,
  // citations included — so it needs the same ⌘K, for the reason every citation UI
  // exists: the token carries a uuid, and nobody types a uuid by hand.
  it('wraps a selection in the summary in a citation, and only on Save', async () => {
    const user = userEvent.setup()
    server = setUp()
    server.state.linkHits = [
      { id: 'doc-cited', type: 'document', label: 'Working Memory Revisited' },
    ]
    container = render(<App />).container
    await openTheDocument(user)

    const box = panel().getByPlaceholderText(/Write the curator summary/) as HTMLTextAreaElement
    await user.type(box, 'It leans on earlier work.')
    // Select "earlier work" — the anchor. userEvent has no drag-select, and the
    // component reads the selection off the element, so setting it is the gesture.
    const start = 'It leans on '.length
    box.setSelectionRange(start, start + 'earlier work'.length)
    server.reset()
    await user.keyboard('{Meta>}k{/Meta}')

    // The dialog names the words being anchored, so the curator can see the link
    // won't rewrite their sentence.
    expect(await screen.findByText(/Link “/)).toBeTruthy()
    await user.type(screen.getByPlaceholderText(/Search by title, author, or venue/), 'Working')
    await user.click(await screen.findByRole('button', { name: /Working Memory Revisited/ }))

    expect(box.value).toBe('It leans on [earlier work](node:doc-cited).')
    // Picking a document is an EDIT, not a write: searching the corpus is the only
    // thing that reached the server, and the citation lands with the summary at Save.
    expect(server.writes).toEqual([])

    await user.click(panel().getByTitle('Accept this concept'))   // Save needs one
    await user.click(panel().getByRole('button', { name: 'Save' }))
    const written = server.writes.find((w) => w.path === '/documents/doc-1/summary')!
    expect(written.body.summary).toBe('It leans on [earlier work](node:doc-cited).')
  })

  it('renders author proposals from the server, never from the scraped names', async () => {
    // A document that has left the review queue comes back with `author_proposals`
    // empty -- `_author_proposals` reads `proposed_author_names`, which Save emptied,
    // and that is pinned in tests/test_proposal_decisions.py. What this pins is the
    // client half: `App.seedCredits` must read that list and not fall back to
    // `attributes.authors_scraped`, which is permanent and still holds the name.
    // Doing so is what put a NEW chip on an approved document.
    const doc = queuedDocument({
      id: 'doc-reviewed',
      label: 'A Filed Paper',
      attributes: {
        title: 'A Filed Paper', status: 'reviewed', summary: 'Filed.',
        abstract: 'An abstract.', canonical_url: 'https://example.org/filed',
        no_named_author: false,
        authors_scraped: [{ name: 'Sridevi C M', orcid: null }],
      },
      author_proposals: [],
      proposals: [],
      concepts: [{ id: MEMORY.id, label: MEMORY.label }],
    })
    server = installFakeServer({
      queue: [doc], documents: { [doc.id]: doc },
      graphNodes: [MEMORY], ontologyNodes: [MEMORY],
    })

    const user = userEvent.setup()
    container = render(<App />).container
    await user.click(await screen.findByTitle(/A Filed Paper/))
    await screen.findByRole('heading', { name: /A Filed Paper/ })

    expect(panel().queryByText('Sridevi C M')).toBeNull()
    expect(panel().queryByText(/NEW/)).toBeNull()
  })

  it('does not say "None yet" beside a NEW chip', async () => {
    // The empty-state message counted only saved `authored_by` edges, so a document
    // whose only author was an uncreated NEW chip rendered the chip and a message
    // denying it existed, side by side.
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)

    expect(panel().getByText('Sridevi C M')).toBeTruthy()
    // Exact: the concepts section below has its own, differently-worded empty state
    // ("None yet — search above to assign."), and none are assigned here either.
    expect(panel().queryByText('None yet — search above.')).toBeNull()
  })

  it('still saves the title and the metadata on their own', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    server.reset()

    // These are the deliberate exceptions to "nothing writes before Save": they
    // rewrite attributes on a document node that already exists, adding no node and
    // no edge, and correcting a bad scrape shouldn't force a review decision.
    const titleInput = panel().getByDisplayValue('A Paper About Cognitive Atrophy') as HTMLInputElement
    await user.click(titleInput)
    await user.clear(titleInput)
    await user.type(titleInput, 'Updated!')
    await user.tab()
    await panel().findByDisplayValue('Updated!')

    await user.type(panel().getByPlaceholderText(/e.g. Nature, arXiv/), 'Nature')
    await user.click(panel().getByRole('button', { name: /Save publication & date/ }))

    const writes = server.writes.map((w) => `${w.method} ${w.path}`)
    expect(writes).toContain('PATCH /documents/doc-1/title')
    expect(writes).toContain('PATCH /documents/doc-1/metadata')
    // Neither one files the document.
    expect(writes).not.toContain('PUT /documents/doc-1/concepts')
    expect(writes).not.toContain('PUT /documents/doc-1/authors')
  })

  // -- dismissing it, and why ----------------------------------------------
  //
  // A rejected document is the one review outcome that leaves nothing to look at:
  // it goes out of the queue and out of the graph. The reason travels with the
  // delete so the dismissal report can say why. It is taken from the Summary box
  // rather than a field of its own -- a document being thrown out has no summary
  // worth keeping, so the box is free.

  /** Type a reason, press Delete, and confirm in the dialog. Returns the dialog
   *  contents as they were BEFORE confirming, which is where the reason is echoed. */
  async function dismissTheDocument(user: ReturnType<typeof userEvent.setup>,
                                    reason?: string) {
    if (reason !== undefined) {
      await user.type(panel().getByPlaceholderText(/Write the curator summary/), reason)
    }
    await user.click(panel().getByRole('button', { name: 'Delete document' }))
    const dialog = within(await screen.findByRole('dialog'))
    const shown = dialog.queryByText(/Reason recorded/)?.textContent
      ?? dialog.getByText(/No reason given/).textContent ?? ''
    // The confirm button carries the same name as the one that opened the dialog,
    // so this has to be scoped or it clicks the opener again.
    await user.click(dialog.getByRole('button', { name: 'Delete document' }))
    await screen.findByText(/No document selected/)
    return shown
  }

  it('sends what was typed in the Summary box as the reason', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    server.reset()

    const shown = await dismissTheDocument(user, 'paywalled')

    // Echoed back before it goes through: the Summary box is not an obvious place
    // for a reason, so the dialog has to say what it is about to keep.
    expect(shown).toContain('paywalled')
    expect(server.writes).toEqual([
      { method: 'DELETE', path: '/documents/doc-1', body: { note: 'paywalled' } },
    ])
  })

  it('dismisses with no reason when nothing was typed', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    server.reset()

    const shown = await dismissTheDocument(user)

    // The reason is optional: a dismissal nobody explained is still a dismissal.
    expect(shown).toMatch(/No reason given/)
    expect(server.writes).toEqual([
      { method: 'DELETE', path: '/documents/doc-1', body: { note: '' } },
    ])
  })

  it('does not re-file an already-saved summary as the reason', async () => {
    const user = userEvent.setup()
    installBroadcastChannel()
    // A document that was reviewed and summarised, then deleted later. Its summary
    // is what the document SAYS; sending it as the reason it was rejected would put
    // the paper's own description on its tombstone.
    const doc = queuedDocument({
      attributes: { ...queuedDocument().attributes,
                    summary: 'A careful study of attention span.' },
    })
    server = installFakeServer({ queue: [doc], documents: { [doc.id]: doc },
                                graphNodes: [MEMORY], ontologyNodes: [MEMORY] })
    container = render(<App />).container
    await user.click(await screen.findByTitle(/A Paper About Cognitive Atrophy/))
    await panel().findByDisplayValue(/A careful study/)
    server.reset()

    const shown = await dismissTheDocument(user)

    expect(shown).toMatch(/No reason given/)
    expect(server.writes).toEqual([
      { method: 'DELETE', path: '/documents/doc-1', body: { note: '' } },
    ])
  })
})
