"""The curation assistant's only door OUT of read-only mode.

graph_reader.py (the assistant's normal door into the database) is read-only on
purpose -- see that file's own docstring. This file is the one deliberate
exception: it can save a document's fetched full text, and nothing else.
Kept apart from graph_reader.py so the exception stays visible on its own,
rather than sitting quietly among a list of reads.

There is exactly one write function below, and it takes a document id and a
string of text -- no title, no label, no summary, nothing else is even a
parameter it could accept. That's what makes "can only touch full_text" true
by construction rather than by promise: there is nothing else here to call.
"""

from typing import Dict
from uuid import UUID

from doi_lookup import default_resolver
from graph import GraphRepository, NodeType, connect, env_dsn
from graph.models import Actor
from reader import NO_BODY_REASONS, Reader, fetch_best_result, split_paragraphs

# Same Reader, same settings, as api.py's own module-level `_reader` -- see
# that file. A second instance is fine; Reader holds no state that needs to
# be shared, just a requests.Session and some config.
_reader = Reader(delay=0, resolver=default_resolver())

# One user account per environment, representing the assistant itself -- kept
# distinct from the curator's own account so a fetch the assistant does on its
# own shows up in a document's history as the assistant's doing, not something
# the curator did by hand. Its `role` is still "curator" (the database only
# allows submitter/curator/admin), but its `handle` is "assistant" -- that's
# what actually distinguishes the two in the history.
#
# Cached per environment the same way api.py caches the dev curator's id: each
# database has its own `users` table, so the sandbox's assistant user id means
# nothing (and may not even exist) in the guide.
_ASSISTANT_USER_IDS: Dict[str, UUID] = {}


def _assistant_actor(env: str) -> Actor:
    if env not in _ASSISTANT_USER_IDS:
        with connect(env_dsn(env), autocommit=True) as conn, conn.cursor() as cur:
            cur.execute("select id from users where handle = %s", ("assistant",))
            row = cur.fetchone()
            if row is None:
                cur.execute(
                    "insert into users (handle, role) values (%s, %s) returning id",
                    ("assistant", "curator"),
                )
                row = cur.fetchone()
            _ASSISTANT_USER_IDS[env] = row[0]
    return Actor(id=_ASSISTANT_USER_IDS[env], role="curator")


def save_full_text(repo: GraphRepository, env: str, document_id: UUID, text: str) -> None:
    """Cache one document's fetched full text. The ONLY write the curation
    assistant can make anywhere in the graph -- see this file's own docstring.
    Touches nothing on the document besides `full_text`."""
    repo.update_node(
        document_id,
        attributes_patch={"full_text": text},
        actor=_assistant_actor(env),
    )


def fetch_and_cache_full_text(repo: GraphRepository, env: str, document_id: UUID) -> Dict:
    """Get a document's full text: return the cached copy if there is one,
    otherwise fetch it from its source URL (same call api.py's document
    viewer makes, `Reader.scrape_urls`) and cache it via save_full_text
    before returning it.

    Never raises on a bad fetch -- a paywalled, scanned, or unreachable
    document is an expected, common outcome here, not a bug. Returns
    {"ok": True, "text": ...} on success, or {"ok": False, "reason": ...}
    (a plain-English sentence, same wording api.py's readable-document view
    uses) when there's nothing to show.

    A fetch that succeeds but finds no body (a scan, a page the publisher
    blocks readers on) is cached as "" -- distinct from `None`, which means
    "never fetched" (see the `full_text` field's own note in graph/types.py)
    -- so the same dead end isn't re-fetched every time this is called. A
    fetch that fails outright (no result at all -- network trouble, a block
    that produced nothing) is NOT cached, so it's retried next time rather
    than remembered as a permanent failure.
    """
    node = repo.get_node(document_id)
    if node is None or node.type != NodeType.DOCUMENT.value:
        return {"ok": False, "reason": "That id isn't a document."}

    cached = node.attributes.get("full_text")
    if cached is not None:
        if cached:
            return {"ok": True, "text": cached}
        return {"ok": False, "reason": "Fetched previously; no readable text "
                                        "was found. Open the original to read it."}

    canonical_url = node.attributes.get("canonical_url")
    oa_pdf_url = node.attributes.get("oa_pdf_url")
    if not canonical_url and not oa_pdf_url:
        return {"ok": False, "reason": "This document has no source link to fetch."}

    r = fetch_best_result(_reader, canonical_url, oa_pdf_url)
    if r is None:
        return {"ok": False, "reason": "Couldn't fetch a readable version "
                                        "(blocked, paywalled, or unavailable). "
                                        "Open the original instead."}

    text = r.get("text") or ""
    paragraphs = split_paragraphs(text)

    if not paragraphs:
        save_full_text(repo, env, document_id, "")
        return {"ok": False, "reason": NO_BODY_REASONS.get(
            r.get("fetch_outcome"),
            "Fetched the page but found no readable text. Open the "
            "original instead.")}

    save_full_text(repo, env, document_id, text)
    return {"ok": True, "text": text}
