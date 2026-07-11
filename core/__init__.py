"""Shared domain logic for the diet tracker.

Both the human web UI and the MCP server import this package; it is the single
source of truth for derived-value computation. Firestore access will live
alongside these pure functions as the platform is built out.
"""

from . import catalogue, compute, nutrients, timeutils

__all__ = ["catalogue", "compute", "nutrients", "timeutils"]
