// @vitest-environment jsdom
//
// Which action tells the other windows something happened.
//
// SCOPE, SOURCES and ENTITIES each open as a separate window running its own React
// app, so they cannot see each other's state. `broadcast.ts` keeps them in step over
// a `BroadcastChannel` named `field-guide`. Nothing about that is visible to a test
// that only calls functions: the message is a side effect of a click.
//
// This is the gap that already cost something. A `notify('documents-changed')` call
// -- the one that tells an open SOURCES window a document was filed, so its accept
// rates have moved -- was written into the title-edit handler instead of the save
// handler. Correcting a typo in a title announced a review that hadn't happened, and
// actually reviewing a document announced nothing. Every test passed. It was caught
// by reading the diff.
//
// So the negative rows below carry as much weight as the positive ones: the only
// thing that could have caught that bug is an assertion that pressing "Save title"
// sends NOTHING.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import {
  installFakeServer, installBroadcastChannel, queuedDocument, conceptNode,
  personNode, type Channel, type FakeServer,
} from './testHarness'

const MEMORY = conceptNode('concept-memory', 'Memory')
const JANE = personNode('person-jane', 'Jane Doe')

let container: HTMLElement
const panel = () => within(container.querySelector('.left-bottom') as HTMLElement)

async function openTheDocument(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTitle(/A Paper About Cognitive Atrophy/))
  await screen.findByRole('heading', { name: /A Paper About Cognitive Atrophy/ })
}

describe('what the other windows are told', () => {
  let server: FakeServer
  let channel: Channel

  beforeEach(() => {
    channel = installBroadcastChannel()
    const doc = queuedDocument({ proposals: [{ id: MEMORY.id, label: MEMORY.label }] })
    server = installFakeServer({
      queue: [doc], documents: { [doc.id]: doc },
      graphNodes: [MEMORY], ontologyNodes: [MEMORY],
    })
  })

  const events = () => channel.sent.map((m) => m.event)

  it('announces a filed document when the document is saved', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    await user.click(panel().getByTitle('Accept this concept'))   // Save needs one
    channel.reset()

    await user.click(panel().getByRole('button', { name: 'Save' }))
    await screen.findByTitle(/Show the documents awaiting review/)

    // Filing a document is what turns it into evidence that a source earns its
    // keep, so an open SOURCES window is now showing a stale accept rate.
    expect(events()).toEqual(['documents-changed'])
  })

  it('announces a dismissed document', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    channel.reset()

    await user.click(panel().getByRole('button', { name: 'Delete document' }))
    // The confirm dialog's button carries the same name as the one that opened it,
    // so this has to be scoped to the dialog or it just clicks the first again.
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Delete document' }))
    await screen.findByText(/No document selected/)

    expect(events()).toEqual(['documents-changed'])
  })

  it('announces new documents when a search is run', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/A Paper About Cognitive Atrophy/)
    channel.reset()

    await user.click(screen.getByRole('button', { name: /Run search/ }))
    await screen.findByText(/Search done/)

    expect(events()).toEqual(['documents-ingested'])
  })

  it('says nothing when only the title is corrected', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    channel.reset()

    const titleInput = panel().getByDisplayValue(/A Paper About Cognitive Atrophy/) as HTMLInputElement
    await user.click(titleInput)
    await user.clear(titleInput)
    await user.type(titleInput, 'Updated!')
    await user.tab()
    await panel().findByDisplayValue('Updated!')

    // The regression this file exists for. Correcting a scrape is not a review, and
    // announcing one moves numbers in the SOURCES window that nothing earned.
    expect(events()).toEqual([])
  })

  it('says nothing when only the publication and date are corrected', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    channel.reset()

    await user.type(panel().getByPlaceholderText(/e.g. Nature, arXiv/), 'Nature')
    await user.click(panel().getByRole('button', { name: /Save publication & date/ }))
    await server.requests.find((r) => r.path.endsWith('/metadata'))

    expect(events()).toEqual([])
  })

  it('reloads the graph when another window changes an entity', async () => {
    // The receiving half. The ENTITIES window has no card of its own -- corrections
    // happen beside the pivots they move -- so it posts and this window reacts.
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    server.reset()

    channel.post('entities-changed')

    await new Promise((r) => setTimeout(r, 0))
    expect(server.requests.map((r) => r.path)).toContain('/graph')
  })
})

// Deleting is the case a refetch alone cannot cover. Everything this window shows
// about an entity is held in state beside the graph -- the open card is a bare id,
// the credit chips are their own list -- so refetching a graph the node has left
// makes the screen *inconsistent* rather than correct. Each row below is one thing
// that went on claiming a node the guide no longer had.
describe('when another window deletes an entity', () => {
  let server: FakeServer
  let channel: Channel

  beforeEach(() => {
    channel = installBroadcastChannel()
    const doc = queuedDocument({ authors: [{ id: JANE.id, label: JANE.label }] })
    // A second document purely so there is somewhere to walk to: the unsaved-work
    // guard only fires on leaving one document for another.
    const other = queuedDocument({
      id: 'doc-2', label: 'A Second Paper',
      attributes: { ...queuedDocument().attributes, title: 'A Second Paper' },
    })
    server = installFakeServer({
      queue: [doc, other], documents: { [doc.id]: doc, [other.id]: other },
      graphNodes: [MEMORY, JANE], ontologyNodes: [MEMORY],
    })
  })

  /** Delete Jane the way the ENTITIES window does: gone from the graph, then the
   *  id on the wire. Both halves matter — the refetch alone is what used to
   *  happen, and it is what leaves the dangling id behind. */
  const deleteJane = async () => {
    server.state.graphNodes = server.state.graphNodes.filter((n) => n.id !== JANE.id)
    channel.post('entity-deleted', JANE.id)
    channel.post('entities-changed')
    await new Promise((r) => setTimeout(r, 0))
  }

  it('closes the card it had open, without asking for a concept', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    await user.click(panel().getByRole('button', { name: 'Jane Doe' }))
    await screen.findByRole('heading', { name: 'Jane Doe' })
    server.reset()

    await deleteJane()

    expect(screen.queryByRole('heading', { name: 'Jane Doe' })).toBeNull()
    // The reported bug, exactly. `selectedNodeId` is a bare id, and an id the graph
    // can't resolve falls through to the concept panel -- so a deleted person was
    // fetched as a concept and the window showed
    // `GET /concepts/<id> -> 404 {"detail":"concept not found"}`.
    expect(server.requests.filter((r) => r.path.startsWith('/concepts/'))).toEqual([])
    expect(screen.queryByText(/404|not found/i)).toBeNull()
  })

  it('drops the credit chip, and does not call the document dirty for it', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await openTheDocument(user)
    expect(panel().getByRole('button', { name: 'Jane Doe' })).toBeTruthy()

    await deleteJane()

    // The quiet half. The chip is an `authored_by` edge, and that edge went with the
    // node -- so leaving it on screen offers to un-credit something already gone.
    expect(panel().queryByRole('button', { name: 'Jane Doe' })).toBeNull()
    // ...and dropping it is this document catching up with the graph, not an edit
    // the curator made. If the baseline kept the credit, an untouched document would
    // read as dirty and prompt on the way out of it.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(await screen.findByTitle(/A Second Paper/))
    await screen.findByRole('heading', { name: /A Second Paper/ })
    expect(confirm).not.toHaveBeenCalled()
  })
})
