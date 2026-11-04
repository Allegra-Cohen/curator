"""Plain in-memory representations of what's in the graph tables.

Deliberately thin: a Node/Edge is the row, with `attributes` left as a raw dict
(validated on the way in by graph/types.py, not re-parsed on the way out — so old
rows never fail to load). Typed convenience accessors, if we want them, belong in
a services layer on top, not here.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional
from uuid import UUID


@dataclass
class Node:
    id: UUID
    type: str
    label: str
    attributes: Dict
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: Optional[datetime] = None


@dataclass
class Edge:
    id: UUID
    source_id: UUID
    target_id: UUID
    type: str
    attributes: Dict
    created_by: UUID
    created_at: datetime
    deleted_at: Optional[datetime] = None


@dataclass
class Graph:
    """A slice of the graph — exactly what a viewer render or a subgraph query returns."""
    nodes: List[Node] = field(default_factory=list)
    edges: List[Edge] = field(default_factory=list)


@dataclass
class Actor:
    """Who is performing a mutation. Threaded through every write so that adding
    real authentication later means populating this, not re-plumbing call sites."""
    id: UUID
    role: str = "curator"
