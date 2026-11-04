// Mirrors the JSON shapes api.py returns.

export interface GraphNode {
  id: string
  type: string
  label: string
  attributes: Record<string, any>
  created_at: string
  updated_at: string
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: string
  attributes: Record<string, any>
}

/** /api/ontology: concepts + structural edges only. Drives the row hierarchy. */
export interface Ontology {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** /api/graph: every node and edge. Same shape as Ontology, deliberately a
 *  separate name — the pivots need `about`/`authored_by`/`funds`, none of which
 *  the ontology map carries, and confusing the two is how a cell silently
 *  computes to zero. */
export interface FullGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface DocConcept {
  id: string
  label: string
}

/** Which kind of thing a credit is. Carried explicitly rather than looked up by
 *  id: a just-created entity hasn't landed in the refetched graph yet, so a lookup
 *  would file it as the wrong kind — silently, and only on the create path. */
export type CreditKind = 'person' | 'organization'

/** A credited author — a person or an organization. Same shape as DocConcept;
 *  named apart because the two are never interchangeable. */
export interface Credit {
  id: string
  label: string
}

/** A credit that knows what it is — what the single Authors field renders, since
 *  one list holds both and the chips are coloured by kind. */
export interface KindedCredit extends Credit {
  kind: CreditKind
}

/** One scraped author name, and the existing node it matches — if any.
 *
 *  Ingestion no longer creates people, so this is how a scraped name reaches the
 *  curator: as a suggestion resolved against nodes that already exist (never an
 *  invented one), written to the graph only on Save. `match: null` means the name
 *  is new to the guide and needs an explicit create. */
export interface AuthorProposal {
  name: string
  /** The ORCID that came with the scrape, bare (`0000-0002-...`), when there was
   *  one. Carried even on an unmatched proposal so creating the person prefills it
   *  — an id confirmed beats an id looked up. Only OpenAlex supplies these; arXiv
   *  and feeds give names alone. */
  orcid: string | null
  /** `via` records what did the matching, and the two are not equivalent: an ORCID
   *  is an identity, a name is a guess. An ORCID match holds across the name
   *  variants a person publishes under, which is why it's tried first and why a
   *  disagreement with the name isn't treated as a duplicate. */
  match: { id: string; label: string; kind: CreditKind; via: 'orcid' | 'name' } | null
}

/** What kind of venue published a document — `attributes.venue_tier`, set by
 *  discovery (see `scout.venue_tier`). It orders the review queue and shows as a
 *  badge; it never hides anything. `null` is a real third state — a feed post or a
 *  page added by hand has no venue to judge, which is not the same as a bad one. */
export type VenueTier = 'journal' | 'preprint' | null

export interface DocumentNode extends GraphNode {
  concepts: DocConcept[]
  /** Discovery's suggestions — concepts whose search surfaced this document. Kept
   *  separate from `concepts` so a guess is never mistaken for a decision. */
  proposals: DocConcept[]
  /** Scraped names awaiting a decision — matched to existing nodes where possible. */
  author_proposals: AuthorProposal[]
  /** Credited people. */
  authors: Credit[]
  /** Organizations credited AS the author — an OECD report, an unbylined lab post.
   *  Not the authors' employers: a document has no affiliation of its own, and an
   *  author's institution lives on the person, via `member_of`. */
  corporate_authors: Credit[]
}

/** How many of these documents still await approval.
 *
 *  The one definition of the queue count, used by both places that show it — the
 *  header button and the list's own badge. They must agree: they name the same
 *  number, and two counts of "how much is left" that disagree is a bug report.
 *
 *  It reads `status` and nothing else. The obvious alternative — row count minus
 *  the set of documents approved in this sitting — was what the badge used to do,
 *  and it was wrong whenever the two fell out of step: any refetch drops the
 *  approved rows from the list, after which subtracting them again counted each
 *  approval twice. A status is carried BY the document, so it cannot drift from it.
 *
 *  An approved row deliberately stays in the queue, tinted, until the next fetch
 *  (see `finished` in DocumentList) — so a queue list is not all pending, and its
 *  length is not this number. */
export function pendingCount(docs: GraphNode[]): number {
  return docs.filter((d) => d.attributes.status === 'pending').length
}

/** Which of the three attribution states a document is in. Derived on the client
 *  from the credits plus `no_named_author`, rather than fetched: the server would
 *  have to walk `member_of` per document to answer it, once per queue row. */
export type AttributionState = 'attributed' | 'none' | 'missing'

export function attributionState(doc: DocumentNode): AttributionState {
  if (doc.authors.length > 0 || doc.corporate_authors.length > 0) return 'attributed'
  return doc.attributes.no_named_author ? 'none' : 'missing'
}

/** One row of the Entities window. `documents` is a count, not a list: this window
 *  finds an entity, and the list of what it's credited on belongs on the card you
 *  open from here. */
export interface EntityRow {
  id: string
  label: string
  type: CreditKind
  orcid: string | null
  kind: string | null
  documents: number
}

/** A person or organization with everything the node card renders. Affiliations,
 *  writes-at and credited documents are all derived per read from edges — nothing
 *  about an entity is stored twice. */
export interface EntityDetail extends GraphNode {
  affiliations: Credit[]
  writes_at: Credit[]
  documents: Credit[]
}

/** Corrections to an existing person. Patch semantics for the text fields (omit to
 *  leave alone, "" to clear); set semantics for the link lists, matching /authors
 *  and /concepts — the whole set, never a delta. */
export interface PersonPatch {
  full_name?: string
  orcid?: string | null
  homepage?: string | null
  affiliation_ids?: string[]
  source_ids?: string[]
}

export interface OrganizationPatch {
  name?: string
  kind?: string
  homepage?: string | null
  source_ids?: string[]
}

/** A scraped author who isn't in the guide yet — shown as a chip badged NEW.
 *
 *  Credited by default, like every other proposal: agreeing with the scrape is the
 *  common case, so it costs no click and disagreeing costs one (the chip's ✕).
 *  Deliberately NOT created at the moment it appears: a document abandoned without
 *  saving must leave nothing behind, which is the same rule that took node creation
 *  out of ingestion. It becomes a node during Save, immediately before the credit
 *  that was the point of creating it.
 *
 *  `kind` starts as a guess (see entityKind.ts) because a node can't be created
 *  without one, and defaulting everything to `person` is the failure this area was
 *  rebuilt to stop. The guess is printed on the chip and editable there, so it is
 *  never the last word. */
export interface PendingCredit {
  name: string
  orcid: string | null
  kind: CreditKind
  /** The affiliation and the source, carried rather than written. The check dialog
   *  offers the same fields the create dialog does — the moment you're looking at an
   *  author is the moment you know these — but a pending credit has no node for an
   *  edge to hang off yet, so they ride along and are applied when Save creates it.
   *  Exactly the payload `createPerson` / `createOrganization` already take. */
  orgName?: string | null
  sourceId?: string | null
}

/** A new person plus the two edges the creation dialog can write at the same time.
 *  `org_name` finds-or-creates by name; `source_id` must already exist. */
export interface PersonCreate {
  full_name: string
  orcid?: string | null
  org_name?: string | null
  source_id?: string | null
}

/** What /api/concepts/{id} returns: the concept plus everything hanging off it. */
export interface ConceptDetail {
  concept: GraphNode
  documents: GraphNode[]
  people: GraphNode[]
  related: { edge: GraphEdge; node: GraphNode }[]
}

/** Patch semantics: an omitted field is left alone; "" clears it. `label`
 *  renames the concept. `keywords` is the arXiv boolean query and
 *  `semantic_query` is the OpenAlex one; `description` is the reader-facing
 *  definition and drives no search — see ConceptAttrs in graph/types.py. */
export interface ConceptPatch {
  label?: string
  description?: string
  semantic_query?: string
  keywords?: string
  criteria?: string
}

/** A new concept. `parent_id` makes it a subtopic of that concept; omit for a
 *  new top-level concept. */
export interface ConceptCreate {
  label: string
  parent_id?: string | null
  description?: string
  semantic_query?: string
  keywords?: string
  criteria?: string
}

/** /api/scout/run: counts from one discovery pass over every concept.
 *  `failures` counts searches that errored (throttling, timeouts) — without it a
 *  degraded run is indistinguishable from a thin literature. */
export interface ScoutRunResult {
  ingested: number
  duplicates: number
  /** Previously dismissed URLs, refused rather than re-offered. */
  suppressed: number
  /** Found but already in the guide — dropped during search, not ingestion. */
  already_known: number
  /** Found but previously dismissed — likewise dropped during search. */
  dismissed: number
  candidates: number
  dropped: number
  openalex: boolean
  filtered: boolean
  failures: number
  failure_detail: string[]
  /** Path to the plain-text report explaining every drop. */
  report: string
}

/** What deleting a concept would take with it — the confirm dialog's data. */
export interface DeletionPreview {
  target: { id: string; label: string }
  also_deleted: { id: string; label: string }[]
  documents_requeued: number
}

export interface Readable {
  url: string
  ok: boolean
  title?: string
  fetch_outcome?: string
  reason?: string
  paragraphs: string[]
}

/** /api/scope: the guide-scope Artifact. `is_default` = the curator hasn't written
 *  one, so screening is running on built-in wording. */
export interface GuideScope {
  body: string
  is_default: boolean
  updated_at: string | null
}

/** One node matched by a search box — the subject picker and the ⌘K link picker.
 *  `type` drives the badge that tells a concept apart from a document that merely
 *  shares its words. */
export interface NodeHit {
  id: string
  type: string
  label: string
}

/** A ⌘K link-picker hit. `via` is the text that actually matched when it wasn't the
 *  label — an author's name, or a venue — and the picker shows it, because a result
 *  whose words you never typed reads as a bug in the search. `visibility` comes back
 *  for remarks only: linking a private one is allowed, but a reader will see the
 *  words without the link until it's published, which is worth knowing first. */
export interface LinkHit extends NodeHit {
  via?: string
  visibility?: Visibility
}

/** A curator remark. `subjects` are chosen (`remarks_on`); `links` is RESOLVED from
 *  the ids in the body, never set directly, and carries each target's type — which is
 *  what lets the References block show the documents without reddening a link to a
 *  concept. `dangling` names the links that resolve to no live node at all, which have
 *  nothing to appear in `links` and would otherwise vanish from the editor.
 *  See ARTIFACTS_DESIGN.md. */
export type Visibility = 'public' | 'private'

export interface Artifact {
  id: string
  label: string
  kind: string
  body: string
  subjects: NodeHit[]
  links: NodeHit[]
  dangling: string[]
  created_by: string | null
  /** The reader/curator boundary: private until deliberately published. */
  visibility: Visibility
  created_at: string
  updated_at: string
}

/** A field node as a reader sees it — attributes already narrowed to the public
 *  allowlist server-side, so `attributes` here is the safe subset, not the full node. */
export interface ReadNode {
  id: string
  type: string
  label: string
  attributes: Record<string, any>
}

/** A published remark for a reader: prose, what it's about, what it links to, and a
 *  byline. No visibility (all public here) and no dangling (readers don't fix links).
 *  `links` is already narrowed to what a reader may see — a link to a private draft
 *  is absent, so it renders as plain words rather than leaking that draft's title. */
export interface ReadArtifact {
  id: string
  label: string
  body: string
  subjects: NodeHit[]
  links: NodeHit[]
  author: string | null
  updated_at: string
  /** Concept node id -> `#rrggbb`: the colour of each of this remark's concepts in
   *  the drawing. Read by `build_polygons`, not by the viewer's panels.
   *
   *  OPTIONAL because this type describes two payloads, not one. `/api/read/graph`
   *  always sends it; the published `read-graph.json` never does, since
   *  `export_guide.py`'s `DROPPED_ARTIFACT_FIELDS` strips it at the boundary. The
   *  one read site (`Viewer.tsx`, feeding the parked quilt canvas) already wrote
   *  `a.paint ?? {}`, so this makes the type admit what that line already assumed. */
  paint?: Record<string, string>
}

/** /api/read/graph — the reader's entire view. The (deferred) viewer builds on this. */
export interface ReadGraph {
  nodes: ReadNode[]
  artifacts: ReadArtifact[]
  edges: GraphEdge[]
}

// --- the nested-polygon drawing --------------------------------------------
//
// `/api/read/polygons` — the reader's canvas. One drawing per remark, each in ITS OWN
// coordinates with its outer wall centred on the origin.
//
// WHERE THE LINE IS: shape is server-side, placement is not. A block arrives as a disc
// of radius `r`, and how many discs fit on a row before it breaks is a question about
// the width of a browser window, which polygons.py cannot answer. So the renderer
// TRANSLATES blocks and does nothing else — everything inside one is finished.

/** One outline. `kind` says what it wraps, which is also where a click goes: a
 *  `concept` opens its card, a `remark` opens in the detail pane. */
export interface PolygonShape {
  kind: 'concept' | 'remark'
  id: string
  name: string
  /** Page coordinates, `[x, y]`, in draw order. Closed by the renderer, not here. */
  points: [number, number][]
  /** HOW DEEP THIS SHAPE IS NESTED. The remark's wall is 0, the concepts inside it 1,
   *  the concepts inside those 2. The flat list of shapes says nothing else about what
   *  is inside what, which is why polygons.py counts this during the one traversal
   *  that knows. Not currently read by the renderer; kept because polygons.py still
   *  computes it and other consumers of this shape (tests, future depth-based styling)
   *  may want it. */
  depth: number
  /** The colour the curator gave this concept IN THIS REMARK, `#rrggbb`. Absent on
   *  a concept nobody has coloured and on every remark wall. When `fillEnd` is also
   *  absent, the reader derives its own two-tone gradient from this one hex — see
   *  `gradientEnds` in PolygonCanvas.tsx. */
  fill?: string
  /** The gradient's other end, when the curator chose both outright rather than
   *  leaving the second to be derived. Never present without `fill`. */
  fillEnd?: string
  /** Present with `fill`: the outlines drawn INSIDE this one, to be cut out of the
   *  fill so a concept wrapped around another does not paint over it. Empty for a
   *  concept with nothing nested in it. */
  holes?: [number, number][][]
}

/** A document, drawn as a dot on a corner of a concept that holds it.
 *
 *  `id` IS NOT UNIQUE within a page. A document about two drawn concepts gets a dot on
 *  each — which is the drawing saying it belongs to both — so both dots carry the same
 *  id and both open the same document. Never key a list on it. */
export interface PolygonDot {
  id: string
  name: string
  x: number
  y: number
}

/** One remark: its outer wall, the concept walls nested inside it, and its dots —
 *  all in the block's OWN coordinates, centred on (0, 0). */
export interface PolygonBlock {
  id: string
  title: string
  /** Radius bounding the whole block, so it occupies (-r, -r) to (r, r). Place a
   *  block by translating it; this is the only number needed to know its size. */
  r: number
  shapes: PolygonShape[]
  dots: PolygonDot[]
  /** Where the remark's title goes, relative to the block's own middle. */
  label: { x: number; y: number }
}

/** /api/read/polygons — the whole drawing, biggest remark first. Empty `blocks` for a
 *  guide with no published remarks. There is no page width or height: those are
 *  whatever the renderer's row-breaking makes them. */
export interface PolygonPage {
  /** Radius of a document dot, in the same units — so the renderer hardcodes no size. */
  dot_r: number
  /** Clear space to leave between two blocks. Applying it is the renderer's job. */
  margin: number
  blocks: PolygonBlock[]
}

// `/api/read/quilts` — the reader's other canvas. One tile per remark a curator has
// explicitly assigned a pattern to; a remark with none set is simply absent from
// `blocks`, not drawn as anything.

interface QuiltShapeBase {
  /** Which named position in the pattern this is, e.g. `circle`, `petal_0`. */
  slot: string
  /** The concept id assigned to this slot — what decides its colour, the same way
   *  a PolygonShape's fill is looked up: by concept id, in the remark's `paint`. */
  concept: string
  /** That concept's own name — for a tooltip, since the shape itself carries no
   *  visible label. */
  name: string
  /** Documents about this slot's concept that this remark also points at — same
   *  convention as PolygonDot (`id` is not unique within a page: a document about
   *  two drawn concepts gets a dot on each). Already placed at this shape's own
   *  candidate points, best position first; if there were more documents than
   *  candidates, the rest simply aren't here. */
  dots: { id: string; name: string; x: number; y: number }[]
}

/** A straight-edged shape: a petal, or the background tile. `points` is the
 *  outline, in draw order, closed by the renderer — same convention as
 *  PolygonShape. */
export interface QuiltPolygon extends QuiltShapeBase {
  kind: 'polygon'
  points: [number, number][]
}

/** A pie-slice with one real curved edge, e.g. the petal pattern's quarter-circle.
 *  Draw two straight lines — centre to `start`, centre to `end` — and one true arc
 *  of radius `r` between `start` and `end`. */
export interface QuiltWedge extends QuiltShapeBase {
  kind: 'wedge'
  cx: number
  cy: number
  r: number
  start: [number, number]
  end: [number, number]
}

export type QuiltShape = QuiltPolygon | QuiltWedge

/** One remark's tile: a fixed pattern filled in with its own assigned shapes, all
 *  in the tile's own coordinates, corner at (0, 0). */
export interface QuiltBlock {
  id: string
  title: string
  /** Which pattern this tile uses, e.g. `"petal"`. */
  pattern: string
  /** The tile is `tile` x `tile` in its own coordinates — how big a square to
   *  reserve for it, before it's placed on the page. */
  tile: number
  shapes: QuiltShape[]
}

/** /api/read/quilts — every assigned tile. Empty `blocks` for a guide where
 *  nothing has a pattern yet. Unlike PolygonPage there's no shared `dot_r` or
 *  `margin` here: this payload is shape only, same as `build_quilts` on the
 *  Python side — dot size and block spacing are the drawing component's and
 *  canvasLayout.ts's own concerns, not decided yet. */
export interface QuiltPage {
  blocks: QuiltBlock[]
}

/** None means "leave alone" on update — which is how clearing the subjects (`[]`)
 *  stays distinct from a body-only edit (`undefined`). */
export interface ArtifactWrite {
  label?: string
  body?: string
  subject_ids?: string[]
  visibility?: Visibility
}

/** /api/environment: which data set the API is talking to, and the choices. */
export interface EnvironmentState {
  active: string
  options: { key: string; label: string }[]
}

/** One source in the Sources window. `health` is polling state kept outside the
 *  graph; `stats` is derived from `sourced_from` edges on every read, never stored
 *  — a counter would drift the moment a document is re-categorised or un-dismissed. */
export interface SourceHealth {
  last_success_at: string | null
  last_failure_at: string | null
  consecutive_failures: number
  last_error: string | null
  failing: boolean
}

export interface SourceStats {
  produced: number
  accepted: number
  dismissed: number
  pending: number
  /** null when nothing has been judged yet — "no opinion" must not read as "all rejected". */
  accept_rate: number | null
}

export interface Source {
  id: string
  label: string
  url: string
  homepage: string | null
  mechanism: string
  enabled: boolean
  notes: string
  /** Whether there is anything to fetch. False for the search APIs (queried, not
   *  polled) and for the manual bucket (not fetched at all) — neither has health
   *  or a "run now". */
  pollable: boolean
  health: SourceHealth
  stats: SourceStats
}

/** Outcome of pasting URLs in by hand, bucketed rather than counted: "nothing
 *  appeared" has several causes and they want different responses from the
 *  curator. `restored` is a URL they had previously dismissed — the paste lifted
 *  the tombstone and brought the original document back. */
export interface AddDocumentsResult {
  added: AddedDocument[]
  restored: AddedDocument[]
  duplicates: AddedDocument[]
  /** Couldn't be fetched or extracted — a bot blocker, a dead link, a PDF. */
  failed: string[]
  /** Not http(s), so never attempted. */
  invalid: string[]
}

export interface AddedDocument {
  id: string
  title: string
  url: string | null
}

/** What the manual-add form sends: for a document our own fetch couldn't reach.
 *  `url` and `title` are required — there's no scraper here to have found a
 *  title on its own. Everything else is what the curator could copy from the
 *  page themselves. */
export interface ManualDocumentIn {
  url: string
  title: string
  authors?: string[]
  publication?: string
  date?: string
  abstract?: string
  full_text?: string
}

export interface SourcePreview {
  /** What the curator typed. Differs from `url` when it was a post or a front
   *  page and the feed had to be resolved from the page's own advertisement. */
  requested: string
  url: string
  /** "rss" when a feed was found, "page" when the page had none and its links were
   *  read as an index instead. Carried into the follow so it isn't re-derived. */
  mechanism: string
  count: number
  publication: string | null
  titles: string[]
}

// --- organization mode ------------------------------------------------------
// The curator's own partition of the review queue: piles made by hand on a canvas,
// kept entirely OUT of the graph. Mirrors `queue_segments.py` — see
// `writeups/design/QUEUE_ORGANIZATION_DESIGN.md`.

/** One pile. `x`/`y` is the circle's centre on the canvas, and it is load-bearing
 *  rather than decorative: the queue's segment order is read off these positions,
 *  so moving a circle is how the curator ranks it. There is no order field to
 *  disagree with the canvas. `color` is an index into `palette.ROOT_COLORS`. */
export interface Segment {
  id: string
  name: string
  note: string
  color: number
  x: number
  y: number
}

/** A whole canvas. `members` is keyed BY DOCUMENT, which is what enforces "a
 *  document is in at most one segment" — there is nowhere to write a second. */
export interface SegmentState {
  segments: Segment[]
  members: Record<string, string>   // document id -> segment id
  updated_at?: string | null
}

// --- curation assistant ------------------------------------------------------
// A read-only chat over the graph. See writeups/design/CURATION_ASSISTANT_DESIGN.md.

export interface AssistantMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What GET /assistant/conversation and POST /assistant/new-thread return: the
 *  curator's ongoing thread for whichever environment is active. */
export interface AssistantThread {
  history: AssistantMessage[]
  started_at: string | null
  updated_at: string | null
}

/** What POST /assistant/message returns. */
export interface AssistantReply {
  reply: string
  history: AssistantMessage[]
}
