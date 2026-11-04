"""The review queue's shape, written to a file the curator can read.

`repo.pending_documents` returns the queue in the order it should be *worked* --
best venue first, then oldest -- which is the right order for deciding one document
at a time and tells you nothing about the pile as a whole. Is this a run of current
work or a backfill reaching into the 2010s? Which of it is the field already reading?
The queue screen cannot answer either, because both are properties of the set.

**One file per run, stamped with the moment it was written** -- the convention
`discovery.write_report` already follows, and for the same reason. A queue report is
a statement about a moment: which papers were waiting, how old they were, how often
they had been cited *that day*. Overwriting one file would make each run destroy the
only record of the last, and the interesting readings here are comparative -- what
the search added, whether the queue is ageing, whether a paper's citations moved.
That is the opposite of `dismissal_report`, which regenerates a single file on
purpose: it describes a standing set (the live tombstones) rather than a moment, so
an old copy of it would simply be wrong.

The environment is in the filename rather than in a directory, and it is not
optional: a sandbox exists to be scribbled on, and a throwaway run there must never
be mistaken for the real guide's record.

Files accumulate, deliberately. Nothing prunes them (`search_reports` doesn't
either); they are small and the history is the point.

Three sections, and the third is the only one that reads the documents rather than
their metadata: CHRONOLOGY and CITATIONS answer "when is this work from" and "who is
reading it", both from fields already in hand, while SEMANTIC GROUPS answers "which of
these say the same thing" -- which needs the abstracts embedded, and is therefore the
one section that can be absent (`--no-embeddings`, or no model installed) without the
report being any less true.

It is a reading aid and nothing else: **nothing here writes to the graph**, proposes
no categorization, and drops nothing from the queue. Citation counts are fetched live
(see `MetadataResolver.cited_by_counts`) and stamped with the moment they were
fetched, because a count stored in a node would be stale the next day.

Written from two places, both named: this module's CLI, and the end of a search run
(`api._refresh_queue_report`) -- a run is the only thing that changes the queue
wholesale, which makes it the moment a fresh report is worth having.
"""

import argparse
import sys
import textwrap
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from graph.models import Node
from graph.repository import GraphRepository
from pipeline_reports.queue_structure import (
    AGE_PER_YEAR, Embedder, STALE_YEARS, DUPLICATE_SIMILARITY, QUALITY_BOUND, SIMILARITY_FLOOR,
    SIMILARITY_PERCENTILE, VENUE_STEP, Chronology, CitationLookup, Citations, Groups,
    chronology, citations, groups, published,
)

REPORT_DIR = Path(__file__).with_name("queue_reports")

RULE = "=" * 72
THIN = "-" * 72

# The page. Titles run to 143 characters in the real queue and the median is 71, so
# nothing here is truncated -- a clipped title is exactly the thing the curator then
# cannot look up, and this is a file to be read rather than a terminal column. Long
# text wraps under itself instead, which keeps the left-hand columns scannable.
PAGE_WIDTH = 96


def _title(doc: Node) -> str:
    """The title as a single clean line.

    Titles arrive with the publisher's own markup in them -- Figshare deposits are
    routinely `<b>…</b>` -- and a report is not the place to render it or to fix the
    record. The tags are stripped for display only; the node keeps what was scraped.
    """
    raw = ((doc.attributes or {}).get("title") or doc.label or "").strip()
    out, depth = [], 0
    for ch in raw:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(ch)
    return " ".join("".join(out).split())


def _wrapped(prefix: str, text: str, width: int = PAGE_WIDTH) -> List[str]:
    """`text` printed in full after `prefix`, wrapping under itself.

    The hanging indent is the width of the prefix, so a wrapped title stays inside
    its own column and the dates, counts and tiers to its left keep lining up. Every
    caller that prints a title goes through this: nothing in the report is truncated,
    because a title cut off at 58 characters is precisely the one a curator has to go
    and look up somewhere else.
    """
    body = " ".join((text or "").split())
    if not body:
        return [prefix.rstrip()]
    lines = textwrap.wrap(body, width=max(20, width - len(prefix))) or [body]
    pad = " " * len(prefix)
    return [prefix + lines[0]] + [pad + line for line in lines[1:]]


def _add_wrapped(add, prefix: str, text: str, width: int = PAGE_WIDTH) -> None:
    for line in _wrapped(prefix, text, width):
        add(line)


def _tier(doc: Node) -> str:
    """Venue tier as a fixed-width badge. `None` is a third state, not a bad one --
    a feed post or a hand-added page has no venue to judge -- so it prints as a
    blank rather than as `preprint`."""
    return f"{(doc.attributes or {}).get('venue_tier') or '':<8}"


