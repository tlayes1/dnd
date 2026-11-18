"""Shared helpers for the build pipeline: config, 5etools markup handling,
and small normalization utilities. No network here."""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")
TOOLS = os.path.join(CACHE, "5etools-src", "data")
OPEN5E = os.path.join(CACHE, "open5e")
CONFIG = os.path.join(ROOT, "config")


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_config():
    cfg = load_json(os.path.join(CONFIG, "sources.json"))
    included = set(cfg.get("included", []))
    excluded = set(cfg.get("excluded2024", []))
    return included, excluded


def load_races_allowlist():
    """Source allowlist for RACES/SUBRACES = included + racesExtra. Other
    categories use only `included`."""
    cfg = load_json(os.path.join(CONFIG, "sources.json"))
    return set(cfg.get("included", [])) | set(cfg.get("racesExtra", []))


# ---- 2014 edition / source filter -----------------------------------------

def is_allowed(record, included, excluded):
    """A 5etools record is kept iff its source is allowlisted, not a 2024 book,
    and it is not explicitly marked as 2024 ('one') edition."""
    src = record.get("source")
    if src is None or src in excluded:
        return False
    if src not in included:
        return False
    if record.get("edition") == "one":
        return False
    return True


# ---- 5etools {@tag ...} markup ---------------------------------------------

_TAG = re.compile(r"\{@(\w+)\s*([^{}]*)\}")


# Tags shaped {@tag name|source|display}: display is the 3rd segment when present.
_NAME_SOURCE_DISPLAY = {
    "spell", "item", "creature", "condition", "skill", "sense", "action",
    "feat", "class", "race", "background", "disease", "status", "optfeature",
    "classFeature", "subclassFeature", "deity", "hazard", "object", "reward",
    "vehicle", "language", "itemProperty", "itemType", "recipe", "table",
    "book", "adventure", "variantrule", "cult", "boon", "card", "deck",
    "legroup", "quickref",
}
# Tags shaped {@tag text|display}: display is the 2nd segment when present.
_TEXT_DISPLAY = {"footnote", "area", "homebrew", "note", "5etools", "chance"}
# Tags where segment 0 is the display label (rest are params): {@filter label|...}
_LABEL_FIRST = {"filter"}


def _tag_repl(m):
    tag = m.group(1)
    body = m.group(2).strip()
    if not body:
        return ""
    parts = body.split("|")
    first = parts[0]
    if tag in _NAME_SOURCE_DISPLAY:
        # name|source|display -> display if a 3rd non-empty segment exists,
        # otherwise the name (segment 0). Segment 1 is the source, never shown.
        if len(parts) >= 3 and parts[2]:
            return parts[2]
        return first
    if tag in _LABEL_FIRST:
        return first
    if tag in _TEXT_DISPLAY:
        if len(parts) >= 2 and parts[1]:
            return parts[1]
        return first
    if tag in ("damage", "dice", "d20", "hit", "dc", "recharge",
               "scaledamage", "scaledice"):
        return first
    if tag == "h":
        return ""
    # default: first segment
    return first


def strip_markup(text):
    """Convert 5etools {@tag} markup to plain text. Applied repeatedly for
    nested tags."""
    if text is None:
        return None
    prev = None
    out = text
    while prev != out:
        prev = out
        out = _TAG.sub(_tag_repl, out)
    return out


def entries_to_text(entries, _depth=0):
    """Flatten a 5etools 'entries' array to plain text (used sparingly; the text
    policy drops most 5etools prose in favour of page refs)."""
    if entries is None:
        return ""
    out = []
    if isinstance(entries, str):
        return strip_markup(entries)
    if isinstance(entries, dict):
        entries = [entries]
    for e in entries:
        if isinstance(e, str):
            out.append(strip_markup(e))
        elif isinstance(e, dict):
            name = e.get("name")
            if name:
                out.append(strip_markup(name) + ".")
            if "entries" in e:
                out.append(entries_to_text(e["entries"], _depth + 1))
            elif "items" in e:
                out.append(entries_to_text(e["items"], _depth + 1))
            elif e.get("type") == "table":
                out.append(_table_to_text(e))
    return "\n".join(p for p in out if p)


def _table_to_text(tbl):
    rows = []
    heads = tbl.get("colLabels", [])
    if heads:
        rows.append(" | ".join(strip_markup(h) for h in heads))
    for row in tbl.get("rows", []):
        cells = []
        for c in row:
            if isinstance(c, (str, int, float)):
                cells.append(strip_markup(str(c)))
            elif isinstance(c, dict):
                cells.append(entries_to_text([c]))
        rows.append(" | ".join(cells))
    return "\n".join(rows)


def page_ref(record):
    src = record.get("source", "?")
    page = record.get("page")
    if page:
        return "See %s p. %s" % (src, page)
    return "See %s" % src


SCHOOL = {
    "A": "Abjuration", "C": "Conjuration", "D": "Divination",
    "E": "Enchantment", "V": "Evocation", "I": "Illusion",
    "N": "Necromancy", "T": "Transmutation", "P": "Psionic",
}

SIZE = {"T": "Tiny", "S": "Small", "M": "Medium", "L": "Large",
        "H": "Huge", "G": "Gargantuan"}

ABIL = ["str", "dex", "con", "int", "wis", "cha"]
