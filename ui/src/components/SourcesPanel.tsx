import { useEffect, useState } from 'react'
import { api } from '../api'
import { notify, onFieldGuideEvent } from '../broadcast'
import type { Source, SourcePreview } from '../types'

// Where documents come from: followed feeds, plus arXiv and OpenAlex.
//
// Its own window, on the SCOPE precedent — curator-authored configuration that is
// visited occasionally and shouldn't compete with the working columns. Deliberately
// NOT a tab in the ontology table: "rows are always concepts" is what holds that
// table up.
//
// The right pane is reserved for v2's successor (a review queue of suggested
// sources, and a search that proposes them), left blank for now so the left pane's
// proportions are honest rather than filling the window.

function relative(iso: string | null): string {
  if (!iso) return 'never'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/** The number that decides a source's fate. `null` means nothing has been judged
 *  yet, which must not render as 0% — a source that arrived last night has not
 *  failed, it just hasn't been reviewed. */
function AcceptRate({ s }: { s: Source }) {
  const { produced, accepted, dismissed, pending, accept_rate } = s.stats
  if (produced === 0) return <span className="muted">nothing yet</span>
  if (accept_rate === null) {
    return <span className="muted">{pending} awaiting review</span>
  }
  const pct = Math.round(accept_rate * 100)
  return (
    <span className={pct === 0 ? 'rate bad' : pct < 34 ? 'rate low' : 'rate'}>
      {pct}% kept
      <span className="muted">
        {' '}({accepted} kept, {dismissed} dismissed
        {pending > 0 ? `, ${pending} pending` : ''})
      </span>
    </span>
  )
}

function SourceRow({ s, onChange, onError }: {
  s: Source
  onChange: (s: Source) => void
  onError: (e: string) => void
}) {
  const [busy, setBusy] = useState<null | 'toggle' | 'run' | 'reread'>(null)
  const [ran, setRan] = useState<string | null>(null)

  const toggle = async () => {
    setBusy('toggle')
    try { onChange(await api.setSourceEnabled(s.id, !s.enabled)) }
    catch (e) { onError(String(e)) } finally { setBusy(null) }
  }

  const run = async () => {
    setBusy('run'); setRan(null)
    try {
      const r = await api.runSource(s.id)
      setRan(`${r.ingested} queued, ${r.dropped ?? 0} filtered out`)
      // The main window is a separate document — without this its review queue
      // stays stale until someone reloads it.
      if (r.ingested) notify('documents-ingested')
      onChange(await api.sources().then((all) => all.find((x) => x.id === s.id)!))
    } catch (e) { onError(String(e)) } finally { setBusy(null) }
  }

  // Screening verdicts are remembered so a source doesn't pay to re-decide the same
  // rejects on every poll — which also means a rewritten guide scope doesn't reach
  // back over them. This is the way back, and it's per source rather than global
  // because reassessing everything would mean every existing document too.
  const reread = async () => {
    setBusy('reread'); setRan(null)
    try {
      const r = await api.rereadSource(s.id)
      setRan(r.forgotten_screenings > 0
        ? `Forgot ${r.forgotten_screenings} past screening${r.forgotten_screenings === 1 ? '' : 's'} — the next poll will reconsider them`
        : 'Nothing remembered to forget')
    } catch (e) { onError(String(e)) } finally { setBusy(null) }
  }

  return (
    <li className={`source-row${s.enabled ? '' : ' off'}`}>
      <div className="source-head">
        {/* The manual bucket has nothing to turn off: it's a record of where
            documents came from, not something that runs. */}
        {s.mechanism === 'manual' ? (
          <strong>{s.label}</strong>
        ) : (
          <label className="source-toggle">
            <input type="checkbox" checked={s.enabled} disabled={busy !== null}
                   onChange={toggle} />
            <strong>{s.label}</strong>
          </label>
        )}
        {s.mechanism === 'api' && <span className="tag">queried, not polled</span>}
        {s.mechanism === 'manual' && <span className="tag">added by hand</span>}
        {s.mechanism === 'page' && <span className="tag">page, no feed</span>}
        {/* A dead feed and a quiet one both put nothing in the graph. This is the
            only thing that tells them apart, so it shouts. */}
        {s.health.failing && (
          <span className="tag bad" title={s.health.last_error ?? ''}>
            failing ×{s.health.consecutive_failures}
          </span>
        )}
      </div>

      <div className="source-url">{s.url}</div>

      <div className="source-meta">
        <AcceptRate s={s} />
        {s.pollable && (
          <span className="muted">· last ok {relative(s.health.last_success_at)}</span>
        )}
        {s.pollable && (
          <button className="link" disabled={busy !== null} onClick={run}>
            {busy === 'run' ? 'Polling…' : 'Run now'}
          </button>
        )}
        {s.pollable && (
          <button className="link" disabled={busy !== null} onClick={reread}
                  title="Reconsider everything this source has already offered — use after rewriting the guide scope">
            {busy === 'reread' ? 'Forgetting…' : 'Re-read'}
          </button>
        )}
      </div>

      {ran && <div className="source-ran">{ran}</div>}
      {s.health.failing && s.health.last_error && (
        <div className="source-err">{s.health.last_error}</div>
      )}
    </li>
  )
}

function AddSource({ onAdded, onError }: {
  onAdded: (s: Source) => void
  onError: (e: string) => void
}) {
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [preview, setPreview] = useState<SourcePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // Fetch before following, and resolve what was pasted into an actual feed url.
  // People paste the post they were reading or the front page — that distinction is
  // ours, not theirs — so the server follows the feed the page advertises. The two
  // failures this prevents: a url that was never a feed follows *successfully* and
  // then sits in the list looking quiet forever, and a post url which can never
  // yield anything new at all.
  const check = async () => {
    setBusy(true); setProblem(null); setPreview(null)
    try {
      const p = await api.previewSource(url.trim())
      setPreview(p)
      // Follow what was resolved, not what was typed — and show it, below.
      setUrl(p.url)
      if (!label.trim() && p.publication) setLabel(p.publication)
    } catch (e) { setProblem(String(e)) } finally { setBusy(false) }
  }

  const follow = async () => {
    setBusy(true); setProblem(null)
    try {
      onAdded(await api.followSource({
        label: label.trim(), url: url.trim(), mechanism: preview?.mechanism,
      }))
      setUrl(''); setLabel(''); setPreview(null)
    } catch (e) { onError(String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="add-source">
      <div className="row">
        <input
          value={url}
          placeholder="https://example.substack.com/feed"
          onChange={(e) => { setUrl(e.target.value); setPreview(null); setProblem(null) }}
        />
        <button disabled={busy || !url.trim()} onClick={check}>
          {busy && !preview ? 'Checking…' : 'Check'}
        </button>
      </div>

      {problem && <p className="error">{problem}</p>}

      {preview && (
        <div className="preview">
          {/* Say so when we followed something other than what was typed. The
              curator is about to follow a url they didn't write, and on some sites
              the advertised feed is narrower than the whole publication (a Substack
              section, say) — which they can only correct if they can see it. */}
          {/* No feed existed, so the page's links were read as an index. Worth
              saying plainly: it's a weaker mechanism (no dates or summaries until
              each article is fetched) and the curator should know which they got. */}
          {preview.mechanism === 'page' && (
            <p className="resolved">
              No feed here — reading the page as an index of published writing.
              <br />
              <span className="muted">
                Found {preview.count} {preview.count === 1 ? 'article' : 'articles'}.
                Each is fetched for its own title and date when it first appears.
              </span>
            </p>
          )}
          {preview.requested !== preview.url && (
            <p className="resolved">
              Found the feed for this page: <code>{preview.url}</code>
              <br />
              <span className="muted">
                You pasted a page, not a feed — this is the feed it advertises. Edit
                it above if that's not the one you want.
              </span>
            </p>
          )}
          <p className="muted">
            {preview.count} {preview.count === 1 ? 'entry' : 'entries'}
            {preview.publication ? ` — ${preview.publication}` : ''}
          </p>
          <ul className="plain-list">
            {preview.titles.map((t) => <li key={t} className="muted">· {t}</li>)}
          </ul>
          <div className="row">
            <input value={label} placeholder="Name it"
                   onChange={(e) => setLabel(e.target.value)} />
            <button className="save" disabled={busy || !label.trim()} onClick={follow}>
              {busy ? 'Following…' : 'Follow'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function SourcesPanel() {
  const [sources, setSources] = useState<Source[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => api.sources().then(setSources).catch((e) => setError(String(e)))
  useEffect(() => { load() }, [])
  // Accept rate is derived from the documents a source produced, so reviewing or
  // dismissing one in the main window moves it — reload rather than show a number
  // that quietly went stale.
  useEffect(() => onFieldGuideEvent((e) => {
    if (e === 'documents-changed' || e === 'documents-ingested') load()
  }), [])

  const replace = (s: Source) =>
    setSources((all) => (all ?? []).map((x) => (x.id === s.id ? s : x)))

  if (error && !sources) return <div className="sources-page"><p className="error">{error}</p></div>
  if (!sources) return <div className="sources-page muted">Loading…</div>

  // Three groups, by what a curator can do with them: poll it, query it, or
  // neither. The manual bucket is listed rather than hidden because its accept
  // rate answers a real question — how good is my own eye, next to the searches.
  const feeds = sources.filter((s) => s.pollable)
  const builtins = sources.filter((s) => s.mechanism === 'api')
  const manual = sources.filter((s) => s.mechanism === 'manual')

  return (
    <div className="sources-page">
      <div className="sources-left">
        <h2>Sources</h2>
        <p className="muted">
          Where documents come from. A followed feed enters the same funnel as
          OpenAlex — dedup, tombstones and the guide scope all apply — so following
          one is all it takes for its posts to reach the review queue.
        </p>

        <AddSource onAdded={(s) => { setSources((all) => [s, ...(all ?? [])]); load() }}
                   onError={setError} />

        {error && <p className="error">{error}</p>}

        <h3>Followed <span className="muted">({feeds.length})</span></h3>
        {feeds.length === 0 && (
          <p className="muted">No feeds followed yet. Paste one above to start.</p>
        )}
        <ul className="plain-list">
          {feeds.map((s) => (
            <SourceRow key={s.id} s={s} onChange={replace} onError={setError} />
          ))}
        </ul>

        <h3>Search APIs</h3>
        <p className="muted">
          Sources too, but queried rather than polled — a concept supplies the query,
          so they run from <strong>⌕ Run search</strong>. Turn one off to leave it out
          of every run. They can't be removed: documents already carry provenance
          pointing at them.
        </p>
        <ul className="plain-list">
          {builtins.map((s) => (
            <SourceRow key={s.id} s={s} onChange={replace} onError={setError} />
          ))}
        </ul>

        {manual.length > 0 && (
          <>
            <h3>By hand</h3>
            <p className="muted">
              Documents pasted into the review queue with <strong>+</strong>, beside
              the queue count. Provenance is an edge for these too, so every document
              can say how it got here — but there's nothing to poll and nothing to
              turn off.
            </p>
            <ul className="plain-list">
              {manual.map((s) => (
                <SourceRow key={s.id} s={s} onChange={replace} onError={setError} />
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Reserved for the source review queue and the search that fills it. Left
          blank rather than stubbed so the left pane's width is the real one. */}
      <div className="sources-right">
        <p className="muted">
          Finding sources — a queue of suggested feeds to accept or reject — goes
          here.
        </p>
      </div>
    </div>
  )
}
