"""GraphRepository: raw node/edge CRUD and graph traversal over Postgres.

This is the only layer that talks SQL. Everything above it (the future
Ontology/Ingestion/People services) composes these primitives. Two invariants:

  * Every write validates its attributes/endpoints via graph.types before hitting
    the DB, and records a `revisions` row in the SAME transaction as the change,
    so the audit log can never drift from reality.
  * Reads never return soft-deleted rows unless you ask (include_deleted=True).

Caveat where those two meet. Revision snapshots are opaque jsonb: _as_snapshot
writes them and nothing reads them back (the only reader in the tree counts rows
by action). That is fine while they are an audit trail. But graph.types sets
extra="forbid", so the day anything *replays* a snapshot through update_node -- a
revert-to-revision-N feature, say -- every attribute removed since that revision
was written will fail validation. Dropping a field from a NodeAttrs model quietly
makes every earlier revision unreplayable. `review_note` was removed this way and
its key still sits in older document snapshots. That's correct for a log (it
records what was true then), and a landmine for a replayer.
"""

from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .models import Actor, Edge, Graph, Node
from .types import EDGE_TYPES, EdgeType, NodeType, validate_edge, validate_node_attrs


class NodeNotFound(Exception):
    pass


# The property graph holds APPROVED material only. A document is approved when the
# curator has filed it under at least one concept, which derives status 'reviewed'
# (IngestionService._sync_status); until then it exists solely so the review queue
# has something to show, and nothing may treat it as part of the guide.
#
# This is a domain rule sitting in the SQL layer, deliberately, and it is the one
# exception to "the repository carries no domain rules". The rule it replaced was
# "every caller remembers to filter", which is the design that let an unreviewed
# document reach the artifact subject picker, the citation picker, and the READER
# projection all at once. A rule enforced at the two general query surfaces cannot
# be forgotten by a seam written later; a convention can. It is the same shape as
# `deleted_at is null`, which this layer already applies with no way to opt out.
#
# There is deliberately NO parameter to disable it. The three internal callers that
# must see the queue -- dedup at ingest, Scout's known-URL set, and the queue
# itself -- use the narrow, purpose-named methods (`document_by_url`,
# `document_urls`, `pending_documents`), each of which does one job and cannot be
# widened into a general query. A flag would put the decision back at the call site,
# which is where it goes wrong.
#
# Long term this constraint should not be needed at all: unapproved documents
# should not be in `nodes` in the first place. See README TODO #1 (staging).
APPROVED_ONLY = "(type <> 'document' or attributes->>'status' = 'reviewed')"


def _node(row: Dict) -> Node:
    return Node(**row)


def _edge(row: Dict) -> Edge:
    return Edge(**row)


