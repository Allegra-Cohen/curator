"""Scope classifier for the curation assistant's chat.

Before the assistant answers a curator's message, something has to decide how
much of the field guide's data to show it. Handing over everything every time
doesn't scale as the graph grows, so this module reads ONLY the curator's
message (never the graph itself) and sorts it into one of a small number of
buckets, using a small Claude model.

This is done as up to FIVE separate, narrow questions, asked in order, each
one only run if the question before it didn't already settle things. One big
question tried to be everything at once and got a real failure: it mistook an
ordinary topic word ("discuss education") for a deliberate reference to a
pile named "education", just because the two happened to match. Splitting the
"is a real segment/concept being named on purpose" judgement into its own
focused question -- separate from "queue or approved?" -- makes that
judgement easier to get right and easier to check.

  0. (Only when there's a previous answer to build on.) Is this message
     clearly continuing what was just discussed -- "the second one", "those
     documents", "why is that included" -- rather than a fresh request? If
     so, skip everything else and reuse the previous answer as-is, so a
     curator asking a follow-up about documents already pulled into the
     conversation doesn't get asked the queue/approved/both question all
     over again. Naming an actual topic/concept/pile does NOT count as a
     follow-up, even if it could also be read that way.
  1. Is this about a subset of documents at all, or does the curator want the
     whole graph?
  2. Do they explicitly point at something already open on their screen
     ("this document", "the concept I have open") -- and is it really open?
  3. Do they want the QUEUE (documents submitted but not yet reviewed), the
     APPROVED graph (documents already curated in), or both? If it's not
     clear, ask -- always phrased as "1 - queue, 2 - approved documents,
     3 - both" so it's a one-character answer.
  4. If the queue is in play: are they deliberately naming one of the
     curator's own SEGMENTS (a pile made by hand while sorting the queue --
     see queue_segments.py), as opposed to just mentioning a topic that
     happens to share its name? If the approved graph is in play: same
     question, but for a named CONCEPT (a topic in the approved ontology).

This module only classifies. It doesn't fetch documents, doesn't talk to the
graph, and doesn't hold a conversation -- those are separate, later pieces.
It also doesn't remember anything between messages on its own -- question 0
only runs when the caller (assistant/conversation.py) hands back the last
resolved answer itself, via `classify(..., previous=...)`.
"""

import sys
from dataclasses import dataclass
from typing import List, Optional

import anthropic

from .llm_json import LLMJSONError, extract_json

FINAL_KINDS = {
    "whole_graph", "open_document", "open_concept", "queue", "approved",
    "both", "clarify",
}


class ScopeClassifierError(Exception):
    """Something went wrong classifying a message -- an API error, or a reply
    that couldn't be read as a decision. Raised rather than silently falling
    back to "whole_graph", so a broken classifier is never mistaken for a
    correct decision to hand over everything."""


@dataclass
class OpenContext:
    """What the curator currently has open on screen, if anything. Only acted
    on when the curator's message explicitly refers to it -- the classifier is
    told never to assume "this" just because something happens to be open."""
    document_title: Optional[str] = None
    document_in_queue: Optional[bool] = None  # True = pending, False = approved
    concept_name: Optional[str] = None


@dataclass
class ScopeDecision:
    kind: str
    segment_name: Optional[str] = None
    concept_name: Optional[str] = None
    clarify_message: Optional[str] = None
    reason: Optional[str] = None  # the model's short explanation, for debugging


