import { useState } from 'react'
import { LINK_PATTERN } from './links'

// Remark prose, rendered. A remark's body is written as MARKDOWN in the curator's
// textarea and stored as text, so the formatting has to be resolved at READ time —
// which is why this is a runtime renderer and not a build step.
//
// The dialect is deliberately the same one the blog's MDX posts use, so a remark can be
// written the way a post is:
//
//   # / ## heading        ### / #### subheading
//   - bullet              1. numbered
//   > quote
//   *italic*  **bold**  ~~struck~~
//   [text](https://…)  or  <a href="https://…">text</a>
//   <Footnote>an aside</Footnote>
//   [anchor](node:<uuid>) — a link to anything in the guide (`doc:` is the legacy
//                           spelling of the same thing, still read; see links.ts)
//   | a | table |          a header row, then a `|---|---|` divider of the same
//   |---|---|              width, then one or more `| cell | cell |` body rows —
//   | row  | here |        the one GFM shape this dialect understands. A literal
//                          `|` inside a cell is written `\|`.
//
// WHY IT'S HAND-WRITTEN rather than `marked` + a sanitizer. Two of those tokens aren't
// markdown at all: a node link has to become a React button that calls `onOpen` (it
// routes inside the app, it is not a URL), and `<Footnote>` has to become a stateful
// component. Both would mean parsing markdown to HTML and then re-parsing the HTML to
// find them again. Going straight to React nodes also means NO `dangerouslySetInnerHTML`
// anywhere: the only raw HTML understood is `<a href>`, and every other `<` in a body is
// literal text, so there's no injection surface to sanitize in the first place.
//
// NOT supported, on purpose: images, nested lists, inline code, HTML beyond `<a>`. All
// of them either sit badly in a ~360px pane or need a real decision first.

// --- blocks ----------------------------------------------------------------

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }

const HEADING = /^(#{1,4})\s+(.*)$/
// The space after the marker is what keeps `*italic*` at the start of a line from
// reading as a bullet — a bullet is `- x` or `* x`, never `*x`.
const BULLET = /^[-*]\s+(.*)$/
const NUMBERED = /^\d+[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
// A delimiter cell: optional colons (alignment, read and ignored — this dialect has no
// per-column alignment) around one or more dashes. `---`, `:---`, `:---:` all match.
const DELIMITER_CELL = /^:?-+:?$/

/** Split one `| a | b |` line into cells. Leading/trailing pipes are optional and
 *  stripped; `\|` inside a cell is an escaped, literal pipe, not a divider. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (c === '\\' && trimmed[i + 1] === '|') { cur += '|'; i++; continue }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  cells.push(cur.trim())
  return cells
}

/** Group lines into blocks. A blank line ends whatever was open; consecutive lines of
 *  the same kind join (so a wrapped paragraph is one paragraph, and three `-` lines are
 *  one list). Indentation is ignored — there are no nested lists in this dialect.
 *
 *  LAZY CONTINUATION, which is not optional: a line that starts no new block, arriving
 *  while a list or quote is open, continues the last item rather than starting a
 *  paragraph. CommonMark works this way and so does the blog's remark pipeline, but the
 *  reason it has to be here is `<Footnote>`: a note long enough to wrap is written
 *  across two lines inside a bullet, and splitting there put the opening tag in one
 *  block and the closing tag in another, so NEITHER half matched and both showed up as
 *  literal angle brackets. */
export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = []
  let open = false                                   // is the last block still taking lines?
  const top = () => blocks[blocks.length - 1]

  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim()
    if (line === '') { open = false; continue }

    // A table only starts here if THIS line and the next both look like rows, and the
    // next is specifically a delimiter row of the same width — a lone `|` in prose (a
    // pipe used as punctuation) never satisfies that pair, so it's never misread.
    if (line.includes('|')) {
      const header = splitTableRow(line)
      const next = lines[idx + 1] !== undefined ? splitTableRow(lines[idx + 1].trim()) : null
      // A single `|` used as punctuation never has a delimiter row (all dashes/colons,
      // same column count) right after it — that pairing is the actual safeguard, so a
      // one-column table is just as safe to accept as a wider one.
      if (next && next.length === header.length
          && next.every((c) => DELIMITER_CELL.test(c))) {
        const rows: string[][] = []
        let j = idx + 2
        for (; j < lines.length; j++) {
          const rowLine = lines[j].trim()
          if (rowLine === '' || !rowLine.includes('|')) break
          rows.push(splitTableRow(rowLine))
        }
        blocks.push({ kind: 'table', header, rows })
        idx = j - 1
        open = false
        continue
      }
    }

    const h = HEADING.exec(line)
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] })
      open = false                                   // a heading never absorbs the next line
      continue
    }

    const q = QUOTE.exec(line)
    if (q) {
      const t = top()
      if (open && t?.kind === 'quote') t.lines.push(q[1])
      else blocks.push({ kind: 'quote', lines: [q[1]] })
      open = true
      continue
    }

    const b = BULLET.exec(line)
    const n = b ? null : NUMBERED.exec(line)
    if (b || n) {
      const kind = b ? 'ul' : 'ol'
      const t = top()
      if (open && t?.kind === kind) t.items.push((b ?? n!)[1])
      else blocks.push({ kind, items: [(b ?? n!)[1]] })
      open = true
      continue
    }

    const t = top()
    if (open && t) {
      if (t.kind === 'p' || t.kind === 'quote') { t.lines.push(line); continue }
      if (t.kind === 'ul' || t.kind === 'ol') {
        t.items[t.items.length - 1] += ` ${line}`
        continue
      }
    }
    blocks.push({ kind: 'p', lines: [line] })
    open = true
  }
  return blocks
}

