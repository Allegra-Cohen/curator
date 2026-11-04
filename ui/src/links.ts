// Inline links to nodes, inside the guide's own prose: `[anchor text](node:<uuid>)`.
//
// The TypeScript mirror of graph/links.py. It exists so an editor's References list
// can update LIVE as the curator types or inserts, before any save — the server is
// authoritative on `cites` edges, but round-tripping every keystroke to learn what you
// just inserted would be absurd. The regex is kept character-for-character in step with
// the Python one; if one changes, both change.
//
// ONE scheme for every node type, and the type is NOT in the link — see the Python
// module for why (ids are unique across types, and `retype` can change a node's type in
// place, so a `person:` prefix would go stale while still resolving). `doc:` is still
// read, because bodies written before the change hold it; nothing writes it any more.

/** The pattern as a SOURCE STRING, because markdown.tsx folds it into a bigger
 *  alternation (a node link is one inline token among bold, links, footnotes…). One
 *  literal, two readers — so prose and the References list can't drift on what counts
 *  as a link. Groups: 1 = anchor, 2 = raw id, 3 = paragraph number (optional — see
 *  below). Mirrors graph/links.py character-for-character; if one changes, both do. */
export const LINK_PATTERN = String.raw`\[([^\]]*)\]\((?:node|doc):([^)\s#]+)(?:#p(\d+))?\)`

const LINK_RE = new RegExp(LINK_PATTERN, 'g')

export interface ParsedLink {
  anchor: string   // the curator's words, as highlighted
  rawId: string    // the id exactly as written — a uuid, unless the link was mangled
  /** The `#p<N>` suffix — "not just this document, this paragraph in it" — when
   *  present. Only the curation assistant's evidence tables ever write one (see
   *  graph/links.py); nobody types it by hand. */
  paragraph: number | undefined
  start: number
  end: number
}

/** Every link in the body, in order, malformed ones included — a broken link still
 *  occupies a position the editor may want to point at. */
export function parseLinks(body: string): ParsedLink[] {
  const out: ParsedLink[] = []
  for (const m of body.matchAll(LINK_RE)) {
    out.push({
      anchor: m[1],
      rawId: m[2],
      paragraph: m[3] !== undefined ? Number(m[3]) : undefined,
      start: m.index!,
      end: m.index! + m[0].length,
    })
  }
  return out
}

/** The token the ⌘K picker inserts — kept beside the parser so a format change can't
 *  break insertion and reading independently. `paragraph` is never set from here — the
 *  picker links a whole document, never a paragraph within one. */
export function makeLink(anchor: string, nodeId: string, paragraph?: number): string {
  const suffix = paragraph !== undefined ? `#p${paragraph}` : ''
  return `[${anchor}](node:${nodeId}${suffix})`
}
