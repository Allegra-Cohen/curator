import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { pendingCount } from '../types'
import { fillFor } from '../palette'
import type { AddDocumentsResult, GraphNode, ManualDocumentIn, VenueTier } from '../types'

export type ListMode = 'queue' | 'cell'

/** The MIME-ish key for a dragged document set. App's concept panel is the drop
 *  target (mass-labeling). */
export const DOCS_DND = 'application/x-fg-docs'

/** Kept in sync with `.add-doc-box` in styles.css — the overlay is positioned in
 *  JS, so its width has to be a number here to keep it on screen. */
const ADD_BOX_WIDTH = 420

interface Props {
  mode: ListMode
  /** What the list is showing. In cell mode this names the junction it came from. */
  heading: string
  docs: GraphNode[]
  selectedId: string | null
  /** Documents saved in THIS sitting (queue mode only). A tint, not a state: the
   *  server drops a document from the queue the instant it's reviewed, so this can
   *  never come from a fetch — it means "you just did this one", which is a fact
   *  about the sitting and not about the document. It evaporates on the next load. */
  finished: Set<string>
  /** Multi-selected documents, to drag as a batch onto a concept. */
  marked: Set<string>
  /** Which pile each row is in, as a hue — organization mode's only mark on this
   *  list (queue mode only; empty otherwise). A segment is a fact about the QUEUE and
   *  never about the document, so nothing here is read back out of it. */
  segmentColors: Map<string, string>
  /** Organization mode is on: the canvas is over the workspace and this list has
   *  stopped re-ordering. Queue mode only — a cell's documents are derived from the
   *  graph, so there is nothing to organize. */
  organizing: boolean
  onToggleOrganize: () => void
  onSelect: (id: string) => void
  /** Toggle a document in the marked set (modifier-click). */
  onToggleMark: (id: string) => void
  /** Paste URLs straight into the queue. Only offered in queue mode — a cell's
   *  contents are derived from the graph, so there's nothing to add *to*. */
  onAdd: (urls: string[]) => Promise<AddDocumentsResult>
  /** The fallback for a URL that just showed up in `failed`: our own fetch
   *  couldn't reach it, but the curator can open it themselves and type in what
   *  they see, pasting the full text too if they can get to it. Only offered
   *  next to a failed URL — there's nothing to fall back on before a fetch has
   *  actually been tried and failed. */
  onAddManual: (doc: ManualDocumentIn) => Promise<AddDocumentsResult>
  onError: (e: unknown) => void
}

/** What a paste actually did, bucket by bucket.
 *
 *  Counts alone can't tell a bot blocker from a document that was already here,
 *  and those want opposite responses from the curator — retry one, go find the
 *  other. So each bucket names what's in it. `restored` is the interesting one:
 *  the URL had been dismissed, and pasting it deliberately brought the original
 *  document back rather than standing a second one beside it.
 *
 *  `couldn't be fetched` gets its own row rather than joining the others: each
 *  entry there carries an "add manually" link into the fallback form, so it has
 *  to render more than plain text. */
function AddResult({ r, onAddManually }: {
  r: AddDocumentsResult
  onAddManually: (url: string) => void
}) {
  const named = (d: { title: string; url: string | null }) => d.title || d.url || ''
  const buckets: Array<[string, string[]]> = [
    ['added', r.added.map(named)],
    ['restored — you had dismissed these', r.restored.map(named)],
    ['already in the guide', r.duplicates.map(named)],
    ['not a web address', r.invalid],
  ]
  const shown = buckets.filter(([, items]) => items.length > 0)
  if (!shown.length && !r.failed.length) return null
  return (
    <ul className="add-doc-result plain-list">
      {shown.map(([label, items]) => (
        <li key={label}>
          <span className="muted">{items.length} {label}</span>
          <ul className="plain-list">
            {items.map((t, i) => (
              <li key={i} className="add-doc-item" title={t}>{t}</li>
            ))}
          </ul>
        </li>
      ))}
      {r.failed.length > 0 && (
        <li>
          <span className="muted">{r.failed.length} couldn’t be fetched</span>
          <ul className="plain-list">
            {r.failed.map((url) => (
              <li key={url} className="add-doc-item add-doc-failed">
                <span className="add-doc-failed-url" title={url}>{url}</span>
                <button type="button" className="link"
                        onClick={() => onAddManually(url)}>
                  add manually
                </button>
              </li>
            ))}
          </ul>
        </li>
      )}
    </ul>
  )
}

