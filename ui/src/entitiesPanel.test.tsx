// @vitest-environment jsdom
//
// The ENTITIES window: every person and organization the guide knows about.
//
// This window deliberately FINDS things and does not fix them. A rename shifts
// every pivot row bearing that name, so corrections happen on the card in the main
// window where that consequence is visible -- which means clicking a row here has
// to ask the other window to open it, over the `field-guide` channel, and do
// nothing else. That is a wiring behaviour, invisible to any test that doesn't
// watch the channel.
//
// Creating is the exception, and the one place `EntityDialog` still writes
// immediately: there is no document here to save, so nothing would ever create the
// node later. The test below pins that, so a future sweep of "nothing writes before
// Save" doesn't take it out on the assumption that all four call sites are alike.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EntitiesPanel from './components/EntitiesPanel'
import {
  installFakeServer, installBroadcastChannel, entityRow,
  type Channel, type FakeServer,
} from './testHarness'

const JANE = entityRow({ id: 'person-jane', label: 'Jane Doe', type: 'person',
                         orcid: '0000-0002-1825-0097', documents: 3 })
const CHT = entityRow({ id: 'org-cht', label: 'Center for Humane Technology',
                        type: 'organization', documents: 0 })

describe('the entities window', () => {
  let server: FakeServer
  let channel: Channel

  beforeEach(() => {
    channel = installBroadcastChannel()
    server = installFakeServer({ entities: [JANE, CHT] })
  })

  const events = () => channel.sent.map((m) => m.event)

  it('asks the main window to open a row, and changes nothing itself', async () => {
    const user = userEvent.setup()
    render(<EntitiesPanel />)
    await screen.findByRole('button', { name: 'Jane Doe' })
    server.reset()
    channel.reset()

    await user.click(screen.getByRole('button', { name: 'Jane Doe' }))

    expect(channel.sent).toEqual([{ event: 'open-entity', payload: JANE.id }])
    expect(server.writes).toEqual([])
  })

  it('counts entities credited on nothing', async () => {
    // The shape of every bug this area has had -- 1022 of 1037 person nodes with no
    // live edge -- so it's a headline number rather than something to go looking for.
    render(<EntitiesPanel />)
    await screen.findByRole('button', { name: 'Jane Doe' })

    expect(screen.getByText(/1 credited on nothing/)).toBeTruthy()
    // And the row itself says so in words, not as a bare 0.
    const cht = screen.getByRole('button', { name: /Center for Humane Technology/ })
      .closest('tr') as HTMLElement
    expect(within(cht).getByText('nothing')).toBeTruthy()
  })

  it('filters by name and by ORCID', async () => {
    const user = userEvent.setup()
    render(<EntitiesPanel />)
    await screen.findByRole('button', { name: 'Jane Doe' })

    const box = screen.getByPlaceholderText(/Search by name or ORCID/)
    await user.type(box, 'humane')
    expect(screen.queryByRole('button', { name: 'Jane Doe' })).toBeNull()

    await user.clear(box)
    // Searching the ORCID is the point of showing it: it's how you find the person
    // whose name you can't spell the same way twice.
    await user.type(box, '0000-0002-1825')
    expect(screen.getByRole('button', { name: 'Jane Doe' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Center for Humane Technology/ }))
      .toBeNull()
  })

  it('deletes an entity and tells both other windows', async () => {
    const user = userEvent.setup()
    render(<EntitiesPanel />)
    await screen.findByRole('button', { name: 'Jane Doe' })
    channel.reset()
    server.reset()

    const jane = screen.getByRole('button', { name: 'Jane Doe' })
      .closest('tr') as HTMLElement
    await user.click(within(jane).getByRole('button', { name: 'Delete' }))

    // The dialog says what goes with it, and steers towards retyping -- deleting
    // and recreating is the tempting wrong move and it drops every `authored_by`.
    await screen.findByText(/credited on 3 documents/i)
    expect(screen.getByText(/retyping keeps the credits/)).toBeTruthy()

    const dialog = document.querySelector('.modal.danger') as HTMLElement
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Jane Doe' })).toBeNull())

    expect(server.writes.map((w) => `${w.method} ${w.path}`))
      .toEqual(['DELETE /entities/person-jane'])
    // Three messages, for three different staleness problems: something is still
    // *showing* this node (and only the id says which one), the pivots lost a node,
    // and every document that credited them lost a chip.
    expect(channel.sent).toEqual([
      { event: 'entity-deleted', payload: JANE.id },
      { event: 'entities-changed', payload: undefined },
      { event: 'documents-changed', payload: undefined },
    ])
  })

  it('creates an entity here and now, then asks for it to be opened', async () => {
    const user = userEvent.setup()
    render(<EntitiesPanel />)
    await screen.findByRole('button', { name: 'Jane Doe' })
    channel.reset()
    server.reset()

    await user.click(screen.getByRole('button', { name: 'New entity' }))
    await user.type(await screen.findByPlaceholderText(/Full name/), 'Alan Baddeley')
    await user.click(screen.getByRole('button', { name: 'Create person' }))

    // Unlike the document panel, this writes straight away: there is no Save here
    // to defer to, and an entity created in this window has nothing to attach to.
    expect(server.writes.map((w) => `${w.method} ${w.path}`)).toEqual(['POST /people'])
    // The new node is opened in the main window, because this one has no card.
    expect(events()).toEqual(['entities-changed', 'open-entity'])
  })

  it('warns before making a second entity with a name already in the guide', async () => {
    const user = userEvent.setup()
    render(<EntitiesPanel />)
    await screen.findByRole('button', { name: 'Jane Doe' })
    server.reset()

    await user.click(screen.getByRole('button', { name: 'New entity' }))
    await user.type(await screen.findByPlaceholderText(/Full name/), 'jane doe')

    // Case-insensitive and exact, matching how the server proposes. A warning, not
    // a block: two people genuinely do share a name.
    expect(await screen.findByText(/is already in the guide/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create person' })).toBeTruthy()
    expect(server.writes).toEqual([])
  })

  it('reloads when an entity is corrected in the main window', async () => {
    render(<EntitiesPanel />)
    await screen.findByRole('button', { name: 'Jane Doe' })
    server.reset()

    channel.post('entities-changed')
    await new Promise((r) => setTimeout(r, 0))

    expect(server.requests.map((r) => r.path)).toContain('/entities')
  })
})
