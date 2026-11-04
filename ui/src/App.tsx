import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import DocumentList, { DOCS_DND, type ListMode } from './components/DocumentList'
import DocumentViewer from './components/DocumentViewer'
import SegmentCanvas from './components/SegmentCanvas'
import DetailsPanel from './components/DetailsPanel'
import OntologyPanel, { type OntMode } from './components/OntologyPanel'
import ConceptPanel, { type Draft } from './components/ConceptPanel'
import NodeCard from './components/NodeCard'
import ChatPane from './components/ChatPane'
import { notify, onFieldGuideEvent } from './broadcast'
import { guessKind } from './entityKind'
import type { TableRow } from './ontologyTable'
import type { PivotCell, PivotColumn, TabKey } from './pivot'
import { pendingCount } from './types'
import { colorsByDocument, orderQueue } from './queueSegments'
import { forSave } from './segmentEdit'
import type {
  Credit, DeletionPreview, DocConcept, DocumentNode, EnvironmentState, FullGraph,
  GraphNode, ManualDocumentIn, Ontology,
  PendingCredit,
  SegmentState,
} from './types'

// Glyphs for the four authored-content buttons in the header. Collapsed, the
// glyph is all you see — so each one has to name its window on its own: a ring
// for the boundary SCOPE draws, a funnel for what SOURCES screens through, a
// head for ENTITIES, a sheet of paper for the ARTIFACTS you write.
const GLYPH = {
  scope: <circle cx="8" cy="8" r="5.5" />,
  sources: <path d="M2.8 3.5h10.4L9.2 8.4v4.3L6.8 11.4V8.4z" strokeLinejoin="round" />,
  entities: (
    <>
      <circle cx="8" cy="5.6" r="2.5" />
      <path d="M3.4 13.6c0-2.5 2.1-4.1 4.6-4.1s4.6 1.6 4.6 4.1" strokeLinecap="round" />
    </>
  ),
  artifacts: <rect x="4.2" y="2.4" width="7.6" height="11.2" rx="1.2" />,
}

// A guide that has never been organized. A constant rather than `null` at the call
// sites, so the canvas and its transitions never have to hold "no canvas yet" as a
// separate case from "an empty one".
const NO_SEGMENTS: SegmentState = { segments: [], members: {} }

function Glyph({ shape }: { shape: keyof typeof GLYPH }) {
  return (
    <svg
      className="scope-glyph" viewBox="0 0 16 16" width="13" height="13"
      fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"
    >
      {GLYPH[shape]}
    </svg>
  )
}