def _when(doc: Node) -> str:
    when = published(doc)
    return when.isoformat() if when else "(undated)"


def render_chronology(chron: Chronology, add) -> None:
    add("CHRONOLOGY")
    add(THIN)
    if not chron.buckets and not chron.undated:
        add("The queue is empty.")
        add("")
        return

    if chron.earliest and chron.latest:
        years = chron.latest.year - chron.earliest.year
        add(f"Span    {chron.earliest.isoformat()} → {chron.latest.isoformat()} "
            f"({years} year{'' if years == 1 else 's'}) · "
            f"median year {chron.median_year}")
    if chron.undated:
        add(f"Undated {len(chron.undated)} document"
            f"{'' if len(chron.undated) == 1 else 's'} — no date was scraped; "
            f"they are listed last, never guessed at")
    add("")

    # A bar per year, scaled to the fullest one. The distribution is the thing worth
    # seeing at a glance -- whether this is a run of current work or a backfill --
    # and it is the one part of the report that answers before it is read.
    widest = max((len(b.docs) for b in chron.buckets), default=0)
    for bucket in chron.buckets:
        bar = "█" * max(1, round(len(bucket.docs) / widest * 32)) if widest else ""
        add(f"  {bucket.year}  {len(bucket.docs):>3}  {bar}")
    add("")

    for bucket in chron.buckets:
        add(f"  {bucket.year}")
        for doc in bucket.docs:
            a = doc.attributes or {}
            _add_wrapped(add, f"    {_when(doc)}  {_tier(doc)}  ", _title(doc))
            if a.get("publication"):
                # Marked with a dash so it cannot be mistaken for the tail of a
                # wrapped title now that titles are allowed to run over a line.
                _add_wrapped(add, f"    {'':<10}  {'':<8}  — ",
                             str(a["publication"]))
        add("")

    if chron.stale:
        add(f"  Published before {chron.asof.year - 5} ({len(chron.stale)})")
        add("  Old work in a fast-moving queue is either a foundational text worth")
        add("  placing carefully or a keyword artifact. Worth deciding on purpose.")
        for doc in chron.stale:
            _add_wrapped(add, f"    {_when(doc)}  ", _title(doc))
        add("")

    if chron.undated:
        add(f"  Undated ({len(chron.undated)})")
        for doc in chron.undated:
            _add_wrapped(add, f"    {'':<10}  {_tier(doc)}  ", _title(doc))
        add("")


def render_citations(cites: Citations, add) -> None:
    add("CITATIONS")
    add(THIN)
    if not cites.rows:
        add("The queue is empty.")
        add("")
        return

    if cites.skipped:
        add("Not fetched (--no-citations). This section needs the network; the rest")
        add("of the report does not.")
        add("")
        return
    if cites._errors:
        add(f"Lookup failed: {cites._errors[0]}")
        add("Counts below are all unknown for that reason, not because the papers")
        add("are uncited.")
        add("")

    known, unknown = cites.known, cites.unknown
    stamp = cites.fetched_at.strftime("%Y-%m-%d %H:%M") if cites.fetched_at else "—"
    add(f"Fetched {stamp} from OpenAlex · {len(known)} of {len(cites.rows)} resolved")
    add("A count is a live number, not a fact about the paper: it is fetched when")
    add("this file is written and stored nowhere. An unknown is NOT a zero — it")
    add("means the URL names no DOI, or OpenAlex has no record of it.")
    add("")
    add("Cited-by is confounded by age, so /yr divides by the years since")
    add("publication. Anything under a year old has no rate: it has not had time.")
    add("")
    add(f"  {'cites':>6}  {'/yr':>6}  {'refs':>5}  title")

    for row in known:
        rate = f"{row.per_year:.1f}" if row.per_year is not None else "—"
        refs = row.reference_count if row.reference_count is not None else "—"
        _add_wrapped(add, f"  {row.count:>6}  {rate:>6}  {str(refs):>5}  ",
                     _title(row.doc))
    add("")

    if unknown:
        add(f"  Unknown ({len(unknown)}) — no DOI in the URL, or not in OpenAlex")
        for row in unknown:
            url = (row.doc.attributes or {}).get("canonical_url") or "(no url)"
            _add_wrapped(add, "    ", _title(row.doc))
            # A truncated URL is not a URL. It goes on its own line at full length,
            # unwrapped, so it can still be copied out in one piece.
            add(f"      {url}")
        add("")


