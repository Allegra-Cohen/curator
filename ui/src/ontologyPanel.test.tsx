// @vitest-environment jsdom
//
// The concepts pane as rendered: one card per root concept.
//
// `ontologyTable.test.ts` pins the derivation — which rows exist, in what order,
// at what depth. This pins the *arrangement*: that the flat row list is grouped
// into cards without any of that derivation being re-decided at render time. The
// two are separate on purpose, because the grouping pass is the one place a
// rendering change could quietly drop a concept the table went to some trouble to
// emit (a poly-parented one, or one recovered from a `subtopic_of` cycle).
//
// Also pins that the pivot tab bar is gone. It is switched off, not deleted, so a
// stray render of it would typecheck and pass every other test in the suite.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, cleanup, fireEvent, createEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OntologyPanel, { type OntMode } from './components/OntologyPanel'
import type { FullGraph, Ontology } from './types'

/** `subtopic_of` runs child -> parent: source is the child. */
const subtopicOf = (child: string, parent: string) =>
  ({ source: child, target: parent, type: 'subtopic_of', attributes: {} })

function ontology(labels: string[], edges: any[] = []): Ontology {
  return {
    nodes: labels.map((l) => ({ id: l, label: l, type: 'concept', attributes: {} })),
    edges,
  } as Ontology
}

const EMPTY_GRAPH: FullGraph = { nodes: [], edges: [] }

// Explicit, because this suite is `globals: false` — nothing has registered RTL's
// auto-cleanup, so without this every render stacks up in the same document and
// the screen queries below start matching the previous test's cards.
afterEach(cleanup)

function panel(ont: Ontology, over: Partial<React.ComponentProps<typeof OntologyPanel>> = {}) {
  const props = {
    ontology: ont,
    graph: EMPTY_GRAPH,
    tab: 'default' as const,
    onTabChange: vi.fn(),
    mode: 'normal' as OntMode,
    onToggleAdd: vi.fn(),
    onToggleDelete: vi.fn(),
    onClickInsert: vi.fn(),
    onDeleteRow: vi.fn(),
    selectedIds: new Set<string>(),
    focusedKey: null,
    onClickRow: vi.fn(),
    onClickCell: vi.fn(),
    onClickColumn: vi.fn(),
    activeCell: null,
    onReparent: vi.fn(),
    onOpenChat: vi.fn(),
    ...over,
  }
  return { props, ...render(<OntologyPanel {...props} />) }
}

/** The cards, as "root: child, child" — the shape the eye is meant to see. */
function shape(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.ont-card')].map((card) => {
    const head = card.querySelector('.ont-cardtitle')!.textContent
    const kids = [...card.querySelectorAll('.ont-cardbody .ont-label')]
      .map((n) => n.textContent)
    return `${head}: ${kids.join(', ')}`
  })
}

