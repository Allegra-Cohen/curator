// @vitest-environment jsdom
//
// The remark markdown renderer. What's worth pinning here is the DIALECT — a remark is
// written the way a blog post is, and the two have to agree on what each token means —
// plus the two tokens that aren't markdown at all: the `node:` link (a React button
// that routes in-app, not a URL) and `<Footnote>` (a stateful disclosure).
//
// jsdom renders this fine: it's all plain DOM, no measurement.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { renderMarkdown, parseBlocks } from './markdown'

// Several tests below reach for a footnote by its NUMBER, and numbering restarts per
// remark — so a leftover render from the previous test makes "Footnote 1" ambiguous.
// No global cleanup is configured for this suite, so it's declared here.
afterEach(cleanup)

const UID = '0f3a91c8-1111-2222-3333-444455556666'

/** Render a body with every link resolvable unless `known` says otherwise. */
function show(body: string, opts: {
  known?: string[]
  onOpen?: (id: string, paragraph?: number) => void
  linkLabel?: (id: string, paragraph?: number) => string | null
} = {}) {
  const linkLabel = opts.linkLabel ?? ((id: string) =>
    (opts.known ?? [UID]).includes(id) ? 'A linked thing' : null)
  const { container } = render(
    <div className="md-body">
      {renderMarkdown(body, linkLabel, opts.onOpen ?? (() => {}))}
    </div>,
  )
  return container
}

describe('block structure', () => {
  it('splits paragraphs on blank lines and joins wrapped ones', () => {
    const blocks = parseBlocks('one line\nwrapped onto two\n\nsecond para')
    expect(blocks.length).toBe(2)
    expect(blocks[0]).toEqual({ kind: 'p', lines: ['one line', 'wrapped onto two'] })
  })

  it('reads - as a bullet list and 1. as a numbered one', () => {
    const c = show('- first\n- second\n\n1. one\n2. two')
    expect(c.querySelectorAll('ul li').length).toBe(2)
    expect(c.querySelectorAll('ol li').length).toBe(2)
    expect(c.querySelector('ol li')?.textContent).toBe('one')
  })

  it('does not mistake a line opening with *italic* for a bullet', () => {
    // The space after the marker is the whole defence — `- x` is a bullet, `*x*` isn't.
    const c = show('*emphasis* opens this line')
    expect(c.querySelector('ul')).toBeNull()
    expect(c.querySelector('em')?.textContent).toBe('emphasis')
  })

  it('collapses heading depth to two tiers under the remark title', () => {
    const c = show('# section\n\n### subsection')
    expect(c.querySelector('h3')?.textContent).toBe('section')
    expect(c.querySelector('h4')?.textContent).toBe('subsection')
  })

  it('continues a list item across a wrapped line', () => {
    // Lazy continuation, and the reason it exists: a <Footnote> long enough to wrap is
    // written across two lines, and splitting the block there left the opening tag in
    // one and the closing tag in another — so neither matched and both rendered as
    // literal angle brackets inside the bullet.
    const c = show('- a claim<Footnote>an aside that runs\n  onto a second line</Footnote>\n- another')
    expect(c.querySelectorAll('li').length).toBe(2)
    expect(c.querySelectorAll('p').length).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Footnote 1' }))
    expect(screen.getByText(/onto a second line/)).toBeTruthy()
  })

  it('joins consecutive > lines into one quote', () => {
    const c = show('> a claim\n> continued')
    expect(c.querySelectorAll('blockquote').length).toBe(1)
    expect(c.querySelector('blockquote')?.textContent).toContain('continued')
  })
})

describe('tables', () => {
  it('reads a header, delimiter row, and body rows into a table', () => {
    const c = show('| Paper | Found? |\n|---|---|\n| One | yes |\n| Two | no |')
    const headers = Array.from(c.querySelectorAll('th')).map((t) => t.textContent)
    expect(headers).toEqual(['Paper', 'Found?'])
    const rows = Array.from(c.querySelectorAll('tbody tr')).map(
      (r) => Array.from(r.querySelectorAll('td')).map((d) => d.textContent),
    )
    expect(rows).toEqual([['One', 'yes'], ['Two', 'no']])
  })

  it('does not mistake an ordinary pipe in prose for a table', () => {
    const c = show('cats | dogs, not a table')
    expect(c.querySelector('table')).toBeNull()
    expect(c.querySelector('p')?.textContent).toBe('cats | dogs, not a table')
  })

  it('reads an escaped \\| as a literal pipe inside a cell', () => {
    const c = show('| a |\n|---|\n| x \\| y |')
    expect(c.querySelector('td')?.textContent).toBe('x | y')
  })

  it('renders inline marks inside cells', () => {
    const c = show('| a |\n|---|\n| **bold** |')
    expect(c.querySelector('td strong')?.textContent).toBe('bold')
  })

  it('ends the table at a blank line or a non-row line', () => {
    const c = show('| a |\n|---|\n| one |\n\nafter')
    expect(c.querySelectorAll('tbody tr').length).toBe(1)
    expect(c.querySelector('p')?.textContent).toBe('after')
  })
})

