
# Purpose of the tool

This is a tool for curating documents using a property graph and an ontology. It has a few functions: Scouting for new stuff to read; helping you manage a property graph of documents, concepts, entities and remarks; and drafting remarks that link directly into the property graph. I use it to manage the knowledge base for the Field Guide to Thinking for Ourselves in the Age of AI (https://www.seewhatuthink.com/field-guide).

# Limitations
A couple of limitations to know about right off the bat:
- The scouting function in this tool is not at all comprehensive, and very little automated assistance is added to help you get a grip on a new area. This suits my own current tolerance for machine help, but you might want to tinker.
- This tool more or less ends with the generation of the property graph. My version has a "viewer" tab that lets you see remarks in the html format of my website with the visualizations I designed for the Field Guide. That's kind of my thing right now, so I didn't include it here. You can hook it up to whatever you want – your own website, your own visualizations, etc.

# Major functions
## Classes and components
This tool basically exists to curate documents into a property graph. We have the following node types:
- Document, which can be a paper, a Substack blog, a website, or what-have-you. Documents have authors, publication dates, abstracts, and links to their existence on the web. They also have summaries that you write and Concepts that you assign.
- Concept, which is an ontological concept you've decided is useful to your mental model. Concepts have definitions, strings that the scout uses for semantic and keyword search, and lists of Documents. 
- Entities, either people or organizations. People can have names, ORCIDs, and they can write_at places on the web and belong_to organizations. Organizations can also write_at places on the web.
- Remarks, which are texts that you write about Concepts that can reference Concepts and Documents. (These are called Artifacts in the UI, sorry.)

When you start using the tool, you'll do a few things regularly:
- Create, delete and move around Concepts in the Ontology viewer (top right panel)
- Edit Concept definitions in the bottom right panel.
- Assign Concepts to Documents that are hanging out in the Review Queue (left column.) 
- Add summaries to Documents in the bottom left panel, and check that the machine extractions are correct for, e.g., authors. Authors appear as blue chips and can be edited by clicking.
- Read Document contents either in the top left panel or by clicking the link to its web presence (if the curator can't fetch the text or the formatting is ugly.)
- Run searches to add Documents to the queue.

## Inputs
The curator takes in Documents via two avenues:
- Running a search via scout.py, or
- Links dropped by hand using the + button at the top of the review queue

Searches happen via the ontology, e.g., you can say "I want to run a new search on the concepts of Memory and Human flourishing." The curator searches arXiv, OpenAlex, and whatever other resources you've added to the Sources window (e.g., someone's research blog), using the keyword and semantic search phrases you've assigned to those concepts you've selected. The results are filtered in two steps using an LLM: The global scope that you set via the Scope window, and a relevance filter that uses the ontological concepts again.

Retrieved documents that aren't duplicates and haven't already been dismissed will appear in the queue. Or, you can just drop a link in yourself if you already know what you're looking for. On ingest, the tool will try to resolve authors based on ORCID but it won't always succeed.

## The queue
The goal of the queue is to get Documents into the property graph by assigning them Concepts. Documents are initially organized with peer-reviewed journals at the top, then other kinds of publications (e.g., magazine articles), then preprints.

If you want to edit the authors, publication date and venue, and abstract of a Document, you can. You can also write summaries. If you don't like a document in the queue, you can dismiss it with the "delete document" button – add a dismissal note by writing it in the summary box. Dismissed documents don't get put back in the queue on future searches, but you can add them yourself manually.

Sometimes the queue fills up with like, hundreds of documents. There's a spatial organization view that you can access by clicking the little bubble-icon button up top. This opens up a canvas where you can drag documents into color-coded category circles that you can name and make notes about. When you exit out of this view, the queue will reorder to match the organization on the canvas and the documents will be colored their categorized color.

If you hook up an API key, the tool will also generate a queue report by embedding abstracts of returning documents and doing some clustering. I didn't find this to be particularly helpful but I included it anyways.

## Ontology and concept assignment

Build your ontology however you want! Or don't – swap this out for whatever kind of mental model suits you. Concepts can have sub-concepts, which is why we're calling it an ontology. But really it's just a filing system for Documents.

There's some fossilized code in here for pivot tables because I had thought to visualize, e.g., a heat map of Concepts or a histogram of number of papers per entity. I didn't find it useful enough to keep working on, but it's there if you want it.

## Artifact/remark creation

As I mentioned, the point of this tool for me personally is to manage the references that go into my posts on the Field Guide. Thus I use the Artifacts window to link the text of those posts to the underlying property graph nodes. I'm really not sure if this is a useful window for anyone else, but do with it what you will.

# Minor functions
I designed this to have a sandbox mode so I can develop without jeopardizing an active review queue.

# Parts under construction / suggested improvements
## Chatbot with tools
As sort of a successor to the queue reports, I added a curation assistant, reachable via the little dialogue bubble in the top right panel. In theory it ought to be able to manage your graph for you if you ask things like "Combine these two concepts" or "How many papers in this concept are studies versus review papers?" It's supposed to have spatial awareness of the UI, so, for example, if you ask it about "this paper," it will look at the Document you have open in the left half of the screen. I stopped developing this because I found I didn't need it, but I suspect it could be pretty useful for managing very large corpora if somebody fixed up its toolbox.

## Better scouting
The scouting is bad! I've wondered if I ought to add something like Elicit. Papers don't come back with much of a quality filter, there's no active discovery beyond keyword and semantic search, and often you don't want to search via ontological concept so much as general vibes. Whether this matters really depends on how comprehensive you're trying to be and how much you already know about a topic.

# Further documentation
Below is Claudish describing the tool in more detail.



**Core graph & curation** — The data layer (448 tests) and a **curator web app** are
built and working end-to-end. A scraper feeds documents in as `pending` nodes; the human
curator reviews each in the UI — reading it, writing its summary, and assigning concepts by
searching for them — then saves, which categorizes the document as `reviewed`and drops it from
the review queue.

```
Scrape (Reader) ─► pending documents ─► curator UI (read · summarize · categorize) ─► ontology
```

Documents can be **mass-categorized** by multi-selecting them in the list and dragging
them onto a concept.

The curator also **shapes the ontology from the UI**. A concept's name, description,
semantic search text, keywords and criteria are editable. The structure of
the entire ontology is now editable too — the curator can **create** a concept, 
**delete** it with a cascade preview, and **move** concepts around (e.g., put a
concept underneath a new parent, or duplicate a concept if it belongs to two.)
See [Editing the ontology](#editing-the-ontology).

Every change to the property graph is **undoable** from the "undo" button in the 
curator view header. The curator can also use the header to switch between two 
databases — a fake **sandbox** for code development and the real **guide**. 
See [Environments](#environments).


Determining **document authorship** is partially automated. `Person` nodes aren't automatically
created because the system can't tell a person from an organization. Instead, the system
scrapes the authors, shows them on the document the curator is reviewing, and also
checks the names against the graph to see if any of the entities exist already and can
be assigned (ORCID first, then the name in either "First Last" or "Last, First" order,
or any alias). New entities only become nodes upon Save, giving the curator an opportunity
to correct bad extractions. Scraped authors are **credited by
default** and dropped with `✕`; one that isn't in the guide yet is badged **NEW** with
the entity type (person/org) it will be created as, and the curator can click to
open a window for editing details as well as changing the entity type. 
See [Authors and entities](#authors-and-entities).

The ontology table also **pivots** (113 UI tests): rows stay concepts, columns
become concepts / people / funders, and every cell holds the documents at that
junction. That's what turns the guide from a filing system into something you can
ask questions of — most usefully *which concepts keep co-occurring with no link
drawn between them*. See [The ontology table](#the-ontology-table).

**Scout discovery** — the front of the funnel is wired: **⌕ Run search** in the header
searches arXiv and OpenAlex for every concept, polls every followed source, filters
the results, and files what survives into the review queue as `pending`.

```
                    ┌─ scope (an Artifact) ─┐
                    ▼                       ▼
concepts ─► keywords ───────→ arXiv ──► LLM filter ──┐
        └─► semantic query ──→ OpenAlex semantic ──┤
sources ─► RSS/Atom feed ───────────────────── ┴─► queue (with proposed concepts)
```

The **concept is the search unit** — a concept's `semantic_query` is the semantic query and
its `keywords` are the boolean one. These are defined by the human curator.
Concept `description` is the definition a reader sees (the two were
one field until 2026-08-07, but splitting them allows the description to have, e.g.,
citations for the definition that would be useful for humans but skew search results.) 

The **guide's scope statement** (a curator-authored [Artifact](#artifacts),
edited from the **SCOPE** button) is appended to semantic queries
as context and is also the premise the LLM filter screens against for both semantic and
keyword search. Documents arrive with the concepts that found them **proposed** rather than 
assigned. Dismissed documents are tombstoned so re-runs don't re-propose them. The curator
can write dismissal reasons in the summary box of a document and a running dismissal report is 
kept. See [Scout](#scout--discovery).

Curators can manage the sources Scout looks at from the **SOURCES** window in the header.
There the curator can add or delete the feeds and index pages the Guide draws from,
with per-source health, a derived accept rate, and a one-click poll. Followed feeds
and feed-less index pages both enter the same funnel as OpenAlex. See
[Sources](#sources).

Documents can also be **added by hand** to the review queue. A **`+`** in the review queue's own
header takes pasted URLs straight in. Re-pasting something you dismissed **restores the
original** even if it was tombstoned. When a site blocks automated fetching outright, a
**manual-entry fallback** lets the curator type the document in — title, and the full
text too if they can copy it themselves. See
[Adding a document by hand](#adding-a-document-by-hand).

**Curation assistant** — a chat window behind the 💬 toggle in the curator app, backed
by Claude Haiku 4.5. It answers questions about the queue and the approved graph —
using only what it's actually shown, never inventing a document or a fact — and can
build a table of real, exact quotes from a set of papers answering a question, rather
than writing its own summary of what they say. Clicking a quote's paragraph number
opens the Document Viewer scrolled right to it. Read-only for now: it can look at the
graph but not change it, even if asked. See [Curation assistant](#curation-assistant).

**Not built yet**: the summarizer, a review *page* for dismissed documents (there is a
regenerated file — see [the dismissal report](#why-it-was-dismissed-and-the-dismissal-report)), the Scout
run-history UI, per-concept scope exemption, **merging and splitting entities** (the
remaining half of first-class people — see [PEOPLE_DESIGN.md](writeups/design/PEOPLE_DESIGN.md)), the
remaining ontology-structure verbs in the UI (**relating** and **merging** concepts —
create / rename / delete are done), the curation assistant taking any action beyond
answering questions (deliberately read-only so far), and — the one that blocks the
rest — any way to say **why** two concepts are related. See [Roadmap](#roadmap).

## Architecture

The graph is a single `nodes` table + single `edges` table. Per-type structure is
enforced in the **app layer** (`graph/types.py`), not the database — so new node
types are a small change and new edge types (like `funds`) need no migration.

Layered, each layer built only on the one below it:

| Layer | File | Responsibility |
|---|---|---|
| Schema | `graph/schema.sql` | `users`, `nodes`, `edges`, `revisions` + indexes |
| Types | `graph/types.py` | node/edge type registry, pydantic attribute schemas, validation |
| Models | `graph/models.py` | `Node` / `Edge` / `Graph` / `Actor` dataclasses |
| DB | `graph/db.py` | connection + `migrate()` |
| Repository | `graph/repository.py` | the only SQL layer for the graph: CRUD, traversal (`neighbors`, `follow`), merge |
| Scout state | `graph/scout_state.py` | Scout's own non-graph tables: source health, page-link memo, screened urls |
| Integrity | `graph/integrity.py` | structural rules needing the graph (cycles): enforce + scan |
| Services | `graph/services.py` | curator verbs (Ontology / Ingestion / People / Query) |
| Bridge | `graph/ingest.py` | `Reader` scraper *or* Scout candidates → `IngestionService` |
| Scraper | `reader.py`, `extractors.py` | fetch + extract article metadata |
| Discovery | `scout.py`, `relevance_filter.py` | search APIs, feeds + the LLM relevance gate — no graph imports |
| Composition | `discovery.py` | the only module that knows about both the graph and Scout |
| API | `api.py` | FastAPI HTTP layer — a thin JSON skin over the services |
| UI | `ui/` | React curator app (documents · ontology · pivots) |

Scout is deliberately graph-agnostic: it takes plain `SearchItem`s and returns
`Candidate`s, so it can be exercised (and its results eyeballed) with no database at
all. `discovery.py` is the seam that turns concepts into the one and the results into
the other.

`/api/ontology` is concepts + structural edges; `/api/graph` is everything. The
pivots need the second, because every cell is built from `about` edges the first
doesn't carry — and the derivation stays client-side and pure so it can be tested
without a browser. The tripwire for moving pivots into SQL is payload size.

**Node types:** `concept`, `document`, `person`, `organization`, `artifact`, `source`.
**Edge types:** `subtopic_of`, `prerequisite_of`, `about`,
`authored_by` (document → person **or organization**), `member_of`, `part_of`,
`works_on`, `funds`, `writes_at` (person **or organization** → source),
`sourced_from`, `remarks_on` (artifact → **any** node), `cites` (artifact → document).

### Artifacts

Every other node type contains direct content from the world: Documents, authors, etc. 
An **artifact** is the curator's own writing *about the curation*. There are 
two kinds:

- the **guide scope** (`kind="guide_scope"`), the singleton stating what the guide
  covers, used to screen discovery results
- **remarks** (`kind="note"`), the curator's commentary on one node or on several
  nodes together, attached by `remarks_on`. These are the core content of the Guide,
  the points of entry for readers.

**The number of subjects is not a type distinction.** One subject (a document, a concept) 
is a note on a thing ("what I think about Literacy"); several is a note on how those things 
relate ("what Literacy has to do with these documents and this other concept"). 
A remark discussing subjects does not imply other relations in the graph (e.g., a remark
indicating that Concept X drives Concept Y does not create an actual edge between
those concept nodes.)

A remark over several subjects is a **hyperedge**: a relation over a *set*, not a pair.
That's why it has to be a node — an edge is arity-2 by construction, and a remark on 
three concepts is not three remarks.

Remarks **link to subjects in the Guide, inline**, in markdown link syntax:
`…which [this survey](node:0f3a91c8-…) settled`. Insertion is a Cmd+K picker over
highlighted text — see [Linking the prose to the guide](#linking-the-prose-to-the-guide). 
The **body is authoritative**: `cites` edges are a projection rebuilt from it on every save, so a
citation can't outlive the sentence that made it. A broken link is reported, never
fatal to a save.

Artifacts carry a `visibility` (`public | private`, **default private**) — the one
place the **reader/curator boundary** lives. The rest of the graph is public (a reader
sees a concept's description, a document's summary); an artifact is the curator's own
voice and is private until published. The same flag doubles as the draft / working-note
mechanism.

A note about edges: The property graph currently does not purport to create any
semantic edges between concepts, e.g., "X causes Y." We stick to who wrote what,
who works where, etc. In fact, the `relates_to` was **removed**. It might be worth
bringing these back if we want machine-assisted causal modeling, but that is a big
lift and so better to design from scratch. See [ARTIFACTS_DESIGN.md](writeups/design/ARTIFACTS_DESIGN.md).

Design decisions baked in: UUID keys, soft deletes (`deleted_at`), an
in-transaction `revisions` audit log — which also **powers Undo**: every revision
records the DB transaction that wrote it (`txid`), so a whole action (a cascade
delete, say) reverses as one unit — a `submitted_by`/`status` document workflow,
and everything client-server from day one — all so the eventual jump to a
multi-user, hosted deployment is config, not a rewrite.

## Setup

**1. Postgres.** For local dev, one Docker container holds every database (all
three environments — see [Environments](#environments) — plus the test DB live
in it side by side):

```bash
docker run -d --name fg_pg \
  -e POSTGRES_PASSWORD=fg -e POSTGRES_DB=field_guide \
  -v fg_pgdata:/var/lib/postgresql/data \
  -p 5433:5432 postgres:16
```

The data lives in the named `fg_pgdata` volume, so `docker rm fg_pg` (or a
restart) no longer takes it with the container. To wipe everything deliberately,
remove the volume too: `docker volume rm fg_pgdata`.

**2. Python deps:**

```bash
pip install -r requirements.txt
```

**3. Schema.** No manual step — the databases are self-provisioning. The API
creates and migrates every environment on startup, and `seed_dev.py` does the
same for the sandbox, so a fresh container needs nothing but the seed. (To do it
by hand anyway: `python3 -c "from graph import migrate; migrate()"` migrates the
real guide; set `$DATABASE_URL` first to point elsewhere.)

### Environments

The app talks to one of two interchangeable databases, picked live from a **Data**
menu in the app header:

| Environment | Database | For |
|---|---|---|
| **Sandbox** (default) | `field_guide_dev` | The fake seed corpus you build against. |
| **Field guide** | `field_guide` | The real guide. Starts empty. |

The sandbox is the default so a forgotten setting can never scribble on the real
guide; switching to the guide is a deliberate act, and the picker turns amber to
say so. The choice is server-side state that resets to the sandbox on restart —
a reboot always lands somewhere safe. `$DATABASE_URL` still points the guide at
any Postgres (a native install, a managed service — the config-not-rewrite seam);
`$SANDBOX_DATABASE_URL` does the same for the sandbox.

## Usage

Scrape URLs into the graph as pending documents:

```python
from graph import connect, GraphRepository, IngestionService, IngestionBridge, GraphQueryService
from graph.models import Actor
from reader import Reader

conn = connect()
repo = GraphRepository(conn)
bridge = IngestionBridge(IngestionService(repo), Reader())

report = bridge.ingest_urls(["https://…"], submitted_by=actor)
print(report.summary())            # "N ingested, M duplicate, K failed"

queue = GraphQueryService(repo).review_queue()   # documents awaiting review
```

Or let discovery find them — search every concept and file the survivors (the same
thing the **⌕ Run search** button does; see [Scout](#scout--discovery)):

```python
from discovery import DiscoveryService

svc = DiscoveryService(repo, openalex_key=..., anthropic_key=...)
candidates, meta = svc.discover()          # network only — no writes
report = bridge.ingest_candidates(candidates, submitted_by=actor)
print(meta["candidates"], "found,", meta["dropped"], "filtered out")
print(report.summary())                    # "... , N previously dismissed"
```

### Proposed concepts 

A document in the review queue arrives with the concepts whose searches surfaced
it as proposals, shown above the assignment area as **green dashed chips**, with ✓ to accept and
× to dismiss. Accepting one gives it a normal blue chip.

Two decisions worth knowing:

- **Concept proposals are node attributes (`proposed_concept_ids`), not `about`
  edges.** Every pivot cell is built from `about`, so concept proposals stored as
  edges would inflate
  co-occurrence counts before anyone agreed to them — and the pivot is only worth
  reading because a number there means *evidence*. An `about` edge keeps meaning
  exactly one thing: the curator said yes.
- **Concept proposals sit outside the assignment set**, so Save can't silently accept
  one the curator never looked at. The alternative — pre-seeding them — is one click faster
  and inverts the rule that automated help is opt-in.
- **Save consumes every concept proposal**, accepted or not. Save is gated on
  assigning at least one concept, so a concept proposal still sitting undecided when
  Save lands was passed over deliberately: undecided at Save means denied.
  `set_concepts` empties `proposed_concept_ids` either way — an accepted concept
  proposal is an `about` edge now, and a passed-over one is a decision, not an
  outstanding question. It used to store whatever was left undecided, which let a
  document that had already left the review queue keep offering concept proposals. A
  document out of the queue is not proposed to.

Ids, not labels, so renaming a concept doesn't orphan its concept proposals.
(`searchterms` still holds labels; that's display provenance, not a link.)

**A document with no concepts belongs in the queue.** Status is derived from
categorization, never set on its own: saving an empty concept set un-files the
document and returns it to `pending`. (It used to mark it reviewed regardless, which
left it reviewed-but-uncategorized — absent from the queue *and* from every concept,
reachable from nowhere.) Deleting a concept applies the same rule, re-queueing only
documents whose *last* category it strips.

### The left column is either the review queue or a list of documents from a concept

You can either browse through the review queue, or click a concept's document list
to look at them more explicitly. You can edit the documents in either case – approving
or dismissing in the first case, editing a summary or something else in the second.
Thus saving is handled differently depending on if you're reviewing or browsing:

- **Queue** — the row tints green with a ✓ and the next unreviewed document opens.
  The tint is *temporary by construction*: `set_concepts` marks the document
  reviewed, so the server has already dropped it from the queue and a refetch could
  never return it in that state. It means "you did this one just now" — a fact about
  the sitting, not the document — and expires the next time you open the queue.
- **Anything else** — it saves and its row stays put in the column.

### Correcting scraped metadata

Scraping mangles two fields often enough to fix in place, each with its own small
save — correcting metadata shouldn't force a review, so neither touches status or
assignments:

- **Title** — an `edit` link beside it in the details panel. Writes both
  `attributes.title` and the node `label`, which are set together at ingestion and
  fall back to each other everywhere; updating one alone leaves the bad scrape
  showing in list tooltips and the delete dialog. Blank is refused.
- **Abstract** — **+ Add abstract** in the viewer when there is none, an `edit` link
  when there is. Discovery fills this from the search APIs, but not every record has
  one, and a human can often reach what a bot blocker denied us.

- **Publication and date** — plain fields in the details panel, sharing one save.
  Blank clears them: a document may legitimately have no venue and no date.

Authors are their own thing, since correcting one means correcting a *node* rather
than a string — see entity_management.md.

### Adding a document by hand

Not everything worth filing arrives through a search. The **`+`** in the review
queue's header opens a paste box — one URL per line — and Reader fetches each one into
the queue as `pending`, uncategorized, with nothing proposed. It's the other end of
the funnel from ⌕ Run search: discovery brings back what the concepts asked for, this
takes what the curator already found in the wild. One paste is one undoable action,
however many URLs it held.

**A dismissed URL is restored, not refused.** Everywhere else a tombstone means "never
offer this again", which is exactly right for a re-run that would otherwise re-propose
rejected papers forever. A deliberate paste is the opposite situation: it's a *newer
judgement* than the dismissal, so it wins, and the original document comes back — same
id, same summary, and the `about` edges the dismissal took with it. Clearing
`dismissed` is what lifts the tombstone, since that flag is exactly what
`tombstoned_urls` reads.

That restore is what the affordance was waiting on. The unique url index is partial
(`where deleted_at is null`), so nothing at the database level stopped a re-add from
standing a live document *beside* a dismissed one for the same url — one of them
invisible, still suppressing the other from every search.

Two details follow from "restore, don't re-ingest":

- **Which edges come back is decided by timestamp, not by type.** A cascade stamps its
  edges and its node with one transaction clock, so an `about` edge the curator
  un-assigned last week carries a strictly older `deleted_at` and stays gone. That was
  its own judgement, and a restore says nothing about it.
- **Status stays derived.** A document that was reviewed and filed before someone
  dismissed it comes back reviewed and filed; only one with nothing on it lands in the
  queue. Same rule as everywhere else — see [Proposed concepts](#proposed-concepts).

The box reports its outcome in **buckets rather than a count** — added, restored,
already in the guide, couldn't be fetched, not a web address — because "nothing
appeared" has four causes and they want different responses. A bot-blocked fetch and
an already-known URL are indistinguishable from a number. Whatever didn't land stays
in the box, so a retry is the failures and nothing else.

**Provenance is the `sourced_from` edge**, as for any other document: hand-added ones
point at a single **Added by hand** source node (`mechanism="manual"`), listed in the
SOURCES window with no poll button and nothing to switch off. It's one shared node,
not one per curator — *who* added a document is `nodes.created_by`, a hard FK to
`users` written on every node already, and copying that into a source node would
duplicate a fact into a place that can drift from the one that owns it. Users aren't
nodes for a reason: the graph describes the field, and a curator is who operates the
tool. Its url is a urn (`urn:field-guide:manual`) so nothing can mistake it for
something to fetch, and `SourceService.feeds()` is now an allowlist of pollable
mechanisms rather than "everything that isn't `api`" — the denylist failed open.

#### When a fetch fails: adding a document manually

Some sites block automated fetching outright (a 403, a bot wall), and Reader can't
get anywhere near the article. Rather than the URL just vanishing into the "couldn't
be fetched" bucket, each one there carries an **add manually** link, opening a small
form pre-filled with that URL: Title (required — there's no scraper here to have
found one) and, optionally, authors, publication, date, a short abstract, and the
**full text**, for a curator who can still get the page open themselves and copy it
in.

**Pasted full text is cached, not stored as a permanent copy.** The rest of the
guide deliberately keeps no lasting copy of an article's body — the Document Viewer
re-fetches the live page every time someone wants to read it, which is why the guide
never rots into holding stale text a publisher has since changed. That re-fetch is
exactly what fails for these documents, though, so pasted text goes into the one
existing exception: the `full_text` slot the curation assistant already uses to
cache a page it fetched for itself (see `assistant/text_writer.py`). Landing there
means the Document Viewer shows the pasted text immediately instead of re-attempting
a fetch that's already known to fail.

Otherwise it's the same document, filed the same way: `pending`, uncategorized,
provenance is the same **Added by hand** source node, and a URL matching an old
dismissal is restored rather than refused — see
[Adding a document by hand](#adding-a-document-by-hand) above for why.


### Guide references

The guide writes about itself in three places — a document's **Summary**, a concept's
**Description**, a remark's **body** — and all three go through the same markdown
renderer. **⌘K** over selected text opens one picker and wraps the selection in a link
to anything in the guide: a document, a concept, a person, an organization, another
remark. The highlighted words stay exactly as written; only the link is added.

This was a citation picker, documents-only, which meant the curator's own guide refused
to let them point at half of it.

**One scheme, and the type is not in the link.** A link is `[anchor](node:<uuid>)` —
never `person:` or `doc:`. Ids are unique across node types, so the graph already knows
what a target is; encoding it in the link duplicates that and can go stale, since
`retype` turns a person into an organization *in place*, keeping the id. So the link
says only "this points inside the guide", and what it points at is a lookup. (`doc:` is
still read, because bodies written before this hold it. Nothing writes it.)

**What a link becomes is decided against the graph, not against the text.** A link to a
document still makes a `cites` edge — that is a claim the prose rests on a paper. A link
to a concept makes nothing: `remarks_on` is how a remark says what it is *about*, and an
inline mention must not quietly add a subject. So the remark editor's **References**
block lists the documents and leaves the rest to the prose, while an id that resolves to
*nothing* is still flagged in red — two states a type-free link would otherwise make
identical.

**Three ways to find the target**, because the curator is mid-sentence and looking
something up must not become a research task:

- by its own name, any node type
- by a document's **author** — "I remember Baddeley wrote it, not what it was called"
- by a document's **venue** — "that Nature piece"

A hit found by author or venue shows *why* it's there (`via Alan Baddeley`); without
that, a result whose words you never typed reads as a bug in the search. Unreviewed
documents never appear — a picker is exactly where an unapproved document must not be —
and sources aren't offered, because the reader has no page for one and the link would
land nowhere.

**Unpublished remarks are offered, and badged.** You write the sentence before you
publish the thing it points at. For a reader that link degrades to plain words, so the
picker says so on the row rather than hiding it.

A link that resolves to nothing a reader may see renders as its plain anchor text — never
as a link that goes nowhere. That covers link-rot, a mangled id, and an unpublished
target, in one rule.

### Curation assistant

A chat window behind the 💬 toggle, backed by Claude Haiku 4.5. It answers questions
about the **queue** (documents not yet reviewed) and the **approved graph** (already
categorized) — nothing it wasn't actually shown, and it says so rather than guessing
when a question is ambiguous ("the queue, the approved documents, or both?").

Before answering, a small classifier decides how much of the graph to hand over — the
whole graph is never sent in one message. It also recognizes a follow-up ("the second
one," "why is that included") and reuses what was already resolved rather than asking
the same question twice.

**Evidence, not summary.** Given a question and a set of documents, the assistant can
build a table of real quotes instead of writing its own description of what a paper
says — one row per document, one column per part of the question. Each cell is the
actual paragraph(s) that answer that part, sliced out of the paper's real text, never
retyped or paraphrased by the model; a cell with nothing says `not found` rather than
stretching a paragraph to fit. Clicking a quote's paragraph number opens the Document
Viewer scrolled right to it, briefly highlighted.

**Read-only.** The assistant can look at the graph but not change it, even if asked.
Its one narrow exception is caching a paper's full text the first time it's read, so
asking about the same paper again doesn't re-fetch it, and so a quote's paragraph
number stays pointing at the same paragraph later.

See [CURATION_ASSISTANT_DESIGN.md](writeups/design/CURATION_ASSISTANT_DESIGN.md) for
the full build history and design decisions.

### Ontology management

If we're working on ontologies or concepts, read ontology_management.md for more 
information about how the curator can edit the ontology and why the ontology is visualized this way.

## Scouting

If we are working on retrieving information using Scout, filtering it, judging
paper quality or anything else about how the Guide ingests information, go to scout.md
and read its contents, then come back here.

### Tombstones

Dismissing a document (the delete button) marks it `dismissed` and soft-deletes it,
so discovery won't offer that URL again — otherwise every re-run re-proposes the same
rejected papers forever. Suppressed URLs are refused on both ingest paths and dropped
at search time, before the paid filter.

**Dismissal is an explicit flag, not `deleted_at`.** Undo reverses a *create* by
soft-deleting it, so row state alone can't tell "the curator rejected this" from "that
run shouldn't have happened" — and keying on `deleted_at` turned an undone 358-document
run into a mass rejection that permanently buried every paper it found. The flag also
makes undo behave: reversing a dismissal restores the prior attributes, which clears
it, so the tombstone lifts.

Re-discovering a document already in the guide is separate and was always safe:
`submit_document` is idempotent on URL, so it's reported as a duplicate and keeps its
`reviewed` status rather than being pushed back into the queue.

### Why it was dismissed, and the dismissal report

A rejection can say **why**. Whatever is typed into the **Summary** box when Delete is
pressed is kept on the dismissed document as `dismissal_note` — "paywalled",
"marketing post", "same paper as the arXiv version" — and the confirm dialog quotes it
back before the delete goes through. Deliberately not a field of its own: a document
being thrown out of the queue has no summary worth keeping, so the box is free, and
one more input is one more thing to skip. It is equally deliberately **optional** —
gating the delete on a reason only teaches people to type a character.

It is not `summary`, because the two are different statements. A restore brings a
document back with its attributes intact, so a reason parked in `summary` would
resurface as the guide's summary of the paper. For the same reason the note is cleared
on restore: the restore is the judgement that supersedes it, and the revision log
keeps the history.

Every dismissal (and every restore, and every undo) regenerates
`dismissal_reports/dismissed_<env>.txt` — the counterpart to the
[search reports](readmes/reports.md#search-reports-discoverywrite_report), for the
same reason. A dismissal is the one review
outcome that leaves nothing to look at: the document goes out of the queue *and* out
of the graph, so a search that found little and a curator rejecting most of what it
found are indistinguishable from the UI. Each entry carries the title, the URL, the
reason, when it went, and the state it was in — including which concepts' searches had
proposed it.

**Regenerated from the database, never appended to.** Every dismissed document is
still a row, so the file is derived, and an undone dismissal or a re-pasted URL drops
out of it by itself. An append-only log would go on asserting a tombstone that no
longer exists. One file per environment, so a throwaway dismissal in the sandbox never
appears in the real guide's record.

## Reports

Five things here write a file for the curator to read rather than a screen to click,
because **curation is lossy and the losses are invisible in the UI** — a search
reports a count, not what it threw away; a dismissal removes a paper from the queue
*and* from the graph; the review queue is a flat list that says nothing about the pile
it is a list of. In each case a thin result and an over-eager filter look identical
from the interface.

| report | file it writes | when |
|---|---|---|
| **Queue report** | `queue_reports/queue_<env>_<stamp>.txt` | `python queue_report.py`, and at the end of a search run |
| **Search report** | `search_reports/search_<stamp>.txt` | every search run |
| **Dismissal report** | `dismissal_reports/dismissed_<env>.txt` | every dismissal, restore and undo |

The queue report is the substantial one: the queue by year, live citation counts, and
**semantic groups** — which queued papers say much the same thing, so that reading one
tells you roughly what is in the others.

**→ [`readmes/reports.md`](readmes/reports.md)** for all of it: what each report says,
why one file per run and another regenerates in place, and the optional ~2GB of
embedding dependencies the queue report's third section needs (and runs without).