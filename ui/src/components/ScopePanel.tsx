import { useEffect, useState } from 'react'
import { api } from '../api'
import type { GuideScope } from '../types'

// The guide's scope statement — the first Artifact, and for now the only one.
//
// It matters more than its size suggests: this text is prepended to EVERY discovery
// screening call, so it decides what search accepts as much as the concept
// descriptions do. It lived as a constant in relevance_filter.py, which meant the
// filter was applying words the curator never wrote and couldn't see. Hence its own
// window: it's authored content, not a setting.
export default function ScopePanel() {
  const [scope, setScope] = useState<GuideScope | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.scope()
      .then((s) => { setScope(s); setBody(s.body) })
      .catch((e) => setError(String(e)))
  }, [])

  const dirty = !!scope && body !== scope.body
  // Warn on close/reload while an edit is pending — this window is likely to be
  // shut absent-mindedly, being a side panel.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const s = await api.saveScope(body.trim())
      setScope(s); setBody(s.body); setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }

  if (error && !scope) return <div className="scope-page"><p className="error">{error}</p></div>
  if (!scope) return <div className="scope-page muted">Loading…</div>

  return (
    <div className="scope-page">
      <h2>Guide scope</h2>
      <p className="muted">
        What this guide is about. Discovery screens every candidate paper against
        this text, so it decides what search accepts — a paper that doesn't fit is
        dropped even when it matches a concept's keywords.
      </p>

      {/* Until the curator saves, screening runs on built-in wording. Saying so is
          the whole point of surfacing this — the old behaviour was invisible. */}
      {scope.is_default && (
        <p className="scope-warn">
          ⚠ No scope has been saved yet — screening is using the built-in default
          shown below. Edit and save to make it yours.
        </p>
      )}

      <textarea
        className="scope-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={14}
        placeholder="Describe what belongs in this guide, and what doesn't…"
      />

      <div className="row save-row">
        <button className="save" disabled={busy || !dirty || body.trim() === ''} onClick={save}>
          {busy ? 'Saving…' : 'Save scope'}
        </button>
        {dirty && <span className="muted">Unsaved changes</span>}
        {saved && !dirty && <span className="muted">Saved.</span>}
        {scope.updated_at && !dirty && (
          <span className="muted">Last edited {new Date(scope.updated_at).toLocaleString()}</span>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      <p className="muted scope-foot">
        Tip: be explicit about the boundary. The default says the guide is about
        <em> human</em> cognition and <em>not</em> about AI/ML methods for their own
        sake — that one distinction is what rejects machine-reading-comprehension
        papers under a concept about reading.
      </p>
    </div>
  )
}
