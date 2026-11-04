import io
import re
import requests
import statistics
import trafilatura
import json
from typing import List, Dict, Optional, Tuple
from datetime import datetime
import time

import fitz  # PyMuPDF -- used only to reconstruct real paragraphs from a
             # PDF's body text (see _pdf_body_paragraphs). Metadata, the
             # JSTOR cover sheet, and the scanned-document check all still go
             # through pypdf below, unchanged.
from bs4 import BeautifulSoup
from pypdf import PdfReader

from doi_lookup import derive_doi
from extractors import ExtractorRegistry, default_registry


# Why a fetch came back with no body, in plain terms a reader can act on. Keyed
# on `fetch_outcome` (set above by scrape_urls, or by the DOI resolver it falls
# back to) -- the one field that knows *why*, as opposed to a document's own
# `body_text_found`, which only says *that* there's no body. Shared by
# api.py's document viewer and the curation assistant's own fetch-and-cache
# step (assistant/text_writer.py), so a curator sees the same explanation
# either way.
NO_BODY_REASONS = {
    "no_text_layer": ("This document has no text layer — it's a scan, so there is "
                     "nothing to render. Open the original to read it."),
    "metadata_only": ("The publisher doesn't allow automated readers, so only the "
                      "catalogue metadata could be retrieved. Open the original "
                      "to read it."),
}


def split_paragraphs(text: str) -> List[str]:
    """Split a document's raw text into paragraphs: one per non-blank line,
    with surrounding whitespace trimmed. Shared for the same reason
    NO_BODY_REASONS is -- api.py's document viewer, the curation assistant's
    fetch-and-cache step (assistant/text_writer.py), and its evidence-finding
    step (assistant/evidence.py) all need to agree on what a "paragraph" is."""
    return [p.strip() for p in text.split("\n") if p.strip()]


# Common abbreviations that end in a period without ending a sentence.
# Checked against the last word before a candidate split point, lowercased.
_SENTENCE_ABBREVIATIONS = {
    "al.", "e.g.", "i.e.", "vs.", "cf.", "etc.", "fig.", "eq.", "eqs.",
    "dr.", "mr.", "mrs.", "ms.", "prof.", "no.", "nos.", "pp.", "st.",
    "jr.", "sr.", "vol.", "ed.", "eds.", "approx.",
}

# A sentence boundary: sentence-ending punctuation, optionally a closing
# quote mark, then whitespace, then something that looks like the start of a
# new sentence. Digits are deliberately excluded from what can follow --
# academic text is full of decimals and statistics ("p < 0.05", "3.10 and
# 4.00") that would otherwise look like a sentence end.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])[\"'’”]?\s+(?=[A-Z\"'‘“(])")


def split_sentences(paragraph: str) -> List[str]:
    """Split one paragraph into sentences -- used only so the curation
    assistant's evidence-quoting step (assistant/evidence.py) can offer a
    model a menu of real, ready-made pieces to PICK from, never to write.
    That's what makes this safe to be imperfect: a decimal, a citation like
    "et al.", or an unusual abbreviation can still make it cut in the wrong
    spot, so a picked "sentence" occasionally runs a little long or short --
    but it is always real text lifted verbatim from the paragraph, never
    something the model composed. Good enough is good enough here.
    """
    text = paragraph.strip()
    if not text:
        return []

    sentences = []
    start = 0
    for m in _SENTENCE_BOUNDARY.finditer(text):
        before = text[start:m.start()]
        last_word = before.strip().split()[-1].lower() if before.strip() else ""
        if last_word in _SENTENCE_ABBREVIATIONS:
            continue  # not a real sentence end -- keep accumulating
        sentences.append(before.strip())
        start = m.end()
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


# Matches an arXiv abstract-page URL and captures its id (with version, if
# any) -- e.g. "https://arxiv.org/abs/2602.09907v2" -> "2602.09907v2".
_ARXIV_ABS = re.compile(r"^https?://arxiv\.org/abs/([^?#]+)", re.I)


