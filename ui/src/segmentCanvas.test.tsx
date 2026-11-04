// @vitest-environment jsdom
//
// The canvas organization mode is made of. What's pinned here is the four gestures
// and the one promise:
//
//   CREATE  drag the + onto the canvas and a circle lands WHERE IT WAS DROPPED —
//           position is the only ranking control this feature has, so the creating
//           gesture has to be the one that puts the circle somewhere;
//   CATCH   drop queue rows on a circle and they are caught, a marked set whole —
//           and the LIST DOES NOT MOVE, only tints. A list that re-sorted on every
//           drop would lose the curator's place on every drop;
//   ROSTER  click a circle for its members, in the order the list is in; click a
//           member to read it;
//   UNFILE  drag a member onto bare canvas and it goes back to unsegmented — and if
//           it was the last one, the circle is gone;
//   READ-ONLY  the floating viewer cannot write the graph. That is the whole reason
//           the mode is safe to be wrong in.
//
// What jsdom cannot answer, and stage 5's browser pass has to: whether a circle is a
// legible target at a real zoom, what a forty-member roster does, and whether the
// tint survives a Scout run mid-sitting. Every rect here is zero-sized, so canvas
// coordinates and client coordinates are the same numbers — which is convenient and
// is also why nothing below proves the transform is right.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, createEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import {
  installFakeServer, installBroadcastChannel, queuedDocument, conceptNode,
  type FakeServer,
} from './testHarness'
import { radiusFor, SAVE_DEBOUNCE, SEGMENT_NEW_DND } from './components/SegmentCanvas'
import { DOCS_DND } from './components/DocumentList'
import type { SegmentState } from './types'

const MEMORY = conceptNode('concept-memory', 'Memory')
const ORDER = ['one', 'two', 'three', 'four']
const docs = ORDER.map((n) => queuedDocument({
  id: `doc-${n}`,
  label: `Paper ${n}`,
  attributes: {
    title: `Paper ${n}`, status: 'pending', summary: '', abstract: 'An abstract.',
    canonical_url: `https://example.org/${n}`, no_named_author: false,
  },
  proposals: [], author_proposals: [],
}))

const ONE_PILE: SegmentState = {
  segments: [{ id: 'seg-safety', name: 'Safety', note: '', color: 0, x: 300, y: 200 }],
  members: { 'doc-two': 'seg-safety' },
}

/** A drag payload jsdom will carry. `types` is what a `dragover` is allowed to read,
 *  which is exactly why the canvas branches on it rather than on the data. */
const transfer = (type: string, value: string) => ({
  types: [type],
  effectAllowed: '', dropEffect: '',
  setData: vi.fn(),
  getData: (t: string) => (t === type ? value : ''),
})

/** A drop that knows where it landed. jsdom builds drag events as plain Events and
 *  discards everything the init dict says that `Event` has no field for — `clientX`
 *  included — so a plain `fireEvent.drop(el, { clientX })` silently drops a circle at
 *  NaN and the test passes against the wrong path. Every rect here is zero-sized, so
 *  these client coordinates ARE canvas coordinates. */
const dropAt = (el: Element, dt: object, x: number, y: number) => {
  for (const kind of ['dragOver', 'drop'] as const) {
    const ev = createEvent[kind](el, { dataTransfer: dt })
    Object.defineProperty(ev, 'clientX', { value: x })
    Object.defineProperty(ev, 'clientY', { value: y })
    fireEvent(el, ev)
  }
}

let container: HTMLElement

const rowTitles = () =>
  [...container.querySelectorAll('.queue ul li .q-title')].map((e) => e.textContent)
const row = (title: string) =>
  [...container.querySelectorAll('.queue ul li')]
    .find((li) => li.querySelector('.q-title')?.textContent?.includes(title)) as HTMLElement
const circles = () => [...container.querySelectorAll('.seg-circle')] as HTMLElement[]
const surface = () => container.querySelector('.seg-surface') as HTMLElement

function setUp(segments: SegmentState): FakeServer {
  return installFakeServer({
    queue: docs,
    segments,
    documents: Object.fromEntries(docs.map((d) => [d.id, d])),
    graphNodes: [MEMORY],
    ontologyNodes: [MEMORY],
  })
}

