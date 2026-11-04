"""Inline links to nodes, inside the guide's own prose: `[anchor text](node:<uuid>)`.

One regex, one module, so the parser can never disagree with itself. The UI mirrors
this shape in TypeScript for rendering; this file is the definition. Three surfaces
write these links -- a remark's body, a document's curator summary, and a concept's
description -- and one renderer reads all three.

Why markdown link syntax rather than `\\cite{...}` or a bare token:

  * The link WRAPS SELECTED TEXT. The curator highlights a phrase, hits Cmd+K, picks
    something -- exactly the link-insertion gesture every editor already has. The
    anchor is therefore whatever they highlighted, so a syntax that wraps is the only
    one that fits the gesture.
  * The anchor is deliberately the curator's own words ("as this paper showed"), not
    a copy of the target's title. It is FREE to drift from that title, because it was
    never a copy of it -- which is the whole reason a title-copying scheme was
    rejected: there, drift is corruption.
  * Nobody types the uuid. It is machine-written by the picker and machine-read here,
    so its opacity costs nothing. That is what let the alternative -- human-readable
    citekeys, with the collision suffixes, immutability rule and backfill they drag
    in -- be dropped entirely rather than built.

**ONE scheme, not one per node type.** This was `doc:` when a document was the only
thing you could link to, and the obvious extension -- adding `remark:`, `concept:`,
`person:` -- is wrong twice over. It duplicates something the graph already knows
(ids are unique across types, so the node itself answers "what kind is this?"), and
the copy can go stale: `PeopleService.retype` turns a person into an organization IN
PLACE, keeping the id, so a `person:<uuid>` link would go on resolving while its own
prefix lied. The scheme says only "this link points inside the guide"; what it points
AT is a lookup. `doc:` is still parsed, because bodies written before this change hold
it, but nothing writes it any more.

Which links become `cites` EDGES is therefore a decision made against the graph, not
against the text: `ArtifactService._sync_citations` resolves the ids and keeps the
documents. A remark citing a paper is a claim about evidence and is worth an edge; a
remark linking a concept is not -- `remarks_on` is the deliberate way to say what a
remark is about, and an inline mention must not quietly become a subject.

A malformed or unresolvable link is NOT an error here. `parse_links` reports what it
found and `linked_node_ids` skips what it cannot read; refusing to save prose because
one link is broken is the wrong failure for an editor, and a link whose target was
later deleted has to be *shown* as broken, not silently dropped.

A link may also carry a paragraph number: `node:<uuid>#p12`, meaning "not just this
document -- this specific paragraph in it." Only the curation assistant's evidence
tables write this (assistant/evidence_table_markdown.py); nobody types it by hand, so
it is never part of the picker's anchor gesture described above. It exists so a real,
already-found quote can be clicked straight to where it lives in the Document Viewer,
instead of the curator hunting the paragraph down by eye.

`#p0` is a reserved special case, not a real paragraph (real ones are always 1 and
up): "open the document, there's no paragraph to scroll to." The same evidence
tables use it for a document that couldn't be read at all, or was read but matched
nothing -- named by title only, with nothing to point at. ui/src/components/ChatPane.tsx
is where 0 is told apart from a real paragraph number.
"""

import re
from dataclasses import dataclass
from typing import List, Optional
from uuid import UUID

# [anchor](node:0f3a91c8-...#p12). The anchor may not contain `]`, so nesting is not
# supported and does not need to be -- an anchor is a phrase, not a document. The
# `#p<N>` paragraph suffix is optional; `doc:` is the legacy spelling of the scheme,
# see the module docstring.
LINK_RE = re.compile(r"\[([^\]]*)\]\((?:node|doc):([^)\s#]+)(?:#p(\d+))?\)")


@dataclass(frozen=True)
class Link:
    """One inline link as it appears in the body.

    `node_id` is None when the uuid could not be parsed -- a hand-mangled link. Kept
    rather than discarded so the editor can point at it; `raw` is what was actually
    written, which is the only thing that would let anyone fix it.
    """
    anchor: str          # the curator's words, as highlighted
    raw: str             # the id exactly as it appears in the body
    node_id: Optional[UUID]
    paragraph: Optional[int]   # the #p<N> suffix, when present
    start: int           # character offset in the body, for editor affordances
    end: int


def parse_links(body: str) -> List[Link]:
    """Every link in the body, in order of appearance, malformed ones included.

    Duplicates are preserved: linking the same paper in three sentences is three
    links, and an editor that collapsed them could not highlight the third.
    """
    out: List[Link] = []
    for m in LINK_RE.finditer(body or ""):
        raw = m.group(2)
        try:
            node_id: Optional[UUID] = UUID(raw)
        except ValueError:
            node_id = None
        paragraph = int(m.group(3)) if m.group(3) is not None else None
        out.append(Link(anchor=m.group(1), raw=raw, node_id=node_id, paragraph=paragraph,
                        start=m.start(), end=m.end()))
    return out


def linked_node_ids(body: str) -> List[UUID]:
    """The distinct nodes this body links to, first-mention order.

    Deduplicated here and only here: the relations built from this are SETS -- a
    remark either cites a paper or it doesn't -- while the body's links are
    positional. That is the whole difference between a projection and its source.
    """
    seen: List[UUID] = []
    for link in parse_links(body):
        if link.node_id is not None and link.node_id not in seen:
            seen.append(link.node_id)
    return seen


def make_link(anchor: str, node_id: UUID, paragraph: Optional[int] = None) -> str:
    """The token the picker inserts. Here so the writer and the reader stay one edit
    apart -- a format change that touched only the regex would break insertion
    silently.

    `paragraph`, when given, is the only way a #p<N> suffix ever gets written --
    see the module docstring."""
    suffix = f"#p{paragraph}" if paragraph is not None else ""
    return f"[{anchor}](node:{node_id}{suffix})"
