// @vitest-environment jsdom
//
// What organization mode's piles do to the REVIEW QUEUE — which is all they do,
// since nothing about a segment reaches the graph (`queue_segments.py`).
//
// Two things are wired here and both are load-bearing:
//
//   ORDER   the list comes out blocked by segment, in canvas reading order, and
//           everything that walks the list walks that order — including "the next
//           one" after a save, which used to read the server's order and would now
//           jump the cursor across the column.
//   COLOUR  a segmented row carries its pile's hue as a rail and a tint, and it
//           carries them as CUSTOM PROPERTIES, so the cascade in styles.css can put
//           selection above them. jsdom sees the properties and the classes; it does
//           not see which colour wins, which is a question only a browser answers.
//
// What isn't pinned here: that the queue and its segmentation are fetched together
// (`Promise.all` in loadQueue) is visible below only as the fact that one render
// produced both the order and the colours.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import {
  installFakeServer, installBroadcastChannel, queuedDocument, conceptNode,
  type Channel, type FakeServer,
} from './testHarness'
import { ROOT_COLORS } from './palette'
import type { SegmentState } from './types'

const MEMORY = conceptNode('concept-memory', 'Memory')

// The server's order — tier, then arrival. The piles below deliberately cut across
// it, so a list that came out in this order would be a list that ignored them.
const ORDER = ['one', 'two', 'three', 'four', 'five']

const docs = ORDER.map((n) => queuedDocument({
  id: `doc-${n}`,
  label: `Paper ${n}`,
  attributes: {
    title: `Paper ${n}`, status: 'pending', summary: '', abstract: 'An abstract.',
    canonical_url: `https://example.org/${n}`, no_named_author: false,
  },
  author_proposals: [],
  proposals: [{ id: MEMORY.id, label: MEMORY.label }],
}))

// Two circles. `evals` is the LOWER one, so it comes second however the blob lists
// them — and it is listed first here on purpose.
const SEGMENTS: SegmentState = {
  segments: [
    { id: 'seg-evals', name: 'Evals', note: '', color: 3, x: 100, y: 400 },
    { id: 'seg-safety', name: 'Safety', note: '', color: 0, x: 500, y: 100 },
  ],
  members: {
    'doc-four': 'seg-safety',
    'doc-two': 'seg-evals',
    'doc-one': 'seg-safety',
  },
}

let container: HTMLElement

const rowTitles = () =>
  [...container.querySelectorAll('.queue ul li .q-title')].map((e) => e.textContent)

const row = (title: string) =>
  [...container.querySelectorAll('.queue ul li')]
    .find((li) => li.querySelector('.q-title')?.textContent?.includes(title)) as HTMLElement

function setUp(segments: SegmentState): FakeServer {
  return installFakeServer({
    queue: docs,
    segments,
    documents: Object.fromEntries(docs.map((d) => [d.id, d])),
    graphNodes: [MEMORY],
    ontologyNodes: [MEMORY],
    // One document categorized under Memory, so the concept panel's document list
    // is reachable — the ordinary way the left column stops being the queue.
    concepts: {
      [MEMORY.id]: {
        concept: MEMORY, documents: [docs[4]], people: [], related: [],
      },
    },
  })
}

