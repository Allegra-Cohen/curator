"""Turns an EvidenceTable (assistant/assemble_evidence.py) into the actual markdown
text the chat window shows -- and does nothing else. No model call, no judgment:
assemble_evidence already sorted every real quote into place; this just lays it out,
plus two short lists underneath, kept apart from assemble_evidence.py on purpose --
that file's own docstring says it hands back a plain data structure, never text.

ONE TABLE PER QUESTION, not one wide table with a column per question. A single wide
table crammed the chat pane -- columns squeezed to a sliver, one long question's worth
of quotes running into the next. Each question now gets its own heading (the question
itself, in full) and a plain two-column table underneath it (Paper, Answer), so a
question's quotes get the width they need and nothing has to be read side-scrolled or
truncated. A paper that answered several questions simply appears in several of these
tables -- the exact same quote CAN legitimately show up under more than one question
(an abstract's opening line often answers several at once), and it's shown in full
under each one rather than pointing the curator back and forth between sections.

The table syntax matches what ui/src/markdown.tsx's renderer understands: a header
row, a `|---|---|` divider, then one row per paper. A `|` inside a quote is escaped
as `\\|` so it can never be mistaken for a column divider, and a newline (paragraphs
shouldn't have one, but nothing guarantees it) is flattened to a space -- a table row
has to stay on one line. `###` headings are also part of that same renderer's dialect.

The "(paragraph 12)" before each quote is a real link (graph/links.py's node:<id>#p12
form) to that exact paragraph in the Document Viewer -- built here from the match's
own document id and paragraph number, never typed by a model. Only the "(paragraph
12)" label itself is the clickable part, deliberately -- not the quote text next to
it. A link's clickable text can't contain a `]`, and a real quote can (a citation
marker, bracketed notation); wrapping the quote would risk a garbled link, or would
mean altering the quote to dodge that, which this whole pipeline exists to never do.

A paper that had NOTHING found for a given question is simply left out of that
question's table -- a "not found" row carries no information once a table is only
about one question. If NO paper had anything for a question, that question's heading
still appears, with a plain one-line note instead of an empty table, so the curator
can see every question was actually looked at.

The "Couldn't be read" and "No matching evidence found" lists below the table(s) are
also real, clickable links now (_document_link), same trust rule as the quotes above
-- built here from real data, never typed by Claude. There's no real paragraph to
point at for these (nothing was found, or nothing could even be fetched), so they use
paragraph 0 -- reserved (see graph/links.py, ui/src/components/ChatPane.tsx) to mean
"open the document, there's no paragraph to scroll to." Real paragraph numbers are
always 1 and up, so 0 can never be mistaken for one. A title containing `]` would
break the link's anchor syntax, same risk noted above for a quote -- checked for and
left as plain text in that one rare case rather than risk a garbled link.
"""

from typing import List
from uuid import UUID

from graph.links import make_link

from .assemble_evidence import DocumentTitle, EvidenceRow, EvidenceTable


def format_evidence_table(table: EvidenceTable) -> str:
    parts: List[str] = [_question_section(question, table, i) for i, question in enumerate(table.columns)]

    for group in table.unreadable:
        titles = ", ".join(_document_link(d) for d in group.documents)
        parts.append(f"Couldn't be read: {titles} ({group.reason})")

    if table.no_evidence:
        titles = ", ".join(_document_link(d) for d in table.no_evidence)
        parts.append(f"No matching evidence found: {titles}")

    return "\n\n".join(parts) if parts else "No evidence found for any of these documents."


def _document_link(d: DocumentTitle) -> str:
    anchor = f'"{d.title}"'
    if "]" in anchor:
        return anchor  # would break the link's anchor syntax -- see this file's own docstring
    return make_link(anchor, d.document_id, paragraph=0)


def _question_section(question: str, table: EvidenceTable, column: int) -> str:
    found_rows = [row for row in table.rows if row.cells[column].status == "found"]
    if not found_rows:
        return f"### {question}\n\nNo matching evidence found for this question."

    lines = [f"### {question}", "", "| Paper | Answer |", "|---|---|"]
    for row in found_rows:
        raw_cells = [f'"{row.title}"', _answer(row, column)]
        lines.append("| " + " | ".join(_cell(c) for c in raw_cells) + " |")
    return "\n".join(lines)


def _answer(row: EvidenceRow, column: int) -> str:
    return " / ".join(
        f'{make_link(f"(paragraph {m.paragraph_number})", row.document_id, paragraph=m.paragraph_number)} "{m.text}"'
        for m in row.cells[column].matches
    )


def _cell(text: str) -> str:
    # Flatten to one line and escape `|` -- both are required for a valid table row.
    return text.replace("\n", " ").replace("|", "\\|")
