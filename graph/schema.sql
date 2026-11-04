-- Field-guide property graph. One nodes table + one edges table hold the whole
-- ontology (Concepts, Documents, People, Organizations and every relationship
-- between them). Per-type attribute shapes live in the app layer (graph/types.py),
-- not the DB: here `attributes` is just validated JSONB.
--
-- Design choices worth knowing:
--   * `type` is text + CHECK (not a native enum) so adding a node type is a
--     one-line constraint change, never an ALTER TYPE.
--   * Edge `type` is free text with no CHECK — the allowed edge types and their
--     endpoint rules are governed entirely by graph/types.EDGE_TYPES, so new
--     relationships (e.g. `funds`) need no migration.
--   * Soft deletes everywhere (`deleted_at`) so merges/edits are undoable; all
--     uniqueness and hot-path indexes are partial `where deleted_at is null`.

create extension if not exists pgcrypto;   -- gen_random_uuid()
-- create extension if not exists vector;  -- pgvector, when we add embeddings

-- Who is acting. One row (the curator) for now; the future multi-user auth seam.
create table if not exists users (
    id         uuid primary key default gen_random_uuid(),
    handle     text unique not null,
    role       text not null default 'curator'
               check (role in ('submitter','curator','admin')),
    created_at timestamptz not null default now()
);

-- Every Concept, Document, Person, Organization is a row here.
create table if not exists nodes (
    id         uuid primary key default gen_random_uuid(),
    type       text not null
               check (type in ('concept','document','person','organization','artifact','source')),
    label      text not null,
    attributes jsonb not null default '{}',   -- shape validated in graph/types.py
    created_by uuid not null references users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
);

-- Every relationship: subtopic_of, about, authored_by, member_of, funds, ...
create table if not exists edges (
    id         uuid primary key default gen_random_uuid(),
    source_id  uuid not null references nodes(id),
    target_id  uuid not null references nodes(id),
    type       text not null,
    attributes jsonb not null default '{}',
    created_by uuid not null references users(id),
    created_at timestamptz not null default now(),
    deleted_at timestamptz
);

