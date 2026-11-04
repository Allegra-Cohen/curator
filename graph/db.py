"""Connection + one-shot schema migration.

The DSN comes from $DATABASE_URL, defaulting to the local dev Postgres. Nothing
here is clever on purpose — a single connection helper the rest of the package
builds on.
"""

import os
from pathlib import Path

import psycopg
from psycopg import conninfo, sql

# Local dev default (the throwaway container in the setup notes runs here). This
# is the "real" guide's database.
DEFAULT_DSN = "postgresql://postgres:fg@localhost:5433/field_guide"

# The sandbox: a separate database in the *same* container, holding the fake seed
# corpus you build against. It's the default environment (see ENVIRONMENTS) so a
# forgotten setting can never scribble on the real guide.
SANDBOX_DSN = "postgresql://postgres:fg@localhost:5433/field_guide_dev"

# The test database: same container, a different database, so a test run can
# never truncate the dev graph. Deliberately does NOT fall through to
# $DATABASE_URL — that's the whole point (see tests/conftest.py).
TEST_DEFAULT_DSN = "postgresql://postgres:fg@localhost:5433/field_guide_test"

# The selectable data environments, in menu order. Each is a wholly separate
# database; the UI's environment picker flips which one the API talks to. The
# sandbox leads and is the default (DEFAULT_ENV) — switching to the real guide is
# a deliberate act, not what you land on by forgetting a setting. $DATABASE_URL
# still points the guide wherever you like (the config-not-rewrite seam for a
# hosted deploy); $SANDBOX_DATABASE_URL does the same for the sandbox.
ENVIRONMENTS = [
    ("sandbox", "Sandbox", os.environ.get("SANDBOX_DATABASE_URL", SANDBOX_DSN)),
    ("guide", "Field guide", os.environ.get("DATABASE_URL", DEFAULT_DSN)),
]
DEFAULT_ENV = "sandbox"
_ENV_DSN = {key: env_dsn for key, _label, env_dsn in ENVIRONMENTS}

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

# Where the picker's choice is remembered across API restarts. It can't live in
# either environment's database — the whole point is knowing which one to open —
# so it's a one-line file beside the package (gitignored: it's this machine's
# state, not source).
#
# This deliberately replaces the old "every boot lands on the sandbox" rule. That
# rule guarded against scribbling on the real guide by accident, which was right
# while the guide was empty and the sandbox was the workspace. Now that the real
# guide IS the workspace, the live hazard runs the other way: restart the server
# mid-session, forget, and pour an afternoon of curation into the sandbox. What
# actually protects you is knowing where you are, which is the picker's job (it
# warms to amber on the real guide) — not a default that silently moves you.
ACTIVE_ENV_PATH = Path(__file__).resolve().parent.parent / ".active_env"


def load_active_env() -> str:
    """The remembered environment, or DEFAULT_ENV if there isn't a valid one.

    Any problem — missing file, unreadable, a key that no longer exists in
    ENVIRONMENTS — falls back to the default rather than raising. A corrupt state
    file should cost you one menu click, not a server that won't boot.
    """
    try:
        env = ACTIVE_ENV_PATH.read_text().strip()
    except OSError:
        return DEFAULT_ENV
    return env if env in _ENV_DSN else DEFAULT_ENV


def save_active_env(env: str) -> None:
    """Remember ``env`` as the active environment for the next boot."""
    if env not in _ENV_DSN:
        raise ValueError(f"unknown environment: {env!r}")
    ACTIVE_ENV_PATH.write_text(env + "\n")


def dsn() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_DSN)


def test_dsn() -> str:
    return os.environ.get("TEST_DATABASE_URL", TEST_DEFAULT_DSN)


def env_dsn(env: str) -> str:
    """The DSN for a named environment ('sandbox' / 'guide')."""
    if env not in _ENV_DSN:
        raise ValueError(f"unknown environment: {env!r}")
    return _ENV_DSN[env]


def connect(dsn_override: str = None, autocommit: bool = False) -> psycopg.Connection:
    """Open a new connection to the field-guide database.

    Pass ``dsn_override`` to target a specific database (the API picks the active
    environment's DSN this way, and the test suite its own); otherwise the DSN
    comes from $DATABASE_URL / DEFAULT_DSN.
    """
    return psycopg.connect(dsn_override or dsn(), autocommit=autocommit)


def ensure_database(target_dsn: str) -> None:
    """Create the database named in ``target_dsn`` if it doesn't exist yet.

    Connects to the ``postgres`` maintenance database on the same server and
    issues ``CREATE DATABASE``. Idempotent: a race or a pre-existing database is
    fine. Used to make a fresh environment (sandbox, guide, or the test DB)
    self-provisioning — no manual ``createdb`` step to remember.
    """
    try:
        psycopg.connect(target_dsn).close()
        return
    except psycopg.OperationalError:
        pass  # Most likely the database doesn't exist yet — create it below.

    info = conninfo.conninfo_to_dict(target_dsn)
    dbname = info["dbname"]
    admin_dsn = conninfo.make_conninfo(**{**info, "dbname": "postgres"})
    with psycopg.connect(admin_dsn, autocommit=True) as admin, admin.cursor() as cur:
        try:
            cur.execute(sql.SQL("create database {}").format(sql.Identifier(dbname)))
        except psycopg.errors.DuplicateDatabase:
            pass  # Created concurrently — fine.


def migrate(conn: psycopg.Connection = None) -> None:
    """Apply schema.sql. Idempotent (every statement is IF NOT EXISTS)."""
    own = conn is None
    conn = conn or connect()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA_PATH.read_text())
        conn.commit()
    finally:
        if own:
            conn.close()
