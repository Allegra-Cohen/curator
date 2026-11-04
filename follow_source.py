#!/usr/bin/env python3
"""Follow, list, and enable/disable the sources Scout polls.

A source is where documents come from: one RSS feed, a lab's blog, a Substack --
plus arXiv and OpenAlex, which are sources too, just queried rather than polled.
Following one is all it takes for its posts to enter the normal review queue: a feed
is another source of candidates, exactly like OpenAlex, so dedup, tombstones, the
guide-scope gate and one-run-one-undo all apply to a Substack post unchanged.

Posts from a followed source arrive with **no concept proposals**. Nothing searched
for them by topic -- the curator followed the source, not a query -- so there's
nothing to propose, and categories get assigned at review like any other document.

This is the v1 surface, before the Sources window exists. Defaults to the sandbox;
pass --env guide to touch the real guide.

Usage:
    python3 follow_source.py list
    python3 follow_source.py follow "Import AI" https://importai.substack.com/feed
    python3 follow_source.py disable "Import AI"
    python3 follow_source.py enable  "Import AI"
    python3 follow_source.py check   https://importai.substack.com/feed
"""

import argparse
import sys

from dotenv import load_dotenv

from graph import GraphRepository, NodeType, SourceService, connect
from graph.db import env_dsn
from graph.models import Actor
from scout import FeedAdapter, SearchFailed

load_dotenv()


def _ctx(env: str):
    conn = connect(env_dsn(env))
    conn.autocommit = True
    repo = GraphRepository(conn)
    with conn.cursor() as cur:
        cur.execute("""insert into users (handle, role) values ('curator', 'curator')
                       on conflict (handle) do update set handle = excluded.handle
                       returning id""")
        uid = cur.fetchone()[0]
    return repo, SourceService(repo), Actor(id=uid, role="curator")


def cmd_list(args):
    _, svc, actor = _ctx(args.env)
    svc.ensure_builtins(actor=actor)
    rows = svc.list_sources()
    if not rows:
        print("no sources yet")
        return
    width = max(len(s.label) for s in rows)
    for s in sorted(rows, key=lambda s: (s.attributes.get("mechanism"), s.label)):
        a = s.attributes
        flag = "   " if a.get("enabled", True) else "off"
        print(f"  {flag} {s.label:<{width}}  {a.get('mechanism'):<8} {a.get('url')}")


def cmd_check(args):
    """Fetch a feed without following it -- confirm the url is right first."""
    try:
        found = FeedAdapter().search(args.url)
    except SearchFailed as e:
        print(f"FAILED: {e}")
        sys.exit(1)
    print(f"{len(found)} entries")
    for c in found[:5]:
        print(f"  · {c.title[:70]}   [{c.date or 'no date'}]")


def cmd_follow(args):
    _, svc, actor = _ctx(args.env)
    # Fetch before following: a source that was never a feed would otherwise sit in
    # the list looking quiet, which is the one failure mode worth spending a request
    # to rule out.
    try:
        found = FeedAdapter().search(args.url)
    except SearchFailed as e:
        print(f"not following — {e}")
        sys.exit(1)

    existing = svc.find_by_url(args.url)
    src = svc.upsert_source(args.label, args.url, homepage=args.homepage,
                            notes=args.notes, actor=actor)
    verb = "already followed" if existing else "following"
    print(f"{verb}: {src.label}  ({len(found)} entries available)")
    if existing and not src.attributes.get("enabled", True):
        print("  note: this source is currently disabled — `enable` to poll it again")


def _set_enabled(args, enabled: bool):
    repo, svc, actor = _ctx(args.env)
    found = [s for s in svc.list_sources() if s.label == args.label]
    if not found:
        print(f"no source labelled {args.label!r}")
        sys.exit(1)
    svc.set_enabled(found[0].id, enabled, actor=actor)
    print(f"{'enabled' if enabled else 'disabled'}: {args.label}")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--env", default="sandbox", choices=["sandbox", "guide"])
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list").set_defaults(fn=cmd_list)

    c = sub.add_parser("check", help="fetch a feed without following it")
    c.add_argument("url")
    c.set_defaults(fn=cmd_check)

    f = sub.add_parser("follow")
    f.add_argument("label")
    f.add_argument("url")
    f.add_argument("--homepage")
    f.add_argument("--notes", default="")
    f.set_defaults(fn=cmd_follow)

    for name, flag in (("enable", True), ("disable", False)):
        s = sub.add_parser(name)
        s.add_argument("label")
        s.set_defaults(fn=lambda a, _f=flag: _set_enabled(a, _f))

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