def candidate_fetch_urls(canonical_url: Optional[str], oa_pdf_url: Optional[str] = None) -> List[str]:
    """URLs worth trying, in priority order, to get a document's actual
    readable body. `canonical_url` is a document's stable identifying link,
    which is sometimes a landing/citation page rather than the paper itself
    -- most visibly for arXiv, where discovery (scout.py) deliberately files
    a document under its abstract page (`arxiv.org/abs/...`), not something
    meant to be read. Fetching only that page, as every caller did before
    this existed, gets the abstract and arXiv's own sidebar links, and
    nothing else.

    1. `oa_pdf_url`, when set and different from `canonical_url` -- a direct
       open-access PDF link (populated for documents discovered via
       OpenAlex), so the likeliest of these to already be the real body.
    2. If `canonical_url` is an arXiv abstract page, that same paper's PDF
       (`arxiv.org/pdf/<id>`) -- a long-stable arXiv URL shape, used instead
       of arXiv's newer "HTML (experimental)" view.
    3. `canonical_url` itself, always tried last -- the only thing any
       caller ever tried before this existed, kept as the final fallback.
    """
    candidates = []
    if oa_pdf_url and oa_pdf_url != canonical_url:
        candidates.append(oa_pdf_url)
    m = _ARXIV_ABS.match(canonical_url or "")
    if m:
        candidates.append(f"https://arxiv.org/pdf/{m.group(1)}")
    if canonical_url:
        candidates.append(canonical_url)
    return candidates


def fetch_best_result(reader: "Reader", canonical_url: Optional[str],
                       oa_pdf_url: Optional[str] = None) -> Optional[Dict]:
    """Try each candidate URL (see candidate_fetch_urls) in order, and return
    the first fetch that actually came back with body text.

    If none of them did, still returns the last candidate that produced any
    HTTP-level result at all, so its `fetch_outcome` can explain why (a scan,
    a metadata-only block, ...) -- same as when only `canonical_url` was ever
    tried. Returns None only when every candidate failed outright with no
    result at all (a network problem, a hard block) -- the caller's existing
    "don't cache this, it might just be a blip" handling for that case is
    unchanged by there now being more than one URL to try.
    """
    last = None
    for url in candidate_fetch_urls(canonical_url, oa_pdf_url):
        results = reader.scrape_urls([url])
        if not results:
            continue
        last = results[0]
        if (last.get("text") or "").strip():
            return last
    return last


