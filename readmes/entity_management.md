# Entity management

This is a companion README to README.md, specifically about how entities (authors and organizations)
are handled in the Field Guide.

### Authors and entities

**Entities don't enter the graph until the curator approves the document.** Ingestion used
to upsert a `person` per scraped name at submit time, before any review. Two things
were wrong with that: the scraper cannot tell a person from
an organization (so "Center for Humane Technology" became a human with eleven papers),
and candidates wrote nodes that a later dismissal never cleaned up — **1022 of 1037
person nodes had no live edge at all** when tested via the sandbox.

So a scraped author is now a *record* on the document (`attributes.authors_scraped`),
resolved against the graph when the document is opened and shown as a chip.

**An author-proposal decision sticks, and only on its own document.**
`authors_scraped` is permanent — it's the evidence of what the scraper actually read,
and rewriting it on a rejection would destroy the difference between "the scraper
missed someone" and "someone decided against this byline". So the list that *shrinks*
is a second attribute, `proposed_author_names`: seeded at ingest from the scraped
names, and emptied by `set_authors` (that is, by Save). Author proposals are derived
by joining that list back onto `authors_scraped` for the ORCIDs, so a name no longer
on it is never proposed on that document again — including if the document later
returns to the review queue. Because the list lives on the document, rejecting a
byline here leaves the same person proposed on every other document that scraped
them; correcting one paper's byline is not a claim that someone never writes
anything.

This is the exact shape `proposed_concept_ids` already had, and the reason the two
had to converge: author proposals used to be re-derived from `authors_scraped` alone.
Nothing consumed it, so no author-proposal decision could ever stick — a rejected
author came back on the next fetch, forever, and a document that had already left the
review queue went on offering scraped names as though nobody had reviewed it. That's
what showed up as an author appearing on a filed document who was in neither the
entities list nor any `authored_by` edge.

**Scraped authors are credited by default.** This is the one place the opt-in rule
doesn't hold, and the distinction is what's being decided. Assigning a *concept* is a
judgement about the guide, so it stays opt-in — a proposal you never looked at must
never become an assignment. Agreeing that a byline says what it says is not a
judgement of that kind; it's checking a scrape. So the common case costs nothing and
disagreeing costs one `✕`, rather than the reverse.

**Nothing reaches the graph any earlier for it.** Chips are still only written by
Save, and a document you open and walk away from leaves nothing behind — the rule
that took node creation out of ingestion is untouched. What changed is only which
answer is the default.

Two chips, and the difference is one badge:

- **Matched** — a solid chip. Something in the guide already carries this name (or
  this ORCID), so it's an ordinary credit with nothing outstanding. `✕` drops it.
- **Not in the guide** — the same solid chip, badged **NEW**, with the kind it will
  be created as. The node is created during Save.

**ORCIDs** ride along from OpenAlex (roughly half of authorships carry one) and still
do the matching: tried first, and when the ORCID and the name disagree **the ORCID
wins and nothing is flagged** — people hold one precisely *because* they publish under
varying names, so a name collision is the situation the identifier exists to survive.
It's no longer *shown*, though. The badge said how a match was made, which is a fact
about our matching and not about the author; what a curator needs to know is whether
something is new.

**Names match in either order.** Some sources write bylines surname-first, and exact
matching read "Nair, Priya" and "Priya Nair" as two people — which is how
the guide got its first duplicate. Names now compare through `person_name_key`
(`graph/types.py`): lowercased, spaces collapsed, and a single "Last, First" turned
round (never a suffix: "Smith, Jr." stays put). A node's `aliases` match as well as
its label, so a spelling that was merged away still finds the person it went into.
Still no fuzzy matching: "Marta V. Souza" and "Marta Villela Souza" only meet through
an alias the curator chose.

**A NEW chip carries a guessed kind** (`NEW · person`, `NEW · org`), because a node
can't be created without one and defaulting everything to `person` is the exact
failure this area was rebuilt to stop. The guess is a word list, not a model — see
`ui/src/entityKind.ts` — and its correctness isn't what makes it safe. Printing it is:
a wrong kind is on screen before Save rather than discoverable in the graph
afterwards. An ORCID overrides the guess outright, since only humans have one.

**Every uncreated author is a NEW chip, however it got there.** Clicking one opens
it for checking and writes nothing; so does typing a name into the authors search box
that nothing matches. Both offer the same fields — name, kind, ORCID, affiliation,
*writes at* — because the moment you're looking at an author is the moment you know
those, and making the curator come back for them after Save is how they don't get
entered. They ride along on the pending credit and are applied when Save creates the
node, which is exactly the payload `createPerson` / `createOrganization` already take.
Inspecting a guess must not be the act that commits it, or looking would be more
dangerous than ignoring.

