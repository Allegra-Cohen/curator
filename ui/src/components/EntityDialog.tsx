import { useEffect, useState } from 'react'
import { api } from '../api'
import SinglePicker from './SinglePicker'
import type { CreditKind, GraphNode, KindedCredit, PendingCredit, Source } from '../types'

interface Props {
  /** Pre-fills the name from whatever was typed in the search that opened this. */
  initialName: string
  /** The ORCID the scrape carried, when the dialog was opened from a proposal that
   *  had one. Pre-filling it is the point of plumbing ORCIDs through at all: the
   *  curator confirms an id rather than going to look one up, and `upsert_person`
   *  dedups on it, so the next paper by the same person under a different name
   *  resolves without anyone doing anything. */
  initialOrcid?: string | null
  /** Which kind to open on. Defaults to person; a scraped author arrives with the
   *  kind guessed from its name, which is exactly what this dialog exists to let
   *  the curator confirm or overturn. */
  initialKind?: CreditKind
  /** Affiliation and source already staged on a pending credit, so reopening the
   *  dialog shows what was entered last time rather than blank fields. */
  initialOrg?: string | null
  initialSourceId?: string | null
  /** Organizations already in the graph — the affiliation field's search corpus.
   *  Typing a name that isn't here creates it on save. */
  allOrgs: { id: string; label: string }[]
  /** People already in the graph. Only used to catch a name that's already here:
   *  correcting a scrape is often correcting it *towards* something that exists,
   *  and silently making a second node for it is how a guide grows two of someone. */
  allPeople: { id: string; label: string }[]
  /** Credit the existing node instead of making another with the same name. Offered,
   *  never forced — two people really do share a name, and the create path has always
   *  allowed a deliberate second one. */
  onUseExisting: (c: KindedCredit) => void
  /** Created (or found — the server upserts), with which kind it turned out to be
   *  so the caller can file the chip without waiting for a graph refetch. */
  onCreated?: (node: GraphNode, kind: CreditKind) => void
  /** Staging mode: hand the edited values back and write NOTHING.
   *
   *  For a scraped author who isn't in the guide yet. The chip is already credited
   *  by default and the node is created at Save, so opening it to check a guessed
   *  kind must not be the act that commits it — that would make inspection more
   *  dangerous than ignoring it. Mutually exclusive with `onCreated`.
   *
   *  It offers the same fields as creating, because the moment you're looking at an
   *  author is the moment you know their affiliation; they travel on the pending
   *  credit and are applied when Save creates the node. */
  onStage?: (c: PendingCredit) => void
  onCancel: () => void
  onError: (e: unknown) => void
}

