"""What structure can be recovered from a review queue, given only its metadata.

The queue is a flat list ordered by venue tier and arrival (`repo.pending_documents`),
which is the right order to *work* it and tells you nothing about what is in it. This
module answers the questions the list can't: when was this work published, and which
of it is anyone else reading.

**Analysis only -- no database, no filesystem, no network.** Every function takes a
list of documents and returns a value; the citation lookup arrives as a callable the
caller supplies. That is what makes it testable against a handful of hand-built nodes,
and it is the same split that keeps `dismissal_report.render` honest. Rendering lives
in `queue_report.py`; fetching lives in `doi_lookup.py`.

The hard constraint shaping all of it: **we do not store document text.** There is a
title, a venue, a date, and -- for about three documents in four -- an abstract.
Nothing here may quietly do worse when a field is missing than it does when the field
is absent: an undated document goes in an undated bucket, an uncitable one prints as
unknown, and one with no abstract is not placed among the groups at all. None of them
is guessed at.

That one-in-four figure is measured, and it used to read "19 in 20" here on the
strength of an impression. It matters more than a footnote: the documents with no
abstract are not scattered noise but a kind -- Substack posts, encyclopedia entries,
court filings, the followed-source half of the queue -- so any text method speaks for
three quarters of the pile and has to say which quarter it is silent about.
"""

import math
from dataclasses import dataclass, field
from datetime import date, datetime
from statistics import median
from typing import Callable, Dict, List, Optional, Sequence, Tuple
from uuid import UUID

from graph.models import Node


# A paper this much older than the queue around it is worth a second look before it
# is filed: in a field moving this fast it is either a foundational text that
# deserves careful placement or a search artifact that drifted in on a keyword.
# Neither is a reason to drop anything -- this only ever changes what gets *printed*.
STALE_YEARS = 5

# The citation lookup's shape: URLs in, count-or-None per URL out. Declared as a type
# so the tests can pass a dict lookup and never touch the network.
CitationLookup = Callable[[Sequence[str]], Dict[str, Optional[int]]]


def published(doc: Node) -> Optional[date]:
    """The publication date, from whatever precision the scraper recorded.

    `published_date` is an ISO string "matching the scraper's output" (DocumentAttrs),
    and in practice that is three different precisions: `2024-03-17`, `2024-03`, and
    a bare `2024`. A partial date is a real date to a coarser resolution, so it is
    read to the start of its period rather than discarded -- the year is the part
    every section here actually uses.

    Returns None for anything unparseable, which the callers keep as a bucket of its
    own. Inventing a date to make a document sortable is how a 1997 paper ends up
    printed as this year's.
    """
    raw = ((doc.attributes or {}).get("published_date") or "").strip()
    if not raw:
        return None
    for fmt, pad in (("%Y-%m-%d", raw[:10]), ("%Y-%m", raw[:7]), ("%Y", raw[:4])):
        try:
            return datetime.strptime(pad, fmt).date()
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------
# Chronology
# --------------------------------------------------------------------------

@dataclass
class YearBucket:
    year: int
    docs: List[Node]


@dataclass
class Chronology:
    """The queue by publication year, newest first."""
    buckets: List[YearBucket]
    undated: List[Node]
    earliest: Optional[date]
    latest: Optional[date]
    median_year: Optional[int]
    stale: List[Node]           # published more than STALE_YEARS before `asof`
    asof: date

    @property
    def dated(self) -> int:
        return sum(len(b.docs) for b in self.buckets)


