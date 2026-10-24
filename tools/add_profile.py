"""Create a profile and link the Google account(s) that sign in to it.

Profiles are created here, not in the app: the app (and the MCP server) admit
a Google account only if its email is listed on a profile, and nothing in the
app can change that list. Name, colour, height and default targets are then
edited in the app.

Usage:
    python tools/add_profile.py --id alex --name Alex --email alex@gmail.com [--project ID]
    python tools/add_profile.py --list [--project ID]

Refuses to overwrite an existing profile, or to link an email that is already
on another profile.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Make the repo root importable when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.store import PROFILES_COLLECTION, Store  # noqa: E402

COLOURS = ["#c05f3e", "#5f7d4a", "#6f7fa0", "#8a5a83", "#1e1b16"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project")
    ap.add_argument("--list", action="store_true", help="list existing profiles and their emails")
    ap.add_argument("--id", help="short lowercase id, e.g. 'alex' (used in URLs)")
    ap.add_argument("--name")
    ap.add_argument("--email", action="append", default=[], help="Google account; repeat for more than one")
    args = ap.parse_args()

    store = Store(project=args.project)
    print(f"Project: {store.db.project}")
    profiles = store.list_profiles()

    if args.list:
        for p in profiles:
            print(f"  {p['id']:<12} {p.get('name', ''):<16} {', '.join(p.get('emails', []))}")
        if not profiles:
            print("  (no profiles)")
        return

    if not (args.id and args.name and args.email):
        ap.error("--id, --name and at least one --email are required (or use --list)")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", args.id):
        ap.error("--id must be lowercase letters, digits or '-'")
    if any(p["id"] == args.id for p in profiles):
        sys.exit(f"profile '{args.id}' already exists")
    emails = [e.strip().lower() for e in args.email]
    for e in emails:
        owner = store.profile_id_for_email(e)
        if owner:
            sys.exit(f"{e} is already linked to profile '{owner}'")

    store.db.collection(PROFILES_COLLECTION).document(args.id).set({
        "name": args.name,
        "colour": COLOURS[len(profiles) % len(COLOURS)],
        "height_cm": None,
        "default_targets": {},
        "emails": emails,
    })
    print(f"Created profile '{args.id}' ({args.name}) for {', '.join(emails)}")
    print("Remember: each email also needs IAP access — add it to ALLOWED_EMAILS and re-run ./deploy.sh.")


if __name__ == "__main__":
    main()