class Reader:
    # article:content_tier values that indicate a gated/paywalled page.
    PAYWALL_TIERS = {"metered", "locked", "premium", "subscription", "subscriber"}

    # Content types we know how to turn into a document. Anything else fails
    # honestly rather than being decoded as text and handed to trafilatura --
    # which is what made a 5MB PDF cost 30s of charset detection to produce
    # nothing.
    HTML_TYPES = {"text/html", "application/xhtml+xml"}
    PDF_TYPES = {"application/pdf", "application/x-pdf"}

    # Bot walls do not reliably use an error status. The same JSTOR url answered
    # 403 `cf-mitigated: challenge`, 200 with a "Client Challenge" interstitial, and
    # 403 "JSTOR: Access Check" within one afternoon -- so a document's identity and
    # contents would otherwise depend on which one we happened to get. The 200 is
    # the dangerous one: it carries a couple of hundred characters of "please enable
    # JavaScript", which is enough text to look like a successful extraction and
    # lands a document titled *Client Challenge* in the queue.
    #
    # Matched on the page title, which is where these identify themselves and where
    # a real article will not collide.
    CHALLENGE_TITLES = (
        "just a moment",            # Cloudflare
        "attention required",       # Cloudflare block page
        "client challenge",         # Imperva/Incapsula, which is what JSTOR fronts with
        "access check",
        "checking your browser",
        "are you a robot",
        "access denied",
    )
    # Weaker signals: real prose could contain these, so they only count on a page
    # too small to be an article. Interstitials run ~5KB.
    CHALLENGE_PHRASES = (
        "enable javascript and cookies to continue",
        "javascript is disabled in your browser",
        "please enable javascript to proceed",
    )
    MAX_CHALLENGE_HTML = 50_000

    def __init__(
        self,
        delay: float = 1.0,
        registry: Optional[ExtractorRegistry] = None,
        timeout: float = 20.0,
        max_retries: int = 1,
        retry_backoff: float = 2.0,
        min_fulltext_chars: int = 1500,
        min_pdf_chars_per_page: float = 100.0,
        resolver=None,
    ):
        """
        Initialize the Reader.

        Args:
            delay: Delay between requests in seconds to be respectful to servers
            registry: Metadata extractor registry. Defaults to the standard stack
                (see extractors.default_registry). Inject a custom registry to
                add site-specific extractors or change extraction behavior.
            timeout: Per-request read/connect timeout in seconds.
            max_retries: Extra attempts on retryable failures (timeout, 5xx).
            retry_backoff: Base backoff in seconds; grows per attempt.
            min_fulltext_chars: Below this, a paywalled page is treated as
                truncated rather than fully retrieved.
            min_pdf_chars_per_page: Below this average, a PDF's text layer is
                treated as absent -- the page images are a scan and whatever few
                characters came out are furniture, not the article.
            resolver: Optional `doi_lookup.MetadataResolver`. When a fetch is
                refused outright, it recovers the document's metadata from its
                DOI. Defaults to None -- off -- so Reader stays offline-testable
                and nothing acquires a second network dependency by surprise.
        """
        self.delay = delay
        self.registry = registry or default_registry()
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_backoff = retry_backoff
        self.min_fulltext_chars = min_fulltext_chars
        self.min_pdf_chars_per_page = min_pdf_chars_per_page
        self.resolver = resolver
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (compatible; Reader/1.0; +http://example.com/bot)'
        })

    def scrape_urls(self, urls: List[str]) -> List[Dict]:
        """
        Scrape a list of URLs and extract content.

        Args:
            urls: List of URLs to scrape

        Returns:
            List of dicts with extracted content and metadata. Fetch-level
            failures (blocked / timeout / unavailable) are warned about but not
            included in the results.

        A result is not required to carry body text. An HTML page that extracts
        to nothing is still dropped -- for HTML, "no text" is the signal that the
        fetch landed on an interstitial or an error page rather than an article,
        and the metadata extractors, which read the same HTML, will be equally
        empty. A PDF is different: it announced itself as a document, so it
        becomes a result whether or not a text layer came with it, and
        ``body_text_found`` carries which. That distinction is the whole reason
        a scanned paper can enter the graph at all.
        """
        results = []

        for url in urls:
            try:
                print(f"Scraping {url}...")
                payload, status, kind = self._fetch_url(url)
                if status == "ok" and payload:
                    extracted = (self._extract_pdf(url, payload) if kind == "pdf"
                                 else self._extract_content(url, payload))
                    if extracted:
                        results.append(extracted)
                elif status == "blocked" and self.resolver is not None:
                    # A refusal is the one failure worth a second question. It says
                    # the publisher won't serve robots -- not that the paper is
                    # unknown -- and scholarly urls carry an identifier that other
                    # services will answer for. A timeout or a 5xx gets no such
                    # treatment: those may well succeed on the next run, and filing
                    # a bodyless document for one would be giving up early.
                    recovered = self.resolver.resolve(url)
                    if recovered:
                        results.append(recovered)

                # Be respectful to servers
                time.sleep(self.delay)
            except Exception as e:
                print(f"Error scraping {url}: {e}")

        return results

    def _fetch_url(self, url: str) -> Tuple[Optional[object], str, str]:
        """Fetch a URL and hand back its body in the form its type deserves.

        Returns:
            (payload, status, kind) where status is one of:
              'ok'          - fetched successfully
              'blocked'     - server refused (401/403/451); often a hard paywall
                              or bot protection
              'timeout'     - request timed out after retries
              'unavailable' - connection error, 5xx, or other HTTP failure
              'unsupported' - fetched fine, but not a type we can read
            and kind is 'html' | 'pdf' | 'other'. The payload is `str` for HTML
            and `bytes` for PDF; on any non-'ok' status it is None and a warning
            was printed.

        The branch matters for more than tidiness. ``response.text`` runs charset
        detection over the whole body, which on a 5MB scanned PDF costs ~30s to
        produce a string nothing can use. Deciding on Content-Type first means a
        PDF is never decoded as text, and an unreadable type says so instead of
        arriving as a mystery "no content extracted".
        """
        reason = None
        fail_status = "unavailable"

        for attempt in range(self.max_retries + 1):
            try:
                response = self.session.get(url, timeout=self.timeout)
                response.raise_for_status()
                kind = self._content_kind(response)
                if kind == "pdf":
                    return response.content, "ok", "pdf"
                if kind == "html":
                    html = response.text
                    if self._looks_like_challenge(html):
                        print(f"⚠️  Bot challenge served as HTTP {response.status_code} "
                              f"— treating as blocked: {url}")
                        return None, "blocked", "other"
                    return html, "ok", "html"
                ctype = (response.headers.get("content-type") or "?").split(";")[0]
                print(f"⚠️  Unsupported content type ({ctype}): {url}")
                return None, "unsupported", "other"
            except requests.exceptions.HTTPError as e:
                code = e.response.status_code if e.response is not None else None
                if code in (401, 403, 451):
                    print(f"⚠️  Blocked (HTTP {code}) — likely paywall or bot protection: {url}")
                    return None, "blocked", "other"
                if code and 500 <= code < 600:
                    reason = f"server error (HTTP {code})"  # retryable
                else:
                    print(f"⚠️  Failed to fetch (HTTP {code}): {url}")
                    return None, "unavailable", "other"
            except requests.exceptions.Timeout:
                reason, fail_status = f"timed out after {self.timeout:.0f}s", "timeout"  # retryable
            except requests.exceptions.RequestException as e:
                print(f"⚠️  Failed to fetch ({e.__class__.__name__}): {url}")
                return None, "unavailable", "other"

            # Only retryable failures (timeout / 5xx) reach here.
            if attempt < self.max_retries:
                backoff = self.retry_backoff * (attempt + 1)
                print(f"   {reason}; retrying in {backoff:.0f}s: {url}")
                time.sleep(backoff)

        print(f"⚠️  Gave up on {url}: {reason}")
        return None, fail_status, "other"

    def _looks_like_challenge(self, html: str) -> bool:
        """Is this a bot wall wearing a success status?

        The alternative to catching it here is a document called *Client Challenge*
        whose body is a JavaScript notice -- indistinguishable, once filed, from a
        paper someone chose. Classifying it as `blocked` also puts it in front of
        the DOI resolver, so the paper it was standing in for still gets in.
        """
        if not html:
            return False

        head = html[:20000]
        m = re.search(r"<title[^>]*>(.*?)</title>", head, re.I | re.S)
        title = " ".join(m.group(1).split()).lower() if m else ""
        if title and any(sig in title for sig in self.CHALLENGE_TITLES):
            return True

        if len(html) <= self.MAX_CHALLENGE_HTML:
            low = html.lower()
            return any(p in low for p in self.CHALLENGE_PHRASES)
        return False

    def _content_kind(self, response) -> str:
        """Classify a fetched response as 'html' | 'pdf' | 'other'.

        Content-Type decides, with a magic-byte fallback: plenty of file hosts
        serve PDFs as ``application/octet-stream`` or with no type at all, and a
        paper that ends in `.pdf` shouldn't be unreadable because a webserver was
        configured carelessly.
        """
        ctype = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
        if ctype in self.PDF_TYPES:
            return "pdf"
        if ctype in self.HTML_TYPES:
            return "html"
        if response.content[:5] == b"%PDF-":
            return "pdf"
        return "other"

    def _extract_content(self, url: str, html: str) -> Optional[Dict]:
        """Extract body text (Trafilatura) and metadata (extractor registry).

        Also determines a ``fetch_outcome``: 'ok', 'paywalled_ok' (gated but full
        text retrieved), or 'truncated' (gated and text looks clipped). It
        describes *this fetch* and is recomputed on every one -- the durable
        counterpart, ``body_text_found``, is what the document keeps.
        """
        try:
            content = trafilatura.extract(html, include_comments=False)
            paywalled = self._paywall_signal(html)

            if not content:
                if paywalled:
                    print(f"⚠️  Likely paywall block (no text extracted): {url}")
                else:
                    print(f"No content extracted from {url}")
                return None

            meta = self.registry.extract(url, html)

            if paywalled and len(content) < self.min_fulltext_chars:
                outcome = "truncated"
                print(f"⚠️  Possible paywall truncation: {url} (only {len(content)} chars)")
            elif paywalled:
                outcome = "paywalled_ok"
                print(f"ℹ️  Paywall detected, full text retrieved: {url}")
            else:
                outcome = "ok"

            return {
                'url': url,
                'requested_url': url,
                'title': meta.title,
                'authors': meta.authors,
                'date': meta.date,
                'publication': meta.publication,
                'doi': meta.doi,
                'text': content,
                'body_text_found': True,
                'fetch_outcome': outcome,
                'scraped_at': datetime.now().isoformat()
            }
        except Exception as e:
            print(f"Error extracting content from {url}: {e}")
            return None

    # ----------------------------------------------------------------------
    # PDFs
    # ----------------------------------------------------------------------

    def _extract_pdf(self, url: str, data: bytes) -> Optional[Dict]:
        """Turn a fetched PDF into a result dict, with or without body text.

        Three things have to be told apart, and conflating any two of them is how
        a scanned paper ends up either missing or lying:

        * **Metadata** comes from the PDF's ``/Info`` dictionary, and for JSTOR
          scans additionally from the cover page (see ``_jstor_cover_fields``).
        * **Body text** is everything *except* a JSTOR cover. The cover is the
          only page of a scan with a text layer, so counting it as body text
          would hand the summarizer JSTOR's terms of use as the article -- a
          silent wrong answer, which is worse than the visible failure this
          replaces.
        * **Whether body text exists at all** is `body_text_found`. A scan's
          page images carry no text, and no amount of extraction will change
          that; the document still belongs in the graph, pointing at something a
          human can read.
        """
        try:
            pdf = PdfReader(io.BytesIO(data))
            info = pdf.metadata or {}
            pages = [(p.extract_text() or "") for p in pdf.pages]
        except Exception as e:
            print(f"⚠️  Couldn't read PDF ({e.__class__.__name__}): {url}")
            return None

        if not pages:
            print(f"⚠️  PDF has no pages: {url}")
            return None

        canonical, oa_pdf_url, doi = url, None, None
        title = _clean_pdf_str(info.get("/Title"))
        authors = [a for a in [_clean_pdf_str(info.get("/Author"))] if a]
        publication, date = None, None

        cover = self._jstor_cover_fields(info, pages[0])
        if cover:
            body_pages = pages[1:]
            title = cover.get("title") or title
            authors = cover.get("authors") or authors
            publication = cover.get("publication")
            date = cover.get("date")
            if cover.get("stable_url"):
                # Identity comes off the cover sheet, not off the url that was
                # pasted: a course-site copy is one of many places this paper
                # sits, and filing under it would make each of them a separate
                # document. The PDF we actually fetched becomes the link-out for
                # readers without JSTOR access -- which is what frees
                # `canonical_url` to be the stablest identifier available rather
                # than the most readable link.
                #
                # That identifier is the DOI. A JSTOR stable id maps to one by a
                # fixed rule, and the DOI is what every OpenAlex-discovered work
                # is already filed under -- so the same paper found by a search,
                # pasted as a PDF, or pasted as a JSTOR page is one node and not
                # three. Derived from the string alone, so identity never depends
                # on a lookup succeeding; the stable url stands in if there's no
                # DOI to be had.
                oa_pdf_url = url
                doi = derive_doi(cover["stable_url"])
                canonical = f"https://doi.org/{doi}" if doi else cover["stable_url"]
        else:
            body_pages = pages

        body = "\n".join(p for p in body_pages if p.strip())
        per_page = len(body) / max(1, len(body_pages))
        found = bool(body.strip()) and per_page >= self.min_pdf_chars_per_page
        if not found:
            print(f"ℹ️  No usable text layer ({per_page:.0f} chars/page over "
                  f"{len(body_pages)} pages) — scanned document: {url}")

        if found:
            # pypdf's `body` above is only used to decide *whether* there's a
            # real text layer (the character-density check just did that).
            # The text actually kept is reconstructed into real paragraphs
            # instead -- see _pdf_body_paragraphs's own docstring for why
            # pypdf's flat per-line text can't tell a paragraph break from a
            # page's ordinary word-wrap.
            try:
                paragraphs = _pdf_body_paragraphs(data, skip_pages=1 if cover else 0)
                body = "\n".join(paragraphs) if paragraphs else body
            except Exception as e:
                print(f"⚠️  Paragraph reconstruction failed, falling back to "
                      f"plain text ({e.__class__.__name__}): {url}")

        abstract = ""
        if not found and self.resolver is not None:
            # A scan has no abstract to give -- the pages are images -- and the
            # abstract is the whole basis on which a bodyless document gets
            # reviewed. The catalogue has one, and the stable url off the cover
            # sheet is exactly the identifier needed to ask for it.
            extra = self.resolver.enrich(canonical)
            if extra:
                doi = doi or extra.get("doi")
                abstract = extra.get("abstract") or ""
                # Gap-fill, in the registry's idiom: what the document says about
                # itself outranks what a catalogue says about it, so the cover
                # sheet keeps every field it filled.
                title = title or extra.get("title")
                publication = publication or extra.get("publication")
                date = date or extra.get("date")
                authors = _with_orcids(authors, extra.get("authors") or [])

        return {
            'url': canonical,
            'requested_url': url,
            'title': title,
            'authors': authors,
            'date': date,
            'publication': publication,
            'doi': doi,
            'abstract': abstract,
            'text': body if found else "",
            'body_text_found': found,
            'oa_pdf_url': oa_pdf_url,
            'fetch_outcome': 'ok' if found else 'no_text_layer',
            'scraped_at': datetime.now().isoformat()
        }

    # JSTOR's generator stamps every PDF it makes, which is a far steadier
    # signal than sniffing the cover text for a house style that changes.
    JSTOR_CREATORS = ("jstorpdfgenerator",)
    _JSTOR_STABLE = re.compile(r"https?://(?:www\.)?jstor\.org/stable/(\S+)", re.I)

    def _jstor_cover_fields(self, info: Dict, first_page: str) -> Optional[Dict]:
        """Parse a JSTOR cover sheet into metadata, or None if this isn't one.

        The cover is a labelled block, not prose, which is why it's worth reading
        at all::

            Well-Being, Agency and Freedom: The Dewey Lectures 1984
            Author(s): Amartya Sen
            Source: The Journal of Philosophy, Vol. 82, No. 4 (Apr., 1985), pp. 169-221
            Stable URL: http://www.jstor.org/stable/2026184
        """
        creator = (_clean_pdf_str(info.get("/Creator")) or "").lower()
        is_jstor = (any(c in creator for c in self.JSTOR_CREATORS)
                    or bool(self._JSTOR_STABLE.search(first_page)))
        if not is_jstor:
            return None

        out: Dict = {}

        stable = self._JSTOR_STABLE.search(first_page)
        if stable:
            # https, because the cover sheets of older scans were stamped when
            # JSTOR was still http and the canonical url is a dedupe key.
            out["stable_url"] = f"https://www.jstor.org/stable/{stable.group(1)}"

        authors = re.search(r"^Author\(s\):\s*(.+)$", first_page, re.M)
        if authors:
            out["authors"] = _split_authors(authors.group(1))

        source = re.search(r"^Source:\s*(.+)$", first_page, re.M)
        if source:
            out["publication"] = _clean_pdf_str(
                re.split(r",\s*Vol\.|,\s*No\.|\s*\(", source.group(1))[0])
            out["date"] = _jstor_date(source.group(1))

        # The line above `Author(s):` is the article title. `/Info` usually has it
        # too, but the cover is the one that's right when a PDF was re-stamped.
        if authors:
            before = first_page[:authors.start()].strip().splitlines()
            if before:
                out["title"] = _clean_pdf_str(before[-1])

        return out

    def _paywall_signal(self, html: str) -> bool:
        """True if the page advertises itself as paywalled/metered.

        Two independent signals: an ``article:content_tier`` meta tag with a
        gated value, or schema.org ``isAccessibleForFree: false`` in JSON-LD.
        This says the content is *gated*, not that our fetch failed.
        """
        soup = BeautifulSoup(html, "lxml")

        for attr in ("property", "name"):
            tag = soup.find("meta", attrs={attr: "article:content_tier"})
            if tag and (tag.get("content") or "").strip().lower() in self.PAYWALL_TIERS:
                return True

        for script in soup.find_all("script", type="application/ld+json"):
            raw = script.string or script.get_text() or ""
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if self._json_says_not_free(data):
                return True

        return False

    def _json_says_not_free(self, node) -> bool:
        """Recursively search JSON-LD for isAccessibleForFree being false."""
        if isinstance(node, dict):
            val = node.get("isAccessibleForFree")
            if val is not None and str(val).strip().lower() in ("false", "no", "0"):
                return True
            return any(self._json_says_not_free(v) for v in node.values())
        if isinstance(node, list):
            return any(self._json_says_not_free(v) for v in node)
        return False