/** Render, and turn the mode on. */
async function organize(segments: SegmentState = { segments: [], members: {} }) {
  const server = setUp(segments)
  const user = userEvent.setup()
  container = render(<App />).container
  await screen.findByTitle(/Paper one/)
  await user.click(screen.getByTitle(/^Organize the queue/))
  return { server, user }
}

describe('the segment canvas', () => {
  beforeEach(() => { installBroadcastChannel() })

  it('appears over the workspace and leaves the queue column alone', async () => {
    await organize(ONE_PILE)
    expect(surface()).toBeTruthy()
    // The drags that fill these piles start in the queue, so the queue has to stay
    // where it is — this is why the overlay is on `.workspace` and not on `.panes`.
    expect(container.querySelector('.workspace .seg-canvas')).toBeTruthy()
    expect(rowTitles()).toEqual(['Paper two', 'Paper one', 'Paper three', 'Paper four'])
  })

  it('drops a new circle where the + was let go, and offers its name', async () => {
    await organize()
    expect(circles()).toHaveLength(0)

    const plus = container.querySelector('.seg-new') as HTMLElement
    const dt = transfer(SEGMENT_NEW_DND, '1')
    fireEvent.dragStart(plus, { dataTransfer: dt })
    dropAt(surface(), dt, 240, 90)

    const [c] = circles()
    expect(c).toBeTruthy()
    // Centred on the drop. Radius comes off a count of zero — a bare circle still has
    // to be a target, which is what the floor in `radiusFor` is for.
    const r = radiusFor(0)
    expect(c.style.left).toBe(`${240 - r}px`)
    expect(c.style.top).toBe(`${90 - r}px`)
    expect(c.textContent).toContain('0')
    // A circle is dropped first and named after, so the roster opens with the field
    // ready rather than making the curator find it.
    expect(screen.getByPlaceholderText('Name this pile…')).toBeTruthy()
  })

  it('catches a marked set whole, and does not move the list doing it', async () => {
    const { user } = await organize(ONE_PILE)
    const before = rowTitles()

    // ⌘-click two rows. The open document is the marked set's first member, so this
    // is the same gesture as opening one and taking another along.
    for (const t of ['Paper one', 'Paper three']) {
      await user.keyboard('{Meta>}')
      await user.click(row(t))
      await user.keyboard('{/Meta}')
    }

    const dt = transfer(DOCS_DND, JSON.stringify(['doc-one', 'doc-three']))
    fireEvent.dragStart(row('Paper one'), { dataTransfer: dt })
    fireEvent.dragOver(circles()[0], { dataTransfer: dt })
    fireEvent.drop(circles()[0], { dataTransfer: dt })

    expect(circles()[0].textContent).toContain('3')
    // TINT MOVES, ORDER DOESN'T. Both freshly-filed rows carry the pile's rail, and
    // every row is exactly where it was.
    expect(rowTitles()).toEqual(before)
    expect(row('Paper one').className).toContain('q-seg')
    expect(row('Paper three').className).toContain('q-seg')
    expect(row('Paper four').className).not.toContain('q-seg')
  })

  it('opens a roster on a click, in the order the list is in, and reads one', async () => {
    const { user } = await organize(ONE_PILE)

    const dt = transfer(DOCS_DND, JSON.stringify(['doc-four', 'doc-one']))
    fireEvent.drop(circles()[0], { dataTransfer: dt })

    // A click, not a drag: the circle only moves once the pointer has travelled.
    fireEvent.mouseDown(circles()[0], { button: 0, clientX: 300, clientY: 200 })
    fireEvent.mouseUp(window)

    const listed = [...container.querySelectorAll('.seg-roster-list li')]
      .map((li) => li.textContent)
    // Queue order, not the order they were filed in — reading down a roster and
    // reading down the list are the same walk.
    expect(listed).toEqual(['Paper two', 'Paper one', 'Paper four'])

    await user.click(container.querySelector('.seg-roster-list li') as HTMLElement)
    const floating = within(container.querySelector('.seg-viewer') as HTMLElement)
    await floating.findByText('First paragraph.')
    // Read-only, abstract included: the mode's promise has no exception in it.
    expect((floating.getByPlaceholderText('No abstract.') as HTMLTextAreaElement).readOnly)
      .toBe(true)
    // And the docked viewer underneath is not fetching the same document a second
    // time — it is covered, so App stops feeding it while the mode is on.
    expect(container.querySelectorAll('.readable').length).toBe(1)
  })

  it('unfiles a member dragged onto bare canvas, and forgets the circle it emptied',
    async () => {
      await organize(ONE_PILE)
      fireEvent.mouseDown(circles()[0], { button: 0, clientX: 300, clientY: 200 })
      fireEvent.mouseUp(window)

      const member = container.querySelector('.seg-roster-list li') as HTMLElement
      const dt = transfer(DOCS_DND, JSON.stringify(['doc-two']))
      fireEvent.dragStart(member, { dataTransfer: dt })
      dropAt(surface(), dt, 40, 40)

      // Its last member left, so the pile is gone — no empty ring to wonder about
      // later, and nothing to clean up.
      expect(circles()).toHaveLength(0)
      expect(row('Paper two').className).not.toContain('q-seg')
    })

  it('moves a circle when the pointer actually travels, and ranks it by where it lands',
    async () => {
      await organize(ONE_PILE)
      fireEvent.mouseDown(circles()[0], { button: 0, clientX: 300, clientY: 200 })
      await act(async () => { fireEvent.mouseMove(window, { clientX: 300, clientY: 460 }) })
      fireEvent.mouseUp(window)

      const r = radiusFor(1)
      expect(circles()[0].style.top).toBe(`${460 - r}px`)
      // A travelled drag is not a click, so no roster came up under it.
      expect(container.querySelector('.seg-roster')).toBeNull()
    })

  it('leaves the mode on Escape, and re-blocks the queue on the way out', async () => {
    await organize(ONE_PILE)
    const dt = transfer(DOCS_DND, JSON.stringify(['doc-four']))
    fireEvent.drop(circles()[0], { dataTransfer: dt })
    expect(rowTitles()).toEqual(['Paper two', 'Paper one', 'Paper three', 'Paper four'])

    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })

    // Leaving is what re-orders: Paper four joins the block it was dropped into,
    // keeping the server's order inside it.
    expect(surface()).toBeNull()
    expect(rowTitles()).toEqual(['Paper two', 'Paper four', 'Paper one', 'Paper three'])
  })
})