def _facts(doc: Node, q, asof: date) -> str:
    """The facts that ranked a paper, never a composite score.

    "2021 · journal · 34 cites" is three things the curator can disagree with
    individually. A single number would be a verdict nobody could audit -- and the
    whole point of §4.6 is that the reasons print, not the arithmetic.

    `stale` prints here too, deliberately, which means the report can call the same
    paper old in the chronology and recommend it here. That contradiction is real and
    belongs on the page: age is uncapped in the ranking precisely because an old paper
    that survived the search was usually chosen on purpose, and the curator is the one
    who gets to decide which reading of it wins.
    """
    a = doc.attributes or {}
    bits = []
    if q and q.published:
        bits.append(str(q.published.year))
    bits.append(str(a.get("venue_tier") or "untiered"))
    if q:
        # Unknown is NOT zero: it means the URL names no DOI, or OpenAlex has no
        # record. Printing it as 0 would be the same false claim the citations
        # section already refuses to make.
        if q.citations is None:
            bits.append("cites unknown")
        else:
            bits.append(f"{q.citations} cite{'' if q.citations == 1 else 's'}")
    if q and q.published and q.published.year < asof.year - STALE_YEARS:
        bits.append("stale")
    return " · ".join(bits)


def _add_paper(add, prefix: str, doc: Node, q, asof: date,
               trailer: str = "") -> None:
    """A paper as a title in full, with its facts on the line beneath.

    The facts used to ride on the end of the title line, which only worked while the
    title was being clipped to fit. They are their own line now: the title is the
    thing being identified and gets the whole width, and the facts sit under it.

    Indented two further than the title's own hanging indent, which matters more than
    it looks: a title long enough to wrap puts a second line at the hanging indent, so
    facts printed there too would be indistinguishable from the rest of the title --
    and in a list with no leading column, from the start of the next paper.
    """
    _add_wrapped(add, prefix, _title(doc))
    facts = _facts(doc, q, asof)
    if trailer:
        facts = f"{facts} · {trailer}"
    _add_wrapped(add, " " * len(prefix) + "  ", facts)


