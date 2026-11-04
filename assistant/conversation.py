"""The curation assistant's chat itself.

One curator message goes in, one reply comes out. In between:

  1. assistant/scope.py decides how much of the field guide is relevant --
     told, via `previous_scope`, what the last message resolved to as well,
     so a follow-up ("the second one", "those documents") can reuse that
     same slice instead of being classified from nothing.
  2. assistant/graph_reader.py -- the ONLY read-only door into the database --
     fetches just that slice.
  3. That slice is handed to Claude as context, along with the conversation so
     far, and its reply is returned.

Claude has three tools. The first, get_document_detail, looks up the full
detail (including the abstract) of ONE document already listed in the slice
above, by its id -- it exists because a big pull only sends titles (see
DETAIL_THRESHOLD) to keep the message from ballooning, and this is how a
question about one specific document's abstract still gets answered. That
tool round-trip (Claude asks -> graph_reader looks up -> Claude answers) all
happens inside one call to `respond()`; what comes back out and gets saved is
still a plain "here's what the curator said, here's what Claude said" pair --
see `_finish`.

The second, find_evidence, is different in shape: it searches one or more
documents' actual body text for real quotes (assistant/evidence.py +
assistant/assemble_evidence.py), and calling it ENDS the turn -- the finished
table is returned as the whole reply, on the spot, rather than being handed
back to Claude to write up. See _run_find_evidence and its use in `_ask`.

The third, screen_documents, checks a whole batch of documents against a
yes/no question at once (assistant/screen_documents.py) -- built after a real
stall where Claude tried to answer a batch question by calling
get_document_detail once per document and ran out of tool rounds before
finishing. Unlike find_evidence, it does NOT end the turn: its result (three
plain lists -- passed, failed, unclear) goes back to Claude, usually to be
followed by a find_evidence call on the documents that passed. See
_run_screen_documents.

This module doesn't change anything a curator has done -- no edit, approve,
or delete is reachable from here, and get_document_detail's tool only ever
calls graph_reader.py, which has no such method to call by mistake. It is
NOT entirely free of writes, though: find_evidence's and screen_documents'
document search both reuse assistant/text_writer.py to cache a document's
full text the first time it's read, the one narrow write the assistant is
allowed to make (see CURATION_ASSISTANT_DESIGN.md) -- a curator's own data is
never touched by it, only a private cached copy of a paper's own text.

History is passed in and returned, not stored here, and so is `previous_scope`
-- this module doesn't know about disk, sessions, or the API. Saving
conversations (and the last resolved scope alongside them) is
conversation_store.py's job, called from api.py.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
from uuid import UUID

import anthropic

from .assemble_evidence import assemble_evidence
from .evidence import EvidenceExtractor, EvidenceExtractorError
from .evidence_table_markdown import format_evidence_table
from .graph_reader import GraphReader
from .scope import OpenContext, ScopeClassifier, ScopeClassifierError, ScopeDecision
from .screen_documents import DocumentScreener, ScreenResult

# Above this many documents, only titles (plus each document's id) are sent
# to keep a big pull (a whole graph, a big pile) from ballooning the message.
# Below it, the full abstract goes along with each title. Either way, Claude
# can still ask for one specific document's abstract via DOCUMENT_DETAIL_TOOL.
DETAIL_THRESHOLD = 30

# Claude's one tool: look up ONE document already listed in the context, by
# its id, when it needs the abstract but was only given the title. It cannot
# look up anything not already listed -- there's no search here, just detail
# on something already in view.
DOCUMENT_DETAIL_TOOL = {
    "name": "get_document_detail",
    "description": (
        "Look up the full detail -- including the abstract -- for ONE "
        "document already listed in the data you were given, using its id. "
        "Use this when you need a document's abstract but were only shown "
        "its title. You can only look up a document already listed above; "
        "there is nothing else to search."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "document_id": {
                "type": "string",
                "description": "The document's id, exactly as shown in the data above.",
            },
        },
        "required": ["document_id"],
    },
}

# Claude's other tool: search the ACTUAL BODY TEXT of one or more documents already
# listed in the context for real quotes answering a question -- e.g. what a paper
# tested or found, across possibly several papers at once. Unlike
# DOCUMENT_DETAIL_TOOL, calling this one ENDS the turn -- see _run_find_evidence and
# its use in _ask. The finished table is built mechanically (assemble_evidence +
# evidence_table_markdown), never retyped by Claude, so it's returned as the whole
# reply instead of being handed back to Claude to write up in its own words.
FIND_EVIDENCE_TOOL = {
    "name": "find_evidence",
    "description": (
        "Search the ACTUAL BODY TEXT of one or more documents (not just their "
        "titles or abstracts) for real quotes that answer a question -- e.g. what "
        "a paper tested, what it found, or comparing that across several papers. "
        "Only ever returns quotes actually found in the text; never guesses or "
        "paraphrases. Use the ids of the documents already listed above that the "
        "question should be checked against -- there is nothing else to search. "
        "Calling this tool FINISHES your answer: its result is the whole reply "
        "the curator will see, so don't write a summary, an introduction, or any "
        "other commentary before or after calling it."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "document_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "The ids of the documents to search, exactly as shown in the data above.",
            },
            "question": {
                "type": "string",
                "description": (
                    "The curator's question to answer from each document's actual text. If "
                    "the curator's question has multiple parts, pass the ENTIRE original "
                    "question here, exactly as asked -- this tool splits a multi-part "
                    "question into separate answers on its own. Don't simplify it down to "
                    "one part; you only get one call before your answer is finalized."
                ),
            },
        },
        "required": ["document_ids", "question"],
    },
}

# A third tool: check a whole batch of documents against a yes/no question at
# once -- e.g. "is this an original study, not a review paper?" -- instead of
# Claude looking each one up individually with get_document_detail. Built
# after a real stall: a 34-document batch question made Claude call
# get_document_detail once per document and run out of tool rounds before
# ever answering (see CURATION_ASSISTANT_DESIGN.md, "a whole-segment question
# can stall without erroring").
#
# Unlike find_evidence, this does NOT end the turn -- its result (three plain
# lists: passed / failed / unclear, each just an id and a title) goes back to
# Claude so it can decide what to do next, usually calling find_evidence on
# the documents that passed. The system prompt and this description are both
# explicit that Claude may ONLY relay these lists or hand them to
# find_evidence -- never write its own description of what a document
# contains, since a yes/no verdict isn't real evidence about content the way
# a find_evidence quote is.
SCREEN_DOCUMENTS_TOOL = {
    "name": "screen_documents",
    "description": (
        "Check a WHOLE BATCH of documents against one yes/no question at once -- "
        "e.g. 'is this an original study, not a review paper?' Use this instead of "
        "calling get_document_detail once per document when the curator's question "
        "is about a whole group. Each document comes back as passed, failed, or "
        "unclear (kept, not dropped, so the curator can judge a borderline one "
        "themselves). After calling this, either call find_evidence on the ids "
        "that passed or were unclear, or -- if the curator only asked for the "
        "screening itself -- list the three groups by title. Either way, do NOT "
        "describe what any document actually contains: a screening verdict is a "
        "yes/no judgment, not real evidence, so there is nothing to summarize "
        "beyond the verdict itself."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "document_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "The ids of the documents to screen, exactly as shown in the data above.",
            },
            "question": {
                "type": "string",
                "description": "A yes/no question to check each document against.",
            },
        },
        "required": ["document_ids", "question"],
    },
}

# A safety cap on how many rounds of "Claude asks for a document -> gets it"
# one reply can go through, so a confused model can't loop forever. A VALID
# find_evidence call never adds to this count -- it ends the turn on the spot (see
# _run_find_evidence). An invalid one (bad ids, missing question) falls back to an
# ordinary round-trip so Claude can retry, the same as any other tool.
MAX_TOOL_ROUNDS = 4


class ConversationError(Exception):
    """The agent couldn't produce a reply -- an API error, or a scope decision
    that named something (an open document/concept) the caller never actually
    supplied an id for."""


@dataclass
class ConversationReply:
    text: str
    history: List[Dict[str, str]]
    scope: ScopeDecision  # kept alongside the reply for debugging/logging, not shown to the curator


class Conversation:
    def __init__(self, reader: GraphReader, api_key: str, *, model: str = "claude-haiku-4-5"):
        self.reader = reader
        self.classifier = ScopeClassifier(api_key, model=model)
        self.evidence_extractor = EvidenceExtractor(reader, api_key, model=model)
        self.screener = DocumentScreener(reader, api_key, model=model)
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def respond(self, message: str, *, history: Optional[List[Dict[str, str]]] = None,
                open_context: Optional[OpenContext] = None,
                open_document_id: Optional[UUID] = None,
                open_concept_id: Optional[UUID] = None,
                previous_scope: Optional[ScopeDecision] = None) -> ConversationReply:
        history = list(history or [])
        open_context = open_context or OpenContext()

        try:
            decision = self.classifier.classify(
                message,
                segment_names=self.reader.segment_names(),
                concept_names=self.reader.concept_names(),
                open_context=open_context,
                previous=previous_scope,
            )
        except ScopeClassifierError as exc:
            raise ConversationError(f"couldn't figure out what part of the graph this is about: {exc}") from exc

        if decision.kind == "clarify":
            return self._finish(message, decision.clarify_message, history, decision)

        context = self._build_context(decision, open_document_id, open_concept_id)
        reply_text = self._ask(message, history, context)
        return self._finish(message, reply_text, history, decision)

    # ------------------------------------------------------------------
    # Building the slice of the graph Claude gets to see
    # ------------------------------------------------------------------

    def _build_context(self, decision: ScopeDecision, open_document_id: Optional[UUID],
                        open_concept_id: Optional[UUID]) -> str:
        kind = decision.kind

        if kind == "open_document":
            if open_document_id is None:
                raise ConversationError(
                    "scope decided this is about the document the curator has open, "
                    "but no open_document_id was given to respond()")
            doc = self.reader.document(open_document_id)
            if doc is None:
                return "The curator seems to have a document open, but it can't be found anymore."
            return "The document the curator currently has open:\n" + self._format_documents([doc])

        if kind == "open_concept":
            if open_concept_id is None:
                raise ConversationError(
                    "scope decided this is about the concept the curator has open, "
                    "but no open_concept_id was given to respond()")
            concept = self.reader.concept_detail(open_concept_id)
            if concept is None:
                return "The curator seems to have a concept open, but it can't be found anymore."
            return self._format_concept_with_documents(concept)

        if kind == "whole_graph":
            sections = [
                "CONCEPTS (the topics documents get organized under):\n" + self._format_concepts(self.reader.concepts()),
                "APPROVED DOCUMENTS (already reviewed and organized):\n" + self._format_documents(self.reader.approved_documents()),
                "QUEUE DOCUMENTS (submitted, not yet reviewed):\n" + self._format_documents(self.reader.queue_documents()),
            ]
            return "\n\n".join(sections)

        if kind == "queue":
            label = f'the "{decision.segment_name}" pile' if decision.segment_name else "the whole queue"
            docs = self.reader.queue_documents(segment_name=decision.segment_name)
            return f"QUEUE DOCUMENTS ({label}):\n" + self._format_documents(docs)

        if kind == "approved":
            label = f'documents about "{decision.concept_name}"' if decision.concept_name else "the whole approved graph"
            docs = self.reader.approved_documents(concept_name=decision.concept_name)
            return f"APPROVED DOCUMENTS ({label}):\n" + self._format_documents(docs)

        if kind == "both":
            queue_label = f'the "{decision.segment_name}" pile' if decision.segment_name else "the whole queue"
            approved_label = f'documents about "{decision.concept_name}"' if decision.concept_name else "the whole approved graph"
            queue_docs = self.reader.queue_documents(segment_name=decision.segment_name)
            approved_docs = self.reader.approved_documents(concept_name=decision.concept_name)
            sections = [
                f"QUEUE DOCUMENTS ({queue_label}):\n" + self._format_documents(queue_docs),
                f"APPROVED DOCUMENTS ({approved_label}):\n" + self._format_documents(approved_docs),
            ]
            return "\n\n".join(sections)

        raise ConversationError(f"don't know how to build context for scope kind {kind!r}")

    @staticmethod
    def _format_documents(docs: List[Dict]) -> str:
        if not docs:
            return "(none)"
        detailed = len(docs) <= DETAIL_THRESHOLD
        lines = []
        for d in docs:
            if detailed:
                abstract = d["abstract"] or "(no abstract on file)"
                lines.append(f'- "{d["title"]}" [id: {d["id"]}]\n  {abstract}')
            else:
                lines.append(f'- "{d["title"]}" [id: {d["id"]}]')
        if detailed:
            return "\n".join(lines)
        return (f"({len(docs)} documents -- too many to show abstracts here; "
                f"use get_document_detail for any one you need the abstract of)\n"
                + "\n".join(lines))

    @staticmethod
    def _format_concepts(concepts: List[Dict]) -> str:
        if not concepts:
            return "(none)"
        return "\n".join(f'- "{c["label"]}": {c["description"] or "(no description)"}' for c in concepts)

    def _format_concept_with_documents(self, concept: Dict) -> str:
        header = f'The concept the curator currently has open: "{concept["label"]}"\n{concept["description"] or "(no description)"}'
        return header + "\n\nDocuments about it:\n" + self._format_documents(concept["documents"])

    # ------------------------------------------------------------------
    # Talking to Claude
    # ------------------------------------------------------------------

    def _ask(self, message: str, history: List[Dict[str, str]], context: str) -> str:
        system = f"""You are the curation assistant inside the "field guide," a tool a curator
