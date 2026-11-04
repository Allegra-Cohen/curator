# Reports

Five things in this project write a plain-text or Markdown file for the curator to
read rather than a screen for them to click. They exist for one reason, stated once
here because it is the same reason every time:

> **Curation is lossy, and the losses are invisible in the UI.** A search reports a
> count, not what it threw away. A dismissal removes a paper from the queue *and*
> from the graph. The review queue is a flat list that says nothing about the pile it
> is a list of. In every case a thin result and an over-eager filter look identical
> from the interface, and the report is the difference between them.

None of these writes to the graph. They are reading aids: they propose an order to
look in and never apply one.

---

## The one distinction that decides how each file is written

**Is this file about a moment, or about a standing set?** Everything else follows.

| | about a **moment** | about a **standing set** |
|---|---|---|
| files | one per run, timestamped, never overwritten | one file, regenerated in place |
| examples | queue report, search reports | dismissal report |
| why | the interesting readings are comparative — what the search added, whether the queue is ageing, whether a paper's citations moved. Overwriting would make each run destroy the only record of the last | it describes what is true *now*. An old copy is simply wrong, and an append-only log would go on asserting a tombstone that no longer exists |

The environment (`sandbox` / `guide`) is in every filename and is never optional. A
sandbox exists to be scribbled on, and a throwaway run there must never be mistaken
for the real guide's record.

Files accumulate, deliberately. Nothing prunes them; they are small and the history
is the point.

---

## Queue report — `queue_report.py`

**What is in the review queue, as a pile rather than as a list.**
`repo.pending_documents()` returns the queue in the order it should be *worked* — best
venue first, then oldest — which is right for deciding one document at a time and
tells you nothing about the set. Is this a run of current work or a backfill reaching
into the 2010s? Which of it is the field already reading? Which of it says the same
thing as the rest?

```bash
python queue_report.py --env sandbox        # → queue_reports/queue_sandbox_<stamp>.txt
python queue_report.py --no-citations       # skip the OpenAlex lookup
python queue_report.py --no-embeddings      # skip the semantic grouping
```

Also written automatically at the end of a search run (`api._refresh_queue_report`) —
a run is the only thing that changes the queue wholesale, which makes it the moment a
fresh report is worth having.

Three sections. The first two need only metadata; the third reads the documents.

### CHRONOLOGY

The queue by publication year, newest first, with a bar per year — the one part of the
report that answers before it is read. Dates arrive at three precisions (`2024-03-17`,
`2024-03`, `2024`) and a partial date is read to the start of its period rather than
discarded. Anything unparseable goes in an **undated** bucket and is never guessed at.

Papers more than five years older than the queue around them are called out as
`stale`: in a fast-moving field that is either a foundational text worth placing
carefully or a keyword artifact that drifted in. It only ever changes what prints.

### CITATIONS

How often the wider literature cites each queued document, fetched live from OpenAlex
and stamped with the moment it was fetched.

**Nothing stores this and nothing should** — a count written into a node is stale the
next day and no code path would refresh it. So `--no-citations` (or being offline) is
an ordinary outcome that still produces a report.

Two rules the whole report keeps:

- **An unknown is not a zero.** It means the URL names no DOI, or OpenAlex has no
  record of it. Unknowns sort *below* the zeros rather than among them, because
  sorting them in would be the same claim as printing them as zero.
- **Age is the confound.** A three-month-old preprint with two citations is not
  less-read than a 2019 paper with thirty; it has had no time. Hence the `/yr` column
  — and anything under a year old has no rate at all, rather than one computed over a
  fraction of a year, which would flatter exactly the newest work in the queue.

### SEMANTIC GROUPS

**Which queued papers say much the same thing, so that reading one tells you roughly
what is in the others.** The term throughout is **stand-in**: the paper you actually
read, that stands in for the ones near it.

A stand-in **names its own group** — there are no invented cluster labels anywhere,
because a label nobody wrote is a claim nobody can check.

The procedure: measure every pair, count each paper's close neighbours, pick the best
stand-in, cross it and everything it covers off, and score again on what is left.
Stop when nothing has an uncovered neighbour. This is not textbook clustering, on
purpose — clustering forms a group and *then* asks which member speaks for it, and the
answer can be a paper that isn't close to some members. Here the group is built
*around* the paper you read, so "these five are close to this one" is true by
construction. It also cannot produce the chain failure where A is near B, B near C,
C near D, and all four group although A and D are unrelated.

Four outcomes, and every document lands in exactly one:

| | |
|---|---|
| **a stand-in** | read this one first |
| **covered** | skim or skip; the stand-in speaks for it |
| **no stand-in** | nothing is close to it — read it on its own. **This is the number that says how long the queue will actually take** |
| **not enough text to place** | no abstract was scraped. About 1 in 4 of a real queue — Substack posts, encyclopedia entries, court filings. Left ungrouped rather than grouped badly |

