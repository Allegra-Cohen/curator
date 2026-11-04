// A fake server and a fake BroadcastChannel, for tests that need to see what the
// UI *sends* rather than what it computes.
//
// `pivot.ts`, `palette.ts` and `entityKind.ts` are pure functions and are tested
// directly. Everything interesting left in `App.tsx` is not a computation at all:
// it's the decision to call the API now versus at Save, and the decision to tell
// the other windows something happened. Neither is visible without running the
// component, so this is the smallest thing that makes them visible.
//
// Nothing here mocks the modules under test. `api.ts` and `broadcast.ts` run for
// real; only the two browser globals underneath them are replaced. A test that
// mocked `api.ts` could not catch a call going to the wrong endpoint, which is
// half of what these tests are for.

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import type {
  Artifact, ConceptDetail, DocumentNode, EntityDetail, EntityRow, GraphNode, GuideScope,
  LinkHit, PolygonPage, Readable, ReadGraph, SegmentState, Source, SourcePreview,
} from './types'

afterEach(() => cleanup())

// jsdom IMPLEMENTS NO SCROLLING. `Element.prototype.scrollTo` and `scrollIntoView` do
// not exist on it at all, so a component that calls either in a layout effect doesn't
// quietly do nothing — it THROWS, React unmounts the tree, and every later query in the
// file fails with "Expected container to be an Element … but got null". That cascade is
// what made 46 tests across two files fail at once (2026-09-16) from a single call in
// `SideCard.tsx`, with nothing in the output naming scrolling as the cause.
//
// Stubbed here, in the harness every DOM test already imports, rather than in each test:
// the gap is jsdom's, not any one component's. These are no-ops on purpose. Scrolling is
// invisible in a renderer with no layout, so there is nothing to assert about it — the
// point is only that calling it must not take the render down with it. Anything that
// really depends on scroll position belongs in a browser, not here.
for (const name of ['scrollTo', 'scrollIntoView'] as const) {
  if (typeof Element !== 'undefined' && !Element.prototype[name]) {
    Element.prototype[name] = (() => {}) as never
  }
}

/** One request the UI made. `method` is upper-case; `path` has the `/api` prefix
 *  stripped, so assertions read the way the endpoints do. */
export interface Recorded {
  method: string
  path: string
  body: any
}

/** What the fake server holds. Only the fields the tests actually assert on are
 *  required; everything else has a default, so a test that cares about author
 *  proposals doesn't have to invent an ontology to get one. */
export interface ServerState {
  queue: DocumentNode[]
  /** The queue's segmentation — organization mode's piles, which order and colour
   *  the list without touching the graph. Empty for every test that isn't about
   *  them, which is the state a guide that has never been organized is in. */
  segments: SegmentState
  documents: Record<string, DocumentNode>
  graphNodes: GraphNode[]
  ontologyNodes: GraphNode[]
  sources: Source[]
  entities: EntityRow[]
  /** What `GET /sources/preview` answers with. The SOURCES window resolves a pasted
   *  page to the feed it advertises, so tests need to control what came back. */
  preview: SourcePreview | null
  /** What `POST /sources/{id}/run` reports. `ingested` drives whether the window
   *  tells the other windows anything. */
  runResult: { ingested: number; dropped?: number }
  rereadResult: { source: string; forgotten_screenings: number }
  /** The guide scope Artifact. `is_default` true means the curator never wrote one
   *  and screening is running on built-in wording — which the window has to say. */
  scope: GuideScope
  concepts: Record<string, ConceptDetail>
  entityDetails: Record<string, EntityDetail>
  /** What `GET /read/graph` answers with — the reader projection the viewer builds
   *  on. Defaults to empty, so only a test about the viewer has to populate it. */
  readGraph: ReadGraph
  /** What `GET /documents/{id}/readable` answers with. `ok: false` is the paywalled
   *  and bot-blocked case, where the abstract is the whole review surface. */
  readable: Readable
  /** Every remark `GET /artifacts` lists. The ARTIFACTS window reads this list and
   *  then edits one of them in place; `links` on each is what the server resolved
   *  from its body, which is what the References block names its entries from. */
  artifacts: Artifact[]
  /** The corpus `GET /links/search` answers from — the ⌘K link picker's results.
   *  Filtered by label OR `via` here the way the server matches by title, author and
   *  venue, so a test can type a few letters of either rather than the whole title. */
  linkHits: LinkHit[]
}