def chronology(docs: Sequence[Node], *, asof: Optional[date] = None,
               stale_years: int = STALE_YEARS) -> Chronology:
    """Group the queue by publication year and describe its shape.

    `asof` is the day the report is being written, injected rather than read from the
    clock so "older than five years" means the same thing every time the test runs.
    """
    asof = asof or date.today()
    by_year: Dict[int, List[Node]] = {}
    undated: List[Node] = []
    dates: List[date] = []

    for doc in docs:
        when = published(doc)
        if when is None:
            undated.append(doc)
            continue
        dates.append(when)
        by_year.setdefault(when.year, []).append(doc)

    # Within a year, newest first -- the same order the buckets are in, so reading
    # top to bottom never reverses direction.
    for year_docs in by_year.values():
        year_docs.sort(key=lambda d: (published(d) or date.min), reverse=True)

    cutoff = asof.year - stale_years
    stale = sorted((d for d in docs if (w := published(d)) and w.year < cutoff),
                   key=lambda d: published(d) or date.min)

    return Chronology(
        buckets=[YearBucket(y, by_year[y]) for y in sorted(by_year, reverse=True)],
        undated=undated,
        earliest=min(dates) if dates else None,
        latest=max(dates) if dates else None,
        # The median of the years, not of the dates: the report prints a year, and a
        # median date would claim a precision the partial dates don't have.
        median_year=int(median([d.year for d in dates])) if dates else None,
        stale=stale,
        asof=asof,
    )


# --------------------------------------------------------------------------
# Citations
# --------------------------------------------------------------------------

@dataclass
class CitationRow:
    doc: Node
    count: Optional[int]              # None = not looked up / not found / offline
    published: Optional[date]
    per_year: Optional[float]         # None unless the paper is at least a year old
    reference_count: Optional[int]    # works this one CITES -- the other direction

    @property
    def known(self) -> bool:
        return self.count is not None


@dataclass
class Citations:
    """Citation counts for the queue, as of the moment they were fetched."""
    rows: List[CitationRow]           # known counts first, descending; unknown last
    fetched_at: Optional[datetime]    # None when the lookup was skipped entirely
    asof: date
    skipped: bool = False             # --no-citations, or no lookup available
    _errors: List[str] = field(default_factory=list)

    @property
    def known(self) -> List[CitationRow]:
        return [r for r in self.rows if r.known]

    @property
    def unknown(self) -> List[CitationRow]:
        return [r for r in self.rows if not r.known]


def citations(docs: Sequence[Node], lookup: Optional[CitationLookup] = None, *,
              asof: Optional[date] = None,
              now: Optional[datetime] = None) -> Citations:
    """How often the wider literature cites each queued document.

    Nothing in the graph stores this and nothing should: a count written into a node
    is stale the next day and no code path would ever refresh it. So it is fetched
    when it is printed and stamped with `fetched_at`, and `lookup=None` (offline, or
    `--no-citations`) is an ordinary outcome that still produces a report.

    **Age is the confound, and the whole reason `per_year` exists.** A three-month-old
    preprint with two citations is not less-read than a 2019 paper with thirty; it has
    had no time. Anything under a year old gets `per_year=None` rather than a rate
    computed over a fraction of a year, which would flatter exactly the newest and
    least-established work in the queue.

    Ordering puts known counts first, descending, then the unknowns by title. Sorting
    unknowns in among the zeros would be the same claim as printing them as zero.
    """
    asof = asof or date.today()
    urls = [(doc.attributes or {}).get("canonical_url") or "" for doc in docs]

    counts: Dict[str, Optional[int]] = {}
    fetched_at: Optional[datetime] = None
    errors: List[str] = []
    if lookup is not None:
        try:
            counts = lookup([u for u in urls if u]) or {}
            fetched_at = now or datetime.now()
        except Exception as e:                      # noqa: BLE001
            # A report that cannot reach OpenAlex still prints. `cited_by_counts`
            # already swallows request failures; this catches everything else so a
            # surprise from the network layer can't cost the curator the two sections
            # that don't need a network at all.
            errors.append(f"{type(e).__name__}: {e}")

    rows: List[CitationRow] = []
    for doc, url in zip(docs, urls):
        when = published(doc)
        count = counts.get(url)
        years = (asof - when).days / 365.25 if when else None
        rows.append(CitationRow(
            doc=doc,
            count=count,
            published=when,
            per_year=(count / years) if (count is not None and years and years >= 1.0)
                     else None,
            reference_count=(doc.attributes or {}).get("reference_count"),
        ))

    rows.sort(key=lambda r: (r.count is None,
                             -(r.count or 0),
                             ((r.doc.attributes or {}).get("title") or r.doc.label)))
    return Citations(rows=rows, fetched_at=fetched_at, asof=asof,
                     skipped=lookup is None, _errors=errors)


