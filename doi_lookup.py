"""Metadata for documents whose body can never be fetched.

Some publishers refuse automated readers outright -- SSRN, Wiley, Sage, ACM and
Taylor & Francis all answer a plain GET with a Cloudflare challenge, and JSTOR and
Elsevier with a bare 403. Reader classifies those as `blocked`, and before this
module that was the end of it: no text, so no result, so no node, so a paper the
curator had found in the wild couldn't be filed at all.

The way out is that scholarly URLs carry an identifier. Recovering the DOI from the
URL and asking OpenAlex about it yields the title, byline (with ORCIDs), venue, date
and -- crucially -- the abstract, which `IngestionService.submit_document` already
names as the thing that lets a curator review a document whose full text nobody can
fetch. The result is a metadata-only document: real, reviewable, and pointing at a
URL a human can open, with `body_text_found=False` saying plainly that no amount of
re-fetching will produce a body.

Two rules keep this honest:

* **The identifier comes from the URL, never from a search.** Every route here is a
  pattern over the URL or an exact-identifier lookup. Nothing is matched on title,
  because a near-miss would file the wrong paper under the right link -- a failure
  no curator could be expected to catch. When no identifier is derivable, this
  returns None and the URL fails as it did before.
* **One place metadata comes from.** Crossref appears only as an identifier
  resolver (for Elsevier's PII, which is not a DOI and maps to one by no arithmetic);
  the metadata itself is always OpenAlex, so there is a single record shape and a
  single notion of what `canonical_url` means.
"""

import os
import re
from datetime import datetime
from typing import Dict, List, Optional, Sequence

import requests

# SSRN and JSTOR ids are not DOIs, but both registrars mint DOIs from them by a
# fixed rule -- 10.2139/ssrn.<id> and 10.2307/<stable id>.
_SSRN = re.compile(r"(?:abstract_id=|/abstract=)(\d+)", re.I)
# arXiv mints a DOI for every submission the same way: 10.48550/arXiv.<id>. The
# version suffix (v1, v2) is deliberately dropped -- the DOI names the submission,
# and OpenAlex indexes one record for it however many versions were posted.
_ARXIV = re.compile(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/[0-9]{7})(?:v\d+)?", re.I)
_JSTOR = re.compile(r"jstor\.org/stable/(\d+)\b", re.I)
# The generic case, and the one that pays: Wiley, Sage, ACM and Taylor & Francis
# all put the DOI straight in the path, so one pattern covers four publishers.
_DOI_IN_PATH = re.compile(r"/(10\.\d{4,9}/[^\s?#]+)", re.I)
_NATURE = re.compile(r"nature\.com/articles/([a-z0-9.\-]+)", re.I)
# Elsevier is the exception that needs a lookup: a PII identifies the article but
# no arithmetic turns it into a DOI.
_PII = re.compile(r"sciencedirect\.com/science/article/(?:abs/|pii/)?(?:pii/)?(S[A-Z0-9]{16})",
                  re.I)

# Trailing view-mode segments some publishers append after the DOI.
_TRAILING = ("/pdf", "/epdf", "/full", "/abstract", "/meta", "/references")


def derive_doi(url: str) -> Optional[str]:
    """The DOI this URL names, from the string alone. No network, no guessing.

    Returns None when the URL carries no recoverable identifier -- ResearchGate,
    IEEE, and the whole non-academic web -- which is a real answer, not a failure.
    """
    if not url:
        return None

    m = _SSRN.search(url)
    if m:
        return f"10.2139/ssrn.{m.group(1)}"

    m = _JSTOR.search(url)
    if m:
        return f"10.2307/{m.group(1)}"

    m = _ARXIV.search(url)
    if m:
        return f"10.48550/arXiv.{m.group(1)}"

    m = _DOI_IN_PATH.search(url)
    if m:
        doi = m.group(1).rstrip("/")
        for suffix in _TRAILING:
            if doi.lower().endswith(suffix):
                doi = doi[: -len(suffix)]
        return doi.rstrip("/") or None

    m = _NATURE.search(url)
    if m:
        return f"10.1038/{m.group(1)}"

    return None