describe('inline marks', () => {
  it('reads **bold**, *italic* and ~~struck~~', () => {
    const c = show('**loud** and *soft* and ~~gone~~')
    expect(c.querySelector('strong')?.textContent).toBe('loud')
    expect(c.querySelector('em')?.textContent).toBe('soft')
    expect(c.querySelector('del')?.textContent).toBe('gone')
  })

  it('does not read **bold** as two italics', () => {
    // Alternation order: `**` is tried before `*` at each position.
    const c = show('**both**')
    expect(c.querySelector('strong')?.textContent).toBe('both')
    expect(c.querySelector('em')).toBeNull()
  })

  it('nests marks, and a link inside emphasis keeps both', () => {
    const c = show('**bold with [a link](https://example.com) inside**')
    const a = c.querySelector('strong a') as HTMLAnchorElement
    expect(a.textContent).toBe('a link')
    expect(a.href).toBe('https://example.com/')
  })
})

describe('links', () => {
  it('takes a hand-written <a href>, spaces around the = included', () => {
    // Real posts contain `<a href= "…">`; the parser tolerates the spacing rather
    // than silently rendering the tag as text.
    const c = show('see <a href= "https://example.com/garden">the garden</a> for more')
    const a = c.querySelector('a') as HTMLAnchorElement
    expect(a.textContent).toBe('the garden')
    expect(a.href).toBe('https://example.com/garden')
  })

  it('opens an external link in a new tab and an in-app one in place', () => {
    const c = show('[out](https://example.com) and [in](/sources)')
    const [out, inn] = Array.from(c.querySelectorAll('a'))
    expect(out.target).toBe('_blank')
    expect(out.rel).toBe('noreferrer')
    expect(inn.target).toBe('')
  })

  it('leaves any other tag as literal text — no HTML is interpreted', () => {
    // The dialect understands exactly two tags. Everything else is prose, which is
    // what makes this safe without a sanitizer.
    const c = show('<script>alert(1)</script> and <b>not bold</b>')
    expect(c.querySelector('script')).toBeNull()
    expect(c.querySelector('b')).toBeNull()
    expect(c.textContent).toContain('<script>alert(1)</script>')
    expect(c.textContent).toContain('<b>not bold</b>')
  })
})

describe('node links', () => {

  it('degrades a dangling link to plain text, never a dead link', () => {
    const c = show('[missing](node:not-a-uuid)', { known: [] })
    expect(c.querySelector('button')).toBeNull()
    expect(c.textContent).toBe('missing')
  })

  it('does not confuse a node link with an ordinary markdown link', () => {
    const c = show(`[linked](node:${UID}) vs [external](https://example.com)`)
    expect(c.querySelectorAll('button.cite-link').length).toBe(1)
    expect(c.querySelectorAll('a').length).toBe(1)
  })
})

describe('footnotes', () => {
  it('numbers notes in reading order and opens one on click', () => {
    show('First<Footnote>note one</Footnote> then second<Footnote>note two</Footnote>')
    const marks = screen.getAllByRole('button', { name: /^Footnote/ })
    expect(marks.map((m) => m.textContent)).toEqual(['1', '2'])

    // Closed by default — a remark reads clean until you ask for the aside.
    expect(screen.queryByText(/note two/)).toBeNull()
    fireEvent.click(marks[1])
    expect(screen.getByText(/note two/)).toBeTruthy()
    expect(screen.queryByText(/note one/)).toBeNull()
    fireEvent.click(marks[1])
    expect(screen.queryByText(/note two/)).toBeNull()
  })

  it('renders markup inside a note', () => {
    const c = show('Claim<Footnote>see **the appendix**</Footnote>')
    fireEvent.click(screen.getByRole('button', { name: 'Footnote 1' }))
    expect(c.querySelector('.fn-note strong')?.textContent).toBe('the appendix')
  })

  it('keeps numbering across blocks, and inside a list item', () => {
    show('Para<Footnote>a</Footnote>\n\n- item<Footnote>b</Footnote>')
    const marks = screen.getAllByRole('button', { name: /^Footnote/ })
    expect(marks.map((m) => m.textContent)).toEqual(['1', '2'])
    expect(marks[1].closest('li')).toBeTruthy()
  })
})
