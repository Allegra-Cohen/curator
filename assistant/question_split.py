"""Breaks one curator question into its separate parts, when it has more than
one, so evidence-finding (assistant/evidence.py) can match each part to its
own quote instead of lumping everything into one unlabeled search.

Example: "what are these papers about and what did they find" is really two
questions -- what it's about, and what it found -- and a paper's answer to
each will usually be a different paragraph. Without splitting first, a single
search for both at once can only hand back an unlabeled pile of paragraphs,
with no way to tell which one answers which half.

Two small, separate questions, same style as assistant/scope.py:

  1. Is this actually more than one question, or just one (however it's
     phrased)? Most questions are just one, and asking this first means the
     ordinary case is never rewritten by the model -- the curator's own
     wording is returned untouched.
  2. Only if it's more than one: split it into that many separate,
     self-contained questions.

Deliberately NOT done here: rewording "these papers" / "they" into "this
paper" / "it" for use against one document at a time. Evidence-finding asks
about one document at a time regardless of how the question was phrased, so
that instruction belongs in its prompt (told once, the same way, regardless
of the question's exact wording) rather than being rewritten into every
question here.
"""

from typing import List

import anthropic

from .llm_json import LLMJSONError, extract_json


class QuestionSplitterError(Exception):
    """Couldn't tell whether the question was compound, or couldn't split it --
    an API error, or a reply that couldn't be read as a decision."""


class QuestionSplitter:
    def __init__(self, api_key: str, *, model: str = "claude-haiku-4-5"):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def split(self, question: str) -> List[str]:
        """Always returns at least one question. A single-part question comes
        back as a one-item list holding the curator's own wording, unchanged."""
        if not self._check_compound(question):
            return [question]
        return self._split_parts(question)

    # ------------------------------------------------------------------

    def _check_compound(self, question: str) -> bool:
        prompt = f"""You are a small helper inside a document-curation tool. A curator typed
one question they want answered about some research documents. Decide ONLY
this: is it really asking more than one separate thing, where each part
would need its own separate answer -- or is it just one question, even if
it's phrased in a long or complicated way?

Respond with ONLY a JSON object, no other text:
{{"compound": true or false, "reason": "<short phrase>"}}

The curator's question:
\"\"\"{question}\"\"\"
"""
        row = self._ask(prompt)
        compound = row.get("compound")
        if not isinstance(compound, bool):
            raise QuestionSplitterError(f"compound check didn't return a boolean: {row!r}")
        return compound

    def _split_parts(self, question: str) -> List[str]:
        prompt = f"""You are the same helper. The curator's question below has already been
judged to be asking more than one separate thing. Split it into that many
separate parts, each rewritten as its own complete, self-contained question.

Respond with ONLY a JSON object, no other text:
{{"parts": ["<question 1>", "<question 2>", ...], "reason": "<short phrase>"}}

The curator's question:
\"\"\"{question}\"\"\"
"""
        row = self._ask(prompt)
        parts = row.get("parts")
        if not isinstance(parts, list) or not parts or not all(isinstance(p, str) and p.strip() for p in parts):
            raise QuestionSplitterError(f"split didn't return a list of questions: {row!r}")
        return parts

    # ------------------------------------------------------------------

    def _ask(self, prompt: str) -> dict:
        try:
            text = self._call(prompt)
        except Exception as exc:
            raise QuestionSplitterError(f"question splitter call failed: {exc}") from exc
        try:
            return extract_json(text)
        except LLMJSONError as exc:
            raise QuestionSplitterError(f"splitter {exc}") from exc

    def _call(self, prompt: str) -> str:
        """One model call. Split out so tests can replace it with a stub, same
        as ScopeClassifier._call."""
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=500,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(b.text for b in resp.content if b.type == "text")


if __name__ == "__main__":
    # Manual try-it-out:
    # python3 -m assistant.question_split "what are these papers about and what did they find?"
    import sys

    from anthropic_key import anthropic_api_key

    q = " ".join(sys.argv[1:]) or "what are these papers about and what did they find?"
    key = anthropic_api_key()
    if not key:
        print("Set ANTHROPIC_API_KEY first.")
        sys.exit(1)

    splitter = QuestionSplitter(key)
    print(splitter.split(q))
