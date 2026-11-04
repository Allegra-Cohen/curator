import { useEffect, useMemo, useRef, useState } from 'react'
import { makeLink } from '../links'
import type {
  Credit, CreditKind, DocumentNode, GraphNode, KindedCredit, LinkHit,
  PendingCredit,
} from '../types'
import LinkPicker from './LinkPicker'
import EntityDialog from './EntityDialog'

interface Props {
  doc: DocumentNode | null
  concepts: { id: string; label: string }[]        // the live (unsaved-inclusive) assignment set
  allConcepts: { id: string; label: string }[]     // everything the search can reach
  onAddConcept: (id: string) => void
  onRemoveConcept: (id: string) => void
  /** The live (unsaved-inclusive) credited set, split for display only — both
   *  halves are `authored_by` edges and go to the server as one list. */
  authors: Credit[]
  corporateAuthors: Credit[]
  /** Everything the two credit searches can reach. */
  allPeople: { id: string; label: string }[]
  allOrgs: { id: string; label: string }[]
  /** `kind` says which field it came from. Not inferred from the id: a just-created
   *  person isn't in `allPeople` yet, so a lookup would file them as the wrong kind. */
  onAddCredit: (c: Credit, kind: 'person' | 'organization') => void
  onRemoveCredit: (id: string) => void
  /** Genuinely anonymous: nobody named AND no organization publishing it. Mutually
   *  exclusive with any credit — the server refuses the contradiction, so the UI
   *  must not offer it. */
  noNamedAuthor: boolean
  onNoNamedAuthorChange: (v: boolean) => void
  /** A person or organization was created from a search — App refetches the graph
   *  so the new node joins the search corpus. */
  onEntityCreated: () => Promise<void>
  /** Correct the scraped venue/date. Its own write, like the title. */
  onSaveMetadata: (patch: { publication?: string; published_date?: string }) => Promise<void>
  /** Discovery's suggestions, awaiting a decision. Deliberately not folded into
   *  `concepts`: a guess must never be mistaken for a decision. */
  proposals: { id: string; label: string }[]
  onAcceptProposal: (id: string) => void
  onRejectProposal: (id: string) => void
  /** Open a concept in the panel on the right. */
  onOpenConcept: (id: string) => void
  /** Open a credited person or organization in that same panel, where it can be
   *  corrected. The counterpart to one-click accept: a create nobody confirmed has
   *  to be reachable afterwards. */
  onOpenCredit: (id: string) => void
  /** Authors accepted from an ORCID proposal but not created yet — they become
   *  nodes during Save. Held here so abandoning a document leaves nothing behind. */
  pendingCredits: PendingCredit[]
  onAddPendingCredit: (c: PendingCredit) => void
  onRemovePendingCredit: (name: string) => void
  /** Correct a NEW chip before Save acts on it — the scraped name, or the kind
   *  guessed from it. Keyed by the name it had, its only identity until Save. */
  onEditPendingCredit: (was: string, next: PendingCredit) => void
  onSave: (summary: string) => Promise<void>
  /** Correct the scraped title. Deliberately its own write, not part of the main
   *  Save: fixing bad metadata shouldn't require committing a review. */
  onSaveTitle: (title: string) => Promise<void>
  /** Ask to delete the open document. App owns the confirm dialog. The note is why
   *  — whatever is unsaved in the Summary box, which is where a curator about to
   *  reject something writes "paywalled". Deliberately not a field of its own: a
   *  document being dismissed from the queue has no summary worth keeping, so the
   *  box is free, and one more input would be one more thing to skip. */
  onDelete: (note: string) => void
  /** Reported up so App can warn before a click swaps an unsaved edit away. */
  onDirtyChange: (dirty: boolean) => void
  onError: (e: unknown) => void
}

const MAX_MATCHES = 8

/** Every in-progress edit for one document, tagged with which document that is.
 *  See the comment at `draft` — the tag is what keeps a stale draft from being
 *  painted for one frame after the open document changes. */
interface Draft {
  docId: string
  summary: string
  publication: string
  publishedDate: string
  title: string
}

