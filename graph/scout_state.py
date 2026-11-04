"""Scout's own bookkeeping: what it learned last time it went looking.

A second, deliberately small SQL layer. `repository.py` is the only SQL for the
*graph*; this owns the plain tables that are not graph data at all, and keeping
them here rather than folding them into the repository is the honest version of
that boundary. Two tables, both keyed by `source` node id:

  * `scout_sources`       -- polling health (did it answer, and if not, why)
  * `scout_page_links`    -- for page sources, which links are articles and which
                             are navigation, so the model is asked once per link
  * `scout_screened_urls` -- urls already rejected by a screen, so a source doesn't
                             pay to re-decide them on every poll

Two rules decide what belongs in this table:

  * **Not the graph.** A poll happens whether or not anything is found, and writing
    it to the source node would create a `revisions` row every time -- machine
    bookkeeping in the audit log, and a watermark sitting in front of Undo.
  * **Only what can't be derived.** Accept rate is *not* here: it comes from
    `sourced_from` edges at read time (see `SourceService.stats`). A *failed* poll
    is the one thing that writes nothing anywhere, so failure state has no other
    home -- which is exactly the case this table exists for.

That distinction is what makes a dead feed legible. A feed that 404s and a feed
whose author is on holiday produce the same thing in the graph -- nothing -- and
only `consecutive_failures` tells them apart.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional
from uuid import UUID

import psycopg


@dataclass(frozen=True)
class Health:
    """One source's polling record. All fields are None/0 before the first poll."""
    last_success_at: Optional[datetime] = None
    last_failure_at: Optional[datetime] = None
    consecutive_failures: int = 0
    last_error: Optional[str] = None

    @property
    def failing(self) -> bool:
        """Every poll since the last success has failed.

        Deliberately true on the *first* failure rather than after a threshold: a
        feed that just broke and a feed that broke a month ago are both broken, and
        the count is there to say how long it has been going on.
        """
        return self.consecutive_failures > 0

    def as_dict(self) -> Dict:
        return {
            "last_success_at": (self.last_success_at.isoformat()
                                if self.last_success_at else None),
            "last_failure_at": (self.last_failure_at.isoformat()
                                if self.last_failure_at else None),
            "consecutive_failures": self.consecutive_failures,
            "last_error": self.last_error,
            "failing": self.failing,
        }


class SourceHealth:
    """Read and record polling outcomes, keyed by `source` node id."""

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def record_success(self, source_id: UUID) -> None:
        """A poll that answered. Clears the failure streak and the stale error."""
        with self.conn.cursor() as cur:
            cur.execute(
                """insert into scout_sources
                       (source_id, last_success_at, consecutive_failures, last_error)
                   values (%s, now(), 0, null)
                   on conflict (source_id) do update set
                       last_success_at = now(),
                       consecutive_failures = 0,
                       last_error = null""",
                (source_id,),
            )

    def record_failure(self, source_id: UUID, error: str) -> None:
        """A poll that couldn't complete. Increments the streak and keeps the reason.

        Note this is only reachable because adapters raise `SearchFailed` rather
        than returning `[]` -- an adapter that swallowed the error would look like a
        source that published nothing, and nothing would ever be recorded here.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                """insert into scout_sources
                       (source_id, last_failure_at, consecutive_failures, last_error)
                   values (%s, now(), 1, %s)
                   on conflict (source_id) do update set
                       last_failure_at = now(),
                       consecutive_failures = scout_sources.consecutive_failures + 1,
                       last_error = excluded.last_error""",
                (source_id, error[:500]),
            )

    def get(self, source_id: UUID) -> Health:
        """One source's health. A source never polled reads as a clean slate."""
        return self.all().get(source_id, Health())

    def all(self) -> Dict[UUID, Health]:
        with self.conn.cursor() as cur:
            cur.execute(
                """select source_id, last_success_at, last_failure_at,
                          consecutive_failures, last_error
                   from scout_sources"""
            )
            return {
                r[0]: Health(last_success_at=r[1], last_failure_at=r[2],
                             consecutive_failures=r[3], last_error=r[4])
                for r in cur.fetchall()
            }