Typing a new author used to `POST /api/people` the moment the dialog box was
submitted, which put a `person` node — and a `member_of` edge, and a `writes_at` edge
— in the graph for a document still sitting in the review queue, and left all of it
behind if you clicked away. So a scraped author you *corrected* wrote nothing and one
you *typed* wrote immediately, from the same dialog box. That asymmetry is gone.

**A refetch never rebuilds the working set.** Editing an entity refetches the graph
and the open document, because a rename moves every chip and pivot row bearing it. But
re-*seeding* the document derives its credits from the server, which knows nothing
about a correction that hasn't been saved — so fixing a mangled scraped author and
then opening that entity's node reverted the chip to the mangled name. The refetch now
updates the document's own text plus what a rename or retype can actually change about
a credit (its label, and which of the two lists it belongs in), and leaves the
decisions alone. Only a Save re-seeds, which is what settles the dirty flags.

**Typing a name that already exists is flagged.** A correction is often a correction
*towards* something the guide has — `Center` → `Center for Humane Technology`, which is
already a node — and without the warning that quietly makes a second copy. The dialog
says so and offers **Credit that one instead**, which swaps the NEW chip for the
existing node. A warning, never a block: two people genuinely do share a name, and
refusing would make the rarer case impossible to express. Matching is exact and
case-insensitive — fuzzy matching here would be a guess, and not guessing is the point
of the whole surface. (This dialog check does *not* yet flip "Last, First" or read
aliases the way the server's proposals do.)

**Entities are correctable.** Clicking a credited chip opens the person or
organization in the node panel: name, ORCID, affiliation, where they write, and what
they're credited on (click a title to open it). A rename is graph-wide, and the card
says so with the count. Any entity can be **retyped** person ⇄ organization *in place*
— the node keeps its id, so every `authored_by` edge survives, which is exactly what
delete-and-recreate would lose. A retype is refused, with the offending edges named,
when one would become illegal (`member_of` runs person → organization).

**A deleted entity is forgotten, not merely refetched around.** Deleting one in the
ENTITIES window broadcasts its **id**, and the main window drops every reference: the
open card, the credit chips on the open document, and the heading over its document
list. A refetch alone isn't enough, because everything the main window shows about an
entity is held beside the graph rather than in it — `selectedNodeId` is a bare id, and
an id the graph can't resolve fell through to the concept panel, which fetched
`GET /concepts/<id>` and put a **404** in the header. The chips failed more quietly:
they went on offering to un-credit an `authored_by` edge that had already gone with
the node. The credit *baseline* drops it too, so a chip vanishing reads as the
document catching up with the graph rather than as an unsaved edit that prompts on the
way out. Nothing on screen should name a node the guide doesn't have.

**ENTITIES** in the header opens a window listing every person and organization with
their ORCID and credit count, filterable, creatable and deletable. "Credited on
nothing" is a headline count there, because that number is the shape of every bug this
area has had. Corrections deliberately happen on the card in the main window, not in
that list, since a rename moves every pivot row bearing the name.

**ARTIFACTS** in the header opens a window for the curator's remarks (see
[Artifacts](#artifacts) and [ARTIFACTS_DESIGN.md](ARTIFACTS_DESIGN.md)). It lists every
remark and edits one: you pick what it's *about* first — a search over the whole graph,
any node type, so a remark can span a concept and one specific document together — then
give it a title and write the prose. **Cmd+K** over selected text links to anything in
the guide, and a live References list names the documents among them. Nothing surfaces on the
main graph yet; the viewer that reads this layer is [Roadmap](#roadmap) work.

What's *not* built is **merge and split** — two people who share a name and have no
ORCID between them still need it. The plan isn't a button: the useful instruction is a
sentence ("there are two A. Persons, one on literacy and one on physics — split them
with their documents"), so the direction is a small tool set handed to a model, with
the changes shown for approval before they land.

Until then, merges are one-off scripts. `development_scripts/merge_comma_names.py`
(2026-09-21) renamed every "Last, First" person in the guide and merged the three that
duplicated someone: the keeper is the node with an ORCID, else more live edges, else the
older; the other's edges move onto it, it is soft-deleted, and its spelling becomes an
alias. Dry run by default, `--merge "A=B"` for pairs the curator names, and every change
in `revisions`. Back up first (`./backup_db.sh`).
