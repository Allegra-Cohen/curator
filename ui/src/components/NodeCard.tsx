import { useEffect, useState } from 'react'
import { api } from '../api'
import { notify } from '../broadcast'
import SinglePicker from './SinglePicker'
import type { Credit, EntityDetail, GraphNode, Source } from '../types'

interface Props {
  /** The node as the pivots already hold it — enough to render a heading before the
   *  detail fetch lands, so opening a card never flashes an empty panel. */
  node: GraphNode
  /** Organizations the affiliation field can reach; typing a new name creates it. */
  allOrgs: Credit[]
  /** Something about this entity changed — App refetches the graph and the open
   *  document, since a rename moves every chip and every pivot row bearing it. */
  onChanged: () => void
  /** Put this entity's documents in the left column and open one of them. The whole
   *  set, not just the clicked title: an author's body of work is the useful thing
   *  to land in, and it's how a concept's documents already behave. */
  onOpenDocuments: (heading: string, docIds: string[], selectId: string) => void
  onError: (e: unknown) => void
}

// A person or organization, editable.
//
// This card used to be read-only, and its comment said why: "there is no PATCH for
// people or organizations". That was tenable while every entity was created through
// a dialog that asked about each field. It stopped being tenable when accepting an
// ORCID-bearing proposal became one click -- a create nobody confirms is a create
// that has to be correctable afterwards, or the click is just a faster way to be
// wrong. So this is the other half of that feature, not a separate one.
//
// Shaped after the document details panel rather than invented: every field always
// renders, empty when unset. A card that hides what it doesn't have can't be asked
// to fill it in -- which is exactly how missing authors stayed missing.
export default function NodeCard({
  node, allOrgs, onChanged, onOpenDocuments, onError,
}: Props) {
  const [detail, setDetail] = useState<EntityDetail | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmRetype, setConfirmRetype] = useState(false)

  // Drafts are tagged with the node they belong to and compared at render time, not
  // synced by an effect. An effect runs one render too late, so switching entities
  // painted a frame of the previous one's values -- the same bug that showed up in
  // the document panel as a flash of the wrong Save button.
  const [draft, setDraft] = useState<{ id: string; name: string; orcid: string } | null>(null)
  const active = draft?.id === node.id ? draft : null

  const isPerson = node.type === 'person'
  const loaded = detail?.id === node.id ? detail : null

  const name = active ? active.name : node.label
  const orcid = active ? active.orcid : (node.attributes.orcid ?? '')
  const edit = (patch: Partial<{ name: string; orcid: string }>) =>
    setDraft({ id: node.id, name, orcid, ...patch })

  useEffect(() => {
    let live = true
    setDetail(null)
    api.entity(node.id).then((d) => { if (live) setDetail(d) }).catch(onError)
    return () => { live = false }
  }, [node.id])

  useEffect(() => {
    let live = true
    api.sources().then((s) => { if (live) setSources(s) }).catch(onError)
    return () => { live = false }
  }, [])

  const dirty = !!active
    && (name !== node.label || orcid !== (node.attributes.orcid ?? ''))

  const save = async () => {
    setBusy(true)
    try {
      if (isPerson) await api.updatePerson(node.id, { full_name: name, orcid })
      else await api.updateOrganization(node.id, { name })
      setDraft(null)
      notify('entities-changed')
      onChanged()
    } catch (e) { onError(e) } finally { setBusy(false) }
  }

  // Set semantics, like the document panel's authors: hand over the whole list.
  const setAffiliation = async (orgId: string | null) => {
    setBusy(true)
    try {
      await api.updatePerson(node.id, { affiliation_ids: orgId ? [orgId] : [] })
      setDetail(await api.entity(node.id))
      onChanged()
    } catch (e) { onError(e) } finally { setBusy(false) }
  }

  const setWritesAt = async (sourceId: string | null) => {
    setBusy(true)
    try {
      const ids = sourceId ? [sourceId] : []
      if (isPerson) await api.updatePerson(node.id, { source_ids: ids })
      else await api.updateOrganization(node.id, { source_ids: ids })
      setDetail(await api.entity(node.id))
      onChanged()
    } catch (e) { onError(e) } finally { setBusy(false) }
  }

  const retype = async () => {
    setBusy(true)
    try {
      await api.retypeEntity(node.id, isPerson ? 'organization' : 'person')
      setConfirmRetype(false)
      setDraft(null)
      notify('entities-changed')
      onChanged()
    } catch (e) { onError(e) } finally { setBusy(false) }
  }

  return (
    <div className="details">
      <div className="panel-head">
        <h3>{node.label}</h3>
        <span className={`chip ${node.type}`}><span className="chip-label">{node.type}</span></span>
      </div>

      {/* .field, not .concept-name: that one is the borderless 16px/600 style for
          a panel's TITLE (the concept and document panels use it that way). Worn
          by ordinary fields it rendered Name and ORCID a size up and semibold,
          with no visible box until hover. */}
      <label className="field-label">Name</label>
      <input className="field" value={name} onChange={(e) => edit({ name: e.target.value })} />

      {isPerson && (
        <>
          <label className="field-label">ORCID</label>
          <input
            className="field"
            value={orcid}
            onChange={(e) => edit({ orcid: e.target.value })}
            placeholder="0000-0002-1825-0097"
          />
        </>
      )}

      {dirty && (
        <div className="row save-row">
          <button className="save" disabled={busy || name.trim() === ''} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
        </div>
      )}

      {isPerson && (
        <>
          <label className="field-label">Organization</label>
          <SinglePicker
            value={loaded?.affiliations[0] ?? null}
            options={allOrgs}
            disabled={busy || !loaded}
            chipClass="organization"
            placeholder="Search organizations…"
            onPick={(o) => setAffiliation(o.id)}
            onClear={() => setAffiliation(null)}
          />
        </>
      )}

      {/* Pick-only, deliberately: a source is followed and polled, so it's created
          in the Sources window rather than conjured from a text box here. */}
      <label className="field-label">
        Writes at <span className="field-hint">one of your followed sources</span>
      </label>
      <SinglePicker
        value={loaded?.writes_at[0] ?? null}
        options={sources}
        disabled={busy || !loaded}
        placeholder="Search followed sources…"
        onPick={(s) => setWritesAt(s.id)}
        onClear={() => setWritesAt(null)}
      />

      {/* What this entity is credited on. Read-only here: a credit is a statement
          about a *document*, so it's removed from that document's panel, where the
          curator can see what they're detaching it from. */}
      <label className="field-label">
        Credited on {loaded ? `(${loaded.documents.length})` : ''}
      </label>
      {loaded && loaded.documents.length > 0 ? (
        <ul className="entity-docs">
          {loaded.documents.map((d) => (
            <li key={d.id}>
              <button
                className="link-button"
                title="Open this document"
                onClick={() => onOpenDocuments(
                  node.label, loaded.documents.map((x) => x.id), d.id)}
              >
                {d.label}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          {loaded ? 'Nothing yet.' : 'Loading…'}
        </p>
      )}

      {/* The correction for an entity created as the wrong kind — including by the
          one-click accept, which decides "person" from the presence of an ORCID and
          can't ask. In place, so the credits above survive it. */}
      <div className="retype">
        {confirmRetype ? (
          <>
            <p className="muted">
              Make this {isPerson ? 'an organization' : 'a person'}? The node keeps its
              id, so everything it's credited on stays credited.
              {isPerson && orcid && ' Its ORCID will be dropped — organizations don’t have one.'}
            </p>
            <div className="row save-row">
              <button className="save" disabled={busy} onClick={retype}>
                {busy ? 'Changing…' : `Yes, make it ${isPerson ? 'an organization' : 'a person'}`}
              </button>
              <button disabled={busy} onClick={() => setConfirmRetype(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <button className="link-button" onClick={() => setConfirmRetype(true)}>
            This is {isPerson ? 'an organization' : 'a person'}, not {isPerson ? 'a person' : 'an organization'}
          </button>
        )}
      </div>
    </div>
  )
}
