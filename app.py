#!/usr/bin/env python3
"""
SkillGrid — a local, hacky browser for your markdown skill library.

Point it at any folder of skill .md files (optionally organized in
subfolders, optionally each in its own folder as SKILL.md) and get a
GitHub-style tree sidebar, foldable skill cards, a live-preview/edit
toggle, delete, and a relationship graph built from `related:`
frontmatter.

Usage:
    python app.py --path /path/to/skills
    python app.py --path /path/to/skills --port 7331
    SKILLGRID_PATH=/path/to/skills python app.py
"""

import argparse
import os
import sys
import json
import re
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, abort

try:
    import yaml
except ImportError:
    print("Missing dependency. Run: pip install -r requirements.txt")
    sys.exit(1)

app = Flask(__name__, static_folder="static", template_folder="templates")

FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?\n)---\s*\n?", re.DOTALL)


def split_frontmatter(raw: str):
    """Minimal YAML-frontmatter splitter (avoids depending on the
    python-frontmatter package). Returns (meta_dict, body_str)."""
    m = FRONTMATTER_RE.match(raw)
    if not m:
        return {}, raw
    yaml_block = m.group(1)
    body = raw[m.end():]
    try:
        meta = yaml.safe_load(yaml_block) or {}
        if not isinstance(meta, dict):
            meta = {}
    except yaml.YAMLError:
        meta = {}
    return meta, body

# Set by main() / configure_root() before the app runs.
ROOT = None


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def configure_root(path: str):
    global ROOT
    resolved = Path(path).expanduser().resolve()
    if not resolved.exists():
        print(f"error: path does not exist: {resolved}")
        sys.exit(1)
    if not resolved.is_dir():
        print(f"error: path is not a directory: {resolved}")
        sys.exit(1)
    ROOT = resolved


def safe_resolve(rel_path: str) -> Path:
    """Resolve a path the client sent, refusing anything that escapes ROOT."""
    if rel_path in (None, "", "."):
        candidate = ROOT
    else:
        candidate = (ROOT / rel_path).resolve()
    try:
        candidate.relative_to(ROOT)
    except ValueError:
        abort(400, description="path escapes configured root")
    return candidate


def parse_skill_file(fp: Path):
    """Read a markdown skill file and split frontmatter/body."""
    try:
        raw = fp.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {"meta": {}, "body": ""}

    meta, body = split_frontmatter(raw)
    meta = dict(meta or {})
    # Normalize `related` to a list of strings no matter how it was written
    # (comma string, single string, YAML list).
    related = meta.get("related")
    if related is None:
        related = []
    elif isinstance(related, str):
        related = [r.strip() for r in re.split(r"[,\n]", related) if r.strip()]
    elif isinstance(related, (list, tuple)):
        related = [str(r).strip() for r in related if str(r).strip()]
    else:
        related = []
    meta["related"] = related

    return {"meta": meta, "body": body}


def iter_skill_files(root: Path):
    """Yield every .md file under root, skipping dotfolders/venvs/node_modules."""
    skip_dirs = {".git", "node_modules", "__pycache__", "venv", ".venv", ".idea"}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.startswith(".")]
        for fn in filenames:
            if fn.lower().endswith(".md"):
                yield Path(dirpath) / fn


def build_tree(root: Path):
    """Build a GitHub-style nested tree of folders/files (only dirs that
    contain at least one .md somewhere below them get included)."""

    def node_for_dir(d: Path):
        name = d.name if d != root else root.name
        children = []
        try:
            entries = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except PermissionError:
            entries = []

        skip_dirs = {".git", "node_modules", "__pycache__", "venv", ".venv", ".idea"}
        for entry in entries:
            if entry.is_dir():
                if entry.name in skip_dirs or entry.name.startswith("."):
                    continue
                child = node_for_dir(entry)
                if child is not None:
                    children.append(child)
            elif entry.is_file() and entry.suffix.lower() == ".md":
                skill = parse_skill_file(entry)
                children.append({
                    "type": "file",
                    "name": entry.name,
                    "path": str(entry.relative_to(root)),
                    "skill_name": skill["meta"].get("name", entry.stem),
                    "description": skill["meta"].get("description", ""),
                })

        # Prune empty dirs (no .md anywhere underneath).
        has_md = any(
            c["type"] == "file" or (c["type"] == "dir" and c.get("count", 0) > 0)
            for c in children
        )
        if not has_md and d != root:
            return None

        count = sum(
            1 if c["type"] == "file" else c.get("count", 0)
            for c in children
        )

        return {
            "type": "dir",
            "name": name,
            "path": str(d.relative_to(root)) if d != root else "",
            "children": children,
            "count": count,
        }

    return node_for_dir(root)


