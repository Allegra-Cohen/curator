"""Pluggable article-metadata extraction.

Different sources expose metadata differently: academic journals use Highwire
``citation_*`` meta tags, modern news sites use JSON-LD, blogs use OpenGraph,
and a few need bespoke handling. Each strategy here is a small
``MetadataExtractor``. The ``ExtractorRegistry`` runs every applicable one in
priority order and merges their output field-by-field, so a higher-priority
extractor fills a field first and lower-priority ones only fill the gaps.

To support a new site:
  * If it uses citation tags / JSON-LD / OpenGraph, it likely already works.
  * Otherwise, write a ``MetadataExtractor`` subclass and register it (see
    ``SubstackExtractor`` for a minimal worked example).
"""

import json
from dataclasses import dataclass, field
from typing import List, Optional
from urllib.parse import urlparse

import trafilatura
from bs4 import BeautifulSoup


@dataclass
class Metadata:
    """Normalized article metadata. All fields optional; merged across extractors."""
    title: Optional[str] = None
    authors: List[str] = field(default_factory=list)
    date: Optional[str] = None          # publication date, normalized to YYYY-MM-DD(-ish)
    publication: Optional[str] = None   # journal or site name
    doi: Optional[str] = None


@dataclass
class PageContext:
    """Everything an extractor might need about a fetched page."""
    url: str
    html: str
    soup: BeautifulSoup


def normalize_date(value: Optional[str]) -> Optional[str]:
    """Best-effort date normalization: keep the date part, use '-' separators.

    '2025/12/11' -> '2025-12-11'; '2026-04-07T04:00:00+00:00' -> '2026-04-07'.
    """
    if not value:
        return None
    v = value.strip().split("T")[0].split(" ")[0].replace("/", "-")
    return v or None


def _clean(value: Optional[str]) -> Optional[str]:
    """Collapse internal whitespace and strip; return None if empty."""
    if not value:
        return None
    v = " ".join(value.split())
    return v or None


class MetadataExtractor:
    """Base class. Subclass, set ``priority``/``name``, and implement ``extract``."""
    name: str = "base"
    priority: int = 0

    def applies(self, ctx: PageContext) -> bool:
        """Cheap gate: should this extractor run on this page? Default: always."""
        return True

    def extract(self, ctx: PageContext) -> Metadata:
        raise NotImplementedError


class CitationMetaExtractor(MetadataExtractor):
    """Highwire Press ``citation_*`` meta tags — the academic-journal standard.

    Handles Frontiers, Springer, PubMed, arXiv, PLOS, IEEE, and most journals
    with no per-site code.
    """
    name = "citation"
    priority = 80

    def applies(self, ctx: PageContext) -> bool:
        return ctx.soup.find("meta", attrs={"name": "citation_title"}) is not None

    def extract(self, ctx: PageContext) -> Metadata:
        soup = ctx.soup

        def all_content(meta_name: str) -> List[str]:
            out = []
            for m in soup.find_all("meta", attrs={"name": meta_name}):
                c = _clean(m.get("content"))
                if c:
                    out.append(c)
            return out

        def first(meta_name: str) -> Optional[str]:
            vals = all_content(meta_name)
            return vals[0] if vals else None

        date = (first("citation_publication_date")
                or first("citation_online_date")
                or first("citation_cover_date")
                or first("citation_date"))

        return Metadata(
            title=first("citation_title"),
            authors=all_content("citation_author"),
            date=normalize_date(date),
            publication=first("citation_journal_title"),
            doi=first("citation_doi"),
        )