class GraphRepository:
    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    # -- internal ----------------------------------------------------------

    def _cur(self):
        return self.conn.cursor(row_factory=dict_row)

    def _record_revision(self, cur, entity, entity_id, action, before, after, actor):
        # txid_current() groups every write of one DB transaction under one id, so
        # undo can reverse a whole action (e.g. a cascade delete) as a unit.
        cur.execute(
            """insert into revisions (entity, entity_id, action, before, after, actor, txid)
               values (%s, %s, %s, %s, %s, %s, txid_current())""",
            (entity, entity_id, action,
             Jsonb(before) if before is not None else None,
             Jsonb(after) if after is not None else None,
             actor.id),
        )

    # -- nodes -------------------------------------------------------------

    def add_node(self, type: NodeType, label: str, attributes: Dict, actor: Actor) -> Node:
        clean = validate_node_attrs(type, attributes)
        with self.conn.transaction(), self._cur() as cur:
            cur.execute(
                """insert into nodes (type, label, attributes, created_by)
                   values (%s, %s, %s, %s) returning *""",
                (type.value, label, Jsonb(clean), actor.id),
            )
            node = _node(cur.fetchone())
            self._record_revision(cur, "node", node.id, "create", None,
                                   _as_snapshot(node), actor)
        return node

    def get_node(self, node_id: UUID, include_deleted: bool = False) -> Optional[Node]:
        sql = "select * from nodes where id = %s"
        if not include_deleted:
            sql += " and deleted_at is null"
        with self._cur() as cur:
            cur.execute(sql, (node_id,))
            row = cur.fetchone()
        return _node(row) if row else None

    def update_node(self, node_id: UUID, *, label: Optional[str] = None,
                    attributes_patch: Optional[Dict] = None,
                    attributes: Optional[Dict] = None, actor: Actor) -> Node:
        """Rename and/or change attributes. The result is re-validated as a whole, so
        neither form can push a node into an invalid shape.

        `attributes_patch` shallow-merges and is what nearly every caller wants.
        `attributes` REPLACES the set outright, which is the only way to *remove* a
        key -- a merge can set one to null but never make it absent, and under
        `extra="forbid"` a field dropped from the schema then fails validation
        forever. Schema migrations need exactly that; ordinary edits do not, which is
        why the patch form stays the default. Passing both is a contradiction.
        """
        if attributes_patch is not None and attributes is not None:
            raise ValueError("pass attributes_patch or attributes, not both")
        with self.conn.transaction(), self._cur() as cur:
            cur.execute("select * from nodes where id = %s and deleted_at is null "
                        "for update", (node_id,))
            row = cur.fetchone()
            if not row:
                raise NodeNotFound(str(node_id))
            before = _node(row)

            new_label = label if label is not None else before.label
            new_attrs = before.attributes
            if attributes is not None:
                new_attrs = validate_node_attrs(NodeType(before.type), attributes)
            elif attributes_patch:
                merged = {**before.attributes, **attributes_patch}
                new_attrs = validate_node_attrs(NodeType(before.type), merged)

            cur.execute(
                """update nodes set label = %s, attributes = %s, updated_at = now()
                   where id = %s returning *""",
                (new_label, Jsonb(new_attrs), node_id),
            )
            after = _node(cur.fetchone())
            self._record_revision(cur, "node", node_id, "update",
                                  _as_snapshot(before), _as_snapshot(after), actor)
        return after

    def retype_node(self, node_id: UUID, new_type: NodeType, attributes: Dict,
                    actor: Actor) -> Node:
        """Change a node's *type*, replacing its attributes to match the new schema.

        The one structural edit that keeps a node's identity: the id doesn't move, so
        every edge, revision and reference survives. That's the point -- correcting a
        thing wrongly created as a person into an organization must not orphan the
        documents already credited to it.

        Attributes are REPLACED rather than merged, because the two schemas barely
        overlap: `full_name`/`orcid`/`aliases` mean nothing on an organization, `kind`
        means nothing on a person, and `extra="forbid"` would reject either set under
        the other. The caller decides what carries over (see
        `PeopleService.retype_entity`); this only executes it.

        Deliberately does NOT check incident edges. Whether `member_of` still makes
        sense after the endpoints change is a graph question, and graph questions
        live one layer up where the edges can be read and reported on -- refusing
        here, mid-write, could only raise, and "which edges" is the useful answer.
        """
        with self.conn.transaction(), self._cur() as cur:
            cur.execute("select * from nodes where id = %s and deleted_at is null "
                        "for update", (node_id,))
            row = cur.fetchone()
            if not row:
                raise NodeNotFound(str(node_id))
            before = _node(row)
            new_attrs = validate_node_attrs(new_type, attributes)
            cur.execute(
                """update nodes set type = %s, attributes = %s, updated_at = now()
                   where id = %s returning *""",
                (new_type.value, Jsonb(new_attrs), node_id),
            )
            after = _node(cur.fetchone())
            self._record_revision(cur, "node", node_id, "update",
                                  _as_snapshot(before), _as_snapshot(after), actor)
        return after

    def soft_delete_node(self, node_id: UUID, actor: Actor) -> None:
        with self.conn.transaction(), self._cur() as cur:
            cur.execute("select * from nodes where id = %s and deleted_at is null",
                        (node_id,))
            row = cur.fetchone()
            if not row:
                raise NodeNotFound(str(node_id))
            cur.execute("update nodes set deleted_at = now() where id = %s", (node_id,))
            self._record_revision(cur, "node", node_id, "delete",
                                  _as_snapshot(_node(row)), None, actor)

    def delete_nodes_cascade(self, node_ids: Sequence[UUID],
                             requeue_doc_ids: Sequence[UUID], actor: Actor) -> None:
        """Soft-delete a set of nodes AND every live edge incident to them, then
        flip the given documents back to `pending` -- all in one transaction.

        Cascading to edges is not optional: `find_edges` returns every live edge
        regardless of whether its endpoints are alive, so a node deleted without its
        edges hands the client an edge pointing at a vanished node. The re-queue is
        folded in here rather than done as a follow-up write so the whole concept
        deletion is atomic: either the concepts go and their now-orphaned documents
        return to the queue together, or nothing does. The caller (OntologyService)
        decides *which* nodes and documents; this only executes the plan.
        """
        ids = list(node_ids)
        with self.conn.transaction(), self._cur() as cur:
            cur.execute(
                """select * from edges
                   where (source_id = any(%s) or target_id = any(%s))
                     and deleted_at is null
                   for update""",
                (ids, ids),
            )
            for row in cur.fetchall():
                edge = _edge(row)
                cur.execute("update edges set deleted_at = now() where id = %s",
                            (edge.id,))
                self._record_revision(cur, "edge", edge.id, "delete",
                                      _as_snapshot(edge), None, actor)

            for nid in ids:
                cur.execute("select * from nodes where id = %s and deleted_at is null "
                            "for update", (nid,))
                row = cur.fetchone()
                if not row:
                    continue
                node = _node(row)
                cur.execute("update nodes set deleted_at = now() where id = %s", (nid,))
                self._record_revision(cur, "node", nid, "delete",
                                      _as_snapshot(node), None, actor)

            for did in requeue_doc_ids:
                cur.execute("select * from nodes where id = %s and deleted_at is null "
                            "for update", (did,))
                row = cur.fetchone()
                if not row:
                    continue
                before = _node(row)
                merged = validate_node_attrs(
                    NodeType(before.type), {**before.attributes, "status": "pending"})
                cur.execute(
                    """update nodes set attributes = %s, updated_at = now()
                       where id = %s returning *""",
                    (Jsonb(merged), did),
                )
                after = _node(cur.fetchone())
                self._record_revision(cur, "node", did, "update",
                                      _as_snapshot(before), _as_snapshot(after), actor)

    def restore_node(self, node_id: UUID, actor: Actor) -> Node:
        """Un-delete a soft-deleted node and the edges that went down with it.

        The inverse of `delete_nodes_cascade` for a single node, and what lets a
        deliberate re-add bring a dismissed document *back* instead of standing a
        second one beside a tombstone that still suppresses the URL.

        Which edges come along is decided by **timestamp, not by type**: a cascade
        deletes the edges and the node inside one transaction, so `now()` is the
        transaction clock and every edge it took carries exactly the node's
        `deleted_at`. Restoring only those leaves earlier removals alone -- an
        `about` edge the curator un-assigned last week has a strictly older stamp and
        stays gone, which is right, because that was its own judgement and this
        restore says nothing about it.

        An edge whose *other* endpoint is dead is skipped even so (a concept deleted
        after the document was). `find_edges` returns live edges regardless of
        whether their endpoints live, so restoring one would hand the client an edge
        pointing at a vanished node -- the exact failure the cascade exists to avoid.

        Recorded as a `create` revision, because that is what it is from Undo's point
        of view: reversing a create soft-deletes, which puts the tombstone back.
        """
        with self.conn.transaction(), self._cur() as cur:
            cur.execute("select * from nodes where id = %s and deleted_at is not null "
                        "for update", (node_id,))
            row = cur.fetchone()
            if not row:
                raise NodeNotFound(str(node_id))
            deleted_at = row["deleted_at"]

            cur.execute("update nodes set deleted_at = null, updated_at = now() "
                        "where id = %s returning *", (node_id,))
            node = _node(cur.fetchone())
            self._record_revision(cur, "node", node_id, "create",
                                  None, _as_snapshot(node), actor)

            # The node is live again by now, so the endpoint checks below see it.
            cur.execute(
                """select e.* from edges e
                     join nodes s on s.id = e.source_id
                     join nodes t on t.id = e.target_id
                    where (e.source_id = %s or e.target_id = %s)
                      and e.deleted_at = %s
                      and s.deleted_at is null and t.deleted_at is null
                    for update of e""",
                (node_id, node_id, deleted_at),
            )
            for erow in cur.fetchall():
                cur.execute("update edges set deleted_at = null where id = %s "
                            "returning *", (erow["id"],))
                edge = _edge(cur.fetchone())
                self._record_revision(cur, "edge", edge.id, "create",
                                      None, _as_snapshot(edge), actor)
        return node

    def find_nodes(self, *, type: Optional[NodeType] = None,
                   label: Optional[str] = None,
                   attr_filters: Optional[Dict[str, str]] = None,
                   limit: int = 100, offset: int = 0) -> List[Node]:
        """List live nodes, optionally filtered by type, exact label, and exact
        attribute matches (attr_filters values are compared as text via
        attributes->>key).

        **Unreviewed documents are never returned** -- see APPROVED_ONLY. There is
        no parameter to switch that off; the three internal callers that must see
        the queue use the narrow methods below.
        """
        clauses = ["deleted_at is null", APPROVED_ONLY]
        params: List = []
        if type is not None:
            clauses.append("type = %s")
            params.append(type.value)
        if label is not None:
            clauses.append("label = %s")
            params.append(label)
        for key, val in (attr_filters or {}).items():
            clauses.append("attributes->>%s = %s")
            params.extend([key, val])
        params.extend([limit, offset])
        with self._cur() as cur:
            cur.execute(
                f"select * from nodes where {' and '.join(clauses)} "
                f"order by created_at limit %s offset %s", params,
            )
            return [_node(r) for r in cur.fetchall()]

    def search_nodes(self, q: str, *, type: Optional[NodeType] = None,
                     limit: int = 20) -> List[Node]:
        """Live nodes whose label contains `q`, case-insensitively.

        Separate from `find_nodes` rather than another parameter on it: that one
        matches EXACTLY, everywhere, and its callers depend on that -- `label=` there
        is how a lookup asserts identity. Silently widening it to a substring match
        would turn every one of those lookups into a fuzzy one.

        Deliberately not full-text: this exists for a picker, where the curator is
        typing the title of a document they already have in mind and needs the top
        few hits as they type. `ilike` is the right amount of machinery for that, and
        the alternative (tsvector, ranking, an index to maintain) buys nothing until
        someone is searching prose they can't remember.

        **Unreviewed documents are never returned** -- see APPROVED_ONLY. Every
        caller of this is a picker, and a picker is exactly where an unapproved
        document must not appear.
        """
        needle = f"%{(q or '').strip()}%"
        clauses = ["deleted_at is null", APPROVED_ONLY, "label ilike %s"]
        params: List = [needle]
        if type is not None:
            clauses.append("type = %s")
            params.append(type.value)
        params.append(limit)
        with self._cur() as cur:
            cur.execute(
                f"select * from nodes where {' and '.join(clauses)} "
                f"order by length(label), label limit %s", params,
            )
            return [_node(r) for r in cur.fetchall()]

    def documents_by_author(self, q: str, *, limit: int = 20) -> List[Tuple[Node, str]]:
        """Documents whose AUTHOR's name contains `q`, each with the name that matched.

        The link picker's second question. A curator hunting for a paper often
        remembers who wrote it and not what it was called, and a picker that can only
        match titles makes them go and look the title up -- which is the moment the
        thought they were writing down is lost.

        The matched author's label comes back with the document because a hit the
        curator didn't type the words of is baffling on its own: the picker shows it
        as "via Alan Baddeley". Both the person and organization cases fall out of
        `authored_by` for free -- an institutional report is authored by the org.

        Same guarantee as `search_nodes`, applied to the document end: an unreviewed
        paper must not reach a picker by a side door its title couldn't take it
        through. Spelled out (`status = 'reviewed'`) rather than reusing
        APPROVED_ONLY, whose "or not a document" half is dead weight in a query that
        already selects only documents.
        """
        needle = f"%{(q or '').strip()}%"
        with self._cur() as cur:
            cur.execute(
                """select d.*, a.label as via
                      from nodes d
                      join edges e on e.source_id = d.id
                                  and e.type = %s and e.deleted_at is null
                      join nodes a on a.id = e.target_id and a.deleted_at is null
                     where d.type = 'document' and d.deleted_at is null
                       and d.attributes->>'status' = 'reviewed'
                       and a.label ilike %s
                     order by length(d.label), d.label
                     limit %s""",
                (EdgeType.AUTHORED_BY.value, needle, limit),
            )
            return [(_node({k: v for k, v in r.items() if k != "via"}), r["via"])
                    for r in cur.fetchall()]

    def documents_by_publication(self, q: str, *,
                                 limit: int = 20) -> List[Tuple[Node, str]]:
        """Documents whose venue contains `q`, each with the venue that matched.

        The third way a half-remembered paper gets found ("that Nature piece").
        Publication is a string on the document rather than a node -- see
        `IngestionService.update_metadata` for why venue is deliberately not modelled
        -- so this is an attribute match, not a join.
        """
        needle = f"%{(q or '').strip()}%"
        with self._cur() as cur:
            cur.execute(
                """select *, attributes->>'publication' as via
                      from nodes
                     where type = 'document' and deleted_at is null
                       and attributes->>'status' = 'reviewed'
                       and attributes->>'publication' ilike %s
                     order by length(label), label
                     limit %s""",
                (needle, limit),
            )
            return [(_node({k: v for k, v in r.items() if k != "via"}), r["via"])
                    for r in cur.fetchall()]

    # -- the review queue --------------------------------------------------
    #
    # Three narrow reads, and the ONLY way anything sees an unreviewed document.
    # Each answers one question for one caller. They are not a bypass of
    # APPROVED_ONLY so much as the definition of who is allowed to know the queue
    # exists: the queue view, dedup at ingest, and Scout. Keep them boring -- the
    # moment one grows a `type=` or a `label=` it has become `find_nodes` again,
    # and the guarantee is gone.

    def pending_documents(self, *, limit: int = 1000) -> List[Node]:
        """Documents awaiting review, best venue first, then oldest first -- the
        review queue itself.

        The queue is the one screen whose whole purpose is unapproved documents, so
        it is the one read that asks for them by name.

        The ordering is the whole of what a venue tier does (see scout.venue_tier):
        nothing is hidden, the curator just meets the peer-reviewed work first and
        can stop when the returns fade. Untiered documents -- feed posts, pages
        added by hand -- sit BETWEEN journals and preprints, because they come from
        a source the curator chose to follow, which is a judgement a preprint
        carries none of. Within a tier the old order stands, so the queue still
        reads as a queue.
        """
        with self._cur() as cur:
            cur.execute(
                """select * from nodes
                    where type = 'document' and deleted_at is null
                      and attributes->>'status' = 'pending'
                    order by case attributes->>'venue_tier'
                                 when 'journal' then 0
                                 when 'preprint' then 2
                                 else 1 end,
                             created_at
                    limit %s""", (limit,),
            )
            return [_node(r) for r in cur.fetchall()]

    def document_by_url(self, url: str) -> Optional[Node]:
        """The live document at this canonical URL, reviewed or not -- for dedup.

        Must see the queue: `nodes_doc_url_uniq` covers every live document, so an
        ingest that couldn't see a pending one would try to insert a duplicate and
        hit the index instead of recognising the paper it already has.
        """
        with self._cur() as cur:
            cur.execute(
                """select * from nodes
                    where type = 'document' and deleted_at is null
                      and attributes->>'canonical_url' = %s
                    limit 1""", (url,),
            )
            row = cur.fetchone()
            return _node(row) if row else None

    def document_urls(self) -> List[str]:
        """Every live document's canonical URL, reviewed or not -- for Scout.

        Must see the queue for the same reason as `document_by_url`, one step
        earlier: a paper already sitting unreviewed is not a new find, and
        re-surfacing it every run is what the known-URL set exists to prevent.
        """
        with self._cur() as cur:
            cur.execute(
                """select attributes->>'canonical_url' as url from nodes
                    where type = 'document' and deleted_at is null
                      and attributes->>'canonical_url' is not null""",
            )
            return [r["url"] for r in cur.fetchall()]

    def user_handle(self, user_id: UUID) -> Optional[str]:
        """The acting user's display handle, for showing who authored a node.

        The one read of `users` outside auth bootstrapping. Auth doesn't exist yet,
        so this resolves to the single seeded 'curator' -- but `created_by` is a real
        column on every node, and surfacing it now means the multi-user seam is
        already visible in the UI rather than bolted on when auth lands.
        """
        with self._cur() as cur:
            cur.execute("select handle from users where id = %s", (user_id,))
            row = cur.fetchone()
        return row["handle"] if row else None

    def deleted_attr_values(self, type: NodeType, key: str, *,
                            where_flag: Optional[str] = None) -> List[str]:
        """Values of `key` across the SOFT-DELETED nodes of a type.

        The one place we deliberately look at deleted rows. Everything else treats a
        soft-deleted node as gone, which is right for the graph but wrong for
        discovery: a document the curator dismissed must stay dismissed, and the
        only record that it ever existed is its deleted row. Hence tombstones --
        see IngestionService.tombstoned_urls.

        `where_flag` narrows to rows carrying that boolean attribute, which is what
        separates a dismissal from an undone create: undo reverses a create by
        setting `deleted_at`, so row state alone cannot tell the two apart.
        """
        clauses = ["type = %s", "deleted_at is not null", "attributes->>%s is not null"]
        params: List = [key, type.value, key]
        if where_flag is not None:
            clauses.append("attributes->>%s = 'true'")
            params.append(where_flag)
        with self._cur() as cur:
            cur.execute(
                f"select distinct attributes->>%s as v from nodes "
                f"where {' and '.join(clauses)}", params,
            )
            return [r["v"] for r in cur.fetchall()]

    def find_deleted_nodes(self, type: NodeType, attr_filters: Dict, *,
                           where_flag: Optional[str] = None,
                           limit: int = 10) -> List[Node]:
        """Soft-deleted nodes matching attribute equality -- the read that lets a
        tombstone be *acted on* rather than only counted.

        `deleted_attr_values` answers "which URLs are tombstoned?", which is all
        discovery needs in order to skip them. Restoring one needs the row itself.
        Same deliberate exception to "a soft-deleted node is gone", and the same
        `where_flag` narrowing, for the same reason: an undone create is not a
        dismissal.

        Newest first, because a URL can accumulate several deleted rows once it has
        been dismissed, restored and dismissed again -- and the standing judgement is
        the last one.
        """
        clauses = ["type = %s", "deleted_at is not null"]
        params: List = [type.value]
        for key, val in attr_filters.items():
            clauses.append("attributes->>%s = %s")
            params.extend([key, val])
        if where_flag is not None:
            clauses.append("attributes->>%s = 'true'")
            params.append(where_flag)
        params.append(limit)
        with self._cur() as cur:
            cur.execute(f"select * from nodes where {' and '.join(clauses)} "
                        f"order by deleted_at desc limit %s", params)
            return [_node(r) for r in cur.fetchall()]

    # -- edges -------------------------------------------------------------

    def add_edge(self, source_id: UUID, target_id: UUID, type: EdgeType,
                 attributes: Optional[Dict] = None, *, actor: Actor) -> Edge:
        with self.conn.transaction(), self._cur() as cur:
            src = self._require_live_type(cur, source_id)
            tgt = self._require_live_type(cur, target_id)
            clean = validate_edge(type, src, tgt, attributes or {})
            cur.execute(
                """insert into edges (source_id, target_id, type, attributes, created_by)
                   values (%s, %s, %s, %s, %s) returning *""",
                (source_id, target_id, type.value, Jsonb(clean), actor.id),
            )
            edge = _edge(cur.fetchone())
            self._record_revision(cur, "edge", edge.id, "create", None,
                                  _as_snapshot(edge), actor)
        return edge

    def get_edge(self, edge_id: UUID, include_deleted: bool = False) -> Optional[Edge]:
        sql = "select * from edges where id = %s"
        if not include_deleted:
            sql += " and deleted_at is null"
        with self._cur() as cur:
            cur.execute(sql, (edge_id,))
            row = cur.fetchone()
        return _edge(row) if row else None

    def soft_delete_edge(self, edge_id: UUID, actor: Actor) -> None:
        with self.conn.transaction(), self._cur() as cur:
            cur.execute("select * from edges where id = %s and deleted_at is null",
                        (edge_id,))
            row = cur.fetchone()
            if not row:
                return
            cur.execute("update edges set deleted_at = now() where id = %s", (edge_id,))
            self._record_revision(cur, "edge", edge_id, "delete",
                                  _as_snapshot(_edge(row)), None, actor)

    def find_edges(self, *, types: Optional[Iterable[EdgeType]] = None) -> List[Edge]:
        """All live edges, optionally restricted to a set of types. The type filter
        with ONTOLOGY_EDGE_TYPES is exactly the viewer's default ontology map."""
        clauses = ["deleted_at is null"]
        params: List = []
        if types is not None:
            clauses.append("type = any(%s)")
            params.append([t.value for t in types])
        with self._cur() as cur:
            cur.execute(f"select * from edges where {' and '.join(clauses)} "
                        f"order by created_at", params)
            return [_edge(r) for r in cur.fetchall()]

    def _require_live_type(self, cur, node_id: UUID) -> NodeType:
        cur.execute("select type from nodes where id = %s and deleted_at is null",
                    (node_id,))
        row = cur.fetchone()
        if not row:
            raise NodeNotFound(str(node_id))
        return NodeType(row["type"])

    # -- traversal ---------------------------------------------------------

    def neighbors(self, node_id: UUID, *, edge_types: Optional[Iterable[EdgeType]] = None,
                  direction: str = "both",
                  include_deleted: bool = False) -> List[Tuple[Edge, Node]]:
        """(edge, neighbor) pairs one hop from node_id. direction is
        'out' (node is source), 'in' (node is target), or 'both'.

        `include_deleted` also returns soft-deleted neighbours and soft-deleted
        edges. Needed to see the *whole* history of a relationship rather than its
        surviving part: dismissing a document soft-deletes it and cascades to every
        incident edge, so a source's dismissed documents are invisible by default --
        which would make an accept rate computed from the live graph read as though
        nothing was ever rejected.
        """
        if direction == "out":
            edge_pred = "e.source_id = %(id)s"
        elif direction == "in":
            edge_pred = "e.target_id = %(id)s"
        else:
            edge_pred = "(e.source_id = %(id)s or e.target_id = %(id)s)"

        params: Dict = {"id": node_id}
        type_pred = ""
        if edge_types is not None:
            type_pred = "and e.type = any(%(etypes)s)"
            params["etypes"] = [t.value for t in edge_types]

        node_live = "" if include_deleted else "and n.deleted_at is null"
        edge_live = "" if include_deleted else "and e.deleted_at is null"
        with self._cur() as cur:
            cur.execute(
                f"""select e.*,
                           n.id as n_id, n.type as n_type, n.label as n_label,
                           n.attributes as n_attributes, n.created_by as n_created_by,
                           n.created_at as n_created_at, n.updated_at as n_updated_at,
                           n.deleted_at as n_deleted_at
                    from edges e
                    join nodes n on n.id = case when e.source_id = %(id)s
                                                then e.target_id else e.source_id end
                                 {node_live}
                    where {edge_pred} {edge_live} {type_pred}
                    order by e.created_at""",
                params,
            )
            out = []
            for r in cur.fetchall():
                neighbor = Node(
                    id=r["n_id"], type=r["n_type"], label=r["n_label"],
                    attributes=r["n_attributes"], created_by=r["n_created_by"],
                    created_at=r["n_created_at"], updated_at=r["n_updated_at"],
                    deleted_at=r["n_deleted_at"],
                )
                edge = Edge(
                    id=r["id"], source_id=r["source_id"], target_id=r["target_id"],
                    type=r["type"], attributes=r["attributes"],
                    created_by=r["created_by"], created_at=r["created_at"],
                    deleted_at=r["deleted_at"],
                )
                out.append((edge, neighbor))
        return out

    def follow(self, start_id: UUID,
               steps: Sequence[Tuple[EdgeType, str]],
               *, include_deleted: bool = False) -> List[Node]:
        """Walk a typed path and return the nodes at the end of it.

        `neighbors` is already generic over edge type, so one hop never needed a
        function of its own. What did was the *multi-hop* question, where every
        interesting one changes direction partway:

            authors who write at a site
                follow(source, [(WRITES_AT, "in")])
            organizations behind a document
                follow(doc, [(AUTHORED_BY, "out"), (MEMBER_OF, "out")])
            co-authors of a person
                follow(person, [(AUTHORED_BY, "in"), (AUTHORED_BY, "out")])

        That last one is why there is no co-authorship edge: co-authorship is two
        people sharing a document, so storing it would be a second representation
        of a fact the graph already holds -- the trap `MemberOfAttrs.current` fell
        into. Derive it here instead.

        `subgraph(depth=N)` can reach the same nodes but returns everything within N
        hops, leaving the caller to filter -- which is where a function per question
        starts breeding. Each step is validated against `EDGE_TYPES`, so a path that
        cannot exist (`works_on` then `authored_by`, say) raises instead of quietly
        returning nothing, which is the failure mode that would otherwise read as
        "this person has no publications".

        Deduplicated by node id and never includes `start_id` itself: two co-authors
        at one organization yield that organization once, and a person is not their
        own co-author.
        """
        if not steps:
            return []

        start = self.get_node(start_id, include_deleted=include_deleted)
        if start is None:
            raise NodeNotFound(str(start_id))

        frontier = {start_id}
        # The node types currently standing at the frontier, so each step can be
        # checked against what it's actually being asked to leave from. Checking
        # only what a step *finds* is not enough: an impossible step simply finds
        # nothing, and returning [] would read as "this document has no such thing"
        # rather than "you asked a question that cannot exist".
        frontier_types = {NodeType(start.type)}
        seen_nodes: Dict[UUID, Node] = {}

        for i, (edge_type, direction) in enumerate(steps):
            if direction not in ("in", "out", "both"):
                raise ValueError(f"step {i}: direction must be in/out/both, "
                                 f"got {direction!r}")
            spec = EDGE_TYPES[edge_type]
            if direction == "out":
                departs_from, arrives_at = spec.sources, spec.targets
            elif direction == "in":
                departs_from, arrives_at = spec.targets, spec.sources
            else:
                departs_from = arrives_at = spec.sources | spec.targets

            if not (frontier_types & departs_from):
                raise ValueError(
                    f"step {i}: {edge_type.value} cannot be followed "
                    f"{direction} of {sorted(t.value for t in frontier_types)} — "
                    f"it runs "
                    f"{sorted(t.value for t in spec.sources)} -> "
                    f"{sorted(t.value for t in spec.targets)}")

            found: Dict[UUID, Node] = {}
            for node_id in frontier:
                for _edge, node in self.neighbors(
                        node_id, edge_types=[edge_type], direction=direction,
                        include_deleted=include_deleted):
                    if NodeType(node.type) in arrives_at:
                        found[node.id] = node
            if not found:
                return []
            frontier = set(found)
            frontier_types = {NodeType(n.type) for n in found.values()}
            seen_nodes = found

        seen_nodes.pop(start_id, None)
        return list(seen_nodes.values())

    def reaches(self, from_id: UUID, to_id: UUID, edge_type: EdgeType) -> bool:
        """True if to_id is reachable from from_id following `edge_type` edges in
        the source -> target direction.

        Directed, unlike subgraph(): "is this concept already above that one?" has
        no answer in an undirected walk. `union` (not `union all`) dedupes the
        frontier, so a cycle that already exists terminates the walk instead of
        hanging it. Nodes are joined in to skip soft-deleted ones -- soft_delete_node
        doesn't cascade to edges, so a path through a deleted node would otherwise
        still count.
        """
        with self._cur() as cur:
            cur.execute(
                """with recursive walk as (
                        select e.target_id as id
                        from edges e
                        join nodes n on n.id = e.target_id and n.deleted_at is null
                        where e.source_id = %(from)s and e.type = %(etype)s
                          and e.deleted_at is null
                      union
                        select e.target_id
                        from walk w
                        join edges e on e.source_id = w.id and e.type = %(etype)s
                                     and e.deleted_at is null
                        join nodes n on n.id = e.target_id and n.deleted_at is null
                    )
                    select 1 from walk where id = %(to)s limit 1""",
                {"from": from_id, "to": to_id, "etype": edge_type.value},
            )
            return cur.fetchone() is not None

    def subgraph(self, root_ids: Sequence[UUID], *, depth: int = 1,
                 edge_types: Optional[Iterable[EdgeType]] = None) -> Graph:
        """Everything reachable from root_ids within `depth` hops, returned as a
        Graph (the reachable nodes plus every live edge among them). A recursive
        CTE walks the graph in the DB; this is the primitive the viewer uses to
        pull a whole sub-region of the guide."""
        params: Dict = {"roots": list(root_ids), "depth": depth}
        type_pred = ""
        if edge_types is not None:
            type_pred = "and e.type = any(%(etypes)s)"
            params["etypes"] = [t.value for t in edge_types]

        with self._cur() as cur:
            cur.execute(
                f"""with recursive reachable as (
                        select id, 0 as depth from nodes
                        where id = any(%(roots)s) and deleted_at is null
                      union
                        select n.id, r.depth + 1
                        from reachable r
                        join edges e on (e.source_id = r.id or e.target_id = r.id)
                                     and e.deleted_at is null {type_pred}
                        join nodes n on n.id = case when e.source_id = r.id
                                                    then e.target_id else e.source_id end
                                     and n.deleted_at is null
                        where r.depth < %(depth)s
                    )
                    select distinct id from reachable""",
                params,
            )
            ids = [r["id"] for r in cur.fetchall()]
            if not ids:
                return Graph()

            cur.execute("select * from nodes where id = any(%s) and deleted_at is null "
                        "order by created_at", (ids,))
            nodes = [_node(r) for r in cur.fetchall()]

            edge_clauses = ["source_id = any(%(ids)s)", "target_id = any(%(ids)s)",
                            "deleted_at is null"]
            eparams: Dict = {"ids": ids}
            if edge_types is not None:
                edge_clauses.append("type = any(%(etypes)s)")
                eparams["etypes"] = [t.value for t in edge_types]
            cur.execute(f"select * from edges where {' and '.join(edge_clauses)} "
                        f"order by created_at", eparams)
            edges = [_edge(r) for r in cur.fetchall()]

        return Graph(nodes=nodes, edges=edges)

    # -- merge -------------------------------------------------------------

    def merge_nodes(self, keep_id: UUID, merge_id: UUID,
                    actor: Actor) -> Tuple[Node, Node, int]:
        """Structurally fold merge_id into keep_id in a single transaction.

        Every live edge touching merge_id is re-pointed to keep_id. Two cases are
        dropped (soft-deleted) instead of re-pointed: a self-loop (the edge already
        connected the two nodes, so it would point keep_id at itself) and a
        collision (an identical live edge of that type already exists on keep_id).
        merge_id is then soft-deleted. Attributes of neither node are touched --
        text reconciliation is the caller's job.

        Returns (survivor, merged_before, dropped_edge_count). Raises NodeNotFound
        if either node is missing/deleted.
        """
        if keep_id == merge_id:
            raise ValueError("cannot merge a node into itself")

        with self.conn.transaction(), self._cur() as cur:
            cur.execute("select * from nodes where id = %s and deleted_at is null "
                        "for update", (keep_id,))
            keep_row = cur.fetchone()
            cur.execute("select * from nodes where id = %s and deleted_at is null "
                        "for update", (merge_id,))
            merge_row = cur.fetchone()
            if not keep_row or not merge_row:
                raise NodeNotFound(str(keep_id if not keep_row else merge_id))
            survivor, merged_before = _node(keep_row), _node(merge_row)

            cur.execute(
                """select * from edges
                   where (source_id = %s or target_id = %s) and deleted_at is null
                   for update""",
                (merge_id, merge_id),
            )
            dropped = 0
            for row in cur.fetchall():
                edge = _edge(row)
                new_source = keep_id if edge.source_id == merge_id else edge.source_id
                new_target = keep_id if edge.target_id == merge_id else edge.target_id

                # self-loop, or an identical live edge already on the survivor?
                collision = new_source == new_target
                if not collision:
                    cur.execute(
                        """select 1 from edges
                           where source_id = %s and target_id = %s and type = %s
                             and deleted_at is null and id <> %s""",
                        (new_source, new_target, edge.type, edge.id),
                    )
                    collision = cur.fetchone() is not None

                if collision:
                    cur.execute("update edges set deleted_at = now() where id = %s",
                                (edge.id,))
                    self._record_revision(cur, "edge", edge.id, "delete",
                                          _as_snapshot(edge), None, actor)
                    dropped += 1
                    continue

                cur.execute(
                    "update edges set source_id = %s, target_id = %s where id = %s "
                    "returning *", (new_source, new_target, edge.id),
                )
                self._record_revision(cur, "edge", edge.id, "update",
                                      _as_snapshot(edge),
                                      _as_snapshot(_edge(cur.fetchone())), actor)

            cur.execute("update nodes set deleted_at = now() where id = %s", (merge_id,))
            self._record_revision(cur, "node", merge_id, "delete",
                                  _as_snapshot(merged_before), None, actor)

        return survivor, merged_before, dropped

    # -- undo --------------------------------------------------------------

    def undoable(self) -> Optional[Dict]:
        """A one-line description of what the next undo would reverse, or None when
        there's nothing to undo. Reads only -- drives the header button's state."""
        with self._cur() as cur:
            cur.execute("select txid from revisions where undone_at is null "
                        "and txid is not null order by created_at desc limit 1")
            row = cur.fetchone()
            if not row:
                return None
            cur.execute("select action from revisions where txid = %s and undone_at is null",
                        (row["txid"],))
            actions = {r["action"] for r in cur.fetchall()}
        return {"description": _describe_undo(actions)}

    def undo_last(self, actor: Actor) -> Optional[Dict]:
        """Reverse the most recent not-yet-undone transaction group. Reversal runs
        newest-write-first so dependencies unwind cleanly, and marks the group
        `undone` rather than deleting the log rows (the audit trail keeps both the
        action and its undo). Returns a small summary, or None if nothing to undo."""
        with self.conn.transaction(), self._cur() as cur:
            cur.execute("select txid from revisions where undone_at is null "
                        "and txid is not null order by created_at desc limit 1 for update")
            row = cur.fetchone()
            if not row:
                return None
            txid = row["txid"]
            cur.execute("select * from revisions where txid = %s and undone_at is null "
                        "order by created_at desc, id desc for update", (txid,))
            revs = cur.fetchall()
            actions = {r["action"] for r in revs}
            for r in revs:
                self._reverse(cur, r)
            cur.execute("update revisions set undone_at = now() "
                        "where txid = %s and undone_at is null", (txid,))
        return {"count": len(revs), "description": _describe_undo(actions)}

    def _reverse(self, cur, rev) -> None:
        table = "nodes" if rev["entity"] == "node" else "edges"
        eid, action, before = rev["entity_id"], rev["action"], rev["before"]
        if action == "create":
            # Undo a create by removing it again.
            cur.execute(f"update {table} set deleted_at = now() where id = %s", (eid,))
        elif action == "delete":
            # Un-delete: soft delete only ever set deleted_at, so clearing it is enough.
            cur.execute(f"update {table} set deleted_at = null where id = %s", (eid,))
        elif action == "update":
            if rev["entity"] == "node":
                cur.execute("update nodes set label = %s, attributes = %s, updated_at = now() "
                            "where id = %s",
                            (before["label"], Jsonb(before["attributes"]), eid))
            else:
                cur.execute("update edges set source_id = %s, target_id = %s, attributes = %s "
                            "where id = %s",
                            (before["source_id"], before["target_id"],
                             Jsonb(before["attributes"]), eid))


def _describe_undo(actions: set) -> str:
    verb = "create" if "create" in actions else "delete" if "delete" in actions else "edit"
    return f"Undo last {verb}"


def _as_snapshot(obj) -> Dict:
    """A JSON-safe dict snapshot of a Node/Edge for the revisions log."""
    out = {}
    for k, v in vars(obj).items():
        out[k] = str(v) if isinstance(v, UUID) else v
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out
