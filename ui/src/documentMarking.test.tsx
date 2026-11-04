// @vitest-environment jsdom
//
// MARKING IS AN EXTENSION OF SELECTING, not a second thing beside it (curator's call,
// 2026-08-25). Modifier-click builds the set that gets dragged onto a concept, and the
// open document is the set's FIRST MEMBER — so starting a set from something you are
// reading takes that document with you, and a marked row and the open row look
// identical because there is nothing left to tell apart. The ◉ that used to claim
// otherwise is gone, and the last test here holds it gone.
//
// The one gesture that parts them: unmarking the open row leaves it open and merely
// out of the set. The viewer does not move under a click that was about the selection.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import {
  installFakeServer, installBroadcastChannel, queuedDocument, conceptNode,
} from './testHarness'

const MEMORY = conceptNode('concept-memory', 'Memory')

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

let container: HTMLElement

const row = (title: string) =>
  [...container.querySelectorAll('.queue ul li')]
    .find((li) => li.querySelector('.q-title')?.textContent?.includes(title)) as HTMLElement

/** Every row that is part of the set the curator is about to act on — marked or
 *  open, which now look the same. */
const green = () =>
  [...container.querySelectorAll('.queue ul li')]
    .filter((li) => li.className.includes('marked') || li.className.includes('sel'))
    .map((li) => li.querySelector('.q-title')!.textContent)

const markHint = () => container.querySelector('.q-markhint')?.textContent ?? ''

async function markClick(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.keyboard('{Meta>}')
  await user.click(row(title))
  await user.keyboard('{/Meta}')
}

function setUp() {
  return installFakeServer({
    queue: docs,
    documents: Object.fromEntries(docs.map((d) => [d.id, d])),
    graphNodes: [MEMORY],
    ontologyNodes: [MEMORY],
  })
}

describe('marking documents to act on as a set', () => {
  beforeEach(() => { installBroadcastChannel(); setUp() })

  it('takes the open document into the set, as its first member', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await user.click(row('Paper one'))
    await screen.findByRole('heading', { name: /Paper one/ })
    await markClick(user, 'Paper three')

    // Both green, and the viewer has not moved off what it was showing.
    expect(green()).toEqual(['Paper one', 'Paper three'])
    expect(markHint()).toContain('2 selected')
    expect(screen.getByRole('heading', { name: /Paper one/ })).toBeTruthy()
  })

  it('unmarking the open row leaves it open, just out of the set', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await user.click(row('Paper one'))
    await screen.findByRole('heading', { name: /Paper one/ })
    await markClick(user, 'Paper two')
    await markClick(user, 'Paper one')

    expect(markHint()).toContain('1 selected')
    expect(row('Paper one').className).not.toContain('marked')
    // Still open, still green as the selection — the click was about the set.
    expect(row('Paper one').className).toContain('sel')
    expect(screen.getByRole('heading', { name: /Paper one/ })).toBeTruthy()
  })

  it('opens the first thing marked when nothing was open', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await markClick(user, 'Paper two')

    await screen.findByRole('heading', { name: /Paper two/ })
    expect(green()).toEqual(['Paper two'])
  })

  it('a plain click starts over — one document, no set', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await user.click(row('Paper one'))
    await markClick(user, 'Paper three')
    await user.click(row('Paper two'))

    expect(green()).toEqual(['Paper two'])
    expect(markHint()).toBe('')
  })

  it('draws no glyph on a marked row — green is the whole of what it says', async () => {
    const user = userEvent.setup()
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await user.click(row('Paper one'))
    await markClick(user, 'Paper three')

    expect(container.querySelector('.q-mark')).toBeNull()
    for (const title of ['Paper one', 'Paper three'])
      expect(row(title).textContent).not.toContain('◉')
  })
})