def pii_from_url(url: str) -> Optional[str]:
    """Elsevier's Publisher Item Identifier, as it appears in a ScienceDirect URL."""
    m = _PII.search(url or "")
    return m.group(1).upper() if m else None


class MetadataResolver:
    """Turns an unfetchable scholarly URL into a metadata-only document.

    Every failure path returns None. This runs inside ingestion, where an
    exception would take down a whole paste, and where "couldn't recover it" is an
    ordinary outcome rather than an error worth propagating.
    """

    OPENALEX = "https://api.openalex.org/works/doi:"
    OPENALEX_WORKS = "https://api.openalex.org/works"
    ARXIV = "http://export.arxiv.org/api/query"
    CROSSREF = "https://api.crossref.org/works"
    # OpenAlex's documented ceiling on values in one `filter=x:a|b|c` clause.
    BATCH = 50

    def __init__(self, timeout: float = 10.0, mailto: Optional[str] = None):
        self.timeout = timeout
        # Both APIs ask callers to identify themselves and give the polite pool
        # better service for it.
        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": f"mailto:{mailto}" if mailto else "FieldGuide/1.0"})

    # -- public ------------------------------------------------------------

    def resolve(self, url: str) -> Optional[Dict]:
        """A Reader-shaped result dict for `url`, or None if nothing is recoverable.

        For a document whose body could not be fetched at all: this is the whole
        record.
        """
        fields = self._fields_for(url)
        if fields is None:
            return None
        print(f"ℹ️  Body unavailable; metadata recovered via {fields['doi']}: {url}")
        return fields

    def enrich(self, url: str) -> Optional[Dict]:
        """The same fields, for a document we *did* fetch but couldn't read.

        A scanned PDF arrives with a byline and a title off its cover and no
        abstract at all, because the pages are images -- and the abstract is what a
        curator reviews a bodyless document on. Callers gap-fill from this rather
        than replacing what they already have: the cover sheet is the publisher's
        own stamp on this artifact, so it is not something a catalogue should
        overwrite.
        """
        fields = self._fields_for(url)
        if fields is None:
            return None
        print(f"ℹ️  No body text; filling metadata from {fields['doi']}: {url}")
        return fields

    # -- internals ---------------------------------------------------------

    def _fields_for(self, url: str) -> Optional[Dict]:
        doi = derive_doi(url) or self._doi_from_pii(url)
        if not doi:
            return None
        work = self._openalex_work(doi)
        if work is None:
            print(f"ℹ️  No OpenAlex record for {doi}: {url}")
            return None
        return self._as_result(url, doi, work)

    # -- identifier resolution --------------------------------------------

    def _doi_from_pii(self, url: str) -> Optional[str]:
        """Elsevier PII -> DOI, via Crossref's `alternative-id` filter.

        The compact form, exactly as the URL spells it, is what Crossref indexes;
        the hyphenated form publishers print on the page returns nothing.
        """
        pii = pii_from_url(url)
        if not pii:
            return None
        try:
            r = self.session.get(self.CROSSREF,
                                 params={"filter": f"alternative-id:{pii}", "rows": 2},
                                 timeout=self.timeout)
            if r.status_code != 200:
                return None
            items = (r.json().get("message") or {}).get("items") or []
        except (requests.exceptions.RequestException, ValueError):
            return None
        # Exactly one match or nothing: an ambiguous identifier is not an
        # identifier, and picking the first of several is how the wrong paper
        # gets filed under the right link.
        if len(items) != 1:
            return None
        return items[0].get("DOI")

    def cited_by_counts(self, urls: Sequence[str]) -> Dict[str, Optional[int]]:
        """How many works cite each of these documents, keyed by the URL asked about.

        Citation count is the one quality signal the guide has no way to compute and
        deliberately does not store. A count written into `nodes` is stale the day
        after, and nothing would ever refresh it; so it is fetched at the moment
        something wants to print it, and printed with the date it was fetched (see
        `queue_report`). Contrast `reference_count`, which is a durable fact about
        the paper -- how many works IT cites never changes.

        Keyed by the URL rather than by DOI because the caller has documents, not
        identifiers: turning a canonical URL into a DOI is this module's job and no
        one else's. Batched as `filter=doi:a|b|c`, 50 per request, which is the whole
        current queue in one call.

        Three different things all return None, and none of them is zero:
        a URL that names no DOI (`derive_doi` found nothing), a DOI OpenAlex has
        never seen, and the network being unreachable. A caller that renders any of
        them as `0` is asserting the paper is uncited, which we do not know. That is
        why the values are Optional and why nothing here raises -- a report that
        cannot reach OpenAlex must still print.
        """
        by_doi: Dict[str, List[str]] = {}
        out: Dict[str, Optional[int]] = {}
        for url in urls:
            doi = derive_doi(url)
            out[url] = None
            if doi:
                # Two URLs can name one DOI (an arXiv abs page and its PDF, a
                # publisher landing page and its doi.org form), so the map is
                # one-to-many and both get the answer.
                by_doi.setdefault(doi.lower(), []).append(url)

        self._fill_counts(by_doi, out)

        # Second pass, arXiv only. A preprint's own DOI (10.48550/arXiv.<id>) is
        # minted by DataCite and OpenAlex frequently has no record under it -- but it
        # does have the *published* version, indexed under the publisher's DOI, with
        # the citations attached to that. So a paper that went on to a venue looks
        # uncited when it is the most cited thing in the queue.
        #
        # arXiv itself knows the mapping: the authors declare the journal DOI on the
        # submission, and the API returns it in `arxiv:doi`. That keeps this module's
        # rule intact -- an identifier resolved to another identifier, never a title
        # matched against a search. A preprint with no such DOI resolves to nothing
        # and stays unknown, which is the honest answer: it was never published, so
        # there is no published record to count.
        stranded = {url: doi for doi, urls in by_doi.items() for url in urls
                    if out[url] is None and doi.startswith("10.48550/arxiv.")}
        if stranded:
            published = self.published_dois(stranded)
            by_published: Dict[str, List[str]] = {}
            for url, doi in published.items():
                by_published.setdefault(doi.lower(), []).append(url)
            self._fill_counts(by_published, out)
        return out

    def _fill_counts(self, by_doi: Dict[str, List[str]],
                     out: Dict[str, Optional[int]]) -> None:
        """Ask OpenAlex about every DOI in `by_doi` and write the answers into `out`."""
        dois = list(by_doi)
        for i in range(0, len(dois), self.BATCH):
            for doi, count in self._counts_for(dois[i:i + self.BATCH]).items():
                for url in by_doi.get(doi, ()):
                    out[url] = count

    def published_dois(self, arxiv_urls: Sequence[str]) -> Dict[str, str]:
        """arXiv URL -> the DOI of the version that went to a venue, where there is one.

        arXiv is an identifier resolver here and nothing more, the same narrow role
        Crossref plays for Elsevier's PII: no metadata is taken from the answer, only
        the DOI the authors themselves recorded. Batched via `id_list` (arXiv allows
        100 per query), so the whole queue's preprints cost one request.

        Silent on every failure, like the rest of this module -- a missing mapping
        costs a count, not a report.
        """
        ids: Dict[str, str] = {}
        for url in arxiv_urls:
            m = _ARXIV.search(url or "")
            if m:
                ids[m.group(1).lower()] = url

        out: Dict[str, str] = {}
        keys = list(ids)
        for i in range(0, len(keys), self.BATCH):
            chunk = keys[i:i + self.BATCH]
            try:
                r = self.session.get(self.ARXIV, timeout=self.timeout,
                                     params={"id_list": ",".join(chunk),
                                             "max_results": len(chunk)})
                if r.status_code != 200:
                    continue
                body = r.text
            except requests.exceptions.RequestException:
                continue
            # Atom, and the one field wanted is a leaf with no attributes worth
            # reading, so a regex beats dragging an XML parser in for it.
            for entry in body.split("<entry>")[1:]:
                got_id = re.search(r"<id>\s*([^<]+?)\s*</id>", entry)
                doi = re.search(r"<arxiv:doi[^>]*>\s*([^<\s]+)\s*</arxiv:doi>", entry)
                if not (got_id and doi):
                    continue
                m = _ARXIV.search(got_id.group(1))
                url = ids.get(m.group(1).lower()) if m else None
                if url:
                    out[url] = doi.group(1)
        return out


    def _counts_for(self, dois: Sequence[str]) -> Dict[str, int]:
        """One batched request. DOIs missing from the answer are simply absent."""
        try:
            r = self.session.get(
                self.OPENALEX_WORKS,
                params={"filter": "doi:" + "|".join(dois),
                        "select": "doi,cited_by_count",
                        "per-page": self.BATCH},
                timeout=self.timeout)
            if r.status_code != 200:
                return {}
            results = (r.json() or {}).get("results") or []
        except (requests.exceptions.RequestException, ValueError):
            return {}
        counts: Dict[str, int] = {}
        for work in results:
            # OpenAlex answers with the DOI in its URL form; we asked in bare form.
            # Normalising here rather than at the call site keeps the two shapes
            # from escaping this module -- the same rule `normalize_orcid` follows.
            doi = (work.get("doi") or "").lower()
            for prefix in ("https://doi.org/", "http://doi.org/", "doi.org/"):
                if doi.startswith(prefix):
                    doi = doi[len(prefix):]
            count = work.get("cited_by_count")
            if doi and isinstance(count, int):
                counts[doi] = count
        return counts

    def _openalex_work(self, doi: str) -> Optional[Dict]:
        try:
            r = self.session.get(f"{self.OPENALEX}{doi}", timeout=self.timeout)
            if r.status_code != 200:
                return None
            work = r.json()
        except (requests.exceptions.RequestException, ValueError):
            return None
        return work if isinstance(work, dict) and work.get("id") else None

    # -- mapping -----------------------------------------------------------

    def _as_result(self, requested_url: str, doi: str, work: Dict) -> Dict:
        """An OpenAlex work as a Reader result.

        `url` is the DOI, matching what `OpenAlexAdapter` already files works
        under -- so a paper pasted by hand and the same paper found by a search
        land on one node instead of two.
        """
        # Imported here rather than at module scope: `derive_doi` is a pure string
        # function that Reader wants, and dragging scout's whole dependency stack
        # (anthropic, feedparser) into Reader's import graph to get it would be a
        # poor trade. The inverted-index unpacking is subtle and already correct
        # there, so it is still reused rather than copied.
        from scout import OpenAlexAdapter

        authors: List[Dict] = []
        for a in work.get("authorships", []):
            person = a.get("author") or {}
            name = (person.get("display_name") or "").strip()
            if name:
                authors.append({"name": name, "orcid": person.get("orcid")})

        date = work.get("publication_date") or ""
        source = (work.get("primary_location") or {}).get("source") or {}
        best_oa = work.get("best_oa_location") or {}

        return {
            "url": f"https://doi.org/{doi}",
            "requested_url": requested_url,
            "title": work.get("title") or "",
            "authors": authors,
            "date": date[:10] if len(date) >= 10 else None,
            "publication": source.get("display_name"),
            "doi": doi,
            # The whole point: open metadata arrives for closed papers, and an
            # abstract is enough to review one on.
            "abstract": OpenAlexAdapter._abstract_from_index(
                work.get("abstract_inverted_index")) or "",
            "text": "",
            "body_text_found": False,
            "oa_pdf_url": best_oa.get("pdf_url"),
            "fetch_outcome": "metadata_only",
            "scraped_at": datetime.now().isoformat(),
        }


def default_resolver() -> MetadataResolver:
    """The resolver the app runs with. $OPENALEX_MAILTO opts into the polite pool."""
    return MetadataResolver(mailto=os.environ.get("OPENALEX_MAILTO"))
