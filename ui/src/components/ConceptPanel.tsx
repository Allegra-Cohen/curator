import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { makeLink } from '../links'
import LinkPicker from './LinkPicker'
import type { ConceptDetail, GraphNode, LinkHit } from '../types'

/** A pending new concept: where in the hierarchy it will be born. Null parent =
 *  new top-level concept. */
export interface Draft {
  parentId: string | null
  parentLabel: string | null
}

interface Props {
  conceptId: string | null
  /** When set, the panel is composing a NEW concept (not yet in the graph); it
   *  takes precedence over conceptId. Save creates it. */
  draft: Draft | null
  /** Title of the open document — the Assign button's target. Null: no document,
   *  so there is nothing to assign to and the button is absent. */
  docTitle: string | null
  /** Does the open document already carry this concept (unsaved-inclusive)? */
  assigned: boolean
  onAssign: (conceptId: string) => void
  /** Send this concept's documents to the left column — optionally opening one. */
  onShowDocuments: (heading: string, docs: GraphNode[], selectId?: string) => void
  /** A draft was saved: the new concept node. App reloads and opens it. */
  onCreated: (node: GraphNode) => void
  /** An existing concept was saved (e.g. renamed) — App reloads the ontology so
   *  the new label shows in the table, chips, and pivots. */
  onChanged: () => void
  /** Reported up so App can warn before a click swaps an unsaved edit (or an
   *  unsaved new concept) away. */
  onDirtyChange: (dirty: boolean) => void
  onError: (e: unknown) => void
}

/** Long titles would push the button off the panel; the full one is in its tooltip. */
const truncate = (s: string, n = 28) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s)

// The comma is load-bearing and not guessable: it separates alternative queries,
// each searched independently. Written as a list it reads like any keyword list;
// without knowing that, curators write one long AND that matches almost nothing.
const KEYWORD_HINT = 'Comma to separate, AND/OR/NOT and parentheses to define'

// Description is the reader's definition — the one concept field the viewer publishes,
// which is why it may quote a source and cite it, and why its hint is the ⌘K one worded
// exactly as the summary and remark editors' (it is the same gesture). Semantic search
// is the prose sent to OpenAlex's vector index, and citation text in a vector query is
// noise, which is why these are two boxes and not one. Nothing falls back: an empty
// search box means the concept is skipped for OpenAlex, and the report says so by name.
const DESCRIPTION_HINT = 'select text and press ⌘K to link to anything in the guide'
const SEMANTIC_HINT = 'sent to OpenAlex — not shown to readers'

