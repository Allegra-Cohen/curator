### Editing the ontology

The `[+]` / `[−]` pair in the ontology header (where the row count used to sit)
turns on the two structure-editing modes. Clicking outside the ontology half, or
Esc, leaves either mode.

- **Create** (`+`) lights up **insertion lines** between rows. *Where* you click is
  the parent: the line under a concept makes a subtopic of it, and the line above
  everything makes a new top-level concept. The click opens a **draft** in the
  concept panel — nothing exists until you fill in the name and **Save**, so a
  half-typed concept never lands in the graph (and clicking away prompts first).
- **Rename** is just editing the concept's name field and saving. It's the cheap
  alternative to delete-and-recreate: to repurpose a category, rename it and its
  documents come along.
- **Delete** (`−`) then a click on a concept opens a **confirm dialog** that spells
  out the blast radius first: the descendant concepts that go with it (a child that
  also hangs under a *surviving* parent is kept, just detached), and how many
  documents fall back to the review queue. A document is re-queued only if the
  delete strips its **last** category — one still filed elsewhere stays put.

**Mass-labelling.** Multi-select documents in the list (⌘/Ctrl- or Shift-click) and
drag them onto an open concept to categorize the whole set at once — the fast path
when a batch all belongs under one concept.

**Undo.** The header's **↶ Undo** reverses the most recent action as a unit — a
whole cascade delete, a mass-label, a create-with-parent — because every write is
tagged with its DB transaction and undo reverses the latest group (see
[Architecture](#architecture)). Soft deletes make it non-destructive; the log keeps
both the action and its undo.

Everything here obeys the same ethos: the machine proposes nothing on its own. Two
concepts can't share a name (rejected on create and rename), and a blank name is
refused.

### The ontology table

Every top-level concept gets a **card**, and its branch nests inside. Hue is
assigned per top-level concept and rows tint lighter the deeper they sit, so a
subtree reads as one colour family; the card head carries that hue full-bleed,
and the rows inside are indented by depth in the `subtopic_of` hierarchy.

The card is what does the grouping, and that pays for the rest: with a container
already saying *these belong together*, the rows inside need no hairline between
them and no rail on each band, and a root's label can go full-bleed rather than
hugging its text. A stack of ragged right edges was most of what made the earlier
flat list read as unarranged.

Cards are a *view* of the flat row list, not a second model — a depth-0 row opens
one, the rows after it collect into it. So poly-parenting, cycle recovery and the
row cap below all keep behaving exactly as the derivation already decided.

A hierarchy only nests cleanly when every concept has one parent, which an
ontology does not guarantee. Rather than pick a winning parent and hide the rest,
a poly-parented concept is drawn **under every parent**. Rows are keyed by path,
selection by concept id — so selecting one instance lights them all, which is what
tells you the concept is poly-parented, and clicking one names its other parents
in the header (*"also in: …"*).