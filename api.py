"""Curator HTTP API: a thin JSON skin over graph.services.

Every endpoint is a near-direct call into one of the four services -- no domain
logic lives here. The layering the package established (repository -> services)
is preserved: this module only ever touches services + the read-model repo, never
SQL.

Auth doesn't exist yet, but every mutation still needs an Actor (and a matching
`users` row). We seed one fixed "curator" user on startup and thread it through;
when real auth arrives it populates that Actor, not the call sites -- the seam the
schema left open.

Run it (dev):
    uvicorn api:app --reload
The React UI (ui/) proxies /api here in dev, or is served from ui/dist in prod.
"""

import os
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Dict, List, Optional
from uuid import UUID

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from psycopg import conninfo
from pydantic import BaseModel

# Load .env before anything reads os.getenv. Discovery's keys (OPENALEX_API_KEY,
# ANTHROPIC_API_KEY) live there, and without this the server silently ran every
# search degraded -- arXiv-only and unfiltered -- while the file sat right there.
load_dotenv()

from graph import (
    ArtifactService,
    ENVIRONMENTS,
    Actor,
    Edge,
    GraphQueryService,
    GraphRepository,
    IngestionBridge,
    IngestionService,
    Node,
    NodeNotFound,
    OntologyService,
    PeopleService,
    SourceService,
    connect,
    ensure_database,
    env_dsn,
    load_active_env,
    migrate,
    save_active_env,
)
from graph.scout_state import Health, PageLinkMemo, ScreenedUrls, SourceHealth
from graph.types import (
    EdgeType, NodeType, PaintColor, Quilt, normalize_orcid, person_name_key,
    public_edge_attrs, public_node_attrs,
)
from anthropic_key import anthropic_api_key
from assistant import Conversation, ConversationError, GraphReader, OpenContext, ScopeDecision
from assistant.text_writer import fetch_and_cache_full_text
import assistant.conversation_store as conversation_store
from pipeline_reports.dismissal_report import write_dismissal_report
from doi_lookup import default_resolver
from pipeline_reports.queue_report import default_embedder, default_lookup, write_queue_report
import queue_segments
from reader import NO_BODY_REASONS, Reader, fetch_best_result, split_paragraphs
from relevance_filter import DEFAULT_GUIDE_SCOPE

app = FastAPI(title="Field Guide — Curator API")


# The data environment the API is currently talking to. Server-side state, not
# per-request: the UI's picker flips it and everything follows, the way "switch
# the guide I'm curating" should behave. The choice survives a restart (see
# load_active_env for why that beats always landing on the sandbox) — a restart
# mid-session drops you back exactly where you were, and the picker warms to
# amber on the real guide so you can always see which one that is.
_active_env = load_active_env()


@app.on_event("startup")
def _prepare_environments() -> None:
    """Create and migrate every environment's database up front, so switching to
    one that's never been touched (a fresh, empty real guide) just shows an empty
    ontology instead of a 500."""
    for _key, _label, dsn in ENVIRONMENTS:
        ensure_database(dsn)
        conn = connect(dsn)
        try:
            migrate(conn)
        finally:
            conn.close()

# Dev-only: the Vite dev server runs on a different origin. In prod the UI is
# served from this same origin (see the static mount at the bottom), so this is
# harmless there.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# One Reader for on-demand readable fetches. delay=0: we fetch a single URL per
# request, so the politeness sleep between URLs is moot.
_reader = Reader(delay=0, resolver=default_resolver())

# The dev curator's user id, resolved lazily on first mutation and cached. Lazy
# (not a startup hook) so it doesn't depend on app-lifecycle ordering and works
# the same under uvicorn, TestClient, or a direct import.
#
# Cached PER ENVIRONMENT: each database has its own `users` table with its own
# curator row, so one global id would be wrong the moment you switch — it would
# stamp revisions in the guide with the sandbox's user id (a foreign key that
# doesn't even exist there).
_DEV_USER_IDS: Dict[str, UUID] = {}


