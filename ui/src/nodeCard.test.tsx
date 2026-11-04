// @vitest-environment jsdom
//
// The person / organization card.
//
// This is where a one-click accept gets corrected. Crediting a scraped author is
// one click, and the kind it lands as is guessed from the name, so a create nobody
// confirmed has to be fixable afterwards or the click is just a faster way to be
// wrong. Two things follow, and both are tested below:
//
//   * A rename is graph-wide. One node carries every `authored_by` edge, so
//     renaming here moves every chip and every pivot row bearing that name. The
//     card says so with the count, because it is usually opened from one document
//     and the edit naturally reads as local.
//   * A retype happens IN PLACE. The node keeps its id, so every `authored_by`
//     edge survives -- which is exactly what delete-and-recreate would lose, and
//     why the ENTITIES window steers people here instead.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NodeCard from './components/NodeCard'
import {
  installFakeServer, installBroadcastChannel, personNode, source,
  type Channel, type FakeServer,
} from './testHarness'

const JANE = personNode('person-jane', 'Jane Doe')
JANE.attributes.orcid = '0000-0002-1825-0097'

const CHT = { id: 'org-cht', label: 'Center for Humane Technology',
              type: 'organization', attributes: {} } as any

const janeDetail = {
  id: 'person-jane', label: 'Jane Doe', type: 'person',
  attributes: { orcid: '0000-0002-1825-0097' },
  affiliations: [], writes_at: [],
  documents: [{ id: 'doc-1', label: 'A Paper' }, { id: 'doc-2', label: 'Another Paper' }],
} as any

const props = { allOrgs: [{ id: 'org-cht', label: 'Center for Humane Technology' }],
                onChanged: () => {}, onOpenDocuments: () => {}, onError: () => {} }