class ScopeClassifier:
    def __init__(self, api_key: str, *, model: str = "claude-haiku-4-5"):
        # Haiku 4.5: each of these four questions is a small, cheap sorting
        # decision, not the conversation itself, so the fast/cheap model is
        # the right default. Swappable via model= if a case ever needs more.
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def classify(self, message: str, *, segment_names: Optional[List[str]] = None,
                 concept_names: Optional[List[str]] = None,
                 open_context: Optional[OpenContext] = None,
                 previous: Optional[ScopeDecision] = None) -> ScopeDecision:
        segment_names = segment_names or []
        concept_names = concept_names or []
        open_context = open_context or OpenContext()

        # 0. Continuing the previous answer, rather than starting fresh? Only
        # asked when there's actually a previous answer to continue -- a
        # thread's first message has nothing to follow up on, and a previous
        # "clarify" isn't a real answer to build on either.
        if previous is not None and previous.kind != "clarify" and self._check_followup(message):
            return ScopeDecision(kind=previous.kind, segment_name=previous.segment_name,
                                  concept_name=previous.concept_name,
                                  reason="follow-up: reusing the previous answer")

        # 1. Subset, or the whole graph?
        if not self._check_subset(message):
            return ScopeDecision(kind="whole_graph", reason="not about a subset")

        # 2. Pointing at something open?
        open_row = self._check_open(message, open_context)
        if open_row["kind"] == "clarify":
            return ScopeDecision(kind="clarify", clarify_message=open_row.get("clarify_message"),
                                  reason=open_row.get("reason"))
        if open_row["kind"] in ("open_document", "open_concept"):
            return ScopeDecision(kind=open_row["kind"], reason=open_row.get("reason"))

        # 3. Queue, approved, or both?
        collection_row = self._check_collection(message)
        collection_kind = collection_row["kind"]
        if collection_kind == "clarify":
            return ScopeDecision(kind="clarify", clarify_message=collection_row.get("clarify_message"),
                                  reason=collection_row.get("reason"))

        # 4. Only now -- and only for the side(s) actually in play -- check
        # whether a real segment/concept is being deliberately named.
        segment_name = None
        concept_name = None
        reason = collection_row.get("reason")
        if collection_kind in ("queue", "both") and segment_names:
            segment_name = self._check_named(
                message, kind="segment", names=segment_names,
                group_word="segment/pile",
            )
        if collection_kind in ("approved", "both") and concept_names:
            concept_name = self._check_named(
                message, kind="concept", names=concept_names,
                group_word="concept",
            )

        return ScopeDecision(kind=collection_kind, segment_name=segment_name,
                              concept_name=concept_name, reason=reason)

    # ------------------------------------------------------------------
    # The (up to) five questions
    # ------------------------------------------------------------------

    def _check_followup(self, message: str) -> bool:
        prompt = f"""You are a small helper inside a document-curation tool called the
"field guide". The curator was just given an answer built from a specific set
of documents. Read their NEW message and decide ONLY this: is it clearly
continuing that same conversation, referring back to what was just discussed
-- using wording that only makes sense pointing at something already said,
like "the second one", "those documents", "what you just mentioned", "why is
that included", "tell me more about it"?

This does NOT count when the message stands on its own -- including one that
names an actual topic, concept, or pile by name ("what about the productive
struggle concept", "show me the UI/UX pile"), even if it could also be read
as continuing the conversation. Only say yes when the wording could ONLY make
sense as pointing back at the previous answer.

Respond with ONLY a JSON object, no other text: {{"followup": true or false, "reason": "<short phrase>"}}

The curator's message:
\"\"\"{message}\"\"\"
"""
        row = self._ask(prompt)
        followup = row.get("followup")
        if not isinstance(followup, bool):
            raise ScopeClassifierError(f"followup check didn't return a boolean: {row!r}")
        return followup

    def _check_subset(self, message: str) -> bool:
        prompt = f"""You are a small helper inside a document-curation tool called the
"field guide". Read one message a curator typed into a chat box and decide
ONLY this: are they asking about a specific subset of documents, or do they
want to see everything (the whole graph)? Respond with ONLY a JSON object, no
other text: {{"subset": true or false, "reason": "<short phrase>"}}

The curator's message:
\"\"\"{message}\"\"\"
"""
        row = self._ask(prompt)
        subset = row.get("subset")
        if not isinstance(subset, bool):
            raise ScopeClassifierError(f"subset check didn't return a boolean: {row!r}")
        return subset

    def _check_open(self, message: str, open_context: OpenContext) -> dict:
        open_desc = self._describe_open_context(open_context)
        prompt = f"""You are the same helper, continuing to sort one curator message. Decide
ONLY this: does the message point at something the curator currently has open
on screen, using a word like "this" or "here" that only makes sense pointing
at something in front of them -- "this document", "the one I'm looking at",
"this concept", "what I have open", "here"?

This does NOT count, even if it uses the word "concept" or "document": simply
NAMING a concept or document by its actual name or topic ("the concept
cognitive agency", "the document about robotics", "docs about X") is not the
same as pointing at what's on screen -- it's just talking about a thing by
name, and belongs to a different question, not this one. Only count it when
the wording could ONLY make sense as pointing at something already in front
of the curator, not when it names something a reader elsewhere could equally
mean.

What's actually open right now:
{open_desc}

Respond with ONLY a JSON object, no other text, using ONE of these shapes:
  {{"kind": "open_document", "reason": "..."}}  -- they refer to what's open, and a document is open
  {{"kind": "open_concept", "reason": "..."}}   -- they refer to what's open, and a concept is open
  {{"kind": "none", "reason": "..."}}           -- they do not refer to what's open
  {{"kind": "clarify", "clarify_message": "<short question>", "reason": "..."}}
    -- they refer to what's open, but nothing matching is actually open

The curator's message:
\"\"\"{message}\"\"\"
"""
        row = self._ask(prompt)
        if row.get("kind") not in ("open_document", "open_concept", "none", "clarify"):
            raise ScopeClassifierError(f"open check returned an unknown kind: {row!r}")
        return row

    def _check_collection(self, message: str) -> dict:
        prompt = f"""You are the same helper, continuing to sort one curator message that is
about SOME subset of documents (already established), but not one already
resolved by "what's open on screen" (already checked, and ruled out).

Two kinds of documents exist in this tool:
  - QUEUE documents: submitted but not yet reviewed by the curator.
  - APPROVED documents: already reviewed and added to the permanent
    collection (called "the graph").

Decide ONLY this: does the curator want documents from the queue, the
approved graph, or both? If you genuinely can't tell, ask instead of
guessing -- and phrase that question EXACTLY as
"1 - queue, 2 - approved documents, 3 - both".

Respond with ONLY a JSON object, no other text, using ONE of these shapes:
  {{"kind": "queue", "reason": "..."}}
  {{"kind": "approved", "reason": "..."}}
  {{"kind": "both", "reason": "..."}}
  {{"kind": "clarify", "clarify_message": "1 - queue, 2 - approved documents, 3 - both", "reason": "..."}}

The curator's message:
\"\"\"{message}\"\"\"
"""
        row = self._ask(prompt)
        if row.get("kind") not in ("queue", "approved", "both", "clarify"):
            raise ScopeClassifierError(f"collection check returned an unknown kind: {row!r}")
        return row

    def _check_named(self, message: str, *, kind: str, names: List[str],
                      group_word: str) -> Optional[str]:
        name_list = ", ".join(f'"{n}"' for n in names)
        prompt = f"""You are the same helper, continuing to sort one curator message. The
curator's own {group_word}s that actually exist right now are: {name_list}

Decide ONLY this: is the curator DELIBERATELY naming one of these specific,
existing {group_word}s as the group they want -- using language that clearly
labels a group, such as "the X {group_word}", "docs labeled 'X'", "tagged X",
"the one called X"?

A message that merely mentions a topic in an ordinary sentence -- "discuss X",
"papers about X", "docs on X" -- does NOT count, even if X happens to be the
exact name of a real {group_word}. Only return a name when the wording is
clearly naming/labeling a specific existing group, not describing a topic to
search for. When genuinely unsure, prefer null.

Respond with ONLY a JSON object, no other text:
  {{"name": "<exact matching name from the list above>", "reason": "..."}}
  or
  {{"name": null, "reason": "..."}}

The curator's message:
\"\"\"{message}\"\"\"
"""
        row = self._ask(prompt)
        name = row.get("name")
        # Never trust a name the model invented -- only ever pass through one
        # that's actually in the list we gave it.
        return name if name in names else None

    # ------------------------------------------------------------------
    # Shared plumbing
    # ------------------------------------------------------------------

    def _ask(self, prompt: str) -> dict:
        try:
            text = self._call(prompt)
        except Exception as exc:
            raise ScopeClassifierError(f"scope classifier call failed: {exc}") from exc
        try:
            return extract_json(text)
        except LLMJSONError as exc:
            raise ScopeClassifierError(f"classifier {exc}") from exc

    def _call(self, prompt: str) -> str:
        """One model call. Split out so tests can replace it with a stub,
        the same way RelevanceFilter's `_ask` is stubbed in test_feeds.py."""
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(b.text for b in resp.content if b.type == "text")

    @staticmethod
    def _describe_open_context(ctx: OpenContext) -> str:
        lines = []
        if ctx.document_title:
            where = "in the queue (not yet approved)" if ctx.document_in_queue else "in the approved graph"
            lines.append(f'- A document is open: "{ctx.document_title}", {where}.')
        if ctx.concept_name:
            lines.append(f'- A concept is open: "{ctx.concept_name}".')
        return "\n".join(lines) if lines else "(nothing is open right now)"


if __name__ == "__main__":
    # Manual try-it-out: python3 -m assistant.scope "docs about education in the queue"
    from anthropic_key import anthropic_api_key

    msg = " ".join(sys.argv[1:]) or "how many docs are about education?"
    key = anthropic_api_key()
    if not key:
        print("Set ANTHROPIC_API_KEY first.")
        sys.exit(1)

    classifier = ScopeClassifier(key)
    decision = classifier.classify(
        msg,
        segment_names=["education", "UI/UX"],
        concept_names=["cognitive agency", "productive struggle"],
        open_context=OpenContext(document_title="A paper about robotics", document_in_queue=True),
    )
    print(decision)
