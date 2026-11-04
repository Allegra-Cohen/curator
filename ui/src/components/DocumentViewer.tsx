import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { api } from '../api'
import type { DocumentNode, Readable } from '../types'

interface Props {
  doc: DocumentNode | null
  /** The abstract was edited — App re-seeds the open document. */
  onAbstractSaved?: (doc: DocumentNode) => void
  /** A quote's paragraph number (1-indexed, matching what a citation link and the
   *  assistant's evidence table both use) to scroll to and briefly highlight once
   *  the text has loaded — set when the curator clicks a quote elsewhere in the
   *  app. A number with no matching paragraph (the live text drifted since the
   *  quote was found) is silently ignored, same as elsewhere this can happen. */
  scrollToParagraph?: number | null
  /** Show, never write. Organization mode's viewer floats over the canvas, and that
   *  mode promises it does not touch the graph — a promise only worth making if it
   *  has no exception to remember, so the abstract is uneditable there too. It is
   *  occasionally annoying (you will spot a missing abstract and be unable to paste
   *  it) and the annoyance is the price of the promise. See
   *  writeups/design/QUEUE_ORGANIZATION_DESIGN.md.
   *
   *  The abstract stays a <textarea> rather than becoming prose: the box would
   *  change height, and the curator would be reading the same document in two
   *  different layouts depending on which mode they were in. Only the affordances
   *  that say "editable" go. */
  readOnly?: boolean
}

// Open the source in a real window rather than a tab, so reading it doesn't cover
// the curator app — the point is to have both on screen at once. Passing a window
// feature string is what makes the browser choose a window over a tab; the plain
// href + target="_blank" stays as the fallback if the popup is blocked.
const openWindow = (href: string) => (e: MouseEvent) => {
  // Let modified clicks (⌘/ctrl/shift/middle) do whatever the user asked for.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  const win = window.open(href, '_blank', 'noopener,noreferrer,width=1000,height=900')
  if (win) e.preventDefault()   // blocked -> fall through to the normal link
}

// On-demand readable view: we store no full text, so when a document is opened
// we re-fetch its URL and render cleaned paragraphs. On failure (paywall, block,
// link-rot) we fall back to a link to the original.
//
// Discovery documents land with an `abstract` from the search API, which is what
// makes a paywalled paper reviewable at all — the fetch above can never succeed on
// one. So the abstract is shown whenever we have it: as the sole content when the
// fetch fails, and above the full text when it succeeds (the two disagree often
// enough — extraction picks up nav furniture — that the author's own summary earns
// its place). `oa_pdf_url` is a link-out to a legitimately-free copy where one
// exists; we don't parse PDFs (see the README TODO).
export default function DocumentViewer({ doc, onAbstractSaved, readOnly, scrollToParagraph }: Props) {
  const [readable, setReadable] = useState<Readable | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Manual abstract entry: null = not editing, string = the draft.
  const [absDraft, setAbsDraft] = useState<string | null>(null)
  const [savingAbs, setSavingAbs] = useState(false)
  // One DOM node per paragraph, keyed by its 1-indexed number — how the scroll
  // effect below finds the paragraph a quote actually points at.
  const paragraphRefs = useRef<Record<number, HTMLParagraphElement | null>>({})
  // Which paragraph is mid-highlight right now, if any — a class toggled off by a
  // timer, with the fade itself done in CSS (see .readable-highlight).
  const [highlighted, setHighlighted] = useState<number | null>(null)

  useEffect(() => {
    if (!readable?.ok || !scrollToParagraph) return
    const el = paragraphRefs.current[scrollToParagraph]
    if (!el) return   // the live text drifted since the quote was found; nothing to jump to
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlighted(scrollToParagraph)
    const t = setTimeout(() => setHighlighted(null), 2000)
    return () => clearTimeout(t)
  }, [readable, scrollToParagraph])

  useEffect(() => {
    setReadable(null); setError(null)
    setAbsDraft(null)          // a new document must not inherit the last one's draft
    if (!doc) return
    setLoading(true)
    let cancelled = false
    api.readable(doc.id)
      .then((r) => { if (!cancelled) setReadable(r) })
      .catch((e) => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [doc?.id])

  if (!doc) return <div className="viewer muted">Select a document to read it.</div>

  const url = doc.attributes.canonical_url
  const abstract: string = doc.attributes.abstract ?? ''
  const oaPdf: string | null = doc.attributes.oa_pdf_url ?? null

  const saveAbstract = async () => {
    if (readOnly) return
    if (savingAbs || absDraft === null || absDraft.trim() === abstract.trim()) return
    if (!doc) return
    setSavingAbs(true)
    try {
      const n = await api.updateAbstract(doc.id, absDraft.trim())
      onAbstractSaved?.(n)
      setAbsDraft(null)
    } catch (e) { setError(String(e)) } finally { setSavingAbs(false) }
  }

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <a href={url} onClick={openWindow(url)} target="_blank" rel="noreferrer">
          Open original ↗
        </a>
        {/* Only present when a free copy genuinely exists; the original link may
            well be paywalled, so this is the one worth reaching for. */}
        {oaPdf && (
          <> · <a href={oaPdf} onClick={openWindow(oaPdf)} target="_blank" rel="noreferrer">
            Free PDF ↗
          </a></>
        )}
        {readable?.fetch_outcome && <span className="muted"> · {readable.fetch_outcome}</span>}
      </div>
      <section className="abstract">
        <h3 className="field-label">Abstract</h3>
        {/* An empty abstract you cannot fill is not an invitation, so the
            placeholder says what is true instead of what to do. */}
        <textarea
          className="concept-name"
          value={absDraft !== null ? absDraft : abstract}
          readOnly={readOnly}
          onChange={(e) => setAbsDraft(e.target.value)}
          onBlur={saveAbstract}
          onKeyDown={(e) => { if (e.key === 'Escape') { setAbsDraft(null); (e.target as HTMLTextAreaElement).blur() } }}
          placeholder={readOnly ? 'No abstract.' : 'Paste the abstract…'}
          rows={6}
          title={readOnly ? undefined : 'Click to edit the abstract'}
        />
      </section>
      {loading && <div className="muted">Fetching readable text…</div>}
      {error && <div className="error">Couldn’t load: {error}</div>}
      {/* With an abstract in hand a failed fetch isn't a dead end, so say the
          milder thing; without one, the original reason is all the curator gets. */}
      {readable && !readable.ok && (
        <div className="muted">
          {abstract ? 'Full text unavailable — reviewing from the abstract.' : readable.reason}
        </div>
      )}
      {readable?.ok && (
        <article className="readable">
          {readable.title && <h2>{readable.title}</h2>}
          {readable.paragraphs.map((p, i) => {
            const n = i + 1
            return (
              <p key={i} ref={(el) => { paragraphRefs.current[n] = el }}
                className={highlighted === n ? 'readable-highlight' : undefined}>
                {p}
              </p>
            )
          })}
        </article>
      )}
    </div>
  )
}
