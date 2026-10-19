#!/usr/bin/env python3
"""Rename CoinGabbar -> IndianSignals. `--dry` previews, no flag applies."""
import pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP = {"node_modules", ".git", "dist", "package-lock.json"}
RULES = [  # longest first
    ("coingabbarsignals-1.onrender.com", "indiansignals.onrender.com"),
    ("coingabbarproject.github.io", "indiansignals.github.io"),
    ("CoinGabbarSignals", "IndianSignals"),
    ("coingabbarsignals", "indiansignals"),
    ("coingabbar-settings", "indiansignals-settings"),
    ("CoinGabbar", "IndianSignals"),
    ("coingabbar", "indiansignals"),
]
dry = "--dry" in sys.argv
total = 0
for p in ROOT.rglob("*"):
    if not p.is_file() or SKIP & set(p.relative_to(ROOT).parts) or p.name == "rebrand.py":
        continue
    try: s = p.read_text(encoding="utf-8")
    except UnicodeDecodeError: continue
    n, out = 0, s
    for a, b in RULES:
        n += out.count(a); out = out.replace(a, b)
    if n:
        total += n; print(f"{n:3d}  {p.relative_to(ROOT)}")
        if not dry: p.write_text(out, encoding="utf-8")
print(("would replace" if dry else "replaced"), total)