// Layout: the queue is a full-height navigator on the far left; the workspace
// beside it is documents (viewer over details) | ontology (table over concept).
//
// Each side owns one job. The left assigns concepts to the open document — by
// search, or the concept panel's Assign button. The right explores the ontology.
// So a row click means exactly one thing (open this concept), which is what lets
// the ontology table stay one surface as it grows columns.
export default function App() {
  const [ontology, setOntology] = useState<Ontology>({ nodes: [], edges: [] })
  // The whole graph, separately from the ontology map: the pivots are built from
  // `about` edges, which /api/ontology doesn't carry.
  const [graph, setGraph] = useState<FullGraph>({ nodes: [], edges: [] })
  const [tab, setTab] = useState<TabKey>('default')
  const [queue, setQueue] = useState<DocumentNode[]>([])
  // The curator's own partition of the queue, made by hand in organization mode and
  // kept out of the graph entirely (`queue_segments.py`). It only ever ORDERS AND
  // COLOURS the list here — nothing about a document changes because it is in a pile.
  const [segments, setSegments] = useState<SegmentState | null>(null)
  // THE CANVAS AS IT STOOD WHEN ORGANIZATION MODE WAS ENTERED — and non-null exactly
  // while the mode is on, which is why `organizing` is derived from it rather than
  // being a second flag that could disagree.
  //
  // The list must not re-sort under the curator on every drop: they are travelling
  // down the queue in order, and a list that moved would lose their place each time.
  // So while the mode is on the ORDER comes from this snapshot and the COLOUR comes
  // from `segments` live — a document dropped on a circle takes its hue at once and
  // stays where it is. Leaving the mode is `setFrozen(null)`, and that one line IS
  // the commit: order falls back to the live canvas and the list re-blocks once.
  const [frozen, setFrozen] = useState<SegmentState | null>(null)
  const organizing = frozen !== null
  // `loadQueue` is captured by the mount effect and by the broadcast subscription,
  // both of which are set up exactly once — so it cannot read `organizing` out of a
  // closure. A ref is what survives that.
  const organizingRef = useRef(organizing)
  useEffect(() => { organizingRef.current = organizing }, [organizing])
  // The left column has two sources now: the review queue, or a clicked cell's
  // documents. Hence "Review queue" living in the app header — it's one source of
  // two, not the column's identity.
  const [listMode, setListMode] = useState<ListMode>('queue')
  // Where the list came from when it isn't the queue: a cell, a column header, a
  // concept's document list. All the same shape — some node's documents. `nodeId`
  // is the node the heading names, when there is a single one: the heading is prose
  // ("Ada Lovelace", "Memory × Insight"), so without the id there's no way to tell
  // that a deleted node is still being advertised over a list of documents.
  const [listSource, setListSource] =
    useState<{ heading: string; docs: GraphNode[]; nodeId?: string } | null>(null)
  const [activeCell, setActiveCell] = useState<string | null>(null)
  // Documents saved in this sitting. Purely a tint: the server drops a document
  // from the queue the moment it's reviewed, so this can never survive a fetch —
  // and shouldn't, since it's a fact about the sitting, not the document.
  const [finished, setFinished] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [doc, setDoc] = useState<DocumentNode | null>(null)
  // Set when the curator clicks a quote in the chat window's evidence table (see
  // ChatPane's onOpenQuote) -- which paragraph the Document Viewer should scroll to
  // and briefly highlight once the document it's for has loaded. Cleared whenever a
  // document is opened any other way, so a stale target can't jump/highlight the
  // wrong paragraph of a document you opened by hand afterward.
  const [scrollToParagraph, setScrollToParagraph] = useState<number | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())  // live concept assignments
  // Discovery's suggestions for the open document, still awaiting a decision. Held
  // OUTSIDE `selection` on purpose: if proposals seeded the assignment set, Save
  // would silently accept every one the curator never looked at, which inverts the
  // rule that automated help is opt-in. Accepting moves one across; rejecting drops it.
  const [proposals, setProposals] = useState<DocConcept[]>([])
  // The live credited set for the open document, split the way the panel shows it.
  // Both halves are `authored_by` edges and go to the server as one list; they're
  // kept apart here only so a person can't be added to the publisher field or the
  // other way round.
  const [credits, setCredits] = useState<Credit[]>([])
  const [orgCredits, setOrgCredits] = useState<Credit[]>([])
  const [noNamedAuthor, setNoNamedAuthor] = useState(false)
  // Authors accepted from an ORCID proposal but not yet created. They exist only
  // here until Save, so clicking away from a document leaves no orphan behind —
  // 1022 of those is what the old ingest-time creation left in the sandbox.
  const [pendingPeople, setPendingPeople] = useState<PendingCredit[]>([])
  // The credit state as the open document was seeded — saved credits plus the
  // scraped proposals that arrive already accepted. The dirty check measures
  // against this rather than against the server's list; see seedDoc.
  const [creditBaseline, setCreditBaseline] =
    useState<{ people: Credit[]; orgs: Credit[]; pending: PendingCredit[] }>(
      { people: [], orgs: [], pending: [] })
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // An entity another window asked us to open, held for one render (see below).
  const [pendingOpen, setPendingOpen] = useState<string | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)   // which ontology *row*
  // Ontology structure editing. `ontMode` is the +/- toggle; `draft` is the
  // in-progress new concept (mutually exclusive with selectedNodeId); `deletePreview`
  // drives the confirm dialog while a delete is pending.
  const [ontMode, setOntMode] = useState<OntMode>('normal')
  const [draft, setDraft] = useState<Draft | null>(null)
  // Whether the right-hand column shows the ontology/concept boxes or the chat
  // shell instead. One switch for both boxes — the toggle button just happens to
  // live in the ontology header. Not wired to anything yet.
  const [chatOpen, setChatOpen] = useState(false)
  // "Make parent of": concepts the in-progress draft will contain, and whether the
  // ontology cards are currently in picking mode. Held here rather than in the
  // concept panel because the two panels split the job — one collects the clicks,
  // the other shows the result and saves it.
  const [deletePreview, setDeletePreview] = useState<DeletionPreview | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  // The document-dismiss confirm dialog: the doc pending deletion, and its in-flight
  // flag. The reason rides along with the doc rather than in a state of its own —
  // it's captured from the Summary box at the moment Delete is pressed, so the two
  // are one decision and must be set and cleared together.
  const [docToDelete, setDocToDelete] =
    useState<{ doc: DocumentNode; note: string } | null>(null)
  const [docDeleteBusy, setDocDeleteBusy] = useState(false)
  const [summaryDirty, setSummaryDirty] = useState(false)
  const [conceptDirty, setConceptDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Transient non-error feedback (e.g. what a discovery run turned up). Separate
  // from `error` so a successful outcome isn't dressed up as a warning.
  const [notice, setNotice] = useState<string | null>(null)
  // Which data set the API is on (sandbox / real guide). Server-held; we just
  // reflect it in the header picker.
  const [env, setEnv] = useState<EnvironmentState | null>(null)
  // What the header Undo button would reverse (null = nothing).
  const [undo, setUndo] = useState<{ available: boolean; description: string | null }>(
    { available: false, description: null })
  // A discovery run is in flight (it's slow — N concepts × 2 APIs + the filter).
  const [scouting, setScouting] = useState(false)
  // The concept picker beside Run search. `null` = search everything (the default);
  // a Set = search exactly those. Narrowing to one concept is what makes tuning its
  // keywords practical — a full run is too slow and too noisy to iterate against.
  const [scoutPick, setScoutPick] = useState<Set<string> | null>(null)
  const [scoutMenu, setScoutMenu] = useState(false)
  // Documents multi-selected in the list, to drag onto a concept for mass-labeling.
  const [markedDocs, setMarkedDocs] = useState<Set<string>>(new Set())
  const [dropActive, setDropActive] = useState(false)   // a doc-drag is over the concept panel
  const [leftPct, setLeftPct] = useState(50)
  // The two columns' top/bottom split — one shared value, so dragging either
  // row-divider moves both rows together.
  const [topPct, setTopPct] = useState(60)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLElement>(null)              // the documents half, for the row divider
  const rightRef = useRef<HTMLElement>(null)            // the ontology half, for click-outside + the row divider

  const catch_ = (e: unknown) => setError(String(e))
  // Every path that (re)opens a document goes through here, so the assignment set
  // and the outstanding proposals can't drift apart.
  // Scraped authors are credited by DEFAULT, not on a click.
  //
  // The inversion is deliberate and specific to authorship. Assigning a concept is
  // a judgement about the guide; agreeing that a byline says what it says is not —
  // it's checking a scrape. So the common case ("yes, those are the authors") costs
  // nothing and the rare one costs a ✕, rather than the reverse. Nothing reaches
  // the graph any earlier for it: these are still only written by Save, and a
  // document you open and walk away from leaves nothing behind.
  //
  // A matched proposal joins the credit lists as an ordinary chip — it's an
  // existing node, so there is nothing to distinguish. An unmatched one becomes a
  // pending credit badged NEW, carrying a guessed `kind` because a node can't be
  // created without one.
  const seedCredits = (d: DocumentNode) => {
    const proposed = d.author_proposals ?? []
    const people = [...(d.authors ?? [])]
    const orgs = [...(d.corporate_authors ?? [])]
    for (const p of proposed) {
      if (!p.match) continue
      const into = p.match.kind === 'organization' ? orgs : people
      if (!into.some((c) => c.id === p.match!.id))
        into.push({ id: p.match.id, label: p.match.label })
    }
    const pending: PendingCredit[] = proposed
      .filter((p) => !p.match)
      .map((p) => ({
        name: p.name,
        orcid: p.orcid,
        // An ORCID settles the kind outright — only humans have one — so it beats
        // reading the name. Everything else is the heuristic, shown on the chip.
        kind: p.orcid ? 'person' : guessKind(p.name),
      }))
    return { people, orgs, pending }
  }

  // `keepEdits` re-reads the document WITHOUT rebuilding the working set.
  //
  // For a refetch caused by something else changing — renaming an entity, say —
  // where the document's own text may have moved but the curator's unsaved
  // decisions about it must not be thrown away. A plain re-seed derives credits
  // from the server, and the server has no idea about a correction that hasn't been
  // saved: fixing a mangled scraped author and then editing that entity's node
  // reverted the chip to the mangled name, because the re-seed rebuilt it from
  // `authors_scraped`. Everything a Save settles still uses the full re-seed —
  // that's how the dirty flags come to rest.
  const seedDoc = (d: DocumentNode, opts?: { keepEdits?: boolean }) => {
    if (opts?.keepEdits && doc && doc.id === d.id) { setDoc(d); return }
    const seeded = seedCredits(d)
    setDoc(d)
    setSelection(new Set(d.concepts.map((c) => c.id)))
    setProposals(d.proposals ?? [])
    setCredits(seeded.people)
    setOrgCredits(seeded.orgs)
    setNoNamedAuthor(!!d.attributes.no_named_author)
    setPendingPeople(seeded.pending)
    // What "unchanged" means for this document. It can't be the server's author
    // list any more: the proposals above are on screen from the first frame, so
    // comparing against what's saved would mark every document dirty the moment you
    // looked at it, and prompt on the way out of one you never touched.
    setCreditBaseline(seeded)
  }
  const loadOntology = () => api.ontology().then(setOntology).catch(catch_)
  const loadGraph = () => api.graph().then(setGraph).catch(catch_)
  // The queue and its segmentation are fetched TOGETHER, and this is the only place
  // either is fetched. Two separate loads could land a moment apart, and in that
  // moment the list would be ordered by a canvas that no longer describes it. It also
  // means the approve path — which deliberately does NOT refetch, so the row you just
  // finished keeps its place (see saveDocument) — keeps its pile and its rail too:
  // the server prunes a reviewed document out of the state on read, and that read
  // doesn't happen until the queue itself is reloaded.
  //
  // While the mode is on the LOCAL canvas is authoritative and a fetched one is
  // dropped on the floor: a Scout run in the Sources window refetches this queue, and
  // adopting the server's segments would throw away an hour of dragging that hasn't
  // been saved yet. The new documents still arrive — unsegmented, at the bottom,
  // which is where the design puts them.
  const loadQueue = () => Promise.all([api.queue(), api.queueSegments()])
    .then(([q, s]) => { setQueue(q); if (!organizingRef.current) setSegments(s) })
    .catch(catch_)
  const loadUndo = () => api.undoStatus().then(setUndo).catch(catch_)

  useEffect(() => { loadOntology(); loadGraph(); loadQueue(); loadUndo() }, [])
  // The Sources window can poll a source and file documents; this window would
  // otherwise show a stale queue until someone reloaded it. Refetching the queue,
  // the graph (the pivots are built from `about` edges) and the undo state covers
  // everything an external run touches. The open document is fetched by id, so an
  // in-progress edit is not disturbed.
  useEffect(() => onFieldGuideEvent((e, payload) => {
    if (e === 'documents-ingested') { loadQueue(); loadGraph(); loadUndo() }
    if (e === 'entities-changed') loadGraph()
    // The Entities window has no card of its own, deliberately: a correction belongs
    // beside the pivots it moves. So it asks this window to open one.
    //
    // Parked in state rather than opened here: this subscription is set up once, so
    // calling openNode from inside it would use the FIRST render's closure forever —
    // and openNode guards unsaved concept edits by reading state that closure can't
    // see. The effect below re-runs on the current render and does.
    if (e === 'open-entity' && payload) { setPendingOpen(payload); window.focus() }
  }), [])

  useEffect(() => {
    if (!pendingOpen) return
    openNode(pendingOpen, null)
    setPendingOpen(null)
  }, [pendingOpen])

  // A deletion gets its own subscription, with the state it reads in the dep list
  // rather than the one-render hop `pendingOpen` uses above. It cannot be deferred:
  // `entities-changed` rides along with it, so the graph is refetched in the same
  // breath, and a render that sees the node gone while the id is still selected
  // *is* the bug — that render mounts the concept panel on a person's id and fetches
  // it. Effects run after the commit, so by the time a deferred handler cleared the
  // id the request would already be on the wire. Re-subscribing costs a channel
  // open/close per selection change.
  useEffect(() => onFieldGuideEvent((e, payload) => {
    if (e === 'entity-deleted' && payload) dropEntity(payload)
  }), [selectedNodeId, listSource])
  useEffect(() => { api.environment().then(setEnv).catch(catch_) }, [])

  // Selecting a document loads its detail and seeds the assignment set from its
  // current concepts.
  useEffect(() => {
    if (!selectedId) {
      setDoc(null); setSelection(new Set()); setProposals([])
      setCredits([]); setOrgCredits([]); setNoNamedAuthor(false)
      return
    }
    api.document(selectedId)
      .then(seedDoc)
      .catch(catch_)
  }, [selectedId])

  const conceptLabel = useMemo(() => {
    const m = new Map<string, string>()
    ontology.nodes.forEach((n) => m.set(n.id, n.label))
    return m
  }, [ontology])

  // Every concept, for the assignment search. The ontology map is concepts-only,
  // so this is a projection of what's already loaded — no extra fetch.
  const allConcepts = useMemo(
    () => ontology.nodes.map((n) => ({ id: n.id, label: n.label })),
    [ontology],
  )
  // The subtopic_of tree, for the Run-search picker. `subtopic_of` runs child ->
  // parent (source = child, target = parent), so this maps a parent to its kids.
  const childrenOf = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const e of ontology.edges) {
      if (e.type !== 'subtopic_of') continue
      m.set(e.target, [...(m.get(e.target) ?? []), e.source])
    }
    return m
  }, [ontology])
  // The picker shown depth-first with indentation, so unchecking a parent (which
  // cascades to its subtree) has a *visible* effect — in a flat list the children
  // it clears are scattered and the cascade looks like nothing happened. Each
  // concept appears once even when poly-parented; visited-guarded because the
  // ontology doesn't guarantee acyclicity (graph TODO #2).
  const pickerRows = useMemo(() => {
    const rows: { id: string; label: string; depth: number }[] = []
    const seen = new Set<string>()
    const labelOf = new Map(allConcepts.map((c) => [c.id, c.label]))
    const isChild = new Set(
      ontology.edges.filter((e) => e.type === 'subtopic_of').map((e) => e.source),
    )
    const walk = (id: string, depth: number) => {
      if (seen.has(id)) return
      seen.add(id)
      rows.push({ id, label: labelOf.get(id) ?? id, depth })
      for (const kid of childrenOf.get(id) ?? []) walk(kid, depth + 1)
    }
    for (const c of allConcepts) if (!isChild.has(c.id)) walk(c.id, 0)
    for (const c of allConcepts) if (!seen.has(c.id)) walk(c.id, 0) // cycle-only
    return rows
  }, [allConcepts, ontology, childrenOf])
  // A concept plus everything beneath it in the subtopic_of tree.
  const subtreeOf = (id: string): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    const walk = (n: string) => {
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
      for (const kid of childrenOf.get(n) ?? []) walk(kid)
    }
    walk(id)
    return out
  }
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph],
  )
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined

  // The queue as organization mode leaves it: blocked by segment, in canvas reading
  // order, each block keeping the server's tier-then-arrival order inside it. This is
  // the ORDER THE CURATOR SEES, so everything that walks the list walks this — see
  // the advance-to-next in saveDocument.
  const queueRows = useMemo(() => orderQueue(queue, frozen ?? segments),
                            [queue, frozen, segments])
  const listDocs = listMode === 'queue' ? queueRows.map((r) => r.doc) : (listSource?.docs ?? [])
  // Pile colour per row, for the rail and the tint. Empty in cell mode: a segment is
  // a fact about the QUEUE, and a cell's documents are derived from the graph.
  // Read off the LIVE canvas, not off `queueRows` — the rows are ordered by the
  // frozen snapshot while the mode is on, and a colour taken from them would lag a
  // drop by a whole mode.
  const segmentColors = useMemo(
    () => (listMode === 'queue' ? colorsByDocument(segments) : new Map<string, string>()),
    [segments, listMode])
  // The badge counts PENDING, always — so it keeps advertising outstanding work
  // while you're off looking at a cell. It diverges from the LIST on purpose: in
  // queue mode the list shows pending + just-approved, which is more rows than this.
  const outstanding = pendingCount(queue)

  // The document side is dirty if either half of its one Save would be lost: the
  // summary draft (tracked in DetailsPanel) or the assignment set (tracked here).
  const assignmentsDirty = useMemo(() => {
    if (!doc) return false
    const saved = new Set(doc.concepts.map((c) => c.id))
    return saved.size !== selection.size || [...selection].some((id) => !saved.has(id))
  }, [doc, selection])
  // Credits are the third half of the same Save, so they join the same guard —
  // otherwise clicking away silently drops an author you just linked.
  const creditsDirty = useMemo(() => {
    if (!doc) return false
    const same = (live: Credit[], base: Credit[]) =>
      live.length === base.length
      && new Set(live.map((c) => c.id)).size === new Set(base.map((c) => c.id)).size
      && live.every((c) => base.some((s) => s.id === c.id))
    // Pending credits compare by name AND kind: correcting a guessed kind changes
    // what Save will create, so it has to count as an edit even though the chip
    // keeps its name.
    const samePending = (live: PendingCredit[], base: PendingCredit[]) =>
      live.length === base.length
      && live.every((p) => base.some(
        (b) => b.name === p.name && b.kind === p.kind
          && (b.orgName ?? null) === (p.orgName ?? null)
          && (b.sourceId ?? null) === (p.sourceId ?? null)))
    return !same(credits, creditBaseline.people)
      || !same(orgCredits, creditBaseline.orgs)
      || !samePending(pendingPeople, creditBaseline.pending)
      || noNamedAuthor !== !!doc.attributes.no_named_author
  }, [doc, credits, orgCredits, noNamedAuthor, pendingPeople, creditBaseline])
  const docDirty = summaryDirty || assignmentsDirty || creditsDirty

  // The credit searches' corpora. `graph` is the whole graph, so people and
  // organizations are already client-side — the same bet as allConcepts, and the
  // reason neither field needs a search endpoint.
  const allPeople = useMemo(
    () => graph.nodes.filter((n) => n.type === 'person')
      .map((n) => ({ id: n.id, label: n.label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [graph])
  const allOrgs = useMemo(
    () => graph.nodes.filter((n) => n.type === 'organization')
      .map((n) => ({ id: n.id, label: n.label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [graph])

  // Which list a credit joins comes from the field it was added in, NOT from
  // looking the id up in allPeople/allOrgs: a just-created person arrives before
  // the graph refetch has landed in state, so the lookup would miss and file them
  // as the wrong kind — silently, and only for newly created entities.
  const addCredit = (c: Credit, kind: 'person' | 'organization') => {
    const [list, set] = kind === 'organization'
      ? [orgCredits, setOrgCredits] as const
      : [credits, setCredits] as const
    if (list.some((x) => x.id === c.id)) return
    set([...list, c])
  }
  const removeCredit = (id: string) => {
    setCredits((cs) => cs.filter((c) => c.id !== id))
    setOrgCredits((cs) => cs.filter((c) => c.id !== id))
  }
  // Keyed by name: a pending credit has no id yet, which is the whole point.
  const addPendingCredit = (c: PendingCredit) =>
    setPendingPeople((ps) => ps.some((x) => x.name === c.name) ? ps : [...ps, c])
  const removePendingCredit = (name: string) =>
    setPendingPeople((ps) => ps.filter((p) => p.name !== name))
  // Correct a NEW chip in place — the name the scraper read, or the kind the
  // heuristic guessed. Keyed by the name it had, since that's its only identity
  // until Save gives it one, and the edit may be changing exactly that.
  const editPendingCredit = (was: string, next: PendingCredit) =>
    setPendingPeople((ps) => ps.map((p) => (p.name === was ? next : p)))

  // Last line of defence: a reload or tab close would drop drafts too.
  useEffect(() => {
    if (!docDirty && !conceptDirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [docDirty, conceptDirty])

  // Entering snapshots the order and stops it changing; leaving commits whatever the
  // canvas says now and lets the list re-block. Both are the one piece of state.
  //
  // The canvas covers the workspace, so entering hides both editors. Unsaved work
  // behind an overlay is work you can't see to save, which is why this asks first —
  // the same guard `selectDoc` and `okToDropConcept` apply for the same reason.
  //
  // Leaving also forgets the circles that never caught anything. They were never in
  // the file (`forSave` doesn't send them), so keeping them in memory would leave a
  // ghost on the canvas the next time the mode is opened — one that vanishes on the
  // next queue reload, which is worse than not being there.
  const exitOrganize = () => {
    setSegments((s) => (s ? forSave(s) : s))
    setFrozen(null)
  }

  const toggleOrganize = () => {
    if (organizing) { exitOrganize(); return }
    if (docDirty && !window.confirm('Discard unsaved changes to this document?')) return
    if (!okToDropConcept()) return
    setDraft(null)
    setFrozen(segments ?? NO_SEGMENTS)
  }

  const selectDoc = (id: string) => {
    if (id === selectedId) return
    if (docDirty && !window.confirm('Discard unsaved changes to this document?')) return
    setMarkedDocs(new Set())   // a plain open is a fresh single selection
    setScrollToParagraph(null)   // opened by hand -- any pending chat-quote target is stale
    setSelectedId(id)
  }

  // The chat window's evidence-table quotes call this (see ChatPane's onOpenQuote)
  // instead of selectDoc: a quote can point at a paragraph in the document that's
  // ALREADY open, where selectDoc's `id === selectedId` guard would (correctly, for
  // every other caller) do nothing -- but a second quote from the same paper still
  // has to scroll there.
  const openQuote = (id: string, paragraph: number) => {
    if (id !== selectedId) {
      if (docDirty && !window.confirm('Discard unsaved changes to this document?')) return
      setMarkedDocs(new Set())
      setSelectedId(id)
    }
    setScrollToParagraph(paragraph)
  }

  // One guard for leaving unsaved concept work — an edited concept OR an
  // in-progress new one. Returns true if it's safe to proceed.
  const okToDropConcept = () =>
    !conceptDirty ||
    window.confirm(draft ? 'Discard this new concept?' : 'Discard unsaved changes to this concept?')

  // Opening a node is the only thing the right side does now. `rowKey` is null when
  // it was opened from somewhere other than a table row (a chip, a cell), where
  // there is no row to focus. Opening a concept also abandons any draft.
  const openNode = (nodeId: string, rowKey: string | null) => {
    if ((draft || nodeId !== selectedNodeId) && !okToDropConcept()) return true
    setDraft(null)
    setFocusedKey(rowKey)
    setSelectedNodeId(nodeId)
    return false
  }
  const clickRow = (row: TableRow) => openNode(row.conceptId, row.key)

  // --- Ontology structure editing (create / delete) ---

  const exitEditMode = () => {
    if (!okToDropConcept()) return
    setDraft(null)
    setDeletePreview(null)
    setOntMode('normal')
  }
  const toggleAdd = () => {
    if (ontMode === 'add') { exitEditMode(); return }
    if (!okToDropConcept()) return
    setDraft(null)
    setDeletePreview(null)
    setTab('default')          // insertion lines only make sense on the concept tab
    setOntMode('add')
  }
  const toggleDelete = () => {
    if (ontMode === 'delete') { exitEditMode(); return }
    if (!okToDropConcept()) return
    setDraft(null)
    setDeletePreview(null)
    setOntMode('delete')
  }

  // Clicking a dividing line: compose a new concept there. Changing which line
  // (or opening one at all) abandons a dirty draft, with a prompt.
  const clickInsert = (parentId: string | null, parentLabel: string | null) => {
    const changing = !draft || draft.parentId !== parentId
    if (changing && !okToDropConcept()) return
    setSelectedNodeId(null)
    setFocusedKey(null)
    setDraft({ parentId, parentLabel })
  }

  // A draft was saved. Refresh, drop the draft, and open the new concept.
  //
  // This returns to normal mode rather than staying in add mode. Add mode used to
  // persist so several concepts could be placed in a row, but the grips that start
  // a drag only render in normal mode — so the curator would finish creating a
  // concept and find nothing on the page could be dragged onto it, which is the
  // usual next step. Placing another concept is one click on Add away.
  const onConceptCreated = async (node: GraphNode) => {
    await Promise.all([loadOntology(), loadGraph()])
    loadUndo()
    setDraft(null)
    setOntMode('normal')
    setSelectedNodeId(node.id)
    setFocusedKey(null)
  }

  // A concept was dragged onto another level. One request, one transaction, one
  // Undo — so a wrong drop is reversed by the header's Undo like any other edit,
  // which is why this needs no confirm dialog of its own.
  const reparent = async (
    conceptId: string, from: string | null, to: string | null,
  ) => {
    try {
      await api.reparentConcept(conceptId, from, to)
      await Promise.all([loadOntology(), loadGraph()])
      loadUndo()
    } catch (e) { catch_(e) }
  }

  // Delete mode: a row click asks the server what the delete would take with it,
  // then opens the confirm dialog.
  const askDelete = (conceptId: string) => {
    api.deletionPreview(conceptId).then(setDeletePreview).catch(catch_)
  }
  const confirmDelete = async () => {
    if (!deletePreview) return
    setDeleteBusy(true)
    try {
      const res = await api.deleteConcept(deletePreview.target.id)
      const gone = new Set(res.deleted.map((d) => d.id))
      await Promise.all([loadOntology(), loadGraph(), loadQueue()])
      // Drop anything that pointed at a now-deleted concept.
      if (selectedNodeId && gone.has(selectedNodeId)) { setSelectedNodeId(null); setFocusedKey(null) }
      setSelection((prev) => new Set([...prev].filter((id) => !gone.has(id))))
      // Including the left column's heading, when the list is a deleted concept's
      // documents — those documents outlive the concept (that's the point of
      // re-queueing them), but the name over them doesn't.
      if (listSource?.nodeId && gone.has(listSource.nodeId)) showQueue()
      // The open document may have lost a category (and been re-queued); re-seed it.
      if (selectedId) {
        api.document(selectedId)
          .then(seedDoc)
          .catch(catch_)
      }
      setDeletePreview(null)
      setOntMode('normal')
      loadUndo()
    } catch (e) { catch_(e) } finally { setDeleteBusy(false) }
  }
  const cancelDelete = () => setDeletePreview(null)

  // --- Document dismissal (viewer delete button) ---
  const confirmDeleteDocument = async () => {
    if (!docToDelete) return
    setDocDeleteBusy(true)
    try {
      const id = docToDelete.doc.id
      await api.deleteDocument(id, docToDelete.note)
      // The document and its `about` edges are gone — every pivot cell is built from
      // `about`, so the graph refetch is load-bearing, not defensive. It may also
      // have been pending, so refetch the queue.
      await Promise.all([loadGraph(), loadQueue()])
      loadUndo()
      notify('documents-changed')      // a dismissal moves a source's accept rate
      // Drop every reference to it. Clearing selectedId empties the doc pane via the
      // load effect; also scrub it from the marks, the finished tint, and any cell
      // list it's sitting in.
      if (selectedId === id) setSelectedId(null)
      setMarkedDocs((p) => { const n = new Set(p); n.delete(id); return n })
      setFinished((p) => { const n = new Set(p); n.delete(id); return n })
      setListSource((s) => (s ? { ...s, docs: s.docs.filter((d) => d.id !== id) } : s))
      setDocToDelete(null)
    } catch (e) { catch_(e) } finally { setDocDeleteBusy(false) }
  }

  // --- Run search (header button) ---
  // Searches every concept and drops what survives into the review queue. It's one
  // undoable action server-side, so a run that pulls in junk is reversible.
  const doScout = async () => {
    setScouting(true)
    setScoutMenu(false)
    try {
      const r = await api.runScout(scoutPick ? [...scoutPick] : undefined)
      notify('documents-ingested')
      await loadQueue()
      loadUndo()
      showQueue()    // land the curator on the new work rather than announcing it
      // Degraded runs still succeed, so say which half was missing rather than
      // letting a key-less run look like a thin corpus.
      const notes = [
        !r.openalex && 'no OpenAlex key — arXiv only',
        !r.filtered && 'no Anthropic key — unfiltered',
        // Say it plainly: a throttled search returns nothing, which would
        // otherwise read as "no such papers exist". Re-running usually fixes it.
        r.failures > 0 && `${r.failures} search${r.failures > 1 ? 'es' : ''} failed ` +
          '(likely rate-limiting) — re-run to catch what they missed',
      ].filter(Boolean)
      // "already known" and "dismissed" are counted during search, where the drop
      // actually happens — the ingest report can't see them, so it always said 0.
      const known = r.already_known + r.duplicates
      setNotice(
        `Search done: ${r.ingested} new of ${r.candidates} found` +
        (known ? `, ${known} already known` : '') +
        (r.dismissed + r.suppressed ? `, ${r.dismissed + r.suppressed} previously dismissed` : '') +
        (r.dropped ? `, ${r.dropped} filtered out` : '') +
        (notes.length ? ` · ${notes.join('; ')}` : '') +
        ` · report: ${r.report.split('/').pop()}`)
    } catch (e) { catch_(e) } finally { setScouting(false) }
  }

  // --- Add by hand (the + in the review queue header) ---
  // The other end of the funnel from Run search: discovery brings back what the
  // concepts asked for, this takes what the curator already found in the wild. The
  // box itself lives in the list header — this is only the part that needs App's
  // reach (the queue, the undo state, the other windows).
  const addDocuments = async (urls: string[]) => {
    const r = await api.addDocuments(urls)
    notify('documents-ingested')
    await loadQueue()
    loadUndo()
    // Only jump to the queue when something actually arrived. A paste that was
    // entirely duplicates has no new work to land on, and yanking the curator out
    // of whatever they were browsing to show them that would be noise.
    if (r.added.length || r.restored.length) showQueue()
    return r
  }

  // The fallback for a URL that showed up in `failed` above: our own fetch
  // couldn't reach it, but the curator can still open it themselves and type in
  // what they see. Same after-effects as addDocuments (reload the queue, jump to
  // it) since it lands the same way — a pending, uncategorized document.
  const addManualDocument = async (doc: ManualDocumentIn) => {
    const r = await api.addManualDocument(doc)
    notify('documents-ingested')
    await loadQueue()
    loadUndo()
    if (r.added.length || r.restored.length) showQueue()
    return r
  }

  // --- Undo (header button) ---
  const doUndo = async () => {
    try {
      const res = await api.undo()
      if (!res.undone) { loadUndo(); return }
      await Promise.all([loadOntology(), loadGraph(), loadQueue()])
      loadUndo()
      notify('documents-changed')      // undo can restore or re-file documents
      setDeletePreview(null)
      // The open concept/document may have been un/re-made; re-seed the open doc.
      if (selectedId) {
        api.document(selectedId)
          .then(seedDoc)
          .catch(() => { setSelectedId(null) })
      }
    } catch (e) { catch_(e) }
  }

  // --- Multi-select + drag-to-label ---
  // Modifier-click builds the set to drag onto a concept. THE OPEN DOCUMENT IS THE
  // SET'S FIRST MEMBER (curator's call, 2026-08-25): marking is an extension of
  // selecting, not a second thing beside it, so starting a set from a document you
  // are reading takes that document with you. Which is why a marked row and the open
  // row look identical — there is nothing to distinguish, and the ◉ that used to
  // claim otherwise is gone.
  //
  // Unmarking the open row leaves it OPEN and merely out of the set (curator's call):
  // the viewer does not move under a click that was about the selection. So the
  // set's first member is the open document as it is BUILT, and this is the one
  // gesture that can part them.
  const toggleMark = (id: string) => {
    if (markedDocs.has(id)) {
      const n = new Set(markedDocs)
      n.delete(id)
      setMarkedDocs(n)
      return
    }
    // A set opened from nothing starts with what you were reading, then what you just
    // clicked — Set keeps insertion order, so "first" means first here.
    const n = new Set(markedDocs)
    if (n.size === 0 && selectedId) n.add(selectedId)
    n.add(id)
    setMarkedDocs(n)
    // Marking with nothing open opens the first thing marked, so the rule holds from
    // either direction.
    if (!selectedId) setSelectedId(id)
  }

  // The concept panel is the drop target. A drop labels every dragged document with
  // the open concept (add-only categorize), which also clears them from the queue.
  const openConceptId = selectedNodeId && (!selectedNode || selectedNode.type === 'concept')
    ? selectedNodeId : null
  const onDropDocs = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropActive(false)
    const raw = e.dataTransfer.getData(DOCS_DND)
    if (!raw || !openConceptId) return
    const ids: string[] = JSON.parse(raw)
    if (ids.length === 0) return
    try {
      await api.labelDocuments(openConceptId, ids)
      await Promise.all([loadQueue(), loadGraph(), loadOntology()])
      loadUndo()
      setMarkedDocs(new Set())
      if (selectedId && ids.includes(selectedId)) {
        api.document(selectedId)
          .then(seedDoc)
          .catch(catch_)
      }
    } catch (err) { catch_(err) }
  }

  // Esc leaves edit mode (closing the delete dialog first if it's open). Pairs with
  // re-clicking + / − to toggle off.
  useEffect(() => {
    if (ontMode === 'normal') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (deletePreview) { setDeletePreview(null); return }
      exitEditMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ontMode, deletePreview, conceptDirty, draft])

  // A mousedown outside the ontology half also leaves edit mode — clicking away
  // from the concept you were placing/editing is the same "I'm done here" gesture
  // as Esc. The concept editor lives inside `.right`, so clicks there don't count.
  useEffect(() => {
    if (ontMode === 'normal') return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (rightRef.current?.contains(t)) return
      if ((t as HTMLElement).closest?.('.modal-backdrop')) return   // the delete dialog
      exitEditMode()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [ontMode, conceptDirty, draft, deletePreview])

  /** Put some node's documents in the left column, optionally opening one. Every
   *  non-queue source funnels through here — cells, column headers, the concept
   *  panel's list — because they're all the same request: show me these. */
  const showDocuments = (
    heading: string, docs: GraphNode[], selectId?: string, nodeId?: string,
  ) => {
    // Leaving the queue leaves organization mode, and therefore commits the order.
    // The mode is a pass over the QUEUE; a cell's documents come out of the graph and
    // have no piles, so there would be nothing on the canvas to go back to.
    exitOrganize()
    setListSource({ heading, docs, nodeId })
    setListMode('cell')
    if (selectId) selectDoc(selectId)
  }

  const docsFor = (ids: string[]) =>
    ids.map((id) => nodeById.get(id)).filter(Boolean) as GraphNode[]

  // A cell click splits across both sides: its documents become the left column,
  // and its COLUMN node — not the row's — opens on the right. The open document is
  // deliberately left alone; only the list around it changes.
  const clickCell = (row: TableRow, col: PivotColumn, c: PivotCell) => {
    if (openNode(col.id, null)) return   // cancelled at the dirty guard
    setActiveCell(`${row.conceptId}|${col.id}`)
    showDocuments(`${row.label} × ${col.label}`, docsFor(c.documentIds), undefined, col.id)
  }

  // A column header is a node like any other: everything under it, and the node
  // itself below. The difference from a cell is only scope — the whole column
  // rather than its intersection with one row.
  const clickColumn = (col: PivotColumn, docIds: string[]) => {
    if (openNode(col.id, null)) return
    setActiveCell(null)
    showDocuments(col.label, docsFor(docIds), undefined, col.id)
  }

  // Back to the queue — and this is where the "finished" tint expires. The refetch
  // is what drops the rows you already did, so clearing the set alongside it keeps
  // the tint's lifetime exactly one visit.
  const showQueue = () => {
    setListMode('queue')
    setActiveCell(null)
    setListSource(null)
    setFinished(new Set())
    loadQueue()
  }

  /** Forget a person or organization that has left the graph.
   *
   *  A refetch is not enough on its own. Everything this window shows about an
   *  entity is held in state beside the graph, and each piece keeps claiming a node
   *  that isn't there any more:
   *
   *  - **The open card.** The loud one: `selectedNodeId` is a bare id, and an id the
   *    graph can't resolve falls through to the concept panel (see `openConceptId`),
   *    which fetches `GET /concepts/<id>` and 404s in the header.
   *  - **Credit chips** on the open document, which lie quietly — the `authored_by`
   *    edge went with the node, so the chip is offering to un-credit an edge that
   *    no longer exists.
   *  - **The heading** over the left column, when the list is that entity's
   *    documents.
   *
   *  The concept cascade delete does the same thing inline (see `confirmDelete`);
   *  this is that rule reaching a delete made in another window.
   */
  const dropEntity = (id: string) => {
    if (selectedNodeId === id) { setSelectedNodeId(null); setFocusedKey(null) }
    setCredits((prev) => prev.filter((c) => c.id !== id))
    setOrgCredits((prev) => prev.filter((c) => c.id !== id))
    // The baseline drops it too. A chip vanishing here is this document catching up
    // with the graph, not an unsaved edit — measuring against a baseline that still
    // held the deleted credit would mark an untouched document dirty and prompt on
    // the way out of it.
    setCreditBaseline((prev) => ({
      ...prev,
      people: prev.people.filter((c) => c.id !== id),
      orgs: prev.orgs.filter((c) => c.id !== id),
    }))
    // Pending credits are deliberately untouched: they are names typed or accepted
    // here and not yet created, so no node of theirs was deleted. Nothing links them
    // to this id — they have no id until Save.
    if (listSource?.nodeId === id) showQueue()
  }

  // No separate staging — this set is the assignment, persisted on Save. Adding
  // comes from the search or the concept panel; removing, from a chip's ✕.
  const addConcept = (id: string) =>
    setSelection((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  const removeConcept = (id: string) =>
    setSelection((prev) => { const next = new Set(prev); next.delete(id); return next })

  // A proposal leaves the pending list either way; accepting also puts it in the
  // assignment set, where it's indistinguishable from one you added yourself —
  // because at that point you did.
  const acceptProposal = (id: string) => {
    addConcept(id)
    setProposals((prev) => prev.filter((p) => p.id !== id))
  }
  const rejectProposal = (id: string) =>
    setProposals((prev) => prev.filter((p) => p.id !== id))

  // One Save writes the summary and the concept assignments together. What happens
  // next depends on what the left column is: working a queue and browsing a cell
  // want opposite things.
  // Correcting a scraped title. Its own write, so it deliberately does NOT touch
  // review state — you can fix metadata without committing to having reviewed it.
  const saveTitle = async (title: string) => {
    if (!doc) return
    const updated = await api.updateTitle(doc.id, title)
    setDoc(updated)
    // The title is rendered from three separate copies; a fix that only landed in
    // one would read as the edit not having worked. The queue and the graph are
    // refetched; listSource is a snapshot, so patch its entry in place.
    setListSource((s) => s && ({
      ...s,
      docs: s.docs.map((d) => (d.id === updated.id ? updated : d)),
    }))
    if (listMode === 'queue') await loadQueue()
    await loadGraph()
    loadUndo()
  }

  const saveMetadata = async (patch: { publication?: string; published_date?: string }) => {
    if (!doc) return
    const updated = await api.updateMetadata(doc.id, patch)
    setDoc(updated)
    // The publication shows in the document list too, so a fix that only landed
    // here would read as not having worked.
    setListSource((s) => s && ({
      ...s, docs: s.docs.map((d) => (d.id === updated.id ? updated : d)),
    }))
    if (listMode === 'queue') await loadQueue()
    loadUndo()
  }

  const save = async (summary: string) => {
    if (!doc) return
    await api.updateSummary(doc.id, summary)
    // Accepted-but-uncreated authors become nodes HERE, at the last possible
    // moment, so that abandoning a document creates nothing. `upsert_person` dedups
    // on the ORCID, so a name already known under a different spelling resolves to
    // the existing node rather than a twin. `kind` is whatever the chip was showing
    // — the guess if nobody touched it, the correction if they did.
    const created = await Promise.all(pendingPeople.map(
      (p) => (p.kind === 'organization'
        ? api.createOrganization(p.name, 'institution', p.sourceId ?? null)
        : api.createPerson({
            full_name: p.name, orcid: p.orcid,
            org_name: p.orgName ?? null, source_id: p.sourceId ?? null,
          }))))
    // Credits before concepts: setConcepts is what marks the document reviewed and
    // drops it from the queue, so it goes last and everything else is already in.
    await api.setAuthors(
      doc.id,
      [...credits, ...orgCredits].map((c) => c.id).concat(created.map((n) => n.id)),
      noNamedAuthor)
    // Concept proposals are not sent back. Save consumes every one of them: an
    // accepted proposal is already in `selection` and becomes an `about` edge, and
    // one still sitting undecided was passed over deliberately, since Save is gated
    // on assigning at least one concept. Either way the document leaves the review
    // queue, and an approved document is not proposed to.
    const updated = await api.setConcepts(doc.id, [...selection])
    // The graph refetch is load-bearing, not defensive: setConcepts writes `about`
    // edges, and EVERY pivot cell is built from `about`. Without it the table keeps
    // the numbers it computed at page load and drifts further with every save —
    // silently, since nothing errors and the counts merely become wrong.
    await loadGraph()
    loadUndo()
    // Filing a document is what turns it from "pending" into evidence that a source
    // earns its keep, so any open Sources window is showing a stale accept rate.
    notify('documents-changed')

    if (listMode === 'queue') {
      // Deliberately NOT refetching the queue: set_concepts marked the document
      // reviewed, so the server has already dropped it and a refetch would make the
      // row vanish under the cursor. Tint it instead and move to the next one — the
      // trail of what you just did is worth more than a tidy list.
      //
      // The row keeps its place, but its COPY is replaced with the one the server
      // just returned, which says `reviewed`. Keeping the stale copy is what used to
      // make the count wrong: the badge counts pending documents, and a row left
      // claiming to be pending goes on being counted until the next fetch — then gets
      // dropped from the list and subtracted a second time. What's on screen and
      // what's outstanding are two different questions, and this is the answer to
      // the second one; `finished` now only tints.
      setQueue((q) => q.map((d) => (d.id === updated.id ? updated : d)))
      const done = new Set(finished).add(doc.id)
      setFinished(done)
      // "The next one" is the next one DOWN THE LIST, which is segment order once the
      // queue has been organized — not the server's order, which the list stopped
      // being in the moment a pile existed.
      const i = queueRows.findIndex((r) => r.doc.id === doc.id)
      const next = queueRows.slice(i + 1).find((r) => !done.has(r.doc.id))
      setScrollToParagraph(null)   // advancing past a chat-quoted document invalidates the target
      setSelectedId(next?.doc.id ?? null)
      return
    }

    // Cell results: you're browsing a set, not working through one, so advancing
    // would be a non-sequitur. Stay put and re-seed from the server's response so
    // the dirty flags settle. Refetching the queue is safe here — this document
    // isn't in the visible list, so nothing vanishes, and it may have just left the
    // queue, which the header badge should show.
    seedDoc(updated)
    await loadQueue()
  }

  // Switching the data set is a big context change — every derived thing (rows,
  // pivots, queue, selections, the finished tint) belongs to the old graph. Rather
  // than reconcile all of it, we POST the switch and hard-reload: the server
  // remembers the choice, so the reloaded page comes up on the new environment
  // with a clean slate. Guard unsaved work first, same as any destructive nav.
  const switchEnv = async (next: string) => {
    if (!env || next === env.active) return
    if ((docDirty || conceptDirty) &&
        !window.confirm('Discard unsaved changes and switch environment?')) return
    try {
      await api.setEnvironment(next)
      window.location.reload()
    } catch (e) { catch_(e) }
  }

  const startDivider = (e: React.MouseEvent) => {
    e.preventDefault()   // stop the browser from starting a text selection on drag
    const body = document.body.style as CSSStyleDeclaration & { webkitUserSelect: string }
    const onMove = (ev: MouseEvent) => {
      // Measured against the workspace, not the whole pane row: the queue sits
      // outside the divider, so including it would offset every drag by its width.
      const el = workspaceRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.min(80, Math.max(20, pct)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      body.cursor = ''
      body.userSelect = ''
      body.webkitUserSelect = ''
    }
    body.cursor = 'col-resize'
    body.userSelect = 'none'
    body.webkitUserSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Same idea as startDivider, but for a column's own top/bottom split — measured
  // against that column (not the workspace), and along Y instead of X.
  const startRowDivider = (
    colRef: React.RefObject<HTMLElement | null>, setPct: (pct: number) => void,
  ) => (e: React.MouseEvent) => {
    e.preventDefault()
    const body = document.body.style as CSSStyleDeclaration & { webkitUserSelect: string }
    const onMove = (ev: MouseEvent) => {
      const el = colRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const pct = ((ev.clientY - rect.top) / rect.height) * 100
      setPct(Math.min(80, Math.max(20, pct)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      body.cursor = ''
      body.userSelect = ''
      body.webkitUserSelect = ''
    }
    body.cursor = 'row-resize'
    body.userSelect = 'none'
    body.webkitUserSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const selectionList = [...selection].map((id) => ({ id, label: conceptLabel.get(id) ?? id }))

  return (
    <div className="app">
      <header className="topbar">
        <strong>Field Guide</strong>{' '}
        {/* Four windows of authored content, stacked like a deck of cards: they
            are things you visit occasionally, so at rest they cost the header a
            glyph each and the labels unfurl on hover. See .scope-group. */}
        <div className="scope-group">
          {/* The scope statement gates what discovery accepts, so it sits with the
              curation controls rather than in a settings menu. Its own window: it's
              authored prose you edit alongside the guide, not a modal to dismiss. */}
          <button
            className="scope-btn"
            onClick={() => window.open('/?view=scope', '_blank',
              'noopener,noreferrer,width=760,height=760')}
            title="Edit what this guide is about — used to screen every search result"
          >
            <Glyph shape="scope" /><span className="scope-label">SCOPE</span>
          </button>
          {/* Where documents come from. Same modality as SCOPE: configuration you
              visit occasionally, not part of the working columns. */}
          <button
            className="scope-btn"
            onClick={() => window.open('/?view=sources', '_blank',
              'width=1100,height=800')}
            title="Sources Scout draws from"
          >
            <Glyph shape="sources" /><span className="scope-label">SOURCES</span>
          </button>
          {/* Everyone the guide knows about. Before this, an entity was only reachable
              through a document that credited it — so a duplicate or a wrongly-typed
              node was invisible unless you happened onto it. */}
          <button
            className="scope-btn"
            onClick={() => window.open('/?view=entities', '_blank',
              'width=1000,height=800')}
            title="People and organizations in the guide"
          >
            <Glyph shape="entities" /><span className="scope-label">ENTITIES</span>
          </button>
          {/* The curator's remarks about the curation — prose over a set of nodes,
              citing documents inline. Same modality as the others: authored content
              you visit, not part of the working columns. */}
          <button
            className="scope-btn"
            onClick={() => window.open('/?view=artifacts', '_blank',
              'width=1000,height=820')}
            title="Curator remarks on concepts, documents and people"
          >
            <Glyph shape="artifacts" /><span className="scope-label">ARTIFACTS</span>
          </button>
        </div>
        {error && <span className="error" onClick={() => setError(null)}>⚠ {error} (dismiss)</span>}
        {!error && notice &&
          <span className="notice" onClick={() => setNotice(null)}>{notice} (dismiss)</span>}
        {/* Pinned right: Review queue, Run search, Undo, then the data-set picker. */}
        <div className="topbar-right">
          {/* The left column is no longer the queue's own — a cell click fills it too.
              So the queue becomes something you ask for, and the count follows it up
              here where it keeps advertising outstanding work from anywhere. */}
          <button
            className={`queue-btn${listMode === 'queue' ? ' sel' : ''}`}
            onClick={showQueue}
            title="Show the documents awaiting review"
          >
            Review queue <span className="badge">{outstanding}</span>
          </button>
          {/* Discovery is the front of the funnel: it fills the queue, it never
              categorizes. One press = one undoable action. The caret narrows the run
              to chosen concepts — the whole ontology is too slow to iterate against. */}
          <div className="scout-group">
            <button
              className="scout-btn"
              disabled={scouting}
              onClick={doScout}
              title={scoutPick
                ? `Search ${scoutPick.size} selected concept(s)`
                : 'Search every concept for new papers and add them to the review queue'}
            >
              {scouting
                ? 'Searching…'
                : `⌕ Run search${scoutPick ? ` (${scoutPick.size})` : ''}`}
            </button>
            <button
              className="scout-caret"
              disabled={scouting}
              onClick={() => setScoutMenu((v) => !v)}
              title="Choose which concepts to search"
            >
              ▾
            </button>
            {scoutMenu && (
              <div className="scout-menu">
                <div className="scout-menu-head">
                  <strong>Search which concepts?</strong>
                  <div className="row">
                    <button onClick={() => setScoutPick(null)}>All</button>
                    <button onClick={() => setScoutPick(new Set())}>None</button>
                  </div>
                </div>
                <ul className="plain-list">
                  {pickerRows.map((c) => {
                    // null means "all", so every box reads as checked until you
                    // narrow — the picker starts from the default rather than blank.
                    const on = scoutPick === null || scoutPick.has(c.id)
                    return (
                      <li key={c.id}>
                        <label
                          className="scout-opt"
                          style={{ paddingLeft: `${c.depth * 16}px` }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const base = scoutPick === null
                                ? new Set(allConcepts.map((x) => x.id))
                                : new Set(scoutPick)
                              // Toggling a concept carries its whole subtree with
                              // it: unchecking a topic drops its children, checking
                              // one restores them. Symmetric, and it still lets you
                              // check just the leaves — a leaf has no subtree to
                              // carry, so checking one adds only itself.
                              const sub = subtreeOf(c.id)
                              if (on) for (const id of sub) base.delete(id)
                              else for (const id of sub) base.add(id)
                              // Back to every concept? Drop to null so the button
                              // stops showing a count.
                              setScoutPick(base.size === allConcepts.length ? null : base)
                            }}
                          />
                          {c.label}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>
          <button
            className="undo-btn"
            disabled={!undo.available}
            onClick={doUndo}
            title={undo.description ?? 'Nothing to undo'}
          >
            ↶ Undo
          </button>
          {/* Sandbox is the default; picking the real guide is a deliberate act, so
              the control names it plainly. */}
          {env && (
            <label className={`env-picker${env.active !== 'sandbox' ? ' live' : ''}`}>
              <span className="muted">Data</span>
              <select value={env.active} onChange={(e) => switchEnv(e.target.value)}>
                {env.options.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      <div className="panes">
        <DocumentList
          mode={listMode}
          heading={listMode === 'queue' ? 'Review queue' : (listSource?.heading ?? '')}
          docs={listDocs}
          selectedId={selectedId}
          finished={finished}
          marked={markedDocs}
          segmentColors={segmentColors}
          organizing={organizing}
          onToggleOrganize={toggleOrganize}
          onSelect={selectDoc}
          onToggleMark={toggleMark}
          onAdd={addDocuments}
          onAddManual={addManualDocument}
          onError={catch_}
        />

        <div className="workspace" ref={workspaceRef}>
          {/* Over the workspace, NOT over `.panes`: the queue column stays live and
              its rows stay draggable, because the drags that fill these piles start
              there. Nothing in here writes the graph. */}
          {organizing && (
            <SegmentCanvas
              state={segments ?? NO_SEGMENTS}
              onChange={setSegments}
              docs={listDocs}
              onError={catch_}
              selectedId={selectedId}
              onSelect={selectDoc}
              doc={doc}
              onCloseDoc={() => setSelectedId(null)}
              onExit={exitOrganize}
            />
          )}
          <section className="left" ref={leftRef} style={{ width: `${leftPct}%` }}>
            <div className="left-top" style={{ flex: `1 1 ${topPct}%` }}>
              {/* A manually-entered abstract comes back as the full document, so
                  re-seed rather than refetch. The assignment set is untouched by
                  this write, so it deliberately isn't disturbed.

                  Starved while organization mode is on: the canvas floats its OWN
                  read-only viewer over this one, and `api.readable` re-fetches the
                  publisher's page — so leaving this one fed would hit them twice for
                  every document the curator clicks, to render something nobody can
                  see. It comes back the moment the overlay does. */}
              <DocumentViewer doc={organizing ? null : doc} onAbstractSaved={setDoc}
                scrollToParagraph={scrollToParagraph} />
            </div>
            <div className="row-divider" onMouseDown={startRowDivider(leftRef, setTopPct)} title="Drag to resize" />
            <div className="left-bottom" style={{ flex: `1 1 ${100 - topPct}%` }}>
              <DetailsPanel
                doc={doc}
                concepts={selectionList}
                allConcepts={allConcepts}
                onAddConcept={addConcept}
                onRemoveConcept={removeConcept}
                proposals={proposals}
                onAcceptProposal={acceptProposal}
                onRejectProposal={rejectProposal}
                onOpenConcept={(id) => { openNode(id, null) }}
                onOpenCredit={(id) => { openNode(id, null) }}
                pendingCredits={pendingPeople}
                onAddPendingCredit={addPendingCredit}
                onRemovePendingCredit={removePendingCredit}
                onEditPendingCredit={editPendingCredit}
                authors={credits}
                corporateAuthors={orgCredits}
                allPeople={allPeople}
                allOrgs={allOrgs}
                onAddCredit={addCredit}
                onRemoveCredit={removeCredit}
                noNamedAuthor={noNamedAuthor}
                onNoNamedAuthorChange={setNoNamedAuthor}
                onEntityCreated={loadGraph}
                onSaveMetadata={saveMetadata}
                onSave={save}
                onSaveTitle={saveTitle}
                onDelete={(note) => { if (doc) setDocToDelete({ doc, note }) }}
                onDirtyChange={setSummaryDirty}
                onError={catch_}
              />
            </div>
          </section>

          <div className="divider" onMouseDown={startDivider} title="Drag to resize" />

          <section className="right" ref={rightRef}>
            {chatOpen ? (
              // The chat shell: same header slot the ontology box uses, same
              // toggle in the same corner (now shown "on"). What's open on
              // screen right now (a document on the left, a concept on the
              // right) is passed down so the assistant can answer "this
              // document" -- see assistant/scope.py's OpenContext.
              <div className="chat-pane">
                <div className="ont-head">
                  <strong>Curation assistant</strong>
                  <button
                    type="button"
                    className="chat-toggle on"
                    title="Close curation assistant"
                    aria-pressed={true}
                    onClick={() => setChatOpen(false)}
                  >💬</button>
                </div>
                <ChatPane
                  openDocumentTitle={doc ? doc.label : null}
                  openDocumentInQueue={doc ? doc.attributes.status === 'pending' : null}
                  openDocumentId={doc ? doc.id : null}
                  openConceptName={selectedNode && selectedNode.type === 'concept' ? selectedNode.label : null}
                  openConceptId={openConceptId}
                  onOpenQuote={openQuote}
                  onOpenDocument={selectDoc}
                />
              </div>
            ) : (
              <>
                <div className="right-top" style={{ flex: `1 1 ${topPct}%` }}>
                  <OntologyPanel
                    ontology={ontology}
                    graph={graph}
                    tab={tab}
                    onTabChange={setTab}
                    selectedIds={selection}
                    focusedKey={focusedKey}
                    onClickRow={clickRow}
                    onClickCell={clickCell}
                    onClickColumn={clickColumn}
                    activeCell={activeCell}
                    mode={ontMode}
                    onToggleAdd={toggleAdd}
                    onToggleDelete={toggleDelete}
                    onClickInsert={clickInsert}
                    onDeleteRow={(id) => askDelete(id)}
                    onReparent={reparent}
                    draftParentId={draft ? draft.parentId : undefined}
                    onOpenChat={() => setChatOpen(true)}
                  />
                </div>
                <div className="row-divider" onMouseDown={startRowDivider(rightRef, setTopPct)} title="Drag to resize" />
            {/* The concept editor doubles as a drop target: drag a multi-selected
                set of documents from the list onto an open concept to label them
                all at once. */}
            <div
              className={`right-bottom${dropActive && openConceptId ? ' drop-active' : ''}`}
              style={{ flex: `1 1 ${100 - topPct}%` }}
              onDragOver={(e) => { if (openConceptId) { e.preventDefault(); setDropActive(true) } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false) }}
              onDrop={onDropDocs}
            >
              {/* A cell's column node isn't always a concept — the authored_by tab
                  puts a person here. Concepts get the editor; everything else gets
                  a read-only card straight off the graph we already hold, since
                  there's no PATCH for people or orgs anyway. */}
              {selectedNode && selectedNode.type !== 'concept'
                ? <NodeCard
                    node={selectedNode}
                    allOrgs={allOrgs}
                    // A rename moves every chip and pivot row bearing this entity,
                    // and a retype moves which axis it sits on — so the graph and
                    // the open document both have to be refetched, not just this
                    // card. Same reason setConcepts refetches the graph.
                    //
                    // The document is re-read but NOT re-seeded (see seedDoc): the
                    // credits on screen can include corrections that aren't saved
                    // yet, and this card is exactly where a curator goes right after
                    // making one. What a rename or retype can actually change about
                    // them — the label, and which of the two lists they belong in —
                    // is applied here from the fresh graph instead.
                    onChanged={async () => {
                      loadUndo()
                      try {
                        const g = await api.graph()
                        setGraph(g)
                        const byId = new Map(g.nodes.map((n) => [n.id, n]))
                        const orgIds = new Set(orgCredits.map((c) => c.id))
                        const refiled = [...credits, ...orgCredits].map((c) => {
                          const n = byId.get(c.id)
                          return {
                            credit: n ? { id: c.id, label: n.label } : c,
                            // A node we just created may not be in this graph yet;
                            // fall back to the list it's already in.
                            org: n ? n.type === 'organization' : orgIds.has(c.id),
                          }
                        })
                        setCredits(refiled.filter((r) => !r.org).map((r) => r.credit))
                        setOrgCredits(refiled.filter((r) => r.org).map((r) => r.credit))
                      } catch (e) { catch_(e) }
                      if (doc) {
                        api.document(doc.id)
                          .then((d) => seedDoc(d, { keepEdits: true }))
                          .catch(catch_)
                      }
                    }}
                    onOpenDocuments={(heading, ids, selectId) =>
                      showDocuments(heading, docsFor(ids), selectId, selectedNode.id)}
                    onError={catch_}
                  />
                : (
                  <ConceptPanel
                    conceptId={selectedNodeId}
                    draft={draft}
                    docTitle={doc ? (doc.attributes.title || doc.label) : null}
                    assigned={!!selectedNodeId && selection.has(selectedNodeId)}
                    onAssign={addConcept}
                    onShowDocuments={showDocuments}
                    onCreated={onConceptCreated}
                    onChanged={() => { loadOntology(); loadGraph(); loadUndo() }}
                    onDirtyChange={setConceptDirty}
                    onError={catch_}
                  />
                )}
              {dropActive && openConceptId && markedDocs.size > 0 && (
                <div className="drop-hint">Label {markedDocs.size} document{markedDocs.size === 1 ? '' : 's'} with this concept</div>
              )}
            </div>
              </>
            )}
          </section>
        </div>
      </div>

      {/* Delete confirmation. Spells out the full blast radius before anything is
          removed: the cascade of concepts, and how many documents fall back to the
          review queue. */}
      {deletePreview && (
        <div className="modal-backdrop" onClick={cancelDelete}>
          <div className="modal danger" role="dialog" aria-modal="true"
               onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{deletePreview.target.label}”?</h3>
            {deletePreview.also_deleted.length > 0 && (
              <>
                <p>These concepts will be deleted too:</p>
                <ul className="modal-list">
                  {deletePreview.also_deleted.map((c) => <li key={c.id}>{c.label}</li>)}
                </ul>
              </>
            )}
            {deletePreview.documents_requeued > 0 && (
              <p>
                {deletePreview.documents_requeued} document
                {deletePreview.documents_requeued === 1 ? '' : 's'} will return to the
                review queue.
              </p>
            )}
            <p className="muted">This can be undone from the revision log.</p>
            <div className="row modal-actions">
              <button className="danger" disabled={deleteBusy} onClick={confirmDelete}>
                {deleteBusy ? 'Deleting…' : 'Delete'}
              </button>
              <button disabled={deleteBusy} onClick={cancelDelete}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Document dismissal — same danger-modal pattern as the concept delete. */}
      {docToDelete && (
        <div className="modal-backdrop" onClick={() => !docDeleteBusy && setDocToDelete(null)}>
          <div className="modal danger" role="dialog" aria-modal="true"
               onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{docToDelete.doc.attributes.title || docToDelete.doc.label}”?</h3>
            <p>This removes the document and its concept assignments from the guide,
               and takes it out of the review queue.</p>
            <p className="danger-note">
              ⚠ This document will be dismissed for good — it won’t be offered for
              review again.
            </p>
            {/* The reason, echoed back. It was typed into the Summary box, which is
                not obviously a place a reason goes — so the dialog says what it is
                about to keep, and when there is nothing, says where to put it. */}
            {docToDelete.note ? (
              <p className="dismiss-reason">
                Reason recorded: <em>{docToDelete.note}</em>
              </p>
            ) : (
              <p className="muted">
                No reason given — cancel and type one in the Summary box to record
                why (“paywalled”, “marketing post”).
              </p>
            )}
            <p className="muted">This can be undone from the revision log.</p>
            <div className="row modal-actions">
              <button className="danger" disabled={docDeleteBusy} onClick={confirmDeleteDocument}>
                {docDeleteBusy ? 'Deleting…' : 'Delete document'}
              </button>
              <button disabled={docDeleteBusy} onClick={() => setDocToDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