export interface FakeServer {
  /** Every request, in order. The list tests make assertions about. */
  readonly requests: Recorded[]
  /** Just the ones that changed something — everything except GET. The "nothing
   *  is written until Save" assertion is `expect(server.writes).toEqual([])`. */
  readonly writes: Recorded[]
  /** Forget everything recorded so far, so a test can set a document up and then
   *  assert only about what the gesture under test sent. */
  reset(): void
  /** Make the next request matching `"METHOD /path"` come back 500. One shot: the
   *  call after it is answered normally, so a test can assert the failure and then
   *  the recovery. For paths that only ever fail in production — a write the server
   *  refused — and never in the fixtures. */
  fail(match: string): void
  state: ServerState
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })

/** Replace `window.fetch` with one that answers from `state` and records
 *  everything. Returns the recorder. Call inside a test, before rendering. */
// A STAND-IN FOR THE DRAWING — deliberately not the drawing.
//
// `/api/read/polygons` is computed by polygons.py, and porting that geometry to
// TypeScript purely to satisfy tests would mean two copies of it, drifting. So this
// returns a page with the RIGHT IDS, NAMES AND KINDS and nonsense coordinates: three
// corners per shape, dots in a line. Every block sits at the origin, on top of the
// others.
//
// The rule that decides WHAT IS DRAWN is copied faithfully, because tests depend on it:
// a block per artifact, holding the concepts and documents that artifact points at by
// `remarks_on` or `cites` — and nothing else. A concept no remark touches is not on the
// canvas, which is the drawing's most consequential property.
//
// So: assert what is on the canvas, never where. The geometry is verified in Python,
// against viz_lab/nested.html (see ui/POLYGONS_LOCAL_BLOCKS_CHECK.txt).
function standInPolygons(g: ReadGraph): PolygonPage {
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id
  const kind = (id: string) => g.nodes.find((n) => n.id === id)?.type
  const tri = (i: number): [number, number][] =>
    [[-50 + i * 10, -50], [50 + i * 10, -50], [i * 10, 50]]

  return {
    dot_r: 3.2,
    margin: 70,
    blocks: g.artifacts.map((a) => {
      const points = g.edges
        .filter((e) => e.source === a.id && (e.type === 'remarks_on' || e.type === 'cites'))
        .map((e) => e.target)
      const concepts = points.filter((id) => kind(id) === 'concept')
      const docs = points.filter((id) => kind(id) === 'document')
      return {
        id: a.id,
        title: a.label,
        r: 200,
        shapes: [
          { kind: 'remark' as const, id: a.id, name: a.label, depth: 0,
            points: [[-200, -200], [200, -200], [0, 200]] as [number, number][] },
          // A coloured concept carries its fill and the outlines cut out of it. The
          // stand-in gives no holes: nothing here nests, and what the holes are FOR
          // is settled in polygons.py's own tests, not by fake geometry.
          //
          // Nothing nests here, so every concept is at depth 1 — inside the wall and
          // nothing inside it. The ALTERNATION the depth drives is likewise settled in
          // polygons.py's tests; what this has to get right is that the field exists.
          ...concepts.map((id, i) => ({
            kind: 'concept' as const, id, name: label(id), points: tri(i), depth: 1,
            ...(a.paint?.[id] ? { fill: a.paint[id], holes: [] } : {}),
          })),
        ],
        dots: docs.map((id, i) => ({ id, name: label(id), x: i * 10, y: 0 })),
        label: { x: 0, y: 218 },
      }
    }),
  }
}