# --------------------------------------------------------------------------
# Semantic groups
# --------------------------------------------------------------------------
#
# The section that answers "maybe start with these three" and "if you've read this
# one, four others further down say much the same". See
# writeups/design/QUEUE_SEMANTICS_PROPOSAL.md for the argument and
# QUEUE_SEMANTICS_MEASUREMENTS.md for where every constant below came from.
#
# **A stand-in is the paper you actually read, that stands in for the ones near it.**
# One term, used throughout. Reading the stand-in tells you roughly what is in its
# neighbours, so you can skim or skip them; everything here is how stand-ins get
# picked. A stand-in names its own group -- there are no invented cluster labels,
# because a label nobody wrote is a claim nobody can check.
#
# Why greedy coverage rather than textbook clustering: normal clustering forms a
# group and then asks which member best speaks for it, and the answer can be a paper
# that isn't actually close to some members. Here the group is built AROUND the paper
# you read, so "these five are close to this one" is true by construction rather than
# on average. It also cannot produce the chain failure where A is near B, B near C,
# C near D, and all four group although A and D are unrelated.

# The text that gets embedded: title, blank line, abstract. Nothing else.
# NOT `publication` -- a topic-free token that would pull one journal's papers
# together, and venue is handled by the quality score below where it belongs.
# NOT `summary` -- sometimes curator-written, sometimes model-written, unevenly
# present; two authorial registers in one space make the distances mean two things.
GROUP_TEXT = "{title}\n\n{abstract}"

# Above this many characters of abstract, a document is set aside rather than placed.
#
# Not a modelling judgement -- a compute one, and a deliberately blunt one. Attention
# cost grows with the SQUARE of the text length, and `embeddings._encode` pads every
# text in a batch out to the longest one in it, so a single very long abstract is paid
# for sixteen times over. Measured on the guide queue: one 19,998-character document
# turned a 0.1GB batch into a 12GB one and a two-minute run into thirty-three minutes
# of swapping. Excluding it costs two documents and takes the worst batch to 0.8GB.
#
# Where 5,000 came from: this queue's abstracts run to a p99 of 3,508 characters, and
# the only two above it -- at 6,103 and 19,998 -- are both a paper's full introduction
# sitting in the `abstract` field, inline citations and all. So the cutoff sits in a
# wide empty gap, with 1.4x headroom over the longest real abstract measured.
#
# Characters, not tokens, because counting tokens needs the tokenizer and this module
# takes no model -- the property that lets its tests run against hand-built nodes on a
# machine with no torch on it. At this margin the proxy is not close to binding.
#
# The honest reading of a document in this bucket: it has MORE information than the
# queue around it, not less, and it is very often a scraper defect worth fixing at the
# source. It is set aside for a person to judge, not judged here. If this starts
# catching real abstracts, the answer is to batch by a token budget (which bounds the
# cost without excluding anything), or to summarise before embedding -- not to raise
# this number until it stops catching anything.
MAX_GROUP_CHARS = 5000

# A pair is close if it is in the top (100 - this) percent of pairs in THIS queue.
# Self-calibrating: it survives a model change and the queue's topic drifting, where
# an absolute cutoff like 0.85 would mean everything or nothing depending on both.
SIMILARITY_PERCENTILE = 95.0