// Creating an author is the one moment the curator is thinking hard about a
// specific person or body, so it's where the things that are tedious to add later
// belong: the ORCID that makes identity resolution exact, the employer, the
// publication they write for.
//
// The first question is which KIND, because that's the fact the search box can't
// carry — a name looks identical either way, and person/organization is a real
// distinction in the graph (different edges hang off each). Asking up front also
// gives the curator the one place to correct a scrape that guessed wrong.
//
// Everything but the name is optional. A dialog that insists on an affiliation
// invites an invented one, which is the failure `no_named_author` exists to prevent
// one level up.
export default function EntityDialog({
  initialName, initialOrcid, initialKind, initialOrg, initialSourceId,
  allOrgs, allPeople, onCreated, onStage, onUseExisting, onCancel, onError,
}: Props) {
  // A scraped ORCID belongs to a human, so a proposal carrying one is a person
  // until the curator says otherwise -- organizations don't have them.
  const [kind, setKind] = useState<CreditKind>(initialKind ?? 'person')
  // Staging edits a credit; creating writes a node. The FIELDS are the same either
  // way — an affiliation you know now shouldn't have to be re-entered after Save —
  // they're just carried on the pending credit instead of written immediately.
  const staging = !!onStage

  const [name, setName] = useState(initialName)
  const [orcid, setOrcid] = useState(initialOrcid ?? '')
  const [org, setOrg] = useState(initialOrg ?? '')
  const [sourceId, setSourceId] = useState(initialSourceId ?? '')
  const [sources, setSources] = useState<Source[]>([])
  const [busy, setBusy] = useState(false)

  // The source field picks from what's already followed — sources are a deliberate
  // act (they get polled), not something to conjure from a text box here.
  useEffect(() => {
    let live = true
    api.sources()
      .then((s) => { if (live) setSources(s) })
      .catch(onError)
    return () => { live = false }
  }, [])

  // Escape closes, as in any dialog. Bound on the document because focus starts in
  // the name field and may move anywhere inside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Does the guide already hold this name? Checked live, because a correction is
  // often a correction *towards* something that exists ("Center" → "Center for
  // Humane Technology", which is already a node), and quietly creating a second one
  // is how a guide ends up with two of someone. Exact and case-insensitive, matching
  // how the server proposes: fuzzy matching here would be a guess, and not guessing
  // is the point of this whole surface.
  const existing = (() => {
    const key = name.trim().toLowerCase()
    if (!key) return null
    const hit = (pool: { id: string; label: string }[], k: CreditKind) => {
      const n = pool.find((p) => p.label.trim().toLowerCase() === key)
      return n ? { ...n, kind: k } : null
    }
    // The kind on screen is checked first, so a name held by both reads as the
    // thing the curator is currently saying it is.
    return kind === 'organization'
      ? hit(allOrgs, 'organization') ?? hit(allPeople, 'person')
      : hit(allPeople, 'person') ?? hit(allOrgs, 'organization')
  })()

  // (The old `orgMatches` filter lived here; SinglePicker does its own filtering.)
  // An exact hit means the field resolves to the existing org rather than reading
  // as a new one — worth saying, since it looks identical either way.
  const orgExists = allOrgs.some(
    (o) => o.label.trim().toLowerCase() === org.trim().toLowerCase())

  const submit = async () => {
    if (onStage) {
      onStage({
        name: name.trim(), orcid: orcid.trim() || null, kind,
        orgName: org.trim() || null, sourceId: sourceId || null,
      })
      return
    }
    setBusy(true)
    try {
      const node = kind === 'person'
        ? await api.createPerson({
            full_name: name.trim(),
            orcid: orcid.trim() || null,
            org_name: org.trim() || null,
            source_id: sourceId || null,
          })
        : await api.createOrganization(name.trim(), 'institution', sourceId || null)
      onCreated?.(node, kind)
    } catch (e) { onError(e) } finally { setBusy(false) }
  }

  return (
    // Clicking the backdrop cancels; clicks inside must not bubble out to it.
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{staging ? 'Check this author' : 'New author'}</h3>
        {/* Both routes to an uncreated author land here now — a scraped name being
            checked, and a name typed into the search box — so the wording can't
            assume a scrape. */}
        {staging && (
          <p className="muted">
            Not in the guide yet. Check the name and the kind — it’s created when you
            save the document, not now.
          </p>
        )}

        <div className="kind-toggle">
          <button className={kind === 'person' ? 'active' : ''}
                  onClick={() => setKind('person')}>Person</button>
          <button className={kind === 'organization' ? 'active' : ''}
                  onClick={() => setKind('organization')}>Organization</button>
        </div>

        <label className="field-label">Name</label>
        <input
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'person' ? 'Full name…' : 'Organization name…'}
          autoFocus
        />

        {/* Already here under this exact name. A warning rather than a block: two
            people genuinely do share a name, and refusing would make the rarer case
            impossible to express. The button is the one-click version of what the
            curator would otherwise do by hand — cancel, and search for it. */}
        {existing && (
          <div className="dup-warn">
            <span>
              <strong>{existing.label}</strong> is already in the guide
              {' '}({existing.kind === 'person' ? 'person' : 'organization'}).
            </span>
            <button className="link" onClick={() => onUseExisting(existing)}>
              Credit that one instead
            </button>
          </div>
        )}

        {/* ORCID and affiliation are facts about a human. An organization has
            neither — it doesn't work anywhere, and it has no ORCID. */}
        {kind === 'person' && (
          <>
            <label className="field-label">
              ORCID{' '}
              <span className="field-hint">
                {initialOrcid && orcid.trim() === initialOrcid
                  ? 'from the source — check it before saving'
                  : 'optional — makes this person exact rather than a name match'}
              </span>
            </label>
            <input
              className="field"
              value={orcid}
              onChange={(e) => setOrcid(e.target.value)}
              placeholder="0000-0002-1825-0097"
            />

            <label className="field-label">
              Organization{' '}
              <span className="field-hint">
                {org.trim() && !orgExists ? 'will be created' : 'optional — where they work'}
              </span>
            </label>
            {/* Was a <datalist>, on the reasoning that a results list would push the
                rest of the dialog around while you type. .search-results doesn't —
                it's position:absolute and overlays — so this now uses the same
                picker as everywhere else, and a native dropdown stops being the one
                control in the app that looks and behaves unlike its neighbours.

                The value here is a NAME, not an id: an org that isn't in the guide
                yet is created on save, so a typed name is a legitimate value with no
                node behind it. Hence the synthetic option. */}
            <SinglePicker
              value={org.trim() ? { id: org, label: org } : null}
              options={allOrgs}
              chipClass="organization"
              placeholder="Search or type a new one…"
              onPick={(o) => setOrg(o.label)}
              onClear={() => setOrg('')}
              onCreate={(n) => setOrg(n)}
              createLabel={(q) => `+ New organization “${q}”…`}
            />
          </>
        )}

        {/* One edge for both kinds: `writes_at` says "this entity writes at this
            location" and doesn't care whether the entity is a person or a body. */}
        <label className="field-label">
          Writes at <span className="field-hint">optional — one of your followed sources</span>
        </label>
        <SinglePicker
          value={sources.find((s) => s.id === sourceId) ?? null}
          options={sources}
          placeholder="Search followed sources…"
          onPick={(s) => setSourceId(s.id)}
          onClear={() => setSourceId('')}
        />

        <div className="row save-row">
          <button className="save" disabled={busy || name.trim() === ''} onClick={submit}>
            {staging ? 'Done' : busy ? 'Creating…' : `Create ${kind}`}
          </button>
          <button onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
