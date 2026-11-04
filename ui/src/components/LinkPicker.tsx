import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { LinkHit } from '../types'

// The ⌘K link picker: the curator selects words, this says what those words point at,
// and the caller wraps the selection in `[anchor](node:<id>)`.
//
// It lives in its own file because THREE editors raise it — a remark's body
// (ArtifactsPanel), a document's curator summary (DetailsPanel) and a concept's
// description (ConceptPanel). All three write the same dialect through the same
// renderer (markdown.tsx), so linking has to feel like one gesture rather than three
// that happen to look alike; a second copy is how they drift on debounce, on Escape,
// or on what Enter does.
//
// ANYTHING in the guide, not just documents. It was documents-only when `cites` was
// the only thing a link could become, which had the curator's own guide refusing to
// let them point at half of it. What a link becomes is now decided server-side against
// the graph (a document link still makes a `cites` edge; nothing else makes an edge at
// all), so the picker's job is simply to find the thing.
//
// It knows nothing about WHERE the link lands — no textarea, no caret, no body string.
// It takes the anchor text to show and hands back what was picked. The caller owns the
// splice, because only the caller knows what it is splicing into.
/** What to CALL a node type here. `artifact` is the model's word; everywhere a
 *  curator can see it, the thing is a remark — and this list is read at speed. */
const kindOf = (type: string) => (type === 'artifact' ? 'remark' : type)

export default function LinkPicker(
  { anchor, onPick, onCancel, onError }:
  { anchor: string; onPick: (hit: LinkHit) => void; onCancel: () => void; onError: (e: unknown) => void },
) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<LinkHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); return }
    let live = true
    const t = setTimeout(() => {
      api.searchLinkTargets(q)
        .then((r) => { if (live) setResults(r) })
        .catch(onError)
    }, 150)
    return () => { live = false; clearTimeout(t) }
  }, [query])

  return (
    <div className="cite-overlay" onMouseDown={onCancel}>
      <div className="cite-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cite-head">
          Link “<strong>{anchor}</strong>” to…
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && results.length > 0) onPick(results[0]) }}
          placeholder="Search by title, author, or venue…"
        />
        <ul className="search-results cite-results">
          {results.map((h) => (
            <li key={h.id}>
              {/* Badge, then a text column: what a hit IS has to read before its
                  name does, now that five types share one list. */}
              <button onClick={() => onPick(h)}>
                <span className={`type-badge ${h.type}`}>{kindOf(h.type)}</span>
                <span className="cite-row">
                  <span className="cite-title">{h.label}</span>
                  {/* Why this hit is here, when the curator's words aren't in its
                      title. Without it, a paper found by its author looks like a
                      search bug. */}
                  {h.via && <span className="muted cite-src">via {h.via}</span>}
                  {/* A private remark is offered, not hidden — you write the sentence
                      before you publish the thing it points at — but a reader gets
                      the words with no link until it is published, and that is worth
                      knowing while writing rather than after. */}
                  {h.visibility === 'private' &&
                    <span className="cite-draft">draft — readers won’t see the link</span>}
                </span>
              </button>
            </li>
          ))}
          {query.trim() && results.length === 0 &&
            <li className="no-match muted">Nothing in the guide matches “{query.trim()}”.</li>}
        </ul>
        <div className="muted cite-foot">The highlighted words stay as written — only the link is added.</div>
      </div>
    </div>
  )
}