# ...but a percentile always finds "close" pairs, even in a queue with no structure:
# the top 5% of a featureless blob is still 5%. So the percentile is floored. The two
# combine as a MAX rather than as a veto, which gives the same "no groups found" on a
# featureless queue and also refuses to suppress two genuinely close papers sitting in
# an otherwise flat one. Measured: this queue's p95 is 0.848 and its loosest real
# pairs sit around 0.83, so 0.80 is below the content and above the noise.
SIMILARITY_FLOOR = 0.80

# Near-identical text is the same document twice under two canonical URLs -- invisible
# to `nodes_doc_url_uniq`, and not dependent on both copies having a resolvable DOI.
# Measured on the sandbox: the known duplicate pair scores 0.9999 and the closest pair
# of genuinely different papers scores 0.9187, so this sits in an empty 0.08 gap.
DUPLICATE_SIMILARITY = 0.97

# What a venue tier is worth, on the log10 scale the citation term uses. At 0.5 one
# tier is worth ~3.2x in citations and journal-vs-preprint -- two steps -- is worth
# exactly 10x, which is §4.3's "citation counts must be SERIOUSLY different to warrant
# a preprint over a peer-reviewed paper" made arithmetic. Solved from its own two
# examples: a 40-cite preprint must not beat a 12-cite journal paper (step > 0.25) and
# a 400-cite one must (step < 0.745).
VENUE_STEP = 0.5

# The tiers, ranked. Untiered sits BETWEEN journal and preprint, which is the order
# `repository.pending_documents` already uses and for the reason written there: a feed
# post came from a source the curator chose to follow, a judgement a preprint carries
# none of. None is a real third state, not a missing value.
VENUE_RANK = {"journal": 1, None: 0, "preprint": -1}

# Age settles near-ties and nothing more. Uncapped, per §4.2 -- and it needs no cap,
# because the weight is its own bound: across this queue's full 1985-2026 span the
# oldest paper collects +0.41, just under one venue step. So an old preprint cannot
# out-rank a journal paper on age, which is the case a cap would have existed for.
AGE_PER_YEAR = 0.01

# How far quality may move a paper against its coverage: at most x1.25 or /1.25.
# Coverage stays primary -- reading the queue in fewer sittings is the point of the
# exercise, and a well-credentialled paper that covers almost nothing doesn't serve
# it. The worst-case ratio between two papers is the square of this, so 1.25 lets
# quality overturn a coverage gap of one (5 vs 6 needs 1.20) and never a gap of three
# (2 vs 6 needs 3.00).
#
# **The most provisional number here.** It is a judgement about how the curator wants
# to spend an afternoon, and it can only really be answered by spending a few of them.
# It is named and printed rather than buried in an expression precisely so that
# changing it is a one-line edit whose effect shows in the next run's output.
QUALITY_BOUND = 1.25

# The embedder's shape: texts in, one vector per text out, in order. Supplied by the
# caller exactly as CitationLookup is, which is what keeps everything below testable
# against hand-built vectors with no model on the machine.
Embedder = Callable[[Sequence[str]], List[List[float]]]


def oversized(doc: Node) -> bool:
    """Whether this document's abstract is too long to be worth embedding.

    A separate question from `group_text`'s, and kept a separate function because the
    two say opposite things: `group_text` returns None when there is too little text
    to place a document, and this returns True when there is so much that placing it
    costs more than the rest of the queue put together. Collapsing them into one
    "unplaceable" answer would file a rich document under "not enough text" -- which
    is not true about it, and would hide the scraper defect that usually causes it.

    See MAX_GROUP_CHARS for why the cutoff is where it is and what to do instead of
    raising it.
    """
    return len((doc.attributes or {}).get("abstract") or "") > MAX_GROUP_CHARS