def _dev_actor_id() -> UUID:
    """Find-or-create the dev curator user in the *active* environment, caching
    its id per environment."""
    env = _active_env
    if env in _DEV_USER_IDS:
        return _DEV_USER_IDS[env]
    with connect(env_dsn(env), autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("select id from users where handle = %s", ("curator",))
        row = cur.fetchone()
        if row is None:
            cur.execute(
                "insert into users (handle, role) values (%s, %s) returning id",
                ("curator", "curator"),
            )
            row = cur.fetchone()
        _DEV_USER_IDS[env] = row[0]
    return _DEV_USER_IDS[env]


# --------------------------------------------------------------------------
# Per-request context: a fresh connection (psycopg connections aren't safe to
# share across FastAPI's threadpool workers) plus the services built on it.
# --------------------------------------------------------------------------

class Ctx:
    def __init__(self, conn):
        self.conn = conn
        self.repo = GraphRepository(conn)
        self.ontology = OntologyService(self.repo)
        self.ingest = IngestionService(self.repo)
        self.people = PeopleService(self.repo)
        self.artifacts = ArtifactService(self.repo)
        self.query = GraphQueryService(self.repo)
        self.sources = SourceService(self.repo)
        self.health = SourceHealth(conn)

    @property
    def actor(self) -> Actor:
        return Actor(id=_dev_actor_id(), role="curator")


def get_ctx():
    # autocommit is required, not incidental: the repo wraps each write in a
    # `conn.transaction()` block, which only COMMITs when it's the *top-level*
    # transaction. Endpoints read (e.g. _require_document) before they write; on a
    # non-autocommit connection that first SELECT opens an implicit transaction, so
    # the write's block degrades to a savepoint that never commits and is rolled
    # back on close. In autocommit mode each transaction() block is its own
    # BEGIN/COMMIT and stray reads leave no open transaction.
    conn = connect(env_dsn(_active_env), autocommit=True)
    try:
        yield Ctx(conn)
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Serialization: dataclasses -> JSON-safe dicts. UUIDs to str, datetimes to ISO.
# The React Flow mapping (attributes.layout -> node position) is done client-side
# so the graph component owns its own layout policy.
# --------------------------------------------------------------------------

def node_json(n: Node) -> Dict:
    return {
        "id": str(n.id),
        "type": n.type,
        "label": n.label,
        "attributes": n.attributes,
        "created_at": n.created_at.isoformat(),
        "updated_at": n.updated_at.isoformat(),
    }


def edge_json(e: Edge) -> Dict:
    return {
        "id": str(e.id),
        "source": str(e.source_id),
        "target": str(e.target_id),
        "type": e.type,
        "attributes": e.attributes,
    }


def _doc_concepts(ctx: Ctx, doc_id: UUID) -> List[Dict]:
    """The concepts a document is currently categorized under (its `about` edges)."""
    pairs = ctx.repo.neighbors(doc_id, edge_types=[EdgeType.ABOUT], direction="out")
    return [{"id": str(n.id), "label": n.label} for _e, n in pairs]


def _doc_proposals(ctx: Ctx, n: Node) -> List[Dict]:
    """Outstanding discovery suggestions, resolved to labels for display.

    Concepts deleted since the run are dropped rather than shown as dead ids -- the
    proposal was only ever a suggestion, so a vanished target is nothing to report.
    Anything already assigned is filtered out too, so a chip can't appear twice.
    """
    assigned = {c["id"] for c in _doc_concepts(ctx, n.id)}
    out = []
    for cid in n.attributes.get("proposed_concept_ids", []):
        if cid in assigned:
            continue
        try:
            node = ctx.repo.get_node(UUID(cid))
        except (ValueError, TypeError):
            continue
        if node is not None and node.type == "concept":
            out.append({"id": str(node.id), "label": node.label})
    return out


def _doc_attribution(ctx: Ctx, doc_id: UUID) -> Dict[str, List[Dict]]:
    """Who a document is credited to, split by what kind of thing they are.

    One `neighbors` call, deliberately -- NOT `PeopleService.attribution_of`, which
    also walks `member_of` to reach affiliations. This runs once per document in the
    queue, so the walk would be paid hundreds of times over to render information
    the details panel doesn't currently show. `state` is derivable client-side from
    these two lists plus `no_named_author`, which is already in `attributes`.
    """
    pairs = ctx.repo.neighbors(
        doc_id, edge_types=[EdgeType.AUTHORED_BY], direction="out")
    credited = [n for _e, n in pairs]
    return {
        "authors": [{"id": str(n.id), "label": n.label}
                    for n in credited if n.type == NodeType.PERSON.value],
        # An organization credited directly is the document's *author* (an OECD
        # report, an unbylined lab post), not an affiliation of its people.
        "corporate_authors": [{"id": str(n.id), "label": n.label}
                              for n in credited
                              if n.type == NodeType.ORGANIZATION.value],
    }


def _author_proposals(ctx: Ctx, n: Node) -> List[Dict]:
    """Scraped author names matched against nodes that ALREADY exist.

    The proposal surface that replaced auto-linking at ingest. Two rules make it
    safe where the old behaviour wasn't:

      * **Only existing nodes are proposed**, so a proposal can never invent a node
        type. The scraper cannot tell "Center for Humane Technology" from a person;
        matching against the graph means the curator's own earlier judgement decides
        which it is, every time after the first.
      * **Nothing is written.** These are suggestions rendered from strings; the
        `authored_by` edges appear only when the curator saves the document.

    Matching runs ORCID first, then the name. The order is the point: an ORCID is an
    identity and a name is a guess, so they are not two ways of doing one thing.
    People carry ORCIDs precisely BECAUSE they publish under varying names -- A.
    Person, Another B. Person -- and an id that matches settles the question no matter
    how far the strings have drifted. When the two disagree, ORCID wins outright and
    nothing is flagged: a name collision is the situation the identifier exists to
    survive, not evidence of a duplicate.

    Name matching stays exact and case-insensitive. Fuzzy matching is a guess, and not
    guessing is the entire point -- an unmatched name is reported as such so the
    curator creates the node explicitly. Two things widen "exact" without guessing:
    names compare through `person_name_key`, so "Demszky, Dorottya" is the same
    string as "Dorottya Demszky", and a node's `aliases` match as well as its label.

    **Only names still outstanding are proposed.** The set comes from
    `proposed_author_names`, which Save empties, and NOT from `authors_scraped`,
    which is permanent. That is what scopes an author-proposal decision: a rejected
    byline is gone from the outstanding list, so it is not offered again on this
    document, while every other document that scraped the same name still asks. It is
    also why an APPROVED document proposes nobody -- its list was emptied when it left
    the review queue, so a scraped name with no `authored_by` edge behind it reads as
    the missing pointer it is, rather than as a fresh suggestion. `authors_scraped` is
    still read here, for the ORCIDs; the outstanding list carries names alone, since
    an author proposal that matches nothing has no id yet.

    TODO(llm-resolution): the automatic version -- read the document, look the
    entity up, decide person or organization, find where it writes -- hangs here.
    See PEOPLE_DESIGN.md item 3.
    """
    outstanding = {(name or "").strip().lower()
                   for name in (n.attributes.get("proposed_author_names") or [])}
    scraped = [a for a in (n.attributes.get("authors_scraped") or [])
               if (a.get("name") or "").strip()
               and (a["name"]).strip().lower() in outstanding]
    if not scraped:
        return []
    credited = {c.id for _e, c in ctx.repo.neighbors(
        n.id, edge_types=[EdgeType.AUTHORED_BY], direction="out")}

    # A name can match both a person and an organization -- which means the graph
    # holds a duplicate that wants correcting, not that we should pick cleverly.
    # Person wins the tie because that's the mistake ingestion used to make, so the
    # wrong one shows up tinted as a person and is visibly the thing to fix.
    by_name: Dict[str, Node] = {}
    by_orcid: Dict[str, Node] = {}
    for kind in (NodeType.PERSON, NodeType.ORGANIZATION):
        for node in ctx.repo.find_nodes(type=kind, limit=10000):
            for spelling in [node.label, *(node.attributes.get("aliases") or [])]:
                by_name.setdefault(person_name_key(spelling), node)
            # Only people have ORCIDs; organizations never enter this index.
            oid = normalize_orcid(node.attributes.get("orcid"))
            if oid:
                by_orcid.setdefault(oid, node)

    out, seen = [], set()
    for author in scraped:
        name = author["name"].strip()
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        orcid = normalize_orcid(author.get("orcid"))
        match, via = (by_orcid.get(orcid), "orcid") if orcid else (None, None)
        if match is None:
            match, via = by_name.get(person_name_key(name)), "name"
        # An already-credited match isn't a proposal -- it's a chip on screen.
        if match is not None and match.id in credited:
            continue
        out.append({
            "name": name,
            # Carried even when unmatched: the create dialog prefills it, which is
            # what makes an ORCID something the curator confirms rather than types.
            "orcid": orcid,
            "match": ({"id": str(match.id), "label": match.label,
                       "kind": match.type, "via": via} if match else None),
        })
    return out


def document_json(ctx: Ctx, n: Node) -> Dict:
    """A document node plus its live concept assignments -- what the details panel
    needs to render current state in one call. `proposals` are discovery's
    suggestions, kept separate from `concepts` so the UI can't confuse what the
    curator decided with what a search guessed."""
    return {**node_json(n), "concepts": _doc_concepts(ctx, n.id),
            "proposals": _doc_proposals(ctx, n),
            "author_proposals": _author_proposals(ctx, n),
            **_doc_attribution(ctx, n.id)}


def _require_document(ctx: Ctx, doc_id: UUID) -> Node:
    node = ctx.repo.get_node(doc_id)
    if node is None:
        raise HTTPException(404, "document not found")
    if node.type != "document":
        raise HTTPException(400, f"node {doc_id} is a {node.type}, not a document")
    return node


def _has_edge(ctx: Ctx, source_id: UUID, target_id: UUID, type: EdgeType) -> bool:
    """Is this exact live edge already there? `edges_triple_uniq` forbids a second
    one, so callers that might repeat a write check first."""
    return any(n.id == target_id for _e, n in ctx.repo.neighbors(
        source_id, edge_types=[type], direction="out"))


def _require_concept(ctx: Ctx, concept_id: UUID) -> Node:
    node = ctx.repo.get_node(concept_id)
    if node is None:
        raise HTTPException(404, "concept not found")
    if node.type != "concept":
        raise HTTPException(400, f"node {concept_id} is a {node.type}, not a concept")
    return node


# --------------------------------------------------------------------------
# Environment: which data set (sandbox / real guide) the API is talking to.
# The picker in the UI header reads and flips this.
# --------------------------------------------------------------------------

class EnvironmentIn(BaseModel):
    env: str


def _environment_state() -> Dict:
    return {
        "active": _active_env,
        # WHICH DATABASE that name currently resolves to. The name is a setting; this
        # is the fact, and they can disagree -- $DATABASE_URL is deliberately
        # repointable (db.py calls it the config-not-rewrite seam), so a server can
        # legitimately report `guide` while serving the sandbox's rows, which is
        # exactly how one of this machine's dev servers is configured. `export_guide.py`
        # refuses to publish on this field rather than on `active`, because the export
        # is permanent and public and a label is not evidence.
        "database": conninfo.conninfo_to_dict(env_dsn(_active_env)).get("dbname"),
        "options": [{"key": key, "label": label} for key, label, _dsn in ENVIRONMENTS],
    }


@app.get("/api/environment")
def get_environment() -> Dict:
    return _environment_state()


@app.post("/api/environment")
def set_environment(body: EnvironmentIn) -> Dict:
    """Switch the active environment. A no-op if it's already active.

    The choice is written to disk, so the next server start comes up here too.
    """
    global _active_env
    if body.env not in {key for key, _label, _dsn in ENVIRONMENTS}:
        raise HTTPException(400, f"unknown environment: {body.env}")
    _active_env = body.env
    save_active_env(body.env)
    return _environment_state()


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------

@app.get("/api/ontology")
def get_ontology(ctx: Ctx = Depends(get_ctx)) -> Dict:
    """All concepts + their structural edges -- the whole right-pane dataset."""
    g = ctx.query.ontology_map()
    return {"nodes": [node_json(n) for n in g.nodes],
            "edges": [edge_json(e) for e in g.edges]}


@app.get("/api/graph")
def get_graph(ctx: Ctx = Depends(get_ctx)) -> Dict:
    """The whole live graph -- every node and edge. Backs the pivot tables, whose
    cells are all derived from `about` edges that /api/ontology doesn't carry."""
    g = ctx.query.full_graph()
    return {"nodes": [node_json(n) for n in g.nodes],
            "edges": [edge_json(e) for e in g.edges]}


@app.get("/api/queue")
def get_queue(ctx: Ctx = Depends(get_ctx)) -> List[Dict]:
    """Documents awaiting review (status=pending), oldest first."""
    return [document_json(ctx, n) for n in ctx.query.review_queue()]


# --------------------------------------------------------------------------
# The queue's SEGMENTS -- the curator's own partition of the pile, made by hand
# in organization mode. Not the graph: no node, no edge, no revision. It lives in
# a file per environment (queue_segments.py), and these two calls are the whole
# surface. See writeups/design/QUEUE_ORGANIZATION_DESIGN.md.
# --------------------------------------------------------------------------

@app.get("/api/queue/segments")
def get_queue_segments(ctx: Ctx = Depends(get_ctx)) -> Dict:
    """This environment's canvas, pruned against the queue as it stands now.

    The prune is why this needs `ctx` at all: documents leave the queue by being
    reviewed or dismissed, and the file never hears about it. Their memberships go,
    and any segment they were the last of goes with them.
    """
    pending = [n.id for n in ctx.query.review_queue()]
    state = queue_segments.prune(queue_segments.load(_active_env), pending)
    return state.model_dump(mode="json")


@app.put("/api/queue/segments")
def put_queue_segments(body: queue_segments.SegmentState) -> Dict:
    """Replace the canvas wholesale, and answer with what was actually written.

    Whole-blob because one curator is editing one document -- a per-member PATCH
    surface would need conflict rules for a conflict that can't arise. The reply is
    not an echo: `save` drops empty segments, so the client has to be told which of
    the ones it sent survived.
    """
    return queue_segments.save(_active_env, body).model_dump(mode="json")


@app.get("/api/nodes/search")
def search_nodes(q: str, limit: int = 20, ctx: Ctx = Depends(get_ctx)) -> List[Dict]:
    """Label substring search across EVERY node type, for the subject picker.

    A remark can be about a concept, a document, a person, an org, or a source, so
    this searches them all in one list and each hit carries its `type` for the badge
    the picker shows -- "Misinformation" the concept and a paper titled about it are
    both legitimate subjects and the curator picks which.

    Artifacts are excluded. Remarking on a remark is allowed by the model but is not
    part of this flow, and a picker that offered the artifact you're currently
    writing as a subject of itself would be a trap, not a feature.
    """
    if not q.strip():
        return []
    hits = ctx.repo.search_nodes(q, limit=limit)
    return [{"id": str(n.id), "type": n.type, "label": n.label}
            for n in hits if n.type != NodeType.ARTIFACT.value]


@app.get("/api/links/search")
def search_link_targets(q: str, limit: int = 20,
                        ctx: Ctx = Depends(get_ctx)) -> List[Dict]:
    """What the Cmd+K link picker offers: anything in the guide worth pointing at.

    THREE ways to find one thing, merged into one list, because the curator is
    mid-sentence and looking something up must not become a research task:

      * by its own name -- any node type
      * by its AUTHOR -- "I remember Baddeley wrote it, not what it was called"
      * by its VENUE -- "that Nature piece"

    A hit found the second or third way carries `via`, the text that actually matched,
    and the picker shows it. Without that, a result whose words you never typed reads
    as a bug in the search.

    What is NOT offered, and why:

      * SOURCES. The reader has no page for one -- a source is rendered inline as a
        link where it appears -- so the link would resolve to a label and then go
        nowhere when clicked. Offering a target with no destination is worse than not
        offering it.
      * The GUIDE SCOPE. It is an artifact mechanically, but it is prose about the
        guide rather than a thing in the guide, and it has no reader surface either.
      * Unreviewed documents, which `search_nodes` already refuses (APPROVED_ONLY).
        A picker is exactly where an unapproved document must not appear.

    Remarks ARE offered, `visibility` included, so the picker can badge a private one:
    the link works for the curator and degrades to plain text for readers until it is
    published, which is a thing to know before you write the sentence, not after.

    MUST stay above `/api/links/{...}`-shaped routes for the reason the old
    `/documents/search` did: FastAPI resolves in definition order.
    """
    if not q.strip():
        return []

    def offerable(n: Node) -> bool:
        if n.type == NodeType.SOURCE.value:
            return False
        return not (n.type == NodeType.ARTIFACT.value
                    and n.attributes.get("kind") != ArtifactService.NOTE)

    def row(n: Node, via: Optional[str] = None) -> Dict:
        d: Dict = {"id": str(n.id), "type": n.type, "label": n.label}
        if via:
            d["via"] = via
        if n.type == NodeType.ARTIFACT.value:
            d["visibility"] = n.attributes.get("visibility", "private")
        return d

    # Name matches first and unqualified: they are what the curator typed. The two
    # edge searches then fill in behind, and a document already found by name is not
    # repeated with a `via` -- it was found the direct way, which is the truer story
    # of how it turned up.
    out: List[Dict] = [row(n) for n in ctx.repo.search_nodes(q, limit=limit)
                       if offerable(n)]
    seen = {d["id"] for d in out}
    for node, via in (ctx.repo.documents_by_author(q, limit=limit)
                      + ctx.repo.documents_by_publication(q, limit=limit)):
        if str(node.id) not in seen:
            seen.add(str(node.id))
            out.append(row(node, via))
    return out[:limit]


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    return document_json(ctx, _require_document(ctx, doc_id))


@app.get("/api/concepts/{concept_id}")
def get_concept(concept_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """One concept with everything hanging off it -- what the concept panel needs.
    _require_concept runs first so a missing/mistyped id is a 404/400 rather than
    a NodeNotFound escaping the service as a 500."""
    _require_concept(ctx, concept_id)
    d = ctx.query.concept_detail(concept_id)
    return {
        "concept": node_json(d["concept"]),
        "documents": [node_json(n) for n in d["documents"]],
        "people": [node_json(n) for n in d["people"]],
        "related": [{"edge": edge_json(e), "node": node_json(n)}
                    for e, n in d["related"]],
    }


def _readable_payload(doc) -> Dict:
    """Re-fetch a document's readable body and return cleaned paragraphs.

    Tries more than one URL when more than one exists (see
    reader.candidate_fetch_urls) -- canonical_url is sometimes a landing or
    citation page (an arXiv abstract page, most visibly) rather than the
    paper itself. This route doesn't cache what it fetches (by design), so
    it's fetched on demand every time. Failures (paywall, link-rot, block)
    are reported in the body rather than as an error status, so the UI can
    fall back to 'open the original in a new tab'. Shared by the curator
    route and the reader route (`/api/read/*`) — the payload carries no
    curation-internal field, so a reader may see exactly what a curator does
    here.
    """
    url = doc.attributes.get("canonical_url")
    oa_pdf_url = doc.attributes.get("oa_pdf_url")
    if not url and not oa_pdf_url:
        raise HTTPException(400, "document has no canonical_url")

    r = fetch_best_result(_reader, url, oa_pdf_url)
    if r is None:
        return {"url": url, "ok": False,
                "reason": "Couldn't fetch a readable version (blocked, paywalled, "
                          "or unavailable). Open the original instead.",
                "paragraphs": []}

    text = r.get("text") or ""
    paragraphs = split_paragraphs(text)

    # A fetch can now succeed and still carry no body -- a scanned PDF is pages of
    # images, and a blocked paper may have arrived as metadata alone. Those are
    # different sentences from "the fetch failed", and all of them differ from `ok`
    # with nothing in it: an empty reader with no explanation reads as a bug. Say
    # which it is, and let the UI offer the original.
    if not paragraphs:
        return {"url": url, "ok": False,
                "reason": NO_BODY_REASONS.get(
                    r.get("fetch_outcome"),
                    "Fetched the page but found no readable text. Open the "
                    "original instead."),
                "paragraphs": []}
    return {
        "url": url,
        "ok": True,
        "title": r.get("title") or doc.label,
        "fetch_outcome": r.get("fetch_outcome"),
        "paragraphs": paragraphs,
    }


def _readable_payload_cached(doc, ctx: Ctx) -> Dict:
    """Same shape as _readable_payload, but for the curator's own Document Viewer
    only -- checks the assistant's cached full_text first (assistant/text_writer.py)
    instead of always re-fetching live. Keeps a quote's paragraph number (see
    graph/links.py's node:<id>#p<N> links) pointing at the same paragraph it did
    when the assistant found it, rather than whatever the live page happens to be
    on a given day.

    Deliberately NOT used by the public reader route (read_readable, below) --
    full_text is private, curator/assistant-only data (see graph/types.py's
    DocumentAttrs and its exclusion from PUBLIC_NODE_ATTRS); a reader must keep
    getting the live, on-demand fetch it always has.
    """
    url = doc.attributes.get("canonical_url")
    fetch = fetch_and_cache_full_text(ctx.repo, _active_env, doc.id)
    if not fetch["ok"]:
        return {"url": url, "ok": False, "reason": fetch["reason"], "paragraphs": []}
    return {
        "url": url,
        "ok": True,
        "title": doc.label,
        "fetch_outcome": None,
        "paragraphs": split_paragraphs(fetch["text"]),
    }


@app.get("/api/documents/{doc_id}/readable")
def get_readable(doc_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """The document's cached readable text if there is one (fetching and caching it
    now if not) -- see _readable_payload_cached for why the curator's own viewer
    checks the cache first rather than always re-fetching live."""
    return _readable_payload_cached(_require_document(ctx, doc_id), ctx)


# --------------------------------------------------------------------------
# Mutations
# --------------------------------------------------------------------------

class SummaryIn(BaseModel):
    summary: str


class AbstractIn(BaseModel):
    abstract: str


class TitleIn(BaseModel):
    title: str


class ConceptsIn(BaseModel):
    concept_ids: List[UUID]


class MetadataIn(BaseModel):
    """Patch semantics, matching IngestionService.update_metadata: omit to leave
    unchanged, pass "" to clear. Unlike `title`, both of these are legitimately
    blankable -- plenty of documents have no venue and no date we can state."""
    publication: Optional[str] = None
    published_date: Optional[str] = None


class AuthorsIn(BaseModel):
    """The full credited set, people and organizations together in one list --
    `authored_by` runs document -> person|organization, so the split into two
    fields is a UI affordance and not two different relationships.

    `no_named_author` is the genuinely-anonymous marker: nobody named AND no
    organization publishing it. The service refuses it alongside any author.
    """
    author_ids: List[UUID]
    no_named_author: bool = False


class PersonIn(BaseModel):
    """A new person, plus the two edges the creation dialog can write in the same
    breath. `org_name` creates-or-finds the organization by name; `source_id` must
    already exist (sources are followed deliberately, not conjured from a text
    field on a person form)."""
    full_name: str
    orcid: Optional[str] = None
    org_name: Optional[str] = None
    source_id: Optional[UUID] = None


class OrganizationIn(BaseModel):
    """`source_id` records that this organization writes at that source -- the same
    `writes_at` edge a person gets, because the edge says "this entity writes at
    this location" and doesn't care which kind of entity."""
    name: str
    kind: str = "institution"
    source_id: Optional[UUID] = None


class PersonPatch(BaseModel):
    """Corrections to an existing person. Patch semantics: an omitted field is left
    alone, and "" clears an optional one. `affiliation_ids` / `source_ids` are SET
    semantics instead -- the whole list, like /concepts and /authors -- because a
    delta is exactly what a UI shouldn't have to compute."""
    full_name: Optional[str] = None
    orcid: Optional[str] = None
    homepage: Optional[str] = None
    affiliation_ids: Optional[List[UUID]] = None
    source_ids: Optional[List[UUID]] = None


class OrganizationPatch(BaseModel):
    """Corrections to an existing organization. An org has no affiliations of its
    own -- `member_of` runs person -> organization -- so only `source_ids`."""
    name: Optional[str] = None
    kind: Optional[str] = None
    homepage: Optional[str] = None
    source_ids: Optional[List[UUID]] = None


class RetypeIn(BaseModel):
    """The correction for an entity created as the wrong kind."""
    to_type: str        # "person" | "organization"


class LayoutIn(BaseModel):
    x: float
    y: float


class ConceptIn(BaseModel):
    """Patch semantics: an omitted field is left alone, matching
    OntologyService.update_concept. Note `None` and `""` differ here -- omit to
    leave unchanged, pass "" to clear. `label` renames the concept (repurposing it
    without a delete-and-recreate); it can't be blanked."""
    label: Optional[str] = None
    description: Optional[str] = None
    semantic_query: Optional[str] = None
    keywords: Optional[str] = None
    criteria: Optional[str] = None


class ConceptCreateIn(BaseModel):
    """A new concept. `parent_id` wires a `subtopic_of` edge to it, which is how
    the UI encodes 'created on the dividing line under that concept'; omit it for
    a new top-level concept.

    A concept is always born a leaf. Interposing a level -- adding a concept that
    gathers Cognitive security, agency, sovereignty and liberty beneath it -- is
    done by creating it and then dragging those concepts onto it, one drag each.
    An earlier version took an `adopt_ids` list so create-and-gather was a single
    action; it was removed because it had to guess what happened to each adopted
    concept's existing parents, and a drag says which edge is moving.
    """
    label: str
    parent_id: Optional[UUID] = None
    description: str = ""
    semantic_query: str = ""
    keywords: str = ""
    criteria: str = ""


class ReparentIn(BaseModel):
    """Move a concept between levels -- the drag in the ontology cards.

    Both ends are explicit and nullable, and `from_parent_id` is required rather
    than inferred: a poly-parented concept is drawn once under EACH parent, so the
    row the curator dragged names which edge they meant. Inferring it would pick
    for them, and pick wrong half the time. `None` means the top level on either
    side -- dragged off a root, or dropped onto one.
    """
    from_parent_id: Optional[UUID] = None
    to_parent_id: Optional[UUID] = None


def _concept_name_clash(ctx: Ctx, label: str, *, exclude: Optional[UUID] = None) -> bool:
    """A live concept already carries this label (case-insensitively)? Keeps the
    curator from forking a concept into two identically-named rows."""
    needle = label.strip().lower()
    for n in ctx.repo.find_nodes(type=NodeType.CONCEPT, limit=10000):
        if n.id != exclude and n.label.strip().lower() == needle:
            return True
    return False


@app.patch("/api/documents/{doc_id}/summary")
def patch_summary(doc_id: UUID, body: SummaryIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    _require_document(ctx, doc_id)
    n = ctx.ingest.update_summary(doc_id, body.summary, actor=ctx.actor)
    return document_json(ctx, n)


@app.patch("/api/documents/{doc_id}/title")
def patch_title(doc_id: UUID, body: TitleIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Correct a scraped title. Blank is refused rather than silently falling back
    to the URL: clearing a title is almost always a slip, and the curator's actual
    need here is fixing a bad scrape. See IngestionService.update_title."""
    _require_document(ctx, doc_id)
    if not body.title.strip():
        raise HTTPException(400, "title cannot be empty")
    n = ctx.ingest.update_title(doc_id, body.title, actor=ctx.actor)
    return document_json(ctx, n)


@app.patch("/api/documents/{doc_id}/abstract")
def patch_abstract(doc_id: UUID, body: AbstractIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Set the author's abstract by hand — for records the search APIs had none for,
    or that a bot blocker kept us from. See IngestionService.update_abstract."""
    _require_document(ctx, doc_id)
    n = ctx.ingest.update_abstract(doc_id, body.abstract, actor=ctx.actor)
    return document_json(ctx, n)


@app.patch("/api/documents/{doc_id}/metadata")
def patch_metadata(doc_id: UUID, body: MetadataIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Correct the scraped publication and date. Separate from the panel's Save for
    the same reason the title is: fixing bad metadata shouldn't drag a review
    decision along with it."""
    _require_document(ctx, doc_id)
    n = ctx.ingest.update_metadata(
        doc_id, publication=body.publication,
        published_date=body.published_date, actor=ctx.actor)
    return document_json(ctx, n)


@app.put("/api/documents/{doc_id}/authors")
def put_authors(doc_id: UUID, body: AuthorsIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Set the document's credited authors to exactly `author_ids` (people and/or
    organizations), reconciling adds and removes. Set semantics like
    /concepts: the curator hands over the whole set, never a delta."""
    _require_document(ctx, doc_id)
    for aid in body.author_ids:
        node = ctx.repo.get_node(aid)
        if node is None:
            raise HTTPException(404, f"author {aid} not found")
        if node.type not in (NodeType.PERSON.value, NodeType.ORGANIZATION.value):
            raise HTTPException(
                400, f"node {aid} is a {node.type}; only a person or an "
                     "organization can be credited as an author")
    try:
        ctx.people.set_authors(doc_id, body.author_ids,
                               no_named_author=body.no_named_author,
                               actor=ctx.actor)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return document_json(ctx, _require_document(ctx, doc_id))


@app.post("/api/people")
def create_person(body: PersonIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Find-or-create a person, optionally affiliating them and recording where
    they write -- the three writes the creation dialog makes as one action, so
    they share a txid and Undo reverses the whole thing rather than leaving a
    person stranded without the edges that were the point of creating them."""
    name = body.full_name.strip()
    if not name:
        raise HTTPException(400, "full_name is required")
    orcid = (body.orcid or "").strip() or None
    org_name = (body.org_name or "").strip() or None

    if body.source_id is not None:
        src = ctx.repo.get_node(body.source_id)
        if src is None:
            raise HTTPException(404, "source not found")
        if src.type != NodeType.SOURCE.value:
            raise HTTPException(400, f"node {body.source_id} is a {src.type}, not a source")

    with ctx.conn.transaction():
        person = ctx.people.upsert_person(name, orcid=orcid, actor=ctx.actor)
        # `upsert_person` may have FOUND an existing person rather than made one, in
        # which case the edges below may already exist -- and `edges_triple_uniq`
        # makes a repeat insert an error, not a no-op. Submitting the dialog twice
        # is a slip, not something to 500 on.
        if org_name:
            org = ctx.people.upsert_org(org_name, actor=ctx.actor)
            if not _has_edge(ctx, person.id, org.id, EdgeType.MEMBER_OF):
                ctx.people.set_affiliation(person.id, org.id, actor=ctx.actor)
        if body.source_id is not None:
            if not _has_edge(ctx, person.id, body.source_id, EdgeType.WRITES_AT):
                ctx.people.set_writes_at(person.id, body.source_id, actor=ctx.actor)
    return node_json(person)


@app.post("/api/organizations")
def create_organization(body: OrganizationIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Find-or-create an organization, deduped on exact name, optionally recording
    where it writes -- the same `writes_at` edge a person gets."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    if body.source_id is not None:
        src = ctx.repo.get_node(body.source_id)
        if src is None:
            raise HTTPException(404, "source not found")
        if src.type != NodeType.SOURCE.value:
            raise HTTPException(400, f"node {body.source_id} is a {src.type}, not a source")

    with ctx.conn.transaction():
        org = ctx.people.upsert_org(name, kind=body.kind, actor=ctx.actor)
        # Same idempotency trap as create_person: upsert may FIND, and a repeat
        # edge insert violates edges_triple_uniq rather than doing nothing.
        if body.source_id is not None and not _has_edge(
                ctx, org.id, body.source_id, EdgeType.WRITES_AT):
            ctx.people.set_writes_at(org.id, body.source_id, actor=ctx.actor)
    return node_json(org)


def _require_entity(ctx: Ctx, node_id: UUID) -> Node:
    node = ctx.repo.get_node(node_id)
    if node is None:
        raise HTTPException(404, "not found")
    if node.type not in (NodeType.PERSON.value, NodeType.ORGANIZATION.value):
        raise HTTPException(400, f"node {node_id} is a {node.type}, not a person "
                                 "or organization")
    return node


def entity_json(ctx: Ctx, node_id: UUID) -> Dict:
    """A person or organization with what the node card renders: where they work,
    where they write, and what they're credited on. All derived per read."""
    d = ctx.people.entity_detail(node_id)
    return {
        **node_json(d["node"]),
        "affiliations": [{"id": str(n.id), "label": n.label} for n in d["affiliations"]],
        "writes_at": [{"id": str(n.id), "label": n.label} for n in d["writes_at"]],
        "documents": [{"id": str(n.id), "label": n.label} for n in d["documents"]],
    }


@app.get("/api/entities")
def list_entities(ctx: Ctx = Depends(get_ctx)) -> List[Dict]:
    """Every person and organization, with what each is credited on.

    The Entities window's read model. `documents` is a count rather than a list --
    the window is for finding and correcting an entity, and the list is on the card
    you open. Counted from `authored_by` in one pass rather than per row, which
    would be a query per person.
    """
    credited: Dict[UUID, int] = {}
    for e in ctx.repo.find_edges(types=[EdgeType.AUTHORED_BY]):
        credited[e.target_id] = credited.get(e.target_id, 0) + 1

    out = []
    for kind in (NodeType.PERSON, NodeType.ORGANIZATION):
        for n in ctx.repo.find_nodes(type=kind, limit=10000):
            out.append({
                "id": str(n.id), "label": n.label, "type": n.type,
                "orcid": n.attributes.get("orcid"),
                "kind": n.attributes.get("kind"),
                "documents": credited.get(n.id, 0),
            })
    out.sort(key=lambda r: r["label"].lower())
    return out


@app.delete("/api/entities/{node_id}")
def delete_entity(node_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Remove a person or organization, and every edge that touched it.

    Soft, like every other delete here: the node and its edges keep their rows with
    `deleted_at` set, so Undo can bring back the credits along with the node. The
    cascade is not optional -- `find_edges` returns live edges regardless of whether
    their endpoints are alive, so deleting a node alone would hand the client an
    edge pointing at nothing.

    Deleting is for an entity that shouldn't exist. An entity of the wrong *kind*
    should be retyped instead, which keeps its credits; the window says so, because
    delete-then-recreate is the tempting wrong move and it silently drops them.
    """
    node = _require_entity(ctx, node_id)
    with ctx.conn.transaction():
        ctx.repo.delete_nodes_cascade([node_id], [], ctx.actor)
    return {"deleted": str(node_id), "label": node.label}


@app.get("/api/entities/{node_id}")
def get_entity(node_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    _require_entity(ctx, node_id)
    return entity_json(ctx, node_id)


@app.patch("/api/people/{person_id}")
def patch_person(person_id: UUID, body: PersonPatch,
                 ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Correct a person. Renaming is graph-wide by nature -- a person credited on
    eleven documents is one node -- which the UI says out loud, because from inside
    one document it would otherwise read as a local edit."""
    _require_entity(ctx, person_id)
    try:
        with ctx.conn.transaction():
            ctx.people.update_person(
                person_id, full_name=body.full_name, orcid=body.orcid,
                homepage=body.homepage, actor=ctx.actor)
            if body.affiliation_ids is not None:
                ctx.people.set_affiliations(person_id, body.affiliation_ids,
                                            actor=ctx.actor)
            if body.source_ids is not None:
                ctx.people.set_writes_at_sources(person_id, body.source_ids,
                                                 actor=ctx.actor)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return entity_json(ctx, person_id)


@app.patch("/api/organizations/{org_id}")
def patch_organization(org_id: UUID, body: OrganizationPatch,
                       ctx: Ctx = Depends(get_ctx)) -> Dict:
    _require_entity(ctx, org_id)
    try:
        with ctx.conn.transaction():
            ctx.people.update_org(org_id, name=body.name, kind=body.kind,
                                  homepage=body.homepage, actor=ctx.actor)
            if body.source_ids is not None:
                ctx.people.set_writes_at_sources(org_id, body.source_ids,
                                                 actor=ctx.actor)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return entity_json(ctx, org_id)


@app.post("/api/entities/{node_id}/retype")
def retype_entity(node_id: UUID, body: RetypeIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Turn a person into an organization or the reverse, in place.

    The node keeps its id, so every `authored_by` edge survives -- which is the
    whole point of correcting rather than deleting and recreating. Refused, with the
    offending edges named, when one of them would become illegal under the new type.
    """
    _require_entity(ctx, node_id)
    try:
        to_type = NodeType(body.to_type)
    except ValueError:
        raise HTTPException(400, f"unknown type {body.to_type!r}")
    try:
        with ctx.conn.transaction():
            ctx.people.retype_entity(node_id, to_type, actor=ctx.actor)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return entity_json(ctx, node_id)


@app.put("/api/documents/{doc_id}/concepts")
def put_concepts(doc_id: UUID, body: ConceptsIn,
                 ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Set the document's concept assignments to exactly `concept_ids` (adds and
    removes to reconcile), and mark it reviewed. Backs the single-Save UI.

    The caller no longer sends back the surviving concept proposals. Save consumes
    them all: the UI gates Save on an assigned concept, so anything still outstanding
    was passed over deliberately, and an approved document is not proposed to."""
    _require_document(ctx, doc_id)
    try:
        ctx.ingest.set_concepts(doc_id, body.concept_ids, actor=ctx.actor)
    except NodeNotFound as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return document_json(ctx, _require_document(ctx, doc_id))


class AddDocumentsIn(BaseModel):
    urls: List[str]


@app.post("/api/documents")
def add_documents(body: AddDocumentsIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Ingest URLs the curator pasted in by hand.

    The other end of the funnel from ⌕ Run search: discovery brings back what the
    concepts ask for, this takes what the curator already found in the wild. It
    lands in the same place on the same terms -- `pending`, uncategorized, nothing
    proposed -- because a document a human vouched for still hasn't been read.

    Three ways it differs from a discovery run, all following from "a paste is a
    deliberate act":

    * **A dismissed URL is restored, not refused** (`restore_dismissed=True`). See
      `IngestionBridge.ingest_urls`.
    * **Provenance is the manual source**, so every document can still answer where
      it came from with an edge. Which curator is `nodes.created_by`, as always.
    * **Nothing is proposed.** Discovery attaches the concepts whose search found a
      paper; nothing here knows why the curator wanted it.

    One transaction, so pasting five URLs is one undoable action -- the same grouping
    a search run gets. The per-bucket reply is what lets the paste box say *why*
    nothing appeared: a bot-blocked fetch and an already-known URL are indistinguish-
    able from a count alone.
    """
    # Only http(s). The manual source's own url is a urn, and `file://` would point
    # Reader at the server's disk -- neither is something a paste box should reach.
    urls, rejected = [], []
    for raw in body.urls:
        u = raw.strip()
        if not u:
            continue
        (urls if u.startswith(("http://", "https://")) else rejected).append(u)
    if not urls and not rejected:
        raise HTTPException(400, "no urls given")

    bridge = IngestionBridge(ctx.ingest, _reader)
    with ctx.conn.transaction():
        manual = ctx.sources.ensure_manual_source(actor=ctx.actor)
        report = bridge.ingest_urls(urls, submitted_by=ctx.actor,
                                    source_ids=[manual.id],
                                    restore_dismissed=True)

    # A restore lifts a tombstone, so the standing list of dismissals is now wrong.
    # Nothing else in a paste can change it -- an ordinary ingest never touches a
    # dismissed row -- so the rewrite is skipped when nothing came back.
    if report.restored:
        _refresh_dismissal_report(ctx)

    def rows(nodes: List[Node]) -> List[Dict]:
        return [{"id": str(n.id), "title": n.label,
                 "url": n.attributes.get("canonical_url")} for n in nodes]

    return {
        "added": rows(report.ingested),
        "restored": rows(report.restored),
        "duplicates": rows(report.duplicates),
        "failed": report.failed,
        "invalid": rejected,
    }


class AddManualDocumentIn(BaseModel):
    url: str
    title: str
    authors: Optional[List[str]] = None
    publication: Optional[str] = None
    date: Optional[str] = None
    abstract: Optional[str] = None
    full_text: Optional[str] = None


@app.post("/api/documents/manual")
def add_manual_document(body: AddManualDocumentIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """File one document with no fetch at all -- the fallback for `/api/documents`
    when our own fetch can't reach a page (blocked, no text layer, no DOI to fall
    back on) but the curator can still open it themselves. See
    `IngestionBridge.ingest_manual`.

    Same http(s)-only rule as the paste box, and title is required here because
    there's no scraper to have found one. `full_text` is optional -- a curator who
    only has a title and a link can still get the document into the queue, same as
    a normal paste.
    """
    url = body.url.strip()
    title = body.title.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must be http(s)")
    if not title:
        raise HTTPException(400, "title is required")

    bridge = IngestionBridge(ctx.ingest, _reader)
    with ctx.conn.transaction():
        manual = ctx.sources.ensure_manual_source(actor=ctx.actor)
        report = bridge.ingest_manual(
            url=url, title=title, authors=body.authors,
            publication=body.publication, date=body.date,
            abstract=body.abstract, full_text=body.full_text,
            submitted_by=ctx.actor, source_ids=[manual.id])

    if report.restored:
        _refresh_dismissal_report(ctx)

    def rows(nodes: List[Node]) -> List[Dict]:
        return [{"id": str(n.id), "title": n.label,
                 "url": n.attributes.get("canonical_url")} for n in nodes]

    return {
        "added": rows(report.ingested),
        "restored": rows(report.restored),
        "duplicates": rows(report.duplicates),
        "failed": report.failed,
        "invalid": [],
    }


class DismissIn(BaseModel):
    """Why this document is being dismissed, in the curator's words.

    Optional, and optional on purpose: the reason is whatever was in the Summary box
    when Delete was pressed, so a curator who typed nothing still gets a dismissal.
    """
    note: Optional[str] = None


def _refresh_dismissal_report(ctx: Ctx) -> None:
    """Rewrite this environment's dismissal report from the database.

    Called AFTER the write commits and deliberately swallowing its errors: the
    dismissal is the real outcome and it has already happened, so a read-only disk or
    a missing directory must not turn a successful delete into a 500 the curator
    would (reasonably) read as "it didn't work". The report is regenerated on every
    dismissal and restore, so a skipped write self-heals on the next one.
    """
    try:
        write_dismissal_report(ctx.repo, _active_env)
    except OSError:
        pass


def _refresh_queue_report(ctx: Ctx) -> None:
    """Rewrite this environment's queue report from the database.

    Same contract as `_refresh_dismissal_report` above, for the same reason: the
    search has already happened and its documents are already filed, so a read-only
    disk must not turn a successful run into a 500. The citation lookup swallows its
    own network failures (`citations()` in queue_structure), so a report written with
    OpenAlex unreachable is a report with an empty citations section -- not an error
    and not a lost run.

    The semantic section follows the same rule twice over: `default_embedder` returns
    None when the model isn't installed, and `groups()` catches a model that won't
    load. Either way the run keeps its other two sections. It is worth the seconds
    here because a search run is the one thing that changes the queue wholesale --
    which makes it the moment new groups are worth computing -- and because the vector
    cache means only the documents the run just added are ever encoded.
    """
    try:
        write_queue_report(ctx.repo, _active_env, lookup=default_lookup(),
                           embed=default_embedder())
    except OSError:
        pass


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: UUID, body: Optional[DismissIn] = None,
                    ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Dismiss a document: mark it dismissed, then soft-delete it and its incident
    edges -- all in one transaction so it's a single undoable action, and so undo
    lifts the dismissal along with the delete. The dismissal tombstones the URL, so
    discovery won't offer the same paper back on the next run.

    `note` records why, and is the only trace a rejected document leaves that a
    person can read -- see dismissal_report, regenerated here."""
    _require_document(ctx, doc_id)
    with ctx.conn.transaction():
        n = ctx.ingest.delete_document(
            doc_id, note=body.note if body else None, actor=ctx.actor)
    _refresh_dismissal_report(ctx)
    return {"deleted": {"id": str(n.id), "label": n.label}}


@app.post("/api/concepts")
def create_concept(body: ConceptCreateIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Create a concept, optionally as a subtopic of `parent_id`. Rejects a blank
    or duplicate label so the ontology can't grow two concepts with one name."""
    label = body.label.strip()
    if not label:
        raise HTTPException(400, "label is required")
    if _concept_name_clash(ctx, label):
        raise HTTPException(409, f"a concept named {label!r} already exists")
    if body.parent_id is not None:
        _require_concept(ctx, body.parent_id)  # 404/400 before anything is created

    # One transaction so the create and its parent edge share a txid and undo as a
    # single unit -- created-under-X is one action to the curator, one Undo to
    # reverse.
    with ctx.conn.transaction():
        node = ctx.ontology.create_concept(
            label, description=body.description, semantic_query=body.semantic_query,
            keywords=body.keywords, criteria=body.criteria, actor=ctx.actor)
        if body.parent_id is not None:
            # A brand-new concept has no children, so this subtopic_of can't close a
            # cycle; check_edge inside relate() still runs.
            ctx.ontology.relate(node.id, body.parent_id, EdgeType.SUBTOPIC_OF, actor=ctx.actor)
    return node_json(node)


@app.post("/api/concepts/{concept_id}/reparent")
def reparent_concept(concept_id: UUID, body: ReparentIn,
                     ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Move a concept between levels -- one drag in the ontology cards.

    A cycle (dropping a concept onto its own descendant) raises
    GraphIntegrityError, which subclasses ValueError and so surfaces as a 400. The
    UI refuses those drops before they are made; this is the backstop for anything
    that reaches the endpoint another way.
    """
    _require_concept(ctx, concept_id)
    for pid in (body.from_parent_id, body.to_parent_id):
        if pid is not None:
            _require_concept(ctx, pid)
    with ctx.conn.transaction():
        ctx.ontology.reparent(concept_id, from_parent_id=body.from_parent_id,
                              to_parent_id=body.to_parent_id, actor=ctx.actor)
    return node_json(ctx.repo.get_node(concept_id))


@app.patch("/api/concepts/{concept_id}")
def patch_concept(concept_id: UUID, body: ConceptIn,
                  ctx: Ctx = Depends(get_ctx)) -> Dict:
    """The curator's concept text (description / semantic query / keywords /
    criteria) and/or its label. Only the fields the body carries are touched."""
    _require_concept(ctx, concept_id)
    if body.label is not None:
        new_label = body.label.strip()
        if not new_label:
            raise HTTPException(400, "label cannot be empty")
        if _concept_name_clash(ctx, new_label, exclude=concept_id):
            raise HTTPException(409, f"a concept named {new_label!r} already exists")

    n = None
    # One transaction so a single Save that touches both the name and the text is
    # one action, and one Undo.
    with ctx.conn.transaction():
        if body.label is not None:
            n = ctx.ontology.rename_concept(concept_id, body.label.strip(), actor=ctx.actor)
        if (body.description is not None or body.semantic_query is not None
                or body.keywords is not None or body.criteria is not None):
            n = ctx.ontology.update_concept(concept_id, description=body.description,
                                            semantic_query=body.semantic_query,
                                            keywords=body.keywords,
                                            criteria=body.criteria, actor=ctx.actor)
    if n is None:
        n = ctx.repo.get_node(concept_id)   # nothing to change; echo current state
    return node_json(n)


@app.get("/api/concepts/{concept_id}/deletion")
def preview_concept_deletion(concept_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """What deleting this concept would take with it -- the confirm dialog's data.
    Reads only."""
    _require_concept(ctx, concept_id)
    p = ctx.ontology.preview_deletion(concept_id)
    return {
        "target": {"id": str(p["target"].id), "label": p["target"].label},
        "also_deleted": [{"id": str(n.id), "label": n.label} for n in p["also_deleted"]],
        "documents_requeued": p["documents_requeued"],
    }


@app.delete("/api/concepts/{concept_id}")
def delete_concept(concept_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Delete a concept: cascade to the descendants it orphans, and send any
    now-uncategorized documents back to the review queue."""
    _require_concept(ctx, concept_id)
    res = ctx.ontology.delete_concept(concept_id, actor=ctx.actor)
    return {
        "deleted": [{"id": str(n.id), "label": n.label} for n in res["deleted"]],
        "documents_requeued": len(res["requeued"]),
    }


class DocumentsIn(BaseModel):
    document_ids: List[UUID]


@app.post("/api/concepts/{concept_id}/documents")
def label_documents(concept_id: UUID, body: DocumentsIn,
                    ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Attach this concept to a batch of documents at once -- the drop target for
    dragging a multi-selected set from the queue onto an open concept. Each
    document is categorized (an `about` edge) and marked reviewed, in one
    transaction so the whole drop is one action (and one Undo)."""
    _require_concept(ctx, concept_id)
    labeled = 0
    with ctx.conn.transaction():
        for doc_id in body.document_ids:
            _require_document(ctx, doc_id)
            ctx.ingest.categorize(doc_id, [concept_id], actor=ctx.actor)
            labeled += 1
    return {"labeled": labeled}


# --------------------------------------------------------------------------
# Artifacts: the curator's own prose about the curation. One node or several
# (`remarks_on`), documents cited inline in the body (`cites`, derived).
# --------------------------------------------------------------------------

class RemarkIn(BaseModel):
    """Every field optional on update; None means "leave alone".

    That is what separates clearing the subjects (`[]`) from not touching them
    (`None`) -- a distinction the editor needs, since saving a body edit must not
    silently wipe what the remark is about. `visibility` rides the same rule, so the
    publish toggle is just a PUT that sets it and leaves the prose alone.
    """
    label: Optional[str] = None
    body: Optional[str] = None
    subject_ids: Optional[List[UUID]] = None
    visibility: Optional[str] = None   # public | private
    # concept node id -> `#rrggbb` (or a `[start, end]` pair), the colours of this
    # remark's shapes in the reader's drawing. Whole-map semantics, like
    # `subject_ids`: what is sent is what the remark ends up with, so removing a
    # colour is sending the map without it. Malformed hex is a 400 -- see
    # ArtifactAttrs.paint / PaintColor.
    paint: Optional[Dict[str, PaintColor]] = None
    # This remark's assignment onto a quilt pattern -- see ArtifactAttrs.quilt /
    # Quilt. Whole-value semantics like `paint`: sending a quilt replaces it outright.
    quilt: Optional[Quilt] = None


def artifact_json(ctx: Ctx, n: Node) -> Dict:
    """A remark plus what it points at.

    `subjects` is an edge read and is the curator's to set. `links` is not: it is
    resolved from the ids IN THE BODY, which is why it carries each target's `type`.
    That type is what lets the editor's References block show the documents (the set
    that becomes `cites`) without reddening a link to a concept -- the block cannot
    ask the graph itself, and a link's text no longer says what kind of thing it
    points at (see graph/links.py).

    `dangling` names the links that resolve to no live node at all, because a broken
    link has nothing to appear in `links` and would otherwise vanish from the editor
    entirely -- looking, wrongly, like it had never been written.
    """
    body = n.attributes.get("body", "")
    return {
        "id": str(n.id),
        "label": n.label,
        "kind": n.attributes.get("kind", "note"),
        "body": body,
        "subjects": [{"id": str(s.id), "type": s.type, "label": s.label}
                     for s in ctx.artifacts.subjects_of(n.id)],
        "links": [{"id": str(t.id), "type": t.type, "label": t.label}
                  for t in ctx.artifacts.links_in(body)],
        "dangling": ctx.artifacts.dangling_links(body),
        # Who wrote it. One curator today; the field is here because `created_by` is
        # real on every node and the window shows it, so the seam is visible now.
        "created_by": ctx.repo.user_handle(n.created_by),
        # public | private -- the reader/curator boundary. Private until published.
        "visibility": n.attributes.get("visibility", "private"),
        # concept node id -> colour, for the reader's drawing. Pruned to the subjects
        # on every save, so what is here is always a live shape.
        "paint": n.attributes.get("paint", {}),
        # This remark's slot assignment on a quilt pattern, or None until a curator
        # sets one -- see ArtifactAttrs.quilt.
        "quilt": n.attributes.get("quilt"),
        "created_at": n.created_at.isoformat(),
        "updated_at": n.updated_at.isoformat(),
    }


def _require_artifact(ctx: Ctx, artifact_id: UUID) -> Node:
    n = ctx.repo.get_node(artifact_id)
    if n is None:
        raise HTTPException(404, "artifact not found")
    if n.type != NodeType.ARTIFACT.value:
        raise HTTPException(400, f"not an artifact: {n.type}")
    return n


@app.get("/api/artifacts")
def list_artifacts(ctx: Ctx = Depends(get_ctx)) -> List[Dict]:
    """Every remark. The guide scope is excluded -- it has its own endpoint because
    it is prose about the guide, not about anything in it."""
    return [artifact_json(ctx, n) for n in ctx.artifacts.list_remarks()]


@app.get("/api/artifacts/{artifact_id}")
def get_artifact(artifact_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    return artifact_json(ctx, _require_artifact(ctx, artifact_id))


def _check_visibility(v: Optional[str]) -> None:
    if v is not None and v not in ("public", "private"):
        raise HTTPException(400, "visibility must be public or private")


@app.post("/api/artifacts")
def create_artifact(body: RemarkIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    if not (body.label or "").strip():
        raise HTTPException(400, "a remark needs a title")
    _check_visibility(body.visibility)
    n = ctx.artifacts.create_remark(
        body.label.strip(), body.body or "", body.subject_ids or [],
        visibility=body.visibility or "private", paint=body.paint,
        quilt=body.quilt, actor=ctx.actor)
    return artifact_json(ctx, n)


@app.put("/api/artifacts/{artifact_id}")
def update_artifact(artifact_id: UUID, body: RemarkIn,
                    ctx: Ctx = Depends(get_ctx)) -> Dict:
    _require_artifact(ctx, artifact_id)
    if body.label is not None and not body.label.strip():
        raise HTTPException(400, "a remark needs a title")
    _check_visibility(body.visibility)
    n = ctx.artifacts.update_remark(
        artifact_id,
        label=body.label.strip() if body.label is not None else None,
        body=body.body, subject_ids=body.subject_ids,
        visibility=body.visibility, paint=body.paint,
        quilt=body.quilt, actor=ctx.actor)
    return artifact_json(ctx, n)


@app.delete("/api/artifacts/{artifact_id}")
def delete_artifact(artifact_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    _require_artifact(ctx, artifact_id)
    n = ctx.artifacts.delete_remark(artifact_id, actor=ctx.actor)
    return {"deleted": str(n.id), "label": n.label}


@app.get("/api/artifacts/for/{node_id}")
def artifacts_for_node(node_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """What the curator has written about this node, and what cites it.

    Two lists, not one, because they answer different questions: `remarks` is prose
    ABOUT this node, `cited_by` is prose that leans on it. A document can easily be
    in the second and not the first.
    """
    return {
        "remarks": [artifact_json(ctx, n) for n in ctx.artifacts.remarks_on(node_id)],
        "cited_by": [{"id": str(n.id), "label": n.label}
                     for n in ctx.artifacts.remarks_citing(node_id)],
    }




class ScopeIn(BaseModel):
    body: str


@app.get("/api/scope")
def get_scope(ctx: Ctx = Depends(get_ctx)) -> Dict:
    """The guide's scope statement — a curator-authored Artifact.

    Prepended to every discovery screening call, so it decides as much as the concept
    descriptions do. `is_default` says whether the curator has actually written one:
    until they have, screening runs on the built-in fallback, and the editor should
    say so rather than presenting borrowed words as the curator's own.
    """
    node = ctx.artifacts.get_guide_scope()
    return {
        "body": node.attributes.get("body", "") if node else DEFAULT_GUIDE_SCOPE,
        "is_default": node is None,
        "updated_at": node.updated_at.isoformat() if node else None,
    }


@app.put("/api/scope")
def put_scope(body: ScopeIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Write the scope statement, creating the Artifact on first save. Blank is
    refused — an empty scope silently widens the filter to everything."""
    if not body.body.strip():
        raise HTTPException(400, "scope cannot be empty")
    n = ctx.artifacts.set_guide_scope(body.body.strip(), actor=ctx.actor)
    return {"body": n.attributes.get("body", ""), "is_default": False,
            "updated_at": n.updated_at.isoformat()}


class ScoutRunIn(BaseModel):
    """Which concepts to search. Omitted/None = all of them, plus every feed."""
    concept_ids: Optional[List[UUID]] = None


@app.post("/api/scout/run")
def run_scout(body: Optional[ScoutRunIn] = None, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Search every concept, poll every followed source, and file the survivors.

    The ontology *is* the search config: each concept's `semantic_query` drives
    OpenAlex semantic search and its `keywords` drive arXiv (its `description` is
    the reader's definition and is not a query). Followed sources join
    the same run as a third adapter that takes no query at all (see discovery.py),
    so their posts pass the same dedup, tombstones and scope gate.

    Synchronous, which is honest at curator scale but not free -- it's N concepts x
    2 APIs plus every feed plus the LLM filter, so it can take a while; the UI
    disables the button and says so. Nothing is auto-categorized: everything lands
    as `pending`, which keeps the human-decides ethos intact.

    Missing keys degrade rather than fail: no OPENALEX_API_KEY means arXiv-only,
    no ANTHROPIC_API_KEY means unfiltered. The response reports which ran.

    `concept_ids` narrows the run (the header dropdown's checkboxes); omit for all.

    Narrowing does **not** stop the feeds. Unchecking a concept is one instruction
    -- "not this topic, right now" -- honoured two ways: the concept's query isn't
    run, and feed posts about it are dropped by the relevance filter. A feed can't
    be narrowed by not-running it (one fetch brings back every topic the writer
    covers), and skipping feeds entirely would lose the sources the curator followed
    on purpose. Whether a source runs at all is its own durable `enabled` flag, set
    in the Sources window -- never inferred from a concept selection.
    """
    from discovery import DiscoveryService

    service = DiscoveryService(
        ctx.repo,
        openalex_key=os.getenv("OPENALEX_API_KEY"),
        anthropic_key=os.getenv("ANTHROPIC_API_KEY"),
        scraper=_reader,
    )
    concept_ids = body.concept_ids if body else None
    # Seed arXiv/OpenAlex as `source` nodes before the run reads them: provenance is
    # resolved by label against what exists, so an unseeded builtin would silently
    # cost every API-found document its `sourced_from` edge.
    with ctx.conn.transaction():
        service.ensure_sources(actor=ctx.actor)

    # Network I/O first, outside the transaction: this is slow, and holding a
    # transaction open across it would pin a connection for no reason.
    candidates, meta = service.discover(concept_ids)

    bridge = IngestionBridge(ctx.ingest, _reader)
    # One transaction so the whole run is a single undoable action -- "Run search"
    # is one act to the curator, so one Undo takes all of it back.
    with ctx.conn.transaction():
        report = bridge.ingest_candidates(candidates, submitted_by=ctx.actor)

    # A search run is the only thing that changes the queue wholesale, which makes it
    # the moment the old report stops being true. Regenerated here rather than left
    # for someone to remember, exactly as the dismissal report is regenerated from
    # the delete endpoint.
    #
    # Only when something actually landed: a run that found nothing leaves the queue
    # as it was, so the file on disk is still correct and re-fetching every citation
    # count to rewrite it identically would be work for nothing.
    if report.ingested:
        _refresh_queue_report(ctx)

    return {
        "ingested": len(report.ingested),
        "duplicates": len(report.duplicates),
        "suppressed": len(report.suppressed),
        **meta,
    }


# --------------------------------------------------------------------------
# Sources: where documents come from. Followed feeds plus the search APIs.
# --------------------------------------------------------------------------

def _source_row(ctx: "Ctx", node: Node, health) -> Dict:
    """One source as the Sources window wants it: what it is, how it's doing.

    `stats` is derived from `sourced_from` edges on every call rather than stored
    (see SourceService.stats) -- so it can't drift out of step with a curator who
    re-categorises or un-dismisses a document.
    """
    a = node.attributes
    return {
        "id": str(node.id),
        "label": node.label,
        "url": a.get("url"),
        "homepage": a.get("homepage"),
        "mechanism": a.get("mechanism"),
        "enabled": a.get("enabled", True),
        "notes": a.get("notes", ""),
        # Not every source is fetchable. The search APIs are queried rather than
        # polled, and the manual bucket isn't fetched at all -- neither has health or
        # anything to "run now". Sent as the positive capability rather than as
        # `builtin`, which named one reason for it and then had to cover two.
        "pollable": a.get("mechanism", "rss") in SourceService.POLLABLE,
        "health": health.as_dict(),
        "stats": ctx.sources.stats(node.id),
    }


@app.get("/api/sources")
def list_sources(ctx: Ctx = Depends(get_ctx)) -> List[Dict]:
    """Every source, followed feeds and search APIs alike."""
    with ctx.conn.transaction():
        ctx.sources.ensure_builtins(actor=ctx.actor)
    health = ctx.health.all()
    rows = [_source_row(ctx, n, health.get(n.id, Health()))
            for n in ctx.sources.list_sources()]
    # Feeds first, then the search APIs, then the manual bucket: the followed
    # sources are what a curator came here to manage, and the other two are context
    # that can't be edited anyway.
    rank = {"manual": 2}
    rows.sort(key=lambda r: (0 if r["pollable"] else rank.get(r["mechanism"], 1),
                             r["label"].lower()))
    return rows


class SourceIn(BaseModel):
    label: str
    url: str
    homepage: Optional[str] = None
    notes: str = ""
    # "rss" or "page". The caller previews first, so it already knows which; a
    # missing value re-resolves rather than assuming.
    mechanism: Optional[str] = None


@app.get("/api/sources/preview")
def preview_source(url: str) -> Dict:
    """Resolve whatever was pasted into a feed, and show what's in it.

    Two failures this exists to prevent, both of which otherwise surface far too
    late. First, a url that was never a feed follows *successfully* and then sits in
    the list looking quiet forever -- indistinguishable from a source that simply
    isn't publishing. Second, and more common: people paste the thing they were
    reading (a post, or the front page), not the feed, because that distinction is
    ours and not theirs. `discover_feed_url` resolves it from the page's own
    advertised feed, so the curator never has to know the difference.

    `requested` and `url` differ whenever that resolution did something -- the
    caller should show both, since the curator is about to follow a url they didn't
    type and should be able to see and correct it.
    """
    from scout import FeedAdapter, PageAdapter, SearchFailed, discover_feed_url

    # A feed if there is one -- it hands over titles, dates and summaries as
    # structured data, which no amount of page reading recovers.
    try:
        resolved = discover_feed_url(url)
        found = FeedAdapter().search(resolved)
        return {
            "requested": url, "url": resolved, "mechanism": "rss",
            "count": len(found),
            "publication": found[0].publication if found else None,
            "titles": [c.title for c in found[:5]],
        }
    except SearchFailed as feed_error:
        pass

    # No feed: read the page as an index of published writing. The model separates
    # articles from navigation, and those judgements are memoised per link once the
    # source is followed, so this classification cost is paid once.
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key:
        raise HTTPException(400, f"{feed_error} (and no ANTHROPIC_API_KEY, so the "
                                 f"page can't be read as an index instead)")
    from relevance_filter import LinkClassifier
    adapter = PageAdapter(classify=LinkClassifier(key).classify)
    try:
        found = adapter.search(url)
    except SearchFailed as e:
        raise HTTPException(400, str(e))
    if not found:
        raise HTTPException(400, f"no feed at {url}, and none of the "
                                 f"{len(adapter.new_verdicts)} links on the page "
                                 f"look like published writing")
    return {
        "requested": url, "url": url, "mechanism": "page",
        "count": len(found), "publication": None,
        "titles": [c.title[:90] for c in found[:5]],
    }


@app.post("/api/sources")
def follow_source(body: SourceIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Follow a feed. Idempotent on url, like submitting a document.

    Deliberately does NOT re-enable a source that was turned off: re-adding
    something you rejected should be a decision you make in the list, not a side
    effect of pasting the url again.
    """
    from scout import SearchFailed, discover_feed_url

    if body.mechanism == "page":
        # Taken at the caller's word: preview already read the page and showed what
        # it found. Re-classifying here would spend a second model call to learn
        # what the curator just looked at.
        url, mechanism = body.url, "page"
    else:
        try:
            # Resolve again rather than trusting the caller: this endpoint is
            # reachable without going through preview, and a post url stored as a
            # source is the silent failure the whole check exists to prevent.
            url, mechanism = discover_feed_url(body.url), "rss"
        except SearchFailed as e:
            raise HTTPException(400, str(e))

    with ctx.conn.transaction():
        node = ctx.sources.upsert_source(
            body.label, url, mechanism=mechanism,
            homepage=body.homepage or body.url,
            notes=body.notes, actor=ctx.actor)
    return _source_row(ctx, node, ctx.health.get(node.id))


class EnabledIn(BaseModel):
    enabled: bool


@app.post("/api/sources/{source_id}/enabled")
def set_source_enabled(source_id: UUID, body: EnabledIn,
                       ctx: Ctx = Depends(get_ctx)) -> Dict:
    """The durable judgement: is this a source for this guide at all.

    Distinct from the per-run concept picker, which never persists. A source has
    exactly one on/off state and this is it -- nothing infers it from a search.
    """
    with ctx.conn.transaction():
        node = ctx.sources.set_enabled(source_id, body.enabled, actor=ctx.actor)
    return _source_row(ctx, node, ctx.health.get(node.id))


@app.post("/api/sources/{source_id}/reread")
def reread_source(source_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Forget what we learned about this source, so the next poll starts fresh.

    The escape hatch behind two deliberate decisions. Screening verdicts are
    remembered so a source doesn't pay to re-decide the same rejects every poll --
    which also means **editing the guide scope doesn't retroactively re-screen
    them**. And a page source's link classifications are memoised, so a real article
    misfiled as navigation would otherwise stay invisible for good.

    Both are the right default and both need a way back; this is it. It does NOT
    touch documents or tombstones: a document already in the guide stays, and a
    paper the curator dismissed stays dismissed. Only the machine's own bookkeeping
    is cleared.
    """
    node = ctx.repo.get_node(source_id)
    if node is None or node.type != NodeType.SOURCE:
        raise HTTPException(404, "no such source")

    forgotten = ScreenedUrls(ctx.conn).forget_source(source_id)
    PageLinkMemo(ctx.conn).forget(source_id)
    return {"source": node.label, "forgotten_screenings": forgotten}


@app.post("/api/sources/{source_id}/run")
def run_source(source_id: UUID, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Poll one source now and file what survives.

    For the moment right after following something: "what does this actually
    bring?" Deliberately runs **no concept queries and applies no concept
    exclusions** -- it's a test of the source, so it should show what the source
    offers, not what the current picker selection would let through. Everything else
    (scope screen, dedup, tombstones, one undoable action) is the normal path.
    """
    from discovery import DiscoveryService

    node = ctx.repo.get_node(source_id)
    if node is None or node.type != NodeType.SOURCE:
        raise HTTPException(404, "no such source")
    mechanism = node.attributes.get("mechanism", "rss")
    if mechanism not in SourceService.POLLABLE:
        detail = (f"{node.label} is queried, not polled — "
                  "run it from the header's Run search") if mechanism == "api" else \
                 f"{node.label} isn't a source that can be polled"
        raise HTTPException(400, detail)

    service = DiscoveryService(
        ctx.repo,
        openalex_key=os.getenv("OPENALEX_API_KEY"),
        anthropic_key=os.getenv("ANTHROPIC_API_KEY"),
        scraper=_reader,
    )
    with ctx.conn.transaction():
        service.ensure_sources(actor=ctx.actor)
    # concept_ids=[] -> no queries run, and (see discover) nothing is excluded.
    candidates, meta = service.discover(concept_ids=[], source_ids=[source_id])

    bridge = IngestionBridge(ctx.ingest, _reader)
    with ctx.conn.transaction():
        report = bridge.ingest_candidates(candidates, submitted_by=ctx.actor)

    return {
        "ingested": len(report.ingested),
        "duplicates": len(report.duplicates),
        "suppressed": len(report.suppressed),
        **meta,
    }


@app.get("/api/undo")
def get_undo(ctx: Ctx = Depends(get_ctx)) -> Dict:
    """What the next undo would reverse (or available=false). Backs the header
    button's enabled state and tooltip."""
    u = ctx.repo.undoable()
    return {"available": u is not None, "description": u["description"] if u else None}


@app.post("/api/undo")
def post_undo(ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Reverse the most recent action. No-op (undone=false) when nothing is left."""
    res = ctx.repo.undo_last(ctx.actor)
    # Undo is generic -- it reverses rows, and can't say whether those rows were a
    # dismissal. So the report is regenerated after any undo rather than only after
    # the ones that matter; it's derived from the database, so rewriting it when
    # nothing changed produces the identical file.
    if res is not None:
        _refresh_dismissal_report(ctx)
    return {"undone": res is not None,
            "description": res["description"] if res else None}


@app.patch("/api/concepts/{concept_id}/layout")
def patch_layout(concept_id: UUID, body: LayoutIn,
                 ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Persist a dragged concept box's position (pinned)."""
    try:
        n = ctx.ontology.set_layout(concept_id, body.x, body.y, pinned=True,
                                    actor=ctx.actor)
    except NodeNotFound as e:
        raise HTTPException(404, str(e))
    return node_json(n)


# --------------------------------------------------------------------------
# Curation assistant: a chat that can only read the graph, never change it.
# See writeups/design/CURATION_ASSISTANT_DESIGN.md for how the pieces behind
# these endpoints fit together, and conversation_store.py for how a thread is
# kept on disk between messages.
# --------------------------------------------------------------------------

class AssistantMessageIn(BaseModel):
    message: str
    open_document_title: Optional[str] = None
    open_document_in_queue: Optional[bool] = None  # True = queue, False = approved
    open_concept_name: Optional[str] = None
    open_document_id: Optional[UUID] = None
    open_concept_id: Optional[UUID] = None


def _thread_json(thread: conversation_store.ConversationThread) -> Dict:
    return {
        "history": thread.history,
        "started_at": thread.started_at.isoformat(),
        "updated_at": thread.updated_at.isoformat(),
    }


@app.get("/api/assistant/conversation")
def get_assistant_conversation() -> Dict:
    """The curator's ongoing thread for whichever environment is active right
    now -- an empty thread if they haven't sent a first message yet. Used to
    restore the chat box's history after a page refresh."""
    thread = conversation_store.current_thread(_active_env)
    if thread is None:
        return {"history": [], "started_at": None, "updated_at": None}
    return _thread_json(thread)


@app.post("/api/assistant/message")
def post_assistant_message(body: AssistantMessageIn, ctx: Ctx = Depends(get_ctx)) -> Dict:
    """Send one message to the curation assistant and get its reply.

    Loads the ongoing thread for the active environment (starting a new one
    if this is the very first message), asks Claude for a reply, and saves
    the updated thread back to disk before returning it.
    """
    key = anthropic_api_key()
    if not key:
        raise HTTPException(400, "ANTHROPIC_API_KEY isn't set, so the assistant can't run.")

    thread = (conversation_store.current_thread(_active_env)
              or conversation_store.start_new_thread(_active_env))

    reader = GraphReader(ctx.repo, _active_env)
    convo = Conversation(reader, key)
    open_context = OpenContext(
        document_title=body.open_document_title,
        document_in_queue=body.open_document_in_queue,
        concept_name=body.open_concept_name,
    )
    previous_scope = ScopeDecision(**thread.last_scope) if thread.last_scope else None
    try:
        reply = convo.respond(
            body.message,
            history=thread.history,
            open_context=open_context,
            open_document_id=body.open_document_id,
            open_concept_id=body.open_concept_id,
            previous_scope=previous_scope,
        )
    except ConversationError as exc:
        raise HTTPException(400, str(exc))

    thread.history = reply.history
    # Not overwritten on a "clarify" -- that reply resolved nothing, so
    # whatever slice answered the message before it is still the one worth
    # reusing if the curator's next message is a follow-up.
    if reply.scope.kind != "clarify":
        thread.last_scope = asdict(reply.scope)
    conversation_store.save_thread(thread)
    return {"reply": reply.text, "history": thread.history}


@app.post("/api/assistant/new-thread")
def post_assistant_new_thread() -> Dict:
    """The curator's "start fresh" command: leave the current thread's file
    exactly as it is, and start a new, empty one for the active
    environment."""
    thread = conversation_store.start_new_thread(_active_env)
    return _thread_json(thread)


# --------------------------------------------------------------------------
# Serve the built UI in prod, if it exists. In dev the Vite server owns the
# frontend and proxies /api here, so this mount is simply absent.
# --------------------------------------------------------------------------

_DIST = Path(__file__).with_name("ui") / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="ui")