describe('the entity card', () => {
  let server: FakeServer
  let channel: Channel

  beforeEach(() => {
    channel = installBroadcastChannel()
    server = installFakeServer({
      entityDetails: { 'person-jane': janeDetail },
      sources: [source({ id: 'source-1', label: 'Import AI' })],
    })
  })

  const events = () => channel.sent.map((m) => m.event)

  it('renders the name field', async () => {
    render(<NodeCard {...props} node={JANE} />)
    expect(await screen.findByDisplayValue('Jane Doe')).toBeTruthy()
  })

  it('writes nothing while the name is being edited', async () => {
    const user = userEvent.setup()
    render(<NodeCard {...props} node={JANE} />)
    await screen.findByDisplayValue('Jane Doe')
    server.reset()

    await user.type(screen.getByDisplayValue('Jane Doe'), 'e')

    expect(server.writes).toEqual([])
    expect(events()).toEqual([])
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('renames on Save, and tells every other window', async () => {
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(<NodeCard {...props} node={JANE} onChanged={onChanged} />)
    await screen.findByDisplayValue('Jane Doe')
    server.reset()
    channel.reset()

    // Name first, then ORCID -- neither input has a linked label, so position is
    // the only stable handle.
    const nameInput = screen.getAllByRole('textbox')[0]
    await user.clear(nameInput)
    await user.type(nameInput, 'Jane Q. Doe')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() =>
      expect(server.writes.map((w) => `${w.method} ${w.path}`))
        .toEqual(['PATCH /people/person-jane']))
    expect(server.writes[0].body).toMatchObject({ full_name: 'Jane Q. Doe' })
    // The ENTITIES window lists this name; the main window's pivots are built on it.
    expect(events()).toEqual(['entities-changed'])
    expect(onChanged).toHaveBeenCalled()
  })

  it('asks before retyping, and warns that the ORCID goes', async () => {
    const user = userEvent.setup()
    render(<NodeCard {...props} node={JANE} />)
    await screen.findByDisplayValue('Jane Doe')
    server.reset()

    await user.click(screen.getByRole('button',
      { name: /This is an organization, not a person/ }))

    // Confirming is a separate press, and nothing has been written yet.
    expect(await screen.findByText(/The node keeps its id/)).toBeTruthy()
    expect(screen.getByText(/Its ORCID will be dropped/)).toBeTruthy()
    expect(server.writes).toEqual([])
  })

  it('retypes in place so the authored_by edges survive', async () => {
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(<NodeCard {...props} node={JANE} onChanged={onChanged} />)
    await screen.findByDisplayValue('Jane Doe')
    server.reset()
    channel.reset()

    await user.click(screen.getByRole('button',
      { name: /This is an organization, not a person/ }))
    await user.click(await screen.findByRole('button',
      { name: /Yes, make it an organization/ }))

    await vi.waitFor(() =>
      expect(server.writes.map((w) => `${w.method} ${w.path}`))
        .toEqual(['POST /entities/person-jane/retype']))
    // In place: the same id, so nothing it is credited on is disturbed. A delete
    // and recreate would silently drop all of it.
    expect(server.writes[0].body).toEqual({ to_type: 'organization' })
    expect(events()).toEqual(['entities-changed'])
    expect(onChanged).toHaveBeenCalled()
  })

  it('offers an ORCID and an affiliation only for a person', async () => {
    const { rerender } = render(<NodeCard {...props} node={JANE} />)
    await screen.findByDisplayValue('Jane Doe')
    expect(screen.getByPlaceholderText('0000-0002-1825-0097')).toBeTruthy()
    expect(screen.getByText('Organization')).toBeTruthy()

    rerender(<NodeCard {...props} node={CHT} />)

    // An organization has neither: it doesn't work anywhere, and it has no ORCID.
    await screen.findByDisplayValue('Center for Humane Technology')
    expect(screen.queryByPlaceholderText('0000-0002-1825-0097')).toBeNull()
    expect(screen.queryByText('Organization')).toBeNull()
    // `writes_at` is not person-only -- it runs person OR organization -> source.
    expect(screen.getByText('Writes at')).toBeTruthy()
  })

  it('sets the affiliation and the writes-at as whole lists, not deltas', async () => {
    const user = userEvent.setup()
    render(<NodeCard {...props} node={JANE} />)
    await screen.findByDisplayValue('Jane Doe')
    server.reset()

    // Both start unset, so each field shows its search box: type, then pick.
    await user.type(screen.getByPlaceholderText('Search organizations…'), 'Humane')
    await user.click(await screen.findByRole(
      'button', { name: 'Center for Humane Technology' }))

    await vi.waitFor(() => expect(server.writes.length).toBeGreaterThan(0))
    // Set semantics, matching /authors and /concepts: the whole set, never a delta.
    // The UI offers one, but the service underneath takes a list.
    expect(server.writes[0].body).toEqual({ affiliation_ids: ['org-cht'] })

    server.reset()
    await user.type(screen.getByPlaceholderText('Search followed sources…'), 'Import')
    await user.click(await screen.findByRole('button', { name: 'Import AI' }))

    await vi.waitFor(() => expect(server.writes.length).toBeGreaterThan(0))
    expect(server.writes[0].body).toEqual({ source_ids: ['source-1'] })
  })

  // The single-valued half of the picker. With the search box still on screen next
  // to a set value, picking a second one would silently discard the first and
  // nothing would say so -- so the chip replaces the box, and ✕ is the way back.
  it('shows a set affiliation as a chip instead of a search box, and clears it', async () => {
    const user = userEvent.setup()
    server = installFakeServer({
      entityDetails: {
        'person-jane': {
          ...janeDetail,
          affiliations: [{ id: 'org-cht', label: 'Center for Humane Technology' }],
        },
      },
      sources: [source({ id: 'source-1', label: 'Import AI' })],
    })
    render(<NodeCard {...props} node={JANE} />)

    await screen.findByText('Center for Humane Technology')
    expect(screen.queryByPlaceholderText('Search organizations…')).toBeNull()
    server.reset()

    // By title, not by name: the button's content is ✕, which is what the
    // accessible name computes to — matching the chips everywhere else.
    await user.click(screen.getByTitle('Clear'))

    // Clearing is the same set-semantics write, with an empty list.
    await vi.waitFor(() => expect(server.writes.length).toBeGreaterThan(0))
    expect(server.writes[0].body).toEqual({ affiliation_ids: [] })
  })

  it('hands over the whole body of work, not the one title clicked', async () => {
    // An author's other papers are the useful thing to land in, and it matches how
    // a concept's documents already behave.
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(<NodeCard {...props} node={JANE} onOpenDocuments={onOpen} />)
    await screen.findByText('Credited on (2)')

    await user.click(screen.getByRole('button', { name: 'Another Paper' }))

    expect(onOpen).toHaveBeenCalledWith('Jane Doe', ['doc-1', 'doc-2'], 'doc-2')
  })
})