# --------------------------------------------------------------------------
# Routes — pages
# --------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(app.template_folder, "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(app.static_folder, filename)


# --------------------------------------------------------------------------
# Routes — API
# --------------------------------------------------------------------------

@app.route("/api/root")
def api_root():
    return jsonify({"root": str(ROOT), "name": ROOT.name})


@app.route("/api/tree")
def api_tree():
    tree = build_tree(ROOT)
    return jsonify(tree or {"type": "dir", "name": ROOT.name, "path": "", "children": [], "count": 0})


@app.route("/api/skills")
def api_skills():
    """Flat list of every skill with meta, for the main scroll view / search."""
    out = []
    for fp in iter_skill_files(ROOT):
        skill = parse_skill_file(fp)
        rel = str(fp.relative_to(ROOT))
        out.append({
            "path": rel,
            "folder": str(fp.parent.relative_to(ROOT)) if fp.parent != ROOT else "",
            "name": skill["meta"].get("name", fp.stem),
            "description": skill["meta"].get("description", ""),
            "related": skill["meta"].get("related", []),
            "size": fp.stat().st_size,
        })
    out.sort(key=lambda s: (s["folder"], s["name"]))
    return jsonify(out)


@app.route("/api/skill")
def api_skill_get():
    rel = request.args.get("path", "")
    fp = safe_resolve(rel)
    if not fp.is_file():
        abort(404, description="file not found")
    skill = parse_skill_file(fp)
    raw = fp.read_text(encoding="utf-8", errors="replace")
    return jsonify({
        "path": rel,
        "meta": skill["meta"],
        "body": skill["body"],
        "raw": raw,
    })


@app.route("/api/skill", methods=["POST"])
def api_skill_save():
    data = request.get_json(force=True, silent=True) or {}
    rel = data.get("path", "")
    content = data.get("raw")
    if content is None:
        abort(400, description="missing 'raw' content")
    fp = safe_resolve(rel)
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(content, encoding="utf-8")
    return jsonify({"ok": True, "path": rel})


@app.route("/api/skill", methods=["DELETE"])
def api_skill_delete():
    rel = request.args.get("path", "")
    fp = safe_resolve(rel)
    if not fp.is_file():
        abort(404, description="file not found")
    fp.unlink()
    return jsonify({"ok": True, "path": rel})


@app.route("/api/graph")
def api_graph():
    """Build a node/edge graph from each skill's `related:` frontmatter.

    Edges are matched by skill `name:` (preferred) and fall back to
    filename stem if a related entry doesn't match any known name.
    """
    skills = []
    for fp in iter_skill_files(ROOT):
        skill = parse_skill_file(fp)
        rel = str(fp.relative_to(ROOT))
        name = skill["meta"].get("name", fp.stem)
        skills.append({
            "path": rel,
            "name": name,
            "description": skill["meta"].get("description", ""),
            "related": skill["meta"].get("related", []),
        })

    name_to_path = {s["name"]: s["path"] for s in skills}
    stem_to_path = {Path(s["path"]).stem: s["path"] for s in skills}

    nodes = [
        {"id": s["path"], "label": s["name"], "title": s["description"]}
        for s in skills
    ]

    edges = []
    seen = set()
    for s in skills:
        for r in s["related"]:
            target = name_to_path.get(r) or stem_to_path.get(r)
            if not target or target == s["path"]:
                continue
            key = tuple(sorted((s["path"], target)))
            if key in seen:
                continue
            seen.add(key)
            edges.append({"from": s["path"], "to": target})

    return jsonify({"nodes": nodes, "edges": edges})


# --------------------------------------------------------------------------
# Entrypoint
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="SkillGrid — browse, edit, and graph a folder of markdown skills."
    )
    parser.add_argument(
        "--path", "-p",
        default=os.environ.get("SKILLGRID_PATH", "."),
        help="Path to the folder containing your skill .md files (default: current dir, or $SKILLGRID_PATH)",
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("SKILLGRID_PORT", 7331)))
    parser.add_argument("--host", default=os.environ.get("SKILLGRID_HOST", "127.0.0.1"))
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    configure_root(args.path)

    n_skills = sum(1 for _ in iter_skill_files(ROOT))
    print(r"""
   _____ __   _ ____  __ _____     _     __
  / ___// /__(_) / / / // ___/____(_)___/ /
  \__ \/ //_/ / / / / / \__ \/ ___/ / __  /
 ___/ / ,< / / / / / / ___/ / /  / / /_/ /
/____/_/|_/_/_/ /_/_/ /____/_/  /_/\__,_/
""")
    print(f"  root:   {ROOT}")
    print(f"  skills: {n_skills} .md files found")
    print(f"  url:    http://{args.host}:{args.port}")
    print()

    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