class JsonLdExtractor(MetadataExtractor):
    """schema.org JSON-LD (``application/ld+json``) — most modern news sites, incl. NYT."""
    name = "json-ld"
    priority = 60

    ARTICLE_TYPES = {
        "Article", "NewsArticle", "ScholarlyArticle",
        "BlogPosting", "Report", "TechArticle",
    }

    def applies(self, ctx: PageContext) -> bool:
        return ctx.soup.find("script", type="application/ld+json") is not None

    def extract(self, ctx: PageContext) -> Metadata:
        for obj in self._iter_objects(ctx.soup):
            if not isinstance(obj, dict):
                continue
            if self._is_article(obj):
                return self._from_object(obj)
        return Metadata()

    def _iter_objects(self, soup: BeautifulSoup):
        """Yield every dict object across all JSON-LD blocks, flattening @graph/lists."""
        for script in soup.find_all("script", type="application/ld+json"):
            raw = script.string or script.get_text()
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except (ValueError, TypeError):
                continue
            stack = [data]
            while stack:
                node = stack.pop()
                if isinstance(node, list):
                    stack.extend(node)
                elif isinstance(node, dict):
                    yield node
                    if isinstance(node.get("@graph"), list):
                        stack.extend(node["@graph"])

    def _is_article(self, obj: dict) -> bool:
        t = obj.get("@type")
        types = t if isinstance(t, list) else [t]
        return any(x in self.ARTICLE_TYPES for x in types)

    def _from_object(self, obj: dict) -> Metadata:
        publisher = obj.get("publisher")
        publication = None
        if isinstance(publisher, dict):
            publication = _clean(publisher.get("name"))
        elif isinstance(publisher, str):
            publication = _clean(publisher)

        return Metadata(
            title=_clean(obj.get("headline") or obj.get("name")),
            authors=self._names(obj.get("author")),
            date=normalize_date(obj.get("datePublished") or obj.get("dateCreated")),
            publication=publication,
        )

    def _names(self, author) -> List[str]:
        """author may be a str, dict, or list of either."""
        out = []
        if isinstance(author, list):
            for a in author:
                out.extend(self._names(a))
        elif isinstance(author, dict):
            n = _clean(author.get("name"))
            if n:
                out.append(n)
        elif isinstance(author, str):
            n = _clean(author)
            if n:
                out.append(n)
        return out


class OpenGraphExtractor(MetadataExtractor):
    """OpenGraph + basic ``<meta name=...>`` tags — broad, low-quality fallback."""
    name = "opengraph"
    priority = 40

    def extract(self, ctx: PageContext) -> Metadata:
        soup = ctx.soup

        def prop(p: str) -> Optional[str]:
            m = soup.find("meta", attrs={"property": p})
            return _clean(m.get("content")) if m else None

        def meta_name(n: str) -> Optional[str]:
            m = soup.find("meta", attrs={"name": n})
            return _clean(m.get("content")) if m else None

        # article:author is frequently a URL; prefer the plain author meta tag.
        author = meta_name("author") or meta_name("dc.creator")
        authors = [author] if author else []

        return Metadata(
            title=prop("og:title") or meta_name("twitter:title"),
            authors=authors,
            date=normalize_date(prop("article:published_time")
                                or meta_name("dc.date")
                                or meta_name("prism.publicationDate")),
            publication=prop("og:site_name"),
        )


class HtmlFallbackExtractor(MetadataExtractor):
    """Last resort: trafilatura's byline/title parsing plus the <title> tag."""
    name = "html-fallback"
    priority = 20

    def extract(self, ctx: PageContext) -> Metadata:
        meta = trafilatura.extract_metadata(ctx.html)
        authors = _split_authors(meta.author) if (meta and meta.author) else []
        title = None
        if meta and meta.title:
            title = _clean(meta.title)
        elif ctx.soup.title:
            title = _clean(ctx.soup.title.get_text())
        return Metadata(
            title=title,
            authors=authors,
            date=normalize_date(meta.date) if meta else None,
            publication=_clean(meta.sitename) if (meta and meta.sitename) else None,
        )


class SubstackExtractor(MetadataExtractor):
    """Worked example of a site-specific extractor.

    Substack's JSON-LD only names the *publication* as author; the individual
    human bylines live in the page body, which trafilatura reads well. We grab
    just the authors here and let the generic extractors handle the rest.
    """
    name = "substack"
    priority = 100

    def applies(self, ctx: PageContext) -> bool:
        host = (urlparse(ctx.url).hostname or "").lower()
        return host == "substack.com" or host.endswith(".substack.com")

    def extract(self, ctx: PageContext) -> Metadata:
        meta = trafilatura.extract_metadata(ctx.html)
        authors = _split_authors(meta.author) if (meta and meta.author) else []
        return Metadata(authors=_undo_truncation(authors, _declared_names(ctx)))


