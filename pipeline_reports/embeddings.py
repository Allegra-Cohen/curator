"""The only file in this project that knows an embedding model exists.

`queue_structure.groups` needs to know which queued papers say the same thing as each
other. That is the one question in the queue report that metadata cannot answer: a
title, a venue and a date tell you nothing about whether two abstracts are about the
same idea. So this module turns text into vectors, and nothing else in the codebase
imports a model, mentions a dimension, or knows what `clustering:` means.

**Everything here is I/O and caching; none of it is analysis.** `groups` receives an
`embed` callable exactly as `citations` receives a `CitationLookup`, which is what
keeps the arithmetic testable against hand-built vectors with no 500MB download.

Three decisions worth not re-litigating (QUEUE_SEMANTICS_PROPOSAL.md §8, §10):

**Local weights, pinned, not a hosted API.** The report's value is comparative -- one
timestamped file per run, never overwritten, "because the interesting readings are
comparative". A hosted model that silently updates would make last month's groups and
this month's incomparable with nothing in either file saying so. Pinned local weights
make the numbers reproducible indefinitely, and nothing leaves the machine.

**`transformers`, not `sentence_transformers`.** The proposal assumed the latter.
`SentenceTransformer.__init__` had no `trust_remote_code` argument until 2.3, and
reaching one that does means dragging `transformers` and `torch` forward across the
whole environment this project runs in. `AutoModel` takes the argument today. The
pooling therefore lives in `_encode` below instead of inside the model repo's
config -- read off its `modules.json` (Transformer -> Pooling, mean, and nothing
else) so it matches the published model exactly.

**The cache is a sidecar file, never a node attribute.** A vector belongs to a model
version. Writing one into `nodes.attributes` would make the model version part of the
record and create a field nothing could correctly invalidate when the model changed.
See `_cache_path` for where it goes and why that location is the safe one.
"""

import hashlib
import json
import os
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

# The type `queue_structure.groups` is written against: texts in, one vector per text
# out, in the same order. Declared here so that module can name it without importing
# anything that would pull in torch.
Embedder = Callable[[Sequence[str]], List[List[float]]]

MODEL_ID = "nomic-ai/nomic-embed-text-v1.5"

# Pinned, and not optional. `trust_remote_code=True` executes code from the model
# repo at load time; tracking `main` would mean a future commit to somebody else's
# repository runs on this machine. It also pins the numbers: §8 keeps this report
# comparable across months, and a revision is what makes that true.
MODEL_REVISION = "e9b6763023c676ca8431644204f50c2b100d9aab"

# nomic-embed-text-v1.5 requires a task prefix on every input, and the wrong one
# silently produces worse groups with no error anywhere. Ours is `clustering:` --
# NOT `search_document:`, which is for retrieval, where one text is a query and the
# other is a corpus entry. Here every text plays the same role.
TASK_PREFIX = "clustering: "

# The full 768. The model supports Matryoshka truncation to 512/256/128/64; nothing
# here is large enough to need it, and the `F.layer_norm` step the model card shows
# belongs to that truncation -- which is why it is correctly absent from `_encode`.
DIMENSIONS = 768

# 8192 tokens of context, and the longest abstract measured in either queue is 1,916
# characters. Nothing is ever truncated; the cap is the model's, stated so that a
# future queue of full texts fails visibly here rather than silently mid-abstract.
MAX_TOKENS = 8192


class ModelUnavailable(RuntimeError):
    """The model could not be loaded: the packages aren't installed, or the weights
    aren't cached and there's no network. Raised rather than returned as empty
    vectors, because a silent zero vector would land every paper in one enormous
    group and look like a finding."""


# --------------------------------------------------------------------------
# The cache
# --------------------------------------------------------------------------

# Beside `queue_reports/`, at the repo root, and gitignored. Both halves matter:
#
#   * NOT under `ui/dist-viewer/` -- `export_guide.py` copies that whole directory to
#     the blog. Nothing derived and private may live there even by accident.
#   * gitignored, because this is a large derived blob that regenerates on demand --
#     the same category as `backups/` and `search_reports/search_*.txt`.
CACHE_PATH = Path(__file__).with_name(".embedding_cache.json")