// --- inline ----------------------------------------------------------------

// ONE alternation, scanned left to right, so every token is found in a single pass and
// no token can be produced inside another one's text by a second pass. Order matters:
// `**` must be tried before `*` (alternation is first-match at each position), and the
// node link before the general link (a node link IS a link whose href is `node:…`).
//
// Group map — the matched branch is identified by which group came back defined:
//   1 footnote body · 2 href + 3 text · 4 anchor + 5 node id + 6 paragraph number
//   7 text + 8 url · 9 bold · 10 italic · 11 struck
const INLINE = new RegExp([
  '<Footnote>([\\s\\S]*?)<\\/Footnote>',
  // `href = "…"` with spaces around the `=` is written in real posts, so the spacing
  // is optional here rather than exact. Attributes after href are tolerated and dropped.
  '<a\\s+href\\s*=\\s*["\']([^"\']*)["\'][^>]*>([\\s\\S]*?)<\\/a>',
  LINK_PATTERN,
  '\\[([^\\]]*)\\]\\(([^)\\s]+)\\)',
  '\\*\\*([\\s\\S]+?)\\*\\*',
  '\\*([^*\\n]+?)\\*',
  '~~([\\s\\S]+?)~~',
].join('|'), 'g')

/** What the inline scanner needs from the prose around it: how to resolve a node link,
 *  and a running footnote number. `note()` is a mutable counter rather than an index
 *  computed from the DOM (the blog reads document order, which it can, being one page) —
 *  here the numbering is per-remark and the render is a pure pass, so counting as we go
 *  is both simpler and stable across re-renders. */
interface Ctx {
  // `paragraph` is the link's #p<N> suffix, when it has one (see links.ts) — most
  // callers ignore the second argument entirely; ChatPane is the one place that
  // reads it, to decide whether a link is allowed to be clickable at all.
  linkLabel: (id: string, paragraph?: number) => string | null
  // `from` is the index of the BLOCK this link sits in — the third argument, and not to
  // be confused with the second: `paragraph` is a position in the DESTINATION, `from` is
  // a position in the prose you are reading. It exists so a narrow screen can open the
  // SideCard directly underneath the paragraph the link was in, the way a footnote
  // expands in place, instead of in a margin there is no room for. Optional, and ignored
  // by every caller but TextPrioritized's remark body.
  onOpen: (id: string, paragraph?: number, from?: number) => void
  note: () => number
  // 'panel' (default): FootnoteMark, the click-to-expand-inline version, for anywhere
  // narrow (SideCard, a document's summary). 'margin': the blog's own ported
  // MarginNote-based Footnote (see components/Footnote.tsx), for TextPrioritized's
  // wide remark body, which has an actual margin to float a note into.
  footnoteVariant: 'panel' | 'margin'
}

/** Which BLOCK a key belongs to. `renderMarkdown` keys its blocks by index and `inline`
 *  extends that with dotted segments as it descends — `"3"` is the fourth block, `"3.1"`
 *  its second list item, `"3.h0"` its first table header. The block is the leading
 *  integer in every case, which is the granularity the inline SideCard anchors at: under
 *  the paragraph, not inside it, since a card can't open mid-sentence. */
function blockOf(key: string): number {
  return parseInt(key, 10)
}

