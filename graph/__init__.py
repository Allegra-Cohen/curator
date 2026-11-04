"""Field-guide property graph: storage layer for the visual ontology."""

from .db import (
    DEFAULT_ENV,
    ENVIRONMENTS,
    connect,
    dsn,
    ensure_database,
    env_dsn,
    load_active_env,
    migrate,
    save_active_env,
    test_dsn,
)
from .ingest import IngestionBridge, IngestReport, Scraper
from .integrity import ACYCLIC, GraphIntegrity, GraphIntegrityError, Violation
from .models import Actor, Edge, Graph, Node
from .repository import GraphRepository, NodeNotFound
from .services import (
    ArtifactService,
    GraphQueryService,
    IngestionService,
    MergeResult,
    OntologyService,
    PeopleService,
    SourceService,
    reader_visible,
)
from .types import (
    EDGE_TYPES,
    ONTOLOGY_EDGE_TYPES,
    EdgeType,
    NodeType,
    validate_edge,
    validate_node_attrs,
)

__all__ = [
    "connect", "migrate", "dsn", "test_dsn", "env_dsn", "ensure_database",
    "ENVIRONMENTS", "DEFAULT_ENV", "load_active_env", "save_active_env",
    "Actor", "Edge", "Graph", "Node",
    "GraphRepository", "NodeNotFound",
    "GraphIntegrity", "GraphIntegrityError", "Violation", "ACYCLIC",
    "OntologyService", "IngestionService", "PeopleService", "GraphQueryService",
    "ArtifactService", "SourceService",
    "MergeResult",
    "IngestionBridge", "IngestReport", "Scraper",
    "EDGE_TYPES", "ONTOLOGY_EDGE_TYPES", "EdgeType", "NodeType",
    "validate_edge", "validate_node_attrs",
]
