"""The type registry: the app-layer contract the database deliberately doesn't enforce.

The `nodes`/`edges` tables only guarantee `attributes is jsonb`. Everything about
*what* a Concept/Document/Person/Organization may contain, and *which* node types
an edge may connect, lives here. Two jobs:

  * per-node-type attribute schemas (validate_node_attrs)
  * per-edge-type endpoint rules + attribute schemas (validate_edge)

Everything here is answerable from the edge alone, with no database: both ends of
a `subtopic_of` are concepts whether or not the edge closes a loop. What an edge
does to the *graph* -- cycles and the like -- needs traversal, so those rules live
in `graph/integrity.py` instead.

Adding a node type is a new NodeType member + a schema + a CHECK tweak in
schema.sql. Adding an edge type (e.g. `funds`) is a new EdgeType member + an
EdgeSpec — no migration, because edge `type` is free text in the DB.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Dict, List, Optional, Set, Tuple, Type, Union

from pydantic import BaseModel, ConfigDict, StringConstraints


class NodeType(str, Enum):
    CONCEPT = "concept"
    DOCUMENT = "document"
    PERSON = "person"
    ORGANIZATION = "organization"
    ARTIFACT = "artifact"
    SOURCE = "source"


class EdgeType(str, Enum):
    SUBTOPIC_OF = "subtopic_of"        # concept -> concept (poly-hierarchy)
    PREREQUISITE_OF = "prerequisite_of"  # concept -> concept
    ABOUT = "about"                    # document -> concept (the categorization act)
    AUTHORED_BY = "authored_by"        # document -> person|organization
    MEMBER_OF = "member_of"            # person -> organization
    PART_OF = "part_of"                # organization|source -> organization (nesting)
    WORKS_ON = "works_on"              # person -> concept
    FUNDS = "funds"                    # person|org -> person|org
    WRITES_AT = "writes_at"            # person -> source
    SOURCED_FROM = "sourced_from"      # document -> source (provenance)
    REMARKS_ON = "remarks_on"          # artifact -> any node (what the prose is about)
    CITES = "cites"                    # artifact -> document (derived from the body)

    # `relates_to` (concept -> concept) was removed rather than deprecated. It
    # asserted that two concepts were linked and nothing about how, which is too
    # vague to model or navigate by; nothing but seed data ever created one, because
    # no curator-facing path to draw one was ever worth building. What replaced it is
    # `remarks_on`: the curator's prose about why things relate IS the relation, and
    # it carries the explanation the bare edge never could. See ARTIFACTS_DESIGN.md.


def normalize_orcid(raw: Optional[str]) -> Optional[str]:
    """Reduce an ORCID to its bare id: `0000-0002-1825-0097`.

    They arrive in two forms and must not be stored in two forms. OpenAlex gives
    the full URL (`https://orcid.org/0000-...`); a curator typing into the person
    dialog gives the bare id. Dedup is exact string equality, so storing both
    shapes would silently defeat the identifier in exactly the case it exists for
    -- the same human, entered twice, matching neither time.

    Deliberately not a validator: a malformed id is returned as-is (trimmed) rather
    than rejected. Checksumming ORCIDs is a real thing we don't do, and refusing to
    save a person because their id has a typo would be a worse failure than storing
    a wrong one the curator can see and fix.

    This is the ONE place either shape is reconciled. Scout carries whatever the API
    gave it, unmodified, so nothing in the scraper layer has to know the rule.
    """
    if not raw:
        return None
    s = raw.strip()
    if not s:
        return None
    for prefix in ("https://orcid.org/", "http://orcid.org/", "orcid.org/"):
        if s.lower().startswith(prefix):
            return s[len(prefix):].strip("/") or None
    return s


_NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def person_name_key(name: Optional[str]) -> str:
    """The form a name is compared in: lowercased, spaces collapsed, and a
    "Last, First" byline turned round to "first last".

    Some sources give bylines surname-first, and exact matching read "Demszky,
    Dorottya" and "Dorottya Demszky" as two people -- the curator created the second
    node without ever being shown the first. Swapping the two sides round a comma is
    not fuzzy matching: nothing is guessed, and the key maps back to one name.

    Only a single comma is flipped, and not when what follows it is a suffix
    ("Smith, Jr."). Anything more tangled is left alone and matched exactly.
    """
    s = " ".join((name or "").split()).lower()
    parts = s.split(",")
    if len(parts) == 2:
        last, first = parts[0].strip(), parts[1].strip()
        if last and first and first.rstrip(".") not in _NAME_SUFFIXES:
            return f"{first} {last}"
    return s


#: A colour the curator chose, as `#rrggbb`. Rejected rather than corrected if it
#: is malformed: unlike an ORCID typo, a bad colour has no partial value -- it would
#: reach the reader's drawing as a shape that silently fails to paint, with nothing
#: anywhere to say why.
HexColor = Annotated[str, StringConstraints(pattern=r"^#[0-9a-fA-F]{6}$")]

#: A concept's paint: one colour, or a `[start, end]` pair for a gradient whose two
#: ends the curator chose outright. Most concepts stay one colour, and the reader
#: derives its own two-tone gradient from it (a hue rotation either way -- see
#: `gradientEnds` in PolygonCanvas.tsx); a pair skips that guess in favour of the
#: exact two colours given.
PaintColor = Union[HexColor, Tuple[HexColor, HexColor]]


class Quilt(BaseModel):
    """A remark's assignment onto one of the reader's quilt patterns (the
    quilt_3/quilt_4-style drawings replacing the old nested-polygon canvas -- see
    writeups/design/QUILT_VIEWER_PLAN.md and viz_examples/quilt_geometry_notes.md).

    `pattern` names which one -- just `"petal"` for now. `slots` says which concept
    fills which named position in it: for `"petal"`, `background` (present only when
    one concept encompasses the rest -- see the pattern's own "when to use" note),
    `circle`, and `petal_0` through `petal_n`. A concept node id, as a STRING -- same
    convention as ArtifactAttrs.paint, and for the same reason: this is how it is
    stored and how it arrives from the editor, and the subject ids it is checked
    against are compared as strings too.
    """
    pattern: str
    slots: Dict[str, str]


# --------------------------------------------------------------------------
# Attribute schemas. extra="forbid" turns a typo'd attribute key into an error
# at write time instead of a silent orphan field in the JSON.
# --------------------------------------------------------------------------

class _Attrs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ScrapedAuthor(_Attrs):
    """A name as an API or scraper reported it, plus an ORCID when one came with it.

    Not a node and not an attribution -- just what the fetch said, held until the
    curator decides. The ORCID is the whole reason this is a record rather than the
    bare string it replaced: an ORCID resolves a person across the name variants
    they publish under (A. Person, Another B. Person), which name matching cannot do
    and should not try to.
    """
    name: str
    orcid: Optional[str] = None


class Layout(BaseModel):
    """Optional curator-pinned position for the visual ontology."""
    x: float
    y: float
    pinned: bool = False


class ConceptAttrs(_Attrs):
    # The concept is its own search config, but the reader-facing and machine-facing
    # text are SEPARATE fields:
    #
    #   * `description` -- the definition a reader sees in the viewer, and the only
    #     one of these that is public (PUBLIC_NODE_ATTRS below). It was also the
    #     OpenAlex query until 2026-08-07; the split happened because a definition
    #     worth publishing often quotes a source and cites it, and citation text in a
    #     vector query is noise that shifts what comes back.
    #   * `semantic_query` -- rich prose written FOR OpenAlex's semantic (vector)
    #     search, and the gloss the LLM relevance filter judges keyword hits against.
    #     Never shown to a reader. Empty means "don't run semantic search for this
    #     concept" -- there is deliberately no fallback to `description`, since a
    #     fallback would re-couple them and quietly re-create the problem the split
    #     solved the next time a citation is added.
    #   * `keywords` -- the boolean expression for keyword search (arXiv).
    #   * `criteria` -- reserved as the eventual machine-facing signal for assisted
    #     categorization (does a document belong here?). Distinct from the two above;
    #     do not overload it with search syntax.
    description: str = ""      # prose: what the concept is (reader-facing, public)
    semantic_query: str = ""   # prose written for OpenAlex semantic search
    keywords: str = ""         # boolean keyword expression for arXiv search
    criteria: str = ""         # (future) machine-facing membership signal for categorization
    layout: Optional[Layout] = None


class DocumentAttrs(_Attrs):
    canonical_url: str
    source_type: str = "journal"           # journal | news | substack (from scraper)
    title: str = ""
    publication: Optional[str] = None
    published_date: Optional[str] = None   # ISO string, matching the scraper's output
    # As scraped, before the curator resolves anyone to a node. Was `authors_raw:
    # List[str]`; widened so an OpenAlex ORCID survives the trip instead of being
    # thrown away at the adapter. The alternative -- a reader accepting both shapes
    # -- was rejected: one field holding two shapes is the second-representation
    # problem, and every future reader would pay for it. The documents that held the
    # old shape were scrapped and re-fetched rather than migrated, which had the
    # better outcome anyway: a re-fetch fills in the ORCIDs a migration could only
    # have left null.
    #
    # PERMANENT. This is the record of what the scraper read, not a worklist: it is
    # never narrowed by a curator's decision, so `proposed_author_names` below is
    # what shrinks instead. Rewriting this on a rejection would destroy the evidence
    # that the byline was ever read, which is the one thing a later curator needs to
    # tell "the scraper missed an author" from "someone decided against this one".
    authors_scraped: List[ScrapedAuthor] = []
    # The scraped names still awaiting an author-proposal decision -- the author
    # counterpart of `proposed_concept_ids` below, and consumed the same way.
    #
    # Seeded at ingest from `authors_scraped`, emptied by `PeopleService.set_authors`
    # (that is, by Save). Author proposals are DERIVED by joining this list back onto
    # `authors_scraped` for the ORCIDs, so a name absent here is never proposed again
    # on this document.
    #
    # It exists because author proposals used to be re-derived from `authors_scraped`
    # alone, which is permanent -- so no decision about an author could ever stick. A
    # rejected byline returned on the next fetch forever, and approved documents,
    # which should not be proposed to at all, kept offering scraped names as though
    # they were unreviewed. Names rather than ids because an author proposal that
    # matches nothing HAS no id yet; that is what the NEW badge means.
    #
    # On the document, so a rejection is scoped to this document. The same author
    # stays proposed everywhere else -- correcting one paper's byline is not a claim
    # that the person never writes anything.
    proposed_author_names: List[str] = []
    abstract: str = ""                     # the author's abstract, as published (from the API)
    # False when nothing will ever render a body for this document: a scanned PDF
    # whose pages are images, chiefly. Distinct from `fetch_outcome`, which Reader
    # computes per-fetch and deliberately doesn't persist -- that describes one
    # attempt at reading, this is a durable fact re-fetching cannot change. The
    # names were once `body_text_found` and `access`, which read as two versions of
    # the same thing and got treated that way.
    #
    # Defaults True so the documents already in the graph read correctly without a
    # backfill: every one of them arrived through the path that requires text.
    # What consumes it is the summarizer -- "there is nothing to summarize" has to
    # be a statement it can read, not something it infers from an empty string and
    # then retries forever.
    body_text_found: bool = True
    summary: str = ""                      # curator- or model-written distillation
    status: str = "pending"                # pending | reviewed
    searchterms: List[str] = []            # which search terms triggered this doc (from Scout)
    # Where this document came from is NOT here -- it's `sourced_from` edges to
    # `source` nodes. A document found by both arXiv and a lab's feed has two
    # provenances, and the string this replaced ("arXiv+openAlex") was a list
    # pretending to be a scalar. Edges also make sources a legal pivot axis.
    #
    # Concepts whose search surfaced this document -- suggestions for the curator,
    # NOT categorization. Deliberately node attributes rather than `about` edges:
    # every pivot cell is built from `about`, so proposals stored as edges would
    # inflate co-occurrence counts before anyone agreed to them, and the pivot is
    # only worth reading because a number there means evidence. An `about` edge keeps
    # meaning exactly one thing -- the curator said yes. Ids, not labels, so a rename
    # doesn't orphan the proposal (unlike `searchterms`, which is display provenance).
    proposed_concept_ids: List[str] = []
    # The curator rejected this document: don't offer the URL again (see
    # IngestionService.tombstoned_urls). Deliberately an explicit flag rather than
    # something inferred from `deleted_at` -- undoing an ingest ALSO soft-deletes,
    # and "this shouldn't have been fetched" is not "I reject this paper".
    dismissed: bool = False
    # Why it was dismissed, in the curator's words -- "paywalled", "marketing post",
    # "same paper as the arXiv version". Written from the Summary box at the moment
    # of deletion (there is no separate field to fill in), which is why it is NOT
    # `summary`: a dismissal can be undone or the URL pasted back in, and
    # `restore_dismissed_document` brings the document back with its attributes
    # intact -- a reason kept in `summary` would resurface as the guide's summary of
    # the paper. Two different statements, two fields.
    #
    # Empty is the honest reading of a dismissal nobody explained, including every
    # one made before this field existed: no reason was given, not "no reason".
    dismissal_note: str = ""
    # "Nobody is named on this, and no organization publishes it either" -- a
    # genuinely anonymous document. NOT the case of an institutional report or an
    # unbylined org post: those are authored by the *organization*, which is a real
    # attribution recorded as an `authored_by` edge to it.
    #
    # Deliberately a separate flag rather than
    # leaning on empty `authors_scraped`, because an empty list means TWO different
    # things: nobody has filled it in yet, and there is nobody to fill in. A gate
    # that can't tell them apart forces the curator to invent an attribution to get
    # past it -- and an invented author is worse than an absent one, since the
    # `authored_by` pivot then carries it forever as though it were real.
    #
    # Same shape as `accept_rate: None` versus `0.0`: no-opinion and none-of-them
    # must not render the same.
    no_named_author: bool = False
    # A legitimately-free full-text copy, when one exists. Purely a link-out for the
    # curator: we hold no rights we didn't already have, and paywalled works simply
    # don't have one -- which is why `abstract` is what makes review possible.
    oa_pdf_url: Optional[str] = None
    # What KIND of venue published this -- "journal" (peer-reviewed, in a CWTS core
    # source) or "preprint". Set by discovery, from the search API's own metadata;
    # see `scout.venue_tier` for the rule and quality_signals.md for why it keys on
    # the venue and not on the author's affiliation or the author count.
    #
    # None is a real third state, not a missing value: a feed post or a page added
    # by hand has no venue to judge, which is not the same as a bad one. It is also
    # what every document ingested before this field existed carries, which is the
    # honest reading of them -- nobody measured their venue.
    #
    # Orders the review queue (`repo.pending_documents`) and shows as a badge. It
    # decides nothing: the only venue that is ever refused is refused at the search
    # API, and never reaches a document at all (`scout.EXCLUDED_SOURCES`).
    venue_tier: Optional[str] = None
    # How many works this one cites, per OpenAlex -- a flag on the queue card when
    # it's zero, never a filter. 5 of 20 journal articles in the measured sample are
    # zero because their publisher never deposited references to Crossref, so this
    # is weak evidence about the paper and strong evidence about the publisher.
    reference_count: Optional[int] = None
    # The document's full text, fetched from its canonical_url on demand and cached
    # here so it doesn't have to be re-fetched every time it's needed -- see
    # assistant/text_writer.py, the only thing that ever writes this field. None
    # means "never fetched", not "fetched and empty". Deliberately absent from
    # PUBLIC_NODE_ATTRS below: too large to publish, and never fetched with a
    # reader's permission to redistribute in mind.
    full_text: Optional[str] = None


class PersonAttrs(_Attrs):
    full_name: str
    orcid: Optional[str] = None
    homepage: Optional[str] = None
    aliases: List[str] = []


class OrganizationAttrs(_Attrs):
    kind: str = "institution"   # group | lab | department | institution | company
    homepage: Optional[str] = None


class ArtifactAttrs(_Attrs):
    """A curator-authored document that sits ON TOP of the graph.

    Every other node type describes the *field* -- concepts, papers, people. An
    artifact is the curator's own writing about the *curation*: what the guide covers,
    what they make of one node, and what they make of several nodes together.

    The subjects are `remarks_on` edges, not an attribute, and their COUNT is not a
    type distinction. One subject is a note on a thing ("here's what I think about
    Literacy"); several is a note on how those things relate ("here's what Literacy
    has to do with these"). Same structure, same editor, same everything -- which is
    why `kind` has no `relation` value and the endpoints carry no from/to roles.

    An artifact over several subjects is a HYPEREDGE: a relation over a set rather
    than a pair. That is the reason this is a node and not an edge, and the reason
    the old `relates_to` edge could not have grown into it -- an edge is arity-2 by
    construction, and a remark on three concepts is not three remarks.

    `body` is authoritative for citations. Inline `[anchor](node:<uuid>)` links are
    parsed out of it on save and the DOCUMENTS among them become `cites` edges (see
    graph/links.py); the edges are a rebuilt projection, never hand-managed, so a
    citation cannot drift out of sync with the sentence holding it. A link to anything
    else -- a concept, a person, another remark -- is prose, not an edge: `remarks_on`
    is how a remark says what it is about, and an inline mention must not add one.

    `kind` identifies an artifact's role. `guide_scope` is the singleton that states
    what the guide is about; the discovery relevance filter screens candidates
    against it, so editing it changes what search accepts. It has no subjects -- it
    is about the guide, not about any node in it.

    `visibility` is the ONE place the reader/curator boundary lives. The rest of the
    graph is public -- a reader sees a concept's description and a document's summary
    -- but an artifact is the curator's own voice and is private until deliberately
    published. Default `private`, so nothing a curator writes reaches readers by
    accident; publishing is an act, not a thing you forget to prevent. It doubles as
    the "working note" mechanism: a private artifact IS a draft or a note to self,
    which is why there is no separate notes field. A string rather than a bool to
    leave room for a third, per-curator level ("only I see this") when multiple
    curators arrive -- that will be `private` narrowed by `created_by`, no migration.

    Applies to guide_scope too, mechanically, but the read surface never exposes any
    artifact but a public `note`, so the scope's value here is moot.

    `paint` colours the concepts of this remark in the reader's nested-polygon
    drawing, keyed by concept node id. It is on the REMARK and not on the concept
    because a concept is drawn once per remark that points at it, and those drawings
    are coloured independently: the same concept may be blue here and rust there.
    Empty by default -- an uncoloured concept draws with no fill, as all of them did
    before this field existed. A value is one colour or a `[start, end]` pair -- see
    `PaintColor`.

    `quilt` is this remark's assignment onto a quilt pattern -- which pattern, and
    which concept sits in which of its slots. None until a curator sets one, the same
    way a remark had no drawing at all before this field existed; unlike `paint`,
    there is no drawing without it, so a remark with no `quilt` simply does not
    appear on the reader's canvas. See `Quilt`.
    """
    kind: str = "note"      # guide_scope | note
    body: str = ""          # the prose itself
    visibility: str = "private"   # public | private -- private until published
    paint: Dict[str, PaintColor] = {}   # concept node id -> colour(s), reader-visible
    quilt: Optional[Quilt] = None       # this remark's slot assignment, reader-visible


class SourceAttrs(_Attrs):
    """Where documents come from: one RSS feed, a lab's blog, arXiv, OpenAlex.

    A node rather than an attribute on a person or organization, for reasons that
    all reduce to "a publication is its own thing": it has many writers, it outlives
    any one of them, some have no identifiable person at all, and only a node can
    carry the edges this needs -- `writes_at` from its authors, `part_of` to the org
    that runs it, and `sourced_from` on every document it produced.

    `mechanism` is how we fetch it, not what it is, so a blog that gains or loses an
    RSS feed doesn't change type. `enabled` is the curator's durable judgement --
    "this is not a source for this guide" -- and is deliberately distinct from the
    per-run narrowing in the search picker, which never persists.

    Polling bookkeeping (last success, consecutive failures, accept counts) is
    deliberately NOT here: every poll would write the node, and every write creates a
    `revisions` row, putting machine housekeeping into the audit log and in front of
    Undo. That state belongs outside the graph.
    """
    url: str                       # the feed/index url we actually fetch
    mechanism: str = "rss"         # rss | sitemap | page | api
    enabled: bool = True           # durable curator judgement, not per-run selection
    homepage: Optional[str] = None
    notes: str = ""                # curator's own note on what this source is for


NODE_ATTRS: Dict[NodeType, Type[_Attrs]] = {
    NodeType.CONCEPT: ConceptAttrs,
    NodeType.DOCUMENT: DocumentAttrs,
    NodeType.PERSON: PersonAttrs,
    NodeType.ORGANIZATION: OrganizationAttrs,
    NodeType.ARTIFACT: ArtifactAttrs,
    NodeType.SOURCE: SourceAttrs,
}


# --------------------------------------------------------------------------
# The public projection: which attributes a reader may see, per node type.
#
# An ALLOWLIST, not a denylist, and deliberately so -- this guards the reader/curator
# boundary, and a new field must be invisible to readers until someone decides it
# isn't. A denylist leaks every field added after it was written; an allowlist fails
# closed. `public_node_attrs` is applied by the read surface (GraphQueryService.
# public_graph) to every node it returns.
#
# What is OUT, and why, is the interesting part:
#   * concept.semantic_query/keywords/criteria -- search and categorization machinery,
#     not reader content. `description` is the reader-facing prose and is the only one
#     in; `semantic_query` is its private twin, written for a vector index rather than
#     for a person, and publishing it would show readers two definitions of one concept.
#   * document.status/dismissed/dismissal_note/proposed_*/authors_scraped/searchterms/
#     no_named_author
#     -- the whole review pipeline's bookkeeping. `summary`/`abstract`/`title` are the
#     reader's content; the rest is how the sausage got made.
#   * document.full_text -- fetched for the curation assistant's own use, never for
#     redistribution. Too large to publish as well: sending it on every document
#     would balloon the graph exported to readers.
#   * source.mechanism/enabled/notes -- how we fetch it and the curator's private
#     judgement of it. Only what a reader would recognise as "a publication" is in.
#   * artifact.* -- an artifact is never projected by attribute allowlist at all; the
#     read surface includes only PUBLIC artifacts and renders them itself. There is no
#     entry here for ARTIFACT precisely so no path can leak a private one field-by-field.
# --------------------------------------------------------------------------
PUBLIC_NODE_ATTRS: Dict[NodeType, Set[str]] = {
    NodeType.CONCEPT:      {"description"},
    NodeType.DOCUMENT:     {"title", "summary", "abstract", "publication",
                            "published_date", "canonical_url", "oa_pdf_url",
                            "source_type"},
    NodeType.PERSON:       {"full_name", "orcid", "homepage"},
    NodeType.ORGANIZATION: {"kind", "homepage"},
    NodeType.SOURCE:       {"url", "homepage"},
}


def public_node_attrs(node_type: NodeType, attributes: Dict) -> Dict:
    """The reader-visible subset of a node's attributes. Absent type == nothing
    public (the artifact case), so this fails closed for any type not listed."""
    allowed = PUBLIC_NODE_ATTRS.get(node_type, set())
    return {k: v for k, v in (attributes or {}).items() if k in allowed}


# --------------------------------------------------------------------------
# The same allowlist, for EDGES. Same contract, same reason: an edge attribute is
# private until someone decides it isn't. This existed for nodes and not for edges,
# which meant every attribute of every edge between two visible nodes shipped raw
# (PUBLIC_SURFACE_AUDIT.md §3) -- the one path the discipline above didn't cover.
#
# What is OUT, and why:
#   * funds.* -- ALL of it. The funding RELATIONSHIP stays visible (who funds whom is
#     exactly what the guide exists to record); the grant record does not. `note` is by
#     its own definition the curator's private annotation on a money relationship
#     between named parties, and it would have gone public silently the first time one
#     was filled in. `amount`/`currency`/`year` are a decision, not an inheritance --
#     `year` goes with `amount` because a year without a sum implies a specific grant
#     while withholding what made it specific.
#   * member_of.current -- the flag the codebase already documents as unreliable
#     (see WritesAtAttrs' docstring, README TODO #3): it is stored beside `end` and
#     left lying when `end` is patched by another route. Publishing it asserts
#     something about a real person's present affiliation that the guide itself does
#     not trust. `writes_at` never had one, correctly.
#   * about.confidence -- the discovery pipeline's relevance score. Curation exhaust,
#     the same category as concept.keywords above.
# --------------------------------------------------------------------------
PUBLIC_EDGE_ATTRS: Dict[EdgeType, Set[str]] = {
    EdgeType.MEMBER_OF: {"role", "start", "end"},
    EdgeType.WRITES_AT: {"role", "start", "end"},
}


def public_edge_attrs(edge_type: EdgeType, attributes: Dict) -> Dict:
    """The reader-visible subset of an edge's attributes. Absent type == nothing
    public, so every edge type not named above fails closed."""
    allowed = PUBLIC_EDGE_ATTRS.get(edge_type, set())
    return {k: v for k, v in (attributes or {}).items() if k in allowed}


# --------------------------------------------------------------------------
# Edge specs: which node types an edge may connect, plus its attribute schema.
# `sources`/`targets` are sets so a single edge type can be many-to-many
# (funds: any person or org can fund any person or org).
# --------------------------------------------------------------------------

class NoAttrs(_Attrs):
    pass


class AboutAttrs(_Attrs):
    confidence: Optional[float] = None   # how strongly the doc belongs to the concept


class MemberOfAttrs(_Attrs):
    role: Optional[str] = None
    start: Optional[str] = None          # ISO date; affiliation is temporal
    end: Optional[str] = None
    current: bool = True


class FundsAttrs(_Attrs):
    amount: Optional[float] = None
    currency: str = "USD"
    year: Optional[int] = None
    note: Optional[str] = None


class WritesAtAttrs(_Attrs):
    """A person writes at a publication -- temporal, because people move.

    Note what is NOT here: a `current` flag. `MemberOfAttrs` has one, computed from
    `end` and stored beside it, which means patching `end` by any other route leaves
    `current` lying (README TODO #3). Same shape of attribute, same trap; "is this
    current" is derived from `end` at read time and never stored.
    """
    role: Optional[str] = None
    start: Optional[str] = None          # ISO date
    end: Optional[str] = None            # None == still writing there


@dataclass(frozen=True)
class EdgeSpec:
    sources: Set[NodeType]
    targets: Set[NodeType]
    attrs: Type[_Attrs]


_C, _D, _P, _O, _S, _A = (
    NodeType.CONCEPT, NodeType.DOCUMENT, NodeType.PERSON, NodeType.ORGANIZATION,
    NodeType.SOURCE, NodeType.ARTIFACT,
)

EDGE_TYPES: Dict[EdgeType, EdgeSpec] = {
    EdgeType.SUBTOPIC_OF:     EdgeSpec({_C}, {_C}, NoAttrs),
    EdgeType.PREREQUISITE_OF: EdgeSpec({_C}, {_C}, NoAttrs),
    EdgeType.ABOUT:           EdgeSpec({_D}, {_C}, AboutAttrs),
    # An organization can be the author. Corporate authorship is standard
    # bibliographically (an OECD report, a standards document, an unbylined lab
    # announcement) and it is a real attribution, not an absence of one. Modelled by
    # widening this edge rather than adding a near-synonym like `published_by`,
    # which would also invite confusion with *venue* -- where a work appeared, which
    # is a different relation the guide still doesn't model.
    EdgeType.AUTHORED_BY:     EdgeSpec({_D}, {_P, _O}, NoAttrs),
    EdgeType.MEMBER_OF:       EdgeSpec({_P}, {_O}, MemberOfAttrs),
    # A source can sit inside an organization (a lab's blog part_of the lab) using
    # the nesting edge that already existed, rather than a new one.
    EdgeType.PART_OF:         EdgeSpec({_O, _S}, {_O}, NoAttrs),
    EdgeType.WORKS_ON:        EdgeSpec({_P}, {_C}, NoAttrs),
    EdgeType.FUNDS:           EdgeSpec({_P, _O}, {_P, _O}, FundsAttrs),
    # "This entity writes at this location" -- nothing more. An organization may
    # write at a source just as a person does; an earlier reading held that only a
    # person can (an org "publishes" rather than "writes for"), which made the
    # obvious thing impossible and bought no clarity. `part_of` remains a separate
    # relation: it says an org *contains* a source, not that it writes there.
    EdgeType.WRITES_AT:       EdgeSpec({_P, _O}, {_S}, WritesAtAttrs),
    # Provenance: how this document reached us. Deliberately NOT "where it was
    # published" -- for a feed those coincide, but OpenAlex is a catalogue that told
    # us about a work living elsewhere. Venue, if ever wanted, is a separate relation
    # rather than a redefinition of this one.
    EdgeType.SOURCED_FROM:    EdgeSpec({_D}, {_S}, NoAttrs),
    # What a piece of curator prose is about. Targets EVERY node type deliberately:
    # a remark on a person or a source is the same act as a remark on a concept, and
    # a restriction to concepts would be a guess about which remarks are worth making.
    #
    # Deliberately NOT modelled by widening `about`. `about` is the categorization
    # act -- the curator saying a document belongs to a concept -- and every pivot
    # cell counts it. Prose routed through it would inflate co-occurrence with
    # commentary that is not evidence, and the pivot is only worth reading because a
    # number in it means evidence.
    EdgeType.REMARKS_ON:      EdgeSpec({_A}, {_C, _D, _P, _O, _S, _A}, NoAttrs),
    # DERIVED, never hand-managed: rebuilt from the artifact's body on every save by
    # ArtifactService._sync_citations. Distinct from `remarks_on` because citing a
    # paper and remarking on one are different acts -- "this backs my point" versus
    # "here is what I make of this paper".
    EdgeType.CITES:           EdgeSpec({_A}, {_D}, NoAttrs),
}

# Concept-structure edges — the pure ontology the viewer shows by default.
# `relates_to` used to be here; see the note on EdgeType. What it gestured at now
# lives in artifacts, which are not ontology edges and never appear in this map.
ONTOLOGY_EDGE_TYPES = frozenset(
    {EdgeType.SUBTOPIC_OF, EdgeType.PREREQUISITE_OF}
)


# --------------------------------------------------------------------------
# Validation entry points used by the repository before every write.
# --------------------------------------------------------------------------

def validate_node_attrs(node_type: NodeType, attributes: Dict) -> Dict:
    """Validate/normalize a node's attributes, returning a clean dict for JSONB.

    Raises pydantic.ValidationError on a bad shape.
    """
    model = NODE_ATTRS[node_type]
    return model(**(attributes or {})).model_dump()


def validate_edge(
    edge_type: EdgeType,
    source_type: NodeType,
    target_type: NodeType,
    attributes: Dict,
) -> Dict:
    """Check endpoint types against the edge spec and validate its attributes.

    Raises ValueError if the endpoints are not allowed for this edge type, or
    pydantic.ValidationError on a bad attribute shape.
    """
    spec = EDGE_TYPES[edge_type]
    if source_type not in spec.sources:
        raise ValueError(
            f"{edge_type.value}: source must be one of "
            f"{sorted(t.value for t in spec.sources)}, got {source_type.value}"
        )
    if target_type not in spec.targets:
        raise ValueError(
            f"{edge_type.value}: target must be one of "
            f"{sorted(t.value for t in spec.targets)}, got {target_type.value}"
        )
    return spec.attrs(**(attributes or {})).model_dump()
