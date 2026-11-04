"""The curation assistant's only door into the database: read-only, on purpose.

Everything the chat agent (assistant/conversation.py) knows about the graph or
the queue comes through this file, and this file contains nothing but reads.
GraphRepository and the services in graph/services.py also have write methods
(delete a document, edit a concept, ...) sitting right next to their read
methods -- this file exists so the agent's code never has to go near those
classes directly, and so there is no write method reachable from anywhere the
agent's code touches, now or when tools get added later.

Every method returns plain dicts (never Node/Edge objects), so the rest of the
assistant package never needs to know about attributes-as-JSON or how a row is
stored.
"""

from typing import Dict, List, Optional
from uuid import UUID

import queue_segments
from graph import EdgeType, GraphRepository, NodeType


class GraphReader:
    def __init__(self, repo: GraphRepository, env: str):
        self.repo = repo
        self.env = env  # which environment's queue_segments file to read (sandbox/guide)

    # ------------------------------------------------------------------
    # Names only -- what the scope classifier asks for (assistant/scope.py
    # step 4: "is the curator deliberately naming one of these?")
    # ------------------------------------------------------------------

    def concept_names(self) -> List[str]:
        return [n.label for n in self.repo.find_nodes(type=NodeType.CONCEPT, limit=1000)]

    def segment_names(self) -> List[str]:
        state = self._segment_state()
        return [s.name for s in state.segments if s.name]

    # ------------------------------------------------------------------
    # Concepts
    # ------------------------------------------------------------------

    def concepts(self) -> List[Dict]:
        """Every concept: label + description. Used for the "whole graph" scope."""
        return [self._concept_row(n) for n in self.repo.find_nodes(type=NodeType.CONCEPT, limit=1000)]

    def concept_detail(self, concept_id: UUID) -> Optional[Dict]:
        """One concept plus the documents ABOUT it. Used for "the concept I have
        open right now"."""
        node = self.repo.get_node(concept_id)
        if node is None or node.type != NodeType.CONCEPT.value:
            return None
        row = self._concept_row(node)
        pairs = self.repo.neighbors(concept_id, edge_types=[EdgeType.ABOUT], direction="in")
        row["documents"] = [self._document_row(n) for _edge, n in pairs]
        return row

    # ------------------------------------------------------------------
    # Documents
    # ------------------------------------------------------------------

    def approved_documents(self, *, concept_name: Optional[str] = None) -> List[Dict]:
        """Approved documents, optionally only the ones about one named concept.

        find_nodes() already never returns a pending document (APPROVED_ONLY),
        so no separate filtering is needed to keep the queue out of this.
        """
        if concept_name is None:
            return [self._document_row(n) for n in self.repo.find_nodes(type=NodeType.DOCUMENT, limit=1000)]
        concept = self._find_concept_by_name(concept_name)
        if concept is None:
            return []
        pairs = self.repo.neighbors(concept.id, edge_types=[EdgeType.ABOUT], direction="in")
        return [self._document_row(n) for _edge, n in pairs]

    def queue_documents(self, *, segment_name: Optional[str] = None) -> List[Dict]:
        """Queue documents, optionally only the ones in one of the curator's
        hand-made piles (see queue_segments.py -- these are not in the graph)."""
        pending = self.repo.pending_documents(limit=1000)
        if segment_name is None:
            return [self._document_row(n) for n in pending]

        state = self._segment_state()
        segment_id = next((s.id for s in state.segments if s.name == segment_name), None)
        if segment_id is None:
            return []
        pruned = queue_segments.prune(state, (n.id for n in pending))
        member_ids = {doc_id for doc_id, seg_id in pruned.members.items() if seg_id == segment_id}
        return [self._document_row(n) for n in pending if n.id in member_ids]

    def document(self, document_id: UUID) -> Optional[Dict]:
        """One document by id, in the queue or already approved. Used for "the
        document I have open right now"."""
        node = self.repo.get_node(document_id)
        if node is None or node.type != NodeType.DOCUMENT.value:
            return None
        return self._document_row(node)

    def full_text(self, document_id: UUID) -> Optional[str]:
        """The cached full text of one document, or None if it's either not a
        document or hasn't been fetched yet. Deliberately its own method, not a
        field on _document_row -- that dict is what goes into every context-
        building call, and full text is exactly what's too big for that."""
        node = self.repo.get_node(document_id)
        if node is None or node.type != NodeType.DOCUMENT.value:
            return None
        return node.attributes.get("full_text")

    # ------------------------------------------------------------------
    # Shared plumbing
    # ------------------------------------------------------------------

    def _segment_state(self) -> "queue_segments.SegmentState":
        return queue_segments.load(self.env)

    def _find_concept_by_name(self, label: str):
        matches = self.repo.find_nodes(type=NodeType.CONCEPT, label=label, limit=1)
        return matches[0] if matches else None

    @staticmethod
    def _concept_row(node) -> Dict:
        return {
            "id": node.id,
            "label": node.label,
            "description": node.attributes.get("description", ""),
        }

    @staticmethod
    def _document_row(node) -> Dict:
        return {
            "id": node.id,
            "title": node.attributes.get("title", ""),
            "abstract": node.attributes.get("abstract", ""),
            "status": node.attributes.get("status", ""),
        }
