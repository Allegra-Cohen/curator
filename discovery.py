"""Discovery orchestration: run Scout over the ontology and file the survivors.

This is the composition root for the front of the ingestion funnel -- the one
place that knows about both the graph and Scout. Scout stays graph-agnostic (it
takes plain `SearchItem`s), the graph package stays Scout-agnostic; this module
bridges them:

    concepts + followed sources  ->  SearchItems  ->  Scout  ->  relevance filter
                                 ->  IngestionBridge.ingest_candidates  ->  queue

A run fans out over a **work list** of two kinds of thing, and the difference
between them is only in what supplies the query:

  * a **concept** is a subject: its `semantic_query` feeds OpenAlex semantic search
    and its `keywords` feed arXiv. Its `description` is the reader's definition and
    is never a query -- see ConceptAttrs for why the two were split. The concept that
    surfaced a document becomes that document's concept proposal.
  * a **followed source** is polled: it takes no subject and enumerates what it
    published. Nothing proposes a concept for what it finds, because nothing
    searched for it -- the curator categorises those at review.

Everything after the fan-out is identical for both: dedup, tombstones, the relevance
gate, arrival as `pending`, one run = one undoable action. `discover()` does all the
(slow, network) work and no writes; the caller wraps the ingest in its own
transaction so a whole run is one undoable action.
"""

import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from graph.models import Node
from graph.repository import GraphRepository
from graph.services import ArtifactService, IngestionService, SourceService
from graph.scout_state import PageLinkMemo, ScreenedUrls, SourceHealth
from graph.types import NodeType
from relevance_filter import DEFAULT_GUIDE_SCOPE, LinkClassifier, RelevanceFilter
from scout import (
    EXCLUDED_SOURCES, ArXivAdapter, Candidate, FeedAdapter, OpenAlexAdapter,
    PageAdapter, QueryNormalizer, Scout, ScrapedAuthor, SearchItem,
)


REPORT_DIR = Path(__file__).with_name("search_reports")


def _sources_of(name: str) -> List[str]:
    """The source names on a candidate. Dedup merges provenance into "a+b"."""
    return [p for p in (name or "").split("+") if p]