// ---------------------------------------------------------------------------
// SAVING. A debounced whole-blob PUT, and three things about it that are decisions
// rather than plumbing:
//
//   * never-filled circles are NOT SENT, and the reply is NOT ADOPTED. Two halves of
//     one rule: the server drops empty segments before writing, so adopting its
//     answer would delete the circle just dropped — and not sending them means the
//     client and the file disagree about nothing;
//   * entering the mode is not an edit, so opening the canvas and closing it writes
//     nothing (on a guide that has never been organized it would CREATE the file);
//   * leaving mid-debounce writes the last edit instead of losing it, which is the
//     ordinary case: the last drop and the Escape after it are half a second apart.
//
// Fake timers throughout, and `fireEvent` rather than `userEvent` — the two don't mix
// without threading `advanceTimers` through, and nothing here needs real typing.
// ---------------------------------------------------------------------------

describe('saving the canvas', () => {
  let server: FakeServer

  beforeEach(() => {
    installBroadcastChannel()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  /** Render and turn the mode on, without userEvent. */
  const open = async (segments: SegmentState = { segments: [], members: {} }) => {
    server = setUp(segments)
    container = render(<App />).container
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    fireEvent.click(screen.getByTitle(/^Organize the queue/))
    server.reset()
  }

  const settle = async () =>
    act(async () => { await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE + 10) })

  const puts = () => server.writes.filter((w) => w.path === '/queue/segments')

  it('writes nothing for a mode that was only opened and closed', async () => {
    await open(ONE_PILE)
    await settle()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(puts()).toEqual([])
  })

  it('writes the whole canvas once the dragging stops', async () => {
    await open(ONE_PILE)
    const dt = transfer(DOCS_DND, JSON.stringify(['doc-four']))
    fireEvent.drop(circles()[0], { dataTransfer: dt })
    expect(puts()).toEqual([])   // not yet — the curator may still be dragging

    await settle()
    expect(puts()).toHaveLength(1)
    expect(puts()[0].method).toBe('PUT')
    expect(puts()[0].body.members)
      .toEqual({ 'doc-two': 'seg-safety', 'doc-four': 'seg-safety' })
  })

  it('coalesces a drag into one write, not one per frame', async () => {
    await open(ONE_PILE)
    fireEvent.mouseDown(circles()[0], { button: 0, clientX: 300, clientY: 200 })
    for (let y = 210; y <= 300; y += 10) {
      await act(async () => { fireEvent.mouseMove(window, { clientX: 300, clientY: y }) })
    }
    fireEvent.mouseUp(window)
    await settle()

    expect(puts()).toHaveLength(1)
    expect(puts()[0].body.segments[0].y).toBe(300)
  })

  it('does not send a circle that has never held anything', async () => {
    await open(ONE_PILE)
    const dt = transfer(SEGMENT_NEW_DND, '1')
    dropAt(surface(), dt, 500, 400)
    await settle()

    // The circle is on the canvas — it has to be, or there would be nothing to drop
    // a document onto — and it is not in the file. The server would have dropped it
    // anyway; not sending it is what keeps the two from disagreeing.
    expect(circles()).toHaveLength(2)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].body.segments.map((s: { id: string }) => s.id)).toEqual(['seg-safety'])
  })

  it('keeps a never-filled circle even though the server just forgot it', async () => {
    // The reply is the file, and the file is right — it is just not the canvas. A
    // client that adopted it would delete the circle the curator is about to fill.
    await open(ONE_PILE)
    dropAt(surface(), transfer(SEGMENT_NEW_DND, '1'), 500, 400)
    await settle()
    expect(circles()).toHaveLength(2)

    const fresh = circles()[1]
    fireEvent.drop(fresh, { dataTransfer: transfer(DOCS_DND, JSON.stringify(['doc-one'])) })
    await settle()

    expect(puts()).toHaveLength(2)
    expect(puts()[1].body.segments).toHaveLength(2)
  })

  it('forgets a never-filled circle on the way out, so it leaves no ghost', async () => {
    await open(ONE_PILE)
    dropAt(surface(), transfer(SEGMENT_NEW_DND, '1'), 500, 400)
    await settle()
    expect(circles()).toHaveLength(2)

    // Two Escapes, and that is the rule: one layer per Escape. Dropping the + opened
    // the new pile's roster, so the first closes that and the second leaves the mode.
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(container.querySelector('.seg-roster')).toBeNull()
    expect(surface()).toBeTruthy()
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    await act(async () => { fireEvent.click(screen.getByTitle(/^Organize the queue/)) })

    // It was never in the file, so keeping it in memory would put a circle on the
    // canvas that vanished at the next queue reload.
    expect(circles()).toHaveLength(1)
  })

  it('writes the last edit on the way out instead of losing it', async () => {
    await open(ONE_PILE)
    fireEvent.drop(circles()[0], {
      dataTransfer: transfer(DOCS_DND, JSON.stringify(['doc-three'])),
    })
    // Escape lands INSIDE the debounce window — which is the ordinary case, not an
    // edge one: the last drop and the Escape after it are half a second apart.
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(puts()).toHaveLength(1)
    expect(puts()[0].body.members['doc-three']).toBe('seg-safety')
    expect(surface()).toBeNull()
  })

  it('says so when the write fails', async () => {
    await open(ONE_PILE)
    server.fail('PUT /queue/segments')
    fireEvent.drop(circles()[0], {
      dataTransfer: transfer(DOCS_DND, JSON.stringify(['doc-four'])),
    })
    await settle()
    await act(async () => { await Promise.resolve() })

    // The queue looks identical whether the canvas was written or not, so a silent
    // failure is an afternoon's sorting quietly not happening.
    const banner = container.querySelector('.error') as HTMLElement
    expect(banner?.textContent).toContain('/queue/segments')
  })
})
