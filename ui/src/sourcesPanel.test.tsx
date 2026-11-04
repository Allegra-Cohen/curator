// @vitest-environment jsdom
//
// The SOURCES window: following a feed, polling one, and what it tells the other
// windows.
//
// It runs in its own browser window, so everything it knows about the rest of the
// guide arrives over the `field-guide` channel and everything it changes has to go
// back out the same way. That makes it the same shape as the bug README todo 13
// records -- a message in the wrong handler is invisible to any test that doesn't
// watch the channel.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SourcesPanel from './components/SourcesPanel'
import {
  installFakeServer, installBroadcastChannel, source,
  type Channel, type FakeServer,
} from './testHarness'

describe('the sources window', () => {
  let server: FakeServer
  let channel: Channel

  beforeEach(() => {
    channel = installBroadcastChannel()
    server = installFakeServer({ sources: [source()] })
  })

  const events = () => channel.sent.map((m) => m.event)
  const row = () => within(document.querySelector('.source-row') as HTMLElement)

  it('follows the feed a page advertises, not the URL that was pasted', async () => {
    // People paste the post they were reading or the publication's front page --
    // the page/feed distinction is ours, not theirs. Following what was typed
    // produces a source that succeeds and then sits there quiet forever, so the
    // server resolves it and the window follows what came back.
    server.state.preview = {
      requested: 'https://importai.example/p/some-post',
      url: 'https://importai.example/feed',
      mechanism: 'rss', count: 3, publication: 'Import AI',
      titles: ['One', 'Two', 'Three'],
    }
    const user = userEvent.setup()
    render(<SourcesPanel />)
    await screen.findByRole('heading', { name: 'Sources' })

    await user.type(screen.getByPlaceholderText(/example.substack.com/),
                    'https://importai.example/p/some-post')
    await user.click(screen.getByRole('button', { name: 'Check' }))

    // It says so, because the curator is about to follow a URL they didn't write.
    await screen.findByText(/Found the feed for this page/)
    // The name is filled in from the publication rather than left to be typed.
    expect((screen.getByPlaceholderText('Name it') as HTMLInputElement).value)
      .toBe('Import AI')

    await user.click(screen.getByRole('button', { name: 'Follow' }))

    const followed = server.writes.find((w) => w.method === 'POST' && w.path === '/sources')
    expect(followed!.body.url).toBe('https://importai.example/feed')
    expect(followed!.body.mechanism).toBe('rss')
  })

  it('announces new documents after a poll that produced some', async () => {
    server.state.runResult = { ingested: 2, dropped: 1 }
    const user = userEvent.setup()
    render(<SourcesPanel />)
    await screen.findByRole('heading', { name: 'Sources' })
    channel.reset()

    await user.click(row().getByRole('button', { name: 'Run now' }))
    await screen.findByText(/2 queued, 1 filtered out/)

    // The main window is a separate document; without this its review queue stays
    // stale until someone reloads it.
    expect(events()).toEqual(['documents-ingested'])
  })

  it('says nothing after a poll that produced nothing', async () => {
    server.state.runResult = { ingested: 0, dropped: 4 }
    const user = userEvent.setup()
    render(<SourcesPanel />)
    await screen.findByRole('heading', { name: 'Sources' })
    channel.reset()

    await user.click(row().getByRole('button', { name: 'Run now' }))
    await screen.findByText(/0 queued, 4 filtered out/)

    // Nothing entered the review queue, so there is nothing for the main window to
    // refetch. Announcing anyway would make every empty poll look like new work.
    expect(events()).toEqual([])
  })

  it('forgets past screenings on Re-read, and tells nobody', async () => {
    server.state.rereadResult = { source: 'source-1', forgotten_screenings: 12 }
    const user = userEvent.setup()
    render(<SourcesPanel />)
    await screen.findByRole('heading', { name: 'Sources' })
    channel.reset()

    await user.click(row().getByRole('button', { name: 'Re-read' }))
    await screen.findByText(/Forgot 12 past screenings/)

    expect(server.writes.map((w) => `${w.method} ${w.path}`))
      .toEqual(['POST /sources/source-1/reread'])
    // Nothing has entered the graph yet -- the next poll is what reconsiders them.
    expect(events()).toEqual([])
  })

  it('turns a source off without touching anything else', async () => {
    const user = userEvent.setup()
    render(<SourcesPanel />)
    await screen.findByRole('heading', { name: 'Sources' })
    server.reset()

    await user.click(row().getByRole('checkbox'))
    await screen.findByText('Import AI')   // settle the re-render

    expect(server.writes.map((w) => `${w.method} ${w.path}`))
      .toEqual(['POST /sources/source-1/enabled'])
    expect(server.writes[0].body).toEqual({ enabled: false })
  })

  it('never shows an unreviewed source as 0% kept', async () => {
    // The rule this holds: no opinion must not render as all-rejected. A source
    // followed last night has produced documents nobody has judged; calling that
    // 0% would condemn it on the strength of the curator being asleep.
    server = installFakeServer({
      sources: [source({ stats: {
        produced: 5, accepted: 0, dismissed: 0, pending: 5, accept_rate: null } })],
    })
    render(<SourcesPanel />)
    await screen.findByRole('heading', { name: 'Sources' })

    expect(row().getByText(/5 awaiting review/)).toBeTruthy()
    expect(row().queryByText(/0% kept/)).toBeNull()
  })

  it('reloads when a document is filed in the main window', async () => {
    // Accept rate is derived from the documents a source produced, so reviewing or
    // dismissing one elsewhere moves this number.
    render(<SourcesPanel />)
    await screen.findByRole('heading', { name: 'Sources' })
    server.reset()

    channel.post('documents-changed')
    await new Promise((r) => setTimeout(r, 0))

    expect(server.requests.map((r) => r.path)).toContain('/sources')
  })
})