describe('the queue under organization mode', () => {
  let server: FakeServer
  let channel: Channel

  beforeEach(() => { channel = installBroadcastChannel() })

  it('blocks the list by segment, in canvas order, unsegmented last', async () => {
    server = setUp(SEGMENTS)
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    // safety (the upper circle): one, four — the server's order INSIDE the block.
    // then evals: two. then what is left, still in the server's order.
    expect(rowTitles()).toEqual([
      'Paper one', 'Paper four', 'Paper two', 'Paper three', 'Paper five',
    ])
    expect(server.requests.some((r) => r.path === '/queue/segments')).toBe(true)
  })

  it('gives a segmented row its pile hue, and leaves an unsegmented one alone', async () => {
    server = setUp(SEGMENTS)
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    const safety = row('Paper one')
    expect(safety.className).toContain('q-seg')
    expect(safety.style.getPropertyValue('--seg-rail')).toBe(ROOT_COLORS[0])
    // The fill is a TINT of the same hue, never the hue itself — that is what keeps
    // row text at one contrast (palette.ts).
    expect(safety.style.getPropertyValue('--seg-tint')).not.toBe('')
    expect(safety.style.getPropertyValue('--seg-tint')).not.toBe(ROOT_COLORS[0])

    expect(row('Paper two').style.getPropertyValue('--seg-rail')).toBe(ROOT_COLORS[3])

    const loose = row('Paper three')
    expect(loose.className).not.toContain('q-seg')
    expect(loose.style.getPropertyValue('--seg-rail')).toBe('')
  })

  it('keeps the pile on a row that is also selected — the cascade decides, not the markup', async () => {
    const user = userEvent.setup()
    server = setUp(SEGMENTS)
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await user.click(screen.getByTitle(/Paper one/))
    const r = row('Paper one')
    expect(r.className).toContain('sel')
    expect(r.className).toContain('q-seg')
    // Which of the two paints the background is styles.css's business, and only a
    // browser can say it came out green. What is pinned here is that the row never
    // stops carrying its rail.
    expect(r.style.getPropertyValue('--seg-rail')).toBe(ROOT_COLORS[0])
  })

  it('advances to the next row DOWN THE LIST after a save, not the next one the server sent',
    async () => {
      const user = userEvent.setup()
      server = setUp(SEGMENTS)
      container = render(<App />).container
      await screen.findByTitle(/Paper one/)

      await user.click(screen.getByTitle(/Paper one/))
      await screen.findByRole('heading', { name: /Paper one/ })
      const panel = container.querySelector('.left-bottom') as HTMLElement
      await user.click(panel.querySelector('[title="Accept this concept"]') as HTMLElement)
      await user.click([...panel.querySelectorAll('button')]
        .find((b) => b.textContent === 'Save') as HTMLElement)

      // Paper FOUR is next in the safety block. The server's order would have said
      // Paper two, which is in the other pile and three rows further down.
      await screen.findByRole('heading', { name: /Paper four/ })
    })

  // ---------------------------------------------------------------------------
  // ENTERING THE MODE FREEZES THE ORDER. The curator is travelling down the queue,
  // and a list that re-sorted under them on every drop would lose their place on
  // every drop — so the order is the canvas as it stood at ENTRY, and only the tint
  // moves while the mode is on. Leaving commits.
  //
  // With no canvas yet (stage 4d), the way to move the state under a frozen list is
  // the way it will really happen: another window runs Scout, this one refetches,
  // and the server's answer has to be ignored.
  // ---------------------------------------------------------------------------

  it('offers Organize on the queue and nowhere else', async () => {
    server = setUp(SEGMENTS)
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    expect(screen.getByTitle(/^Organize the queue/)).toBeTruthy()
    expect(screen.getByTitle(/^Organize the queue/).getAttribute('aria-pressed'))
      .toBe('false')
  })

  it('holds the list still while the mode is on, and re-blocks it on the way out',
    async () => {
      const user = userEvent.setup()
      server = setUp(SEGMENTS)
      container = render(<App />).container
      await screen.findByTitle(/Paper one/)

      await user.click(screen.getByTitle(/^Organize the queue/))
      expect(screen.getByTitle(/^Stop organizing/).getAttribute('aria-pressed'))
        .toBe('true')

      // A Scout run in the Sources window: new documents, and a canvas on disk that
      // has moved on. The queue must take the new documents and the canvas must not
      // be adopted — the local one is authoritative, and an hour of unsaved dragging
      // is what adopting would throw away.
      server.state.queue = [...docs, queuedDocument({
        id: 'doc-six', label: 'Paper six',
        attributes: { ...docs[0].attributes, title: 'Paper six' },
      })]
      server.state.segments = {
        segments: [{ id: 'seg-evals', name: 'Evals', note: '', color: 3, x: 100, y: 400 }],
        members: { 'doc-five': 'seg-evals' },
      }
      channel.post('documents-ingested')
      await screen.findByTitle(/Paper six/)

      // The new document arrives UNSEGMENTED, at the bottom — never auto-filed. The
      // five that were already here have not moved, and Paper five has not taken the
      // colour the file now gives it.
      expect(rowTitles()).toEqual([
        'Paper one', 'Paper four', 'Paper two', 'Paper three', 'Paper five',
        'Paper six',
      ])
      expect(row('Paper five').className).not.toContain('q-seg')
      expect(row('Paper one').style.getPropertyValue('--seg-rail')).toBe(ROOT_COLORS[0])
    })

  it('leaves the mode when the column stops being the queue', async () => {
    // The mode is a pass over the QUEUE. A cell's documents come out of the graph and
    // have no piles, so there would be nothing on the canvas to go back to.
    const user = userEvent.setup()
    server = setUp(SEGMENTS)
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    await user.click(screen.getByTitle(/^Organize the queue/))
    expect(screen.getByTitle(/^Stop organizing/)).toBeTruthy()

    // Open a concept in the ontology, then its document list — the ordinary way the
    // left column stops being the queue.
    await user.click(container.querySelector('.ont-cardtitle') as HTMLElement)
    await user.click(await screen.findByRole('button', { name: /^Documents \(1\)/ }))

    expect(rowTitles()).toEqual(['Paper five'])
    expect(screen.queryByTitle(/^Stop organizing/)).toBeNull()
    expect(screen.queryByTitle(/^Organize the queue/)).toBeNull()
  })

  it('leaves the queue in the server order when nothing has been organized', async () => {
    server = setUp({ segments: [], members: {} })
    container = render(<App />).container
    await screen.findByTitle(/Paper one/)

    expect(rowTitles()).toEqual(
      ['Paper one', 'Paper two', 'Paper three', 'Paper four', 'Paper five'])
    expect(container.querySelectorAll('.queue ul li.q-seg')).toHaveLength(0)
  })
})