def group_text(doc: Node) -> Optional[str]:
    """The text this document is placed by, or None if there isn't enough of it.

    None is a real answer, not a failure. About 1 in 4 of the sandbox queue has no
    abstract -- Substack posts, encyclopedia entries, court filings -- and a title is
    eight words whose vector is mostly phrasing. Filing one of those with whatever it
    drifts toward would be inventing a finding; they go in a bucket that says so.
    """
    a = doc.attributes or {}
    title = (a.get("title") or doc.label or "").strip()
    abstract = (a.get("abstract") or "").strip()
    if not abstract:
        return None
    return GROUP_TEXT.format(title=title, abstract=abstract)


@dataclass
class Group:
    """One paper to read, and the papers it stands in for."""
    stand_in: Node
    covered: List[Node]                 # ordered by similarity to the stand-in, closest first
    similarities: List[float]           # aligned with `covered`

    @property
    def size(self) -> int:
        return 1 + len(self.covered)

    @property
    def tightest(self) -> Optional[float]:
        return max(self.similarities) if self.similarities else None

    @property
    def loosest(self) -> Optional[float]:
        return min(self.similarities) if self.similarities else None


@dataclass
class DuplicatePair:
    """Two records that are almost certainly the same document."""
    a: Node
    b: Node
    similarity: float


@dataclass
class Quality:
    """Why one paper outranked another, in the four facts the curator can argue with.

    Kept alongside the score rather than folded into it: a composite number alone
    would be a verdict nobody can audit, and "covers 5 · 34 cites · journal · 2021"
    is four facts that can each be disagreed with separately.
    """
    citations: Optional[int]            # None = unknown, which is NOT zero
    venue_tier: Optional[str]
    published: Optional[date]
    multiplier: float                   # what it did to the coverage score


@dataclass
class Groups:
    """What the queue looks like once papers that say the same thing are collapsed."""
    groups: List[Group]                 # best stand-in first
    alone: List[Node]                   # placeable, but no close neighbour: read each
    unplaceable: List[Node]             # no abstract -- not judged, either way
    oversized: List[Node]               # abstract too long to embed -- see MAX_GROUP_CHARS
    duplicates: List[DuplicatePair]
    quality: Dict[UUID, Quality]        # by node id, for the render
    threshold: float                    # the cut actually used
    percentile_value: Optional[float]   # what the percentile alone would have given
    floor: float
    pair_count: int
    asof: date                          # so the render can flag a stale stand-in
    skipped: bool = False               # --no-embeddings, or no embedder available
    error: Optional[str] = None

    @property
    def placed(self) -> int:
        """Documents the grouping actually speaks for. Deliberately NOT the whole
        queue: the copies withheld as duplicates, the documents with no abstract and
        the documents whose abstract was too long to embed are each counted
        separately, so the four numbers add up to the queue and no document goes
        missing between them."""
        return sum(g.size for g in self.groups) + len(self.alone)

    @property
    def duplicate_copies(self) -> int:
        return len(self.duplicates)


def _quality_scores(docs: Sequence[Node], counts: Dict[UUID, Optional[int]],
                    *, asof: date) -> Dict[UUID, float]:
    """The raw quality of each document, on a log10 citation scale.

    Three signals, all already in hand -- nothing is fetched or stored for this.
    Citations carry the weight and age only settles ties, because raw citations
    LARGELY IS an age measure: a 2015 paper leads mostly by having had nine more
    years. Weighting both fully would count age twice, and a third time, since
    "newer papers sit out on the edge without much around them" is exactly what the
    neighbour count already measures.

    **Unknown is not zero.** A document whose citation count could not be resolved
    gets the median of the counts that did resolve, so it sits mid-field rather than
    at the bottom of it. Same for a missing date, which contributes no age term at all.
    """
    known = sorted(c for c in counts.values() if c is not None)
    fallback = float(median(known)) if known else 0.0

    out: Dict[UUID, float] = {}
    for doc in docs:
        count = counts.get(doc.id)
        cites = float(count) if count is not None else fallback
        tier = (doc.attributes or {}).get("venue_tier")
        when = published(doc)
        age = (asof - when).days / 365.25 if when else 0.0
        out[doc.id] = (VENUE_STEP * VENUE_RANK.get(tier, 0)
                       + math.log10(1.0 + max(0.0, cites))
                       + AGE_PER_YEAR * max(0.0, age))
    return out


