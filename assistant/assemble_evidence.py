"""Turns the raw output of extract_evidence (assistant/evidence.py) into a
table shape, and does nothing else. This is the `assemble_evidence` piece
described in writeups/design/CURATION_ASSISTANT_DESIGN.md.

No model call happens here. extract_evidence already worked out which real
quotes answer which part of the question, for every document -- this file
only sorts that into rows/columns and looks up each document's title. Every
quote keeps the document id and paragraph number it already had, so nothing
here can re-word or misattribute a quote.

What comes out is a plain data structure (columns, rows, two side-lists) --
not text, not markdown. Turning that into something the chat window can
actually display is a separate, later step.
"""

from dataclasses import dataclass, field
from typing import Dict, List
from uuid import UUID

from .evidence import DocumentEvidence, EvidenceMatch
from .graph_reader import GraphReader


@dataclass
class TableCell:
    status: str  # "found" or "not_found" -- same meaning as QuestionAnswer.status
    matches: List[EvidenceMatch] = field(default_factory=list)


@dataclass
class EvidenceRow:
    document_id: UUID
    title: str
    cells: List[TableCell]  # one per column, same order as EvidenceTable.columns


@dataclass
class DocumentTitle:
    document_id: UUID
    title: str


@dataclass
class UnreadableGroup:
    reason: str  # one of reader.NO_BODY_REASONS' sentences, or similar
    documents: List[DocumentTitle]


@dataclass
class EvidenceTable:
    columns: List[str]  # the question parts, in order
    rows: List[EvidenceRow]  # only documents with at least one found cell
    unreadable: List[UnreadableGroup]  # couldn't be fetched at all, grouped by why
    no_evidence: List[DocumentTitle]  # fetched fine, but nothing matched anywhere


def assemble_evidence(
    document_evidence: List[DocumentEvidence],
    questions: List[str],
    reader: GraphReader,
) -> EvidenceTable:
    rows: List[EvidenceRow] = []
    no_evidence: List[DocumentTitle] = []
    unreadable_by_reason: Dict[str, List[DocumentTitle]] = {}

    for doc in document_evidence:
        title = _title(reader, doc.document_id)

        if doc.status == "couldnt_fetch":
            unreadable_by_reason.setdefault(doc.reason, []).append(
                DocumentTitle(document_id=doc.document_id, title=title)
            )
            continue

        if not any(a.status == "found" for a in doc.answers):
            no_evidence.append(DocumentTitle(document_id=doc.document_id, title=title))
            continue

        cells = [TableCell(status=a.status, matches=a.matches) for a in doc.answers]
        rows.append(EvidenceRow(document_id=doc.document_id, title=title, cells=cells))

    unreadable = [
        UnreadableGroup(reason=reason, documents=docs)
        for reason, docs in unreadable_by_reason.items()
    ]

    return EvidenceTable(columns=questions, rows=rows, unreadable=unreadable, no_evidence=no_evidence)


def _title(reader: GraphReader, document_id: UUID) -> str:
    row = reader.document(document_id)
    return row["title"] if row else ""