def write_report(items: List[SearchItem], kept: List[Candidate], dropped: List[Dict],
                 errors: List[str], *, stamp: Optional[str] = None,
                 scope: Optional[str] = None, scope_source: str = "") -> Path:
    """Write a plain-text account of one run: what was searched, what was dropped, why.

    Search is lossy by design -- dedup, tombstones, a relevance floor, an LLM
    judgement -- and every one of those drops is invisible in the UI, which reports
    only a count. That makes a narrow literature and an over-eager filter look
    identical. The report is the difference: each dropped paper appears with the
    stage that cut it and, for the LLM filter, the model's own stated reason, so the
    filter can be audited against what the curator actually wanted.
    """
    stamp = stamp or datetime.now().strftime("%Y-%m-%d_%H%M%S")
    REPORT_DIR.mkdir(exist_ok=True)
    path = REPORT_DIR / f"search_{stamp}.txt"
    # Two runs inside the same second would otherwise overwrite each other's report
    # -- easy to hit now that a cheap re-poll finishes in well under a second, and
    # the lost report is exactly the one showing why the second run found nothing.
    n = 2
    while path.exists():
        path = REPORT_DIR / f"search_{stamp}_{n}.txt"
        n += 1

    by_stage: Dict[str, List[Dict]] = {}
    for d in dropped:
        by_stage.setdefault(d["stage"], []).append(d)

    concept_items = [i for i in items if not i.is_polled]
    feed_items = [i for i in items if i.is_polled]

    lines: List[str] = []
    add = lines.append
    add(f"Search report — {stamp}")
    add("=" * 72)
    add("")
    add(f"Concepts searched : {len(concept_items)}")
    add(f"Sources polled    : {len(feed_items)}")
    add(f"Kept (queued)     : {len(kept)}")
    add(f"Dropped           : {len(dropped)}")
    for stage, rows in sorted(by_stage.items()):
        add(f"  {stage:<12} {len(rows)}")
    if errors:
        add(f"Failed searches   : {len(errors)}  (results below are INCOMPLETE)")
    add("")

    if scope is not None:
        # Printed verbatim. It decides as much as the concept descriptions do -- it
        # is now BOTH the screening prompt's premise and trailing context on every
        # semantic query -- so a report that omitted it would leave you unable to
        # explain the run's calls from the report alone.
        add(f"GUIDE SCOPE  [{scope_source}]")
        add("Applied to: LLM screening (keyword hits) AND semantic query context")
        add("-" * 72)
        add(scope.strip())
        add("")

    if feed_items:
        # Sources are listed separately because they were sent no query at all --
        # printing them under "queries" would invent one. What matters for auditing a
        # feed is which url was fetched and that the scope was the only gate.
        add("SOURCES POLLED")
        add("-" * 72)
        for it in feed_items:
            # Per-source accounting. A run-level count can't answer the question that
            # actually decides a source's fate -- "is this one earning its keep?" --
            # because one prolific feed's hits mask another's silence.
            mine_kept = [c for c in kept if it.name in _sources_of(c.source)]
            mine_dropped = [d for d in dropped
                            if it.name in _sources_of(d.get("source", ""))]
            by_reason: Dict[str, int] = {}
            for d in mine_dropped:
                by_reason[d["stage"]] = by_reason.get(d["stage"], 0) + 1

            add(f"[{it.name}]")
            add(f"  feed     : {it.source_url}")
            add(f"  found    : {len(mine_kept) + len(mine_dropped)}"
                f"   kept {len(mine_kept)}, dropped {len(mine_dropped)}")
            for stage, n in sorted(by_reason.items()):
                add(f"             {n} × {stage}")
            if it.name in {e.split(" / ")[0] for e in errors}:
                add("  STATUS   : FAILED — this source contributed nothing to this run")
        add("")
        add("  No query is sent to a feed. Each post is classified instead:")
        add("    · outside the guide scope        → dropped  [llm-filter-scope]")
        add("    · about an unchecked concept     → dropped  [llm-filter-excluded]")
        add("    · about a checked concept        → queued, with that concept proposal")
        add("    · in scope, about no concept     → queued, with no concept proposals")
        add("")

    if concept_items:
        add("QUERIES SENT")
        add("-" * 72)
    for it in concept_items:
        add(f"[{it.name}]")
        # The converted query, not the raw field: a comma-separated list becomes
        # OR-ed alternatives, and seeing the result is how you catch it going wrong.
        add(f"  arXiv    : {QueryNormalizer.to_arxiv(it.keywords) if it.keywords else '(no keywords — skipped)'}")
        query = (it.semantic_query or "").strip()
        if not query:
            add("  OpenAlex : (no semantic search text — skipped)")
        else:
            add(f"  OpenAlex : {query}")
            if scope:
                add("             + scope appended as context (see above)")
            # A run has to say what it refused to look at, for the same reason it
            # prints the guide scope: a narrowed search is otherwise indistinguishable
            # from a quiet literature.
            add(f"             − not indexed: {', '.join(EXCLUDED_SOURCES.values())}"
                f" (deposit repositories — see quality_signals.md)")
        add("")

    if errors:
        add("FAILED SEARCHES")
        add("-" * 72)
        for e in errors:
            add(f"  {e}")
        add("")

    for stage, rows in sorted(by_stage.items()):
        add(f"DROPPED — {stage} ({len(rows)})")
        add("-" * 72)
        for r in rows:
            add(f"  {r['title'][:96]}")
            add(f"    reason : {r['reason']}")
            add(f"    via    : {', '.join(r.get('matched_terms') or []) or '—'}"
                f"   [{r.get('source') or '?'}]")
            add(f"    url    : {r['url']}")
            add("")
        add("")

    path.write_text("\n".join(lines))
    return path