# --------------------------------------------------------------------------
# PDF helpers
# --------------------------------------------------------------------------

_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


def _pdf_ordered_lines(lines: List[Tuple]) -> List[Tuple]:
    """Put one PDF page's lines into reading order.

    `lines` is a list of (x0, y0, x1, y1, text) boxes, in no particular
    order. A plain top-to-bottom sort is wrong for a two-column page: it
    interleaves the two columns line by line, splicing the end of a
    left-column sentence onto the start of whatever happens to sit at the
    same height in the right column.

    This looks for one big horizontal gap splitting the page's lines into two
    x-position clusters -- the empty gutter between two columns. A line that
    starts before the gap AND ends after it (its text spans past the gutter)
    is a row divider -- a title, section heading, or anything else sitting
    above/below the two-column region -- and everything collected so far is
    flushed (left column top-to-bottom, then right column top-to-bottom)
    before it. A page with no such gap (the ordinary single-column case) is
    just sorted top-to-bottom, left-to-right, as before.
    """
    if not lines:
        return []

    xs0 = sorted(round(l[0]) for l in lines)
    gaps = [(xs0[i + 1] - xs0[i], xs0[i], xs0[i + 1]) for i in range(len(xs0) - 1)]
    big_gaps = [g for g in gaps if g[0] >= 80]
    if not big_gaps:
        return sorted(lines, key=lambda l: (round(l[1], 1), l[0]))

    _, left_max, right_min = max(big_gaps, key=lambda g: g[0])

    ordered: List[Tuple] = []
    pending_left: List[Tuple] = []
    pending_right: List[Tuple] = []

    def flush():
        pending_left.sort(key=lambda l: l[1])
        pending_right.sort(key=lambda l: l[1])
        ordered.extend(pending_left)
        ordered.extend(pending_right)
        pending_left.clear()
        pending_right.clear()

    for line in sorted(lines, key=lambda l: l[1]):
        x0, y0, x1, y1, text = line
        if x0 <= left_max and x1 > right_min:
            flush()
            ordered.append(line)
        elif x0 <= left_max:
            pending_left.append(line)
        else:
            pending_right.append(line)
    flush()
    return ordered