-- Search terms: used by Scout to query APIs, tracked so curators can re-use or
-- reject them over time. Status tracks whether a term is active (use it),
-- rejected (skip it), or archived (old but keep the history).
create table if not exists searchterms (
    id         uuid primary key default gen_random_uuid(),
    term       text unique not null,
    status     text not null default 'active'
               check (status in ('active','rejected','archived')),
    notes      text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Audit log: every mutation with before/after. Powers undo and the "how the
-- guide evolved" history.
create table if not exists revisions (
    id         uuid primary key default gen_random_uuid(),
    entity     text not null check (entity in ('node','edge')),
    entity_id  uuid not null,
    action     text not null check (action in ('create','update','delete')),
    before     jsonb,
    after      jsonb,
    actor      uuid not null references users(id),
    created_at timestamptz not null default now()
);

-- indexes -------------------------------------------------------------------
-- Search terms: quick lookup by status (Scout needs active ones).
create index if not exists searchterms_status_idx on searchterms (status);

create index if not exists nodes_type_idx   on nodes (type) where deleted_at is null;
create index if not exists nodes_attrs_gin  on nodes using gin (attributes);
create index if not exists edges_source_idx on edges (source_id) where deleted_at is null;
create index if not exists edges_target_idx on edges (target_id) where deleted_at is null;
create index if not exists edges_type_idx   on edges (type) where deleted_at is null;

-- Dedup: one live document per canonical URL.
create unique index if not exists nodes_doc_url_uniq
    on nodes ((attributes->>'canonical_url'))
    where type = 'document' and deleted_at is null;

-- Dedup: no duplicate live edge of the same type between the same pair.
create unique index if not exists edges_triple_uniq
    on edges (source_id, target_id, type) where deleted_at is null;

-- The review queue is a hot query; index document status inside the JSON.
create index if not exists nodes_doc_status_idx
    on nodes ((attributes->>'status'))
    where type = 'document' and deleted_at is null;

-- Undo. Every revision records the DB transaction that wrote it, so a whole
-- multi-write action (a cascade delete, say) undoes as one unit; `undone_at`
-- marks a revision already reversed so it isn't reversed twice. Added by ALTER so
-- an existing database picks them up on the next migrate().
alter table revisions add column if not exists txid      bigint;
alter table revisions add column if not exists undone_at timestamptz;
create index if not exists revisions_txid_idx on revisions (txid) where undone_at is null;

-- Artifacts: curator-authored prose that sits ON TOP of the graph rather than
-- describing the field -- the guide's own scope statement, and the curator's remarks
-- on one node or on several nodes together (`remarks_on`), which is where the
-- explanation of why things relate now lives.
--
-- Sources: where documents come from -- one RSS feed, a lab's blog, arXiv, OpenAlex.
-- A node rather than an attribute on a person because a publication has many
-- writers, outlives any of them, and needs to carry edges (`writes_at` from its
-- authors, `sourced_from` on every document it produced).
--
-- `create table if not exists` above can't widen the CHECK on a database that
-- already exists, so the constraint is dropped and re-added here; both statements
-- are safe to re-run.
alter table nodes drop constraint if exists nodes_type_check;
alter table nodes add  constraint nodes_type_check
    check (type in ('concept','document','person','organization','artifact','source'));

-- `relates_to` was REMOVED from the model, not deprecated (see graph/types.EdgeType).
-- It said two concepts were linked and nothing about how; artifacts say how, and an
-- artifact spans any number of nodes where an edge spans exactly two.
--
-- Hard delete, not soft, and the revisions go too. A soft-deleted edge of a type the
-- app no longer knows would still surface in `include_deleted` traversals, and an
-- Undo replaying its creation would insert an edge whose type is in no enum -- a row
-- nothing downstream can read. Safe to re-run; a no-op once the rows are gone.
with gone as (
    delete from edges where type = 'relates_to' returning id
)
delete from revisions where entity = 'edge' and entity_id in (select id from gone);

-- Dedup: one live source per url. Following the same feed twice is a no-op, which
-- is what lets `upsert_source` be idempotent the way `submit_document` is.
create unique index if not exists nodes_source_url_uniq
    on nodes ((attributes->>'url'))
    where type = 'source' and deleted_at is null;

-- Per-source polling health. Deliberately NOT node attributes and NOT revisioned:
-- a poll is machine bookkeeping, so writing it to the node would put every poll in
-- `revisions`, pollute the audit log, and sit in front of Undo. Only what cannot be
-- derived lives here -- a *failed* poll writes nothing to the graph, so failure
-- state has nowhere else to go. Accept rate is NOT here: it is derived from
-- `sourced_from` edges at read time, because a stored counter would drift the
-- moment a document is re-categorised or a dismissal undone.
create table if not exists scout_sources (
    source_id            uuid primary key references nodes(id),
    last_success_at      timestamptz,
    last_failure_at      timestamptz,
    consecutive_failures int not null default 0,
    last_error           text
);

-- For `page` sources: which links on the page are articles and which are
-- navigation, as judged once by the model. The point is the *negatives*. An article
-- link becomes a document, so the graph remembers it and dedup drops it on the next
-- poll -- but a navigation link becomes nothing, so without this memo every poll
-- would re-judge the ~100 nav links on a busy index page forever.
--
-- Keyed per source, not globally: the same url can be a headline link on one site
-- and a footer link on another, and the judgement is about its role on *this* page.
-- Urls the pipeline has already reached a verdict on and rejected. Not a
-- tombstone: a tombstone is the *curator's* judgement ("I reject this paper") and
-- suppresses a url forever; this is bookkeeping ("we already paid to decide about
-- this one"), so a source doesn't re-scrape and re-screen the same rejects on
-- every poll. Only rejects need recording -- an accepted url becomes a document,
-- and the pipeline's existing url dedup covers it.
--
-- Consequence, accepted deliberately: editing the guide scope does NOT re-screen
-- these. Making scope edits retroactive would mean reassessing every existing
-- Document too, not just past rejects -- a far bigger operation that, if it is ever
-- wanted, belongs as an explicit and clearly expensive action in the scope editor.
-- `forget_source` is the per-source escape hatch in the meantime.
create table if not exists scout_screened_urls (
    url         text primary key,
    source_id   uuid references nodes(id),   -- null for concept-search drops
    stage       text,
    reason      text,
    screened_at timestamptz not null default now()
);

create table if not exists scout_page_links (
    source_id     uuid not null references nodes(id),
    url           text not null,
    is_article    boolean not null,
    reason        text,
    first_seen_at timestamptz not null default now(),
    primary key (source_id, url)
);
