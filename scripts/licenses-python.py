#!/usr/bin/env python3
"""Emit installed-distribution license info for the current interpreter as JSON.

Run with a bot's venv python (e.g. apps/discord-bot/.venv/bin/python) by
scripts/generate-licenses.mjs. Prints a JSON array of
{name, version, spdx, author, homepage, text} to stdout. Best-effort: packages
with no discoverable license text still appear (with an empty `text`).
"""

import importlib.metadata as md
import json
import sys

# venv bootstrap tooling — installed but not application dependencies we ship.
EXCLUDE = {"pip", "setuptools", "wheel", "pkg-resources"}


def spdx(meta):
    """Return a short SPDX-ish license identifier."""
    # PEP 639: a real SPDX expression in License-Expression is the best source.
    expr = (meta.get("License-Expression") or "").strip()
    if expr:
        return expr
    classifiers = [
        c.split("::")[-1].strip()
        for c in (meta.get_all("Classifier", []) or [])
        if c.startswith("License ::") and "OSI Approved" not in c.split("::")[-1]
    ]
    if classifiers:
        return "; ".join(dict.fromkeys(classifiers))
    lic = (meta.get("License") or "").strip()
    if lic:
        # The License field is sometimes the entire license text — keep only a label.
        first = lic.splitlines()[0].strip()
        return first[:60] if len(first) < 80 else ""
    return ""


def homepage(meta):
    """Home-page metadata, falling back to a Project-URL (Homepage/Repository/...)."""
    hp = (meta.get("Home-page") or "").strip()
    if hp:
        return hp
    prefer = ("homepage", "repository", "source", "documentation")
    urls = {}
    for entry in meta.get_all("Project-URL", []) or []:
        label, _, url = entry.partition(",")
        urls[label.strip().lower()] = url.strip()
    for label in prefer:
        if urls.get(label):
            return urls[label]
    return next(iter(urls.values()), "")


def license_text(dist, meta):
    """Return the full bundled license text if the dist-info carries one."""
    texts = []
    # 1) License-File entries recorded in the dist-info metadata.
    for name in meta.get_all("License-File", []) or []:
        for candidate in (name, "licenses/" + name):
            try:
                t = dist.read_text(candidate)
            except Exception:
                t = None
            if t and t.strip():
                texts.append(t.strip())
                break
    if texts:
        return "\n\n---\n\n".join(dict.fromkeys(texts))
    # 2) The License field itself, when it holds the full text rather than a label.
    lic = meta.get("License") or ""
    if "\n" in lic and len(lic) > 200:
        return lic.strip()
    return ""


out = []
seen = set()
for dist in md.distributions():
    meta = dist.metadata
    name = meta["Name"]
    if not name:
        continue
    low = name.lower()
    if low in EXCLUDE or low.startswith("zantiflow"):
        continue
    key = (low, meta["Version"])
    if key in seen:
        continue
    seen.add(key)
    out.append(
        {
            "name": name,
            "version": meta["Version"],
            "spdx": spdx(meta),
            "author": meta.get("Author") or meta.get("Author-email") or "",
            "homepage": homepage(meta),
            "text": license_text(dist, meta),
        }
    )

json.dump(out, sys.stdout)