// The far-left column. It used to be the review queue and nothing else; now it's
// wherever documents come from — the queue, or the contents of a clicked cell.
// Which is why "Review queue" moved up to the app header: it's one source among
// two, not the identity of the column.
/** The venue tier as a badge on a queue row.
 *
 *  Shown, not enforced: the queue is already ordered by tier, so the badge exists
 *  to explain the order rather than to rank anything a second time. An untiered
 *  document gets no badge at all — a feed post has no venue, and inventing a label
 *  for it ("other") would read as a verdict.
 *
 *  `no refs` rides here too: on OpenAlex a paper citing nothing is worth a glance,
 *  but 5 of 20 journal articles measure zero (their publisher never deposited
 *  references), so it is a flag to look at and never a reason to drop. */
function VenueBadge({ doc }: { doc: GraphNode }) {
  const tier = doc.attributes.venue_tier as VenueTier
  const noRefs = doc.attributes.reference_count === 0
  if (!tier && !noRefs) return null
  return (
    <>
      {tier && (
        <span className={`q-venue q-venue-${tier}`}
              title={tier === 'journal'
                ? 'Peer-reviewed — a recognized journal or conference'
                : 'Preprint — not peer reviewed'}>
          {tier === 'journal' ? 'peer-reviewed' : 'preprint'}
        </span>
      )}
      {noRefs && (
        <span className="q-venue q-venue-norefs" title="Cites no other work">
          no refs
        </span>
      )}
    </>
  )
}

/** Three piles of different weights: what organization mode makes, and what its
 *  canvas actually looks like. A glyph rather than a word because it sits beside the
 *  `+` in a 220px header, and because the mode has no verb short enough to fit. */
const PILES = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
       strokeWidth="1.3" aria-hidden="true">
    <circle cx="5" cy="5.6" r="3.3" />
    <circle cx="12.1" cy="4.7" r="2.2" />
    <circle cx="9.3" cy="11.6" r="3" />
  </svg>
)

