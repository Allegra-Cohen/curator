"""LLM relevance gate: drop search noise before it reaches the queue.

Two questions, because two kinds of source carry two different curator
declarations -- and each candidate is screened against whatever was actually said:

  * A **concept** search says *"I want work about this concept."* So a keyword hit
    is judged against that concept's own `semantic_query` -- the prose the curator
    wrote to go looking, not the reader-facing `description` beside it. Keyword
    search matches on
    token overlap and surfaces papers that merely contain a concept's words --
    "productive struggle" returning a robotics control paper -- and this is what
    catches them.

  * A **followed source** says *"important things come from here, but I can't
    predict which concepts."* No concept was asserted about the post, so screening
    it against one would enforce a constraint the curator never made. It's judged on
    the guide scope alone, and it arrives in the queue with no concept proposals --
    the accurate answer, since nothing proposed one.

Both answer to the same guide scope, and the standard is the same; only the
question differs. Semantic-search candidates (OpenAlex) are already gated by a
relevance-score floor, so they skip the filter entirely -- only candidates with
`via_semantic == False` are judged. When the model is unsure it keeps the
candidate: the curator is the final gate, so the filter only kills obvious noise.
"""

import json
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import anthropic

from scout import Candidate


# FALLBACK ONLY -- the real scope statement is a curator-authored Artifact
# (`ArtifactService.get_guide_scope`), editable from the SCOPE button in the UI. This
# constant is what a guide that has never had one saved gets.
#
# Note how much work this paragraph does: it is prepended to every screening call, so
# its "human cognition ... NOT about AI/ML systems for their own sake" framing is what
# rejects machine-reading-comprehension papers under a concept whose own search text
# never says "human". That is exactly why it belongs to the curator and not to this file.
DEFAULT_GUIDE_SCOPE = (
    "This field guide covers how generative AI affects human cognition, learning, "
    "expertise, and epistemic autonomy: cognitive offloading and skill erosion, "
    "metacognition and self-regulated learning, the preservation or loss of "
    "intellectual independence, and related human-centered concerns. It is NOT "
    "about AI/ML systems or methods for their own sake, nor unrelated fields that "
    "merely share vocabulary."
)


@dataclass
class FilterResult:
    """Outcome of a filtering pass."""
    kept: List[Candidate] = field(default_factory=list)
    dropped: List[Candidate] = field(default_factory=list)  # judged off-topic noise
    reasons: Dict[str, str] = field(default_factory=dict)    # url -> the model's reason
    # Dropped candidates as report rows, each carrying the model's stated reason.
    drop_log: List[dict] = field(default_factory=list)