def _multipliers(raw: Dict[UUID, float]) -> Dict[UUID, float]:
    """Raw quality to a bounded multiplier, by RANK rather than by value.

    Percentile among the queue: best gets QUALITY_BOUND, median gets 1.0, worst gets
    1/QUALITY_BOUND. Ranking rather than scaling is what lets VENUE_STEP and
    AGE_PER_YEAR be constants that fix an *order* -- which is the only thing §4.3 and
    §4.2 actually argue about -- while the bound alone decides how much that order is
    allowed to move a paper.

    **Ties share a rank, averaged.** Documents alike in all three signals -- the same
    tier, the same year, both uncited -- score identically, and there is no fact left
    to separate them with. Handing them consecutive ranks anyway would order them by
    whatever their UUIDs happen to be, and since a rank IS the multiplier, an accident
    of identifier would then decide which of two equally-credentialled papers the
    curator is told to read first. Averaging gives them the one multiplier they have
    equal claim to.
    """
    if not raw:
        return {}
    if len(raw) == 1:
        return {next(iter(raw)): 1.0}
    order = sorted(raw, key=lambda k: raw[k])
    span = len(order) - 1
    out: Dict[UUID, float] = {}
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and raw[order[j + 1]] == raw[order[i]]:
            j += 1
        rank = (i + j) / 2.0
        for k in order[i:j + 1]:
            out[k] = QUALITY_BOUND ** (2.0 * (rank / span) - 1.0)
        i = j + 1
    return out


