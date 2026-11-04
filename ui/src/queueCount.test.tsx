// @vitest-environment jsdom
//
// What the review-queue count means.
//
// It is the number of documents still awaiting approval, and it is read off their
// `status` -- not off how many rows are on screen, and not off a tally kept
// alongside them. Both badges show it: the one in the app header and the one over
// the list. They name the same number, so they may never disagree.
//
// These pin a bug that was live for some time and was invisible from inside the app:
// the header badge was `rows - approvedThisSitting`, which is right only while both
// halves are in step. An approved row deliberately STAYS in the list, tinted, so the
// tally was load-bearing -- until anything refetched the queue, at which point the
// server's list had already dropped those rows and subtracting them again counted
// every approval twice. The symptom was a count that sagged as you worked and then
// jumped UP when you came back to the queue, which reads as documents appearing from
// nowhere. Reported against a real guide: 54, then 62 on returning.
//
// A status travels with the document, so it cannot fall out of step with it. That is
// the whole of the fix, and what these tests are here to hold.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import {
  installFakeServer, installBroadcastChannel, queuedDocument, conceptNode,
  type FakeServer,
} from './testHarness'

const MEMORY = conceptNode('concept-memory', 'Memory')

/** Three pending documents, each with a concept proposal so Save is reachable in
 *  one click -- Save is gated on assigning a concept. */
function setUp() {
  const docs = ['one', 'two', 'three'].map((n) => queuedDocument({
    id: `doc-${n}`,
    label: `Paper ${n}`,
    attributes: {
      title: `Paper ${n}`, status: 'pending', summary: '', abstract: 'An abstract.',
      canonical_url: `https://example.org/${n}`, no_named_author: false,
    },
    author_proposals: [],
    proposals: [{ id: MEMORY.id, label: MEMORY.label }],
  }))
  return installFakeServer({
    queue: docs,
    documents: Object.fromEntries(docs.map((d) => [d.id, d])),
    graphNodes: [MEMORY],
    ontologyNodes: [MEMORY],
  })
}

let container: HTMLElement

/** The count in the app header — the "Review queue" button. */
const headerCount = () =>
  screen.getByTitle('Show the documents awaiting review')
    .querySelector('.badge')!.textContent

/** The count over the list itself. Must always agree with the header. */
const listCount = () =>
  container.querySelector('.queue-head .badge')!.textContent

/** Both, asserted together — the point is that they are one number. */
const counts = () => ({ header: headerCount(), list: listCount() })

/** How many rows the list is actually showing, which is a DIFFERENT question: an
 *  approved document stays visible, tinted, until the next fetch. */
const rows = () => container.querySelectorAll('.queue ul li').length

const panel = () => within(container.querySelector('.left-bottom') as HTMLElement)

async function open(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await screen.findByTitle(new RegExp(title)))
  await screen.findByRole('heading', { name: new RegExp(title) })
}

/** Approve the open document: accept its proposed concept, Save. */
async function approve(user: ReturnType<typeof userEvent.setup>) {
  await user.click(panel().getByTitle('Accept this concept'))
  await user.click(panel().getByRole('button', { name: 'Save' }))
}

/** Dismiss the open document, through the confirm dialog. */
async function dismiss(user: ReturnType<typeof userEvent.setup>) {
  await user.click(panel().getByRole('button', { name: 'Delete document' }))
  const dialog = within(await screen.findByRole('dialog'))
  await user.click(dialog.getByRole('button', { name: 'Delete document' }))
}

describe('the review queue count', () => {
  let server: FakeServer

  beforeEach(() => {
    installBroadcastChannel()
    server = setUp()
  })

  it('counts documents still awaiting approval, not rows on screen', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)
    expect(counts()).toEqual({ header: '3', list: '3' })

    await open(user, 'Paper one')
    await approve(user)
    await screen.findByTitle(/Paper two/)

    // The approved row is still there, and still counted as a row -- that is the
    // design, it's how you can see what you just did. It is NOT still counted as
    // outstanding work.
    expect(rows()).toBe(3)
    expect(counts()).toEqual({ header: '2', list: '2' })
  })

  it('drops by one per dismissal, including straight after an approval', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await open(user, 'Paper one')
    await approve(user)
    await screen.findByTitle(/Paper two/)
    expect(counts()).toEqual({ header: '2', list: '2' })

    // The reported symptom. A dismissal refetches the queue, and that fetch no
    // longer carries the document approved a moment ago -- so a count that also
    // subtracted a tally of approvals subtracted that one twice and fell to 0.
    await open(user, 'Paper two')
    await dismiss(user)
    await screen.findByTitle(/Paper three/)
    expect(counts()).toEqual({ header: '1', list: '1' })
  })

  it('does not jump when the curator comes back to the queue', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await open(user, 'Paper one')
    await approve(user)
    await screen.findByTitle(/Paper two/)
    await open(user, 'Paper two')
    await approve(user)
    await screen.findByTitle(/Paper three/)
    expect(counts()).toEqual({ header: '1', list: '1' })

    // Going elsewhere and back is what used to expose the drift: returning to the
    // queue clears the tally and refetches together, so the number "corrected"
    // itself upward and looked like the queue had grown while nobody was watching.
    await user.click(screen.getByTitle('Show the documents awaiting review'))
    await screen.findByTitle(/Paper three/)
    expect(counts()).toEqual({ header: '1', list: '1' })
    // And now the list has caught up with the count: the approved rows are gone.
    expect(rows()).toBe(1)
    expect(server.state.queue.map((d) => d.id)).toEqual(['doc-three'])
  })
})