def _flatten(c: Candidate, ids_by_name: Optional[Dict[str, str]] = None,
             source_ids_by_name: Optional[Dict[str, object]] = None) -> Dict:
    """A Candidate as the plain dict IngestionBridge.ingest_candidates wants.

    `matched_terms` holds concept *labels* (readable provenance); the same concepts
    resolved to ids become the document's concept proposals, so a later rename
    doesn't orphan them. Labels are unique among live concepts, so the mapping is
    unambiguous. A feed candidate has no matched_terms at all and so arrives with no
    concept proposals -- the accurate answer, since nothing proposed one.

    `source` names the adapter(s) or feed(s) that turned it up, joined with "+" when
    several did; each resolves to a `source` node and becomes a `sourced_from` edge.
    """
    ids_by_name = ids_by_name or {}
    source_ids_by_name = source_ids_by_name or {}
    proposed = [ids_by_name[n] for n in (c.matched_terms or []) if n in ids_by_name]
    source_ids = [source_ids_by_name[n] for n in (c.source or "").split("+")
                  if n in source_ids_by_name]
    return {
        "url": c.url,
        "title": c.title,
        "authors": [{"name": a.name, "orcid": a.orcid} for a in (c.authors or [])],
        "publication": c.publication,
        "date": c.date,
        "abstract": c.abstract,
        "matched_terms": c.matched_terms,
        "source": c.source,
        "source_ids": source_ids,
        "oa_pdf_url": c.oa_pdf_url,
        "venue_tier": c.venue_tier,
        "reference_count": c.reference_count,
        "proposed_concept_ids": proposed,
    }


