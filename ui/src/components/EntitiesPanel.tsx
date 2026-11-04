import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { notify, onFieldGuideEvent } from '../broadcast'
import type { Credit, EntityRow, GraphNode } from '../types'
import EntityDialog from './EntityDialog'

// Everyone the guide knows about: people and organizations in one list.
//
// Its own window, on the SCOPE and SOURCES precedent — occasional maintenance that
// shouldn't compete with the working columns. Until now there was no way to see the
// whole population at all: entities were only reachable through a document that
// happened to credit them, so a duplicate or a mistyped node was invisible unless
// you stumbled onto it.
//
// Corrections deliberately DON'T happen here. Clicking a row opens the card in the
// main window, beside the pivots the change moves — a rename shifts every row
// bearing that name, and making that edit in a window that can't show it would hide
// the consequence. This window finds things; the card fixes them.
export default function EntitiesPanel() {
  const [rows, setRows] = useState<EntityRow[]>([])
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'person' | 'organization'>('all')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<EntityRow | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => api.entities().then(setRows).catch((e) => setError(String(e)))
  useEffect(() => { load() }, [])
  // A correction made in the main window changes what belongs on this list.
  useEffect(() => onFieldGuideEvent((e) => {
    if (e === 'entities-changed' || e === 'documents-changed') load()
  }), [])

  const allOrgs: Credit[] = useMemo(
    () => rows.filter((r) => r.type === 'organization')
      .map((r) => ({ id: r.id, label: r.label })), [rows])
  // Only for the create dialog's duplicate warning — this window is the one place
  // a curator can see every person at once, so creating a second of one here would
  // be a particularly silly way to end up with a duplicate.
  const allPeople: Credit[] = useMemo(
    () => rows.filter((r) => r.type === 'person')
      .map((r) => ({ id: r.id, label: r.label })), [rows])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => (kind === 'all' || r.type === kind)
      && (!q || r.label.toLowerCase().includes(q)
          || (r.orcid ?? '').toLowerCase().includes(q)))
  }, [rows, query, kind])

  const people = rows.filter((r) => r.type === 'person').length
  const orgs = rows.length - people
  // Nothing credited is the shape the old ingest bug left behind, 1022 times. Worth
  // surfacing as a number: it's the difference between a populated guide and a
  // graph full of names nobody ever used.
  const orphans = rows.filter((r) => r.documents === 0).length

  const onCreated = async (node: GraphNode) => {
    setCreating(false)
    await load()
    notify('entities-changed')
    notify('open-entity', node.id)
  }

  const remove = async (r: EntityRow) => {
    setBusy(true)
    try {
      await api.deleteEntity(r.id)
      setConfirmDelete(null)
      await load()
      // The id goes with it: every other window has to *forget* this node, not just
      // refetch around it — an open card, a credit chip on a document, a heading
      // over its documents are all claims about something no longer in the graph.
      notify('entity-deleted', r.id)
      notify('entities-changed')
      notify('documents-changed')   // credits vanished; accept rates are unmoved but chips aren't
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="entities-page">
      <div className="entities-head">
        <h2>Entities</h2>
        <span className="muted">
          {people} {people === 1 ? 'person' : 'people'}, {orgs}{' '}
          {orgs === 1 ? 'organization' : 'organizations'}
          {orphans > 0 && <> · <span className="rate low">{orphans} credited on nothing</span></>}
        </span>
        <button className="save" onClick={() => setCreating(true)}>New entity</button>
      </div>

      {error && <p className="error" onClick={() => setError(null)}>{error}</p>}

      <div className="entities-controls">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or ORCID…"
        />
        <div className="kind-toggle">
          {(['all', 'person', 'organization'] as const).map((k) => (
            <button key={k} className={kind === k ? 'active' : ''}
                    onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k === 'person' ? 'People' : 'Organizations'}
            </button>
          ))}
        </div>
      </div>

      <table className="entities-table">
        <thead>
          <tr><th>Name</th><th>Kind</th><th>ORCID</th><th>Credited on</th><th /></tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td>
                <button className="link-button strong"
                        title="Open this entity in the main window"
                        onClick={() => notify('open-entity', r.id)}>
                  {r.label}
                </button>
              </td>
              <td><span className={`chip ${r.type}`}><span className="chip-label">{r.type}</span></span></td>
              <td className="mono">{r.orcid ?? <span className="muted">—</span>}</td>
              <td>{r.documents === 0
                ? <span className="muted">nothing</span>
                : r.documents}</td>
              <td>
                <button className="danger" onClick={() => setConfirmDelete(r)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={5} className="muted">
              {rows.length === 0
                ? 'Nobody yet. Entities are created as you credit authors on documents.'
                : 'Nothing matches.'}
            </td></tr>
          )}
        </tbody>
      </table>

      {/* The someday note. Merging and splitting are the two operations this window
          can't do and a list can't really express: "these two A. Persons are one
          person" and "this one A. Person is two, split by subject" are instructions,
          not clicks. They're the natural first tools to hand a model. */}
      <div className="someday">
        <h4>Someday: say it instead</h4>
        <p className="muted">
          Merging and splitting aren't on this list because they don't fit it. “There
          are two A. Persons — one works on literacy, one on physics — split them up
          with their documents” is an instruction, not a button. The plan is a small
          set of tools (merge, split, reassign credits, look an author up) handed to a
          model you talk to, with the changes shown for approval before they land.
          Until then, retyping and correcting happen on the card, one entity at a time.
        </p>
      </div>

      {creating && (
        <EntityDialog
          initialName=""
          allOrgs={allOrgs}
          allPeople={allPeople}
          onCreated={onCreated}
          // Nothing to credit here — this window lists entities, it doesn't attach
          // them to a document. The duplicate warning still earns its place: it's
          // where a curator would otherwise create the second "Jane Doe".
          onUseExisting={() => setCreating(false)}
          onCancel={() => setCreating(false)}
          onError={(e) => setError(String(e))}
        />
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmDelete(null)}>
          <div className="modal danger" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Delete “{confirmDelete.label}”?</h3>
            {confirmDelete.documents > 0 ? (
              <p>
                This is credited on {confirmDelete.documents}{' '}
                document{confirmDelete.documents === 1 ? '' : 's'}. Those credits go
                with it.
              </p>
            ) : (
              <p className="muted">Credited on nothing, so nothing else changes.</p>
            )}
            {/* The tempting wrong move, said before they make it: recreating under
                the right kind silently drops every credit, and retyping doesn't. */}
            <p className="muted">
              If the kind is wrong, open it instead and use “this is
              {confirmDelete.type === 'person' ? ' an organization' : ' a person'}” —
              retyping keeps the credits, deleting and recreating loses them.
            </p>
            <div className="row save-row">
              <button className="save danger" disabled={busy}
                      onClick={() => remove(confirmDelete)}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
              <button disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
