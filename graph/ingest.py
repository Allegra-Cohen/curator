"""Ingestion bridge: connect the Reader scraper to the graph's IngestionService.

This is the tail segment of the eventual discovery funnel:

    discover  ->  filter   ->  [ fetch+extract  ->  summarize  ->  submit ]
    (future)     (future)         Reader (✓)         (stub)        this bridge

`discover` (enumerate candidate articles from a collection source) and `filter`
(score candidates against the ontology's Concepts) are deliberately future AND
human-gated: this is a curation tool, not an autocrawler, so a person decides
what gets scraped and how it's categorized. Accordingly, everything this bridge
ingests lands as `status='pending'` -- nothing enters the guide unreviewed.

The scraper is injected (any object with `scrape_urls`), so the real `Reader` can
be swapped for a fake in tests or, later, for a discovery-driven fetcher.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol

from .models import Actor, Node
from .services import IngestionService, PeopleService, SourceService


class Scraper(Protocol):
    """The one method the bridge needs. `reader.Reader` already satisfies this."""
    def scrape_urls(self, urls: List[str]) -> List[Dict]: ...


@dataclass
class IngestReport:
    """Outcome of an ingest run, kept explicit so a curator can see what happened."""
    ingested: List[Node] = field(default_factory=list)     # new pending documents
    duplicates: List[Node] = field(default_factory=list)   # URLs already in the graph
    failed: List[str] = field(default_factory=list)         # couldn't fetch/extract
    suppressed: List[str] = field(default_factory=list)     # URLs previously dismissed
    restored: List[Node] = field(default_factory=list)      # dismissed, brought back

    def summary(self) -> str:
        s = (f"{len(self.ingested)} ingested, {len(self.duplicates)} duplicate, "
             f"{len(self.failed)} failed")
        # Only mentioned when they happened -- on a first run both are always zero,
        # and a standing "0 dismissed, 0 restored" would just be noise.
        if self.suppressed:
            s += f", {len(self.suppressed)} previously dismissed"
        if self.restored:
            s += f", {len(self.restored)} restored"
        return s


class IngestionBridge:
    def __init__(self, ingestion: IngestionService, scraper: Scraper,
                 people: Optional[PeopleService] = None):
        self.ingestion = ingestion
        self.scraper = scraper
        # Author linking needs the people domain; build one on the shared repo when
        # a caller doesn't inject its own (tests can pass a fake/spy).
        self.people = people or PeopleService(ingestion.repo)
        # Provenance -- which source(s) a document reached us through.
        self.sources = SourceService(ingestion.repo)

    def ingest_urls(self, urls: List[str], *, submitted_by: Actor,
                    searchterms: Optional[List[str]] = None,
                    source_ids: Optional[List] = None,
                    restore_dismissed: bool = False) -> IngestReport:
        """Scrape `urls` and submit each successful result as a pending document.

        A URL the scraper can't fetch or extract is reported under `failed` (Reader
        drops those from its output). A URL already in the graph is reported under
        `duplicates` and left untouched (submit is idempotent). A newly-ingested
        document also gets its scraped authors resolved to `person` nodes and linked
        with `authored_by` edges -- see `_link_authors`. `searchterms` is passed through
        for curation context; `source_ids` records where these urls came from as
        `sourced_from` edges.

        `restore_dismissed` inverts what a tombstone means for this call. Discovery
        leaves it off: a re-run offering back a paper the curator already rejected is
        exactly what tombstones exist to stop. A curator pasting the URL by hand
        leaves it on, because that paste *is* a newer judgement than the dismissal --
        so the original document comes back (see
        `IngestionService.restore_dismissed_document`) rather than a duplicate
        landing beside a tombstone that still hides it from every search.

        The restore is attempted twice, because a tombstone is keyed on the
        document's canonical url and a paste is not always spelled that way. A url
        that matches a tombstone as pasted is restored without a fetch at all --
        the document already has its metadata, which makes that path both cheaper
        and less destructive than a fresh scrape. A url whose canonical form only
        emerges from the fetch (a JSTOR scan filed under its stable page) can't be
        matched until the fetch has happened, so it is restored in the result loop
        instead. Neither path submits: the original node comes back."""
        report = IngestReport()
        # Refuse dismissed URLs before spending a fetch on them.
        tombstoned = self.ingestion.tombstoned_urls()

        restored_urls = set()
        if restore_dismissed:
            for url in [u for u in urls if u in tombstoned]:
                node = self.ingestion.restore_dismissed_document(
                    url, actor=submitted_by)
                if node is not None:
                    report.restored.append(node)
                    restored_urls.add(url)

        # A restored URL is already in `tombstoned` (the set was read before the
        # lift), so it stays out of `wanted` without further help -- it only has to
        # be kept out of `suppressed`, which would otherwise report it as refused.
        wanted = [u for u in urls if u not in tombstoned]
        report.suppressed = [u for u in urls
                             if u in tombstoned and u not in restored_urls]

        results = self.scraper.scrape_urls(wanted)

        # The URLs we asked for that came back with something, so `failed` below
        # can be computed against what was requested. A result's `url` is the
        # document's identity and is not required to be the URL that was fetched:
        # a JSTOR scan is filed under its stable page, while the PDF that was
        # actually pasted becomes the reader's link-out. Keying `failed` off the
        # identity instead would report that paste as a failure.
        attempted = set()
        for scraped in results:
            url = scraped.get("url") or scraped.get("canonical_url")
            if not url:
                continue
            requested = scraped.get("requested_url") or url
            attempted.add(requested)
            # A fetch can land on a URL we never asked for -- a redirect, or a
            # JSTOR scan resolving to its stable page -- so the tombstone is
            # re-checked here against the identity rather than trusting the
            # pre-filter, which only ever saw what the caller passed.
            if url in tombstoned:
                # ...and the restore has to be re-tried for the same reason. The
                # pre-fetch pass above can only match a paste against a tombstone
                # when the two are spelled the same; when the canonical url is
                # only knowable after fetching, this is the first moment the
                # match is possible at all. Without it, re-pasting a dismissed
                # scan is silently refused -- which is precisely the behaviour
                # `restore_dismissed` exists to prevent.
                if restore_dismissed and url not in restored_urls:
                    node = self.ingestion.restore_dismissed_document(
                        url, actor=submitted_by)
                    if node is not None:
                        report.restored.append(node)
                        restored_urls.add(url)
                        continue
                # Reported as the caller spelled it: a curator who pasted a PDF
                # url should not be told that some JSTOR url they never typed was
                # refused.
                report.suppressed.append(requested)
                continue
            already = self.ingestion.find_document_by_url(url) is not None
            node = self.ingestion.submit_document(scraped, submitted_by=submitted_by,
                                                  searchterms=searchterms,
                                                  oa_pdf_url=scraped.get("oa_pdf_url"))
            if already:
                report.duplicates.append(node)
            else:
                report.ingested.append(node)
                # Only new documents link authors: submit is idempotent on the URL,
                # and re-linking a duplicate's authors would be redundant work.
                self._link_authors(node, scraped.get("authors") or [], submitted_by)
                if source_ids:
                    self.sources.record_provenance(node.id, source_ids,
                                                   actor=submitted_by)

        # Only what we actually tried to fetch can have failed -- suppressed URLs
        # were never attempted and are reported under `suppressed`, not `failed`.
        report.failed = [u for u in wanted if u not in attempted]
        return report

    def ingest_manual(self, *, url: str, title: str,
                      authors: Optional[List[str]] = None,
                      publication: Optional[str] = None,
                      date: Optional[str] = None,
                      abstract: Optional[str] = None,
                      full_text: Optional[str] = None,
                      submitted_by: Actor,
                      source_ids: Optional[List] = None) -> IngestReport:
        """File one document the curator typed in by hand, with no fetch at all.

        The fallback for `ingest_urls` when our own fetch can't reach a page (a
        403, a bot wall with no DOI to fall back on) but the curator can still get
        the page open in their own browser. Same three outcomes as a pasted URL --
        added, duplicate, or restored -- with `restore_dismissed` always on: typing
        a document in by hand is exactly the deliberate "I want this back" act that
        lifts a tombstone for a pasted URL too, and there's no reason a slower path
        to the same document should behave differently.

        `full_text` goes straight to `submit_document`'s `full_text` slot -- see
        that method's docstring for why it's kept at all. Nothing here re-derives
        `title` or the other fields from `full_text`; the curator typed what they
        typed, and this fills in exactly that, no scraping-style guessing."""
        report = IngestReport()
        url = url.strip()
        tombstoned = self.ingestion.tombstoned_urls()

        if url in tombstoned:
            node = self.ingestion.restore_dismissed_document(url, actor=submitted_by)
            if node is not None:
                report.restored.append(node)
                return report
            # Restore can only fail if the tombstoned row vanished between the two
            # reads -- vanishingly unlikely, but report it rather than silently
            # falling through to a submit that would collide with a dismissed row
            # the unique-url index still half-remembers.
            report.suppressed.append(url)
            return report

        existing = self.ingestion.find_document_by_url(url)
        if existing:
            report.duplicates.append(existing)
            return report

        scraped = {"url": url, "title": title, "authors": authors or [],
                  "publication": publication, "date": date, "abstract": abstract}
        node = self.ingestion.submit_document(scraped, submitted_by=submitted_by,
                                              full_text=full_text)
        report.ingested.append(node)
        if source_ids:
            self.sources.record_provenance(node.id, source_ids, actor=submitted_by)
        return report

    def ingest_candidates(self, candidates: List[Dict], *,
                          submitted_by: Actor) -> IngestReport:
        """Submit already-fetched discovery candidates as pending documents.

        Scout gets title/authors/date/publication/abstract straight from the OpenAlex
        and arXiv APIs, so there is nothing to scrape -- and a paywalled DOI would
        defeat a Reader round-trip anyway. The abstract is what carries review here:
        it arrives for closed and open works alike, so a curator can judge a paper
        whose full text nobody can fetch. Each dict is a flattened `Candidate`:
        `url`, `title`, `authors`, `publication`, `date`, `abstract`, plus
        `matched_terms` (-> `searchterms`), `source_ids` (-> `sourced_from` edges),
        and `oa_pdf_url` (a free copy, when one exists). Idempotent on URL, like
        `ingest_urls`, and it links authors on new documents the same way."""
        report = IngestReport()
        # Scout filters these out too, but that only covers the discovery path; this
        # is the backstop that holds the invariant for every caller.
        tombstoned = self.ingestion.tombstoned_urls()
        for c in candidates:
            url = c.get("url")
            if not url:
                continue
            if url in tombstoned:
                report.suppressed.append(url)
                continue
            scraped = {
                "url": url,
                "title": c.get("title"),
                "authors": c.get("authors") or [],
                "publication": c.get("publication"),
                "date": c.get("date"),
                "abstract": c.get("abstract"),
            }
            already = self.ingestion.find_document_by_url(url) is not None
            node = self.ingestion.submit_document(
                scraped, submitted_by=submitted_by,
                searchterms=c.get("matched_terms"),
                oa_pdf_url=c.get("oa_pdf_url"),
                venue_tier=c.get("venue_tier"),
                reference_count=c.get("reference_count"),
                proposed_concept_ids=c.get("proposed_concept_ids"))
            if already:
                report.duplicates.append(node)
            else:
                report.ingested.append(node)
                self._link_authors(node, scraped["authors"], submitted_by)
                # Where it came from. Several is normal: a paper found by both arXiv
                # and a lab's feed has two provenances.
                if c.get("source_ids"):
                    self.sources.record_provenance(node.id, c["source_ids"],
                                                   actor=submitted_by)
        return report

    def _link_authors(self, doc: Node, authors: List[Dict], actor: Actor) -> None:
        """Deliberately a no-op. Scraped authors stay records on the document
        (`attributes.authors_scraped`) and become nodes only when the curator says so.

        This USED to upsert a `person` node per scraped name and attach an
        `authored_by` edge, at submit time -- before anyone had reviewed the
        document. Two things were wrong with it, and the sandbox showed both:

        1. **The scraper cannot tell a person from an organization.** Every name it
           found was made a `person`, so "Center for Humane Technology" became a
           human with eleven papers to its name. The node type was a guess recorded
           as fact, and nothing downstream could tell it apart from a real one.
        2. **Candidates wrote to the graph before approval.** A dismissed document
           soft-deletes its edges but NOT the nodes ingestion conjured, so every
           author of every candidate ever fetched stayed forever. 1022 of 1037
           person nodes in the sandbox had no live edge at all -- 98% orphans,
           swamping the very search meant to find real people.

        The rule now matches concepts: nothing enters the graph until the curator
        approves the document. The review panel proposes matches by searching
        *existing* nodes, so a proposal can never invent a type, and the edges are
        written on Save (`PeopleService.set_authors`).

        Kept as a method rather than deleted at the call sites so the seam stays
        visible -- and because this is exactly where the LLM resolution pass will
        hang when it arrives (read the document, look the entity up, decide person
        or organization, find where it writes). See PEOPLE_DESIGN.md item 3.

        Note that an ORCID does NOT change this. It resolves a person with certainty,
        which is more than a name can do, but "we know who this is" still isn't "the
        curator accepted this document" -- and it is the second condition that admits
        anything to the graph. The certainty is spent on the *proposal* instead, in
        `_author_proposals`.
        """
        return
