import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { makeLink, parseLinks } from '../links'
import LinkPicker from './LinkPicker'
import type { Artifact, ArtifactWrite, LinkHit, NodeHit, Visibility } from '../types'

// The curator's remarks about the curation — prose over a SET of nodes, citing
// documents inline. Its own window, on the SCOPE / SOURCES / ENTITIES precedent:
// authored content you visit, not part of the working columns.
//
// Two states in one window, like Entities: a LIST of every remark, and an EDITOR for
// one. The list is where you read what's been written; the editor is where a new
// remark is called or an old one revised. Nothing here surfaces on the main graph
// yet — the viewer that reads this layer is Phase 3. See ARTIFACTS_DESIGN.md.
export default function ArtifactsPanel() {
  const [rows, setRows] = useState<Artifact[]>([])
  const [editing, setEditing] = useState<Artifact | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => api.artifacts().then(setRows).catch((e) => setError(String(e)))
  useEffect(() => { load() }, [])

  if (editing) {
    return (
      <ArtifactEditor
        artifact={editing === 'new' ? null : editing}
        onDone={() => { setEditing(null); load() }}
        onError={(e) => setError(String(e))}
      />
    )
  }

  return (
    <div className="artifacts-page">
      <div className="artifacts-head">
        <h2>Artifacts</h2>
        <span className="muted">
          {rows.length === 0 ? 'nothing written yet'
            : `${rows.length} remark${rows.length === 1 ? '' : 's'}`}
        </span>
        <button className="save" onClick={() => setEditing('new')}>New artifact</button>
      </div>

      {error && <p className="error" onClick={() => setError(null)}>{error}</p>}

      <p className="muted artifacts-intro">
        A remark is prose about one node or several together — what you make of a
        concept, or what one concept has to do with others. Link to anything in the
        guide inside the text with <kbd>⌘K</kbd> over a selection.
      </p>

      {rows.length === 0 ? (
        <p className="muted">
          No remarks yet. “New artifact” starts one — you pick what it’s about first.
        </p>
      ) : (
        <ul className="artifacts-list">
          {rows.map((a) => (
            <li key={a.id}>
              <button className="artifact-row" onClick={() => setEditing(a)}>
                <span className="artifact-row-title">
                  <span className={`vis-badge ${a.visibility}`}>{a.visibility}</span>
                  {a.label}
                </span>
                <span className="artifact-row-subjects">
                  {a.subjects.map((s) => (
                    <span key={s.id} className={`chip subject ${s.type}`}>
                      <span className="chip-label">{s.label}</span>
                    </span>
                  ))}
                  {a.subjects.length === 0 &&
                    <span className="muted">— about nothing yet</span>}
                </span>
                <span className="artifact-row-meta muted">
                  {a.links.filter((l) => l.type === 'document').length > 0 &&
                    <>cites {a.links.filter((l) => l.type === 'document').length} · </>}
                  {a.created_by ?? 'unknown'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// -- the editor --------------------------------------------------------------

interface EditorProps {
  artifact: Artifact | null   // null = a new remark
  onDone: () => void          // saved or deleted — return to the list
  onError: (e: unknown) => void
}

function ArtifactEditor({ artifact, onError, onDone }: EditorProps) {
  const [subjects, setSubjects] = useState<NodeHit[]>(artifact?.subjects ?? [])
  const [label, setLabel] = useState(artifact?.label ?? '')
  const [body, setBody] = useState(artifact?.body ?? '')
  // Private until deliberately published — a new remark defaults to a draft.
  const [visibility, setVisibility] = useState<Visibility>(artifact?.visibility ?? 'private')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Resolve a linked id to what it is: its title AND its type. Seeded from the saved
  // artifact's `links` (resolved server-side from the body), and extended every time
  // the picker inserts one, so the References block can name a citation the instant
  // it's added — before any save round-trip.
  //
  // The TYPE is what stopped this block from reddening half the guide. References is
  // documents only, deliberately — it mirrors the set the server turns into `cites`
  // edges — and since a link's text no longer says what it points at (see links.ts),
  // "not a document" and "resolves to nothing" would otherwise be the same thing here.
  // An id absent from this map is genuinely broken, which is what the red flags.
  const [targets, setTargets] = useState<Record<string, { label: string; type: string }>>(
    () => Object.fromEntries((artifact?.links ?? []).map(
      (l) => [l.id, { label: l.label, type: l.type }])))

  // The Cmd+K link flow: a selection captured from the body, held while the curator
  // picks what to wrap it in. null = picker closed.
  const [pending, setPending] = useState<{ anchor: string; start: number; end: number } | null>(null)

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  // A caret position to restore after we programmatically rewrite the body (React
  // resets it otherwise, dropping the cursor to the end mid-edit).
  const caret = useRef<number | null>(null)
  useEffect(() => {
    if (caret.current !== null && bodyRef.current) {
      bodyRef.current.focus()
      bodyRef.current.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  })

  const dirty = artifact
    ? label !== artifact.label || body !== artifact.body
      || visibility !== artifact.visibility
      || subjects.map((s) => s.id).join() !== artifact.subjects.map((s) => s.id).join()
    : label.trim() !== '' || body.trim() !== '' || subjects.length > 0
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const addSubject = (n: NodeHit) =>
    setSubjects((cur) => cur.some((s) => s.id === n.id) ? cur : [...cur, n])
  const removeSubject = (id: string) =>
    setSubjects((cur) => cur.filter((s) => s.id !== id))

  // Cmd/Ctrl+K wraps the current selection in a link. An empty selection is a no-op
  // — there's nothing to anchor — matching every editor's link command.
  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: start, selectionEnd: end } = el
      if (start === end) return
      setPending({ anchor: body.slice(start, end), start, end })
    }
  }

  const insertLink = (hit: LinkHit) => {
    if (!pending) return
    const token = makeLink(pending.anchor, hit.id)
    const next = body.slice(0, pending.start) + token + body.slice(pending.end)
    caret.current = pending.start + token.length
    setBody(next)
    setTargets((t) => ({ ...t, [hit.id]: { label: hit.label, type: hit.type } }))
    setPending(null)
  }

  // The References block, live from the body: the DOCUMENTS it links to, unique and
  // in order of first mention — the same set the server will turn into `cites` edges.
  // Repeats collapse here the way they do in the edge set; positions still matter in
  // the prose, not in this summary.
  //
  // A link to a concept or another remark is simply absent: it is a link, not a
  // reference, and the prose already shows it. What must NOT be lost is a link that
  // resolves to nothing at all — an id with no target is listed and flagged, because
  // it has nothing anywhere else to appear in and would otherwise look like it had
  // never been written.
  const references = useMemo(() => {
    const seen = new Set<string>()
    const out: { rawId: string; title: string | null }[] = []
    for (const link of parseLinks(body)) {
      if (seen.has(link.rawId)) continue
      seen.add(link.rawId)
      const target = targets[link.rawId]
      if (target && target.type !== 'document') continue
      out.push({ rawId: link.rawId, title: target?.label ?? null })
    }
    return out
  }, [body, targets])

  const canSave = label.trim() !== '' && subjects.length > 0 && !busy

  const save = async () => {
    setBusy(true)
    try {
      const payload: ArtifactWrite = {
        label: label.trim(), body, subject_ids: subjects.map((s) => s.id), visibility,
      }
      if (artifact) await api.updateArtifact(artifact.id, payload)
      else await api.createArtifact(payload)
      onDone()
    } catch (e) { onError(e); setBusy(false) }
  }

  const remove = async () => {
    if (!artifact) return
    setBusy(true)
    try { await api.deleteArtifact(artifact.id); onDone() }
    catch (e) { onError(e); setBusy(false) }
  }

  return (
    <div className="artifacts-page">
      <div className="artifacts-head">
        <h2>{artifact ? 'Edit remark' : 'New remark'}</h2>
        <button className="link-button" onClick={() => {
          if (!dirty || window.confirm('Discard changes to this remark?')) onDone()
        }}>← All artifacts</button>
      </div>

      {/* Subjects first: what this prose is about. A remark over several is a note on
          how they relate; over one, a note on the thing. Any node type is fair game,
          which is why this searches the whole graph rather than one list. */}
      <label className="field-label">About</label>
      <SubjectPicker chosen={subjects} onAdd={addSubject} onError={onError} />
      <div className="chips artifact-subjects">
        {subjects.length === 0 &&
          <span className="muted">Nothing yet — search above to say what this is about.</span>}
        {subjects.map((s) => (
          <span key={s.id} className={`chip subject ${s.type}`}>
            <span className="chip-label">{s.label}</span>
            <button className="chip-x" title="Remove" onClick={() => removeSubject(s.id)}>×</button>
          </span>
        ))}
      </div>

      <label className="field-label">Title</label>
      <input
        className="artifact-title"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="What you'd call this remark"
      />

      <label className="field-label">
        Remark
        <span className="muted field-hint"> — select text and press ⌘K to link to anything in the guide</span>
      </label>
      <textarea
        ref={bodyRef}
        className="artifact-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onBodyKeyDown}
        rows={14}
        placeholder="Write what you're thinking…"
      />

      {references.length > 0 && (
        <div className="artifact-refs">
          <label className="field-label">References</label>
          <ul>
            {references.map((r) => (
              <li key={r.rawId} className={r.title ? '' : 'broken'}>
                {r.title ?? <>⚠ broken link <span className="mono">{r.rawId}</span> — the target is gone or the link is malformed</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Publish state. A draft is curator-only; publishing is the one act that puts
          a remark in front of readers, so it's a deliberate control, not a default. */}
      <div className="vis-control">
        <span className="field-label vis-label">Publish</span>
        <button
          type="button"
          className={`publish-toggle ${visibility === 'private' ? 'draft' : 'published'}`}
          onClick={() => setVisibility(visibility === 'private' ? 'public' : 'private')}
        >
          {visibility === 'public' ? 'Published' : 'Draft (private)'}
        </button>
        <span className="muted vis-hint">
          {visibility === 'public'
            ? 'Readers can see this remark.'
            : 'Only curators can see this — a draft or working note.'}
        </span>
      </div>

      {/* Save left, delete across from it on the right — the order styles.css
          states at .save-row and the document panel already follows. This panel
          had them swapped, so the two windows put destructive and primary actions
          under opposite hands. */}
      <div className="save-row artifact-actions">
        <button className="save" onClick={save} disabled={!canSave}>
          {busy ? 'Saving…' : artifact ? 'Save' : 'Create remark'}
        </button>
        {!canSave && !busy && (
          <span className="muted save-blocked">
            {label.trim() === '' ? 'Needs a title.' : subjects.length === 0 ? 'Pick what it’s about.' : ''}
          </span>
        )}
        {artifact && !confirmDelete &&
          <button className="danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
        {artifact && confirmDelete && (
          <span className="confirm-inline">
            Delete this remark?
            <button className="danger" onClick={remove} disabled={busy}>Yes, delete</button>
            <button className="link-button" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </span>
        )}
      </div>

      {pending && (
        <LinkPicker
          anchor={pending.anchor}
          onPick={insertLink}
          onCancel={() => setPending(null)}
          onError={onError}
        />
      )}
    </div>
  )
}

// -- subject search (any node type) ------------------------------------------

function SubjectPicker(
  { chosen, onAdd, onError }:
  { chosen: NodeHit[]; onAdd: (n: NodeHit) => void; onError: (e: unknown) => void },
) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NodeHit[]>([])

  // Debounced against the DB: the corpus is the whole graph, so this isn't a
  // client-side filter over a list we already hold (Entities can do that; documents
  // alone are too many). A short delay keeps a fast typist from firing a request per
  // keystroke.
  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); return }
    let live = true
    const t = setTimeout(() => {
      api.searchNodes(q)
        .then((r) => { if (live) setResults(r) })
        .catch(onError)
    }, 150)
    return () => { live = false; clearTimeout(t) }
  }, [query])

  const chosenIds = new Set(chosen.map((c) => c.id))
  const shown = results.filter((r) => !chosenIds.has(r.id))

  return (
    <div className="concept-search">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown.length > 0) { onAdd(shown[0]); setQuery('') }
          if (e.key === 'Escape') setQuery('')
        }}
        placeholder="Search concepts, documents, people, organizations, sources…"
      />
      {query.trim() && (
        <ul className="search-results">
          {shown.map((r) => (
            <li key={r.id}>
              <button onClick={() => { onAdd(r); setQuery('') }}>
                {r.label}
                <span className={`chip ${r.type}`}>
                  <span className="chip-label">{r.type}</span>
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 &&
            <li className="no-match muted">Nothing matches “{query.trim()}”.</li>}
        </ul>
      )}
    </div>
  )
}

// The ⌘K picker moved to `LinkPicker.tsx` when the document summary grew the same
// gesture — one dialog, three editors now. See the note at its definition.