export function installFakeServer(partial: Partial<ServerState> = {}): FakeServer {
  const state: ServerState = {
    queue: [], segments: { segments: [], members: {} }, documents: {},
    graphNodes: [], ontologyNodes: [],
    sources: [], entities: [], preview: null,
    runResult: { ingested: 0, dropped: 0 },
    rereadResult: { source: '', forgotten_screenings: 0 },
    scope: { body: 'The built-in default scope.', is_default: true, updated_at: null },
    concepts: {}, entityDetails: {},
    readGraph: { nodes: [], artifacts: [], edges: [] },
    readable: { url: 'https://example.org/paper', ok: true, title: 'A Paper',
                fetch_outcome: 'ok', paragraphs: ['First paragraph.', 'Second paragraph.'] },
    artifacts: [],
    linkHits: [],
    ...partial,
  }
  const requests: Recorded[] = []
  const failing: string[] = []

  // Ids for anything the server is asked to create. Fixed prefix + counter rather
  // than random, so a failing assertion names something readable.
  let created = 0
  const newId = (kind: string) => `${kind}-created-${++created}`

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    const path = url.replace(/^\/api/, '')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, body })
    const i = failing.indexOf(`${method} ${path}`)
    if (i >= 0) {
      failing.splice(i, 1)
      return new Response('the server said no', { status: 500 })
    }

    // --- reads -------------------------------------------------------------
    if (method === 'GET') {
      if (path === '/queue') return ok(state.queue)
      if (path === '/queue/segments') return ok(state.segments)
      if (path === '/graph') return ok({ nodes: state.graphNodes, edges: [] })
      if (path === '/ontology') return ok({ nodes: state.ontologyNodes, edges: [] })
      if (path === '/undo') return ok({ available: false, description: null })
      if (path === '/environment')
        return ok({ active: 'sandbox', options: [{ key: 'sandbox', label: 'Sandbox' }] })
      if (path === '/sources') return ok(state.sources)
      if (path === '/artifacts') return ok(state.artifacts)
      const artifact = path.match(/^\/artifacts\/([^/]+)$/)
      if (artifact) return ok(state.artifacts.find((a) => a.id === artifact[1]))
      if (path.startsWith('/sources/preview')) {
        if (!state.preview) return new Response('no feed here', { status: 400 })
        return ok(state.preview)
      }
      if (path === '/entities') return ok(state.entities)
      if (path === '/read/graph') return ok(state.readGraph)
      if (path === '/read/polygons') return ok(standInPolygons(state.readGraph))
      // Not an endpoint: the file `export_guide.py` writes beside the published build,
      // which is where `profile.graphSource: 'static'` reads from. Served from the same
      // `readGraph` state and recorded like any other request, so a test can assert
      // WHICH of the two a build asked for.
      if (path === '/read-graph.json') return ok(state.readGraph)
      // The drawing's own static twin, beside the published build. NOTE that
      // `export_guide.py` does not write this file yet — that is deliberately deferred
      // until the drawing settles, so the real blog build fetches a 404 here. Served in
      // tests because these assert WHICH path a build asks for, not whether the deploy
      // has caught up.
      if (path === '/polygons.json') return ok(standInPolygons(state.readGraph))
      if (path === '/scope') return ok(state.scope)
      const readable = path.match(/^\/(?:read\/)?documents\/([^/]+)\/readable$/)
      if (readable) return ok(state.readable)
      const linkSearch = path.match(/^\/links\/search\?q=(.*)$/)
      if (linkSearch) {
        const q = decodeURIComponent(linkSearch[1]).toLowerCase()
        return ok(state.linkHits.filter(
          (h) => h.label.toLowerCase().includes(q)
            || (h.via ?? '').toLowerCase().includes(q)))
      }
      const doc = path.match(/^\/documents\/([^/]+)$/)
      if (doc) return ok(state.documents[doc[1]])
      const entity = path.match(/^\/entities\/([^/]+)$/)
      if (entity)
        return ok(state.entityDetails[entity[1]]
          ?? { id: entity[1], label: '', type: 'person', attributes: {},
               affiliations: [], writes_at: [], documents: [] })
      const concept = path.match(/^\/concepts\/([^/]+)$/)
      if (concept)
        return ok(state.concepts[concept[1]]
          ?? { concept: { id: concept[1], label: '', type: 'concept', attributes: {} },
               documents: [], people: [], related: [] })
      return ok(null)
    }

    // --- writes ------------------------------------------------------------
    // These return the shape the client needs to keep rendering; the tests assert
    // on `requests`, not on what came back.
    // A discovery run. The client reads every field to build its summary notice, so
    // a bare {} would throw on `report.split` and look like a failed run.
    if (method === 'POST' && path === '/scout/run')
      return ok({ ingested: 1, candidates: 1, already_known: 0, duplicates: 0,
                  dismissed: 0, suppressed: 0, dropped: 0, failures: 0,
                  openalex: true, filtered: true,
                  report: 'search_reports/run.md' })
    if (method === 'POST' && path === '/documents')
      return ok({ added: [], restored: [], duplicates: [], failed: [] })
    // --- sources -----------------------------------------------------------
    const run = path.match(/^\/sources\/([^/]+)\/run$/)
    if (method === 'POST' && run) return ok(state.runResult)
    const reread = path.match(/^\/sources\/([^/]+)\/reread$/)
    if (method === 'POST' && reread) return ok(state.rereadResult)
    const enabled = path.match(/^\/sources\/([^/]+)\/enabled$/)
    if (method === 'POST' && enabled) {
      const s = state.sources.find((x) => x.id === enabled[1])!
      const next = { ...s, enabled: body.enabled }
      state.sources = state.sources.map((x) => (x.id === next.id ? next : x))
      return ok(next)
    }
    if (method === 'POST' && path === '/sources') {
      const added = source({ id: newId('source'), label: body.label, url: body.url,
                             mechanism: body.mechanism ?? 'rss' })
      state.sources = [added, ...state.sources]
      return ok(added)
    }

    // Organization mode's canvas. The real endpoint drops empty segments before
    // writing and answers with what it wrote, so this does too — a test that asserted
    // the reply was an echo would be asserting against the wrong server.
    if (method === 'PUT' && path === '/queue/segments') {
      const live = new Set(Object.values(body.members ?? {}))
      state.segments = {
        segments: (body.segments ?? []).filter((s: any) => live.has(s.id)),
        members: body.members ?? {},
        updated_at: new Date().toISOString(),
      }
      return ok(state.segments)
    }

    // --- the guide scope ---------------------------------------------------
    if (method === 'PUT' && path === '/scope') {
      state.scope = { body: body.body, is_default: false,
                      updated_at: new Date().toISOString() }
      return ok(state.scope)
    }

    // --- concepts ----------------------------------------------------------
    if (method === 'POST' && path === '/concepts')
      return ok({ id: newId('concept'), label: body.label, type: 'concept',
                  attributes: { description: body.description,
                                semantic_query: body.semantic_query,
                                keywords: body.keywords, criteria: body.criteria } })
    const conceptPatch = path.match(/^\/concepts\/([^/]+)$/)
    if (method === 'PATCH' && conceptPatch) {
      const held = state.concepts[conceptPatch[1]]
      const next = { id: conceptPatch[1], type: 'concept',
                     label: body.label ?? held?.concept.label ?? '',
                     attributes: { ...(held?.concept.attributes ?? {}), ...body } }
      if (held) state.concepts[conceptPatch[1]] = { ...held, concept: next as GraphNode }
      return ok(next)
    }

    // --- entity corrections ------------------------------------------------
    // Rename, retype and the affiliation / writes-at links all answer with the
    // entity's full detail, which is what the card re-renders from.
    const detailFor = (id: string) =>
      state.entityDetails[id]
      ?? ({ id, label: '', type: 'person', attributes: {},
            affiliations: [], writes_at: [], documents: [] } as unknown as EntityDetail)
    const person = path.match(/^\/people\/([^/]+)$/)
    if (method === 'PATCH' && person) {
      const next = { ...detailFor(person[1]) }
      if (body.full_name !== undefined) next.label = body.full_name
      if (body.orcid !== undefined)
        next.attributes = { ...next.attributes, orcid: body.orcid }
      state.entityDetails[person[1]] = next
      return ok(next)
    }
    const org = path.match(/^\/organizations\/([^/]+)$/)
    if (method === 'PATCH' && org) {
      const next = { ...detailFor(org[1]) }
      if (body.name !== undefined) next.label = body.name
      state.entityDetails[org[1]] = next
      return ok(next)
    }
    const retype = path.match(/^\/entities\/([^/]+)\/retype$/)
    if (method === 'POST' && retype) {
      const next = { ...detailFor(retype[1]), type: body.to_type }
      state.entityDetails[retype[1]] = next
      return ok(next)
    }

    // --- entities ----------------------------------------------------------
    const entity = path.match(/^\/entities\/([^/]+)$/)
    if (method === 'DELETE' && entity) {
      state.entities = state.entities.filter((e) => e.id !== entity[1])
      return ok({ deleted: entity[1], label: '' })
    }

    if (method === 'POST' && path === '/people')
      return ok({ id: newId('person'), label: body.full_name, type: 'person',
                  attributes: {} })
    if (method === 'POST' && path === '/organizations')
      return ok({ id: newId('org'), label: body.name, type: 'organization',
                  attributes: {} })

    // Dismissal. The real endpoint marks the document dismissed and soft-deletes it,
    // so it leaves the queue -- which a test about the queue count has to see.
    const docDelete = path.match(/^\/documents\/([^/]+)$/)
    if (method === 'DELETE' && docDelete) {
      const gone = state.documents[docDelete[1]]
      state.queue = state.queue.filter((d) => d.id !== docDelete[1])
      delete state.documents[docDelete[1]]
      return ok({ deleted: { id: docDelete[1], label: gone?.label ?? '' } })
    }

    const docWrite = path.match(/^\/documents\/([^/]+)\//)
    if (docWrite) {
      const existing = state.documents[docWrite[1]]
      // Echo the document back with the write applied where it's cheap to do so,
      // so a component that re-seeds from the response doesn't see a blank.
      const updated: DocumentNode = { ...existing }
      if (path.endsWith('/concepts')) {
        updated.concepts = (body.concept_ids as string[]).map(
          (id) => ({ id, label: id }))
        updated.proposals = []          // Save consumes every concept proposal
        // `status` is DERIVED from having a concept, server-side and here: filed
        // under one or more, the document is reviewed and leaves the queue; filed
        // under none, it goes back to pending (`IngestionService._sync_status`).
        // The echo has to carry it -- the badge counts pending documents, and it
        // counts them from what this reply says.
        const reviewed = updated.concepts.length > 0
        updated.attributes = {
          ...existing.attributes, status: reviewed ? 'reviewed' : 'pending',
        }
        const rest = state.queue.filter((d) => d.id !== docWrite[1])
        state.queue = reviewed ? rest : [...rest, updated]
      }
      if (path.endsWith('/authors')) {
        updated.author_proposals = []   // and every author proposal
      }
      state.documents[docWrite[1]] = updated
      return ok(updated)
    }
    return ok({})
  }

  globalThis.fetch = handler as typeof fetch

  return {
    get requests() { return requests },
    get writes() { return requests.filter((r) => r.method !== 'GET') },
    reset() { requests.length = 0 },
    fail(match: string) { failing.push(match) },
    state,
  }
}