// The ontology's mirror of DetailsPanel: metadata + the curator's write surface
// for one concept. Same shape, other side of the screen — documents are edited on
// the left, concepts on the right. It doubles as the *create* surface: clicking an
// insertion line in the table opens a draft here, and Save is what actually writes
// it. The name is editable so a concept can be renamed (repurposed) in place rather
// than deleted and rebuilt.
export default function ConceptPanel({
  conceptId, draft, docTitle, assigned, onAssign, onShowDocuments,
  onCreated, onChanged, onDirtyChange, onError,
}: Props) {
  const [detail, setDetail] = useState<ConceptDetail | null>(null)
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [semanticQuery, setSemanticQuery] = useState('')
  const [keywords, setKeywords] = useState('')
  const [criteria, setCriteria] = useState('')
  const [busy, setBusy] = useState(false)

  // The ⌘K link flow over the DESCRIPTION — the same gesture, picker and token the
  // summary and remark editors use (DetailsPanel, ArtifactsPanel). It belongs here
  // because the description is the third piece of guide prose the viewer renders
  // through markdown.tsx: a definition that quotes a paper should be able to say which
  // paper, and a uuid is not something anyone types by hand. The SEARCH box gets no
  // such affordance and wants none — nothing reads it but a vector index.
  const [pendingCite, setPendingCite] =
    useState<{ anchor: string; start: number; end: number } | null>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  // Where to put the caret after the insert rewrites the field. React drops the cursor
  // to the end of a controlled value it didn't expect to change, which would strand the
  // curator at the bottom of the box mid-sentence.
  const caret = useRef<number | null>(null)
  useEffect(() => {
    if (caret.current !== null && descRef.current) {
      descRef.current.focus()
      descRef.current.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  })

  // An empty selection is a no-op — there is nothing to anchor — matching every
  // editor's link command. ⌘K is swallowed either way, so the keystroke doesn't
  // half-work depending on whether anything was highlighted.
  const onDescriptionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      const { selectionStart: start, selectionEnd: end } = e.currentTarget
      if (start === end) return
      setPendingCite({ anchor: description.slice(start, end), start, end })
    }
  }

  const insertLink = (hit: LinkHit) => {
    if (!pendingCite) return
    const token = makeLink(pendingCite.anchor, hit.id)
    caret.current = pendingCite.start + token.length
    setDescription(
      description.slice(0, pendingCite.start) + token + description.slice(pendingCite.end))
    setPendingCite(null)
  }

  // Rendered under whichever form is showing. Both write the same field, so the flow
  // above is shared rather than duplicated per form.
  const citePicker = pendingCite && (
    <LinkPicker
      anchor={pendingCite.anchor}
      onPick={insertLink}
      onCancel={() => setPendingCite(null)}
      onError={onError}
    />
  )

  const isDraft = draft !== null

  // Draft mode: start blank whenever a new draft opens (or its parent changes).
  useEffect(() => {
    if (!isDraft) return
    setDetail(null)
    setLabel(''); setDescription(''); setSemanticQuery('')
    setKeywords(''); setCriteria('')
  }, [isDraft, draft?.parentId])

  // Existing concept: load it. Skipped while composing a draft.
  useEffect(() => {
    if (isDraft) return
    if (!conceptId) {
      setDetail(null); setLabel(''); setDescription(''); setSemanticQuery('')
      setKeywords(''); setCriteria('')
      return
    }
    let live = true            // a slow fetch must not clobber a newer selection
    api.concept(conceptId)
      .then((d) => {
        if (!live) return
        setDetail(d)
        setLabel(d.concept.label)
        setDescription(d.concept.attributes.description ?? '')
        setSemanticQuery(d.concept.attributes.semantic_query ?? '')
        setKeywords(d.concept.attributes.keywords ?? '')
        setCriteria(d.concept.attributes.criteria ?? '')
      })
      .catch(onError)
    return () => { live = false }
  }, [conceptId, isDraft])

  const savedLabel = detail?.concept.label ?? ''
  const savedDesc = detail?.concept.attributes.description ?? ''
  const savedSem = detail?.concept.attributes.semantic_query ?? ''
  const savedKw = detail?.concept.attributes.keywords ?? ''
  const savedCrit = detail?.concept.attributes.criteria ?? ''
  // A draft is dirty the moment it holds any content (so click-away is guarded);
  // an existing concept is dirty when any field diverges from the saved node.
  const dirty = isDraft
    ? (label.trim() !== '' || description !== '' || semanticQuery !== ''
        || keywords !== '' || criteria !== '')
    : (!!detail && (label !== savedLabel || description !== savedDesc
        || semanticQuery !== savedSem || keywords !== savedKw
        || criteria !== savedCrit))
  useEffect(() => { onDirtyChange(dirty) }, [dirty])

  if (isDraft) {
    const create = async () => {
      setBusy(true)
      try {
        const node = await api.createConcept({
          label: label.trim(),
          parent_id: draft!.parentId,
          description, semantic_query: semanticQuery, keywords, criteria,
        })
        onCreated(node)
      } catch (e) { onError(e) } finally { setBusy(false) }
    }

    return (
      <div className="details">
        <div className="panel-head">
          <h3>New concept</h3>
        </div>
        <p className="muted draft-context">
          {draft!.parentId
            ? <>Subtopic of <strong>{draft!.parentLabel}</strong></>
            : <>New top-level concept</>}
        </p>

        <label className="field-label">Name</label>
        <input
          className="concept-name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Concept name…"
          autoFocus
        />

        <label className="field-label">
          Description <span className="field-hint">{DESCRIPTION_HINT}</span>
        </label>
        <textarea ref={descRef} value={description} onKeyDown={onDescriptionKeyDown}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this concept covers…" rows={3} />
        {citePicker}
        <label className="field-label">
          Semantic search <span className="field-hint">{SEMANTIC_HINT}</span>
        </label>
        <textarea value={semanticQuery} onChange={(e) => setSemanticQuery(e.target.value)}
                  placeholder="Describe the work you want found, in plain prose…" rows={3} />
        <label className="field-label">
          Keywords <span className="field-hint">{KEYWORD_HINT}</span>
        </label>
        <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)}
                  placeholder="e.g. AI AND literacy, LLMs AND reading comprehension" rows={2} />
        <label className="field-label">Criteria</label>
        <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)}
                  placeholder="What qualifies a document for this concept…" rows={3} />

        <div className="row save-row">
          <button className="save" disabled={busy || label.trim() === ''} onClick={create}>
            {busy ? 'Creating…' : 'Create'}
          </button>
          <span className="muted">Unsaved — not created until you save.</span>
        </div>
      </div>
    )
  }

  if (!conceptId) return <div className="details muted">No concept selected.</div>
  if (!detail) return <div className="details muted">Loading…</div>

  const save = async () => {
    setBusy(true)
    try {
      const n = await api.updateConcept(detail.concept.id, {
        label: label.trim(), description, semantic_query: semanticQuery,
        keywords, criteria,
      })
      // Re-seed from the server's response so `dirty` settles back to false.
      setDetail({ ...detail, concept: n })
      setLabel(n.label)
      onChanged()   // label may have changed — refresh the table/chips/pivots
    } catch (e) { onError(e) } finally { setBusy(false) }
  }

  return (
    <div className="details">
      <div className="panel-head">
        <input
          className="concept-name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Concept name…"
          title="Rename this concept"
        />
        {docTitle && (
          <button
            className="assign"
            disabled={assigned}
            onClick={() => onAssign(detail.concept.id)}
            title={assigned ? `Already assigned to "${docTitle}"` : `Assign to "${docTitle}"`}
          >
            {assigned ? 'Assigned to ' : 'Assign to '}{truncate(docTitle)}
          </button>
        )}
      </div>

      <label className="field-label">
        Description <span className="field-hint">{DESCRIPTION_HINT}</span>
      </label>
      <textarea
        ref={descRef}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={onDescriptionKeyDown}
        placeholder="What this concept covers…"
        rows={3}
      />
      {citePicker}

      <label className="field-label">
        Semantic search <span className="field-hint">{SEMANTIC_HINT}</span>
      </label>
      <textarea
        value={semanticQuery}
        onChange={(e) => setSemanticQuery(e.target.value)}
        placeholder="Describe the work you want found, in plain prose…"
        rows={3}
      />

      <label className="field-label">
        Keywords <span className="field-hint">{KEYWORD_HINT}</span>
      </label>
      <textarea
        value={keywords}
        onChange={(e) => setKeywords(e.target.value)}
        placeholder="e.g. AI AND literacy, LLMs AND reading comprehension"
        rows={2}
      />

      <label className="field-label">Criteria</label>
      <textarea
        value={criteria}
        onChange={(e) => setCriteria(e.target.value)}
        placeholder="What qualifies a document for this concept…"
        rows={3}
      />

      {/* The label sends the whole set to the left column; a row sends the set AND
          opens that one. Either way the left column ends up holding the list, so
          what you're reading always has its siblings beside it. */}
      <button
        className="field-label link-label"
        disabled={detail.documents.length === 0}
        onClick={() => onShowDocuments(detail.concept.label, detail.documents)}
        title="Show these in the document list"
      >
        Documents ({detail.documents.length})
      </button>
      {detail.documents.length === 0
        ? <span className="muted">No documents categorized here yet.</span>
        : (
          <ul className="plain-list">
            {detail.documents.map((d) => (
              <li key={d.id}>
                <button
                  className="doc-link"
                  title={d.label}
                  onClick={() => onShowDocuments(detail.concept.label, detail.documents, d.id)}
                >
                  {d.attributes.title || d.label}
                </button>
              </li>
            ))}
          </ul>
        )}

      <div className="row save-row">
        <button className="save" disabled={busy || !dirty} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {dirty && <span className="muted">Unsaved changes</span>}
      </div>
    </div>
  )
}
