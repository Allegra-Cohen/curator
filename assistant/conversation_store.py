"""Where the curation assistant's conversations live on disk.

One curator, one ongoing thread per environment (sandbox vs. the real guide) --
see writeups/design/CURATION_ASSISTANT_DESIGN.md. A thread is a JSON file
named for the moment it started: `conversations/{env}_{stamp}.json`. Sending
a message rewrites that same file with the growing history (and the last
resolved scope decision -- see `last_scope` below, which is what lets a
follow-up message reuse the same slice of documents instead of being
reclassified from nothing). Starting a new thread (the curator's own "clear
the context" command) leaves the old file exactly as it was and starts a
fresh one.

"Current" thread for an environment = whichever file has the newest stamp.
That's the whole rule -- there's no separate pointer or database row that has
to stay in sync with it.
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

CONVERSATION_DIR = Path(__file__).with_name("conversations")

STAMP_FORMAT = "%Y-%m-%d_%H%M%S"


@dataclass
class ConversationThread:
    env: str
    started_at: datetime
    updated_at: datetime
    history: List[Dict[str, str]] = field(default_factory=list)
    # The last scope decision that actually resolved to a slice of documents
    # (never a "clarify" -- that has no slice to remember). Handed back to
    # the classifier as `previous` next time, so a follow-up message ("the
    # second one") can reuse it instead of being classified from scratch.
    # See assistant/scope.py's question 0.
    last_scope: Optional[Dict] = None
    path: Optional[Path] = None


def current_thread(env: str, *, directory: Optional[Path] = None) -> Optional[ConversationThread]:
    """The curator's ongoing thread for this environment, or None if they
    haven't sent a first message yet (or have never used the assistant)."""
    directory = directory or CONVERSATION_DIR
    if not directory.exists():
        return None
    matches = sorted(directory.glob(f"{env}_*.json"))
    if not matches:
        return None
    return _load(matches[-1])


def save_thread(thread: ConversationThread, *, directory: Optional[Path] = None) -> Path:
    """Write a thread's current history back to its file -- its own file if
    it already has one, otherwise a new one named for when it started."""
    directory = directory or CONVERSATION_DIR
    directory.mkdir(exist_ok=True)
    path = thread.path or (directory / f"{thread.env}_{thread.started_at.strftime(STAMP_FORMAT)}.json")
    thread.updated_at = datetime.now()
    path.write_text(json.dumps({
        "env": thread.env,
        "started_at": thread.started_at.isoformat(),
        "updated_at": thread.updated_at.isoformat(),
        "history": thread.history,
        "last_scope": thread.last_scope,
    }, indent=2))
    thread.path = path
    return path


def start_new_thread(env: str, *, directory: Optional[Path] = None,
                      now: Optional[datetime] = None) -> ConversationThread:
    """Leave whatever thread was current untouched on disk, and start a
    fresh, empty one, which immediately becomes current (it has the newest
    stamp)."""
    now = now or datetime.now()
    thread = ConversationThread(env=env, started_at=now, updated_at=now, history=[])
    save_thread(thread, directory=directory)
    return thread


def _load(path: Path) -> ConversationThread:
    data = json.loads(path.read_text())
    return ConversationThread(
        env=data["env"],
        started_at=datetime.fromisoformat(data["started_at"]),
        updated_at=datetime.fromisoformat(data["updated_at"]),
        history=data["history"],
        # .get, not [...]: a thread file saved before follow-ups existed has
        # no "last_scope" key at all.
        last_scope=data.get("last_scope"),
        path=path,
    )