class RelevanceFilter:
    """Judge keyword hits against their concepts, and feed items against the scope."""

    def __init__(self, api_key: str, *, model: str = "claude-haiku-4-5",
                 batch_size: int = 12, guide_scope: str = DEFAULT_GUIDE_SCOPE):
        # Haiku 4.5: cheap and fast, plenty for relevance classification. It takes
        # no thinking/effort params, so we don't pass them.
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        self.batch_size = batch_size
        self.guide_scope = guide_scope

    def filter(self, candidates: List[Candidate],
               concept_queries: Optional[Dict[str, str]] = None,
               *,
               feed_concepts: Optional[Dict[str, str]] = None,
               selected_concepts: Optional[Set[str]] = None) -> FilterResult:
        """Split candidates into kept/dropped, and attach concept proposals.

        Args:
            candidates: the Scout survivors to gate.
            concept_queries: name -> semantic-search prose for the **keyword** path,
                so an arXiv hit is judged against the same statement of intent
                OpenAlex was given. Names come from Candidate.matched_terms. A name
                missing here is judged on its bare label -- which is what a concept
                with no search text yet gets.
            feed_concepts: name -> description for **every live concept**. The
                reader-facing definition, not the search prose: this path labels a
                post rather than re-judging a search, and every concept has a
                definition. Feed posts
                are classified against all of them, including the ones the curator
                unchecked -- that is what makes the exclusion below possible.
            selected_concepts: the concept names checked in the concept picker.
                `None` means every concept is checked (a full run).

        Semantic candidates pass through untouched; everything else is judged in
        batches. Any batch that errors or fails to return a verdict keeps its
        candidates (favor recall).

        Feed posts are batched *separately* from keyword hits and get a different
        question, because the concept screen does a different job on each path:

          * keyword hits -- "is this really about the concept that found it?"
            A post that fails has failed the thing the curator asked for.
          * feed posts -- "has the curator said she doesn't want this right now?"
            Unchecking a concept means exactly that. For a query source you honour
            it by not running the query; a feed can't be narrowed that way (one
            fetch brings back every topic the writer covers), so it is honoured by
            dropping the posts that match.

        The model only ever *classifies* -- it says what a post is in scope for and
        which concepts it is about. Whether that means drop is decided here, from
        the checked/unchecked sets, because that is the curator\'s instruction and
        not a judgement call worth delegating.
        """
        concept_queries = concept_queries or {}
        feed_concepts = feed_concepts or {}
        # A concept the curator unchecked. `None` selection means a full run, so
        # nothing is excluded and the feed screen becomes pure annotation.
        excluded = (set() if selected_concepts is None
                    else set(feed_concepts) - set(selected_concepts))

        result = FilterResult()

        # Semantic hits are already score-gated -- nothing to judge.
        result.kept.extend(c for c in candidates if c.via_semantic)
        judgeable = [c for c in candidates if not c.via_semantic]
        by_concept = [c for c in judgeable if not c.via_polled]
        from_feeds = [c for c in judgeable if c.via_polled]

        for batch in self._batched(by_concept):
            verdicts = self._judge_batch(batch, concept_queries)
            for i, candidate in enumerate(batch):
                verdict = verdicts.get(i)
                if verdict is None:
                    result.kept.append(candidate)  # no verdict -> keep (recall)
                    continue
                reason = verdict.get("reason", "(no reason given)")
                result.reasons[candidate.url] = reason
                if verdict.get("keep", True):     # default keep if the field is missing
                    result.kept.append(candidate)
                else:
                    result.dropped.append(candidate)
                    result.drop_log.append(
                        self._drop_row(candidate, "llm-filter", reason))

        for batch in self._batched(from_feeds):
            verdicts = self._judge_feed_batch(batch, feed_concepts)
            for i, candidate in enumerate(batch):
                verdict = verdicts.get(i)
                if verdict is None:
                    result.kept.append(candidate)  # no verdict -> keep (recall)
                    continue
                reason = verdict.get("reason", "(no reason given)")
                result.reasons[candidate.url] = reason
                matched = [n for n in verdict.get("concepts", []) if n in feed_concepts]

                if not verdict.get("in_scope", True):
                    result.dropped.append(candidate)
                    result.drop_log.append(
                        self._drop_row(candidate, "llm-filter-scope", reason))
                    continue

                wanted = [n for n in matched if n not in excluded]
                if matched and not wanted:
                    # Every concept it is about is one the curator unchecked.
                    names = ", ".join(matched)
                    result.dropped.append(candidate)
                    result.drop_log.append(self._drop_row(
                        candidate, "llm-filter-excluded",
                        f"about {names}, unchecked for this run"))
                    continue

                # Kept. `wanted` is empty when the post matched no concept at all --
                # in scope but unplaced, which reaches the queue bare by design (see
                # the tagged decision in SOURCES_DESIGN.md).
                candidate.matched_terms = wanted
                result.kept.append(candidate)

        return result

    @staticmethod
    def _drop_row(candidate: Candidate, stage: str, reason: str) -> dict:
        """One dropped candidate as a search-report row.

        The model\'s own stated reason is kept verbatim: the filter is a judgement
        call, so "what did it cut and why" is the only way to tell a working filter
        from one quietly discarding good documents.
        """
        return {
            "stage": stage,
            "reason": reason,
            "title": candidate.title,
            "url": candidate.url,
            "source": candidate.source,
            "matched_terms": list(candidate.matched_terms or []),
        }

    def _batched(self, candidates: List[Candidate]) -> List[List[Candidate]]:
        return [candidates[i:i + self.batch_size]
                for i in range(0, len(candidates), self.batch_size)]

    @staticmethod
    def _abstract_of(c: Candidate, limit: int = 600) -> str:
        text = (c.abstract or "").strip().replace("\n", " ")
        return (text[:limit] + "...") if len(text) > limit else (text or "(no abstract)")

    def _judge_feed_batch(self, batch: List[Candidate],
                          feed_concepts: Dict[str, str]) -> Dict[int, dict]:
        """Classify posts a followed source turned up: in scope, and about what.

        Two things to notice about this prompt.

        **It asks for classification, never for a keep/drop verdict.** Whether a
        match means drop depends on which concepts the curator checked, which is her
        instruction rather than a judgement -- so the policy stays in `filter()` and
        the model is never told about it.

        **It lists every live concept, including the unchecked ones.** That is what
        makes exclusion possible at all: to drop a post *because* it is about a
        concept the curator unchecked, something has to recognise that it is about
        that concept. Passing only the checked concepts would make every unwanted
        post look like an unplaceable one.
        """
        concept_lines = "\n".join(
            f"  - {name}: {desc}" for name, desc in sorted(feed_concepts.items())
        ) or "  (no concepts defined yet)"

        entries = [
            f"[{i}] Title: {c.title}\n"
            f"Published by: {c.publication or '(unknown)'}\n"
            f"Text: {self._abstract_of(c)}"
            for i, c in enumerate(batch)
        ]
        prompt = (
            f"{self.guide_scope}\n\n"
            f"The guide organises its material under these concepts:\n"
            f"{concept_lines}\n\n"
            f"Below are posts from sources a curator follows deliberately -- blogs, "
            f"newsletters and lab sites she judged worth watching. No topic search "
            f"found them, so do not ask whether each matches a particular concept. "
            f"For each post, report two things:\n\n"
            f"  in_scope -- does it fall within the guide's scope as stated above? "
            f"Say true for anything plausibly in scope, even if it fits none of the "
            f"concepts listed; say false only for what is clearly outside the guide's "
            f"subject matter. When genuinely unsure, say true -- a human curator makes "
            f"the final call.\n\n"
            f"  concepts -- which of the concepts above is it substantially about? "
            f"Use the exact names as written. Return an empty list if none genuinely "
            f"apply; do not stretch for a match. Only list a concept you would defend "
            f"as a real fit.\n\n"
            f"Respond with ONLY a JSON array, one object per post, no prose:\n"
            f'[{{"id": <int>, "in_scope": <true|false>, "concepts": ["<name>", ...], '
            f'"reason": "<short phrase>"}}]\n\n'
            + "\n\n".join(entries)
        )
        return self._ask(prompt)

    def _judge_batch(self, batch: List[Candidate],
                     concept_queries: Dict[str, str]) -> Dict[int, dict]:
        """Ask the model for a keep/drop verdict on each candidate in the batch.

        Returns a map from batch index -> {"keep": bool, "reason": str}. On any
        error returns {}, which the caller treats as "keep everything in this batch".
        """
        entries = []
        for i, c in enumerate(batch):
            concept_lines = []
            for name in (c.matched_terms or []):
                gloss = concept_queries.get(name)
                concept_lines.append(f"  - {name}: {gloss}" if gloss else f"  - {name}")
            concepts = "\n".join(concept_lines) if concept_lines else "  (unknown)"

            entries.append(
                f"[{i}] Title: {c.title}\n"
                f"Abstract: {self._abstract_of(c)}\n"
                f"Surfaced under concept(s):\n{concepts}"
            )
        documents = "\n\n".join(entries)

        prompt = (
            f"{self.guide_scope}\n\n"
            f"Below are candidate papers found by keyword search. For each, decide "
            f"whether it is genuinely about at least one of the concept(s) it was "
            f"surfaced under, within the guide's scope -- or whether it merely "
            f"contains the keywords while actually being about something else "
            f"(a common failure of keyword search). When you are genuinely unsure, "
            f"keep it; a human curator makes the final call.\n\n"
            f"Respond with ONLY a JSON array, one object per candidate, no prose:\n"
            f'[{{"id": <int>, "keep": <true|false>, "reason": "<short phrase>"}}]\n\n'
            f"{documents}"
        )
        return self._ask(prompt)

    def _ask(self, prompt: str) -> Dict[int, dict]:
        """One screening call. Both prompts land here so they share the same failure
        rule: an API error keeps the whole batch rather than losing candidates."""
        try:
            resp = self.client.messages.create(
                model=self.model,
                max_tokens=2048,
                messages=[{"role": "user", "content": prompt}],
            )
            text = "".join(b.text for b in resp.content if b.type == "text")
            return self._parse_verdicts(text)
        except Exception:
            return {}  # keep the whole batch rather than lose candidates to an API error

    @staticmethod
    def _parse_verdicts(text: str) -> Dict[int, dict]:
        """Pull the JSON verdict array out of the model's reply, defensively."""
        # Strip a ```json ... ``` fence if the model added one, then grab the array.
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            return {}
        try:
            rows = json.loads(match.group(0))
        except (ValueError, TypeError):
            return {}
        verdicts = {}
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("id"), int):
                verdicts[row["id"]] = row
        return verdicts


