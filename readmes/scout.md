## Scout — discovery

Wired end to end: **⌕ Run search** in the header searches every concept and files
what survives into the review queue.

```
concepts ─► Scout (arXiv keywords │ OpenAlex semantic) ─► dedup ─► relevance filter
         ─► pending queue, ordered by venue tier
                    ▲                  ▲
        guide scope ┘                  └ journal → untiered → preprint
        (Artifact — governs both paths)   (deposit repositories never searched)
```

**The concept is the search unit.** There is no separate list of search terms: a
concept's `semantic_query` *is* the OpenAlex query and its `keywords` *are* the arXiv
boolean query, so building the ontology tunes discovery. `description` — the concept's
public definition — is deliberately NOT a query, and there is no fallback to it: an
empty `semantic_query` means the concept is skipped for OpenAlex, and the search
report names it. `criteria` is
deliberately left out of search — it's reserved as the eventual *machine-facing*
signal for assisted categorization ("does this document belong here?"), a different
question from "what should we go find?".

**But not everything worth reading is a paper** — see [Sources](#sources).

**But the concept isn't the whole config** — the [guide scope](#the-guide-scope) sits
above it and shapes both paths.

**Narrowing a run.** The `▾` beside Run search picks which concepts to search
(default: all). A full run is too slow and too noisy to tune a single concept's
keywords against; one concept, one report is a loop you can actually iterate on.

| File | Responsibility |
|---|---|
| `scout.py` | adapters, `SearchItem`, dedup, `Candidate` |
| `relevance_filter.py` | the LLM gate: concept-match on keyword hits, scope-only on feed items |
| `discovery.py` | the only module that knows about both the graph and Scout |
| `follow_source.py` | follow / list / enable / disable the sources polled |

- **Four adapters, split by `query_kind`.** arXiv is `boolean` (reads `keywords`,
  via `QueryNormalizer`); OpenAlex is `semantic` (reads `semantic_query`, matched by
  embedding); feeds and index pages are `enumerative` (read `source_url` and send
  no query at all, routed by the source's `mechanism`). An empty field just skips
  that adapter for that item.
- **Dedup is by normalized title**, not URL — the same paper is an arXiv preprint
  *and* an OpenAlex DOI, so URL-keyed dedup would file it twice. Provenance merges,
  and `source` reads `arXiv+openAlex` when both found it.
- **Two gates, one standard.** OpenAlex results are floored at `relevance_score`
  0.85; arXiv results go through the LLM filter, judged against the description of
  the concept that surfaced them (keyword search matches word overlap, so it drags
  in papers that merely contain the phrase). Semantic hits skip the filter, being
  pre-gated — but both paths answer to the same scope statement. Unsure → keep; the
  curator is the final gate. ⚠ The 0.85 floor is **inert** — see
  [Venue tiers](#venue-tiers--what-screens-for-quality).
- **Quality is screened by venue, never by author** — see
  [Venue tiers](#venue-tiers--what-screens-for-quality).
- **A failed search is not an empty one.** Adapters raise `SearchFailed` rather than
  returning `[]`, because a throttled arXiv call otherwise reads as "no such papers
  exist". Failures are counted per run and reported in the UI.
- **Already-known and dismissed URLs never resurface** — see [Tombstones](#tombstones).

Everything lands as `pending`; nothing is auto-categorized — the concepts that found
a document are **proposed**, not assigned (see [Proposed concepts](#proposed-concepts)).
One press is one undoable action, so a run that pulls in junk reverses in a single Undo.

**What a run costs.** N concepts × 2 APIs, plus the filter — synchronous, so the
button says `Searching…` and can take a while. Narrow it with the `▾` picker; if the
ontology grows, "only concepts changed since the last run" is the next lever.

**Keys** (both in `.env`, both optional — `api.py` loads `.env` on import):
`OPENALEX_API_KEY` for semantic search, `ANTHROPIC_API_KEY` for the filter. Missing
either degrades rather than fails — arXiv-only, or unfiltered — and the run notice
says which.

`scout_test.py` exercises the pipeline without the graph: `--llm-filter` runs the
gate, `--save` dumps JSON to eyeball scores and provenance.

### Sources

A lot of the writing this guide cares about is org blogs, lab pages and Substacks,
which neither arXiv nor OpenAlex indexes. So Scout also polls **followed sources**.

**A feed is another source of candidates, exactly like OpenAlex** — not a parallel
pipeline. It emits the same `SearchItem`s into the same funnel, so dedup, tombstones,
the guide-scope gate, arrival as `pending` and one-run-one-undo all apply to a
Substack post unchanged. No gate is given up.

Followed from the **SOURCES** window, or the script:

```bash
python3 follow_source.py check  https://seewhatuthink.substack.com/feed   # try it first
python3 follow_source.py follow "See What You Think" https://seewhatuthink.substack.com/feed
python3 follow_source.py list
python3 follow_source.py disable "Import AI"
```

**Sites with no feed are read as index pages.** When feed discovery finds nothing,
the page's links are classified once — which are published writing, which are
navigation — and those judgements are **memoised per link**, so a re-poll that
finds nothing new costs no model calls at all. Reader then fetches each new article
for its real title and date. See [SOURCES_DESIGN.md](SOURCES_DESIGN.md); the short
version is that per-site CSS selectors were rejected because the two motivating
sites need opposite structural rules.

A **`source` node**, not an attribute on a person or organization: a publication has
many writers, outlives any of them, sometimes has no identifiable person at all — and
only a node can carry the edges this needs (`writes_at` from its authors, `part_of`
to the org that runs it, `sourced_from` on every document it produced). arXiv and
OpenAlex are `source` nodes too, so provenance is uniform.

**Provenance is edges, not a string.** The old `source_api` field is gone. A paper
found by both arXiv and a lab's feed has *two* provenances, and `arXiv+openAlex` was
a list pretending to be a scalar. It also makes sources a legal pivot axis later —
concept → document → source runs through a document, so cells stay document sets.

#### The concept screen means different things on each path

Both paths look at the concepts, but they answer to different curator instructions,
so the same concept match causes opposite outcomes:

| | What the curator declared | A concept match means |
|---|---|---|
| concept search (arXiv) | *"I want work about **this concept**."* | keep — it's what she asked for (a non-match drops) |
| followed source | *"Good things come from **here**; drop the topics I've unchecked."* | drop *iff* every matched concept is unchecked |

On a feed the concept screen is an **exclusion filter** driven by the concept
picker: unchecking a concept means *"not this, right now"*, and a feed can't honour
that by not-running (one fetch brings back every topic), so it drops the posts that
match. A post about a **checked** concept is queued **with that concept proposal
attached**; a post in scope but about no concept slides through bare and is
categorised at review. A post about **only** unchecked concepts is dropped. See
[SOURCES_DESIGN.md](SOURCES_DESIGN.md) for the full rule and the tagged decisions.

#### What's deliberately not built

- **No date window.** Not needed, because urls are only decided once: anything a
  screen rejected is recorded and dropped at search time on later polls, before the
  paid filter and before Reader fetches anything. That covers feeds and page sources
  alike, where a date window could only ever have covered feeds — a page gives no
  date until the article is fetched, which is the cost being avoided. **Re-read** in
  the Sources window is the way back; note this means editing the guide scope is
  deliberately *not* retroactive.
- **No polling state in the graph.** Watermarks and health counters would write a
  node on every poll, and every write lands in `revisions` — putting machine
  bookkeeping into the audit log and in front of Undo.
- **No summariser for feed posts** (or any document) yet — the abstract is the
  post's own feed summary, and review is manual.

A dead feed **raises** rather than returning nothing — including a url that was never
a feed at all, which `feedparser` will otherwise read as an empty one. Feeds rot, and
a silently dead feed looks exactly like a quiet one.

See [SOURCES_DESIGN.md](SOURCES_DESIGN.md) for the full design and what's next
(a Sources window, source discovery, author elevation).

### The guide scope

A curator-authored [Artifact](#artifacts), edited from the **SCOPE** button (it opens
in its own window — it's prose you write, not a setting you flip). It governs **both**
search paths:

- appended to every semantic query as trailing context
- the premise the LLM filter screens keyword hits against

Both, because otherwise the two sources disagree about what the guide is for. That
was a real bug: the scope existed only in the filter, so OpenAlex results entered the
queue never having been measured against it — a concept described as *"Reading,
attention, and comprehension in a post-literate age"* has no AI in it, so semantic
search correctly returned reading-psychology papers the guide doesn't want. Appending
the scope to the query fixed it at the source.

It was also, briefly, a constant in `relevance_filter.py` — which meant the filter was
applying words the curator had never written and couldn't see. That constant survives
only as `DEFAULT_GUIDE_SCOPE`, the fallback for a guide with no scope saved; the editor
says plainly when it's in use.

**Be explicit about the boundary.** The default's "…about *human* cognition, and *not*
about AI/ML methods for their own sake" is the single distinction that rejects
machine-reading-comprehension papers under a concept about reading.

### Venue tiers — what screens for quality

The guide is **quality before comprehensiveness**. The cheapest honest signal of
quality is *where the author chose to submit the work* — a fact about the work, not
about the author. Three mechanisms, in increasing order of how much they decide:

| | what it does | where |
|---|---|---|
| **Deposit exclusion** | Zenodo and figshare are not searched at all | `scout.EXCLUDED_SOURCES` |
| **Venue tier** | orders the review queue; hides nothing | `scout.venue_tier`, `repo.pending_documents` |
| **The LLM screen** | the only thing that judges a paper's content | `relevance_filter.py` |

**Tiers.** `journal` (a CWTS-core journal or conference, per OpenAlex's `is_core`)
→ untiered → `preprint` (arXiv, SSRN, OSF, PhilPapers, Preprints.org). A preprint
that has since appeared in a core journal is promoted on that evidence. Stored as
`attributes.venue_tier`; `null` is a real third state — a feed post or a page added
by hand has no venue to judge, which is not the same as a bad one, so it sits
*between* the two: it came from a source the curator chose to follow, which is a
judgement a preprint carries none of.

**Why deposits are excluded rather than ranked.** On a `cognitive sovereignty` run,
Zenodo and figshare took **35 of the 50** result slots — 15 of those to duplicate
records of the same deposit. OpenAlex's semantic retrieval is approximate, so that
mass was crowding better papers out of the candidate pool entirely: excluding the
two hosts raised the top relevance score from **0.8945 to 0.9312**, and surfaced
Cognitive Science, Topics in Cognitive Science, International Studies Quarterly and
Ethics and Information Technology, none of which had appeared at any depth before.
The 50-result cap is the binding constraint, so a deposit dropped *after* the fetch
has still cost a slot.

**Signals deliberately rejected**, having been measured on the same 65 works:

- **Author affiliation.** 38/39 deposits have none, 1/20 journal articles has none —
  but a deposit form *has no affiliation field*, so this measures metadata
  completeness, is collinear with venue, and would add the bias of an
  independent-researcher penalty for no information gain. It also fails on a paper
  already approved into this guide (a *Journal of Philosophy* article).
- **Author count.** 36/39 deposits are single-authored — but so are **6 of 20**
  journal articles, including two in *Philosophy & Technology*. Philosophy is a
  single-author discipline; this taxes exactly the work the guide wants.
- **Journal impact (`2yr_mean_citedness`).** Does not transfer across fields: it
  ranks *Artificial Intelligence and Applications* (1.49) above *Journal for General
  Philosophy of Science* (0.41). Usable as a floor, never as a sort key.

`reference_count` is stored and shown as a `no refs` flag on the queue card, and
deliberately filters nothing: 5 of 20 journal articles measure zero because their
publisher never deposited references to Crossref, so it is weak evidence about the
paper and strong evidence about the publisher.

**⚠ Open question — prestige vs. quality.** Every mechanism above is a *venue*
proxy, and venue is prestige. It does not read the paper. The LLM screen is the only
thing that can, and today it judges **scope only** — so a thin, unsupported paper in
a core journal passes, and a good one on arXiv or SSRN ranks below it. Adding a
quality dimension to that prompt is the open piece of work; whether it belongs in
the scope Artifact (one paragraph, judged holistically) or as a second dimension with
its own per-candidate verdict is undecided. Measurements behind all of the above:
`quality_signals.md`, `venue_filter_evidence.md`, `openalex_top50_saturation.md`.

### Search reports

Every run writes `search_reports/search_<timestamp>.txt`. Search is lossy by design —
dedup, tombstones, a relevance floor, an LLM judgement — and each of those drops is
invisible in the UI, which reports only counts. That makes a narrow literature and an
over-eager filter look identical. The report distinguishes them:

- counts per drop stage
- **the actual converted query sent to each API** — how you catch a query-conversion
  bug without reading code
- **the scope applied**, verbatim, and whether it was yours or the built-in default
- **what the run refused to index** (the excluded deposit repositories), for the same
  reason: a narrowed search is otherwise indistinguishable from a quiet literature
- failed searches, flagged as making the results incomplete
- every dropped paper with its title, url, the concept that surfaced it, and —
  for LLM drops — **the model's own stated reason**

That last one is what lets you audit the filter rather than trust it.