class DiscoveryService:
    """Turn the current ontology into a discovery run's candidate list."""

    def __init__(self, repo: GraphRepository, *, openalex_key: Optional[str] = None,
                 anthropic_key: Optional[str] = None, scraper=None):
        self.repo = repo
        self.openalex_key = openalex_key      # no key -> OpenAlex semantic search is a no-op
        self.anthropic_key = anthropic_key    # no key -> relevance filter is skipped
        # Anything with `scrape_urls`; page sources need it to turn a bare url into
        # something reviewable. None means page sources yield nothing.
        self.scraper = scraper
        self._page_source_names: set = set()

    def _concepts(self, only: Optional[List] = None) -> List[Node]:
        """Every concept, or just the ones named. `only` holds UUIDs."""
        concepts = self.repo.find_nodes(type=NodeType.CONCEPT, limit=10000)
        if only is None:
            return concepts
        wanted = {str(cid) for cid in only}
        return [c for c in concepts if str(c.id) in wanted]

    def ensure_sources(self, *, actor) -> None:
        """Seed the built-in API sources. The one write this class does, kept out of
        `discover()` so that stays read-only -- callers run this inside the same
        transaction as the ingest, so a run remains one undoable action."""
        SourceService(self.repo).ensure_builtins(actor=actor)

    def _enrich_pages(self, candidates: List[Candidate]) -> List[Candidate]:
        """Scrape page-sourced candidates for their real metadata.

        Only reached by urls that already survived dedup and tombstones, so this
        fetches new documents only -- a re-poll of an unchanged page scrapes nothing.
        A url Reader can't read is dropped here rather than screened on its anchor
        text; it reappears as a candidate on the next run, since nothing was written.
        """
        needs = [c for c in candidates if c.via_polled and not c.abstract
                 and c.source in self._page_source_names]
        if not needs or self.scraper is None:
            return candidates

        # Keyed on what was *requested*, not on the result's `url`: that is the
        # document's identity and may differ from the url fetched (a JSTOR scan is
        # filed under its stable page). Joining on the identity would silently drop
        # every such candidate as unreadable.
        scraped = {(d.get("requested_url") or d.get("url")): d
                   for d in self.scraper.scrape_urls([c.url for c in needs])}
        out = []
        for c in candidates:
            if c not in needs:
                out.append(c)
                continue
            d = scraped.get(c.url)
            if not d:
                continue        # unreadable: drop rather than screen on anchor text
            c.title = d.get("title") or c.title
            # The page's own byline wins over whatever the listing said, but an ORCID
            # already attached to a name is kept: the scraper can only ever supply
            # names, so letting it overwrite would trade an identity for a string.
            known = {a.name: a.orcid for a in (c.authors or []) if a.orcid}
            c.authors = [ScrapedAuthor(name=n, orcid=known.get(n))
                         for n in (d.get("authors") or []) if n]
            c.date = d.get("date")
            c.publication = d.get("publication")
            # Reader keeps the full text; the screens want a short excerpt, and the
            # graph deliberately doesn't store bodies (see IngestionService).
            body = (d.get("text") or "").strip()
            c.abstract = body[:1500] or None
            out.append(c)
        return out

    def _known_urls(self) -> set:
        """Canonical URLs already in the guide -- Scout skips these so a re-run only
        surfaces new papers.

        Counts unreviewed documents too, via `repo.document_urls`: one sitting in the
        queue is already found, and re-surfacing it every run is exactly what this
        set exists to prevent. One of the three reads permitted to see the queue --
        see repository.APPROVED_ONLY.
        """
        return set(self.repo.document_urls())

    def _tombstoned_urls(self) -> set:
        """URLs the curator has dismissed. Dropped at search time rather than at
        ingest so they never reach the (paid) relevance filter."""
        return IngestionService(self.repo).tombstoned_urls()

    def discover(self, concept_ids: Optional[List] = None, *,
                 source_ids: Optional[List] = None,
                 include_feeds: bool = True) -> Tuple[List[Dict], Dict]:
        """Search concepts, poll followed sources, return (candidate dicts, meta).

        `concept_ids` / `source_ids` narrow the run to those; None means all of that
        kind. Narrowing is what makes the pipeline debuggable -- one concept, one
        report, a loop tight enough to actually tune keywords against.

        Note this narrowing is **per-run only** and never persists. A source's own
        `enabled` attribute is the durable judgement ("this is not a source for this
        guide"); one mechanism can't do both jobs, because a per-run choice that stuck
        would make every later run silently narrow -- and a narrow run is
        indistinguishable from a quiet literature.

        Unchecking a concept means two things at once, one per kind of source: the
        query isn't run, AND feed posts about that concept are dropped. Same
        instruction ("not this, right now"), two mechanisms -- a feed can't be
        narrowed by not-running it, since one fetch brings back every topic the
        writer covers. See SOURCES_DESIGN.md.

        Pure of graph writes -- only reads. Network I/O (Scout, the LLM filter)
        happens here so the caller can keep it out of its ingest transaction.
        """
        concepts = self._concepts(concept_ids)
        # Every live concept, not just the searched ones: the feed screen has to be
        # able to recognise a post as being about an *unchecked* concept in order to
        # drop it, and unchecked concepts are exactly what `concepts` leaves out.
        all_concepts = self._concepts(None)
        items = [
            SearchItem(
                name=c.label,
                keywords=c.attributes.get("keywords", ""),
                semantic_query=c.attributes.get("semantic_query", ""),
            )
            for c in concepts
        ]

        # Followed sources join the same work list. `feeds()` already excludes the
        # search APIs -- they're sources too, but they're queried, not polled.
        sources = SourceService(self.repo)
        feeds = sources.feeds() if include_feeds else []
        if source_ids is not None:
            wanted = {str(s) for s in source_ids}
            feeds = [f for f in feeds if str(f.id) in wanted]
        items += [
            SearchItem(name=f.label, source_url=f.attributes["url"],
                       mechanism=f.attributes.get("mechanism", "rss"))
            for f in feeds
        ]

        # Adapter/feed name -> source node id, for the `sourced_from` edges. Source
        # labels match the adapter `name` strings, which is what a candidate reports
        # as its origin. A source that hasn't been seeded yet simply contributes no
        # provenance edge -- see `ensure_sources`, which the writing caller runs.
        source_ids_by_name = {s.label: s.id for s in sources.list_sources()}

        # Resolve the scope up front: BOTH paths answer to it now. The semantic path
        # takes it as query context (OpenAlexAdapter), the keyword path as the
        # screening prompt's premise (RelevanceFilter). Previously only the latter
        # did, so OpenAlex results entered the queue having never been measured
        # against what the guide is about.
        scope_node = ArtifactService(self.repo).get_guide_scope()
        curator_scope = scope_node.attributes.get("body") if scope_node else None
        scope_used = curator_scope or DEFAULT_GUIDE_SCOPE
        scope_source = ("curator-authored Artifact" if curator_scope
                        else "BUILT-IN DEFAULT — no scope Artifact saved yet")

        # Page sources: one memo per source, so the classifier is only asked about
        # links nobody has judged before. Without a key there is no classifier, and
        # PageAdapter extracts nothing rather than guessing that every link is an
        # article -- see its docstring.
        memo = PageLinkMemo(self.repo.conn)
        pages = [f for f in feeds if f.attributes.get("mechanism") == "page"]
        page_adapters = {}
        classifier = LinkClassifier(self.anthropic_key) if self.anthropic_key else None
        self._page_source_names = {pg.label for pg in pages}
        for pg in pages:
            page_adapters[pg.attributes["url"]] = PageAdapter(
                classify=classifier.classify if classifier else None,
                known=memo.known(pg.id))

        class _RoutingPageAdapter:
            """One adapter object per run, dispatching to the per-source one.

            Scout holds a single list of adapters for the whole run, but each page
            source needs its own memo -- so this picks the right one by url."""
            name, query_kind, mechanism = "page", "enumerative", "page"

            def search(self, query):
                return page_adapters[query].search(query)

        scout = Scout(adapters=[
            OpenAlexAdapter(api_key=self.openalex_key, guide_scope=scope_used),
            ArXivAdapter(),
            FeedAdapter(),
            _RoutingPageAdapter(),
        ])
        screened_store = ScreenedUrls(self.repo.conn)
        candidates = scout.search(items, duplicates=self._known_urls(),
                                  tombstones=self._tombstoned_urls(),
                                  screened=screened_store.all())
        surfaced = len(candidates)

        # Every drop, from every stage, in one list for the report.
        drop_log: List[Dict] = list(scout.dropped)

        # Persist what the classifier decided, and report what it rejected. A link
        # wrongly filed as navigation is otherwise invisible forever -- the same
        # silent-loss failure this project refuses elsewhere -- so every reject is
        # an auditable row, and `PageLinkMemo.forget` is the way back.
        for pg in pages:
            adapter = page_adapters[pg.attributes["url"]]
            verdicts = adapter.new_verdicts
            if verdicts:
                memo.remember(
                    pg.id,
                    {u: v["is_article"] for u, v in verdicts.items()},
                    {u: v.get("reason", "") for u, v in verdicts.items()})
            for url, v in verdicts.items():
                if not v["is_article"]:
                    drop_log.append({
                        "stage": "page-not-an-article",
                        "reason": v.get("reason", "(no reason given)"),
                        "title": url, "url": url, "source": pg.label,
                        "matched_terms": [],
                    })
            if adapter.overflowed:
                scout.errors.append(
                    f"{pg.label} / page had {adapter.overflowed} more articles than "
                    f"the {adapter.MAX_NEW} cap — some were not fetched")

        # Page candidates arrive as a url and its anchor text, nothing more. Reader
        # fills in the real title, date, authors and text before anything screens
        # them: judging a document on its link text would be far thinner evidence
        # than the abstract every other path supplies.
        candidates = self._enrich_pages(candidates)

        dropped = 0
        if self.anthropic_key:
            # Keyword hits are judged against the concept that surfaced them, so this
            # only needs the searched concepts -- they're the only names that can
            # appear in a candidate's matched_terms.
            queries = {c.label: c.attributes.get("semantic_query", "")
                       for c in concepts if c.attributes.get("semantic_query")}
            # Both paths read `semantic_query`, not `description`: the machine-facing
            # field is the one written to be matched against, and the reader-facing
            # one may carry quoted definitions and citations that mean nothing to a
            # classifier. The cost is that a concept with no search text yet is
            # invisible to the feed screen -- no post is labelled with it, and
            # unchecking it excludes nothing. That is the same silence its OpenAlex
            # search has, and it ends the same way: fill the box.
            feed_concepts = {c.label: c.attributes.get("semantic_query", "")
                             for c in all_concepts if c.attributes.get("semantic_query")}
            # Nothing is excluded unless the curator checked *some* concepts. Two
            # cases collapse to that:
            #   None -- a full run; every concept is checked.
            #   []   -- no concept queries at all (a feeds-only poll). Reading this
            #           as "every concept is unchecked" would drop every post that
            #           matches anything, which is never what someone pressing Run
            #           search wants; the discontinuity at zero is the lesser evil.
            selected = {c.label for c in concepts} if concepts else None
            result = RelevanceFilter(
                self.anthropic_key, guide_scope=scope_used,
            ).filter(candidates, queries,
                     feed_concepts=feed_concepts, selected_concepts=selected)
            dropped = len(result.dropped)
            drop_log.extend(result.drop_log)
            candidates = result.kept

        # Record which feeds answered and which didn't. This is the only place a
        # failed poll is written down: a feed that 404s and a feed whose author is
        # quiet both put nothing in the graph, and `consecutive_failures` is what
        # tells them apart later.
        health = SourceHealth(self.repo.conn)
        for f in feeds:
            failure = scout.failed_items.get(f.label)
            if failure:
                health.record_failure(f.id, failure)
            else:
                health.record_success(f.id)

        # Remember what the screens rejected, so no future poll pays to decide it
        # again. Only filter verdicts are recorded: a url Reader couldn't fetch was
        # dropped before any screen ran, so it stays eligible for a retry rather
        # than being lost to a transient failure.
        source_id_by_label = {f.label: f.id for f in feeds}
        screened_store.record([
            {"url": d["url"], "stage": d["stage"], "reason": d.get("reason"),
             "source_id": source_id_by_label.get(d.get("source"))}
            for d in drop_log
            if d["stage"].startswith("llm-filter")
        ])

        report_path = write_report(items, candidates, drop_log, scout.errors,
                                   scope=scope_used, scope_source=scope_source)

        # Counted here, not from the ingest report: these were dropped BEFORE
        # ingestion ever saw them, so IngestReport can only ever say zero.
        seen_before = sum(1 for d in scout.dropped if d["reason"] == "already in the guide")
        dismissed = sum(1 for d in scout.dropped if d["reason"] == "previously dismissed")

        meta = {
            "candidates": surfaced + len(scout.dropped),  # everything search turned up
            "dropped": dropped,              # cut by the relevance filter
            "already_known": seen_before,    # already in the guide
            "dismissed": dismissed,          # tombstoned
            "openalex": bool(self.openalex_key),
            "filtered": bool(self.anthropic_key),
            # Searches that outright failed (throttling, timeouts). Reported so a
            # degraded run isn't mistaken for a complete one -- arXiv in particular
            # rate-limits, and a swallowed failure reads as "nothing found".
            "failures": len(scout.errors),
            "failure_detail": scout.errors[:5],
            # Reported separately from concepts so a run that polled nothing is
            # visible as such -- a disabled or unfollowed source is otherwise
            # indistinguishable from one that published nothing.
            "concepts_searched": len(concepts),
            "sources_polled": len(feeds),
            "report": str(report_path),
        }
        # Spans every concept, not just the searched ones -- a feed post's concept
        # proposals can name a concept no query went looking for.
        ids_by_name = {c.label: str(c.id) for c in all_concepts}
        return ([_flatten(c, ids_by_name, source_ids_by_name) for c in candidates],
                meta)
