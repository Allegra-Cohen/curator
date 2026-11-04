"""The standing list of dismissed documents, written to a file the curator can read.

A dismissal is the one curation decision that leaves nothing to look at. Everything
else lands somewhere you can see it -- a document gets filed under a concept, a
concept appears in the table -- but rejecting a paper removes it from the queue and
from the graph, and the only record left is a soft-deleted row nothing reads back.
That makes two very different situations look identical from the UI: a search that
found little, and a curator rejecting most of what it found. This is the counterpart
to `discovery.write_report`, which exists for exactly the same reason on the other
side of the funnel.

**Regenerated, not appended.** The file is derived from the database each time it is
written: every dismissed document is still a row (`find_deleted_nodes(...,
where_flag="dismissed")`), carrying its `deleted_at` and its `dismissal_note`. So an
undone dismissal, or a URL pasted back in, drops out of the file by itself -- which
an append-only log could not do, and would have gone on asserting a tombstone that
no longer exists. What is lost is the history of dismissals that were reversed; that
lives in the revision log, which is where history belongs.

The list is exactly the tombstone set discovery consults (`tombstoned_urls` reads the
same flag on the same rows), so the file answers "why isn't this paper coming back?"
with the curator's own words.

One file PER ENVIRONMENT. The sandbox exists to be scribbled on, and a shared file
would let a throwaway dismissal there appear in the real guide's record.
"""

from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from graph.models import Node
from graph.repository import GraphRepository
from graph.types import NodeType


REPORT_DIR = Path(__file__).with_name("dismissal_reports")

# High enough to mean "all of them" for any guide a single curator will build, and
# still a bound rather than an unbounded scan. `find_deleted_nodes` requires one.
MAX_DISMISSALS = 5000

RULE = "=" * 72


def _stamp(dt: Optional[datetime]) -> str:
    """A timestamp in the reader's own clock.

    `deleted_at` is `timestamptz`, so psycopg hands it back in UTC -- which printed
    four hours off the "Regenerated" line at the top of the same file, making one
    dismissal look like two different times. `astimezone()` with no argument is the
    local zone; a naive datetime (only the tests construct one) is already local.
    """
    if not dt:
        return "(no date)"
    local = dt.astimezone() if dt.tzinfo else dt
    return local.strftime("%Y-%m-%d %H:%M")


def _concept_labels(repo: GraphRepository) -> Dict[str, str]:
    """id -> label for every live concept, to name a dismissed document's proposals.

    Proposals are stored as ids (see ConceptAttrs), and a concept can be renamed or
    deleted after the document was dismissed; an id nothing resolves is simply left
    out rather than printed raw, since a uuid tells the reader nothing.
    """
    return {str(c.id): c.label for c in
            repo.find_nodes(type=NodeType.CONCEPT, limit=MAX_DISMISSALS)}


def render(docs: List[Node], *, env: str, concepts: Dict[str, str],
           now: Optional[datetime] = None) -> str:
    """The report text. Split from the write so tests can read it without a file,
    and so the format is checkable against a list of nodes alone."""
    now = now or datetime.now()
    lines: List[str] = []
    add = lines.append
    add(f"Dismissed documents — {env}")
    add(f"Regenerated {now.strftime('%Y-%m-%d %H:%M')} · "
        f"{len(docs)} document{'' if len(docs) == 1 else 's'}, newest first")
    add("Each entry is a live tombstone: discovery won't offer the URL again, and")
    add("pasting it in by hand restores the original document (and clears its entry).")
    add(RULE)
    add("")

    if not docs:
        add("Nothing has been dismissed.")
        add("")
        return "\n".join(lines)

    for d in docs:
        a = d.attributes or {}
        # A dismissal made before the note existed, or one nobody explained, prints
        # as "not given" rather than blank -- an empty line reads as a formatting
        # slip, and the distinction (no reason recorded vs. no reason) isn't real.
        note = (a.get("dismissal_note") or "").strip()
        proposed = [concepts[i] for i in a.get("proposed_concept_ids", [])
                    if i in concepts]

        # The state it was in when it left: whether it had been reviewed and filed
        # or was still in the queue is most of what someone re-reading this wants,
        # because dismissing a reviewed document also removed it FROM the guide.
        state = [f"{a.get('status', 'pending')} when dismissed"]
        if a.get("source_type"):
            state.append(str(a["source_type"]))
        if a.get("venue_tier"):
            state.append(str(a["venue_tier"]))
        if proposed:
            state.append("proposed: " + ", ".join(proposed))

        add(f"{_stamp(d.deleted_at)}  {a.get('title') or d.label}")
        add(f"  reason : {note if note else '— not given'}")
        add(f"  url    : {a.get('canonical_url', '(none)')}")
        add(f"  state  : {' · '.join(state)}")
        add("")

    return "\n".join(lines)


def write_dismissal_report(repo: GraphRepository, env: str, *,
                           directory: Optional[Path] = None) -> Path:
    """Regenerate this environment's dismissal report and return where it landed."""
    directory = directory or REPORT_DIR
    directory.mkdir(exist_ok=True)
    docs = repo.find_deleted_nodes(NodeType.DOCUMENT, {},
                                   where_flag="dismissed", limit=MAX_DISMISSALS)
    path = directory / f"dismissed_{env}.txt"
    path.write_text(render(docs, env=env, concepts=_concept_labels(repo)))
    return path
