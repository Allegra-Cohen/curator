"""Finds real quotes that answer a question, across one or more documents --
and does nothing else. This is the `extract_evidence` piece described in
writeups/design/CURATION_ASSISTANT_DESIGN.md: it never writes a summary, a
label, or a single word of its own about what a document says. It only ever
points at real text that was actually fetched from the document.

For each document, separately:

  1. Get its full text -- the cached copy if there is one, otherwise fetch it
     now (assistant/text_writer.fetch_and_cache_full_text, already built).
     If that fails (paywalled, no source link, nothing readable), record why
     and move on to the next document; nothing else runs for this one.
  2. Split the text into paragraphs (reader.split_paragraphs -- the same
     split the Document Viewer and the fetch-and-cache step both use).
  3. The curator's question may really be more than one question ("what are
     these papers about and what did they find" is two) --
     assistant/question_split.py breaks it into that many separate,
     self-contained parts. A plain single question comes back as a one-item
     list, so the rest of this always works the same way regardless.
  4. For EACH part, separately: ask a small model "given these numbered
     paragraphs, which number(s) answer this one question, or none?" The
     model only ever answers with numbers. The real paragraph text is then
     read out of the actual list built in step 2 at that index -- it is
     never retyped or paraphrased by the model. That is what makes a
     fabricated or drifted quote structurally impossible here, not just
     something checked for afterward.
  5. For each paragraph found in step 4, narrow it down further: split that
     one paragraph into sentences (reader.split_sentences), and ask the
     model to PICK the 1-2 sentence numbers that answer the question most
     directly -- same trick as step 4, just one size smaller. If it picks
     none (the answer genuinely needs the whole paragraph), the whole
     paragraph is kept, exactly as before. This is what keeps a table cell
     from filling up with a whole paragraph when one sentence would do.

A question can genuinely match more than one paragraph in the same document
(step 4 allows the model to return several numbers), and different parts of a
split question will usually match different paragraphs.

Step 5 is a refinement on top of already-correct evidence, not a second
chance to get the facts right -- if its model call fails or comes back
unusable, the code falls back to the whole paragraph (already known
correct) rather than raising. Step 4 keeps the stricter behavior (raise,
don't guess), because getting THAT wrong could mean the wrong paragraph --
wrong facts -- not just a less tidy display.

The exact same sentence CAN legitimately come back as the answer to more
than one question part -- an abstract's opening line often does. Earlier
this module used to hunt those down and hide the repeat behind a "(see
part N)" note; that's gone now. Once results moved to one table per
question (assistant/evidence_table_markdown.py), a repeated quote no longer
sits twice in the same table -- it's the answer in two SEPARATE tables, and
the curator would rather see it in both than chase a pointer between them.

This module calls assistant/text_writer.py directly (the one narrow write
the curation assistant is allowed to make) -- not through a tool Claude
chooses to call. Nothing here hands Claude the raw document text; Claude
never sees anything except the exact paragraph(s) this module already found.

Documents, a document's question-parts, and one question's matched
paragraphs are each genuinely independent of their siblings at that level --
so each of those three spots (see `_map`) runs its model calls at once
instead of one at a time, which is what actually made this slow to begin
with once step 5 added more calls per document. The one thing that
ISN'T safe to do at once is touch the database -- fetch_and_cache_full_text
reads and writes through one shared connection, not a pool -- so that one
step alone stays behind a lock (`_db_lock`) even while everything else
around it runs in parallel.
"""

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import List, Optional
from uuid import UUID

import anthropic

from .graph_reader import GraphReader
from .llm_json import LLMJSONError, extract_json
from .question_split import QuestionSplitter, QuestionSplitterError
from .text_writer import fetch_and_cache_full_text
from reader import split_paragraphs, split_sentences


class EvidenceExtractorError(Exception):
    """Couldn't split the question, or couldn't get a paragraph-matching
    answer from the model -- an API error, or a reply that couldn't be read
    as a decision. A document that simply couldn't be fetched is NOT this --
    that's a normal, expected outcome, reported per-document instead."""


@dataclass
class EvidenceMatch:
    paragraph_number: int  # 1-indexed, as shown to the model and as the
                            # curator would see it if it's ever displayed
    text: str  # real text lifted verbatim from the paragraph -- usually now
               # just the 1-2 sentences that answer the question (step 5
               # above), or the whole paragraph when nothing shorter fit


@dataclass
class QuestionAnswer:
    question: str
    status: str  # "found" or "not_found"
    matches: List[EvidenceMatch] = field(default_factory=list)


@dataclass
class DocumentEvidence:
    document_id: UUID
    status: str  # "ok" or "couldnt_fetch"
    reason: Optional[str] = None  # set when status == "couldnt_fetch"
    answers: List[QuestionAnswer] = field(default_factory=list)  # set when status == "ok"