function inline(text: string, ctx: Ctx, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let cursor = 0
  let i = 0
  // `matchAll` clones the regex, which MATTERS: the emphasis branches recurse back into
  // this function, and a shared `lastIndex` on the module-level INLINE would have the
  // inner scan clobber the outer one's position.
  for (const m of text.matchAll(INLINE)) {
    if (m.index > cursor) out.push(text.slice(cursor, m.index))
    const k = `${key}.${i++}`
    // Each test names the group that CAN'T be empty for that branch — an anchor or a
    // link text is allowed to be the empty string, so testing those would misfile it.
    if (m[1] !== undefined) {
      {
        out.push(<FootnoteMark key={k} n={ctx.note()}>{inline(m[1], ctx, k)}</FootnoteMark>)
      }
    } else if (m[2] !== undefined) {
      out.push(<Link key={k} href={m[2]}>{inline(m[3], ctx, k)}</Link>)
    } else if (m[5] !== undefined) {
      // A link whose target doesn't resolve — deleted, mangled, or not visible to
      // this reader (a private remark) — degrades to its plain anchor text, never a
      // link that goes nowhere. Resolution is by ID: the link's text no longer says
      // what kind of thing it points at, which is deliberate (see links.ts).
      const paragraph = m[6] !== undefined ? Number(m[6]) : undefined
      out.push(ctx.linkLabel(m[5], paragraph)
        ? <button key={k} className="cite-link"
            onClick={() => ctx.onOpen(m[5], paragraph, blockOf(key))}>{m[4]}</button>
        : m[4])
    } else if (m[8] !== undefined) {
      out.push(<Link key={k} href={m[8]}>{inline(m[7], ctx, k)}</Link>)
    } else if (m[9] !== undefined) {
      out.push(<strong key={k}>{inline(m[9], ctx, k)}</strong>)
    } else if (m[10] !== undefined) {
      out.push(<em key={k}>{inline(m[10], ctx, k)}</em>)
    } else if (m[11] !== undefined) {
      out.push(<del key={k}>{inline(m[11], ctx, k)}</del>)
    }
    cursor = m.index + m[0].length
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

// An outbound link. External targets open in a new tab, the way the blog's own anchors
// do; an in-app href doesn't. NO resting underline — the app's inline-link idiom is
// underline-on-hover, and a resting one reads as a different kind of thing here even
// though the blog underlines (see .md-link in styles.css).
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const external = /^[a-z][a-z0-9+.-]*:/i.test(href)
    && !href.startsWith('node:') && !href.startsWith('doc:')
  return (
    <a className="md-link" href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
      {children}
    </a>
  )
}

// A footnote, at panel width — SideCard's and DocumentDetail's variant, used wherever
// there's no real margin to float a note into (~360px at most, and draggable
// narrower). Same idea as the blog's own narrow-viewport fallback (MarginNote.tsx's
// `margin-note-mobile`): a numbered marker that toggles the note open as a block right
// where it sits. Closed by default, so a remark reads clean. TextPrioritized's wide
// remark body uses the OTHER variant, `Footnote` (imported above) — see `footnoteVariant`.
function FootnoteMark({ n, children }: { n: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="fn">
      <button type="button" className="fn-mark" aria-expanded={open}
        aria-label={`Footnote ${n}`} onClick={() => setOpen((o) => !o)}>
        {n}
      </button>
      {open && (
        <span className="fn-note">
          <span className="fn-note-n">{n}.</span>{' '}{children}
        </span>
      )}
    </span>
  )
}

// --- the renderer ----------------------------------------------------------

// Heading levels collapse to TWO tiers, not four: `#`/`##` are a section, `###`/`####`
// a subsection. The pane is one column of ~360px under an <h2> title — four distinct
// heading sizes below that would be a hierarchy the space can't actually show, and the
// type scale only has five steps for the whole app.
const TAG = ['h3', 'h3', 'h4', 'h4'] as const

/** Render guide prose to React nodes — a remark's body, a document's summary, a
 *  concept's description. `linkLabel` returns null for a link this surface can't
 *  resolve, which is what makes it degrade to plain text. `footnoteVariant` defaults to
 *  'panel' — every existing call site (SideCard, DocumentDetail) is narrow and keeps
 *  working unchanged; only TextPrioritized's remark body passes 'margin'. */
export function renderMarkdown(
  body: string,
  linkLabel: (id: string, paragraph?: number) => string | null,
  onOpen: (id: string, paragraph?: number, from?: number) => void,
  footnoteVariant: 'panel' | 'margin' = 'panel',
): React.ReactNode[] {
  let notes = 0
  const ctx: Ctx = { linkLabel, onOpen, note: () => ++notes, footnoteVariant }
  return parseBlocks(body).map((b, i) => {
    const key = String(i)
    switch (b.kind) {
      case 'h': {
        const Tag = TAG[b.level - 1]
        return <Tag key={key}>{inline(b.text, ctx, key)}</Tag>
      }
      case 'quote':
        return (
          <blockquote key={key} className="md-quote">
            <p>{inline(b.lines.join('\n'), ctx, key)}</p>
          </blockquote>
        )
      case 'ul':
        return (
          <ul key={key} className="md-list">
            {b.items.map((t, j) => <li key={j}>{inline(t, ctx, `${key}.${j}`)}</li>)}
          </ul>
        )
      case 'ol':
        return (
          <ol key={key} className="md-list">
            {b.items.map((t, j) => <li key={j}>{inline(t, ctx, `${key}.${j}`)}</li>)}
          </ol>
        )
      case 'p':
        return <p key={key}>{inline(b.lines.join('\n'), ctx, key)}</p>
      case 'table':
        return (
          <div key={key} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {b.header.map((h, j) => <th key={j}>{inline(h, ctx, `${key}.h${j}`)}</th>)}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr key={ri}>
                    {b.header.map((_, ci) => (
                      <td key={ci}>{inline(row[ci] ?? '', ctx, `${key}.${ri}.${ci}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}
