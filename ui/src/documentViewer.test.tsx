// @vitest-environment jsdom
//
// The reading pane.
//
// No full text is stored, so opening a document re-fetches its URL and renders
// cleaned paragraphs. That fetch can never succeed on a paywalled paper, which is
// why the `abstract` the search API supplied matters so much: for those documents
// it is the entire review surface, and without it the curator has nothing to judge
// from at all. Hence the hand-entry path — a human can often reach an abstract a
// bot blocker denied us.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentViewer from './components/DocumentViewer'
import {
  installFakeServer, installBroadcastChannel, queuedDocument, type FakeServer,
} from './testHarness'

describe('the reading pane', () => {
  let server: FakeServer

  beforeEach(() => {
    installBroadcastChannel()
    server = installFakeServer()
  })

  it('renders the fetched text under the abstract', async () => {
    const doc = queuedDocument()
    render(<DocumentViewer doc={doc} />)

    expect(await screen.findByText('First paragraph.')).toBeTruthy()
    expect(screen.getByText('An abstract.')).toBeTruthy()
    // Both, not one: extraction picks up navigation furniture often enough that the
    // author's own summary earns its place even when the fetch worked.
    expect(screen.getByText('Second paragraph.')).toBeTruthy()
  })

  it('says the milder thing about a failed fetch when there is an abstract', async () => {
    server.state.readable = {
      url: 'https://example.org/paper', ok: false,
      reason: 'paywalled', paragraphs: [],
    }
    render(<DocumentViewer doc={queuedDocument()} />)

    // With an abstract in hand a failed fetch is not a dead end.
    expect(await screen.findByText(/reviewing from the abstract/)).toBeTruthy()
    expect(screen.queryByText('paywalled')).toBeNull()
  })

  it('gives the raw reason when there is no abstract to fall back on', async () => {
    server.state.readable = {
      url: 'https://example.org/paper', ok: false,
      reason: 'blocked by the publisher', paragraphs: [],
    }
    const doc = queuedDocument()
    doc.attributes.abstract = ''
    render(<DocumentViewer doc={doc} />)

    // Nothing to review from, so the reason is all the curator gets — and it's what
    // tells them whether pasting an abstract by hand is worth trying.
    expect(await screen.findByText('blocked by the publisher')).toBeTruthy()
  })

  it('takes an abstract by hand when the scrape got none', async () => {
    const doc = queuedDocument()
    doc.attributes.abstract = ''
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(<DocumentViewer doc={doc} onAbstractSaved={onSaved} />)

    const textarea = await screen.findByPlaceholderText(/Paste the abstract/)
    server.reset()

    await user.type(textarea, 'What the paper actually says.')
    // Typing writes nothing; only blur (or explicit save) does.
    expect(server.writes).toEqual([])

    await user.tab()

    expect(server.writes.map((w) => `${w.method} ${w.path}`))
      .toEqual(['PATCH /documents/doc-1/abstract'])
    expect(server.writes[0].body).toEqual({ abstract: 'What the paper actually says.' })
    // The panel above re-seeds from the returned document rather than refetching.
    expect(onSaved).toHaveBeenCalled()
  })

  it('does not carry a half-typed abstract into the next document', async () => {
    // These panes are swapped by clicking a different row, and a draft that survived
    // would offer one document's text as another's.
    const first = queuedDocument({ id: 'doc-1' })
    first.attributes.abstract = ''
    const second = queuedDocument({ id: 'doc-2' })
    second.attributes.abstract = ''

    const user = userEvent.setup()
    const { rerender } = render(<DocumentViewer doc={first} />)
    const textarea = await screen.findByPlaceholderText(/Paste the abstract/)
    await user.type(textarea, 'half a thought')

    rerender(<DocumentViewer doc={second} />)

    // After switching documents, the textarea should be empty again
    expect(screen.queryByDisplayValue('half a thought')).toBeNull()
    expect((screen.getByPlaceholderText(/Paste the abstract/) as HTMLTextAreaElement).value).toBe('')
  })

  // Organization mode. The mode's whole promise is that nothing done in it writes the
  // graph, and a promise with one exception in it is a promise nobody can rely on — so
  // the abstract, the viewer's only editable thing, is uneditable there too.
  it('will not write an abstract when it is read-only', async () => {
    const doc = queuedDocument()
    doc.attributes.abstract = ''
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(<DocumentViewer doc={doc} onAbstractSaved={onSaved} readOnly />)

    const textarea = await screen.findByPlaceholderText('No abstract.') as HTMLTextAreaElement
    expect(textarea.readOnly).toBe(true)
    server.reset()

    await user.click(textarea)
    await user.keyboard('smuggled in')
    await user.tab()

    expect(textarea.value).toBe('')
    expect(server.writes).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
  })

  // The same document, read-only: still readable, still linkable out. Read-only is
  // about writing the graph, not about being less useful to read from.
  it('still shows the abstract and the source links when read-only', async () => {
    const doc = queuedDocument()
    doc.attributes.oa_pdf_url = 'https://example.org/paper.pdf'
    render(<DocumentViewer doc={doc} readOnly />)

    expect(await screen.findByText('First paragraph.')).toBeTruthy()
    expect(screen.getByText('An abstract.')).toBeTruthy()
    expect(screen.getByText('Open original ↗')).toBeTruthy()
    expect(screen.getByText('Free PDF ↗')).toBeTruthy()
  })

  // A quote clicked elsewhere in the app (an evidence-table cell) opens the document
  // here with a target paragraph number attached -- see markdown.tsx's #p<N> links.
  // jsdom doesn't implement scrollIntoView at all, so it's stubbed for the duration
  // of these two tests and put back exactly as it was (undefined) afterward.
  it('scrolls to and briefly highlights the paragraph a quote points at', async () => {
    const original = Element.prototype.scrollIntoView
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    try {
      render(<DocumentViewer doc={queuedDocument()} scrollToParagraph={2} />)

      const p = await screen.findByText('Second paragraph.')
      expect(scrollSpy).toHaveBeenCalled()
      expect(p.className).toContain('readable-highlight')
      // The other paragraph is untouched.
      expect(screen.getByText('First paragraph.').className).not.toContain('readable-highlight')
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('does nothing when the target paragraph no longer exists in the live text', async () => {
    const original = Element.prototype.scrollIntoView
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    try {
      render(<DocumentViewer doc={queuedDocument()} scrollToParagraph={99} />)

      await screen.findByText('Second paragraph.')
      expect(scrollSpy).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('offers the free PDF only when one exists', async () => {
    const without = queuedDocument()
    const { rerender } = render(<DocumentViewer doc={without} />)
    await screen.findByText('Open original ↗')
    expect(screen.queryByText(/Free PDF/)).toBeNull()

    const with_ = queuedDocument({ id: 'doc-2' })
    with_.attributes.oa_pdf_url = 'https://example.org/paper.pdf'
    rerender(<DocumentViewer doc={with_} />)

    // Worth reaching for over the original, which may well be paywalled.
    const pdf = await screen.findByText('Free PDF ↗')
    expect(pdf.getAttribute('href')).toBe('https://example.org/paper.pdf')
  })
})