describe('the concepts pane', () => {
  it('gives every root its own card and nests its branch inside', () => {
    const ont = ontology(
      ['Governance', 'Misinfo', 'Elections', 'Interp', 'Probing'],
      [
        subtopicOf('Misinfo', 'Governance'),
        subtopicOf('Elections', 'Misinfo'),
        subtopicOf('Probing', 'Interp'),
      ],
    )
    const { container } = panel(ont)

    // The whole branch lands in the root's card, however deep it runs — a card
    // boundary is opened by a root, not by a change of depth.
    expect(shape(container)).toEqual([
      'Governance: Misinfo, Elections',
      'Interp: Probing',
    ])
  })

  it('shows a poly-parented concept in every card whose branch reaches it', () => {
    // The derivation emits such a concept once per parent, and that duplication is
    // the signal — it is how the curator sees it was filed twice. Grouping must
    // carry all of those instances through, not dedupe them back into one card.
    const ont = ontology(
      ['Governance', 'Interp', 'Evals'],
      [subtopicOf('Evals', 'Governance'), subtopicOf('Evals', 'Interp')],
    )
    const { container } = panel(ont)

    expect(shape(container)).toEqual(['Governance: Evals', 'Interp: Evals'])
  })

  it('surfaces a concept caught in a subtopic_of cycle as its own card', () => {
    // Every member of a cycle has a parent, so none counts as a root and the walk
    // never reaches it. The table recovers them as roots; cards must not lose them
    // again by assuming a root is childless-of-parents.
    const ont = ontology(
      ['Governance', 'A', 'B'],
      [subtopicOf('A', 'B'), subtopicOf('B', 'A')],
    )
    const { container } = panel(ont)

    expect(shape(container).map((s) => s.split(':')[0])).toEqual(['Governance', 'A'])
  })

  it('says so when a root has no subtopics, rather than showing an empty box', () => {
    const { container } = panel(ontology(['Governance']))
    expect(shape(container)).toEqual(['Governance: '])
    expect(within(container).getByText('No subtopics.')).toBeTruthy()
  })

  it('renders no pivot tab bar', () => {
    // Switched off, not deleted: the markup and its CSS both still exist, so this
    // is the only thing standing between "dormant" and "quietly back on".
    const { container } = panel(ontology(['Governance']))
    expect(container.querySelector('.ont-tabs')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText('co-occurrence')).toBeNull()
    expect(screen.queryByText('authored_by')).toBeNull()
    expect(screen.queryByText('funds')).toBeNull()
  })

  it('opens a concept when its card head is clicked', async () => {
    const onClickRow = vi.fn()
    panel(ontology(['Governance']), { onClickRow })

    await userEvent.click(screen.getByRole('button', { name: 'Governance' }))

    expect(onClickRow.mock.calls[0][0].conceptId).toBe('Governance')
  })

  it('deletes from the card head in delete mode, not opens', async () => {
    // The head is a root's only click target now, so it has to carry every mode a
    // banded row does — losing delete here would strand root concepts.
    const onDeleteRow = vi.fn()
    const onClickRow = vi.fn()
    panel(ontology(['Governance']), { mode: 'delete', onDeleteRow, onClickRow })

    await userEvent.click(screen.getByRole('button', { name: 'Governance' }))

    expect(onDeleteRow).toHaveBeenCalledWith('Governance', 'Governance')
    expect(onClickRow).not.toHaveBeenCalled()
  })

  describe('add mode', () => {
    const ont = () => ontology(['Governance', 'Misinfo'],
                               [subtopicOf('Misinfo', 'Governance')])

    it('offers a subtopic line under every concept, root included', async () => {
      const onClickInsert = vi.fn()
      panel(ont(), { mode: 'add', onClickInsert })

      await userEvent.click(screen.getByTitle('New subtopic of Governance'))
      expect(onClickInsert).toHaveBeenCalledWith('Governance', 'Governance')

      await userEvent.click(screen.getByTitle('New subtopic of Misinfo'))
      expect(onClickInsert).toHaveBeenCalledWith('Misinfo', 'Misinfo')
    })

    it('offers a new root as a card of its own, above the first one', async () => {
      // A root has no row above it to hang a line under, which is why it needs its
      // own affordance rather than reusing the between-rows one. It sits at the top,
      // where it is reachable without scrolling past every existing card.
      const onClickInsert = vi.fn()
      const { container } = panel(ont(), { mode: 'add', onClickInsert })

      const stack = [...container.querySelectorAll('.ont-card, .ont-newroot')]
      expect(stack[0].className).toContain('ont-newroot')

      await userEvent.click(screen.getByTitle('New top-level concept'))
      expect(onClickInsert).toHaveBeenCalledWith(null, null)
    })

    it('gives an empty ontology somewhere to start', async () => {
      const onClickInsert = vi.fn()
      panel(ontology([]), { mode: 'add', onClickInsert })

      await userEvent.click(screen.getByTitle('New top-level concept'))
      expect(onClickInsert).toHaveBeenCalledWith(null, null)
    })

    it('marks the line the in-progress draft belongs to', () => {
      const { container } = panel(ont(), { mode: 'add', draftParentId: 'Governance' })
      const active = container.querySelectorAll('.ont-insert.active')
      expect(active).toHaveLength(1)
      expect(active[0].getAttribute('title')).toBe('New subtopic of Governance')
    })

    it('marks the new-root card when the draft is a root', () => {
      const { container } = panel(ont(), { mode: 'add', draftParentId: null })
      expect(container.querySelector('.ont-newroot.active')).toBeTruthy()
      expect(container.querySelector('.ont-insert.active')).toBeNull()
    })
  })

  // Dragging a concept to another level. The grip is what makes a drag
  // deliberate: rows are click-to-select, and a whole-row drag would turn an
  // imprecise click into a silent restructuring of the ontology.
  describe('moving a concept between levels', () => {
    const tree = () => ontology(
      ['Autonomy', 'Security', 'Deepfakes', 'Other'],
      [subtopicOf('Security', 'Autonomy'), subtopicOf('Deepfakes', 'Security')],
    )

    /** Begin a drag and let the panel catch up.
     *
     *  The panel defers its dragstart state by a task on purpose — Safari aborts a
     *  drag whose source is displaced by a re-render inside the handler (see
     *  gripFor). So every test here has to wait that task out. Note what this
     *  means: nothing below can tell you the drag works in a real browser, only
     *  that the wiring is right once it has begun. */
    const startDrag = async (grip: Element, dt: object) => {
      fireEvent.dragStart(grip, { dataTransfer: dt })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    }

    it('gives every row a handle in normal mode, and none in delete mode', () => {
      expect(panel(tree()).container.querySelectorAll('.ont-grip').length).toBe(4)
      expect(panel(tree(), { mode: 'delete' }).container.querySelector('.ont-grip'))
        .toBeNull()
    })

    it('reports the dragged row’s own parent, not just the concept', async () => {
      // `Deepfakes` sits under `Security`; dropping it on `Other` must move THAT
      // edge. A poly-parented concept has several, and only this one was dragged.
      const onReparent = vi.fn()
      const { container } = panel(tree(), { onReparent })

      const grip = [...container.querySelectorAll('.ont-grip')]
        .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
      const wraps = [...container.querySelectorAll('.ont-dropwrap')]
      const target = wraps.find((w) => w.textContent?.includes('Other'))!

      const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
      await startDrag(grip, dt)
      fireEvent.dragOver(target, { dataTransfer: dt })
      fireEvent.drop(target, { dataTransfer: dt })

      expect(onReparent).toHaveBeenCalledWith('Deepfakes', 'Security', 'Other')
    })

    it('refuses a drop that would put a concept inside its own subtree', async () => {
      const onReparent = vi.fn()
      const { container } = panel(tree(), { onReparent })

      const grip = [...container.querySelectorAll('.ont-grip')]
        .find((g) => g.getAttribute('aria-label')?.includes('Security'))!
      const wraps = [...container.querySelectorAll('.ont-dropwrap')]
      const ownChild = wraps.find((w) => w.textContent?.includes('Deepfakes'))!

      const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Security' }
      await startDrag(grip, dt)
      fireEvent.dragOver(ownChild, { dataTransfer: dt })
      fireEvent.drop(ownChild, { dataTransfer: dt })

      expect(onReparent).not.toHaveBeenCalled()
      // ...and it never looked droppable in the first place.
      expect(ownChild.className).not.toContain('droppable')
    })

    /** A dragover/drop that carries a modifier key.
     *
     *  jsdom builds drag events as plain Events, so `metaKey` in the init dict is
     *  discarded exactly like `relatedTarget` — passing it to fireEvent silently
     *  gives you an unmodified drop, and the test passes against the wrong path. */
    const dragWith = (
      kind: 'dragOver' | 'drop', el: Element, dt: object, metaKey: boolean,
    ) => {
      const ev = createEvent[kind](el, { dataTransfer: dt })
      Object.defineProperty(ev, 'metaKey', { value: metaKey })
      fireEvent(el, ev)
    }

    /** A dragleave that names where the cursor went. jsdom builds drag events as
     *  plain Events and drops `relatedTarget` from the init dict entirely (it
     *  arrives undefined), so it has to be put on the event by hand. */
    const leaveFor = (el: Element, to: Node) => {
      const ev = createEvent.dragLeave(el)
      Object.defineProperty(ev, 'relatedTarget', { value: to })
      fireEvent(el, ev)
    }

    it('keeps the target lit when the cursor crosses onto a child of it', async () => {
      // A dropwrap contains the row button, so moving INTO that button fires
      // dragleave on the wrapper. Clearing on that would drop the outline and the
      // destination ghost while the pointer is still over a valid target — the
      // drag looks dead without being dead.
      const { container } = panel(tree())

      const grip = [...container.querySelectorAll('.ont-grip')]
        .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
      const wraps = [...container.querySelectorAll('.ont-dropwrap')]
      const target = wraps.find((w) => w.textContent?.includes('Other'))!
      const inner = target.querySelector('.ont-rowlabel, .ont-cardhead')!

      const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
      await startDrag(grip, dt)
      fireEvent.dragOver(target, { dataTransfer: dt })
      expect(target.className).toContain('over')

      leaveFor(target, inner)
      expect(target.className).toContain('over')

      // Leaving for something outside the wrapper still clears it.
      leaveFor(target, container)
      expect(target.className).not.toContain('over')
    })

    it('offers promotion to the top level only for a concept that has a parent', async () => {
      const { container } = panel(tree())
      expect(container.querySelector('.ont-dragbar')).toBeNull()   // not dragging

      // `Security` sits under `Autonomy`, so it can be promoted: the bar is a
      // drop target as well as a label.
      const grip = [...container.querySelectorAll('.ont-grip')]
        .find((g) => g.getAttribute('aria-label')?.includes('Security'))!
      await startDrag(grip, { effectAllowed: '', setData: vi.fn() })
      expect(container.querySelector('.ont-dragbar.targetable')).toBeTruthy()
    })

    // ⌘ turns the drop from a move into an add. `from` is what names the edge to
    // remove, so an add sends null: the service adds the new parent and removes
    // nothing.
    describe('holding ⌘ files it in a second place', () => {
      it('sends no from-parent, so the old one survives', async () => {
        const onReparent = vi.fn()
        const { container } = panel(tree(), { onReparent })

        const grip = [...container.querySelectorAll('.ont-grip')]
          .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
        const target = [...container.querySelectorAll('.ont-dropwrap')]
          .find((w) => w.textContent?.includes('Other'))!

        const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
        await startDrag(grip, dt)
        dragWith('dragOver', target, dt, true)
        dragWith('drop', target, dt, true)

        expect(onReparent).toHaveBeenCalledWith('Deepfakes', null, 'Other')
      })

      it('still adds when ⌘ is released a moment before the mouse', async () => {
        // The finicky version of this read e.metaKey off the drop itself, so
        // letting go of ⌘ a hair early turned a duplicate into a move — and the
        // ghost had already promised otherwise. The last dragover decides.
        const onReparent = vi.fn()
        const { container } = panel(tree(), { onReparent })

        const grip = [...container.querySelectorAll('.ont-grip')]
          .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
        const target = [...container.querySelectorAll('.ont-dropwrap')]
          .find((w) => w.textContent?.includes('Other'))!

        const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
        await startDrag(grip, dt)
        dragWith('dragOver', target, dt, true)    // ghost says "also under"
        dragWith('drop', target, dt, false)       // ⌘ already up at release

        expect(onReparent).toHaveBeenCalledWith('Deepfakes', null, 'Other')
      })

      it('goes back to a move once ⌘ is released and the cursor moves again', async () => {
        // The forgiveness above must not become stickiness: an actual change of
        // mind, which shows up as a dragover without ⌘, has to be honoured.
        const onReparent = vi.fn()
        const { container } = panel(tree(), { onReparent })

        const grip = [...container.querySelectorAll('.ont-grip')]
          .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
        const target = [...container.querySelectorAll('.ont-dropwrap')]
          .find((w) => w.textContent?.includes('Other'))!

        const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
        await startDrag(grip, dt)
        dragWith('dragOver', target, dt, true)
        dragWith('dragOver', target, dt, false)   // moved on with ⌘ up
        dragWith('drop', target, dt, false)

        expect(onReparent).toHaveBeenCalledWith('Deepfakes', 'Security', 'Other')
      })

      it('says "also under" while ⌘ is down, and "under" when it is not', async () => {
        const { container } = panel(tree())
        const grip = [...container.querySelectorAll('.ont-grip')]
          .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
        const target = [...container.querySelectorAll('.ont-dropwrap')]
          .find((w) => w.textContent?.includes('Other'))!

        const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
        await startDrag(grip, dt)

        dragWith('dragOver', target, dt, true)
        expect(target.querySelector('.ont-dropghost')!.textContent).toContain('also under')

        // Released mid-drag: the wording has to follow, not stick.
        dragWith('dragOver', target, dt, false)
        const ghost = target.querySelector('.ont-dropghost')!
        expect(ghost.textContent).toContain('under Other')
        expect(ghost.textContent).not.toContain('also under')
      })

      it('refuses a parent the concept already has', async () => {
        // Filing Deepfakes under Security when it is already there would add
        // nothing. In MOVE mode that same row is refused too, but for a different
        // reason — so this pins the ⌘ path specifically.
        const onReparent = vi.fn()
        const { container } = panel(tree(), { onReparent })

        const grip = [...container.querySelectorAll('.ont-grip')]
          .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
        const itsParent = [...container.querySelectorAll('.ont-dropwrap')]
          .find((w) => w.textContent?.includes('Security'))!

        const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
        await startDrag(grip, dt)
        dragWith('dragOver', itsParent, dt, true)
        dragWith('drop', itsParent, dt, true)

        expect(onReparent).not.toHaveBeenCalled()
      })

      it('withdraws the top-level target, which only means anything as a move', async () => {
        const { container } = panel(tree())
        const grip = [...container.querySelectorAll('.ont-grip')]
          .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
        const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
        await startDrag(grip, dt)
        expect(container.querySelector('.ont-dragbar.targetable')).toBeTruthy()

        const target = [...container.querySelectorAll('.ont-dropwrap')]
          .find((w) => w.textContent?.includes('Other'))!
        dragWith('dragOver', target, dt, true)
        expect(container.querySelector('.ont-dragbar.targetable')).toBeNull()
      })
    })

    it('promotes to the top level when the bar is dropped on', async () => {
      // `to` is null — that IS "make it a root". The bar appearing is not the same
      // as the bar working, and only this asserts the second one.
      const onReparent = vi.fn()
      const { container } = panel(tree(), { onReparent })

      const grip = [...container.querySelectorAll('.ont-grip')]
        .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
      const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
      await startDrag(grip, dt)

      const bar = container.querySelector('.ont-dragbar.targetable')!
      fireEvent.dragOver(bar, { dataTransfer: dt })
      fireEvent.drop(bar, { dataTransfer: dt })

      expect(onReparent).toHaveBeenCalledWith('Deepfakes', 'Security', null)
    })

    it('shows the bar without a target when the concept is already a root', async () => {
      // `Autonomy` is a root. There is nowhere to promote it to, so the bar still
      // says what is moving but must not accept a drop — a target that does
      // nothing is worse than no target.
      const { container } = panel(tree())
      const grip = [...container.querySelectorAll('.ont-grip')]
        .find((g) => g.getAttribute('aria-label')?.includes('Autonomy'))!
      await startDrag(grip, { effectAllowed: '', setData: vi.fn() })

      expect(container.querySelector('.ont-dragbar')).toBeTruthy()
      expect(container.querySelector('.ont-dragbar.targetable')).toBeNull()
    })

    it('leaves the list still: nothing is inserted into the flow by a drag', async () => {
      // The bar and the ghost are both positioned, not in flow. This is what stops
      // the ontology jumping ~40px the moment a drag starts — and displacing the
      // drag source that way is also what made Safari abort the drag.
      const { container } = panel(tree())
      const rows = container.querySelector('.ont-rows')!
      const before = rows.children.length

      const grip = [...container.querySelectorAll('.ont-grip')]
        .find((g) => g.getAttribute('aria-label')?.includes('Deepfakes'))!
      const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => 'Deepfakes' }
      await startDrag(grip, dt)
      expect(rows.children.length).toBe(before)

      // ...and the ghost hangs off the target's own wrapper, not the card body.
      const target = [...container.querySelectorAll('.ont-dropwrap')]
        .find((w) => w.textContent?.includes('Other'))!
      fireEvent.dragOver(target, { dataTransfer: dt })
      expect(target.querySelector('.ont-dropghost')).toBeTruthy()
    })
  })
})