class EvidenceExtractor:
    def __init__(
        self, reader: GraphReader, api_key: str, *,
        model: str = "claude-haiku-4-5", matching_model: str = "claude-haiku-4-5", max_workers: int = 6,
    ):
        self.reader = reader
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        # "Which paragraph(s) answer this" (_matching_paragraph_numbers) is
        # the one genuinely fuzzy judgment call in this whole module -- not
        # a small yes/no like everything else, but "is this THE paragraph
        # that best answers this, or just a related one." This step sends a
        # WHOLE document's paragraphs to the model, once per document (and,
        # after the compound-question fix above, once per question part too)
        # -- by far the most expensive calls this module makes. It briefly
        # used Sonnet here, because Haiku tended to be too inclusive,
        # matching several paragraphs that all touch the same idea instead
        # of picking the clearest one -- but given the real cost difference
        # on large documents, the curator chose to go back to Haiku here too
        # and watch accuracy while testing continues, rather than pay
        # Sonnet's rate by default. Still overridable per instance if a
        # curator wants to try Sonnet again for a specific run.
        self.matching_model = matching_model
        self.splitter = QuestionSplitter(api_key, model=model)
        # How many of a batch's independent model calls (across documents,
        # across a document's question-parts, or across one question's
        # matched paragraphs) can be in flight at once. Bounded rather than
        # unlimited so one big table can't open hundreds of threads or fire
        # an unbounded burst of requests at the API at the same moment.
        self.max_workers = max_workers
        # fetch_and_cache_full_text reads and writes through ONE shared
        # database connection (GraphRepository wraps a single psycopg
        # connection, not a pool) -- that's not safe to touch from more than
        # one thread at a time, unlike the model calls below, which the
        # Anthropic client supports concurrently. This lock keeps every
        # document's fetch-and-cache step one-at-a-time even while their
        # model calls run in parallel. In practice this barely costs
        # anything: once a document's text is cached (the common case, after
        # the first time it's ever asked about), this step is just a fast
        # database read, held only briefly.
        self._db_lock = threading.Lock()

    def extract(self, document_ids: List[UUID], question: str) -> List[DocumentEvidence]:
        try:
            sub_questions = self.splitter.split(question)
        except QuestionSplitterError as exc:
            raise EvidenceExtractorError(f"couldn't split the question: {exc}") from exc

        return self._map(lambda doc_id: self._one_document(doc_id, sub_questions), document_ids)

    # ------------------------------------------------------------------

    def _map(self, fn, items):
        """Runs fn over items concurrently -- independent work only, never
        used where one item's result is needed to start another -- and
        returns the results in the same order as `items`, regardless of
        which finishes first. Shared by every parallelizable step below so
        there's exactly one place that decides how many can run at once."""
        items = list(items)
        if not items:
            return []
        with ThreadPoolExecutor(max_workers=min(len(items), self.max_workers)) as pool:
            return list(pool.map(fn, items))

    def _one_document(self, document_id: UUID, sub_questions: List[str]) -> DocumentEvidence:
        with self._db_lock:
            fetch = fetch_and_cache_full_text(self.reader.repo, self.reader.env, document_id)
        if not fetch["ok"]:
            return DocumentEvidence(document_id=document_id, status="couldnt_fetch", reason=fetch["reason"])

        paragraphs = split_paragraphs(fetch["text"])
        if not paragraphs:
            # Cached/fetched text with nothing splittable in it -- treat the
            # same as nothing found, for every part, rather than erroring.
            return DocumentEvidence(
                document_id=document_id, status="ok",
                answers=[QuestionAnswer(question=q, status="not_found") for q in sub_questions],
            )

        # Each question-part is answered independently of the others, so
        # they can all be worked on at once.
        answers = self._map(lambda q: self._one_question(paragraphs, q), sub_questions)
        return DocumentEvidence(document_id=document_id, status="ok", answers=answers)

    def _one_question(self, paragraphs: List[str], question: str) -> QuestionAnswer:
        numbers = self._matching_paragraph_numbers(paragraphs, question)
        # Narrowing one matched paragraph down to a sentence doesn't depend
        # on any other matched paragraph, so this is the other spot worth
        # running at once -- it's what turns a cell with many matches from
        # many sequential calls into one wave of parallel ones.
        texts = self._map(lambda n: self._narrow_to_sentences(paragraphs[n - 1], question), numbers)
        matches = [EvidenceMatch(paragraph_number=n, text=t) for n, t in zip(numbers, texts)]
        if not matches:
            return QuestionAnswer(question=question, status="not_found")
        return QuestionAnswer(question=question, status="found", matches=matches)

    def _narrow_to_sentences(self, paragraph: str, question: str) -> str:
        """Step 5: try to shrink one already-matched paragraph down to the 1-2
        sentences that answer the question. Falls back to the whole paragraph
        -- never raises -- because a paragraph is always a safe, correct
        answer; a shorter one is a nice-to-have, not a fact that can be
        gotten wrong."""
        sentences = split_sentences(paragraph)
        if len(sentences) < 2:
            return paragraph  # nothing shorter to offer

        numbered = "\n".join(f"[{i}] {s}" for i, s in enumerate(sentences, start=1))
        prompt = f"""You are a small helper inside a document-curation tool. Below is ONE
paragraph, already confirmed to answer the question below, split into
numbered sentences.

Pick the 1 or 2 sentence numbers that answer the question MOST DIRECTLY and
would still make sense quoted on their own. If no single sentence or pair of
sentences captures it well -- the answer genuinely needs the whole
paragraph -- return an empty list instead of guessing.

Respond with ONLY a JSON object, no other text:
{{"sentence_numbers": [<int>, ...], "reason": "<short phrase>"}}

The question:
\"\"\"{question}\"\"\"

The paragraph's sentences:
{numbered}
"""
        try:
            row = self._ask(prompt)
            raw = row.get("sentence_numbers")
            if not isinstance(raw, list):
                return paragraph
            valid = sorted({n for n in raw if isinstance(n, int) and 1 <= n <= len(sentences)})
        except EvidenceExtractorError:
            return paragraph
        if not valid:
            return paragraph
        return self._join_sentences(sentences, valid[:2])

    @staticmethod
    def _join_sentences(sentences: List[str], indices: List[int]) -> str:
        """Join 1-2 picked sentences (always exactly 1 or 2 -- callers cap at
        `valid[:2]`) back into one quote. Adjacent sentences (a real run of
        consecutive text) are joined with just a space; non-adjacent ones
        get a visible " [...] " so the quote never implies a continuity that
        isn't really there."""
        if len(indices) == 1:
            return sentences[indices[0] - 1]
        first, second = indices
        connector = " " if second == first + 1 else " [...] "
        return sentences[first - 1] + connector + sentences[second - 1]

    def _matching_paragraph_numbers(self, paragraphs: List[str], question: str) -> List[int]:
        numbered = "\n\n".join(f"[{i}] {p}" for i, p in enumerate(paragraphs, start=1))
        prompt = f"""You are a careful research assistant inside a document-curation tool.
Below are the numbered paragraphs of ONE document. This question may have
originally been asked about a whole group of documents -- you are only
looking at this one, so answer using only what this one document's
paragraphs actually say.

Decide which paragraph number(s) answer the question below. Usually ONE
paragraph says it best -- prefer picking just that single clearest one.
Only include more than one paragraph if they genuinely add DIFFERENT
information needed to answer the question fully -- not the same point
restated, introduced, and then repeated again elsewhere, which academic
papers do constantly (in an abstract, again in the introduction, again in
the results). If several paragraphs all make the same point, pick the one
that states it most clearly and completely, and leave the rest out. If none
of them answer it, say so -- do not guess or stretch a paragraph to fit.

Respond with ONLY a JSON object, no other text:
{{"paragraph_numbers": [<int>, ...], "reason": "<short phrase>"}}
Use an empty list if none answer it.

The question:
\"\"\"{question}\"\"\"

The paragraphs:
{numbered}
"""
        row = self._ask(prompt, model=self.matching_model)
        raw = row.get("paragraph_numbers")
        if not isinstance(raw, list):
            raise EvidenceExtractorError(f"paragraph match didn't return a list: {row!r}")
        # Keep only real, in-range paragraph numbers -- a small model can
        # misremember an index; that's a fuzzy-judgment slip, not a plumbing
        # failure, so it's dropped rather than raised.
        return sorted({n for n in raw if isinstance(n, int) and 1 <= n <= len(paragraphs)})

    def _ask(self, prompt: str, *, model: Optional[str] = None) -> dict:
        try:
            text = self._call(prompt, model=model)
        except Exception as exc:
            raise EvidenceExtractorError(f"evidence extractor call failed: {exc}") from exc
        try:
            return extract_json(text)
        except LLMJSONError as exc:
            raise EvidenceExtractorError(f"evidence extractor {exc}") from exc

    def _call(self, prompt: str, *, model: Optional[str] = None) -> str:
        """One model call. Split out so tests can replace it with a stub, same
        as ScopeClassifier._call. `model` defaults to self.model (the cheap
        model most calls here use) -- only the paragraph-matching step
        passes its own, stronger self.matching_model."""
        resp = self.client.messages.create(
            model=model or self.model,
            max_tokens=500,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(b.text for b in resp.content if b.type == "text")


if __name__ == "__main__":
    # Manual try-it-out:
    # python3 -m assistant.evidence <document-id> [<document-id> ...] -- <question>
    import sys

    from anthropic_key import anthropic_api_key
    from graph import GraphRepository, connect, env_dsn

    args = sys.argv[1:]
    if "--" not in args:
        print("Usage: python3 -m assistant.evidence <document-id> [<document-id> ...] -- <question>")
        sys.exit(1)
    split_at = args.index("--")
    doc_ids = [UUID(a) for a in args[:split_at]]
    q = " ".join(args[split_at + 1:])

    key = anthropic_api_key()
    if not key:
        print("Set ANTHROPIC_API_KEY first.")
        sys.exit(1)

    conn = connect(env_dsn("sandbox"), autocommit=True)
    reader = GraphReader(GraphRepository(conn), "sandbox")
    extractor = EvidenceExtractor(reader, key)
    for doc_evidence in extractor.extract(doc_ids, q):
        print(doc_evidence)