// --- BroadcastChannel ------------------------------------------------------
// jsdom has no BroadcastChannel, and `broadcast.ts` silently does nothing when the
// global is missing — so without this every cross-window test would pass by
// default, which is worse than having no test.

interface Listener { name: string; fn: ((e: { data: any }) => void) | null }

/** Messages seen on the `field-guide` channel, by a listener that isn't the app. */
export interface Channel { readonly sent: { event: string; payload?: string }[]
                           reset(): void
                           /** Post as if another window did it. */
                           post(event: string, payload?: string): void }

export function installBroadcastChannel(): Channel {
  const listeners: Listener[] = []
  const sent: { event: string; payload?: string }[] = []

  class Fake {
    name: string
    onmessage: ((e: { data: any }) => void) | null = null
    private entry: Listener
    constructor(name: string) {
      this.name = name
      this.entry = { name, fn: null }
      // `onmessage` is assigned after construction, so read it at delivery time.
      Object.defineProperty(this.entry, 'fn', { get: () => this.onmessage })
      listeners.push(this.entry)
    }
    postMessage(data: any) {
      sent.push(data)
      for (const l of listeners)
        if (l !== this.entry && l.name === this.name) l.fn?.({ data })
    }
    close() {
      const i = listeners.indexOf(this.entry)
      if (i >= 0) listeners.splice(i, 1)
    }
  }
  ;(globalThis as any).BroadcastChannel = Fake

  return {
    get sent() { return sent },
    reset() { sent.length = 0 },
    post(event: string, payload?: string) {
      const ch = new Fake('field-guide')
      ch.postMessage({ event, payload })
      ch.close()
    },
  }
}