export default function DocumentList({
  mode, heading, docs, selectedId, finished, marked, segmentColors,
  organizing, onToggleOrganize, onSelect, onToggleMark,
  onAdd, onAddManual, onError,
}: Props) {
  // The badge over the list answers the same question as the one in the app header
  // — how much is left — so it is the same count, not a row count. The two used to
  // disagree while a sitting was in progress, which reads as one of them being broken.
  //
  // A cell list is the other question. Its documents are approved by definition, so
  // pending would be 0 there; what "how many" means for a cell is how many there are.
  const count = mode === 'queue' ? pendingCount(docs) : docs.length
  const [collapsed, setCollapsed] = useState(false)
  // The paste-a-URL box. It belongs here rather than in the app header because it
  // acts on this list: the header holds guide-wide things (scope, sources, search),
  // and adding a document is an action on the queue you're looking at.
  const [addOpen, setAddOpen] = useState(false)
  const [addUrls, setAddUrls] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addResult, setAddResult] = useState<AddDocumentsResult | null>(null)
  // The manual-add fallback, nested inside the same box. `manualUrl` is which
  // failed URL it's for — null means the form is closed. Its fields start
  // blank on every open (there's nothing to prefill: our fetch got nothing).
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  const [manualTitle, setManualTitle] = useState('')
  const [manualAuthors, setManualAuthors] = useState('')
  const [manualPublication, setManualPublication] = useState('')
  const [manualDate, setManualDate] = useState('')
  const [manualAbstract, setManualAbstract] = useState('')
  const [manualFullText, setManualFullText] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  // Where to paint the box. It overlays the workspace rather than sitting in the
  // column, which is 220px wide — inline, every line of a URL wrapped three times
  // and the result list was unreadable. `position: fixed` is what gets it out:
  // the column scrolls its own overflow, so an absolutely-positioned child would
  // be clipped at its edge, and no ancestor sets a transform to spoil it.
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const [addAt, setAddAt] = useState<{ top: number; left: number } | null>(null)

  const closeAdd = () => {
    setAddOpen(false); setAddResult(null); setAddAt(null); setManualUrl(null)
  }

  const openManual = (url: string) => {
    setManualUrl(url)
    setManualTitle(''); setManualAuthors(''); setManualPublication('')
    setManualDate(''); setManualAbstract(''); setManualFullText('')
  }
  const closeManual = () => { if (!manualBusy) setManualUrl(null) }

  const submitManual = async () => {
    if (!manualUrl || !manualTitle.trim()) return
    setManualBusy(true)
    try {
      const r = await onAddManual({
        url: manualUrl,
        title: manualTitle.trim(),
        authors: manualAuthors.split(',').map((a) => a.trim()).filter(Boolean),
        publication: manualPublication.trim() || undefined,
        date: manualDate.trim() || undefined,
        abstract: manualAbstract.trim() || undefined,
        full_text: manualFullText.trim() || undefined,
      })
      // It landed the same way a paste does, just by a different door — fold it
      // into the same result list rather than showing a second one, and drop the
      // URL out of `failed` now that it's no longer just sitting there unresolved.
      setAddResult((prev) => prev ? {
        ...prev,
        added: [...prev.added, ...r.added],
        restored: [...prev.restored, ...r.restored],
        duplicates: [...prev.duplicates, ...r.duplicates],
        failed: prev.failed.filter((u) => u !== manualUrl),
      } : r)
      // And out of the retry box, same as any other URL that just landed.
      setAddUrls((prev) => prev.split('\n').filter((u) => u.trim() !== manualUrl).join('\n'))
      setManualUrl(null)
    } catch (e) { onError(e) } finally { setManualBusy(false) }
  }

  // Fixed coordinates have to be re-derived whenever the button moves under them:
  // a resize, or scrolling the list the button sits at the top of.
  useEffect(() => {
    if (!addOpen) return
    const place = () => {
      const r = addBtnRef.current?.getBoundingClientRect()
      if (!r) return
      setAddAt({
        top: r.bottom + 6,
        left: Math.max(8, Math.min(r.left, window.innerWidth - ADD_BOX_WIDTH - 8)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)   // capture: inner scrollers too
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [addOpen])

  // Esc or a click outside closes it — the same gesture that leaves the ontology's
  // edit modes. Never mid-fetch, though: the request lands either way, and closing
  // over it would throw away the only account of what happened to the URLs.
  useEffect(() => {
    if (!addOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || addBusy || manualBusy) return
      // Escape backs out one level at a time: out of the manual form first, then
      // out of the whole box — mirroring the outside-click check just below,
      // which treats both as one region and only closeAdd resets manual state.
      if (manualUrl) closeManual(); else closeAdd()
    }
    const onDown = (e: MouseEvent) => {
      if (addBusy || manualBusy) return
      if ((e.target as HTMLElement).closest?.('.add-doc-group')) return
      closeAdd()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [addOpen, addBusy, manualBusy, manualUrl])

  const submitAdd = async () => {
    const urls = addUrls.split('\n').map((u) => u.trim()).filter(Boolean)
    if (!urls.length) return
    setAddBusy(true)
    setAddResult(null)
    try {
      const r = await onAdd(urls)
      setAddResult(r)
      // Leave only what didn't land, so a retry is the failures and nothing else —
      // re-submitting the whole box would just re-report the duplicates.
      setAddUrls([...r.failed, ...r.invalid].join('\n'))
    } catch (e) { onError(e) } finally { setAddBusy(false) }
  }

  // Plain click opens (and, at the App level, clears marks); a modifier-click builds
  // the multi-selection to drag. A marked row and the open one look the SAME — both
  // green — because they are the same answer to "what am I about to act on", and the
  // open document is a member of the set: no glyph is needed to tell them apart. See
  // App's toggleMark, which is where that rule lives.
  const click = (e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); onToggleMark(id) }
    else onSelect(id)
  }
  // Dragging a marked row drags the whole marked set; dragging an unmarked row
  // drags just it. The concept panel reads this on drop.
  const dragStart = (e: React.DragEvent, id: string) => {
    const ids = marked.has(id) && marked.size > 0 ? [...marked] : [id]
    e.dataTransfer.setData(DOCS_DND, JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'copy'
  }

  if (collapsed) {
    return (
      <div className="queue collapsed">
        <button className="collapse-btn" title="Show documents" onClick={() => setCollapsed(false)}>
          ☰ <span className="badge">{count}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="queue">
      <div className="queue-head">
        <button className="collapse-btn" title="Hide" onClick={() => setCollapsed(true)}>‹</button>
        <span className="q-heading" title={heading}>{heading}</span>
        <span className="badge">{count}</span>
        {/* Only in queue mode: a cell's contents are derived from the graph, so
            there is nothing there to add a document *to*, and nothing to organize.
            The two buttons sit in separate wrappers on purpose — the add box's
            click-outside test is `.add-doc-group`, and clicking Organize has to
            count as outside it. */}
        {mode === 'queue' && (
          <span className="queue-tools">
            <button
              className={`organize-btn${organizing ? ' sel' : ''}`}
              onClick={onToggleOrganize}
              title={organizing
                ? 'Stop organizing — the queue re-orders into segment order'
                : 'Organize the queue into segments'}
              aria-pressed={organizing}
            >
              {PILES}
            </button>
            <span className="add-doc-group">
              <button
                ref={addBtnRef}
                className={`add-doc-btn${addOpen ? ' sel' : ''}`}
                onClick={() => (addOpen ? closeAdd() : setAddOpen(true))}
                title="Add a document by pasting its URL"
                aria-expanded={addOpen}
              >
                +
              </button>
            </span>
          </span>
        )}
      </div>

      {/* Carries `add-doc-group` as well as its own class so the click-outside
          check treats the box and its + as one region. */}
      {mode === 'queue' && addOpen && addAt && (
        <div className="add-doc-box add-doc-group"
             style={{ top: addAt.top, left: addAt.left, width: ADD_BOX_WIDTH }}>
          <div className="add-doc-head">
            <strong>Add documents</strong>
            <span className="muted">One URL per line. They arrive pending —
              nothing is categorized for you.</span>
          </div>
          <textarea
            className="add-doc-input"
            value={addUrls}
            onChange={(e) => setAddUrls(e.target.value)}
            placeholder="https://…"
            rows={4}
            autoFocus
            disabled={addBusy}
            onKeyDown={(e) => {
              // Enter has to stay a newline — the box is multi-line on purpose —
              // so submit is the modifier chord, as elsewhere.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAdd()
            }}
          />
          <div className="add-doc-actions">
            <button className="save" disabled={addBusy || !addUrls.trim()}
                    onClick={submitAdd}>
              {addBusy ? 'Fetching…' : 'Add'}
            </button>
            <button disabled={addBusy} onClick={closeAdd}>Close</button>
          </div>
          {addResult && <AddResult r={addResult} onAddManually={openManual} />}
          {manualUrl && (
            <div className="add-doc-manual">
              <div className="add-doc-head">
                <strong>Add manually</strong>
                <span className="muted" title={manualUrl}>
                  Our fetch couldn't reach {manualUrl} — type in what you see on the
                  page yourself. Paste the full text too if you can get to it.
                </span>
              </div>
              <input
                className="add-doc-input"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Title (required)"
                autoFocus
                disabled={manualBusy}
              />
              <input
                className="add-doc-input"
                value={manualAuthors}
                onChange={(e) => setManualAuthors(e.target.value)}
                placeholder="Authors, comma separated (optional)"
                disabled={manualBusy}
              />
              <input
                className="add-doc-input"
                value={manualPublication}
                onChange={(e) => setManualPublication(e.target.value)}
                placeholder="Publication or venue (optional)"
                disabled={manualBusy}
              />
              <input
                className="add-doc-input"
                value={manualDate}
                onChange={(e) => setManualDate(e.target.value)}
                placeholder="Date (optional)"
                disabled={manualBusy}
              />
              <textarea
                className="add-doc-input"
                value={manualAbstract}
                onChange={(e) => setManualAbstract(e.target.value)}
                placeholder="Short abstract (optional)"
                rows={2}
                disabled={manualBusy}
              />
              <textarea
                className="add-doc-input"
                value={manualFullText}
                onChange={(e) => setManualFullText(e.target.value)}
                placeholder="Paste the full text here, if you can get to it (optional)"
                rows={6}
                disabled={manualBusy}
              />
              <div className="add-doc-actions">
                <button className="save" disabled={manualBusy || !manualTitle.trim()}
                        onClick={submitManual}>
                  {manualBusy ? 'Adding…' : 'Add'}
                </button>
                <button disabled={manualBusy} onClick={closeManual}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {docs.length === 0 && (
        <div className="muted">
          {mode === 'queue' ? 'Nothing pending. 🎉' : 'No documents in this cell.'}
        </div>
      )}

      {marked.size > 0 && (
        <div className="q-markhint">
          {marked.size} selected — drag onto a concept to label
        </div>
      )}

      <ul>
        {docs.map((d) => {
          const done = mode === 'queue' && finished.has(d.id)
          const isMarked = marked.has(d.id)
          // The pile, as two custom properties rather than a background: `.q-seg`
          // has to sit UNDER hover, selection and the reviewed tint in the cascade
          // (styles.css says which wins), and an inline background would beat all
          // three. The rail is set the same way and is never overridden — a row
          // says which pile it is in even while it is green.
          const hue = segmentColors.get(d.id)
          return (
            <li
              key={d.id}
              className={`${d.id === selectedId ? 'sel' : ''}${done ? ' done' : ''}${isMarked ? ' marked' : ''}${hue ? ' q-seg' : ''}`}
              style={hue
                ? ({ '--seg-rail': hue, '--seg-tint': fillFor(hue, 2) } as CSSProperties)
                : undefined}
              draggable
              onDragStart={(e) => dragStart(e, d.id)}
              onClick={(e) => click(e, d.id)}
              title={`${d.label}${'\n'}(⌘/Ctrl-click to multi-select for labeling)`}
            >
              <div className="q-title">
                {done && <span className="q-done" title="Reviewed just now">✓ </span>}
                {d.attributes.title || d.label}
              </div>
              <div className="q-sub muted">
                <VenueBadge doc={d} />
                {d.attributes.publication || d.attributes.source_type}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
