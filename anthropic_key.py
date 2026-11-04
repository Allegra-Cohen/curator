"""One place every part of this project reads its Anthropic API key from.

Without this, each file that needs Claude (the curation assistant, the queue's
LLM noise filter, scout's relevance filter, ...) would call
`os.getenv("ANTHROPIC_API_KEY")` on its own -- easy to spell differently in
one of them, or to forget entirely. Call `anthropic_api_key()` instead.

This does NOT load the .env file -- that's still each entry point's own job
(see api.py's `load_dotenv()` at the top, or a script's `__main__` block),
same as it is for every other environment variable in this project.
"""

import os
from typing import Optional


def anthropic_api_key() -> Optional[str]:
    """The Anthropic API key from the environment, or None if it isn't set."""
    return os.getenv("ANTHROPIC_API_KEY")
