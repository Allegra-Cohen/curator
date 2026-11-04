"""Segments: the curator's own partition of the review queue, kept OUT of the graph.

A **segment** is a pile the curator makes by hand while organizing the queue -- a
named, coloured circle on a canvas, and the documents dropped into it. It is a
working aid, not a claim: a segment is not a concept, membership in one is not an
`about` edge, and a segment's note is not an Artifact. Nothing in this module
touches Postgres, and that is the whole point of the feature.

**So the state lives in a file, one per environment**, beside `.active_env` and
`.embedding_cache.json`:

    .queue_segments.sandbox.json

A file rather than a table because this organization is *naturally persistent but
eventually temporary*: it has to survive a reload and a server restart -- an hour
of sorting can't evaporate on a refresh -- and it stops mattering entirely once the
queue it describes has been worked through. It doesn't want to be in `backup_db.sh`'s
backups or in the graph's revision history. See
`writeups/design/QUEUE_ORGANIZATION_DESIGN.md`.

The reading in `api.py` is one GET and one whole-blob PUT. Whole-blob because one
curator is editing one document: a member-by-member PATCH surface would need
conflict rules for a conflict that cannot arise.

TWO NORMALIZATIONS, and the difference between them is the interesting part:

  `drop_empty_segments`  -- an empty pile is not a pile. Applied on every SAVE, so
                            the file can never hold one. That is what makes a
                            brand-new circle purely client-side state until it
                            catches its first document, which in turn is what lets
                            "an emptied circle disappears" be a rule with no
                            exception for the one you just made.
  `prune`                -- the queue moved on: documents got reviewed or dismissed
                            and are no longer pending. Their memberships are dead
                            weight, so they go, and any segment left with nothing in
                            it goes with them. Applied on every READ, because the
                            queue changes for reasons this file never hears about.

`prune` is deliberately NOT written back to disk on a read. A GET that rewrites a
file is a surprise, and it buys nothing: pruning is idempotent, so the next save
persists the same result anyway.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from graph import ENVIRONMENTS


# How many hues the canvas has to spend: `ui/src/palette.ts` ROOT_COLORS, the same
# nine the ontology table uses. A `color` stored here is always a real slot in that
# ramp -- the restart past the ninth segment happens where the curator PICKS one, so
# what lands in the file is never an index nothing can render.
COLORS = 9

_ENV_KEYS = {key for key, _label, _dsn in ENVIRONMENTS}


class Segment(BaseModel):
    """One pile. `x`/`y` is the circle's centre on the canvas, and it is load-bearing
    rather than decorative: the queue's segment order is read off these positions
    (top-to-bottom, then left-to-right), so moving a circle is how the curator ranks
    it. There is no separate order field to disagree with the canvas."""
    model_config = ConfigDict(extra="forbid")

    id: UUID
    # Both start empty: a circle is dropped first and named after, if at all. An
    # unnamed pile is still a pile -- the colour and the position identify it.
    name: str = ""
    note: str = ""
    color: int = Field(ge=0, lt=COLORS)
    x: float
    y: float


class SegmentState(BaseModel):
    """A whole canvas. Members are keyed BY DOCUMENT, which is what enforces "a
    document is in at most one segment" -- there is nowhere to write a second."""
    model_config = ConfigDict(extra="forbid")

    segments: List[Segment] = Field(default_factory=list)
    members: Dict[UUID, UUID] = Field(default_factory=dict)   # document -> segment
    updated_at: Optional[str] = None

    @model_validator(mode="after")
    def _coherent(self) -> "SegmentState":
        ids = [s.id for s in self.segments]
        if len(set(ids)) != len(ids):
            raise ValueError("two segments share an id")
        known = set(ids)
        orphans = {str(d) for d, s in self.members.items() if s not in known}
        if orphans:
            raise ValueError(
                f"{len(orphans)} document(s) assigned to a segment that isn't here")
        return self

    def count(self, segment_id: UUID) -> int:
        return sum(1 for s in self.members.values() if s == segment_id)


EMPTY = SegmentState()


# --- the two normalizations -------------------------------------------------

def drop_empty_segments(state: SegmentState) -> SegmentState:
    """Forget every segment with no documents in it. Applied on save."""
    live = {s for s in state.members.values()}
    return SegmentState(
        segments=[s for s in state.segments if s.id in live],
        members=dict(state.members),
        updated_at=state.updated_at,
    )


def prune(state: SegmentState, pending_ids: Iterable[UUID]) -> SegmentState:
    """Drop what the queue has moved past: memberships whose document is no longer
    pending, and then any segment those memberships were holding up.

    `pending_ids` is the queue as it stands right now. A document missing from it
    has been reviewed or dismissed -- either way it has left the queue, so its pile
    membership describes nothing. This is the only place that fact enters the file's
    world, which is why it runs on every read rather than on a hook somewhere.
    """
    live: Set[UUID] = set(pending_ids)
    kept = {d: s for d, s in state.members.items() if d in live}
    return drop_empty_segments(SegmentState(
        segments=list(state.segments), members=kept, updated_at=state.updated_at))


# --- the file ---------------------------------------------------------------

def state_path(env: str, directory: Optional[Path] = None) -> Path:
    """Where this environment's canvas is kept. The environment is in the FILENAME
    rather than in a directory, for the reason `queue_report` gives: one glance at a
    listing should say which guides have been organized and when."""
    if env not in _ENV_KEYS:
        raise ValueError(f"unknown environment: {env!r}")
    return (directory or Path(__file__).parent) / f".queue_segments.{env}.json"


def load(env: str, directory: Optional[Path] = None) -> SegmentState:
    """This environment's saved canvas, or an empty one.

    Every failure short of a bad environment name reads as empty rather than
    raising -- missing file, unreadable, truncated JSON, a shape from some older
    version of this module. That is `load_active_env`'s rule and it applies for the
    same reason: a corrupt scratchpad should cost the curator an afternoon's
    sorting, never a server that won't answer. There is nothing here that can't be
    rebuilt by dragging.
    """
    path = state_path(env, directory)
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return EMPTY
    try:
        return SegmentState.model_validate(raw)
    except ValueError:
        return EMPTY


def save(env: str, state: SegmentState,
         directory: Optional[Path] = None) -> SegmentState:
    """Write the canvas, and return what was actually written.

    Normalizes first (empty segments are not saved) and stamps `updated_at`, so the
    caller never has to remember either. The return value is the point: the client
    PUT one thing and the file holds another, and it needs to know which.

    Written to a temp file and moved into place. A canvas is one JSON object -- a
    write interrupted halfway leaves a file that parses as nothing, and while `load`
    would survive that by returning empty, surviving it isn't the same as not doing
    it.
    """
    path = state_path(env, directory)
    written = drop_empty_segments(state)
    written.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(written.model_dump(mode="json"), indent=2))
    os.replace(tmp, path)
    return written