# arXiv stamps this on every page of the PDF it generates -- a sidebar/footer
# watermark, not part of the paper -- e.g. "arXiv:2602.09907v2  [cs.HC]  13
# Jul 2026". Dropped before paragraphs are assembled: it's positioned closely
# enough to real body text on some pages that it would otherwise get glued
# onto the end of whatever paragraph happens to be nearby.
_ARXIV_WATERMARK = re.compile(r"^arXiv:\S+\s+\[[A-Za-z0-9.\-]+\]\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$")


def _pdf_page_paragraphs(page) -> List[str]:
    """One PDF page's text as real paragraphs, using PyMuPDF's exact line
    positions -- unlike pypdf's flat per-line text (what Reader otherwise
    uses), which carries no marker at all between a paragraph's wrapped
    lines and the start of the next paragraph.

    Two signals mark a new paragraph, either being enough on its own: a
    first line noticeably indented past the page's usual left margin (common
    in justified academic text with paragraph indents), or a gap to the
    previous line distinctly bigger than the page's normal line-to-line
    spacing (catches section headings, which usually aren't indented).
    Everything else is a wrapped continuation of the current paragraph,
    joined with a space -- these are mid-sentence line breaks, not real ones.
    """
    raw_lines = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:  # not a text block (e.g. an image)
            continue
        for line in block["lines"]:
            text = "".join(span["text"] for span in line["spans"]).strip()
            if text and not _ARXIV_WATERMARK.match(text):
                raw_lines.append(line["bbox"] + (text,))
    if not raw_lines:
        return []

    lines = _pdf_ordered_lines(raw_lines)
    margin = statistics.mode([round(l[0]) for l in lines])
    line_gaps = [lines[i][1] - lines[i - 1][3] for i in range(1, len(lines))
                 if lines[i][1] - lines[i - 1][3] > 0]
    median_gap = statistics.median(line_gaps) if line_gaps else 0

    paragraphs = []
    current: List[str] = []
    prev_bottom = None
    for (x0, y0, x1, y1, text) in lines:
        gap = (y0 - prev_bottom) if prev_bottom is not None else 0
        is_indent = round(x0) > margin + 5
        is_big_gap = median_gap > 0 and gap > median_gap * 1.8
        is_new_column = prev_bottom is not None and gap < 0  # jumped back up the page
        if current and (is_indent or is_big_gap or is_new_column):
            paragraphs.append(" ".join(current))
            current = []
        current.append(text)
        prev_bottom = y1
    if current:
        paragraphs.append(" ".join(current))
    return paragraphs