// --- fixtures --------------------------------------------------------------

/** A document in the review queue. Defaults to the interesting case: it has
 *  scraped authors awaiting a decision and a concept proposal, because a document
 *  with neither exercises none of the paths these tests are about. */
export function queuedDocument(over: Partial<DocumentNode> = {}): DocumentNode {
  return {
    id: 'doc-1',
    label: 'A Paper About Cognitive Atrophy',
    type: 'document',
    attributes: {
      title: 'A Paper About Cognitive Atrophy',
      status: 'pending',
      summary: '',
      abstract: 'An abstract.',
      canonical_url: 'https://example.org/paper',
      no_named_author: false,
    },
    concepts: [],
    proposals: [],
    author_proposals: [],
    authors: [],
    corporate_authors: [],
    ...over,
  } as DocumentNode
}

/** A saved remark, as `GET /artifacts` returns it. `links` is the server's resolution
 *  of the ids in `body` — pass the targets the body points at. */
export function remark(over: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    label: 'What I make of Literacy',
    kind: 'note',
    body: '',
    subjects: [],
    links: [],
    dangling: [],
    created_by: 'curator',
    visibility: 'private',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  } as Artifact
}

export function conceptNode(id: string, label: string): GraphNode {
  return { id, label, type: 'concept', attributes: {} } as GraphNode
}

export function personNode(id: string, label: string): GraphNode {
  return { id, label, type: 'person', attributes: {} } as GraphNode
}

/** A followed feed. Defaults to healthy, enabled and pollable — override the parts
 *  a test is actually about. `accept_rate: null` is the default because "nothing
 *  judged yet" is the state the panel most easily gets wrong. */
export function source(over: Partial<Source> = {}): Source {
  return {
    id: 'source-1',
    label: 'Import AI',
    url: 'https://importai.example/feed',
    homepage: null,
    mechanism: 'rss',
    enabled: true,
    notes: '',
    pollable: true,
    health: {
      last_success_at: new Date().toISOString(), last_failure_at: null,
      consecutive_failures: 0, last_error: null, failing: false,
    },
    stats: { produced: 0, accepted: 0, dismissed: 0, pending: 0, accept_rate: null },
    ...over,
  }
}

export function entityRow(over: Partial<EntityRow> = {}): EntityRow {
  return {
    id: 'person-jane', label: 'Jane Doe', type: 'person',
    orcid: null, kind: null, documents: 0,
    ...over,
  }
}
