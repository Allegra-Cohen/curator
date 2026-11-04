"""Structural invariants: the rules that need to see the graph.

`graph.types` validates what an edge *is* -- endpoint types, attribute shape --
and needs no database to do it. Nothing validated what an edge *does to the
graph*: whether it closes a cycle, contradicts an edge already there, or leaves
something unreachable. Those questions need traversal, so they live here, above
the repository and beside the services that call them.

Two faces over one set of rules, so the two can't drift apart:

  * check_edge() -- preventive. A service calls it before a write; it raises
    GraphIntegrityError if the write would break an invariant.
  * scan()       -- diagnostic. Walks the live graph and reports what is already
    broken: edges that got in before a rule existed, or around it (see
    scan_cycles -- merge_nodes repoints edges in raw SQL and never passes
    through check_edge).

Both faces are needed. A preventive check only guards the door it is nailed to;
the graph can still be walked into a bad state through another one.

Adding a rule means extending ACYCLIC, or adding a check_* method plus the
matching scan branch. Cycles are the only rule so far.
"""

from dataclasses import dataclass, field
from typing import List
from uuid import UUID

from .repository import GraphRepository
from .types import EdgeType


class GraphIntegrityError(ValueError):
    """A write rejected because it would break a structural invariant.

    Subclasses ValueError so callers already catching ValueError around the
    services (and the API layer, which maps ValueError to a 400) keep working.
    """


@dataclass(frozen=True)
class Violation:
    """One broken invariant found by scan(). Carries the ids so a caller can
    offer to fix it, and a message already phrased for a human."""
    rule: str
    message: str
    node_ids: List[UUID] = field(default_factory=list)
    edge_ids: List[UUID] = field(default_factory=list)


# Edge types where a cycle is nonsense rather than merely unusual:
#   subtopic_of     -- a concept cannot sit beneath itself
#   prerequisite_of -- you cannot need A before B and B before A
#   part_of         -- an org cannot contain itself
# `about` / `authored_by` / `member_of` / `funds` connect different node types (or
# are meaningfully cyclic -- orgs really do fund each other in circles), so they have
# no acyclic rule to break. `remarks_on` is the same: two notes that reference each
# other are two notes that reference each other, not a contradiction.
ACYCLIC = frozenset({
    EdgeType.SUBTOPIC_OF,
    EdgeType.PREREQUISITE_OF,
    EdgeType.PART_OF,
})


class GraphIntegrity:
    """Structural rules: enforced before a write, or reported after the fact."""

    def __init__(self, repo: GraphRepository):
        self.repo = repo

    # -- preventive --------------------------------------------------------

    def check_edge(self, source_id: UUID, target_id: UUID,
                   edge_type: EdgeType) -> None:
        """Raise GraphIntegrityError if adding this edge would break an invariant.

        Called by a service before repo.add_edge, deliberately not *by* add_edge:
        the repository is the SQL layer and shouldn't carry domain rules.

        Not atomic with the insert it guards -- two concurrent writers could each
        pass and jointly form a cycle. Acceptable while this is a single-curator
        tool; the fix is for the caller to wrap check + write in one
        conn.transaction() (they nest), and scan() catches whatever slips through.
        """
        if edge_type in ACYCLIC:
            self._check_acyclic(source_id, target_id, edge_type)

    def _check_acyclic(self, source_id: UUID, target_id: UUID,
                       edge_type: EdgeType) -> None:
        # An edge source -> target closes a loop exactly when target can already
        # reach source. That statement is direction-agnostic, so one rule covers
        # subtopic_of (child -> parent), prerequisite_of, and part_of alike.
        if source_id == target_id:
            raise GraphIntegrityError(
                f"{self._label(source_id)} cannot be its own {edge_type.value} target"
            )
        if self.repo.reaches(target_id, source_id, edge_type):
            raise GraphIntegrityError(
                f"{edge_type.value}: {self._label(source_id)} -> "
                f"{self._label(target_id)} would close a cycle, because "
                f"{self._label(target_id)} already reaches {self._label(source_id)}"
            )

    # -- diagnostic --------------------------------------------------------

    def scan(self) -> List[Violation]:
        """Every invariant violation currently live in the graph."""
        return self.scan_cycles()

    def scan_cycles(self) -> List[Violation]:
        """Edges sitting on a cycle in an ACYCLIC edge type.

        Needed even with check_edge in place, because merge_nodes repoints edges
        in raw SQL and never passes through it. Given A subtopic_of B and
        B subtopic_of C, merging C into A repoints B -> C into B -> A, leaving
        A -> B -> A. merge_nodes drops self-loops and duplicate edges, but has no
        notion of a cycle.

        Every edge on a cycle is reported, not just one: there is no principled
        "guilty" edge, and the curator is the one who decides which to drop.
        """
        out: List[Violation] = []
        for etype in sorted(ACYCLIC, key=lambda t: t.value):
            for e in self.repo.find_edges(types=[etype]):
                if e.source_id == e.target_id:
                    out.append(Violation(
                        rule="acyclic",
                        message=(f"{self._label(e.source_id)} is its own "
                                 f"{etype.value} target"),
                        node_ids=[e.source_id],
                        edge_ids=[e.id],
                    ))
                elif self.repo.reaches(e.target_id, e.source_id, etype):
                    out.append(Violation(
                        rule="acyclic",
                        message=(f"{etype.value}: {self._label(e.source_id)} -> "
                                 f"{self._label(e.target_id)} sits on a cycle"),
                        node_ids=[e.source_id, e.target_id],
                        edge_ids=[e.id],
                    ))
        return out

    # -- internal ----------------------------------------------------------

    def _label(self, node_id: UUID) -> str:
        """A human-readable name for a message; falls back to the raw id."""
        n = self.repo.get_node(node_id)
        return n.label if n else str(node_id)