def _pdf_body_paragraphs(data: bytes, skip_pages: int = 0) -> List[str]:
    """A PDF's body text as real paragraphs (see _pdf_page_paragraphs),
    across every page after the first `skip_pages` -- used to drop a JSTOR
    cover sheet, which is metadata, not body text (see Reader._extract_pdf).
    """
    doc = fitz.open(stream=data, filetype="pdf")
    paragraphs = []
    for page in list(doc)[skip_pages:]:
        paragraphs.extend(_pdf_page_paragraphs(page))
    return paragraphs


def _clean_pdf_str(value) -> Optional[str]:
    """Collapse whitespace on a PDF string object; None if it's empty.

    pypdf hands back its own string types for `/Info` values, so this also
    coerces to `str` rather than assuming.
    """
    if value is None:
        return None
    v = " ".join(str(value).split())
    return v or None


def _with_orcids(names, catalogued: List[Dict]):
    """Attach ORCIDs to a cover sheet's byline where the catalogue agrees on a name.

    Strictly additive, and on an exact name match only. The byline stays as the
    document printed it -- what changes is that a name may now carry an id, which
    is the one thing name matching can never recover on its own. If the cover
    listed nobody, the catalogue's byline is used outright: there is nothing to
    contradict.
    """
    if not names:
        return catalogued
    orcids = {a.get("name"): a.get("orcid") for a in catalogued if a.get("orcid")}
    if not orcids:
        return names
    return [{"name": n, "orcid": orcids.get(n)} for n in names]