def _split_authors(value: Optional[str]) -> List[str]:
    """trafilatura joins multiple authors with ';'."""
    if not value:
        return []
    return [a for a in (_clean(part) for part in value.split(";")) if a]


def _declared_names(ctx: PageContext) -> List[str]:
    """Author names the page states outright, in its own words.

    Only `<meta name="author">` and `dc.creator` -- the two places a name appears as
    a plain string the publisher wrote, rather than as something parsed out of the
    body. That difference is the whole basis for preferring them below.
    """
    out = []
    for key in ("author", "dc.creator"):
        tag = ctx.soup.find("meta", attrs={"name": key})
        name = _clean(tag.get("content")) if tag else None
        if name:
            out.append(name)
    return out


def _undo_truncation(names: List[str], declared: List[str]) -> List[str]:
    """Restore a derived name that a parse cut short, using the page's own string.

    trafilatura reads bylines out of the page body, which is the only way to get the
    *human* who wrote a Substack post -- its JSON-LD credits the publication. But it
    assumes an author is a person, and truncates accordingly: the Center for Humane
    Technology's posts come back as `Center; Julie Guirado`, losing three words of an
    organization's actual name. The page declares the full string in
    `<meta name="author">`, and this extractor's priority (100) meant the truncation
    won anyway, because `_merge_fill` only fills fields that are still empty.

    The rule is narrow on purpose: a declared name replaces a derived one only when
    the derived one is a **whole-word prefix** of it. That's the shape a truncation
    has, and it can't turn one author into a different author -- "Julie Guirado" is
    not a prefix of anything the page declared, so it survives untouched. Anything
    less conservative would be guessing, which is what this whole area is trying to
    stop doing.
    """
    if not declared:
        return names
    out = []
    for name in names:
        full = next((d for d in declared
                     if d.lower() != name.lower()
                     and d.lower().startswith(name.lower() + " ")), None)
        out.append(full or name)
    return out


class ExtractorRegistry:
    """Runs extractors in priority order and merges their results field-by-field."""

    def __init__(self, extractors: Optional[List[MetadataExtractor]] = None):
        self.extractors: List[MetadataExtractor] = []
        for e in (extractors or []):
            self.register(e)

    def register(self, extractor: MetadataExtractor) -> None:
        self.extractors.append(extractor)
        self.extractors.sort(key=lambda e: e.priority, reverse=True)

    def extract(self, url: str, html: str) -> Metadata:
        ctx = PageContext(url=url, html=html, soup=BeautifulSoup(html, "lxml"))
        result = Metadata()
        for e in self.extractors:
            try:
                if not e.applies(ctx):
                    continue
                _merge_fill(result, e.extract(ctx))
            except Exception as ex:  # a broken extractor must not sink the page
                print(f"[extractor:{e.name}] failed on {url}: {ex}")
        return result


def _merge_fill(base: Metadata, extra: Metadata) -> None:
    """Fill only fields still empty in ``base`` from ``extra`` (in place)."""
    if not base.title and extra.title:
        base.title = extra.title
    if not base.authors and extra.authors:
        base.authors = extra.authors
    if not base.date and extra.date:
        base.date = extra.date
    if not base.publication and extra.publication:
        base.publication = extra.publication
    if not base.doi and extra.doi:
        base.doi = extra.doi


def default_registry() -> ExtractorRegistry:
    """The standard stack: site-specific first, generic strategies after."""
    return ExtractorRegistry([
        SubstackExtractor(),
        CitationMetaExtractor(),
        JsonLdExtractor(),
        OpenGraphExtractor(),
        HtmlFallbackExtractor(),
    ])