class PageLinkMemo:
    """Which links on a page source are articles — remembered, so the model is
    asked about each link exactly once.

    This is the whole reason page sources are affordable. A publications index has
    a handful of articles among a hundred navigation links; judging all of them on
    every poll would be the dominant cost of running the source, and the answer
    almost never changes.

    Asymmetry worth understanding: article links don't strictly *need* remembering,
    because they become documents and the pipeline's own url dedup drops them next
    time. The navigation links are what must be remembered -- nothing anywhere else
    records that `/about` was already considered and rejected.

    Nothing here goes stale in a way that breaks: a redesigned site simply presents
    urls the memo hasn't seen, so they get judged once and carry on. The failure
    mode is one extra model call, never silent under-extraction.
    """

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def known(self, source_id: UUID) -> Dict[str, bool]:
        """url -> is_article for every link already judged for this source."""
        with self.conn.cursor() as cur:
            cur.execute(
                "select url, is_article from scout_page_links where source_id = %s",
                (source_id,),
            )
            return {r[0]: r[1] for r in cur.fetchall()}

    def remember(self, source_id: UUID, verdicts: Dict[str, bool],
                 reasons: Optional[Dict[str, str]] = None) -> None:
        """Record judgements. Existing rows are left alone -- a link's role on a page
        is settled once, and re-judging it would defeat the point of the memo."""
        reasons = reasons or {}
        if not verdicts:
            return
        with self.conn.cursor() as cur:
            cur.executemany(
                """insert into scout_page_links (source_id, url, is_article, reason)
                   values (%s, %s, %s, %s)
                   on conflict (source_id, url) do nothing""",
                [(source_id, url, is_article, reasons.get(url))
                 for url, is_article in verdicts.items()],
            )

    def forget(self, source_id: UUID) -> None:
        """Drop every judgement for a source, so the next poll re-reads the page from
        scratch. The escape hatch for a misjudgement the curator spotted in the run
        report -- without it, a link wrongly filed as navigation would stay invisible
        forever, which is exactly the silent-loss failure this project keeps refusing
        to accept elsewhere."""
        with self.conn.cursor() as cur:
            cur.execute("delete from scout_page_links where source_id = %s",
                        (source_id,))


class ScreenedUrls:
    """Urls a screen has already rejected, so no source pays to re-decide them.

    Without this, an item a source keeps offering but the guide scope keeps
    rejecting costs a fetch and a screening call on **every single poll**, forever.
    A feed post is re-screened; a page article is re-scraped *and* re-screened.

    Deliberately not a tombstone. A tombstone is the curator saying "I reject this
    paper" -- a judgement, undoable, and the thing `dismissed` records. This is
    machine bookkeeping: "we already spent the money to decide." Keeping them
    separate is what stops an automated rejection from ever looking like a curatorial
    one in the audit trail.

    Only rejects are recorded. An accepted url becomes a document, so the pipeline's
    existing url dedup already skips it -- the same asymmetry as `PageLinkMemo`,
    where the negatives are the ones nothing else remembers.

    Recorded only when a screen actually reached a verdict. A url Reader couldn't
    fetch is *not* recorded, so a transient failure means a retry next poll rather
    than a document lost for good.
    """

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def all(self) -> set:
        with self.conn.cursor() as cur:
            cur.execute("select url from scout_screened_urls")
            return {r[0] for r in cur.fetchall()}

    def record(self, rows: List[Dict]) -> None:
        """Each row: url, source_id (optional), stage, reason."""
        if not rows:
            return
        with self.conn.cursor() as cur:
            cur.executemany(
                """insert into scout_screened_urls (url, source_id, stage, reason)
                   values (%s, %s, %s, %s)
                   on conflict (url) do nothing""",
                [(r["url"], r.get("source_id"), r.get("stage"),
                  (r.get("reason") or "")[:500]) for r in rows],
            )

    def forget_source(self, source_id: UUID) -> int:
        """Let one source's rejects be reconsidered — the escape hatch behind
        "re-read this source from scratch"."""
        with self.conn.cursor() as cur:
            cur.execute("delete from scout_screened_urls where source_id = %s",
                        (source_id,))
            return cur.rowcount