def render_groups(grp: Groups, add) -> None:
    add("SEMANTIC GROUPS")
    add(THIN)
    add("Which queued papers say much the same thing, so that reading one tells you")
    add("roughly what is in the others. A STAND-IN is the paper you actually read;")
    add("the papers under it can then be skimmed or skipped. A stand-in names its own")
    add("group -- there are no invented cluster labels here.")
    add("")

    if grp.skipped:
        add("Not computed (--no-embeddings). This section needs a local embedding")
        add("model; the rest of the report does not.")
        add("")
        return
    if grp.error:
        add(f"Could not compute: {grp.error}")
        add("The chronology and citations above are unaffected.")
        add("")
        return
    if not grp.groups and not grp.alone and not grp.unplaceable and not grp.oversized:
        add("The queue is empty.")
        add("")
        return

    # Every setting, in every file, so that two timestamped reports can actually be
    # compared -- and so the curator can argue with a number instead of guessing at
    # one. See QUEUE_SEMANTICS_MEASUREMENTS.md §5 for where each came from.
    total = (grp.placed + grp.duplicate_copies + len(grp.unplaceable)
             + len(grp.oversized))
    accounted = [f"{grp.placed} placed"]
    if grp.duplicate_copies:
        accounted.append(f"{grp.duplicate_copies} duplicate copy"
                         if grp.duplicate_copies == 1
                         else f"{grp.duplicate_copies} duplicate copies")
    if grp.unplaceable:
        accounted.append(f"{len(grp.unplaceable)} with no abstract")
    if grp.oversized:
        accounted.append(f"{len(grp.oversized)} too long to place")
    add(f"Queue    {total} documents — {' · '.join(accounted)}")
    add(f"         {grp.pair_count} pairs compared")
    pv = f"{grp.percentile_value:.4f}" if grp.percentile_value is not None else "—"
    add(f"Close    similarity ≥ {grp.threshold:.4f}")
    add(f"         the higher of: top {100 - SIMILARITY_PERCENTILE:g}% of this "
        f"queue's pairs ({pv}) and an absolute floor ({grp.floor:.2f})")
    add(f"Same     similarity ≥ {DUPLICATE_SIMILARITY:.2f} is treated as one document "
        f"filed twice")
    small, large = _coverage_gaps()
    add("Ranking  coverage first; venue, citations and age may move a paper by at")
    add(f"         most ×{QUALITY_BOUND:g}, so quality can overturn a coverage ratio "
        f"of {QUALITY_BOUND ** 2:.2f}× —")
    add(f"         a {small} can out-rank a {small + 1}; a 2 never out-ranks a "
        f"{large}.")
    add(f"         One venue tier ≈ {10 ** VENUE_STEP:.1f}× in citations "
        f"(journal vs preprint ≈ {10 ** (2 * VENUE_STEP):.0f}×);")
    add(f"         age adds {AGE_PER_YEAR:g}/year, uncapped.")
    add("These are settings, not findings. Changing one changes the order below.")
    add("")

    if grp.duplicates:
        # Above the groups on purpose: a duplicate is a thing to resolve before the
        # grouping is read, not a reading recommendation to act on.
        add(f"  Duplicates ({len(grp.duplicates)}) — almost certainly one document "
            "filed twice.")
        add("  `nodes_doc_url_uniq` cannot see these: two canonical URLs, one paper.")
        for pair in grp.duplicates:
            _add_wrapped(add, f"    {pair.similarity:.4f}  ", _title(pair.a))
            for node in (pair.a, pair.b):
                url = (node.attributes or {}).get("canonical_url") or "(no url)"
                # Full length and unwrapped: a URL broken across lines is one the
                # curator cannot paste anywhere, which defeats printing it at all.
                add(f"            {url}")
        add("")

    if grp.groups:
        add(f"  Start with ({len(grp.groups)} stand-in"
            f"{'' if len(grp.groups) == 1 else 's'})")
        for n, group in enumerate(grp.groups, 1):
            span = (f"{group.loosest:.2f}" if len(group.covered) == 1
                    else f"{group.loosest:.2f}–{group.tightest:.2f}")
            _add_paper(add, f"    {n}. ", group.stand_in,
                       grp.quality.get(group.stand_in.id), grp.asof,
                       trailer=f"stands in for {len(group.covered)} paper"
                               f"{'' if len(group.covered) == 1 else 's'} "
                               f"at {span}")
            for node, sim in zip(group.covered, group.similarities):
                _add_paper(add, f"         {sim:.2f}  ", node,
                           grp.quality.get(node.id), grp.asof)
            add("")

    if grp.alone:
        # The finding that tells the curator how long the queue will actually take.
        add(f"  No stand-in ({len(grp.alone)})")
        add("  Nothing else in the queue is close to these, so each has to be read on")
        add("  its own. This is the number that says how long the queue will take.")
        for node in grp.alone:
            # A bullet because this is the one list with no leading column -- no
            # similarity, no count, no date -- and without a marker the eye cannot
            # find where one wrapped title ends and the next paper begins.
            _add_paper(add, "    · ", node, grp.quality.get(node.id), grp.asof)
        add("")

    if grp.unplaceable:
        add(f"  Not enough text to place ({len(grp.unplaceable)})")
        add("  No abstract was scraped for these. A title is a few words and its")
        add("  vector is mostly phrasing, so they are left ungrouped rather than")
        add("  grouped badly — nothing is claimed about them in either direction.")
        for node in grp.unplaceable:
            # Same reason as `alone` above: the tier badge is blank for most of
            # these, so it cannot be the thing that marks a new entry.
            _add_wrapped(add, f"    · {_tier(node)}  ", _title(node))
        add("")

    if grp.oversized:
        add(f"  Too long to place ({len(grp.oversized)})")
        add("  These have plenty of information — more than most of the queue — but")
        add("  embedding them costs more compute than the rest of the queue combined,")
        add("  so they are set aside for you to judge rather than grouped. Often the")
        add("  sign that a full text landed in the abstract field.")
        for node in grp.oversized:
            # The length is the whole reason the document is in this bucket, and the
            # number is what tells the curator which kind it is: a genuinely long
            # abstract reads differently from a 20,000-character full text, and only
            # the figure distinguishes them at a glance.
            chars = len((node.attributes or {}).get("abstract") or "")
            _add_wrapped(add, f"    · {chars:>7,} chars  ", _title(node))
        add("")


def _coverage_gaps() -> Tuple[int, int]:
    """The two examples that make QUALITY_BOUND concrete, derived from it.

    Computed rather than written down: §4.4 asks that changing the bound be a
    one-line edit whose effect is visible in the next run's output, and a sentence
    typed by hand would still say "five" long after the constant had moved.

    Returns the smallest coverage a one-paper gap can be overturned at, and the
    smallest coverage a paper standing in for 2 can never reach.
    """
    worst = QUALITY_BOUND ** 2
    small = 1
    while (small + 1) / small > worst:
        small += 1
    return small, int(2 * worst) + 1


