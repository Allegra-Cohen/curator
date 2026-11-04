// @vitest-environment jsdom
//
// The SCOPE window: the guide's scope statement.
//
// Small, and more load-bearing than it looks. This text is prepended to EVERY
// discovery screening call, so it decides what search accepts as much as the
// concept descriptions do. It used to be a constant inside `relevance_filter.py`,
// which meant the filter rejected papers on wording the curator had never written
// and could not see. Surfacing it is the whole feature, and `is_default` is the
// part that says whether they're looking at their own words or the built-in ones.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ScopePanel from './components/ScopePanel'
import { installFakeServer, installBroadcastChannel, type FakeServer } from './testHarness'

describe('the scope window', () => {
  let server: FakeServer

  beforeEach(() => {
    installBroadcastChannel()
    server = installFakeServer()
  })

  it('warns while screening is still running on the built-in wording', async () => {
    render(<ScopePanel />)
    expect(await screen.findByText(/No scope has been saved yet/)).toBeTruthy()
    // The default text is shown rather than an empty box, so the curator edits what
    // is actually in force instead of guessing at it.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value)
      .toBe('The built-in default scope.')
  })

  it('writes nothing until Save is pressed, then stops warning', async () => {
    const user = userEvent.setup()
    render(<ScopePanel />)
    await screen.findByRole('textbox')
    server.reset()

    const box = screen.getByRole('textbox')
    await user.clear(box)
    await user.type(box, 'Human cognition, not AI methods for their own sake.')

    // Typing is not saving. The button becomes available and the window says so.
    expect(server.writes).toEqual([])
    expect(screen.getByText('Unsaved changes')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save scope' }))

    await waitFor(() => expect(screen.queryByText(/No scope has been saved yet/)).toBeNull())
    expect(server.writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PUT /scope'])
    expect(server.writes[0].body)
      .toEqual({ body: 'Human cognition, not AI methods for their own sake.' })
  })

  it('will not save an unchanged or empty scope', async () => {
    const user = userEvent.setup()
    render(<ScopePanel />)
    await screen.findByRole('textbox')

    // Nothing edited yet: saving would rewrite the default as though it were the
    // curator's own, and `is_default` would stop warning about wording nobody chose.
    const saveButton = () =>
      screen.getByRole('button', { name: 'Save scope' }) as HTMLButtonElement
    expect(saveButton().disabled).toBe(true)

    await user.clear(screen.getByRole('textbox'))
    expect(saveButton().disabled).toBe(true)
  })
})