**A free duplicate detector**, printed *above* the groups because a duplicate is
something to resolve before the grouping is read. Near-identical text at a stricter
cutoff catches the same paper filed under two canonical URLs — which
`nodes_doc_url_uniq` cannot see — and needs neither copy to have a resolvable DOI.

Every setting prints in the header of every file: the similarity threshold and how it
was reached, the duplicate cutoff, how much venue and citations and age are allowed to
move a paper. **They are settings, not findings.** They were calibrated against one
72-document queue, which is one sample of one, and they are printed so that two
timestamped reports can be compared at all and so the curator can argue with a number
instead of guessing at one.

The design is `writeups/design/QUEUE_SEMANTICS_PROPOSAL.md`; what happened when that
design met real data — three of its premises did not survive — is
`QUEUE_SEMANTICS_MEASUREMENTS.md`. Read both, in that order.

### Titles print in full, everywhere

Nothing in this report is truncated. Titles run to 143 characters in a real queue and
the median is 71, so a title clipped to fit a column is exactly the one that then has
to be looked up somewhere else. Long titles wrap under themselves at a hanging indent,
which keeps the columns to their left scannable. URLs are the deliberate exception to
the page width: one broken across two lines cannot be pasted anywhere.

### Where the code lives

| file | responsibility |
|---|---|
| `queue_structure.py` | the analysis, pure — no database, no network, no filesystem. The citation lookup and the embedder both arrive as callables the caller supplies, which is what makes it testable against hand-built nodes and vectors |
| `queue_report.py` | render + write |
| `doi_lookup.py` | the citation fetch — it went there because that module already owned URL → DOI → OpenAlex |
| `embeddings.py` | the local embedding model. **The only file in the project that knows a model exists** |

`embeddings.py` needs `transformers`, `torch`, `einops` and `numpy` — about 2GB,
listed in their own block in `requirements.txt`. They are optional: without them,
`default_embedder()` returns `None` and the report loses that one section, exactly as
`--no-citations` loses its own. The model (`nomic-embed-text-v1.5`) is local and
**pinned to a revision**, because the report's value is comparative and a hosted model
that silently updated would make last month's groups and this month's incomparable
with nothing in either file saying so. Vectors are cached to a gitignored sidecar file
keyed by `(model_id, revision, sha256(text))` — **never into `nodes`**, because a
vector belongs to a model version and nothing could correctly invalidate it when the
model changed.

---

## Search reports — `discovery.write_report`

**What one search run searched, what it dropped, and why.** Written to
`search_reports/search_<stamp>.txt` on every run.

Search is lossy by design — dedup, tombstones, a relevance floor, an LLM judgement —
and every one of those drops is invisible in the UI, which reports only a count. That
makes a narrow literature and an over-eager filter look identical. Each dropped paper
appears with the stage that cut it and, for the LLM filter, **the model's own stated
reason**, so the filter can be audited against what the curator actually wanted.

---

## Dismissal report — `dismissal_report.py`

**The standing list of dismissed documents**, at
`dismissal_reports/dismissed_<env>.txt`. Regenerated on every dismissal, restore and
undo.

A dismissal is the one curation decision that leaves nothing to look at: the document
goes out of the queue *and* out of the graph, so from the UI a thin search and a
curator rejecting most of what it found are indistinguishable. This is the counterpart
to the search report on the other side of the funnel.

Each entry carries the title, the URL, the reason (`dismissal_note`, whatever was
typed into the Summary box when Delete was pressed), when it went, and the state it
was in — including which concepts' searches had proposed it.

**Regenerated, never appended to.** Every dismissed document is still a row, so the
file is derived, and an undone dismissal or a re-pasted URL drops out of it by itself.

---

## Republish reports — `republish_diff_report.py`, `republish_author_audit.py`

Two pre-flight checks for publishing the guide to the blog. Neither is on a schedule;
both are run by hand as part of a republish.

- **`republish_diff_report.py`** — a semantic diff of what this republish would make
  public that isn't already. **Order matters:** it compares the live export against
  what is *currently published*, so it must run **before** `export_guide.py` copies
  into the blog. Run after, it compares the new payload with itself and reports no
  changes — which reads exactly like "nothing to review". It refuses rather than write
  that file over a real report.
- **`republish_author_audit.py`** — read-only: are the people in the export attached
  to approved, non-dismissed papers?

`writeups/REPUBLISH.md` is the republish sequence these sit in, including the one
environment trap: `republish_author_audit.py` needs the app's interpreter, which is
anaconda's rather than whatever `python3` resolves to.