def render(docs: Sequence[Node], *, env: str,
           lookup: Optional[CitationLookup] = None,
           embed: Optional[Embedder] = None,
           asof: Optional[date] = None,
           now: Optional[datetime] = None) -> str:
    """The report text.

    Split from the write so the format is checkable against a list of nodes with no
    database, and so the citation lookup can be a dict in a test instead of a
    request. `asof`/`now` are injected for the same reason: "older than five years"
    has to mean the same thing on every run of the suite.

    `embed` follows exactly the same contract as `lookup`, and for the same reason:
    it is the only door a 500MB model can come through, so a test can hand over a
    dict of vectors and the CLI can hand over nothing at all.
    """
    now = now or datetime.now()
    asof = asof or now.date()
    lines: List[str] = []
    add = lines.append

    add(f"Queue structure — {env}")
    add(f"Written {now.strftime('%Y-%m-%d %H:%M')} · "
        f"{len(docs)} document{'' if len(docs) == 1 else 's'} pending")
    add("A reading aid for working the queue: it proposes an order to look in and")
    add("never applies one. Nothing here writes to the graph.")
    add("A snapshot, not a standing record — citation counts in particular are")
    add("true as of the time above and nowhere else.")
    add(RULE)
    add("")

    render_chronology(chronology(docs, asof=asof), add)
    add(RULE)
    add("")
    render_citations(citations(docs, lookup, asof=asof, now=now), add)
    add(RULE)
    add("")
    # The citation lookup runs twice on a full report -- once for the section above
    # and once to weight the stand-ins. That is a cache hit in `doi_lookup`, not a
    # second round of requests, and passing the counts through by hand would couple
    # two sections that are otherwise independent.
    render_groups(groups(docs, embed, lookup, asof=asof), add)

    return "\n".join(lines)


def write_queue_report(repo: GraphRepository, env: str, *,
                       lookup: Optional[CitationLookup] = None,
                       embed: Optional[Embedder] = None,
                       directory: Optional[Path] = None,
                       now: Optional[datetime] = None) -> Path:
    """Write a new report for this environment and return where it landed.

    Never overwrites: the file is named for the moment it was written, so a run's
    report is still there after the next run.
    """
    now = now or datetime.now()
    directory = directory or REPORT_DIR
    directory.mkdir(exist_ok=True)

    stamp = now.strftime("%Y-%m-%d_%H%M%S")
    path = directory / f"queue_{env}_{stamp}.txt"
    # Two runs inside the same second would otherwise overwrite each other, which is
    # the one thing this naming exists to prevent. `discovery.write_report` carries
    # the same guard for the same reason.
    n = 2
    while path.exists():
        path = directory / f"queue_{env}_{stamp}_{n}.txt"
        n += 1

    path.write_text(render(repo.pending_documents(), env=env, lookup=lookup,
                           embed=embed, now=now))
    return path


def default_lookup() -> CitationLookup:
    """The live OpenAlex lookup. Its own function so a caller that wants the report
    without a network can pass `None` and mean it."""
    from doi_lookup import default_resolver
    return default_resolver().cited_by_counts


def default_embedder() -> Optional[Embedder]:
    """The local embedding model, or None if it isn't installed on this machine.

    Unlike `default_lookup`, this one CAN legitimately come back empty: the citation
    lookup needs a network that usually exists, and this needs ~2GB of torch that
    often does not. Returning None costs the semantic section and nothing else --
    the same outcome as `--no-embeddings`, reached without the curator having to know
    what is installed. `embeddings` is imported here rather than at module scope so
    that a report run without it never pays for the import.
    """
    try:
        from pipeline_reports.embeddings import embedder
        return embedder()
    except ImportError:
        return None


def main(argv: Optional[Sequence[str]] = None) -> int:
    from dotenv import load_dotenv

    from graph import GraphRepository, connect
    from graph.db import env_dsn, load_active_env

    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env", choices=("sandbox", "guide"), default=None,
                    help="which database to read (default: the active environment)")
    ap.add_argument("--no-citations", action="store_true",
                    help="skip the OpenAlex lookup; the report still writes")
    ap.add_argument("--no-embeddings", action="store_true",
                    help="skip the semantic grouping; the report still writes")
    args = ap.parse_args(argv)

    env = args.env or load_active_env()
    repo = GraphRepository(connect(env_dsn(env)))
    path = write_queue_report(
        repo, env,
        lookup=None if args.no_citations else default_lookup(),
        embed=None if args.no_embeddings else default_embedder())
    print(f"{path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