def groups(docs: Sequence[Node], embed: Optional[Embedder] = None,
           lookup: Optional[CitationLookup] = None, *,
           asof: Optional[date] = None,
           percentile: float = SIMILARITY_PERCENTILE,
           floor: float = SIMILARITY_FLOOR) -> Groups:
    """Which queued papers say the same thing as each other, and which to read first.

    Pure arithmetic, like everything else in this module: `embed` is a callable the
    caller supplies, exactly as `lookup` is, so the tests pass hand-built vectors and
    never load a model. `embed=None` (`--no-embeddings`) costs this section and not
    the run -- the same rule `lookup=None` already follows.

    The procedure, per QUEUE_SEMANTICS_PROPOSAL.md §2:

      1. Measure how similar every placeable paper is to every other.
      2. Count, for each, how many others sit closer than the threshold.
      3. Score on that count and on how good a stand-in it is. The winner is the
         first paper to read; the papers close to it are now covered.
      4. Cross off the winner and everything it covered, then score again on the
         neighbours still uncrossed.
      5. Stop when nothing left has an uncovered neighbour. What remains has no
         stand-in and must be read on its own -- a finding in itself, because it is
         what tells the curator how long the queue will actually take.

    Only an uncrossed paper can become a stand-in, so every document lands in exactly
    one place: a stand-in, a paper covered by one, alone, or unplaceable.
    """
    asof = asof or date.today()
    empty = Groups(groups=[], alone=[], unplaceable=[], oversized=[], duplicates=[],
                   quality={}, threshold=floor, percentile_value=None, floor=floor,
                   pair_count=0, asof=asof)

    if embed is None:
        empty.skipped = True
        return empty

    placeable: List[Node] = []
    texts: List[str] = []
    unplaceable: List[Node] = []
    too_long: List[Node] = []
    for doc in docs:
        text = group_text(doc)
        # Asked before the text is looked at, and never reaching `texts`: the whole
        # point is that these never go near the model, so the cost they represent is
        # not paid to discover they were too expensive.
        if oversized(doc):
            too_long.append(doc)
        elif text is None:
            unplaceable.append(doc)
        else:
            placeable.append(doc)
            texts.append(text)
    # Set on `empty` too, not just on the full return below. Every early exit from
    # here -- no embedder, fewer than two placeable, a model that would not load --
    # returns `empty`, and a document dropped on one of those paths would vanish from
    # the queue's accounting with nothing in the report saying it had.
    empty.unplaceable = unplaceable
    empty.oversized = too_long

    if len(placeable) < 2:
        return empty

    try:
        vectors = embed(texts)
    except Exception as e:                              # noqa: BLE001
        # Same contract as the citation lookup: a model that will not load costs this
        # section, never the two that need nothing but the queue itself.
        empty.error = f"{type(e).__name__}: {e}"
        return empty

    import numpy as np

    matrix = np.asarray(vectors, dtype=float)
    # The vectors arrive unit-normalised (embeddings._encode), so cosine similarity is
    # a dot product. Re-normalising here would hide a caller that forgot to.
    sims = matrix @ matrix.T
    n = len(placeable)
    upper = np.triu_indices(n, 1)
    pairs = sims[upper]

    duplicates = [
        DuplicatePair(a=placeable[i], b=placeable[j], similarity=float(sims[i, j]))
        for i, j in zip(*upper) if sims[i, j] >= DUPLICATE_SIMILARITY
    ]
    duplicates.sort(key=lambda d: -d.similarity)

    percentile_value = float(np.percentile(pairs, percentile)) if len(pairs) else None
    threshold = max(percentile_value, floor) if percentile_value is not None else floor

    counts: Dict[UUID, Optional[int]] = {}
    if lookup is not None:
        cites = citations(placeable, lookup, asof=asof)
        counts = {row.doc.id: row.count for row in cites.rows}
    raw = _quality_scores(placeable, counts, asof=asof)
    multiplier = _multipliers(raw)
    quality = {
        doc.id: Quality(citations=counts.get(doc.id),
                        venue_tier=(doc.attributes or {}).get("venue_tier"),
                        published=published(doc),
                        multiplier=multiplier.get(doc.id, 1.0))
        for doc in placeable
    }

    # A duplicate must not also stand in for its own copy: that would print "read
    # this, it covers this identical thing", which is advice to resolve the duplicate,
    # not to read anything. The second copy is withheld from the grouping and named
    # in the duplicates section instead.
    suppressed = {d.b.id for d in duplicates}

    close = sims >= threshold
    np.fill_diagonal(close, False)

    covered: set = {i for i, doc in enumerate(placeable) if doc.id in suppressed}

    result: List[Group] = []
    while True:
        best, best_key = None, None
        for i in range(n):
            if i in covered:
                continue
            gain = sum(1 for j in np.flatnonzero(close[i]) if int(j) not in covered)
            if gain == 0:
                continue
            score = gain * multiplier.get(placeable[i].id, 1.0)
            # Ties break on raw coverage, then on quality, then on id -- so two runs
            # over the same queue produce the same report in the same order.
            key = (score, gain, raw.get(placeable[i].id, 0.0), str(placeable[i].id))
            if best_key is None or key > best_key:
                best, best_key = i, key
        if best is None:
            break

        neighbours = [int(j) for j in np.flatnonzero(close[best])
                      if int(j) not in covered]
        neighbours.sort(key=lambda j: -sims[best, j])
        result.append(Group(
            stand_in=placeable[best],
            covered=[placeable[j] for j in neighbours],
            similarities=[float(sims[best, j]) for j in neighbours],
        ))
        covered.add(best)
        covered.update(neighbours)

    alone = [placeable[i] for i in range(n)
             if i not in covered and placeable[i].id not in suppressed]

    return Groups(groups=result, alone=alone, unplaceable=unplaceable,
                  oversized=too_long,
                  duplicates=duplicates, quality=quality, threshold=threshold,
                  percentile_value=percentile_value, floor=floor,
                  pair_count=int(len(pairs)), asof=asof)
