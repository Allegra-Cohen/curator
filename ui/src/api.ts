import type {
  AddDocumentsResult,
  Artifact, ArtifactWrite,
  AssistantReply, AssistantThread,
  ConceptCreate, ConceptDetail, ConceptPatch, DeletionPreview, DocumentNode,
  EnvironmentState, FullGraph, GraphNode, GuideScope, LinkHit, ManualDocumentIn, NodeHit, Ontology,
  PersonCreate,
  PolygonPage,
  QuiltPage,
  ReadGraph,
  SegmentState,
  Readable, ScoutRunResult, Source, SourcePreview,
  EntityDetail,
  PersonPatch,
  OrganizationPatch,
  EntityRow,
} from './types'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, init)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${detail}`)
  }
  return res.json() as Promise<T>
}

// A file sitting beside the built viewer, not an endpoint. `BASE_URL` is Vite's
// `base` ('/field-guides/fgttfo/' in the blog build, '/' everywhere else), so this
// is absolute; a relative './read-graph.json' would resolve against the DOCUMENT's
// URL and miss if anyone ever landed on the directory without its trailing slash.
async function staticFile<T>(name: string): Promise<T> {
  const url = import.meta.env.BASE_URL + name
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.json() as Promise<T>
}


export const api = {
  ontology: () => req<Ontology>('/ontology'),
  /** The whole graph — what the pivots derive from. See types.FullGraph. */
  graph: () => req<FullGraph>('/graph'),
  queue: () => req<DocumentNode[]>('/queue'),
  /** The curator's own partition of the queue — piles made by hand in organization
   *  mode, and never a fact about the graph (`queue_segments.py`). Pruned server-side
   *  on every read, so what comes back only ever names documents still pending. */
  queueSegments: () => req<SegmentState>('/queue/segments'),
  /** Replace the canvas wholesale. Whole-blob because one curator is editing one
   *  document — a per-member PATCH surface would need conflict rules for a conflict
   *  that can't arise.
   *
   *  The reply is what the server actually WROTE, which is not always what was sent:
   *  `save` drops empty segments. The canvas doesn't adopt it, and that is
   *  deliberate — see `SegmentCanvas`. */
  saveQueueSegments: (state: SegmentState) =>
    req<SegmentState>('/queue/segments', {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(state),
    }),
  document: (id: string) => req<DocumentNode>(`/documents/${id}`),
  readable: (id: string) => req<Readable>(`/documents/${id}/readable`),
  concept: (id: string) => req<ConceptDetail>(`/concepts/${id}`),

  // Attach a concept to a batch of documents at once (drag-to-label).
  labelDocuments: (conceptId: string, documentIds: string[]) =>
    req<{ labeled: number }>(`/concepts/${conceptId}/documents`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ document_ids: documentIds }),
    }),

  // Run discovery over every concept and file the survivors into the queue.
  // Slow by nature (N concepts × 2 APIs + the LLM filter) — callers should show
  // a busy state rather than expect this to return promptly.
  // conceptIds narrows the run to those concepts; omit for all of them.
  runScout: (conceptIds?: string[]) =>
    req<ScoutRunResult>('/scout/run', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ concept_ids: conceptIds ?? null }),
    }),

  // Undo: GET reports what the next undo would reverse; POST performs it.
  undoStatus: () => req<{ available: boolean; description: string | null }>('/undo'),
  undo: () => req<{ undone: boolean; description: string | null }>('/undo', { method: 'POST' }),

  // Sources: where documents come from — followed feeds plus the search APIs.
  sources: () => req<Source[]>('/sources'),
  previewSource: (url: string) =>
    req<SourcePreview>(`/sources/preview?url=${encodeURIComponent(url)}`),
  followSource: (body: { label: string; url: string; mechanism?: string; homepage?: string; notes?: string }) =>
    req<Source>('/sources', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
    }),
  setSourceEnabled: (id: string, enabled: boolean) =>
    req<Source>(`/sources/${id}/enabled`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled }),
    }),
  // Polls one source now, with no concept queries and no concept exclusions — a
  // test of the source, not a curated run.
  runSource: (id: string) => req<Record<string, any>>(`/sources/${id}/run`, { method: 'POST' }),
  // Clears remembered screening verdicts and page-link classifications for one
  // source, so the next poll reconsiders everything it has already judged.
  rereadSource: (id: string) =>
    req<{ source: string; forgotten_screenings: number }>(
      `/sources/${id}/reread`, { method: 'POST' }),

  // Artifacts — the curator's remarks about the curation, edited in their own
  // window. `cites` edges and the resolved `links` list are both derived from the
  // body server-side, so the client only ever sends label/body/subjects.
  artifacts: () => req<Artifact[]>('/artifacts'),
  artifact: (id: string) => req<Artifact>(`/artifacts/${id}`),
  createArtifact: (body: ArtifactWrite) =>
    req<Artifact>('/artifacts', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
    }),
  updateArtifact: (id: string, patch: ArtifactWrite) =>
    req<Artifact>(`/artifacts/${id}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(patch),
    }),
  deleteArtifact: (id: string) =>
    req<{ deleted: string; label: string }>(`/artifacts/${id}`, { method: 'DELETE' }),
  // Subject picker: a label substring search over any node type, served straight from
  // the DB so the corpus isn't shipped.
  searchNodes: (q: string) =>
    req<NodeHit[]>(`/nodes/search?q=${encodeURIComponent(q)}`),
  // ⌘K link picker: anything worth pointing at, found three ways — by its own name,
  // by a document's author, or by its venue. Sources and unreviewed documents are
  // refused server-side; see `search_link_targets`.
  searchLinkTargets: (q: string) =>
    req<LinkHit[]>(`/links/search?q=${encodeURIComponent(q)}`),


  // The guide-scope Artifact — screening prompt input, edited in its own window.
  scope: () => req<GuideScope>('/scope'),
  saveScope: (body: string) =>
    req<GuideScope>('/scope', {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ body }),
    }),

  environment: () => req<EnvironmentState>('/environment'),
  // The server holds the active environment; a switch is followed by a full page
  // reload (see App.tsx), so this returns the new state but the UI doesn't use it.
  setEnvironment: (env: string) =>
    req<EnvironmentState>('/environment', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ env }),
    }),

  createConcept: (body: ConceptCreate) =>
    req<GraphNode>('/concepts', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
    }),
  updateConcept: (id: string, patch: ConceptPatch) =>
    req<GraphNodeResp>(`/concepts/${id}`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
    }),
  // Move a concept between levels — one drag in the ontology cards. Both parents
  // are explicit: `from` names which edge to drop, which a poly-parented concept
  // makes ambiguous otherwise, and `null` on either side is the top level.
  reparentConcept: (id: string, from: string | null, to: string | null) =>
    req<GraphNode>(`/concepts/${id}/reparent`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ from_parent_id: from, to_parent_id: to }),
    }),
  // What a delete would take with it — for the confirm dialog.
  deletionPreview: (id: string) => req<DeletionPreview>(`/concepts/${id}/deletion`),
  deleteConcept: (id: string) =>
    req<{ deleted: { id: string; label: string }[]; documents_requeued: number }>(
      `/concepts/${id}`, { method: 'DELETE' }),

  updateSummary: (id: string, summary: string) =>
    req<DocumentNode>(`/documents/${id}/summary`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ summary }),
    }),
  // Correct a scraped title. Updates the node label too, server-side, so the
  // list, tooltips and dialogs don't keep showing the bad scrape.
  updateTitle: (id: string, title: string) =>
    req<DocumentNode>(`/documents/${id}/title`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ title }),
    }),
  // The author's abstract, entered by hand when discovery couldn't get one.
  updateAbstract: (id: string, abstract: string) =>
    req<DocumentNode>(`/documents/${id}/abstract`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ abstract }),
    }),
  // Correct the scraped venue and date. Patch semantics: omit a field to leave it
  // alone, pass "" to clear it. Its own write, like the title — fixing metadata
  // shouldn't commit a review.
  updateMetadata: (id: string, patch: { publication?: string; published_date?: string }) =>
    req<DocumentNode>(`/documents/${id}/metadata`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
    }),
  // Set-semantics, like setConcepts: `author_ids` is the whole credited set, people
  // and organizations together — `authored_by` runs document → person|organization,
  // so the panel's two fields are one relationship on the wire.
  setAuthors: (id: string, author_ids: string[], no_named_author = false) =>
    req<DocumentNode>(`/documents/${id}/authors`, {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ author_ids, no_named_author }),
    }),
  // Everyone the guide knows about — the Entities window's list.
  entities: () => req<EntityRow[]>('/entities'),
  // Soft, and it takes the credits with it. Retyping is the right move when only
  // the kind is wrong; this is for an entity that shouldn't exist.
  deleteEntity: (id: string) =>
    req<{ deleted: string; label: string }>(`/entities/${id}`, { method: 'DELETE' }),
  // The node card's read model: the entity plus the edges hanging off it.
  entity: (id: string) => req<EntityDetail>(`/entities/${id}`),
  updatePerson: (id: string, patch: PersonPatch) =>
    req<EntityDetail>(`/people/${id}`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
    }),
  updateOrganization: (id: string, patch: OrganizationPatch) =>
    req<EntityDetail>(`/organizations/${id}`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
    }),
  // Correct an entity created as the wrong kind. In place: the id doesn't move, so
  // the credits survive. 400s (with the edges named) if one would become illegal.
  retypeEntity: (id: string, to_type: 'person' | 'organization') =>
    req<EntityDetail>(`/entities/${id}/retype`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ to_type }),
    }),
  // Find-or-create a person, with the affiliation and the writes-at edge in the
  // same call so the three land as one undoable action.
  createPerson: (body: PersonCreate) =>
    req<GraphNode>('/people', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
    }),
  // `source_id` records where this organization writes — the same `writes_at`
  // edge a person gets.
  createOrganization: (name: string, kind = 'institution', source_id: string | null = null) =>
    req<GraphNode>('/organizations', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ name, kind, source_id }),
    }),
  // Set-semantics: reconciles the doc's concept assignments to exactly this list.
  // Outstanding concept proposals are NOT sent back: Save consumes all of them
  // server-side. Save is gated on an assigned concept, so a concept proposal still
  // undecided when it lands was passed over deliberately, and an approved document
  // is not proposed to.
  setConcepts: (id: string, concept_ids: string[]) =>
    req<DocumentNode>(`/documents/${id}/concepts`, {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ concept_ids }),
    }),
  // Paste URLs straight into the queue — the curator found something in the wild.
  // Slow in proportion to the list: every new URL is fetched and extracted before
  // this returns, so callers need a busy state. A previously-dismissed URL is
  // restored rather than refused, which is the one way this differs from discovery.
  addDocuments: (urls: string[]) =>
    req<AddDocumentsResult>('/documents', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ urls }),
    }),

  // The fallback when the above couldn't fetch a URL: the curator types in what
  // our fetch couldn't get, no fetch attempted at all. Same bucketed shape as
  // addDocuments (added/restored/duplicate) so the result renders the same way;
  // `failed`/`invalid` come back empty since there's nothing here to fail to fetch.
  addManualDocument: (doc: ManualDocumentIn) =>
    req<AddDocumentsResult>('/documents/manual', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(doc),
    }),

  // Dismiss a document: soft-deletes it and its edges, and tombstones the URL so
  // discovery won't offer it back. Pasting it in by hand still can — see addDocuments.
  // `note` is why, taken from the Summary box: it is kept on the dismissed node and
  // is what the dismissal report prints, so a rejection isn't a silent disappearance.
  deleteDocument: (id: string, note?: string) =>
    req<{ deleted: { id: string; label: string } }>(`/documents/${id}`, {
      method: 'DELETE', headers: JSON_HEADERS,
      body: JSON.stringify({ note: note ?? null }),
    }),

  setLayout: (id: string, x: number, y: number) =>
    req<GraphNodeResp>(`/concepts/${id}/layout`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ x, y }),
    }),

  // Curation assistant — read-only chat over the graph. One ongoing thread per
  // environment; see writeups/design/CURATION_ASSISTANT_DESIGN.md.
  assistantConversation: () => req<AssistantThread>('/assistant/conversation'),
  assistantMessage: (body: {
    message: string
    open_document_title?: string | null
    open_document_in_queue?: boolean | null
    open_concept_name?: string | null
    open_document_id?: string | null
    open_concept_id?: string | null
  }) =>
    req<AssistantReply>('/assistant/message', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
    }),
  // The curator's own "/clear": leaves the old thread's file as-is, starts a new one.
  assistantNewThread: () => req<AssistantThread>('/assistant/new-thread', { method: 'POST' }),
}

type GraphNodeResp = import('./types').GraphNode