// Metadata + the curator's write surface, and the only place concepts get assigned.
// Assignment is a search rather than a hunt through the ontology table: by the time
// the table has hundreds of rows, typing a name you already know beats scanning for
// it — and it leaves a row click meaning exactly one thing. One Save at the bottom
// writes the summary and the assignments together. No automated help.
export default function DetailsPanel({
  doc, concepts, allConcepts, onAddConcept, onRemoveConcept, onOpenConcept,
  proposals, onAcceptProposal, onRejectProposal, onOpenCredit,
  pendingCredits, onAddPendingCredit, onRemovePendingCredit, onEditPendingCredit,
  authors, corporateAuthors, allPeople, allOrgs, onAddCredit, onRemoveCredit,
  noNamedAuthor, onNoNamedAuthorChange, onEntityCreated, onSaveMetadata,
  onSave, onSaveTitle, onDelete, onDirtyChange, onError,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [savingTitle, setSavingTitle] = useState(false)
  const [savingMeta, setSavingMeta] = useState(false)
  // The two search boxes, tagged with their document for the same reason the draft
  // is: cleared by an effect, a half-typed search survived one render into the next
  // document and briefly showed its results dropdown there.
  const [search, setSearch] = useState({ docId: '', concept: '', credit: '' })
  // What the creation dialog is opened with; null when closed. Carries the ORCID
  // too, because a dialog opened from a scraped proposal can prefill one — a name
  // typed into the search box never has an id behind it, so that path passes null.
  const [newEntity, setNewEntity] =
    useState<{ name: string; orcid: string | null } | null>(null)
  // The NEW chip currently being corrected, or null. Distinct from `newEntity`
  // because nothing is created here: this edits a credit that Save will act on,
  // which is the whole reason a curator can check a guessed kind without that check
  // itself putting a node in the graph.
  const [editingPending, setEditingPending] = useState<PendingCredit | null>(null)

  // Every in-progress edit, tagged with the document it belongs to.
  //
  // These used to be separate states re-seeded by `useEffect` on `doc.id`. That's
  // one render too late: the effect runs AFTER the render that already used the
  // previous document's values, so switching documents painted a frame of the old
  // draft — visibly, as a "Save publication & date" button that appeared and then
  // vanished. Tagging the draft with its document and comparing at render time
  // means a draft from another document is simply never read.
  const [draft, setDraft] = useState<Draft | null>(null)
  const active = doc && draft?.docId === doc.id ? draft : null

  // The ⌘K link flow over the SUMMARY, the same gesture the remark editor has and for
  // the same reason: a summary is markdown, read by the same renderer, so the curator
  // can point at things from it — and a uuid is not something anyone types by hand.
  // A selection captured from the textarea, held while the picker resolves it to a
  // node. null = picker closed.
  const [pendingCite, setPendingCite] =
    useState<{ anchor: string; start: number; end: number } | null>(null)
  const summaryRef = useRef<HTMLTextAreaElement>(null)
  // A caret position to restore after the insert rewrites the summary. React puts the
  // cursor at the end of a controlled value it didn't expect to change, which would
  // drop the curator to the bottom of the field mid-sentence.
  const caret = useRef<number | null>(null)
  useEffect(() => {
    if (caret.current !== null && summaryRef.current) {
      summaryRef.current.focus()
      summaryRef.current.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  })

  const searching = doc && search.docId === doc.id ? search : null
  const query = searching ? searching.concept : ''
  const creditQuery = searching ? searching.credit : ''
  const setQuery = (concept: string) =>
    doc && setSearch({ docId: doc.id, concept, credit: creditQuery })
  const setCreditQuery = (credit: string) =>
    doc && setSearch({ docId: doc.id, concept: query, credit })

  const summary = active ? active.summary : (doc?.attributes.summary ?? '')
  const publication = active ? active.publication : (doc?.attributes.publication ?? '')
  const publishedDate = active ? active.publishedDate : (doc?.attributes.published_date ?? '')
  const title = active ? active.title : (doc?.attributes.title ?? doc?.label ?? '')

  // Writing to any field promotes the whole set into a draft for THIS document,
  // seeded from what's on screen — which is the saved value for anything untouched.
  const edit = (patch: Partial<Draft>) => {
    if (!doc) return
    setDraft({
      docId: doc.id, summary, publication, publishedDate, title, ...patch,
    })
  }

  // A draft for a *different* document is dead: nothing was saved, so returning to
  // this one must show the server's state, not what was typed elsewhere. Clearing
  // is safe where the old re-seeding effect was not — render already ignores a
  // stale draft, so this changes nothing on screen and only stops the object
  // surviving a round trip.
  useEffect(() => {
    if (draft && doc && draft.docId !== doc.id) setDraft(null)
    if (doc && search.docId && search.docId !== doc.id)
      setSearch({ docId: '', concept: '', credit: '' })
    // A captured selection belongs to the summary it was taken from: its offsets index
    // THAT string. Leaving the picker open across a document switch would splice the
    // token into a different summary at positions that mean nothing there.
    setPendingCite(null)
  }, [doc?.id])

  // Summary and title are tracked here; concept assignments live in App, which
  // folds them into its own dirty check.
  const dirty = !!doc && (
    summary !== (doc.attributes.summary ?? '') ||
    title !== (doc.attributes.title ?? doc.label ?? '')
  )
  useEffect(() => { onDirtyChange(dirty) }, [dirty])

  // Already-assigned concepts drop out of the results: they're visible as chips
  // right below, and offering to add one again would do nothing.
  const assigned = useMemo(() => new Set(concepts.map((c) => c.id)), [concepts])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return allConcepts
      .filter((c) => !assigned.has(c.id) && c.label.toLowerCase().includes(q))
      .slice(0, MAX_MATCHES)
  }, [query, allConcepts, assigned])

  // ONE credited list, people and organizations together — which is what an
  // `authored_by` edge actually is. Two fields implied the curator had to know
  // which kind a name was before typing it, and made the wrong guess (an author's
  // employer filed as the publisher) look like the form was asking for it. The kind
  // is shown on the chip instead, where a bad scrape can be seen and deleted.
  const allCredits: KindedCredit[] = useMemo(() => [
    ...authors.map((c) => ({ ...c, kind: 'person' as const })),
    ...corporateAuthors.map((c) => ({ ...c, kind: 'organization' as const })),
  ], [authors, corporateAuthors])
  const credited = useMemo(
    () => new Set(allCredits.map((c) => c.id)), [allCredits])

  // Scraped authors aren't rendered from `author_proposals` here any more. App
  // folds them into the credit set when the document is seeded — matched ones as
  // ordinary chips, unmatched ones as pending credits badged NEW — so reading them
  // again in this panel would show every author twice.
  // Already-credited entities drop out for the same reason assigned concepts do:
  // they're chips right below, and re-adding one is a no-op.
  const creditMatches: KindedCredit[] = useMemo(() => {
    const needle = creditQuery.trim().toLowerCase()
    if (!needle) return []
    const tag = (pool: { id: string; label: string }[], kind: CreditKind) =>
      pool.map((p) => ({ ...p, kind }))
    return [...tag(allPeople, 'person'), ...tag(allOrgs, 'organization')]
      .filter((p) => !credited.has(p.id) && p.label.toLowerCase().includes(needle))
      .sort((x, y) => x.label.localeCompare(y.label))
      .slice(0, MAX_MATCHES)
  }, [creditQuery, allPeople, allOrgs, credited])

  if (!doc) return <div className="details muted">No document selected.</div>

  const a = doc.attributes
  const save = async () => { setBusy(true); try { await onSave(summary) } finally { setBusy(false) } }

  // What Delete records as the reason: the text typed into Summary and not saved.
  // Comparing against the saved value is what keeps the two meanings apart — an
  // existing summary is what the document SAYS, and re-filing it as why the
  // document was rejected would put a paper's own abstract-in-brief on its
  // tombstone. See `onDelete`.
  const dismissalNote =
    summary !== (a.summary ?? '') ? summary.trim() : ''

  const add = (id: string) => { onAddConcept(id); setQuery('') }

  // ⌘/Ctrl+K wraps the current selection in a citation. An empty selection is a no-op —
  // there's nothing to anchor — matching the remark editor and every editor's link
  // command. The browser's own ⌘K is suppressed either way, so the keystroke doesn't
  // half-work depending on whether anything was highlighted.
  const onSummaryKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      const { selectionStart: start, selectionEnd: end } = e.currentTarget
      if (start === end) return
      setPendingCite({ anchor: summary.slice(start, end), start, end })
    }
  }

  // The splice. It goes through `edit`, not a setState of its own, so an inserted
  // citation is an edit like any other: it promotes the document into a draft and lights
  // the same Save. A citation nobody saved must not be a citation.
  const insertLink = (hit: LinkHit) => {
    if (!pendingCite) return
    const token = makeLink(pendingCite.anchor, hit.id)
    caret.current = pendingCite.start + token.length
    edit({
      summary: summary.slice(0, pendingCite.start) + token + summary.slice(pendingCite.end),
    })
    setPendingCite(null)
  }

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && matches.length > 0) add(matches[0].id)
    if (e.key === 'Escape') setQuery('')
  }

  const addCredit = (c: KindedCredit) => {
    onAddCredit({ id: c.id, label: c.label }, c.kind)
    setCreditQuery('')
  }

  const metaDirty = publication !== (a.publication ?? '')
    || publishedDate !== (a.published_date ?? '')
  const saveMeta = async () => {
    setSavingMeta(true)
    try { await onSaveMetadata({ publication, published_date: publishedDate }) }
    finally { setSavingMeta(false) }
  }


  const saveTitle = async () => {
    if (savingTitle || title.trim() === '' || title === (a.title || doc.label)) return
    setSavingTitle(true)
    try { await onSaveTitle(title.trim()) }
    finally { setSavingTitle(false) }
  }

  return (
    <div className="details">
      <h3>
        <input
          className="concept-name"
          value={title}
          onChange={(e) => edit({ title: e.target.value })}
          onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === 'Escape') { edit({ title: a.title || doc.label }); (e.target as HTMLInputElement).blur() } }}
          placeholder="Document title…"
          title="Click to edit the title"
        />
      </h3>
      {/* Bibliographic metadata, ALWAYS shown — including the fields the scrape
          didn't fill. These used to render only when present, which made a missing
          author indistinguishable from a field that doesn't exist, and so nothing
          ever prompted anyone to fix one. An empty box asks to be filled; absence
          asks nothing. */}
      <div className="meta-edit">
        <label className="field-label">Authors</label>

        <div className="concept-search">
          <input
            value={creditQuery}
            onChange={(e) => setCreditQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && creditMatches.length > 0) {
                addCredit(creditMatches[0])
              }
              if (e.key === 'Escape') setCreditQuery('')
            }}
            placeholder="Search people and organizations…"
            disabled={noNamedAuthor}
          />
          {creditQuery.trim() && (
            <ul className="search-results">
              {creditMatches.map((c) => (
                <li key={c.id}>
                  <button onClick={() => addCredit(c)}>
                    {c.label}
                    <span className={`chip ${c.kind}`}>
                      <span className="chip-label">{c.kind === 'person' ? 'person' : 'org'}</span>
                    </span>
                  </button>
                </li>
              ))}
              {/* Create is always offered, not only on no-match: "Jane Doe" existing
                  is no reason a different Jane Doe can't be added. The dialog asks
                  which kind — the one thing a name can't tell us. */}
              <li>
                <button className="create-option"
                        onClick={() => setNewEntity({ name: creditQuery.trim(), orcid: null })}>
                  + New author “{creditQuery.trim()}”…
                </button>
              </li>
            </ul>
          )}
        </div>
        {/* One list, coloured by kind. A scrape that guessed wrong — an
            organization filed as a person, or the reverse — is visible here and
            fixed by deleting the chip and searching again.
            TODO: nothing stops the curator crediting an author's *employer*
            alongside them, thinking they're recording where the author works. It's
            a real misreading and it would clog the authorship pivot, but it needs a
            considered answer rather than a guard bolted on here. */}
        <div className="chips">
          {/* Pending credits count as credits for the empty state. They are chips
              rendered right below, so testing `allCredits` alone printed "None yet"
              beside a NEW chip — the message denying the thing next to it. */}
          {allCredits.length === 0 && pendingCredits.length === 0 && (
            <span className="muted">
              {noNamedAuthor ? 'Marked anonymous.' : 'None yet — search above.'}
            </span>
          )}
          {/* Accepted, not yet created. Marked "new" rather than shown as an
              ordinary credit, because it isn't one yet: nothing exists in the graph
              until Save, and a chip that looked identical would be claiming
              otherwise. */}
          {pendingCredits.map((c) => (
            <span key={`pending:${c.name}`} className={`chip credit ${c.kind} pending`}
                  title={`Not in the guide yet — will be created as a ${c.kind} when you save`}>
              {/* Opens the same editor a credited chip does, except there's no node
                  behind it yet: the edit changes what Save will create and writes
                  nothing on its own. */}
              <button className="chip-label"
                      onClick={() => setEditingPending(c)}
                      title="Check the name and what kind of thing this is">
                {c.name}
              </button>
              {/* NEW says "nothing in the guide matched this" — the cue to look
                  twice. The kind rides along because it's a guess from the name and
                  a wrong one is invisible otherwise, not because the curator needs
                  to think about node types. */}
              <span className="chip-note">NEW · {c.kind === 'person' ? 'person' : 'org'}</span>
              <button className="chip-x" title="Not an author of this document"
                      onClick={() => onRemovePendingCredit(c.name)}>×</button>
            </span>
          ))}
          {allCredits.map((c) => (
            <span key={c.id} className={`chip credit ${c.kind}`}>
              {/* Opens the node for editing — the correction path for a one-click
                  create, and for anything else a scrape got wrong. */}
              <button className="chip-label" onClick={() => onOpenCredit(c.id)}
                      title={`Open this ${c.kind}`}>
                {c.label}
              </button>
              <button className="chip-x" title="Remove"
                      onClick={() => onRemoveCredit(c.id)}>×</button>
            </span>
          ))}
        </div>

        {/* Mutually exclusive with the credits above, which is why the searches
            disable when it's ticked: the server refuses the contradiction, and a UI
            that lets you build one only to reject it on Save is worse than one that
            won't let you start. */}
        <label className="checkbox-row" title={
          credited.size > 0
            ? 'Remove the credits above first'
            : 'Nobody is named and no organization publishes it'
        }>
          <input
            type="checkbox"
            checked={noNamedAuthor}
            disabled={credited.size > 0}
            onChange={(e) => onNoNamedAuthorChange(e.target.checked)}
          />
          Anonymous — no author or publisher
        </label>

        <div className="meta-row">
          <div>
            <label className="field-label">
              Publication <span className="field-hint">venue, as text</span>
            </label>
            <input
              value={publication}
              onChange={(e) => edit({ publication: e.target.value })}
              placeholder="e.g. Nature, arXiv, Import AI"
            />
          </div>
          <div>
            <label className="field-label">Date</label>
            <input
              value={publishedDate}
              onChange={(e) => edit({ publishedDate: e.target.value })}
              placeholder="YYYY-MM-DD"
            />
          </div>
        </div>
        {/* Its own save, like the title's: correcting a bad scrape shouldn't have
            to travel with a review decision. */}
        {metaDirty && (
          <div className="row save-row">
            <button className="save" disabled={savingMeta} onClick={saveMeta}>
              {savingMeta ? 'Saving…' : 'Save publication & date'}
            </button>
          </div>
        )}
      </div>

      {/* Typing an author who isn't in the guide yet STAGES them, exactly as a
          scraped NEW chip does — `onStage`, not `onCreated`, so nothing is written
          here. It used to call `POST /api/people` the moment the button was
          pressed, which put a `person` node (and a `member_of` edge, and a
          `writes_at` edge) in the graph for a document still sitting in the review
          queue. Clicking away then left all of it behind with no `authored_by` edge
          pointing at it — the same shape as the 1022 edgeless `person` nodes that
          took node creation out of ingestion in the first place.

          So both routes to an uncreated author now behave alike: correcting a
          scraped name and typing a new one both produce a NEW chip, and `App.save`
          creates the node. It writes immediately for a document already out of the
          review queue too, where it was harmless — one rule beats a rule with a
          condition on it. */}
      {newEntity !== null && (
        <EntityDialog
          initialName={newEntity.name}
          initialOrcid={newEntity.orcid}
          allOrgs={allOrgs}
          allPeople={allPeople}
          onStage={(c) => { onAddPendingCredit(c); setNewEntity(null) }}
          onUseExisting={(c) => { setNewEntity(null); addCredit(c) }}
          onCancel={() => setNewEntity(null)}
          onError={onError}
        />
      )}

      {/* The same dialog in staging mode: same fields, but it edits the pending
          credit and writes nothing. Checking a guessed kind must not be the act
          that commits it. If the corrected name turns out to name something the
          guide already has, `onUseExisting` swaps the NEW chip for that node — the
          common shape of a correction, and the one that would otherwise quietly
          make a second copy. */}
      {editingPending !== null && (
        <EntityDialog
          initialName={editingPending.name}
          initialOrcid={editingPending.orcid}
          initialKind={editingPending.kind}
          initialOrg={editingPending.orgName}
          initialSourceId={editingPending.sourceId}
          allOrgs={allOrgs}
          allPeople={allPeople}
          onStage={(next) => {
            onEditPendingCredit(editingPending.name, next)
            setEditingPending(null)
          }}
          onUseExisting={(c) => {
            onRemovePendingCredit(editingPending.name)
            addCredit(c)
            setEditingPending(null)
          }}
          onCancel={() => setEditingPending(null)}
          onError={onError}
        />
      )}

      {/* The hint is worded exactly as the remark editor's, because it is the same
          gesture — see the note at `onSummaryKeyDown`. */}
      <label className="field-label">
        Summary
        <span className="muted field-hint"> — select text and press ⌘K to link to anything in the guide</span>
      </label>
      <textarea
        ref={summaryRef}
        value={summary}
        onChange={(e) => edit({ summary: e.target.value })}
        onKeyDown={onSummaryKeyDown}
        placeholder="Write the curator summary…"
        rows={5}
      />

      {pendingCite && (
        <LinkPicker
          anchor={pendingCite.anchor}
          onPick={insertLink}
          onCancel={() => setPendingCite(null)}
          onError={onError}
        />
      )}

      {/* Discovery's suggestions, above the assignment surface and visually apart
          from it. Green = proposed, not assigned: nothing here is categorised until
          you press ✓, and Save leaves whatever you haven't decided still pending. */}
      {proposals.length > 0 && (
        <>
          <label className="field-label">
            Proposed <span className="field-hint">found by these concepts' searches — ✓ to accept, × to dismiss</span>
          </label>
          <div className="chips">
            {proposals.map((p) => (
              <span key={p.id} className="chip proposed">
                <button className="chip-label" title={`Open ${p.label}`}
                        onClick={() => onOpenConcept(p.id)}>
                  {p.label}
                </button>
                <button className="chip-ok" title="Accept this concept"
                        onClick={() => onAcceptProposal(p.id)}>✓</button>
                <button className="chip-x" title="Dismiss this suggestion"
                        onClick={() => onRejectProposal(p.id)}>×</button>
              </span>
            ))}
          </div>
        </>
      )}

      <label className="field-label">Concepts</label>
      <div className="concept-search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search concepts to assign…"
        />
        {query.trim() && (
          <ul className="search-results">
            {matches.map((c) => (
              <li key={c.id}>
                <button onClick={() => add(c.id)}>{c.label}</button>
              </li>
            ))}
            {matches.length === 0 && <li className="muted no-match">No match</li>}
          </ul>
        )}
      </div>

      <div className="chips">
        {concepts.length === 0 && <span className="muted">None yet — search above to assign.</span>}
        {concepts.map((c) => (
          // Two sibling buttons, not a button inside a button: the label opens the
          // concept on the right, the ✕ unassigns it.
          <span key={c.id} className="chip selected">
            <button className="chip-label" title={`Open ${c.label}`}
                    onClick={() => onOpenConcept(c.id)}>
              {c.label}
            </button>
            <button className="chip-x" title="Remove" onClick={() => onRemoveConcept(c.id)}>×</button>
          </span>
        ))}
      </div>

      {/* Save is what files the document and drops it from the queue, so it needs
          at least one concept. Saving with none used to be allowed, which meant a
          document could leave the queue uncategorised — and since proposals stay
          pending through a save, that reads as though the green suggestions had
          been accepted when nothing was. Accepting a proposal or assigning by hand
          are both fine; what's refused is filing on neither.
          Deliberately NOT a gate on authorship: the title, publication and date
          each save on their own, so correcting metadata is still possible here. */}
      <div className="row save-row">
        <button className="save" disabled={busy || concepts.length === 0} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {concepts.length === 0 && (
          <span className="muted save-blocked">
            Assign a concept first — accept one above, or search.
          </span>
        )}
        {/* Across from Save: dismiss this document. Soft pink, not the loud red —
            destructive, but it shouldn't shout over the save it sits beside.
            The reason travels with it: only what's UNSAVED in Summary counts, so
            deleting a document that was reviewed and summarised long ago doesn't
            file its summary as the reason it was rejected. */}
        <button className="danger doc-delete" disabled={busy}
                onClick={() => onDelete(dismissalNote)}>
          Delete document
        </button>
      </div>
    </div>
  )
}
