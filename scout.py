"""Scout: discovery pipeline that searches APIs for candidate documents.

Orchestrates the discover funnel:
  searchterms → API search → dedup/tombstone check → candidates list

SourceAdapters search a specific API (OpenAlex, arXiv) and return candidates.
Scout fans out to all adapters, merges results, and filters by duplicate + tombstone.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Protocol, Tuple
from datetime import datetime
import requests
import time
import re


class SearchFailed(Exception):
    """An adapter couldn't complete a search (timeout, rate limit, bad response).

    Distinct from "searched fine, found nothing": an empty result list is a real
    answer about the literature, whereas this means we don't know. Scout records
    these per run so a degraded run can say so instead of quietly under-reporting.
    """


class QueryNormalizer:
    """Parse and convert user queries to API-specific formats.

    User queries use: phrases, AND/OR/NOT operators, + (as AND), parentheses.
    Converts to arXiv format (ti:"phrase" OR abs:"phrase") or OpenAlex format.
    """

    @staticmethod
    def split_alternatives(query: str) -> List[str]:
        """Split a comma-separated list into independent alternative queries.

        Curators write keywords as a list -- "AI AND literacy, LLMs AND reading" --
        meaning "any of these", which is how you'd write it anywhere else. Without
        this the comma is just another character: the tokenizer glues it onto the
        adjacent term (`ti:comprehension,`, a literal comma in the search) and the
        segments get ANDed into one query demanding every term from every phrase at
        once. That silently returns a handful of results where the individual
        queries return many.

        Commas inside quotes are left alone -- those are part of a phrase.
        """
        parts, buf, in_quotes = [], [], False
        for ch in query:
            if ch == '"':
                in_quotes = not in_quotes
            if ch == ',' and not in_quotes:
                parts.append(''.join(buf))
                buf = []
            else:
                buf.append(ch)
        parts.append(''.join(buf))
        return [p.strip() for p in parts if p.strip()]

    @staticmethod
    def normalize(query: str) -> str:
        """Normalize user input: replace + with AND, handle edge cases."""
        # Replace + with AND (e.g., "expertise erosion + GenAI" -> "expertise erosion AND GenAI")
        query = re.sub(r'\s*\+\s*', ' AND ', query)
        # Normalize whitespace around operators
        query = re.sub(r'\s+(AND|OR|NOT|ANDNOT)\s+', r' \1 ', query, flags=re.IGNORECASE)
        # Uppercase operators
        query = re.sub(r'\b(and|or|not|andnot)\b', lambda m: m.group(0).upper(), query)
        return query.strip()

    @staticmethod
    def _tokenize(query: str) -> List[str]:
        """Tokenize query into tokens and operators/parens.

        Splits on AND, OR, NOT, ANDNOT (case-insensitive) and parentheses,
        keeping operators and parens as separate tokens.
        Phrases with multiple words stay together as one token.
        """
        # Split on operators/parens, keeping them and everything else
        # Regex: quoted strings, parens, operators, or words (excluding parens/spaces)
        pattern = r'"[^"]*"|\(|\)|(?:AND|OR|ANDNOT|NOT)\b|[^()\s]+'
        raw_tokens = re.findall(pattern, query, re.IGNORECASE)

        # Recombine adjacent non-operator words into phrases
        result = []
        phrase_parts = []

        for token in raw_tokens:
            token_upper = token.upper()
            if token in ('(', ')'):
                # Flush phrase and add paren
                if phrase_parts:
                    phrase = ' '.join(phrase_parts)
                    result.append(phrase)
                    phrase_parts = []
                result.append(token)
            elif token_upper in ('AND', 'OR', 'NOT', 'ANDNOT'):
                # Flush phrase and add operator
                if phrase_parts:
                    phrase = ' '.join(phrase_parts)
                    result.append(phrase)
                    phrase_parts = []
                result.append(token_upper)
            elif token.startswith('"'):
                # Quoted phrase: flush any pending words, then add quote
                if phrase_parts:
                    phrase = ' '.join(phrase_parts)
                    result.append(phrase)
                    phrase_parts = []
                result.append(token)
            else:
                # Regular word: accumulate
                phrase_parts.append(token)

        # Flush remaining phrase parts
        if phrase_parts:
            phrase = ' '.join(phrase_parts)
            result.append(phrase)

        return result

    @staticmethod
    def _is_operator(token: str) -> bool:
        """Check if token is a boolean operator."""
        return token.upper() in ('AND', 'OR', 'NOT', 'ANDNOT')

    @staticmethod
    def to_arxiv(query: str) -> str:
        """Convert a user query to arXiv format.

        Multi-word phrases are split into individual terms joined by AND:
          "cognitive sovereignty" -> (ti:cognitive AND ti:sovereignty) OR (abs:cognitive AND abs:sovereignty)

        This matches arXiv's default AND behavior and catches papers with those words
        in any order, not just as a phrase.

        A comma-separated list is a set of ALTERNATIVES: each segment is converted
        independently, parenthesised, and OR-ed together. Parenthesising matters --
        `a AND b OR c AND d` binds in ways the curator didn't write.
        """
        alternatives = QueryNormalizer.split_alternatives(query)
        if len(alternatives) > 1:
            clauses = [QueryNormalizer._to_arxiv_one(a) for a in alternatives]
            return ' OR '.join(f'({c})' for c in clauses if c)
        return QueryNormalizer._to_arxiv_one(query)

    @staticmethod
    def _to_arxiv_one(query: str) -> str:
        """Convert a single (comma-free) query expression."""
        normalized = QueryNormalizer.normalize(query)
        tokens = QueryNormalizer._tokenize(normalized)

        output = []
        for token in tokens:
            if token in '()':
                output.append(token)
            elif QueryNormalizer._is_operator(token):
                # arXiv uses ANDNOT instead of NOT
                if token.upper() == 'NOT':
                    output.append('ANDNOT')
                else:
                    output.append(token)
            elif token.startswith('"') and token.endswith('"'):
                # Quoted phrase: split into words and join with AND
                phrase_content = token[1:-1]  # remove quotes
                words = phrase_content.split()
                if len(words) == 1:
                    # Single word, just add it
                    output.append(f'(ti:{words[0]} OR abs:{words[0]})')
                else:
                    # Multiple words: (ti:word1 AND ti:word2...) OR (abs:word1 AND abs:word2...)
                    ti_clause = ' AND '.join(f'ti:{w}' for w in words)
                    abs_clause = ' AND '.join(f'abs:{w}' for w in words)
                    output.append(f'(({ti_clause}) OR ({abs_clause}))')
            else:
                # Unquoted phrase (from tokenizer): split into words and AND them
                words = token.split()
                if len(words) == 1:
                    output.append(f'(ti:{token} OR abs:{token})')
                else:
                    ti_clause = ' AND '.join(f'ti:{w}' for w in words)
                    abs_clause = ' AND '.join(f'abs:{w}' for w in words)
                    output.append(f'(({ti_clause}) OR ({abs_clause}))')

        result = ' '.join(output)
        return result

    # Note: OpenAlex no longer uses boolean keyword search here. Concepts feed
    # their prose `description` straight into OpenAlex's semantic (vector) search,
    # so there is no OpenAlex-specific normalizer -- see OpenAlexAdapter.


@dataclass
class SearchItem:
    """One unit of work in a run. Usually a concept; sometimes a source to poll.

    Different adapters want different inputs, so an item carries every shape:
      * `keywords`       -- a boolean expression for keyword adapters (arXiv)
      * `semantic_query` -- rich natural-language prose for semantic adapters
                            (OpenAlex). A concept's reader-facing `description` is a
                            separate field and never arrives here; see ConceptAttrs.
      * `source_url`     -- a feed or index page to enumerate, for adapters that
                            take no query at all

    The first two come from a concept; the third comes from a source. That's the
    only difference between them: arXiv and OpenAlex are sources that *require a
    subject* (the concept supplies the query), while a feed is a source that *takes
    no subject* and enumerates instead.

    `name` is the human-readable label recorded as provenance on every candidate
    this item surfaces (Candidate.matched_terms). An empty field means "skip this
    adapter for this item" (e.g. no keywords -> don't hit arXiv).

    `is_polled` matters downstream: a feed item has no concept behind it, so nothing
    proposes a concept for what it finds, and the relevance filter screens it on the
    guide scope alone rather than against a concept query that doesn't exist.
    """
    name: str
    keywords: str = ""
    semantic_query: str = ""
    source_url: str = ""
    # Which enumerative adapter can read this source: "rss" or "page". Routing on
    # it matters because both adapters answer to `query_kind == "enumerative"`, so
    # without it every page source would also be handed to FeedAdapter, fail to
    # parse, and be recorded as a broken feed.
    mechanism: str = "rss"

    @property
    def is_polled(self) -> bool:
        return bool(self.source_url)


@dataclass
class ScrapedAuthor:
    """An author name as an adapter found it, with an ORCID when the API supplied one.

    OpenAlex attaches an ORCID to most authorships and it used to be discarded here,
    because this was a bare `str`. The id is worth carrying: it identifies a person
    across the name variants they publish under, which is precisely what matching on
    the name string cannot do.

    `orcid` is stored **exactly as the API gave it** -- usually the full
    `https://orcid.org/...` URL. Scout does not normalize it, because scout knows
    nothing about the graph; `graph.types.normalize_orcid` is the single place either
    shape is reduced, at the boundary where ORCIDs actually enter the guide.

    Adapters with no ORCIDs to give (arXiv, RSS, page scraping) leave it None. That
    is an absence of data, not an absence of identity.
    """
    name: str
    orcid: Optional[str] = None


@dataclass
class Candidate:
    """A document discovered via API search."""
    url: str
    title: str
    authors: List[ScrapedAuthor]
    publication: Optional[str]
    date: Optional[str]  # ISO YYYY-MM-DD or similar
    abstract: Optional[str] = None
    doi: Optional[str] = None
    source: str = ""  # which adapter found it
    matched_terms: List[str] = None  # names of the search items that found this doc
    relevance_score: Optional[float] = None  # OpenAlex semantic cosine similarity
    via_semantic: bool = False  # True if any adapter that found it used semantic search
    # True if a followed source turned this up rather than a concept's query. Such a
    # candidate has NO concept behind it, so there's nothing to judge it "about" --
    # the relevance filter screens it on the guide scope alone. Kept distinct from an
    # empty `matched_terms` because the two mean different things: this one was never
    # asked a concept question, rather than asked and found wanting.
    via_polled: bool = False
    # A legitimately-free copy of the full text, when one exists (publisher- or
    # repository-hosted, per OpenAlex). This is a *link-out* for the curator, not a
    # paywall bypass -- OpenAlex indexes where free copies live, it hosts nothing.
    oa_pdf_url: Optional[str] = None
    # What KIND of venue published this -- see `venue_tier`. None means the adapter
    # can't tell (a feed post, a scraped page); that is a third state, not "bad",
    # and the queue orders it between the two rather than at the bottom.
    venue_tier: Optional[str] = None
    # How many works this one cites, per OpenAlex. Zero on a paper that claims to be
    # research is worth seeing -- it is shown on the queue card as a flag, never
    # used to drop anything (5 of 20 journal articles measure zero, mostly older
    # records whose publisher never deposited references).
    reference_count: Optional[int] = None

    def __post_init__(self):
        if self.matched_terms is None:
            self.matched_terms = []


# --------------------------------------------------------------------------
# Venue tiers -- what kind of place published a candidate.
#
# The guide is quality-before-comprehensiveness, and the cheapest honest signal of
# quality is where the author chose to submit the work. Deliberately a statement
# about the VENUE, never about the author: affiliation and author count both
# separate the sludge from the journals in the data, and both were rejected --
# affiliation because it is collinear with venue (a deposit form has no affiliation
# field, so it measures metadata completeness) and would add bias for no
# information, author count because 6 of 20 journal articles in the same sample are
# single-authored, philosophy being a single-author discipline. See
# quality_signals.md for the measurements.
#
# A tier orders the queue; it does not decide anything. The one exclusion is
# EXCLUDED_SOURCES below, and the real quality judgement stays with the LLM screen
# (which reads the abstract) and the curator.
TIER_JOURNAL = "journal"      # peer-reviewed, in a recognized (CWTS core) venue
TIER_PREPRINT = "preprint"    # arXiv, SSRN, OSF, PhilPapers, Preprints.org
TIER_UNKNOWN = None           # a feed post, a scraped page: no venue to judge.
                              # Never assigned to a paper -- see `venue_tier`.

# Deposit repositories that accept anything, with no review and no moderation.
# Excluded at the API rather than screened later: on a `cognitive sovereignty` run
# they took 35 of the 50 result slots (15 of those to duplicate records of the same
# deposit), and OpenAlex's semantic retrieval is approximate, so that mass was
# crowding better-scoring papers out of the candidate pool entirely -- excluding
# them RAISED the top score from 0.8945 to 0.9312.
#
# arXiv, SSRN, OSF, PhilPapers and Preprints.org deliberately stay: preprints are
# in scope for a guide about a literature that moves faster than journal
# acceptance, and they arrive as TIER_PREPRINT, ranked below the journals.
EXCLUDED_SOURCES = {
    "S4306400562": "Zenodo",
    "S4377196282": "Figshare",
}


def venue_tier(work: dict) -> str:
    """Which tier an OpenAlex work belongs to, from its own payload.

    `is_core` (CWTS Leiden's core-source flag) rides on `primary_location.source`,
    so this costs no extra request. A journal that isn't core is not treated as
    peer-reviewed here -- in the measured sample the only two non-core journals
    were the two that read as filler.

    A preprint that has since appeared in a journal is promoted on that basis: the
    work is the same work, and the journal location is the evidence it cleared
    review.

    Never returns TIER_UNKNOWN. Every OpenAlex work is a paper somebody submitted
    somewhere, so the honest floor is "preprint" -- including the ~10% that carry no
    source at all, which are if anything *less* vouched-for than a named preprint
    server. TIER_UNKNOWN is for candidates that never reach this function: a feed
    post or a hand-added page, where there is no venue to judge in the first place.
    """
    source = (work.get("primary_location") or {}).get("source") or {}
    if source.get("type") in ("journal", "conference") and source.get("is_core"):
        return TIER_JOURNAL
    # Published elsewhere since being deposited -- the strongest promotion signal
    # available, and it costs nothing: `locations` is already in the payload.
    for loc in (work.get("locations") or []):
        other = loc.get("source") or {}
        if other.get("type") in ("journal", "conference") and other.get("is_core"):
            return TIER_JOURNAL
    return TIER_PREPRINT


class SourceAdapter(Protocol):
    """Interface for API search adapters."""
    name: str
    # Which field of a SearchItem this adapter reads:
    #   "boolean"     -> .keywords    (arXiv)
    #   "semantic"    -> .semantic_query (OpenAlex)
    #   "enumerative" -> .source_url    (a feed or page) -- not a query at all; it
    #                                  lists what the source published and lets the
    #                                  gates downstream do the narrowing.
    query_kind: str

    def search(self, query: str) -> List[Candidate]:
        """Search the API for documents matching the query.
        Returns a list of Candidates (may include duplicates across adapters).
        """
        ...


class OpenAlexAdapter:
    """Search via OpenAlex semantic (vector) search.

    Docs: https://developers.openalex.org/guides/semantic-search
    OpenAlex embeds works (GTE-Large) and ranks by cosine similarity to the query,
    so we feed a concept's prose `description` -- the richer the input, the better
    the match. Notes on the semantic endpoint:
      * param is `search.semantic`; only one search param is allowed per request,
        so this fully replaces the old boolean `search=` path.
      * it requires an API key and is billed (~$0.001/query); with no key we skip.
      * capped at 50 results; each carries a `relevance_score`.
      * the year cutoff is pushed to the API via `publication_year` (the only date
        filter semantic search supports -- `from_publication_date` is rejected),
        so it doesn't eat into the 50-result budget.
      * the endpoint returns transient 5xx (esp. 504) fairly often, so we retry.
    """
    name = "openAlex"
    query_kind = "semantic"
    base_url = "https://api.openalex.org/works"

    @staticmethod
    def _abstract_from_index(inverted: Optional[dict]) -> Optional[str]:
        """Rebuild an abstract from OpenAlex's `abstract_inverted_index`.

        OpenAlex stores abstracts as {word: [positions]} rather than plain text (a
        copyright workaround). Abstracts are open metadata, so this arrives for
        paywalled works too -- which is exactly why we keep it: for a closed paper
        the abstract is the only thing a curator can review it on.
        """
        if not inverted:
            return None
        positions = [(pos, word) for word, spots in inverted.items() for pos in spots]
        if not positions:
            return None
        positions.sort()
        return " ".join(word for _pos, word in positions)

    def __init__(self, timeout: float = 10.0, api_key: Optional[str] = None,
                 from_year: int = 2023, min_relevance: float = 0.85,
                 guide_scope: Optional[str] = None):
        self.timeout = timeout
        self.api_key = api_key  # Required for semantic search; no key -> adapter is a no-op
        self.from_year = from_year
        # Semantic search always returns a full page regardless of match quality,
        # so drop anything below this cosine floor. ~0.85 keeps on-topic hits.
        self.min_relevance = min_relevance
        # The guide's scope statement, appended to every query as context.
        #
        # Without it the query is the concept description alone, which need not
        # mention what the guide is actually about: "Reading, attention, and
        # comprehension in a post-literate age" has no AI in it, so semantic search
        # correctly returned reading-psychology papers that the guide doesn't want.
        # The keyword path gets scope via the relevance filter; this is how the
        # semantic path gets it, so both sources answer to the same statement.
        self.guide_scope = guide_scope

    def _compose(self, description: str) -> str:
        """Concept description first, scope after, as trailing context.

        Order is deliberate: the description is the query and the scope only tilts
        it, so the description leads. Truncated to the 2,000 characters OpenAlex
        matches on -- and the description is protected from that truncation, since
        losing the actual query to boilerplate would be worse than losing context.
        """
        LIMIT = 2000
        desc = (description or "").strip()
        if not self.guide_scope:
            return desc[:LIMIT]
        scope = self.guide_scope.strip()
        room = LIMIT - len(desc) - len("\n\nContext — this guide covers: ")
        if room <= 0:
            return desc[:LIMIT]
        return f"{desc}\n\nContext — this guide covers: {scope[:room]}"

    def search(self, query: str) -> List[Candidate]:
        """Semantic-search OpenAlex for `query` (a concept description), from_year+.

        Errors are caught silently -- arXiv is the fallback and OpenAlex is a bonus.
        Retries transient 5xx/429 responses with backoff before giving up.
        """
        candidates = []
        if not self.api_key:
            return candidates  # semantic search needs a key; nothing to do without one
        params = {
            "search.semantic": self._compose(query),
            # publication_year:>N means "N+1 and later", so subtract 1 for an inclusive floor.
            "filter": ",".join([
                f"publication_year:>{self.from_year - 1}",
                # Excluded HERE rather than after the fetch: the 50-result cap is the
                # binding constraint, so a deposit dropped later has still cost a slot.
                *(f"primary_location.source.id:!{sid}" for sid in EXCLUDED_SOURCES),
            ]),
            "per_page": 50,  # semantic search caps here anyway
            "api_key": self.api_key,
        }
        max_retries = 2
        try:
            data = None
            for attempt in range(max_retries + 1):
                resp = requests.get(self.base_url, params=params, timeout=self.timeout)
                if resp.status_code == 200:
                    data = resp.json()
                    break
                # 429 (rate limit) and 5xx (incl. the frequent 504) are worth a retry.
                if resp.status_code in (429, 500, 502, 503, 504) and attempt < max_retries:
                    time.sleep(2 ** attempt)  # 1s, 2s
                    continue
                # Out of retries, or a non-retryable status (e.g. a 400 from a bad
                # filter). Either way we don't know what's out there -- say so
                # rather than returning [] as if the search came back empty.
                raise SearchFailed(f"{self.name}: HTTP {resp.status_code}")
            if data is None:
                raise SearchFailed(f"{self.name}: no response after retries")

            for work in data.get("results", []):
                score = work.get("relevance_score")
                if score is not None and score < self.min_relevance:
                    continue  # below the semantic floor; skip the long tail

                url = work.get("doi") or work.get("id", "")
                if not url:
                    continue

                title = work.get("title", "")
                # The one adapter that has ORCIDs. They ride along on the authorship,
                # not the work, and an author without one is normal -- coverage is
                # good, not total.
                authors = []
                for a in work.get("authorships", []):
                    person = a.get("author") or {}
                    name = (person.get("display_name") or "").strip()
                    if name:
                        authors.append(ScrapedAuthor(name=name,
                                                     orcid=person.get("orcid")))

                pub_date = work.get("publication_date") or ""
                pub_date_short = pub_date[:10] if len(pub_date) >= 10 else None

                # Current OpenAlex shape: the venue lives on primary_location.source.
                source_obj = (work.get("primary_location") or {}).get("source") or {}
                publication = source_obj.get("display_name")

                # A free full-text PDF when one exists. We deliberately don't take
                # `landing_page_url` -- it equals the DOI ~96% of the time, so it's
                # redundant with canonical_url and buys the viewer nothing.
                best_oa = work.get("best_oa_location") or {}

                candidates.append(Candidate(
                    url=url,
                    title=title,
                    authors=authors,
                    publication=publication,
                    date=pub_date_short,
                    abstract=self._abstract_from_index(
                        work.get("abstract_inverted_index")),
                    doi=work.get("doi"),
                    source=self.name,
                    relevance_score=work.get("relevance_score"),
                    oa_pdf_url=best_oa.get("pdf_url"),
                    venue_tier=venue_tier(work),
                    reference_count=work.get("referenced_works_count"),
                ))
        except requests.exceptions.RequestException as e:
            raise SearchFailed(f"{self.name}: {type(e).__name__}: {e}")

        return candidates


class ArXivAdapter:
    """Search via arXiv API (free, no auth required).

    Docs: https://info.arxiv.org/help/api/user-manual.html
    Note: arXiv is rate-limited; requests that get 429 are retried with backoff.
    """
    name = "arXiv"
    query_kind = "boolean"
    base_url = "http://export.arxiv.org/api/query"

    def __init__(self, timeout: float = 10.0):
        self.timeout = timeout

    def search(self, query: str) -> List[Candidate]:
        """Search arXiv by keyword, returns top 100 results.

        Retries on 429 (rate limit) and transport errors with exponential backoff.
        Raises `SearchFailed` once retries are exhausted rather than returning an
        empty list: a silent [] is indistinguishable from "nothing matched", which
        would let a throttled run report a small corpus as if it were the truth.
        """
        candidates = []
        max_retries = 2
        last_error: Optional[str] = None

        for attempt in range(max_retries + 1):
            try:
                # Convert user query to arXiv format
                search_query = QueryNormalizer.to_arxiv(query)
                params = {
                    "search_query": search_query,
                    "start": 0,
                    "max_results": 100,
                    "sortBy": "submittedDate",
                    "sortOrder": "descending",
                }
                resp = requests.get(self.base_url, params=params, timeout=self.timeout)

                # Handle rate limit with backoff
                if resp.status_code == 429:
                    last_error = "rate limited (429)"
                    if attempt < max_retries:
                        backoff = 2 ** attempt  # 1s, 2s
                        time.sleep(backoff)
                        continue
                    raise SearchFailed(f"{self.name}: {last_error}")

                resp.raise_for_status()
                # arXiv returns Atom XML; parse manually for simplicity
                content = resp.text
                last_error = None

                import xml.etree.ElementTree as ET
                root = ET.fromstring(content)
                ns = {"atom": "http://www.w3.org/2005/Atom"}

                for entry in root.findall("atom:entry", ns):
                    # Check publication date (in arXiv, the published date is the submission)
                    pub_elem = entry.find("atom:published", ns)
                    pub_date = pub_elem.text if pub_elem is not None else None
                    if pub_date and len(pub_date) >= 10:
                        pub_date = pub_date[:10]
                    # Filter to 2023+ only
                    if pub_date and pub_date < "2023-01-01":
                        continue

                    # arXiv URL is stable from the ID
                    id_elem = entry.find("atom:id", ns)
                    arxiv_id = id_elem.text.split("arxiv.org/abs/")[-1] if id_elem is not None else ""
                    url = f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else ""
                    if not url:
                        continue

                    title_elem = entry.find("atom:title", ns)
                    title = title_elem.text.replace("\n", " ").strip() if title_elem is not None else ""

                    # arXiv's Atom feed carries names only -- no ORCIDs to take.
                    authors = []
                    for author_elem in entry.findall("atom:author", ns):
                        name_elem = author_elem.find("atom:name", ns)
                        if name_elem is not None and name_elem.text:
                            authors.append(ScrapedAuthor(name=name_elem.text))

                    summary_elem = entry.find("atom:summary", ns)
                    abstract = summary_elem.text.replace("\n", " ").strip() if summary_elem is not None else None

                    candidates.append(Candidate(
                        url=url,
                        title=title,
                        authors=authors,
                        publication="arXiv",
                        date=pub_date,
                        abstract=abstract,
                        source=self.name,
                        # arXiv is a preprint server: no peer review, only moderation
                        # and an endorsement requirement. If OpenAlex also turns this
                        # paper up as published, `_merge_into` promotes it.
                        venue_tier=TIER_PREPRINT,
                    ))
                return candidates  # success
            except SearchFailed:
                raise                       # already final; don't retry it as a transport error
            except Exception as e:
                # Timeouts and transport errors are worth another go; a parse error
                # won't fix itself but costs little to retry.
                last_error = f"{type(e).__name__}: {e}"
                candidates = []             # a partial parse must not leak into the retry
                if attempt < max_retries:
                    time.sleep(2 ** attempt)
                    continue
                raise SearchFailed(f"{self.name}: {last_error}")

        raise SearchFailed(f"{self.name}: {last_error or 'unknown error'}")


class FeedAdapter:
    """Read an RSS/Atom feed: org blogs, lab news pages, Substacks.

    The third `query_kind`. arXiv and OpenAlex answer a *query* the curator implied
    by describing a concept; a feed answers no query at all -- it just says what was
    published. So the "query" handed to `search()` is the feed url itself, and all
    the narrowing happens downstream at the gates, which is the point: a feed is a
    source of SearchItems exactly like OpenAlex, and gives up none of them.

    Deliberately no date window. Correctness never depends on one -- tombstones drop
    suppressed urls before the paid filter and `submit_document` is idempotent on url
    -- so a wide window costs money, not correctness. And RSS already bounds the
    cost: most feeds serve only their last ~20 entries. A `since` watermark is worth
    building when a real feed proves expensive, not before.
    """
    name = "feed"
    query_kind = "enumerative"
    mechanism = "rss"

    def __init__(self, timeout: float = 10.0, max_entries: int = 50):
        self.timeout = timeout
        self.max_entries = max_entries

    @staticmethod
    def _authors(entry) -> List[ScrapedAuthor]:
        """Feed author fields are a mess: `author`, `authors`, `dc:creator`, any of
        them absent. Take what's there and let the curator fix the rest. Feeds carry
        no ORCIDs, so every one of these is name-only."""
        names = []
        for a in (entry.get("authors") or []):
            name = (a.get("name") or "").strip() if isinstance(a, dict) else str(a).strip()
            if name:
                names.append(name)
        if not names and entry.get("author"):
            names = [str(entry["author"]).strip()]
        seen, out = set(), []
        for n in names:
            if n and n not in seen:
                seen.add(n)
                out.append(ScrapedAuthor(name=n))
        return out

    @staticmethod
    def _date(entry) -> Optional[str]:
        parsed = entry.get("published_parsed") or entry.get("updated_parsed")
        if not parsed:
            return None
        try:
            return datetime(*parsed[:6]).strftime("%Y-%m-%d")
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _summary(entry) -> Optional[str]:
        """A post's own summary stands in for an abstract.

        It's what makes review possible before anyone fetches the page, exactly as an
        API abstract does for a paywalled paper. Feeds often carry the whole post
        here, so it's truncated -- the filter reads the first 600 chars anyway.
        """
        text = entry.get("summary") or ""
        if not text and entry.get("content"):
            content = entry["content"]
            text = content[0].get("value", "") if content else ""
        text = re.sub(r"<[^>]+>", " ", text)          # feeds carry HTML bodies
        text = re.sub(r"&[a-z]+;", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:2000] or None

    def search(self, query: str) -> List[Candidate]:
        """Fetch and parse the feed at `query` (a url). Raises `SearchFailed` on a
        dead or unparseable feed.

        A dead feed must never read as "this source published nothing" -- feeds rot
        (404s, moves, format changes), and a silently dead one looks exactly like a
        quiet one. That's the same contract the API adapters hold.
        """
        import feedparser

        try:
            resp = requests.get(query, timeout=self.timeout,
                                headers={"User-Agent": "field-guide-scout/0.1"})
        except requests.exceptions.RequestException as e:
            raise SearchFailed(f"{self.name}: {query}: {type(e).__name__}: {e}")
        if resp.status_code != 200:
            raise SearchFailed(f"{self.name}: {query}: HTTP {resp.status_code}")

        parsed = feedparser.parse(resp.content)
        # Two ways this isn't a usable feed, and both must raise rather than return
        # []. An empty *valid* feed is a real answer ("nothing published lately"); a
        # page that was never a feed is not, and returning [] would let a mistyped
        # url -- a homepage instead of /feed -- sit in the source list looking quiet.
        if not parsed.entries:
            if parsed.bozo:
                raise SearchFailed(f"{self.name}: {query}: unparseable feed "
                                   f"({parsed.get('bozo_exception')})")
            if not parsed.get("version"):
                raise SearchFailed(f"{self.name}: {query}: not a feed "
                                   f"(no RSS/Atom structure found)")

        publication = (parsed.feed.get("title") or "").strip() or None
        candidates = []
        for entry in parsed.entries[:self.max_entries]:
            url = (entry.get("link") or "").strip()
            title = (entry.get("title") or "").strip()
            if not url or not title:
                continue    # an entry we can't fetch or name is no use to a curator
            candidates.append(Candidate(
                url=url,
                title=title,
                authors=self._authors(entry),
                publication=publication,
                date=self._date(entry),
                abstract=self._summary(entry),
                source=self.name,
            ))
        return candidates


class PageAdapter:
    """Read an index page that has no feed: a lab's publications list, a personal
    site's writing section.

    The last resort, and only worth reaching for when tiers 1 and 2 fail -- a feed
    hands over titles, dates and summaries as structured data, while this recovers a
    list of urls and nothing else. Everything after that is the normal path: Reader
    fetches each new url for its metadata, then the scope and concept screens run
    exactly as they do for a Substack post.

    Two collaborators are injected rather than built here, because Scout must stay
    graph-agnostic and both of these reach outside it:

      * `classify(page_url, links) -> {url: {is_article, reason}}` -- the judgement
        about which links are articles.
      * `known` -- verdicts already recorded for this page, so the classifier is
        only asked about links nobody has judged yet.

    With no classifier injected this adapter extracts nothing. That is deliberate:
    the alternative is treating every link as an article and ingesting a site's
    navigation as documents.
    """
    name = "page"
    query_kind = "enumerative"
    mechanism = "page"

    # A cap, like FeedAdapter's. Each *new* url costs a Reader fetch, so an index
    # page far larger than expected should stop and say so rather than quietly
    # hammering someone's server on its first poll.
    MAX_NEW = 60

    def __init__(self, timeout: float = 15.0, classify=None,
                 known: Optional[Dict[str, bool]] = None):
        self.timeout = timeout
        self.classify = classify
        self.known = known or {}
        # Filled in per call, for the caller to persist and to report.
        self.new_verdicts: Dict[str, dict] = {}
        self.overflowed = 0

    @staticmethod
    def _links(page_url: str, html: bytes) -> List[Tuple[str, str]]:
        """Every on-page link with visible text, absolute and de-duplicated.

        Fragments are stripped and same-page anchors dropped: `#main-content` is
        never a publication, and keeping the fragment would let one article appear
        under several urls.
        """
        from bs4 import BeautifulSoup
        from urllib.parse import urldefrag, urljoin

        soup = BeautifulSoup(html, "html.parser")
        seen: Dict[str, str] = {}
        for a in soup.find_all("a", href=True):
            url, _frag = urldefrag(urljoin(page_url, a["href"]))
            text = " ".join(a.get_text(" ", strip=True).split())
            if not url.startswith("http") or not text:
                continue
            if url.rstrip("/") == page_url.rstrip("/"):
                continue                      # a link back to this page
            # Keep the longest text seen for a url: index pages often link the same
            # article from a thumbnail (no text) and a headline (the good text).
            if len(text) > len(seen.get(url, "")):
                seen[url] = text
        return list(seen.items())

    def search(self, query: str) -> List[Candidate]:
        """Fetch the page at `query` and return its article links as candidates.

        Raises `SearchFailed` on a dead or unreadable page -- the same contract the
        feed adapter holds, so a page that stops rendering its list is visible as a
        failure instead of looking like a site that stopped publishing.
        """
        try:
            resp = requests.get(query, timeout=self.timeout,
                                headers={"User-Agent": "field-guide-scout/0.1"})
        except requests.exceptions.RequestException as e:
            raise SearchFailed(f"{self.name}: {query}: {type(e).__name__}: {e}")
        if resp.status_code != 200:
            raise SearchFailed(f"{self.name}: {query}: HTTP {resp.status_code}")

        links = self._links(query, resp.content)
        if not links:
            raise SearchFailed(
                f"{self.name}: {query}: no links found — the page may render its "
                f"list with JavaScript, which this can't read")

        unknown = [(u, t) for u, t in links if u not in self.known]
        self.new_verdicts = {}
        if unknown and self.classify:
            self.new_verdicts = self.classify(query, unknown) or {}

        verdict = dict(self.known)
        verdict.update({u: v["is_article"] for u, v in self.new_verdicts.items()})

        articles = [(u, t) for u, t in links if verdict.get(u)]
        self.overflowed = max(0, len(articles) - self.MAX_NEW)
        articles = articles[:self.MAX_NEW]

        # Link text is a placeholder title only. Reader replaces it with the page's
        # real metadata before anything is screened -- judging a document on its
        # anchor text would be far thinner than the abstract every other path gets.
        return [
            Candidate(url=u, title=t, authors=[], publication=None, date=None,
                      abstract=None, source=self.name)
            for u, t in articles
        ]


def discover_feed_url(url: str, timeout: float = 10.0) -> str:
    """Resolve whatever the curator pasted into an actual feed url.

    People paste the thing they were reading -- a post, or the publication's front
    page -- not the feed. Making them hunt for `/feed` is a bad trade when every
    blogging platform already advertises it: HTML pages carry
    `<link rel="alternate" type="application/rss+xml">` precisely so readers don't
    have to. This tries, in order:

      1. the url as given (it may already be a feed),
      2. the `<link rel="alternate">` the page advertises,
      3. the conventional paths, against the site root.

    Raises `SearchFailed` if none of those is a feed -- the same contract the
    adapters hold, so a mistyped url fails loudly at the moment of adding rather
    than becoming a source that sits in the list looking quiet.
    """
    from urllib.parse import urljoin, urlparse

    adapter = FeedAdapter(timeout=timeout)

    def works(candidate: str) -> bool:
        try:
            adapter.search(candidate)
            return True
        except SearchFailed:
            return False

    if works(url):
        return url

    # What does the page itself say its feed is?
    try:
        resp = requests.get(url, timeout=timeout,
                            headers={"User-Agent": "field-guide-scout/0.1"})
        if resp.status_code == 200:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(resp.content, "html.parser")
            for link in soup.find_all("link", rel=lambda v: v and "alternate" in v):
                if "xml" not in (link.get("type") or ""):
                    continue
                href = link.get("href")
                if href and works(urljoin(url, href)):
                    return urljoin(url, href)
    except requests.exceptions.RequestException:
        pass        # fall through to the conventional paths

    # Last resort: the paths platforms actually use, tried against the site root
    # rather than the pasted path (a post url's directory is never the feed).
    parts = urlparse(url)
    root = f"{parts.scheme}://{parts.netloc}"
    for suffix in ("/feed", "/rss", "/feed.xml", "/index.xml", "/atom.xml", "/rss.xml"):
        if works(root + suffix):
            return root + suffix

    raise SearchFailed(
        f"no feed found at {url} — the page advertises none, and the usual "
        f"paths ({root}/feed and friends) aren't feeds either")


class Scout:
    """Discover pipeline: search APIs, dedup, filter tombstones, yield candidates."""

    def __init__(self, adapters: Optional[List[SourceAdapter]] = None, delay: float = 0.5):
        """
        Args:
            adapters: List of SourceAdapters to search (defaults to OpenAlex + arXiv).
            delay: Delay between adapter calls (seconds), to be respectful to APIs.
        """
        if adapters is None:
            adapters = [OpenAlexAdapter(), ArXivAdapter()]
        self.adapters = adapters
        self.delay = delay
        # Searches that failed outright during the last `search()` call, as
        # "adapter: reason" strings. A caller reporting counts should report these
        # too -- otherwise a throttled run looks like a thin literature.
        self.errors: List[str] = []
        # Which search items failed, item name -> reason. `errors` is for humans
        # (it's printed in the run report); this is for callers that must act per
        # item -- recording a feed's health needs to know *which* source failed, and
        # picking that back out of the formatted strings would be guesswork.
        self.failed_items: Dict[str, str] = {}
        # Candidates found but not returned, with why. Search drops things silently
        # by nature -- the curator sees a small number and can't tell a narrow
        # literature from an over-eager filter -- so every drop is recorded here and
        # written into the run report (see DiscoveryService.discover).
        self.dropped: List[Dict] = []

    @staticmethod
    def _normalize_title(title: str) -> str:
        """Collapse a title to a comparison key: lowercase, no HTML, alphanumerics only.

        This is what unifies the same paper across sources -- an arXiv preprint and
        its published OpenAlex record share a title but have different URLs/DOIs.
        """
        t = (title or "").lower()
        t = re.sub(r"<[^>]+>", " ", t)     # strip HTML tags (OpenAlex titles carry <br> etc.)
        t = re.sub(r"&[a-z]+;", " ", t)    # strip HTML entities (&lt; &amp; ...)
        t = re.sub(r"[^a-z0-9]+", " ", t)  # keep alphanumerics only
        return re.sub(r"\s+", " ", t).strip()

    @classmethod
    def _canonical_key(cls, candidate: Candidate) -> str:
        """Dedup key for a candidate: normalized title, falling back to URL."""
        norm = cls._normalize_title(candidate.title)
        return norm if norm else candidate.url.lower()

    @staticmethod
    def _merge_into(base: Candidate, new: Candidate) -> None:
        """Fold a duplicate `new` into the record we're keeping (`base`).

        Keeps the richest fields: a published record's DOI/venue beats a bare
        preprint, we keep the strongest relevance score, and we backfill anything
        missing. Source becomes e.g. "arXiv+openAlex" so appearing in both -- a
        confidence signal -- is visible.
        """
        if not base.doi and new.doi:
            base.doi = new.doi
            base.url = new.url  # prefer the resolvable DOI URL over a preprint link
        if new.relevance_score is not None:
            base.relevance_score = (new.relevance_score if base.relevance_score is None
                                    else max(base.relevance_score, new.relevance_score))
        if not base.abstract and new.abstract:
            base.abstract = new.abstract
        if not base.oa_pdf_url and new.oa_pdf_url:
            base.oa_pdf_url = new.oa_pdf_url
        if not base.publication and new.publication:
            base.publication = new.publication
        # The best venue any adapter saw wins: the arXiv copy of a paper that was
        # later published is still that paper, and OpenAlex is the one that knows.
        if new.venue_tier == TIER_JOURNAL:
            base.venue_tier = TIER_JOURNAL
        elif base.venue_tier is None:
            base.venue_tier = new.venue_tier
        if base.reference_count is None:
            base.reference_count = new.reference_count
        if not base.date and new.date:
            base.date = new.date
        if new.source and new.source not in base.source:
            base.source = f"{base.source}+{new.source}" if base.source else new.source

    def search(self, items: List[SearchItem], duplicates: Optional[set] = None,
               tombstones: Optional[set] = None,
               screened: Optional[set] = None) -> List[Candidate]:
        """Search for candidates matching the given search items (concepts).

        Each adapter reads the field its `query_kind` wants: boolean adapters
        (arXiv) use `item.keywords`, semantic adapters (OpenAlex) use
        `item.semantic_query`. An item with an empty field is skipped for that
        adapter -- no keywords means no arXiv call, and so on.

        Args:
            items: List of SearchItems to query (one per concept, typically).
            duplicates: Set of URLs already in the guide (to skip).
            tombstones: Set of URLs the curator has rejected (to skip).
            screened: Set of URLs a screen already rejected. Distinct from
                `tombstones`, which is the curator's judgement -- this is "we already
                paid to decide about this one", and it's what stops a source
                re-fetching and re-screening the same rejects on every poll.

        Returns:
            List of Candidate documents, deduplicated and filtered. Each candidate
            tracks which item(s) found it via matched_terms (by item name).
        """
        duplicates = duplicates or set()
        tombstones = tombstones or set()
        screened = screened or set()
        self.errors = []
        self.failed_items = {}
        self.dropped = []

        # Map from canonical key (normalized title) to the merged candidate + the
        # item names that found it. Keying on title -- not URL -- collapses the same
        # paper across arXiv and OpenAlex, which carry different URLs for it.
        key_to_candidate = {}
        key_to_terms = {}

        for i, item in enumerate(items):
            if i > 0:
                time.sleep(self.delay)  # be respectful

            print(f"Searching: {item.name}")
            for adapter in self.adapters:
                kind = getattr(adapter, "query_kind", "boolean")
                # Route the adapter to the query shape it understands. An enumerative
                # adapter gets the feed url -- not a query, but the same slot: the
                # thing this adapter needs in order to go and look.
                if kind == "semantic":
                    query = item.semantic_query
                elif kind == "enumerative":
                    # Only the adapter that can read this kind of source.
                    if getattr(adapter, "mechanism", "rss") != item.mechanism:
                        continue
                    query = item.source_url
                else:
                    query = item.keywords
                if not query or not query.strip():
                    continue
                try:
                    candidates = adapter.search(query)
                    print(f"  {adapter.name}: {len(candidates)} results")
                    for candidate in candidates:
                        if item.is_polled:
                            # One FeedAdapter serves every feed, so its own name says
                            # nothing about *which* feed this came from -- the item's
                            # name does, and provenance is resolved against it. Set
                            # before the merge below, which folds `source` into a
                            # "a+b" string and would otherwise bake in "feed".
                            candidate.source = item.name
                        key = self._canonical_key(candidate)
                        if key not in key_to_candidate:
                            key_to_candidate[key] = candidate
                            key_to_terms[key] = []
                        else:
                            self._merge_into(key_to_candidate[key], candidate)
                        # A semantic hit anywhere clears the candidate for the LLM gate.
                        if kind == "semantic":
                            key_to_candidate[key].via_semantic = True
                        if item.is_polled:
                            # A source name is not a search term, and provenance now
                            # lives in `sourced_from` edges -- so don't smuggle it
                            # into matched_terms, where it would read as a concept
                            # and turn into a bogus proposal.
                            key_to_candidate[key].via_polled = True
                        elif item.name not in key_to_terms[key]:
                            key_to_terms[key].append(item.name)
                except Exception as e:
                    # Record, don't abort: one flaky source shouldn't cost us the
                    # other's results, but the run must not claim to be complete.
                    # SearchFailed already names the adapter; anything else doesn't.
                    print(f"  {adapter.name}: error: {e}")
                    detail = f"{e}" if isinstance(e, SearchFailed) else f"{adapter.name}: {e}"
                    self.errors.append(f"{item.name} / {detail}")
                    self.failed_items[item.name] = detail

        # Filter by duplicates/tombstones (both keyed by URL, as stored in the guide),
        # attach provenance, and return the merged survivors.
        survivors = []
        for key, candidate in key_to_candidate.items():
            candidate.matched_terms = key_to_terms[key]
            reason = ("already in the guide" if candidate.url in duplicates
                      else "previously dismissed" if candidate.url in tombstones
                      # Dropped here, before the paid filter and (for page sources)
                      # before Reader is asked to fetch anything.
                      else "already screened out" if candidate.url in screened
                      else None)
            if reason:
                print(f"  Skipped ({reason}): {candidate.url}")
                self.dropped.append({
                    "stage": "search",
                    "reason": reason,
                    "title": candidate.title,
                    "url": candidate.url,
                    "source": candidate.source,
                    "matched_terms": list(candidate.matched_terms),
                })
                continue
            survivors.append(candidate)

        return survivors