def _split_authors(line: str) -> List[str]:
    """Split a JSTOR `Author(s):` line into names.

    JSTOR writes bylines in natural order ("Amartya Sen"), separated by commas
    and/or "and". Comma-splitting would mangle a "Jr."-style suffix; that's a
    known rough edge, and the curator sees every scraped name as an author
    proposal before any of it reaches the graph.
    """
    parts = re.split(r"\s+and\s+|;\s*|,\s+", line)
    return [p for p in (_clean_pdf_str(x) for x in parts) if p]


def _jstor_date(source_line: str) -> Optional[str]:
    """Pull a publication date out of a JSTOR `Source:` line.

    "…, Vol. 82, No. 4 (Apr., 1985), pp. 169-221" -> "1985-04".

    Deliberately partial: the cover states a month and a year, so that is what
    gets recorded. Padding it to "1985-04-01" would invent a day that no one
    published on, and a date field is read as a fact.
    """
    year = re.search(r"\((?:[^)]*?)\b(1[5-9]\d{2}|20\d{2})\b[^)]*\)", source_line)
    if not year:
        return None
    inside = year.group(0)
    month = re.search(r"\b([A-Za-z]{3})[a-z]*\.?\b", inside)
    if month and month.group(1).lower() in _MONTHS:
        return f"{year.group(1)}-{_MONTHS[month.group(1).lower()]:02d}"
    return year.group(1)
