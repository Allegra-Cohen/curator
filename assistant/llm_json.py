"""Shared parsing for the small model calls scattered through the curation
assistant (assistant/scope.py, assistant/question_split.py, and
assistant/evidence.py): each one sends a prompt and expects a single JSON
object back. This is the one place that pulls a {...} out of the model's
reply and turns it into a dict, so all three parse a reply the same way and
raise the same kind of error when it isn't one.

Making the actual API call is NOT here -- that stays a plain method on each
caller's own class, because each one's tests replace that one method with a
stub (no network, no API key needed), which only works if it's still an
overridable method on the object being tested.
"""

import json
import re


class LLMJSONError(Exception):
    """The model's reply couldn't be read as a single JSON object. Callers
    typically catch this and re-raise as their own error type."""


def extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise LLMJSONError(f"reply had no JSON object: {text!r}")
    try:
        row = json.loads(match.group(0))
    except (ValueError, TypeError) as exc:
        raise LLMJSONError(f"reply wasn't valid JSON: {text!r}") from exc
    if not isinstance(row, dict):
        raise LLMJSONError(f"reply wasn't a JSON object: {text!r}")
    return row