def _key(text: str) -> str:
    """What a cached vector is keyed by: the model, its revision, and the text.

    All three, because a vector is only meaningful as the output of one model version
    on one input. Keying on the text alone would silently serve last month's model's
    answer after an upgrade -- exactly the incomparability §8 pins the revision to
    avoid, reintroduced through the back door.
    """
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return f"{MODEL_ID}@{MODEL_REVISION[:12]}:{digest}"


def _load_cache(path: Path) -> Dict[str, List[float]]:
    """Read the sidecar, treating any damage as an empty cache.

    A cache is by definition reconstructible, so a truncated or hand-edited file
    costs a re-encode and nothing else. Failing the report over it would be trading
    a recoverable situation for an unrecoverable one.
    """
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_cache(path: Path, cache: Dict[str, List[float]]) -> None:
    """Write the sidecar, atomically, and never at the cost of the report.

    Atomic because two runs can overlap -- `api._refresh_queue_report` fires at the
    end of a search run while the curator may be running the CLI -- and a half-written
    JSON file read by the other one is the damage `_load_cache` then has to absorb.

    Failures are swallowed: a read-only disk should cost the caching, not the report
    the curator asked for.
    """
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(cache))
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


# --------------------------------------------------------------------------
# The model
# --------------------------------------------------------------------------

_MODEL = None       # loaded once per process; ~500MB of weights


def _load_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
    except ImportError as e:
        raise ModelUnavailable(
            f"{e}. The semantic section needs transformers, torch and einops; "
            "run the report with --no-embeddings to skip it."
        ) from e

    try:
        tok = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
        model = AutoModel.from_pretrained(MODEL_ID, revision=MODEL_REVISION,
                                          trust_remote_code=True)
    except Exception as e:                                      # noqa: BLE001
        # Anything from a missing `einops` (the remote code imports it) to no network
        # on a cold cache. All of it means the same thing to the caller.
        raise ModelUnavailable(f"could not load {MODEL_ID}: {type(e).__name__}: {e}") from e

    model.eval()
    _MODEL = (tok, model, torch)
    return _MODEL


def _encode(texts: Sequence[str], *, batch_size: int = 16) -> List[List[float]]:
    """Texts to unit vectors, in order.

    Attention-masked mean pooling then L2 normalisation, which is what the model
    repo's own `modules.json` specifies (`Transformer` -> `Pooling` with
    `pooling_mode_mean_tokens`, and no `Normalize` module). Masked, because padding
    tokens carry a real embedding: averaging over them would make a vector depend on
    the longest text in its batch rather than on its own content.

    We normalise ourselves so that `queue_structure` can treat cosine similarity as a
    plain dot product -- the arithmetic there stays readable, and the invariant lives
    at the one place vectors are made.
    """
    tok, model, torch = _load_model()
    out: List[List[float]] = []
    with torch.no_grad():
        for i in range(0, len(texts), batch_size):
            batch = [TASK_PREFIX + t for t in texts[i:i + batch_size]]
            enc = tok(batch, padding=True, truncation=True,
                      max_length=MAX_TOKENS, return_tensors="pt")
            hidden = model(**enc)[0]
            mask = enc["attention_mask"].unsqueeze(-1).float()
            pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
            pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
            out.extend(pooled.tolist())
    return out


def embedder(*, cache_path: Optional[Path] = None) -> Embedder:
    """The live embedder, cached to disk. This is what `queue_report` hands `groups`.

    Returns a callable rather than encoding anything, so that constructing it is free
    and the 500MB load only happens if there is an uncached text to encode. A run over
    an unchanged queue touches no model at all.
    """
    path = cache_path or CACHE_PATH

    def embed(texts: Sequence[str]) -> List[List[float]]:
        cache = _load_cache(path)
        # Deduplicated: two documents with identical text -- which §7's duplicate
        # detector exists to find -- are one encode, not two.
        missing = list(dict.fromkeys(t for t in texts if _key(t) not in cache))
        if missing:
            for text, vector in zip(missing, _encode(missing)):
                cache[_key(text)] = vector
            _save_cache(path, cache)
        return [cache[_key(t)] for t in texts]

    return embed
