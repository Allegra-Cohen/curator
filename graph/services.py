"""Domain services: the curator's verbs, composed from GraphRepository primitives.

Four services, split along the future permission boundary:

  * OntologyService   -- concepts + their structural relationships (curators only)
  * IngestionService  -- the submit -> review -> categorize pipeline (submitters + curators)
  * PeopleService     -- researchers, organizations, affiliations, funding
  * GraphQueryService -- read-models the viewer and curator UIs consume

None of these touches SQL directly; that all lives in GraphRepository. Every
mutation takes an Actor, which is where authorization will eventually hang.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence
from urllib.parse import urlparse
from uuid import UUID

from .links import linked_node_ids, parse_links
from .integrity import GraphIntegrity
from .models import Actor, Edge, Graph, Node
from .repository import GraphRepository, NodeNotFound
from .types import (
    EDGE_TYPES,
    EdgeType,
    NodeType,
    ONTOLOGY_EDGE_TYPES,
    PaintColor,
    Quilt,
    normalize_orcid,
)


@dataclass
class MergeResult:
    """Outcome of merging two concepts. The structural merge is done; `reconcile`
    hands both concepts' text back so the curator can resolve it in a follow-up
    update_concept call (we never guess how to combine descriptions/criteria)."""
    survivor: Node
    reconcile: Dict[str, Dict[str, str]]   # {"keep": {...}, "merged": {...}}
    dropped_edges: int


def _require_type(node: Optional[Node], expected: NodeType, what: str) -> Node:
    if node is None:
        raise NodeNotFound(f"{what} not found")
    if node.type != expected.value:
        raise ValueError(f"{what} must be a {expected.value}, got {node.type}")
    return node


def _reconcile_links(repo: GraphRepository, node_id: UUID, targets: Sequence[UUID],
                     edge_type: EdgeType, *, actor: Actor) -> List[Edge]:
    """Reconcile this node's outgoing edges of one type to exactly `targets`.

    Set semantics, not a delta: the caller hands over what they want, so no UI ever
    has to compute the difference. Edges that survive are left ALONE rather than
    rewritten, which matters because `member_of` and `writes_at` carry role and
    dates -- rebuilding an edge that was already right would quietly discard them.

    Module-level rather than a method because two services need it for the same
    reason: PeopleService reconciles affiliations, ArtifactService reconciles both a
    remark's subjects and its derived citations.
    """
    current = {n.id: e for e, n in repo.neighbors(
        node_id, edge_types=[edge_type], direction="out")}
    wanted = list(dict.fromkeys(targets))
    for tid, edge in current.items():
        if tid not in wanted:
            repo.soft_delete_edge(edge.id, actor)
    return [repo.add_edge(node_id, tid, edge_type, actor=actor)
            for tid in wanted if tid not in current]


def reader_visible(node: Node) -> bool:
    """Whether a reader may see this node at all -- the guide's one privacy rule.

    Every field node is public: a concept's description, a document's summary, who
    wrote it. The curator's own voice is not, so an artifact passes only if it is a
    PUBLISHED remark (the guide scope is an artifact mechanically, but it is prose
    about the guide and has no reader surface).

    Module-level because two readers need the same answer and must not drift:
    `public_graph` decides which nodes exist for a reader, and `public_links_in`
    decides which of a body's links may be resolved to a label for one. It is stated
    positively -- what may be seen -- so a new node type is invisible until someone
    adds it, rather than public until someone remembers to hide it.
    """
    if node.type != NodeType.ARTIFACT.value:
        return True
    return (node.attributes.get("kind") == ArtifactService.NOTE
            and node.attributes.get("visibility") == ArtifactService.PUBLIC)


class OntologyService:
    """Concepts and the structural edges between them."""

    STRUCTURAL = ONTOLOGY_EDGE_TYPES

    def __init__(self, repo: GraphRepository):
        self.repo = repo
        self.integrity = GraphIntegrity(repo)

    def create_concept(self, label: str, *, description: str = "",
                       semantic_query: str = "", keywords: str = "",
                       criteria: str = "", actor: Actor) -> Node:
        return self.repo.add_node(
            NodeType.CONCEPT, label,
            {"description": description, "semantic_query": semantic_query,
             "keywords": keywords, "criteria": criteria},
            actor)

    def rename_concept(self, concept_id: UUID, new_label: str, *, actor: Actor) -> Node:
        return self.repo.update_node(concept_id, label=new_label, actor=actor)

    def update_concept(self, concept_id: UUID, *, description: Optional[str] = None,
                       semantic_query: Optional[str] = None,
                       keywords: Optional[str] = None,
                       criteria: Optional[str] = None, actor: Actor) -> Node:
        """Curator-written text. Only the fields you pass are changed."""
        patch: Dict = {}
        if description is not None:
            patch["description"] = description
        if semantic_query is not None:
            patch["semantic_query"] = semantic_query
        if keywords is not None:
            patch["keywords"] = keywords
        if criteria is not None:
            patch["criteria"] = criteria
        return self.repo.update_node(concept_id, attributes_patch=patch, actor=actor)

    def relate(self, from_id: UUID, to_id: UUID, rel_type: EdgeType, *,
               actor: Actor) -> Edge:
        if rel_type not in self.STRUCTURAL:
            raise ValueError(f"{rel_type.value} is not a concept-structure edge")
        # validate_edge only sees the endpoints' *types*, and both ends of a
        # subtopic_of are concepts whether or not the edge closes a loop. The
        # rules that need the graph itself live in GraphIntegrity.
        self.integrity.check_edge(from_id, to_id, rel_type)
        return self.repo.add_edge(from_id, to_id, rel_type, actor=actor)

    def unrelate(self, edge_id: UUID, *, actor: Actor) -> None:
        self.repo.soft_delete_edge(edge_id, actor)

    def reparent(self, concept_id: UUID, *, from_parent_id: Optional[UUID],
                 to_parent_id: Optional[UUID], actor: Actor) -> Optional[Edge]:
        """Move a concept between levels: drop its `subtopic_of` edge to
        `from_parent_id`, add one to `to_parent_id`.

        `None` on either side means the top level -- `from_parent_id=None` for a
        concept that is currently a root (there is no edge to drop), and
        `to_parent_id=None` to make it one (there is none to add). Both None is a
        no-op rather than an error; a drag that lands where it started should do
        nothing, not fail.

        **Only the named parent edge is dropped.** A poly-parented concept keeps
        every other parent it has, because the curator moved ONE instance of it --
        the row they dragged -- and the others are not theirs to discard. This is
        also why the caller must say which parent to move *from* rather than the
        service inferring it: with several parents there is no inferring it.

        The add happens before the delete so that a move which would close a
        `subtopic_of` cycle (dropping a concept onto its own descendant) is refused
        by `relate`'s integrity check with the old parent still in place. Callers
        wrap this in a transaction anyway, but the ordering means it is safe even
        for one that doesn't.

        Adopting a parent the concept already has is not an error either: the new
        edge is skipped (it would collide with `edges_triple_uniq`) and the old one
        still goes, which turns a redundant poly-parenting into the single edge the
        curator was reaching for.

        Returns the new edge, or None when nothing was added.
        """
        _require_type(self.repo.get_node(concept_id), NodeType.CONCEPT, "concept")
        if to_parent_id is not None and to_parent_id == concept_id:
            raise ValueError("a concept cannot be its own parent")

        current = {n.id: e for e, n in self.repo.neighbors(
            concept_id, edge_types=[EdgeType.SUBTOPIC_OF], direction="out")}

        edge = None
        if to_parent_id is not None and to_parent_id not in current:
            _require_type(self.repo.get_node(to_parent_id),
                          NodeType.CONCEPT, "new parent")
            edge = self.relate(concept_id, to_parent_id,
                               EdgeType.SUBTOPIC_OF, actor=actor)
        if from_parent_id is not None and from_parent_id in current:
            self.repo.soft_delete_edge(current[from_parent_id].id, actor)
        return edge

    def set_layout(self, concept_id: UUID, x: float, y: float, *,
                   pinned: bool = True, actor: Actor) -> Node:
        return self.repo.update_node(
            concept_id, attributes_patch={"layout": {"x": x, "y": y, "pinned": pinned}},
            actor=actor)

    def merge_concepts(self, keep_id: UUID, merge_id: UUID, *,
                       actor: Actor) -> MergeResult:
        """Fold the concept `merge_id` into `keep_id` (see repo.merge_nodes for the
        structural rules). The survivor's text is left untouched; both versions come
        back in `reconcile` for the curator to resolve."""
        keep = _require_type(self.repo.get_node(keep_id), NodeType.CONCEPT, "keep")
        merged = _require_type(self.repo.get_node(merge_id), NodeType.CONCEPT, "merge")
        survivor, merged_before, dropped = self.repo.merge_nodes(keep_id, merge_id, actor)
        reconcile = {
            "keep": {"description": keep.attributes.get("description", ""),
                     "semantic_query": keep.attributes.get("semantic_query", ""),
                     "keywords": keep.attributes.get("keywords", ""),
                     "criteria": keep.attributes.get("criteria", "")},
            "merged": {"description": merged_before.attributes.get("description", ""),
                       "semantic_query": merged_before.attributes.get("semantic_query", ""),
                       "keywords": merged_before.attributes.get("keywords", ""),
                       "criteria": merged_before.attributes.get("criteria", "")},
        }
        return MergeResult(survivor=survivor, reconcile=reconcile, dropped_edges=dropped)

    def _deletion_plan(self, concept_id: UUID) -> Dict:
        """Work out what deleting a concept actually takes down.

        The subtree cascades, but *poly-parent-aware*: a descendant is deleted only
        if EVERY one of its `subtopic_of` parents is itself being deleted -- a child
        that also hangs under a surviving parent is kept (it just loses this branch).
        Then documents that would be left with no category at all are marked for
        re-queue; ones still filed under a surviving concept are not.

        Returns {target, delete_ids (set), also_deleted (Nodes), requeue_doc_ids}.
        """
        target = _require_type(
            self.repo.get_node(concept_id), NodeType.CONCEPT, "concept")

        children: Dict[UUID, List[UUID]] = {}
        parents: Dict[UUID, List[UUID]] = {}
        for e in self.repo.find_edges(types=[EdgeType.SUBTOPIC_OF]):
            children.setdefault(e.target_id, []).append(e.source_id)  # parent -> child
            parents.setdefault(e.source_id, []).append(e.target_id)   # child -> parent

        # Every concept below the target, then the fixpoint: keep a descendant only
        # while it has a parent that survives.
        descendants: set = set()
        stack = list(children.get(concept_id, []))
        while stack:
            d = stack.pop()
            if d in descendants:
                continue
            descendants.add(d)
            stack.extend(children.get(d, []))

        delete_ids = {concept_id}
        changed = True
        while changed:
            changed = False
            for d in descendants:
                if d in delete_ids:
                    continue
                ps = parents.get(d, [])
                if ps and all(p in delete_ids for p in ps):
                    delete_ids.add(d)
                    changed = True

        also_deleted = [n for n in (self.repo.get_node(cid) for cid in delete_ids
                                    if cid != concept_id) if n is not None]

        # A document re-enters the queue only if the deletion strips its LAST
        # category. `about` edges run document -> concept.
        doc_concepts: Dict[UUID, set] = {}
        for e in self.repo.find_edges(types=[EdgeType.ABOUT]):
            doc_concepts.setdefault(e.source_id, set()).add(e.target_id)
        requeue_doc_ids = [doc for doc, cs in doc_concepts.items()
                           if (cs & delete_ids) and not (cs - delete_ids)]

        return {"target": target, "delete_ids": delete_ids,
                "also_deleted": also_deleted, "requeue_doc_ids": requeue_doc_ids}

    def preview_deletion(self, concept_id: UUID) -> Dict:
        """What a delete would take with it -- for the UI's confirm dialog. Reads
        only; changes nothing."""
        plan = self._deletion_plan(concept_id)
        return {"target": plan["target"], "also_deleted": plan["also_deleted"],
                "documents_requeued": len(plan["requeue_doc_ids"])}

    def delete_concept(self, concept_id: UUID, *, actor: Actor) -> Dict:
        """Soft-delete a concept, cascade to the descendants it orphans, and send
        any now-uncategorized documents back to the review queue. Returns
        {deleted (Nodes, target first), requeued (doc ids)}."""
        plan = self._deletion_plan(concept_id)
        self.repo.delete_nodes_cascade(
            list(plan["delete_ids"]), plan["requeue_doc_ids"], actor)
        return {"deleted": [plan["target"], *plan["also_deleted"]],
                "requeued": plan["requeue_doc_ids"]}


class IngestionService:
    """The document lifecycle: submit -> categorize/summarize.

    There is no approve/reject gate. `approve`/`reject` (and a `review_note` to
    hold a rejection reason) used to live here, left over from an earlier UI, but
    nothing reachable ever set them -- the curator's one Save takes a document
    straight from `pending` to `reviewed`, and with a single curator there is no
    second role for a gate to serve. If a publication gate for the Viewer is ever
    wanted, it is a new state, not these.
    """

    def __init__(self, repo: GraphRepository):
        self.repo = repo

    def find_document_by_url(self, url: str) -> Optional[Node]:
        """The live document with this canonical URL, or None.

        `repo.document_by_url` rather than `find_nodes`, because dedup is one of the
        three things that must see the review queue: a paper already sitting
        unreviewed IS a duplicate, and an ingest blind to it would insert a second
        one and hit `nodes_doc_url_uniq`. See repository.APPROVED_ONLY.
        """
        return self.repo.document_by_url(url)

    def tombstoned_urls(self) -> set:
        """Canonical URLs of documents the curator has dismissed (soft-deleted).

        Deleting a document is a judgement -- "this doesn't belong in the guide" --
        and discovery re-runs the same searches every time, so without this the same
        rejected paper is offered back on every run and has to be dismissed forever.
        `find_document_by_url` only sees live nodes, so the dismissal leaves no trace
        that ingestion would otherwise notice.

        This is the suppression the delete TODO deferred. It is deliberately keyed on
        URL rather than on the node: the point is to refuse the *source*, and a
        re-ingest creates a new node with a new id.

        Only documents explicitly marked `dismissed` count. Undo reverses a create by
        soft-deleting it too, so keying off `deleted_at` alone would treat an undone
        discovery run as a mass rejection and permanently bury every paper it found.
        """
        return set(self.repo.deleted_attr_values(
            NodeType.DOCUMENT, "canonical_url", where_flag="dismissed"))

    def restore_dismissed_document(self, url: str, *, actor: Actor) -> Optional[Node]:
        """Bring back the document the curator dismissed at this URL, if there is one.

        A deliberate re-add is a *newer judgement* than the old dismissal, so it
        wins. The original node comes back -- same id, same summary, same edges the
        dismissal took with it -- rather than a second document appearing beside a
        tombstone that goes on suppressing the URL from discovery. Without this, the
        unique-url index being partial (`where deleted_at is null`) means a manual
        re-add is *permitted*, and leaves the graph holding one live and one
        dismissed document for the same url.

        Clearing `dismissed` is what lifts the tombstone: `tombstoned_urls` reads
        exactly that flag on exactly these rows, so nothing else has to be told.

        Status is **derived, not forced back to pending** -- the same rule
        `_sync_status` holds everywhere else. A document that was reviewed and filed
        under two concepts before someone dismissed it comes back reviewed and filed,
        because its `about` edges came back with it; only one with nothing on it
        lands in the queue.

        Returns None when no dismissed document has this URL, which is the ordinary
        case and lets the caller fall through to a normal ingest.
        """
        found = self.repo.find_deleted_nodes(
            NodeType.DOCUMENT, {"canonical_url": url},
            where_flag="dismissed", limit=1)
        if not found:
            return None
        doc = self.repo.restore_node(found[0].id, actor=actor)
        categorized = bool(self.repo.neighbors(
            doc.id, edge_types=[EdgeType.ABOUT], direction="out"))
        # One patch rather than clearing the flag and then syncing status, so the
        # restore reads as a single update in the revision log.
        #
        # The dismissal note goes with the dismissal. It says why the document was
        # rejected, and this restore is the judgement that supersedes it: leaving it
        # would hang "paywalled" off a paper now in the guide, and a later dismissal
        # with no reason given would silently inherit it. The revision log keeps the
        # history; the node carries only what is true of it now.
        return self.repo.update_node(
            doc.id,
            attributes_patch={"dismissed": False, "dismissal_note": "",
                              "status": "reviewed" if categorized else "pending"},
            actor=actor)

    def submit_document(self, scraped: Dict, *, submitted_by: Actor,
                        source_type: Optional[str] = None,
                        searchterms: Optional[List[str]] = None,
                        oa_pdf_url: Optional[str] = None,
                        venue_tier: Optional[str] = None,
                        reference_count: Optional[int] = None,
                        proposed_concept_ids: Optional[List[str]] = None,
                        full_text: Optional[str] = None) -> Node:
        """Turn a scraper result dict into a pending Document node.

        Idempotent on canonical URL: re-submitting an already-known URL returns the
        existing node rather than erroring. We deliberately keep only metadata +
        (later) a summary -- the scraped full `text` is dropped, matching the
        no-Tier-2/link-rot-accepted storage decision. `searchterms` tracks which
        search terms triggered discovery (for curation context). Where the document
        came *from* is not stored here -- see `SourceService.record_provenance`.

        The `abstract` is one exception to dropping text: it's short, it's open
        metadata the search APIs hand us even for paywalled works, and it's what
        lets a curator review a document whose full text we can never fetch.

        `full_text` is the other, deliberately narrow: it's for a curator pasting
        in a document our own fetch couldn't reach (see `IngestionBridge.
        ingest_manual`), landing in the same `full_text` slot the curation
        assistant caches a live fetch into (`assistant/text_writer.save_full_text`)
        -- so the Document Viewer shows what was pasted instead of re-attempting a
        fetch that already failed once."""
        url = scraped.get("url") or scraped.get("canonical_url")
        if not url:
            raise ValueError("scraped document has no url")

        existing = self.find_document_by_url(url)
        if existing:
            return existing

        attrs = {
            "canonical_url": url,
            "source_type": source_type or _infer_source_type(url),
            "title": scraped.get("title") or "",
            "publication": scraped.get("publication"),
            "published_date": scraped.get("date"),
            "authors_scraped": _scraped_authors(scraped.get("authors")),
            # Every scraped name starts as an outstanding author proposal. Save
            # empties this; `authors_scraped` above keeps the full record either way.
            "proposed_author_names": [a["name"] for a
                                      in _scraped_authors(scraped.get("authors"))],
            "abstract": scraped.get("abstract") or "",
            # Absent means yes: `ingest_candidates` and every existing caller
            # submit documents that have a body, and only Reader's PDF path has
            # cause to say otherwise.
            "body_text_found": bool(scraped.get("body_text_found", True)),
            "summary": "",
            "status": "pending",
            "searchterms": searchterms or [],
            "oa_pdf_url": oa_pdf_url,
            # What kind of venue this came from, for ordering the queue -- see
            # scout.venue_tier. None is the honest answer for anything that isn't a
            # paper (a feed post, a hand-added page), not a judgement about it.
            "venue_tier": venue_tier,
            "reference_count": reference_count,
            "proposed_concept_ids": proposed_concept_ids or [],
            "full_text": full_text or None,
        }
        label = attrs["title"] or url
        return self.repo.add_node(NodeType.DOCUMENT, label, attrs, submitted_by)

    def _sync_status(self, doc_id: UUID, *, actor: Actor) -> None:
        """Hold the queue invariant: a document is `reviewed` iff it is filed under
        at least one concept, and `pending` otherwise.

        Status is *derived from* categorization, never set independently of it --
        otherwise a document can end up reviewed-but-uncategorized, which is
        invisible in both places a curator looks (not in the queue, not under any
        concept). `delete_concept` already re-queues documents whose last category it
        removes; this is the same rule applied to the curator removing it by hand.
        """
        categorized = bool(self.repo.neighbors(
            doc_id, edge_types=[EdgeType.ABOUT], direction="out"))
        self.repo.update_node(
            doc_id, attributes_patch={"status": "reviewed" if categorized else "pending"},
            actor=actor)

    def categorize(self, doc_id: UUID, concept_ids: Sequence[UUID], *,
                   actor: Actor) -> List[Edge]:
        """Attach the document to concepts (`about` edges) and mark it reviewed.
        Skips concepts it's already attached to, so it's safe to re-run."""
        already = {n.id for e, n in self.repo.neighbors(
            doc_id, edge_types=[EdgeType.ABOUT], direction="out")}
        edges = [self.repo.add_edge(doc_id, cid, EdgeType.ABOUT, actor=actor)
                 for cid in concept_ids if cid not in already]
        self._sync_status(doc_id, actor=actor)
        return edges

    def set_concepts(self, doc_id: UUID, concept_ids: Sequence[UUID], *,
                     actor: Actor) -> List[Edge]:
        """Reconcile the document's `about` edges to exactly `concept_ids`: add the
        missing ones, soft-delete the ones no longer wanted, leave the rest. Unlike
        `categorize` (add-only) this lets the curator *remove* an assignment, which
        the single-Save UI needs. Returns the live `about` edges after
        reconciliation.

        Saving an empty set is un-filing the document, so it goes back to `pending`
        rather than sitting reviewed-but-uncategorized where nothing can reach it
        (see `_sync_status`).

        **This consumes the document's outstanding concept proposals**, the mirror of
        what `PeopleService.set_authors` does to author proposals. The curator UI
        gates Save on at least one assigned concept, so a concept proposal still
        outstanding when Save lands was passed over deliberately: undecided at Save
        means denied. This used to store whatever the caller said was still
        undecided, which let an approved document keep offering concept proposals --
        and an approved document is not proposed to. The list is emptied whether the
        proposal was accepted (it is an `about` edge now) or passed over."""
        current = {n.id: e for e, n in self.repo.neighbors(
            doc_id, edge_types=[EdgeType.ABOUT], direction="out")}
        desired = set(concept_ids)
        for cid in desired - set(current):
            self.repo.add_edge(doc_id, cid, EdgeType.ABOUT, actor=actor)
        for cid in set(current) - desired:
            self.repo.soft_delete_edge(current[cid].id, actor)
        self.repo.update_node(
            doc_id, attributes_patch={"proposed_concept_ids": []}, actor=actor)
        self._sync_status(doc_id, actor=actor)
        return [e for e, _n in self.repo.neighbors(
            doc_id, edge_types=[EdgeType.ABOUT], direction="out")]

    def update_summary(self, doc_id: UUID, summary: str, *, actor: Actor) -> Node:
        return self.repo.update_node(
            doc_id, attributes_patch={"summary": summary}, actor=actor)

    def update_title(self, doc_id: UUID, title: str, *, actor: Actor) -> Node:
        """Correct a document's title -- the field scraping gets wrong most often.

        Writes BOTH `attributes.title` and the node `label`, because the two are set
        together at submit time (`label = title or url`) and every view falls back
        from one to the other. Updating only the attribute would leave the label
        holding the bad scrape, which then surfaces in list tooltips, the delete
        confirmation, and undo descriptions.

        A blank title falls back to the URL for the label, exactly as submission
        does, so a document is never left labelled with an empty string."""
        doc = _require_type(self.repo.get_node(doc_id), NodeType.DOCUMENT, "document")
        title = title.strip()
        label = title or doc.attributes.get("canonical_url") or doc.label
        return self.repo.update_node(
            doc_id, label=label, attributes_patch={"title": title}, actor=actor)

    def update_abstract(self, doc_id: UUID, abstract: str, *, actor: Actor) -> Node:
        """Set the document's abstract by hand.

        Discovery fills this from the search APIs, but not every record has one --
        arXiv-only finds, works OpenAlex has no abstract for, or anything a bot
        blocker kept us from. A human can often retrieve it when we can't, and for a
        paywalled paper the abstract is the whole review surface, so it's worth a
        manual path. Distinct from `summary`, which is the curator's own distillation
        rather than the author's."""
        return self.repo.update_node(
            doc_id, attributes_patch={"abstract": abstract}, actor=actor)

    def update_metadata(self, doc_id: UUID, *, publication: Optional[str] = None,
                        published_date: Optional[str] = None, actor: Actor) -> Node:
        """Correct the bibliographic strings a scrape got wrong or never found.

        Patch semantics: an omitted field is left alone, `""` clears it back to
        None. Publication is a *string* on purpose -- it names a venue, and venue
        is the one bibliographic entity the guide deliberately doesn't model as a
        node. Nothing searches over it, so promoting it would buy a node type's
        worth of upkeep and no query.
        """
        patch: Dict = {}
        if publication is not None:
            patch["publication"] = publication.strip() or None
        if published_date is not None:
            patch["published_date"] = published_date.strip() or None
        if not patch:
            return _require_type(
                self.repo.get_node(doc_id), NodeType.DOCUMENT, "document")
        return self.repo.update_node(doc_id, attributes_patch=patch, actor=actor)

    def link_authors(self, doc_id: UUID, person_ids: Sequence[UUID], *,
                     actor: Actor) -> List[Edge]:
        already = {n.id for e, n in self.repo.neighbors(
            doc_id, edge_types=[EdgeType.AUTHORED_BY], direction="out")}
        return [self.repo.add_edge(doc_id, pid, EdgeType.AUTHORED_BY, actor=actor)
                for pid in person_ids if pid not in already]

    def delete_document(self, doc_id: UUID, *, note: Optional[str] = None,
                        actor: Actor) -> Node:
        """Soft-delete a document and every edge incident to it (`about`,
        `authored_by`), atomically -- the same cascade concept deletion uses, since
        `find_edges` returns live edges regardless of whether their endpoints live.
        There is nothing to re-queue: the document itself is what's leaving.

        Marks the document `dismissed` first, which is what tombstones the URL so
        discovery won't offer it again (see `tombstoned_urls`). Both writes want to
        be in the caller's transaction so they share a txid: undo then reverses the
        dismissal and the delete together, and an undone dismissal correctly stops
        suppressing the URL.

        `note` is why -- recorded in `dismissal_note`, in the same patch as the flag
        rather than a second update, so one dismissal reads as one change in the
        revision log and undo restores the pre-delete attributes in one step. It is
        deliberately optional: a dismissal nobody explained is still a dismissal, and
        gating the delete on a reason would only teach people to type a character.
        """
        doc = self.repo.get_node(doc_id)
        _require_type(doc, NodeType.DOCUMENT, "document")
        patch: Dict = {"dismissed": True}
        # `None` means the caller had nothing to say; `""` from a blank Summary box
        # means the same. Neither should overwrite a note an earlier dismissal left.
        if note and note.strip():
            patch["dismissal_note"] = note.strip()
        self.repo.update_node(doc_id, attributes_patch=patch, actor=actor)
        self.repo.delete_nodes_cascade([doc_id], [], actor)
        return doc


def _kept_paint(paint: Dict[str, PaintColor], subject_ids: Sequence[UUID]) -> Dict[str, PaintColor]:
    """`paint` with every colour whose concept is not a subject removed.

    Keyed by node id as a string, because that is how it is stored and how it
    arrives from the editor; the subject ids are UUIDs, so both sides are compared
    as strings. Non-concept subjects need no filtering out -- a person or a document
    simply never has an entry, since nothing offers a colour for one.
    """
    keep = {str(i) for i in subject_ids}
    return {k: v for k, v in paint.items() if k in keep}


class ArtifactService:
    """Curator-authored prose that sits on top of the graph.

    Two things, sharing one shape:

      * the guide scope -- a singleton with no subjects, stating what the guide is
        about, which the discovery relevance filter screens candidates against
      * remarks -- prose about one node ("what I think about Literacy") or several
        together ("what Literacy has to do with these"), attached by `remarks_on`

    The number of subjects is not a type distinction and there is no `relation` kind;
    see ArtifactAttrs. A remark over several subjects is a hyperedge, which is why an
    edge could never have carried it and why the `relates_to` edge it replaces was
    removed outright rather than annotated.

    Citations are DERIVED. The body owns them (inline `[anchor](doc:<uuid>)`), and
    `cites` edges are rebuilt from it on every save. Nothing else may write them.
    """

    GUIDE_SCOPE = "guide_scope"
    NOTE = "note"
    PUBLIC = "public"
    PRIVATE = "private"

    def __init__(self, repo: GraphRepository):
        self.repo = repo

    # -- remarks -----------------------------------------------------------

    def create_remark(self, label: str, body: str, subject_ids: Sequence[UUID], *,
                      visibility: str = PRIVATE, paint: Optional[Dict[str, PaintColor]] = None,
                      quilt: Optional[Quilt] = None, actor: Actor) -> Node:
        """A new piece of prose about one or more nodes.

        No minimum on `subject_ids` at this layer. A remark with no subjects yet is a
        legitimate half-written draft, and the editor -- not the graph -- is where
        "you haven't said what this is about" belongs.

        Default `private`: a new remark reaches no reader until it is published on
        purpose. See ArtifactAttrs.visibility.
        """
        node = self.repo.add_node(
            NodeType.ARTIFACT, label,
            {"kind": self.NOTE, "body": body, "visibility": visibility,
             "paint": _kept_paint(paint or {}, subject_ids),
             "quilt": quilt.model_dump() if quilt else None}, actor)
        self.set_subjects(node.id, subject_ids, actor=actor)
        self._sync_citations(node.id, body, actor=actor)
        return node

    def update_remark(self, artifact_id: UUID, *, label: Optional[str] = None,
                      body: Optional[str] = None,
                      subject_ids: Optional[Sequence[UUID]] = None,
                      visibility: Optional[str] = None,
                      paint: Optional[Dict[str, PaintColor]] = None,
                      quilt: Optional[Quilt] = None,
                      actor: Actor) -> Node:
        """Patch semantics: None means "leave alone", which is what distinguishes
        clearing the subjects (`[]`) from not touching them (`None`).

        DROPPING A SUBJECT DROPS ITS COLOUR. A colour describes a shape in the
        reader's drawing, and a concept that is no longer a subject is no longer
        drawn, so keeping the entry would leave the remark carrying colours for
        shapes that do not exist -- invisible in the editor, and silently reapplied
        if the concept were ever added back. Pruning runs whenever the subjects are
        given, including on a paint-only save, so a stale colour cannot survive by
        being written past.

        `quilt` has NO such pruning yet -- a slot can currently go on pointing at a
        concept id no longer among this remark's subjects. Whole-value replace, same
        as `visibility`/`body`: None leaves it alone, a value overwrites it outright.
        """
        art = self._require_artifact(artifact_id)
        patch: Dict = {}
        if body is not None:
            patch["body"] = body
        if visibility is not None:
            patch["visibility"] = visibility
        if paint is not None:
            patch["paint"] = paint
        if quilt is not None:
            patch["quilt"] = quilt.model_dump()
        # Whichever subject list this save leaves in force -- the new one if it is
        # setting them, otherwise the one already on the node.
        if subject_ids is not None or paint is not None:
            subjects = (subject_ids if subject_ids is not None
                        else [n.id for n in self.subjects_of(art.id)])
            kept = _kept_paint(
                patch.get("paint", art.attributes.get("paint", {})), subjects)
            if kept != art.attributes.get("paint", {}) or paint is not None:
                patch["paint"] = kept
        node = self.repo.update_node(
            art.id, label=label, attributes_patch=patch or None, actor=actor)
        if subject_ids is not None:
            self.set_subjects(art.id, subject_ids, actor=actor)
        if body is not None:
            self._sync_citations(art.id, body, actor=actor)
        return node

    def delete_remark(self, artifact_id: UUID, *, actor: Actor) -> Node:
        """Soft-delete the artifact and every edge it owns.

        Cascading is safe here in a way it is not for a concept: an artifact's edges
        all point OUT of it and assert nothing about the nodes they touch, so
        removing them takes nothing away from the graph the artifact was written on.
        Nothing is re-queued for the same reason -- a cited document was never made
        pending by being cited.
        """
        art = self._require_artifact(artifact_id)
        self.repo.delete_nodes_cascade([artifact_id], [], actor)
        return art

    def set_subjects(self, artifact_id: UUID, subject_ids: Sequence[UUID], *,
                     actor: Actor) -> List[Edge]:
        """What this prose is about. Set semantics -- pass [] to clear."""
        return _reconcile_links(
            self.repo, artifact_id, subject_ids, EdgeType.REMARKS_ON, actor=actor)

    def subjects_of(self, artifact_id: UUID) -> List[Node]:
        return [n for _, n in self.repo.neighbors(
            artifact_id, edge_types=[EdgeType.REMARKS_ON], direction="out")]

    def citations_of(self, artifact_id: UUID) -> List[Node]:
        return [n for _, n in self.repo.neighbors(
            artifact_id, edge_types=[EdgeType.CITES], direction="out")]

    def remarks_on(self, node_id: UUID) -> List[Node]:
        """Every artifact that remarks on this node -- the curator-side read, and the
        seam the viewer will eventually be built on."""
        return [n for _, n in self.repo.neighbors(
            node_id, edge_types=[EdgeType.REMARKS_ON], direction="in")]

    def remarks_citing(self, doc_id: UUID) -> List[Node]:
        """Every artifact citing this document. The reason `cites` is an edge at all
        rather than a parse of every body at read time."""
        return [n for _, n in self.repo.neighbors(
            doc_id, edge_types=[EdgeType.CITES], direction="in")]

    def public_links_in(self, body: str) -> List[Node]:
        """`links_in`, narrowed to what a reader may see.

        The read projection resolves a body's links to their labels, and a published
        remark is free to link a private draft -- so this is where that stops. The
        link itself is harmless on the reader's side (nothing resolves it, so it
        renders as plain words), but the LABEL would have travelled in the payload.
        Enforced in the service rather than in the serializer so the rule is testable
        and sits beside `public_graph`, which decides the same question for nodes.
        """
        return [n for n in self.links_in(body) if reader_visible(n)]

    def links_in(self, body: str) -> List[Node]:
        """The live nodes this prose links to, in first-mention order.

        The body is the source of truth and this resolves it against the graph, which
        is the whole reason a link carries no type in its text (see graph/links.py):
        what an id IS gets looked up, never parsed. Ids that resolve to nothing are
        simply absent -- `dangling_links` is what names those.

        Used by every reader of a body: the editor's References block, the curator
        artifact payload, and the reader projection. They differ only in what they
        then do with the types, which is why this returns nodes rather than a
        pre-filtered list.
        """
        out = []
        for node_id in linked_node_ids(body):
            node = self.repo.get_node(node_id)
            if node is not None:
                out.append(node)
        return out

    def _sync_citations(self, artifact_id: UUID, body: str, *,
                        actor: Actor) -> List[UUID]:
        """Rebuild `cites` from the body. Returns the ids that did NOT resolve.

        DOCUMENTS ONLY, decided here against the graph rather than in the parser: a
        `cites` edge is a claim that this prose rests on that paper. A link to a
        concept or a person is not that claim, and must not become one -- `remarks_on`
        is how a remark says what it is about, and an inline mention that quietly
        added a subject would put words in the curator's mouth. So a non-document
        link is neither an edge nor an error; it is just a link.

        Unresolvable ids are reported, not raised. A link whose target was deleted, or
        one that was hand-mangled, must still let the prose save -- refusing the write
        would hold an essay hostage to one broken link -- and the editor needs to know
        which ones to mark.
        """
        wanted, dangling = [], []
        for node_id in linked_node_ids(body):
            node = self.repo.get_node(node_id)
            if node is None:
                dangling.append(node_id)
            elif node.type == NodeType.DOCUMENT.value:
                wanted.append(node_id)
        _reconcile_links(self.repo, artifact_id, wanted, EdgeType.CITES, actor=actor)
        return dangling

    def dangling_links(self, body: str) -> List[str]:
        """Links in this body that point at no live node, for the editor to flag.

        Reads the body rather than the edges, because an id that resolves to nothing
        has no edge to be found by. A link to a live CONCEPT is not dangling -- it
        just isn't a citation; that distinction is what stopped the References block
        from reddening every non-document link the moment one scheme replaced `doc:`.
        """
        out = []
        for link in parse_links(body):
            if link.node_id is None or self.repo.get_node(link.node_id) is None:
                out.append(link.raw)
        return out

    def list_remarks(self) -> List[Node]:
        """Every remark, scope excluded -- the scope is not prose about the graph.

        The CURATOR list: public and private together. The reader's list is
        `public_remarks`, and the two must never be confused -- this one is only ever
        served behind the curator API.
        """
        return [n for n in self.repo.find_nodes(type=NodeType.ARTIFACT)
                if n.attributes.get("kind") != self.GUIDE_SCOPE]

    def public_remarks(self) -> List[Node]:
        """The reader-visible remarks: public `note`s only.

        The single source of truth for what the read surface exposes. Scope is
        excluded by the kind check, and a private artifact by the visibility check, so
        neither the guide's config nor a curator's draft can leak through here.
        """
        return [n for n in self.repo.find_nodes(type=NodeType.ARTIFACT)
                if n.attributes.get("kind") == self.NOTE
                and n.attributes.get("visibility") == self.PUBLIC]

    def set_visibility(self, artifact_id: UUID, visibility: str, *, actor: Actor) -> Node:
        """Publish (`public`) or unpublish (`private`) a remark. The whole
        reader/curator boundary is this one write."""
        if visibility not in (self.PUBLIC, self.PRIVATE):
            raise ValueError(f"visibility must be public|private, got {visibility!r}")
        self._require_artifact(artifact_id)
        return self.repo.update_node(
            artifact_id, attributes_patch={"visibility": visibility}, actor=actor)

    def _require_artifact(self, artifact_id: UUID) -> Node:
        return _require_type(
            self.repo.get_node(artifact_id), NodeType.ARTIFACT, "artifact")

    # -- guide scope -------------------------------------------------------

    def find_by_kind(self, kind: str) -> Optional[Node]:
        found = self.repo.find_nodes(
            type=NodeType.ARTIFACT, attr_filters={"kind": kind}, limit=1)
        return found[0] if found else None

    def get_guide_scope(self) -> Optional[Node]:
        """The scope artifact, or None if the curator hasn't written one yet.

        None is a real state, not an error: callers fall back to a built-in default
        so a guide with no scope still filters sensibly."""
        return self.find_by_kind(self.GUIDE_SCOPE)

    def set_guide_scope(self, body: str, *, actor: Actor,
                        label: str = "Guide scope") -> Node:
        """Write the scope statement, creating the artifact on first save."""
        existing = self.get_guide_scope()
        if existing is None:
            return self.repo.add_node(
                NodeType.ARTIFACT, label,
                {"kind": self.GUIDE_SCOPE, "body": body}, actor)
        return self.repo.update_node(
            existing.id, attributes_patch={"body": body}, actor=actor)


class SourceService:
    """Where documents come from: feeds the curator follows, and the search APIs.

    A source is a node so a publication can be its own thing -- many writers, longer
    lived than any of them, sometimes with no identifiable person at all -- and so it
    can carry edges: `writes_at` from its authors, `part_of` to the org that runs it,
    `sourced_from` on every document it produced.

    Two kinds live here and they are deliberately the same kind. `arXiv` and
    `OpenAlex` are sources that *require a subject* (a concept supplies the query); a
    feed is a source that *takes no subject* and enumerates instead. That's the only
    axis on which they differ, and it lives in the fan-out stage, not here.
    """

    # The built-in API sources, seeded so provenance is uniform from day one --
    # otherwise a `sourced_from` axis would only see the feeds and read as though
    # nothing came from the literature. Labels match the adapter `name` strings
    # exactly (scout.ArXivAdapter.name, scout.OpenAlexAdapter.name), because that's
    # what a candidate reports as its origin and what provenance is resolved against.
    BUILTINS = (
        ("arXiv", "https://arxiv.org", "api"),
        ("openAlex", "https://openalex.org", "api"),
    )

    # Mechanisms Scout can actually poll. An allowlist rather than "everything that
    # isn't `api`": the denylist was right while a search API was the only thing you
    # couldn't poll, but it fails *open* -- `manual` would have joined the poll list
    # and sent Scout to fetch a urn. Anything added later is unpollable until it says
    # otherwise, which is the safe direction for this to be wrong in.
    POLLABLE = frozenset({"rss", "sitemap", "page"})

    # The provenance bucket for documents a curator pasted in by hand. The url is a
    # urn precisely so nothing can mistake it for something to fetch -- and because
    # `upsert_source` dedups on url, which makes this find-or-create for free.
    MANUAL = ("Added by hand", "urn:field-guide:manual", "manual")

    def __init__(self, repo: GraphRepository):
        self.repo = repo

    def find_by_url(self, url: str) -> Optional[Node]:
        found = self.repo.find_nodes(
            type=NodeType.SOURCE, attr_filters={"url": url}, limit=1)
        return found[0] if found else None

    def upsert_source(self, label: str, url: str, *, mechanism: str = "rss",
                      homepage: Optional[str] = None, notes: str = "",
                      actor: Actor) -> Node:
        """Find-or-create a source, dedup on url.

        Idempotent the way `submit_document` is: following the same feed twice is a
        no-op rather than a second node quietly polling in parallel. Deliberately
        does NOT re-enable a source that's been turned off -- re-following something
        you rejected should be a decision you make, not a side effect of running a
        script again.
        """
        existing = self.find_by_url(url)
        if existing:
            return existing
        attrs: Dict = {"url": url, "mechanism": mechanism, "notes": notes}
        if homepage:
            attrs["homepage"] = homepage
        return self.repo.add_node(NodeType.SOURCE, label, attrs, actor)

    def ensure_builtins(self, *, actor: Actor) -> List[Node]:
        """Seed arXiv and OpenAlex as sources. Safe to re-run."""
        return [self.upsert_source(name, url, mechanism=mech, actor=actor)
                for name, url, mech in self.BUILTINS]

    def ensure_manual_source(self, *, actor: Actor) -> Node:
        """The `source` node hand-added documents point at. Safe to re-run.

        Provenance is `sourced_from` edges, so "how did this get here?" should have
        the same *shape* of answer for a pasted URL as for an arXiv paper. Absence of
        an edge can't be that answer: it reads identically to a bug that dropped one.
        A node makes the claim positively, and makes "things I found by hand" a set
        you can click.

        Deliberately **one shared node, not one per curator.** Which curator added a
        document is `nodes.created_by` -- a hard FK to `users`, written on every node
        already -- and copying that into a source node would duplicate a fact into a
        place that can drift from the one that owns it. Users aren't nodes for a
        reason: the graph describes the *field*, and a curator is who operates the
        tool, not something the guide makes claims about.
        """
        label, url, mechanism = self.MANUAL
        return self.upsert_source(label, url, mechanism=mechanism, actor=actor)

    def list_sources(self, *, enabled_only: bool = False) -> List[Node]:
        sources = self.repo.find_nodes(type=NodeType.SOURCE, limit=10000)
        if enabled_only:
            sources = [s for s in sources if s.attributes.get("enabled", True)]
        return sources

    def feeds(self, *, enabled_only: bool = True) -> List[Node]:
        """Sources Scout should poll: the feeds and index pages, never the search
        APIs (which are sources too, but queried rather than polled) and never the
        manual bucket (which isn't fetchable at all). See `POLLABLE`."""
        return [s for s in self.list_sources(enabled_only=enabled_only)
                if s.attributes.get("mechanism", "rss") in self.POLLABLE]

    def set_enabled(self, source_id: UUID, enabled: bool, *, actor: Actor) -> Node:
        """The durable judgement -- "this is not a source for this guide".

        Distinct from the per-run narrowing in the search picker, which never
        persists. One mechanism can't do both jobs: a per-run choice that stuck would
        make every later run silently narrow, and a narrow run is indistinguishable
        from a quiet literature.
        """
        return self.repo.update_node(
            source_id, attributes_patch={"enabled": enabled}, actor=actor)

    def record_provenance(self, doc_id: UUID, source_ids: Sequence[UUID], *,
                          actor: Actor) -> List[Edge]:
        """Attach `sourced_from` edges: how this document reached us.

        Several are normal and are the reason this is edges rather than a string -- a
        paper found by both arXiv and a lab's feed has two provenances, and
        "arXiv+lab-feed" is a list pretending to be a scalar.
        """
        edges = []
        for sid in source_ids:
            edges.append(self.repo.add_edge(
                doc_id, sid, EdgeType.SOURCED_FROM, actor=actor))
        return edges

    def provenance_of(self, doc_id: UUID) -> List[Node]:
        """The sources a document came from."""
        return [n for _, n in self.repo.neighbors(
            doc_id, edge_types=[EdgeType.SOURCED_FROM], direction="out")]

    def stats(self, source_id: UUID) -> Dict:
        """How this source has actually performed: produced / accepted / dismissed.

        **Derived, never stored.** A counter incremented at ingest would drift the
        moment a curator re-categorises a document, dismisses one later, or undoes a
        dismissal -- the same trap as `MemberOfAttrs.current` (README TODO #3), and
        the number would be wrong precisely when someone leaned on it to decide
        whether to keep a source.

        `accepted` counts documents filed under at least one concept, which is the
        only durable evidence the curator wanted it. `pending` is the honest third
        bucket: not yet judged, so not evidence either way -- an accept rate that
        counted unreviewed documents as rejections would condemn a good source that
        simply arrived last night.
        """
        # `include_deleted` is load-bearing: dismissing a document soft-deletes it
        # and cascades to its `sourced_from` edge, so the default live-only view
        # would report a source that produced nothing but rejects as flawless.
        docs = [n for _, n in self.repo.neighbors(
            source_id, edge_types=[EdgeType.SOURCED_FROM], direction="in",
            include_deleted=True)]

        accepted = dismissed = pending = 0
        for d in docs:
            if d.attributes.get("dismissed"):
                dismissed += 1
            elif d.attributes.get("status") == "reviewed":
                accepted += 1
            else:
                pending += 1

        judged = accepted + dismissed
        return {
            "produced": len(docs),
            "accepted": accepted,
            "dismissed": dismissed,
            "pending": pending,
            # None rather than 0 when nothing has been judged: "no opinion yet" and
            # "everything was rejected" must not render the same.
            "accept_rate": (accepted / judged) if judged else None,
        }


class PeopleService:
    """Researchers, organizations, and the edges among them (affiliation, funding)."""

    def __init__(self, repo: GraphRepository):
        self.repo = repo
        self.integrity = GraphIntegrity(repo)

    def upsert_person(self, full_name: str, *, orcid: Optional[str] = None,
                      actor: Actor) -> Node:
        """Find-or-create a person. Dedups on ORCID when given, else exact name.

        The ORCID is normalized first, so the id a curator types and the URL OpenAlex
        sends resolve to the same person rather than to two.
        """
        orcid = normalize_orcid(orcid)
        if orcid:
            found = self.repo.find_nodes(
                type=NodeType.PERSON, attr_filters={"orcid": orcid}, limit=1)
            if found:
                return found[0]
        found = self.repo.find_nodes(
            type=NodeType.PERSON, attr_filters={"full_name": full_name}, limit=1)
        if found:
            return found[0]
        attrs: Dict = {"full_name": full_name}
        if orcid:
            attrs["orcid"] = orcid
        return self.repo.add_node(NodeType.PERSON, full_name, attrs, actor)

    def set_authors(self, doc_id: UUID, author_ids: Sequence[UUID], *,
                    no_named_author: bool = False, actor: Actor) -> List[Edge]:
        """Reconcile a document's `authored_by` edges to exactly `person_ids`.

        The counterpart to `set_concepts`, and deliberately the same shape: the
        curator hands over the full set they want, not a delta, so the UI never has
        to compute one and two curators can't disagree about what "remove" meant.
        `link_authors` only ever adds, which is right for ingestion (scraped names
        accumulate) and wrong for editing.

        `author_ids` may name **people or organizations**: an institutional report
        is authored by the organization, and that is an attribution rather than the
        absence of one. `no_named_author` is reserved for the genuinely anonymous
        case -- nobody named, and no organization publishing it either -- which is a
        different state from "nobody has filled this in yet" (see
        `DocumentAttrs.no_named_author`). Setting it alongside any author is a
        contradiction and is refused.

        **This consumes the document's outstanding author proposals.** Scraped
        authors are credited by DEFAULT, so by the time Save reaches here every one
        of them is either named in `author_ids` or was taken off on purpose -- there
        is no undecided third state left to preserve. Emptying
        `proposed_author_names` is what makes a rejection stick: the name is no
        longer derivable, so it is not offered again on this document, including
        after the document returns to the review queue. It stays proposed on every
        other document that scraped it, because the list belongs to this document.
        """
        if no_named_author and author_ids:
            raise ValueError(
                "a document cannot both have named authors and have no named author")

        current = {n.id: e for e, n in self.repo.neighbors(
            doc_id, edge_types=[EdgeType.AUTHORED_BY], direction="out")}
        wanted = list(dict.fromkeys(author_ids))     # dedup, keep order

        for pid, edge in current.items():
            if pid not in wanted:
                self.repo.soft_delete_edge(edge.id, actor)

        added = [self.repo.add_edge(doc_id, pid, EdgeType.AUTHORED_BY, actor=actor)
                 for pid in wanted if pid not in current]

        self.repo.update_node(
            doc_id, attributes_patch={"no_named_author": bool(no_named_author),
                                      "proposed_author_names": []},
            actor=actor)
        return added

    def attribution_of(self, doc_id: UUID) -> Dict:
        """Who a document is attributed to, and whether that's settled.

        `state` is the part a gate should read:
          * `attributed` -- has at least one author
          * `none`       -- explicitly marked as having no byline
          * `missing`    -- nobody has said either way, so it's unfinished

        Derived on every read rather than stored: authorship changes by adding and
        removing edges, and a cached status would go stale the moment it did.
        """
        credited = [n for _, n in self.repo.neighbors(
            doc_id, edge_types=[EdgeType.AUTHORED_BY], direction="out")]
        authors = [n for n in credited if n.type == NodeType.PERSON.value]
        # An organization credited directly is the *author* of a corporate document,
        # not an affiliation of one.
        corporate = [n for n in credited if n.type == NodeType.ORGANIZATION.value]
        doc = self.repo.get_node(doc_id)
        marked = bool(doc and doc.attributes.get("no_named_author"))

        # Affiliations are reached *through* the people -- there is no separate
        # document -> organization affiliation edge -- so a document has no
        # affiliation of its own to be missing, only its authors do.
        affiliations = self.repo.follow(
            doc_id, [(EdgeType.AUTHORED_BY, "out"), (EdgeType.MEMBER_OF, "out")]
        ) if authors else []
        by_id = {o.id: o for o in corporate + affiliations}

        return {
            "authors": authors,
            "corporate_authors": corporate,
            "organizations": list(by_id.values()),
            "state": ("attributed" if credited
                      else "none" if marked else "missing"),
            # An author with no affiliation is normal and not an error; surfaced so
            # the UI can show it without treating it as unfinished work.
            "authors_without_org": [
                a.label for a in authors
                if not self.repo.follow(a.id, [(EdgeType.MEMBER_OF, "out")])
            ],
        }

    def upsert_org(self, name: str, *, kind: str = "institution",
                   actor: Actor) -> Node:
        """Find-or-create an organization, dedup on exact name (the node label)."""
        found = self.repo.find_nodes(type=NodeType.ORGANIZATION, label=name, limit=1)
        if found:
            return found[0]
        return self.repo.add_node(NodeType.ORGANIZATION, name, {"kind": kind}, actor)

    def update_person(self, person_id: UUID, *, full_name: Optional[str] = None,
                      orcid: Optional[str] = None, homepage: Optional[str] = None,
                      actor: Actor) -> Node:
        """Correct a person. Patch semantics: an omitted field is left alone, and ""
        clears the optional ones.

        `full_name` and the node label are ONE fact, so they move together -- the
        label is what every chip, search result and pivot row renders, and letting
        them diverge would show two names for one person depending on where you
        looked. A blank name is refused for the same reason `update_title` refuses
        one: it's always a slip, never an intention.

        Renaming here is graph-wide and that is the intent: a person credited on
        eleven documents is one node, so fixing "L. V. Hills" fixes all eleven. The
        UI says so, because from inside one document it could easily read as local.
        """
        node = self.repo.get_node(person_id)
        if node is None or node.type != NodeType.PERSON.value:
            raise ValueError(f"{person_id} is not a person")
        patch: Dict = {}
        label = None
        if full_name is not None:
            name = full_name.strip()
            if not name:
                raise ValueError("full_name cannot be blank")
            patch["full_name"] = name
            label = name
        if orcid is not None:
            patch["orcid"] = normalize_orcid(orcid)
        if homepage is not None:
            patch["homepage"] = homepage.strip() or None
        if not patch and label is None:
            return node
        return self.repo.update_node(person_id, label=label,
                                     attributes_patch=patch, actor=actor)

    def update_org(self, org_id: UUID, *, name: Optional[str] = None,
                   kind: Optional[str] = None, homepage: Optional[str] = None,
                   actor: Actor) -> Node:
        """Correct an organization. Same patch semantics as `update_person`; the name
        is the label here, with no separate attribute to keep in step."""
        node = self.repo.get_node(org_id)
        if node is None or node.type != NodeType.ORGANIZATION.value:
            raise ValueError(f"{org_id} is not an organization")
        patch: Dict = {}
        label = None
        if name is not None:
            if not name.strip():
                raise ValueError("name cannot be blank")
            label = name.strip()
        if kind is not None:
            patch["kind"] = kind
        if homepage is not None:
            patch["homepage"] = homepage.strip() or None
        if not patch and label is None:
            return node
        return self.repo.update_node(org_id, label=label,
                                     attributes_patch=patch, actor=actor)

    def _set_links(self, node_id: UUID, targets: Sequence[UUID],
                   edge_type: EdgeType, *, actor: Actor) -> List[Edge]:
        """See `_reconcile_links`. Same shape as `set_authors`, and shared with
        ArtifactService."""
        return _reconcile_links(self.repo, node_id, targets, edge_type, actor=actor)

    def set_affiliations(self, person_id: UUID, org_ids: Sequence[UUID], *,
                         actor: Actor) -> List[Edge]:
        """Where a person is a member. Set semantics -- pass [] to clear."""
        return self._set_links(person_id, org_ids, EdgeType.MEMBER_OF, actor=actor)

    def set_writes_at_sources(self, entity_id: UUID, source_ids: Sequence[UUID], *,
                              actor: Actor) -> List[Edge]:
        """Where a person or organization writes. Set semantics -- pass [] to clear."""
        return self._set_links(entity_id, source_ids, EdgeType.WRITES_AT, actor=actor)

    def entity_detail(self, node_id: UUID) -> Dict:
        """A person or organization with everything the node card shows: where they
        work, where they write, and what they're credited on.

        Derived per read, never stored -- the same rule `attribution_of` follows. The
        credited documents in particular are just the `authored_by` edges read
        backwards, and caching a count on the node would be a second representation
        free to drift from the edges that define it.
        """
        node = self.repo.get_node(node_id)
        if node is None or node.type not in (NodeType.PERSON.value,
                                             NodeType.ORGANIZATION.value):
            raise ValueError(f"{node_id} is not a person or organization")
        return {
            "node": node,
            "affiliations": [n for _e, n in self.repo.neighbors(
                node_id, edge_types=[EdgeType.MEMBER_OF], direction="out")],
            "writes_at": [n for _e, n in self.repo.neighbors(
                node_id, edge_types=[EdgeType.WRITES_AT], direction="out")],
            "documents": [n for _e, n in self.repo.neighbors(
                node_id, edge_types=[EdgeType.AUTHORED_BY], direction="in")],
        }

    def retype_entity(self, node_id: UUID, to_type: NodeType, *, actor: Actor) -> Node:
        """Correct a person into an organization, or the reverse.

        The curator decides an entity's kind at creation, from a name alone, and a
        name does not always say -- "Center for Humane Technology" reads as a person
        to anything that only sees a string. So the decision has to be reversible,
        and reversible *in place*: delete-and-recreate would take the `authored_by`
        edges with it, which are the whole reason the node is worth correcting rather
        than abandoning.

        Attributes that mean nothing under the new type are dropped, because they
        genuinely stop being true -- an organization has no ORCID. `homepage` carries
        over, being the one field both schemas share.

        **Incident edges are checked first and the whole thing is refused if any
        would become illegal** -- a person's `member_of` cannot survive them becoming
        an organization, since `member_of` runs person -> organization. Refusing
        beats silently dropping the edge: the curator is correcting a mistake, and
        answering with a quiet second data loss is no answer. The error names the
        edges, so removing them and retrying is a decision made with eyes open.
        """
        node = self.repo.get_node(node_id)
        if node is None:
            raise ValueError(f"{node_id} not found")
        if to_type not in (NodeType.PERSON, NodeType.ORGANIZATION):
            raise ValueError("can only retype between person and organization")
        if node.type == to_type.value:
            return node

        blocked = []
        for edge, other in self.repo.neighbors(node_id):
            spec = EDGE_TYPES[EdgeType(edge.type)]
            # This node's end takes the new type; the far end keeps its own.
            outgoing = edge.source_id == node_id
            s = to_type if outgoing else NodeType(other.type)
            t = NodeType(other.type) if outgoing else to_type
            if s not in spec.sources or t not in spec.targets:
                arrow = (f"{node.label} -{edge.type}-> {other.label}" if outgoing
                         else f"{other.label} -{edge.type}-> {node.label}")
                blocked.append(arrow)
        if blocked:
            raise ValueError(
                f"cannot retype: these edges would become invalid -- "
                f"{'; '.join(blocked)}. Remove them first.")

        if to_type == NodeType.ORGANIZATION:
            attrs = {"kind": "institution", "homepage": node.attributes.get("homepage")}
        else:
            attrs = {"full_name": node.label,
                     "homepage": node.attributes.get("homepage")}
        return self.repo.retype_node(node_id, to_type, attrs, actor)

    def set_affiliation(self, person_id: UUID, org_id: UUID, *,
                        role: Optional[str] = None, start: Optional[str] = None,
                        end: Optional[str] = None, actor: Actor) -> Edge:
        """Record that a person is/was a member of an org. `current` is inferred
        from the absence of an end date."""
        return self.repo.add_edge(
            person_id, org_id, EdgeType.MEMBER_OF,
            {"role": role, "start": start, "end": end, "current": end is None},
            actor=actor)

    def set_writes_at(self, entity_id: UUID, source_id: UUID, *,
                      role: Optional[str] = None, start: Optional[str] = None,
                      end: Optional[str] = None, actor: Actor) -> Edge:
        """Record that a person OR an organization writes at a source.

        "This entity writes at this location" is the whole meaning. An earlier
        version reserved the edge for people, on the reading that an organization
        "publishes" rather than "writes for" -- which made the obvious thing
        impossible and bought no clarity. `part_of` still says something else: that
        an org *contains* a source.

        Whether they *still* write there is read off `end`, deliberately:
        `WritesAtAttrs` has no stored `current` flag, unlike `MemberOfAttrs`, and
        reintroducing one would be a second representation of the same fact, free to
        drift from the dates beside it.
        """
        return self.repo.add_edge(
            entity_id, source_id, EdgeType.WRITES_AT,
            {"role": role, "start": start, "end": end}, actor=actor)

    def nest_org(self, child_id: UUID, parent_id: UUID, *, actor: Actor) -> Edge:
        # Org nesting has the same cycle problem as the concept hierarchy: an org
        # cannot contain itself, directly or through a chain.
        self.integrity.check_edge(child_id, parent_id, EdgeType.PART_OF)
        return self.repo.add_edge(child_id, parent_id, EdgeType.PART_OF, actor=actor)

    def record_funding(self, funder_id: UUID, fundee_id: UUID, *,
                       amount: Optional[float] = None, currency: str = "USD",
                       year: Optional[int] = None, note: Optional[str] = None,
                       actor: Actor) -> Edge:
        """A funder (person or org) funds a fundee (person or org)."""
        return self.repo.add_edge(
            funder_id, fundee_id, EdgeType.FUNDS,
            {"amount": amount, "currency": currency, "year": year, "note": note},
            actor=actor)


class GraphQueryService:
    """Read-only views assembled for the UIs. No mutations, no Actor."""

    def __init__(self, repo: GraphRepository):
        self.repo = repo

    def ontology_map(self) -> Graph:
        """The viewer's default: all concepts plus their structural edges only."""
        concepts = self.repo.find_nodes(type=NodeType.CONCEPT, limit=10000)
        edges = self.repo.find_edges(types=ONTOLOGY_EDGE_TYPES)
        return Graph(nodes=concepts, edges=edges)

    def full_graph(self) -> Graph:
        """Every live node and edge -- what the pivot tables are derived from.

        `ontology_map` is concepts + structural edges only, so no `about`,
        `authored_by` or `funds` edge reaches the client through it -- and every
        pivot cell is built from `about`. Hence the whole graph rather than a
        server-computed pivot: at curator scale the payload is small, and the
        derivation stays pure and client-side where it can be reasoned about (same
        bet as ontologyTable.ts). The tripwire for moving pivots into SQL is
        payload size, not elegance.

        Unreviewed documents are absent, because `find_nodes` cannot return them
        (repository.APPROVED_ONLY). Nothing here changes as a result -- a pending
        document has no `about` edges by construction, so it never contributed to a
        pivot cell -- but the curator's canvas no longer holds nodes the curator has
        not approved, which is the point.
        """
        return Graph(nodes=self.repo.find_nodes(limit=10000),
                     edges=self.repo.find_edges())

    def public_graph(self) -> Dict:
        """The READER projection: the whole live graph MINUS artifacts, PLUS public
        `note` artifacts and the `remarks_on`/`cites` edges connecting them.

        This is the seam between the two audiences. Everything a curator built about
        the *field* is public -- a concept's description, a document's summary, who
        wrote it -- so the field nodes and every edge among them pass through. The one
        private layer is the curator's own voice, the artifacts, and only the ones
        published (`visibility == public`) appear, with only their artifact-anchored
        edges.

        Fails closed by construction: field nodes are enumerated and artifacts are
        added back by an explicit public-only filter, rather than the whole graph
        being returned and private things subtracted. A new artifact is invisible
        until it opts in, never visible until someone remembers to hide it.

        That reasoning was for a while applied only to artifacts, and documents --
        whose admission to the guide is equally conditional -- shipped to readers
        while still unreviewed. They are now excluded one layer down, by
        `find_nodes` (repository.APPROVED_ONLY), so this method never sees one.
        Their incident edges need no handling of their own: `visible_ids` is built
        from `field_nodes`, and a field edge survives only when both ends are in it.
        The
        attribute-level projection (a document's `status`, a source's `notes`) is the
        read serializer's job via types.public_node_attrs -- this method decides which
        nodes and edges exist for a reader, not which of their fields show.
        """
        all_nodes = self.repo.find_nodes(limit=10000)
        field_nodes = [n for n in all_nodes if n.type != NodeType.ARTIFACT.value]
        public_arts = [n for n in all_nodes
                       if n.type == NodeType.ARTIFACT.value and reader_visible(n)]

        public_art_ids = {n.id for n in public_arts}
        visible_ids = {n.id for n in field_nodes} | public_art_ids
        anchored = {EdgeType.REMARKS_ON.value, EdgeType.CITES.value}

        edges = []
        for e in self.repo.find_edges():
            if e.type in anchored:
                # Artifact-anchored: keep only from a PUBLIC artifact to a visible
                # node. This is what drops a private draft's subjects and citations.
                if e.source_id in public_art_ids and e.target_id in visible_ids:
                    edges.append(e)
            elif e.source_id in visible_ids and e.target_id in visible_ids:
                edges.append(e)   # a field edge; both ends are public by definition
        return {"field_nodes": field_nodes, "artifacts": public_arts, "edges": edges}

    def concept_detail(self, concept_id: UUID) -> Dict:
        """One concept with everything hanging off it: documents, people, neighbors."""
        concept = _require_type(
            self.repo.get_node(concept_id), NodeType.CONCEPT, "concept")
        pairs = self.repo.neighbors(concept_id)
        documents = [n for e, n in pairs if e.type == EdgeType.ABOUT.value]
        people = [n for e, n in pairs if e.type == EdgeType.WORKS_ON.value]
        related = [(e, n) for e, n in pairs if e.type in {t.value for t in ONTOLOGY_EDGE_TYPES}]
        return {"concept": concept, "documents": documents,
                "people": people, "related": related}

    def review_queue(self) -> List[Node]:
        """Documents awaiting curator review, oldest first.

        The one screen that is *about* unapproved documents, so it is the one read
        that asks for them by name (`repo.pending_documents`). Every other read in
        this service goes through `find_nodes`, which cannot see them at all.
        """
        return self.repo.pending_documents(limit=1000)


def _scraped_authors(raw) -> List[Dict]:
    """Coerce whatever a caller calls "authors" into `[{name, orcid}]`.

    Two callers, two shapes, and both are legitimate: the discovery path hands over
    dicts carrying ORCIDs from OpenAlex, while `ingest_urls` and the page scraper
    have only names. Accepting both HERE, at the single write, is what keeps the
    stored attribute to one shape -- the alternative was every reader knowing that
    an author might be a string.

    ORCIDs are normalized on the way in (`https://orcid.org/X` and `X` are the same
    id), so a comparison downstream is plain equality and never has to care which
    API produced the record.
    """
    out: List[Dict] = []
    for a in (raw or []):
        if isinstance(a, dict):
            name, orcid = (a.get("name") or "").strip(), a.get("orcid")
        else:
            name, orcid = str(a).strip(), None
        if name:
            out.append({"name": name, "orcid": normalize_orcid(orcid)})
    return out


def _infer_source_type(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if host == "substack.com" or host.endswith(".substack.com"):
        return "substack"
    return "journal"
