"""Screens a batch of documents against a yes/no question -- e.g. "is this an
original study, not a review paper?" -- without Claude looping through them
one at a time. This is the `screen_documents` tool described in
writeups/design/CURATION_ASSISTANT_DESIGN.md, built to fix the stall found
while testing a 34-document segment (see that file's "Found while testing"
section): Claude tried to answer a batch question by calling
get_document_detail once per document and ran out of tool rounds before
finishing.

For each document, separately:

  1. Ask the question against the document's abstract (already in hand -- no
     fetch needed). The model answers "yes", "no", or "unclear" -- it is
     NEVER asked to explain why, so there is no free text here for it to get
     wrong.
  2. Only if that answer is "unclear", fetch-and-cache the document's full
     text (assistant/text_writer.fetch_and_cache_full_text, the same cache
     extract_evidence uses) and ask again against the full text instead of
     just the abstract. If the document can't be fetched, or the second
     check is still unclear, it stays unclear -- there's nothing more to go
     on.
  3. A model call that fails outright (an API error, or a reply that isn't
     usable JSON) also counts as unclear for that one document, rather than
     stopping the whole batch -- one flaky call shouldn't block every other
     document's answer, which is exactly the kind of stall this tool exists
     to avoid.

Every document ends up in exactly one of three groups: passed, failed, or
unclear. Per a decision with the curator, unclear documents are kept, not
dropped -- the curator would rather see a borderline document and judge it
themselves than have it silently disappear.

The tool result Claude receives (built in conversation.py) is just three
plain lists of (id, title) -- see SCREEN_DOCUMENTS_TOOL there for the
instructions telling Claude what it's allowed to do with that (call
find_evidence next, or list the groups by title -- never invent commentary
about what a document contains beyond its verdict).
"""

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import List
from uuid import UUID

import anthropic

from .graph_reader import GraphReader
from .llm_json import LLMJSONError, extract_json
from .text_writer import fetch_and_cache_full_text


class DocumentScreenerError(Exception):
    """Not raised for a single document's failed check -- see this module's
    own docstring, point 3. Reserved for something wrong with the call
    itself that a caller might want to know about while testing."""


@dataclass
class ScreenResult:
    document_id: UUID
    title: str
    verdict: str  # "passed", "failed", or "unclear"


class DocumentScreener:
    def __init__(
        self, reader: GraphReader, api_key: str, *,
        model: str = "claude-haiku-4-5", max_workers: int = 6,
    ):
        self.reader = reader
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        # How many documents' checks can be in flight at once -- same bound,
        # same reasoning, as EvidenceExtractor.max_workers.
        self.max_workers = max_workers
        # fetch_and_cache_full_text shares ONE database connection, not a
        # pool (see evidence.py's _db_lock for the full reasoning) -- kept
        # one-at-a-time even while the model calls around it run in parallel.
        self._db_lock = threading.Lock()

    def screen(self, document_ids: List[UUID], question: str) -> List[ScreenResult]:
        """Every document is independent of the others, so they're all
        checked at once (see EvidenceExtractor._map, same pattern)."""
        return self._map(lambda doc_id: self._one_document(doc_id, question), document_ids)

    def _map(self, fn, items):
        items = list(items)
        if not items:
            return []
        with ThreadPoolExecutor(max_workers=min(len(items), self.max_workers)) as pool:
            return list(pool.map(fn, items))

    def _one_document(self, document_id: UUID, question: str) -> ScreenResult:
        doc = self.reader.document(document_id)
        if doc is None:
            return ScreenResult(document_id=document_id, title="(document not found)", verdict="unclear")

        verdict = self._ask_verdict(doc["title"], doc["abstract"] or "(no abstract on file)", question)
        if verdict != "unclear":
            return ScreenResult(document_id=document_id, title=doc["title"], verdict=verdict)

        with self._db_lock:
            fetch = fetch_and_cache_full_text(self.reader.repo, self.reader.env, document_id)
        if not fetch["ok"]:
            return ScreenResult(document_id=document_id, title=doc["title"], verdict="unclear")

        verdict = self._ask_verdict(doc["title"], fetch["text"], question, is_full_text=True)
        return ScreenResult(document_id=document_id, title=doc["title"], verdict=verdict)

    def _ask_verdict(self, title: str, text: str, question: str, *, is_full_text: bool = False) -> str:
        label = "the document's full text" if is_full_text else "the document's abstract"
        prompt = f"""You are a small helper inside a document-curation tool, screening one
document against a yes/no question. Answer only from what's shown below --
don't guess or assume anything about the document beyond it.

The question:
\"\"\"{question}\"\"\"

Below is {label} for a document titled "{title}":
\"\"\"{text}\"\"\"

Answer "yes" if the document clearly satisfies the question, "no" if it
clearly does not, or "unclear" if you genuinely can't tell from what's shown
-- don't guess either way when you're not confident.

Respond with ONLY a JSON object, no other text:
{{"verdict": "yes" | "no" | "unclear"}}
"""
        try:
            row = self._ask(prompt)
        except DocumentScreenerError:
            # A failed call is treated the same as a genuinely unclear
            # judgment -- see this module's docstring, point 3.
            return "unclear"
        verdict = row.get("verdict")
        if verdict == "yes":
            return "passed"
        if verdict == "no":
            return "failed"
        return "unclear"

    def _ask(self, prompt: str) -> dict:
        try:
            text = self._call(prompt)
        except Exception as exc:
            raise DocumentScreenerError(f"screening call failed: {exc}") from exc
        try:
            return extract_json(text)
        except LLMJSONError as exc:
            raise DocumentScreenerError(f"screening {exc}") from exc

    def _call(self, prompt: str) -> str:
        """One model call. Split out so tests can replace it with a stub,
        same as EvidenceExtractor._call and ScopeClassifier._call."""
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=50,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(b.text for b in resp.content if b.type == "text")


if __name__ == "__main__":
    # Manual try-it-out:
    # python3 -m assistant.screen_documents <document-id> [<document-id> ...] -- <yes/no question>
    import sys

    from anthropic_key import anthropic_api_key
    from graph import GraphRepository, connect, env_dsn

    args = sys.argv[1:]
    if "--" not in args:
        print("Usage: python3 -m assistant.screen_documents <document-id> [<document-id> ...] -- <yes/no question>")
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
    screener = DocumentScreener(reader, key)
    for result in screener.screen(doc_ids, q):
        print(result)