class LinkClassifier:
    """Separate a page's article links from its navigation.

    Page sources have no feed to tell them what's a post, so something has to look
    at a list of links and say which are publications. Hand-written CSS selectors
    would do it per site and rot silently; this asks the model instead, and the
    answers are memoised per link (see `PageLinkMemo`) so each link costs one
    judgement ever, not one per poll.

    The two sites that motivated this need opposite rules, which is why a heuristic
    was rejected: on one, the essays share a path prefix and the navigation doesn't;
    on the other, the publications sit at top-level paths and are distinguished only
    by having long link text. A model handles both without being told either.
    """

    def __init__(self, api_key: str, *, model: str = "claude-haiku-4-5",
                 batch_size: int = 120):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        self.batch_size = batch_size

    def classify(self, page_url: str,
                 links: List[Tuple[str, str]]) -> Dict[str, dict]:
        """Judge `(url, link_text)` pairs. Returns url -> {is_article, reason}.

        On any API error returns {} -- the caller keeps nothing rather than
        guessing. That's the opposite of the relevance filter's favour-recall rule,
        and deliberately so: an unjudged link there means one extra document for a
        curator to dismiss, whereas here it would mean ingesting a site's entire
        navigation as documents.
        """
        out: Dict[str, dict] = {}
        for i in range(0, len(links), self.batch_size):
            out.update(self._judge(page_url, links[i:i + self.batch_size]))
        return out

    def _judge(self, page_url: str,
               links: List[Tuple[str, str]]) -> Dict[str, dict]:
        listing = "\n".join(
            f"[{i}] {text[:120]}\n    {url}" for i, (url, text) in enumerate(links)
        )
        prompt = (
            f"This is the list of links found on {page_url}, a page that indexes "
            f"writing published by a person or organisation.\n\n"
            f"Decide which links point to an individual piece of published writing "
            f"by this site -- an article, essay, paper, report or blog post. Those "
            f"are `true`.\n\n"
            f"Everything else is `false`: site navigation, section indexes, tag or "
            f"category listings, author or team pages, sign-up and subscribe links, "
            f"social media, legal pages, and links to products or services.\n\n"
            f"Two things to watch for:\n"
            f"  · An index page that lists many pieces is NOT itself a piece.\n"
            f"  · A piece is still a piece when it lives on another domain "
            f"(a paper on arXiv, say) -- judge what it is, not where it is.\n\n"
            f"Respond with ONLY a JSON array, one object per link, no prose:\n"
            f'[{{"id": <int>, "is_article": <true|false>, "reason": "<short phrase>"}}]'
            f"\n\n{listing}"
        )
        try:
            resp = self.client.messages.create(
                model=self.model, max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )
            text = "".join(b.text for b in resp.content if b.type == "text")
        except Exception:
            return {}

        verdicts = RelevanceFilter._parse_verdicts(text)
        out: Dict[str, dict] = {}
        for i, (url, _text) in enumerate(links):
            v = verdicts.get(i)
            if v is None:
                continue        # unjudged -> not extracted; see classify()'s docstring
            out[url] = {"is_article": bool(v.get("is_article")),
                        "reason": v.get("reason", "")}
        return out