uses to review and organize research documents into topics (called concepts).

Right now you can only READ what's in the field guide. You cannot add, edit,
delete, or approve anything, and you have no way to do so, even if asked. If
the curator asks you to change something, say plainly that you can't do that
yet, and that you can only answer questions about what's already there.

Two collections exist:
  - The QUEUE: documents submitted but not yet reviewed by the curator.
  - The APPROVED graph: documents already reviewed and organized under concepts.

Below is the data relevant to the curator's question, gathered just now. Only
use what's actually listed below -- never invent a document, concept, title,
or fact that isn't there. If the data below doesn't answer the question, say
so plainly instead of guessing.

Some documents below are shown as titles only, without an abstract. If the
curator asks about one of those, use the get_document_detail tool to look up
its abstract by id -- don't say you can't see it without trying that first.
You can only look up a document's id that is actually listed below; there is
nothing else to search. Every document below has an id in brackets after its
title, like [id: ...] -- that's for you to use with the tool, never repeat a
raw id back to the curator, refer to documents by title instead.

If the question needs the ACTUAL BODY of one or more documents -- what a
paper tested, what it found, comparing findings across several papers -- use
the find_evidence tool instead of guessing from a title or abstract. Give it
every document id (from what's listed above) the question should be checked
against. If the curator asked several things at once, pass the WHOLE question
to find_evidence in one call, exactly as asked -- it splits a multi-part
question into a separate answer for each part on its own, so simplifying it
down to just one part yourself would lose the rest. Its result is a finished
table of real quotes; once you call it, that table IS your whole answer -- do
not add a summary, an introduction, or any commentary before or after it, and
calling it again afterward will not add to this answer, since calling it
always finishes your reply immediately.

If the curator wants to know which documents in a group meet some yes/no
condition (e.g. "which of these are original studies, not reviews?"), use
the screen_documents tool instead of judging from titles/abstracts yourself.
It checks every document in the group and comes back with three lists:
passed, failed, and unclear (kept, not dropped -- the curator can judge those
themselves). After it comes back, either call find_evidence on the documents
that passed or were unclear, or, if that's all the curator asked for, just
list the three groups by title. Either way, do not add your own description
of what any of those documents contain -- a screen_documents verdict is a
yes/no judgment, not real evidence, so there is nothing to summarize beyond
the verdict itself.

If the question is about a whole segment, pile, or a large group of documents
at once, do NOT call get_document_detail once per document to work through
them one at a time -- that tool is for looking up ONE document already open
on screen. For a whole group, go straight to the batch tools instead:
screen_documents to narrow the group down by a yes/no condition, find_evidence
to pull real quotes out of the group (or the narrowed-down group).

Write in plain English. Avoid jargon, and if you have to use a field-guide
specific term, explain it in a few words.

{context}
"""
        messages: List[Dict] = history + [{"role": "user", "content": message}]
        for round_num in range(1, MAX_TOOL_ROUNDS + 1):
            print(f"[assistant] round {round_num}/{MAX_TOOL_ROUNDS}")
            try:
                resp = self.client.messages.create(
                    model=self.model,
                    max_tokens=1024,
                    system=system,
                    tools=[DOCUMENT_DETAIL_TOOL, FIND_EVIDENCE_TOOL, SCREEN_DOCUMENTS_TOOL],
                    messages=messages,
                )
            except Exception as exc:
                print(f"[assistant] turn ended: API call failed ({exc})")
                raise ConversationError(f"the assistant call failed: {exc}") from exc

            if resp.stop_reason != "tool_use":
                print(f"[assistant] turn ended: answered directly (round {round_num})")
                return "".join(b.text for b in resp.content if b.type == "text")

            tool_use_blocks = [b for b in resp.content if b.type == "tool_use"]
            for block in tool_use_blocks:
                print(f"[assistant]   tool call: {self._describe_tool_call(block)}")

            # A VALID find_evidence call ends the turn right here: its table is
            # built mechanically and returned as the whole reply, with anything
            # Claude wrote alongside the tool call (a preamble, a summary) simply
            # discarded -- see FIND_EVIDENCE_TOOL's docstring for why.
            evidence_block = next((b for b in tool_use_blocks if b.name == "find_evidence"), None)
            if evidence_block is not None:
                table_text = self._run_find_evidence(evidence_block)
                if table_text is not None:
                    print(f"[assistant] turn ended: find_evidence produced the table (round {round_num})")
                    return table_text
                print("[assistant]   find_evidence call was unusable, asking Claude to retry")

            messages.append({"role": "assistant", "content": resp.content})
            tool_results = [
                {"type": "tool_result", "tool_use_id": block.id, "content": self._tool_result_text(block)}
                for block in tool_use_blocks
            ]
            messages.append({"role": "user", "content": tool_results})

        print(f"[assistant] turn ended: hit MAX_TOOL_ROUNDS ({MAX_TOOL_ROUNDS}) without answering")
        raise ConversationError("the assistant kept looking up documents without ever answering")

    @staticmethod
    def _describe_tool_call(block) -> str:
        """A short, human-readable summary of one tool call for the round-by-round
        log above -- not shown to the curator, just printed to the terminal."""
        raw = block.input if isinstance(block.input, dict) else {}
        if block.name == "get_document_detail":
            return f"get_document_detail(document_id={raw.get('document_id')!r})"
        if block.name == "find_evidence":
            ids = raw.get("document_ids")
            count = len(ids) if isinstance(ids, list) else "?"
            return f"find_evidence(question={raw.get('question')!r}, {count} document(s))"
        if block.name == "screen_documents":
            ids = raw.get("document_ids")
            count = len(ids) if isinstance(ids, list) else "?"
            return f"screen_documents(question={raw.get('question')!r}, {count} document(s))"
        return f"{block.name}({raw!r})"

    def _tool_result_text(self, block) -> str:
        if block.name == "get_document_detail":
            return self._run_tool(block)
        if block.name == "find_evidence":
            # Only reached when _run_find_evidence already found the input
            # unusable -- explain what's wrong so Claude can retry properly,
            # the same as a bad get_document_detail id does above.
            return ("document_ids (a non-empty list of ids already shown above) "
                    "and question (a non-empty string) are both required.")
        if block.name == "screen_documents":
            return self._run_screen_documents(block)
        return "Unknown tool."

    def _run_screen_documents(self, block) -> str:
        raw = block.input if isinstance(block.input, dict) else {}
        question = raw.get("question")
        raw_ids = raw.get("document_ids")
        if not isinstance(question, str) or not question.strip():
            return ("document_ids (a non-empty list of ids already shown above) "
                    "and question (a non-empty yes/no question) are both required.")
        if not isinstance(raw_ids, list) or not raw_ids:
            return ("document_ids (a non-empty list of ids already shown above) "
                    "and question (a non-empty yes/no question) are both required.")
        try:
            doc_ids = [UUID(str(i)) for i in raw_ids]
        except (ValueError, TypeError):
            return "One of those ids isn't valid -- only use ids exactly as shown in the data you were given."

        results = self.screener.screen(doc_ids, question)
        return self._format_screen_results(results)

    @staticmethod
    def _format_screen_results(results: List[ScreenResult]) -> str:
        passed = [r for r in results if r.verdict == "passed"]
        unclear = [r for r in results if r.verdict == "unclear"]
        failed = [r for r in results if r.verdict == "failed"]

        def lines(group: List[ScreenResult], with_id: bool) -> str:
            if not group:
                return "(none)"
            if with_id:
                return "\n".join(f'- "{r.title}" [id: {r.document_id}]' for r in group)
            return "\n".join(f'- "{r.title}"' for r in group)

        return (
            f"PASSED ({len(passed)}) -- clearly satisfies the question:\n"
            f"{lines(passed, True)}\n\n"
            f"UNCLEAR ({len(unclear)}) -- couldn't be determined; kept, not dropped, "
            f"so the curator can judge these themselves:\n"
            f"{lines(unclear, True)}\n\n"
            f"FAILED ({len(failed)}) -- clearly does not satisfy the question, left out:\n"
            f"{lines(failed, False)}\n\n"
            "Do not describe what any of these documents actually contain -- this is "
            "only a yes/no/unclear verdict, not real evidence."
        )

    def _run_tool(self, block) -> str:
        raw_id = block.input.get("document_id") if isinstance(block.input, dict) else None
        try:
            doc_id = UUID(str(raw_id))
        except (ValueError, TypeError):
            return "That id isn't valid -- only use an id exactly as shown in the data you were given."
        doc = self.reader.document(doc_id)
        if doc is None:
            return "No document with that id was found in what you were given."
        where = "in the queue (not yet approved)" if doc["status"] == "pending" else "in the approved graph"
        abstract = doc["abstract"] or "(no abstract on file)"
        return f'"{doc["title"]}" -- {where}.\nAbstract: {abstract}'

    def _run_find_evidence(self, block) -> Optional[str]:
        """Returns the finished table text when the call is usable -- the
        short-circuit path in _ask. Returns None when the input itself is
        unusable (missing question, empty/invalid document_ids), which sends
        the caller down the ordinary tool_result round-trip instead, via
        _tool_result_text, so Claude gets a chance to retry."""
        raw = block.input if isinstance(block.input, dict) else {}
        question = raw.get("question")
        raw_ids = raw.get("document_ids")
        if not isinstance(question, str) or not question.strip():
            return None
        if not isinstance(raw_ids, list) or not raw_ids:
            return None
        try:
            doc_ids = [UUID(str(i)) for i in raw_ids]
        except (ValueError, TypeError):
            return None

        try:
            evidence = self.evidence_extractor.extract(doc_ids, question)
        except EvidenceExtractorError as exc:
            raise ConversationError(f"couldn't find evidence: {exc}") from exc

        # Every document with status "ok" was asked the same split question in
        # the same order (see EvidenceExtractor._one_document), so the first
        # one's answers name all the columns; if every document failed to
        # fetch, there are no rows to show anyway, so an empty column list is
        # fine -- assemble_evidence's table.rows stays empty either way.
        ok_doc = next((d for d in evidence if d.status == "ok"), None)
        columns = [a.question for a in ok_doc.answers] if ok_doc else []
        table = assemble_evidence(evidence, columns, self.reader)
        return format_evidence_table(table)

    @staticmethod
    def _finish(message: str, reply_text: str, history: List[Dict[str, str]],
                decision: ScopeDecision) -> ConversationReply:
        new_history = history + [
            {"role": "user", "content": message},
            {"role": "assistant", "content": reply_text},
        ]
        return ConversationReply(text=reply_text, history=new_history, scope=decision)


if __name__ == "__main__":
    # Manual try-it-out: python3 -m assistant.conversation "how many docs are about education?"
    import sys

    from anthropic_key import anthropic_api_key
    from graph import GraphRepository, connect, env_dsn

    msg = " ".join(sys.argv[1:]) or "how many documents are in the queue?"
    key = anthropic_api_key()
    if not key:
        print("Set ANTHROPIC_API_KEY first.")
        sys.exit(1)

    conn = connect(env_dsn("sandbox"), autocommit=True)
    reader = GraphReader(GraphRepository(conn), "sandbox")
    convo = Conversation(reader, key)
    reply = convo.respond(msg)
    print(reply.text)
    print("\n(scope decision:", reply.scope, ")")
