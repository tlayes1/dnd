"""Steps 2-4 (normalize, merge, text policy): turn 5etools + Open5e into one
internal schema. 5etools supplies mechanics. Per the user's request (see
design.md), full descriptive text is now KEPT for all content: 5etools prose is
converted from `entries` + {@tag} markup to readable text, and Open5e SRD prose
is preferred when available. `textRef` (page citation) is kept alongside. No LLM
summaries anywhere."""
import os
import re

from util import (ABIL, OPEN5E, SCHOOL, SIZE, TOOLS, entries_to_text, is_allowed,
                  load_config, load_races_allowlist, load_json, page_ref,
                  strip_markup)

INCLUDED, EXCLUDED = load_config()
# Races/subraces use a wider allowlist (included + racesExtra) so missing player
# races can be added without pulling in those books' feats/spells/items/bgs.
RACE_INCLUDED = load_races_allowlist()


def _open5e(name):
    p = os.path.join(OPEN5E, name + ".json")
    return load_json(p) if os.path.exists(p) else []


def _slug(*parts):
    return "|".join(str(p).lower() for p in parts)


def text_from(entries, *fallbacks):
    """Build readable prose. Prefer the first non-empty fallback (e.g. Open5e
    SRD text already in markdown); otherwise flatten 5etools `entries`."""
    for fb in fallbacks:
        if fb:
            return fb
    if entries:
        t = entries_to_text(entries)
        return t or None
    return None


# ===========================================================================
# RACES  (5etools mechanics + Open5e SRD prose)
# ===========================================================================

def _ability_list(ability):
    """5etools ability -> [{str:2},...] or choose blocks. Return normalized."""
    out = []
    if not ability:
        return out
    for block in ability:
        entry = {}
        for ab in ABIL:
            if ab in block:
                entry[ab] = block[ab]
        if "choose" in block:
            ch = block["choose"]
            entry["choose"] = {
                "count": ch.get("count", 1),
                "amount": ch.get("amount", 1),
                "from": ch.get("from", ABIL),
            }
        if entry:
            out.append(entry)
    return out


def _speed(speed):
    if isinstance(speed, int):
        return {"walk": speed}
    if isinstance(speed, dict):
        out = {}
        for k, v in speed.items():
            if isinstance(v, bool):
                out[k] = 30 if v else 0
            elif isinstance(v, (int, float)):
                out[k] = v
            elif isinstance(v, dict) and "number" in v:
                out[k] = v["number"]
        return out
    return {"walk": 30}


def _lang_profs(lp):
    langs = []
    anon = 0
    if not lp:
        return {"fixed": [], "choose": 0}
    for block in lp:
        for k, v in block.items():
            if k == "anyStandard":
                anon += v
            elif k == "any":
                anon += v
            elif v is True:
                langs.append(k.capitalize())
    return {"fixed": langs, "choose": anon}


def _skill_profs(sp):
    """Return {fixed:[...], choose:{count,from:[...]}}."""
    fixed, choose = [], None
    if not sp:
        return {"fixed": [], "choose": None}
    for block in sp:
        for k, v in block.items():
            if k == "choose":
                frm = v.get("from", [])
                choose = {"count": v.get("count", 1),
                          "from": [s.capitalize() for s in frm]}
            elif k == "any":
                choose = {"count": v, "from": "any"}
            elif v is True:
                fixed.append(k.capitalize())
    return {"fixed": fixed, "choose": choose}


def _race_traits(entries):
    """Pull trait names from 5etools race entries (names only)."""
    out = []
    if not entries:
        return out
    for e in entries:
        if isinstance(e, dict) and e.get("name"):
            out.append(e["name"])
    return out


# ---- subrace/race field extraction ----------------------------------------

def _prof_names(blocks):
    """weapon/armor/toolProficiencies: [{"name|src": true, ...}] -> [display]."""
    out = []
    if not blocks:
        return out
    for block in blocks:
        if not isinstance(block, dict):
            continue
        for k, v in block.items():
            if v is True:
                out.append(k.split("|")[0])
            elif k == "choose":
                frm = v.get("from", []) if isinstance(v, dict) else []
                out.append("choose %d: %s" % (v.get("count", 1),
                           ", ".join(str(x).split("|")[0] for x in frm)))
            elif k in ("anyArmorLight", "anyArmorMedium", "anyArmorHeavy",
                       "anyWeapon", "anyTool"):
                out.append(k)
    return out


def _resist(blocks):
    out = []
    for r in blocks or []:
        if isinstance(r, str):
            out.append(r)
        elif isinstance(r, dict):
            # e.g. {"choose": {"from": [...]}} or {"resist": [...]}
            if "choose" in r:
                frm = r["choose"].get("from", [])
                out.append("choose: " + ", ".join(frm))
            else:
                for v in r.values():
                    if isinstance(v, list):
                        out.extend(x for x in v if isinstance(x, str))
    return out


def _spell_name(raw):
    """Strip 5etools spell suffixes: 'dancing lights#c' (cantrip),
    'ray of sickness#2' (cast at 2nd level). Returns (name, tag)."""
    s = str(raw)
    tag = None
    if "#" in s:
        s, suf = s.split("#", 1)
        tag = "cantrip" if suf == "c" else ("as L" + suf if suf.isdigit() else suf)
    return s.strip(), tag


def _freq_recharge(freq_key):
    """Map a 5etools innate-spell frequency key to (freq label, recharge type).
    'daily'/'rest' -> once per long rest; 'will' -> at-will."""
    k = str(freq_key).lower()
    if k in ("will", "atwill"):
        return "at will", "at-will"
    if k == "ritual":
        return "ritual", "manual"
    # daily / rest / long-rest style
    return "1/long rest", "long"


def _additional_spells(blocks):
    """Normalize race/subrace additionalSpells into
    {known:[{name,tag}], innate:[{level,freq,recharge,spells}], choose:[{level,count,from,ability}], ability}.
    Keeps usage frequency + a recharge tag (addition #2)."""
    out = {"known": [], "innate": [], "choose": [], "ability": None}
    if not blocks:
        return out
    for blk in blocks:
        if not isinstance(blk, dict):
            continue
        out["ability"] = out["ability"] or blk.get("ability")
        # known: {"1": ["dancing lights#c", ...]} or {"1": {"_": [{choose:...}]}}
        known = blk.get("known")
        if isinstance(known, dict):
            for lvl, val in known.items():
                if isinstance(val, list):
                    for sp in val:
                        if isinstance(sp, str):
                            nm, tag = _spell_name(sp)
                            out["known"].append({"name": nm, "tag": tag,
                                                 "atLevel": _int(lvl)})
                        elif isinstance(sp, dict) and "choose" in sp:
                            out["choose"].append({"atLevel": _int(lvl), "count": 1,
                                                  "from": sp["choose"],
                                                  "ability": blk.get("ability")})
                elif isinstance(val, dict):
                    # {"_": [{choose: "level=0|class=Wizard"}]}
                    for arr in val.values():
                        for sp in arr:
                            if isinstance(sp, dict) and "choose" in sp:
                                out["choose"].append({"atLevel": _int(lvl), "count": 1,
                                                      "from": sp["choose"],
                                                      "ability": blk.get("ability")})
        # innate: {"3": {"daily": {"1": ["faerie fire"]}}, "5": {...}} or {"3": ["x"]}
        innate = blk.get("innate")
        if isinstance(innate, dict):
            for lvl, val in innate.items():
                if isinstance(val, list):
                    spells = [_spell_name(s)[0] for s in val]
                    out["innate"].append({"level": _int(lvl), "freq": "at will",
                                          "recharge": "at-will", "spellList": spells})
                elif isinstance(val, dict):
                    for freq_key, inner in val.items():
                        freq, rech = _freq_recharge(freq_key)
                        if isinstance(inner, dict):
                            for _cnt, arr in inner.items():
                                spells = [_spell_name(s)[0] for s in arr]
                                out["innate"].append({"level": _int(lvl), "freq": freq,
                                                      "recharge": rech, "spellList": spells})
                        elif isinstance(inner, list):
                            spells = [_spell_name(s)[0] for s in inner]
                            out["innate"].append({"level": _int(lvl), "freq": freq,
                                                  "recharge": rech, "spellList": spells})
        # choose blocks keyed under additionalSpells directly
        ch = blk.get("choose")
        if isinstance(ch, list):
            for c in ch:
                out["choose"].append({"atLevel": 1, "count": 1, "from": c,
                                      "ability": blk.get("ability")})
    return out


def _int(x):
    try:
        return int(x)
    except (ValueError, TypeError):
        return 1


def _trait_objs(record, subs_lookup):
    """Build trait objects [{name, text|textRef, overwrite?}] from entries,
    honoring the text policy and capturing data.overwrite markers (addition #1).
    Also detects racial ACTIVE features that recharge (e.g. Breath Weapon)."""
    out = []
    srd = bool(record.get("srd"))
    for e in record.get("entries", []) or []:
        if not isinstance(e, dict) or not e.get("name"):
            continue
        name = e["name"]
        overwrite = (e.get("data") or {}).get("overwrite")
        full = entries_to_text(e.get("entries"))
        trait = {"name": name}
        if srd and full:
            trait["text"] = full
        elif full and record.get("source") in ("PHB",):  # PHB basic/SRD-ish prose kept
            trait["text"] = full
        else:
            # keep full flattened text too (relaxed text policy is in effect)
            trait["text"] = full or None
            trait["textRef"] = page_ref(record)
        if not trait.get("text") and not trait.get("textRef"):
            trait["textRef"] = page_ref(record)
        if overwrite:
            trait["overwrite"] = overwrite
        # detect a rechargeable racial active (e.g. Dragonborn Breath Weapon)
        rech = _trait_recharge(full)
        if rech:
            trait["recharge"] = rech
            trait["active"] = True
        out.append(trait)
    return out


def _trait_recharge(text):
    """Infer a recharge type for a racial active from its prose."""
    if not text:
        return None
    t = text.lower()
    if "short or long rest" in t or "short rest or" in t:
        return "short"
    if "long rest" in t and ("use it again" in t or "can't use it again" in t
                             or "until you finish" in t):
        return "long"
    return None


def normalize_races():
    data = load_json(os.path.join(TOOLS, "races.json"))
    all_races = data.get("race", [])
    races_raw = [r for r in all_races if is_allowed(r, RACE_INCLUDED, EXCLUDED)]
    subs_raw = data.get("subrace", [])

    # Open5e SRD prose keyed by lowered name.
    o5e = {r["name"].lower(): r for r in _open5e("races")}

    races = {}
    for r in races_raw:
        # Resolve base-race inheritance (e.g. MOT Centaur/Minotaur _copy from
        # GGR with _mod tweaks). Base races can use the same mechanisms subraces
        # do, so the traits/fields come from the referenced parent.
        r = _resolve_race_copy(r, all_races)
        name = r["name"]
        key = _slug(name, r["source"])
        srd = bool(r.get("srd"))
        o = o5e.get(name.lower()) if srd else None
        races[key] = {
            "name": name,
            "source": r["source"],
            "page": r.get("page"),
            "srd": srd,
            "size": [SIZE.get(s, s) for s in (r.get("size") or ["M"])],
            "speed": _speed(r.get("speed", 30)),
            "ability": _ability_list(r.get("ability")),
            "darkvision": r.get("darkvision", 0),
            "languages": _lang_profs(r.get("languageProficiencies")),
            "skillProficiencies": _skill_profs(r.get("skillProficiencies")),
            "weaponProficiencies": _prof_names(r.get("weaponProficiencies")),
            "armorProficiencies": _prof_names(r.get("armorProficiencies")),
            "toolProficiencies": _prof_names(r.get("toolProficiencies")),
            "resist": _resist(r.get("resist")),
            "additionalSpells": _additional_spells(r.get("additionalSpells")),
            "traitTags": r.get("traitTags", []),
            "traits": _trait_objs(r, None),
            "text": text_from(r.get("entries"),
                               (o.get("traits") or o.get("desc")) if o else None),
            "textRef": page_ref(r),
            "subraces": [],
        }

    # Subraces: resolve _copy, expand _versions, then fully extract.
    all_subs = data.get("subrace", [])
    for raw in all_subs:
        resolved = _resolve_copy(raw, all_subs, data.get("race", []))
        for sr in _resolve_versions(resolved):
            # guard: nothing half-merged should remain
            for k in ("_copy", "_mod", "_versions"):
                sr.pop(k, None)
            rsrc = sr.get("raceSource")
            rname = sr.get("raceName")
            if not rname:
                continue
            pkey = _slug(rname, rsrc)
            if pkey not in races:
                continue  # parent race not in allowlist
            if not is_allowed_subrace(sr):
                continue
            # skip template-expansion artifacts with unresolved {{vars}}
            nm_raw = sr.get("name")
            if nm_raw and "{{" in nm_raw:
                continue
            traits = _trait_objs(sr, None)
            addspells = _additional_spells(sr.get("additionalSpells"))
            has_spells = bool(addspells["known"] or addspells["innate"] or addspells["choose"])
            # "meaningful" = has traits, an ability bonus, profs, or spells.
            # (A bare `resist`-only record is a color/ancestry variant handled by
            #  an in-race chooser, not a real subrace, e.g. Dragonborn colors.)
            meaningful = bool(traits or sr.get("ability") or has_spells
                              or sr.get("weaponProficiencies")
                              or sr.get("armorProficiencies")
                              or sr.get("toolProficiencies"))
            if not meaningful:
                continue
            # nameless subraces are the race's default variant
            display = nm_raw or ("Base " + rname)
            field_ow = sr.get("overwrite") or {}
            sub = {
                "name": display,
                "nameless": not sr.get("name"),
                "source": sr.get("source"),
                "page": sr.get("page"),
                "srd": bool(sr.get("srd")),
                "ability": _ability_list(sr.get("ability")),
                "speed": _speed(sr["speed"]) if "speed" in sr else None,
                "darkvision": sr.get("darkvision"),
                "resist": _resist(sr.get("resist")),
                "languages": _lang_profs(sr.get("languageProficiencies")),
                "skillProficiencies": _skill_profs(sr.get("skillProficiencies")),
                "weaponProficiencies": _prof_names(sr.get("weaponProficiencies")),
                "armorProficiencies": _prof_names(sr.get("armorProficiencies")),
                "toolProficiencies": _prof_names(sr.get("toolProficiencies")),
                "additionalSpells": addspells,
                "traitTags": sr.get("traitTags", []),
                # record-level overwrite markers (which fields replace the base)
                "overwriteFields": sorted(k for k, v in field_ow.items() if v),
                "traits": traits,
                "text": text_from(sr.get("entries")),
                "textRef": page_ref(sr),
            }
            races[pkey]["subraces"].append(sub)

    return _dedupe_races_by_name(list(races.values()))


# Source priority for collapsing races that share a name across included books
# (decision 1a: core first, then MOT before GGR, then the rest). Unlisted
# sources sort last by their position here (i.e. lowest priority).
SOURCE_PRIORITY = ["PHB", "MOT", "GGR", "MTF", "VGM", "SCAG", "TCE", "XGE",
                   "ERLW", "EEPC", "WBtW", "AAG", "VRGR", "SCC", "TTP", "LR", "AI"]


def _src_rank(src):
    try:
        return SOURCE_PRIORITY.index(src)
    except ValueError:
        return len(SOURCE_PRIORITY)


def _dedupe_races_by_name(races):
    """Collapse races sharing a name to a single entry, preferring the highest-
    priority source. Subraces from the dropped same-name parents are merged onto
    the kept parent (deduped by subrace name)."""
    by_name = {}
    for r in races:
        by_name.setdefault(r["name"], []).append(r)
    out = []
    for name, group in by_name.items():
        group.sort(key=lambda r: _src_rank(r.get("source")))
        keeper = group[0]
        if len(group) > 1:
            seen = {s["name"] for s in keeper.get("subraces", [])}
            for other in group[1:]:
                for s in other.get("subraces", []):
                    if s["name"] not in seen:
                        keeper["subraces"].append(s)
                        seen.add(s["name"])
        out.append(keeper)
    out.sort(key=lambda r: r["name"])
    return out


def is_allowed_subrace(sr):
    src = sr.get("source")
    if src is None or src in EXCLUDED or src not in RACE_INCLUDED:
        return False
    if sr.get("edition") == "one":
        return False
    return True


import copy as _copylib


def _apply_mod(record, mod):
    """Apply 5etools _mod ops to a record's `entries` (and similar arrays),
    matching entries by `name`. Supports replaceArr/appendArr/insertArr/
    removeArr/prependArr."""
    if not isinstance(mod, dict):
        return record
    for field, ops in mod.items():
        if field == "*":
            continue
        op_list = ops if isinstance(ops, list) else [ops]
        arr = record.get(field)
        if not isinstance(arr, list):
            arr = [] if arr is None else [arr]
        for op in op_list:
            if not isinstance(op, dict):
                continue
            mode = op.get("mode")
            items = op.get("items")
            new_items = items if isinstance(items, list) else ([items] if items is not None else [])
            if mode == "replaceArr":
                target = op.get("replace")
                arr = [new_items[0] if (isinstance(x, dict) and x.get("name") == target) else x
                       for x in arr] if new_items else arr
            elif mode == "appendArr":
                arr = arr + new_items
            elif mode == "prependArr":
                arr = new_items + arr
            elif mode == "insertArr":
                idx = op.get("index", len(arr))
                arr = arr[:idx] + new_items + arr[idx:]
            elif mode == "removeArr":
                names = op.get("names")
                names = names if isinstance(names, list) else ([names] if names else [])
                arr = [x for x in arr if not (isinstance(x, dict) and x.get("name") in names)]
        record[field] = arr
    return record


def _resolve_race_copy(record, races, _seen=None):
    """Resolve 5etools _copy for a base RACE: deep-merge from the referenced base
    race (recursively), then apply its _mod ops. Returns a record with no _copy."""
    if "_copy" not in record:
        return record
    _seen = _seen or set()
    cp = record["_copy"]
    sig = (cp.get("name"), cp.get("source"))
    if sig in _seen:
        return {k: v for k, v in record.items() if k != "_copy"}
    _seen.add(sig)
    base = None
    for r in races:
        if r.get("name") == cp.get("name") and r.get("source") == cp.get("source"):
            base = r
            break
    if base is None:
        return {k: v for k, v in record.items() if k != "_copy"}
    base = _resolve_race_copy(base, races, _seen)  # resolve chained copies
    merged = _copylib.deepcopy(base)
    if isinstance(cp.get("_mod"), dict):
        merged = _apply_mod(merged, cp["_mod"])
    for k, v in record.items():
        if k == "_copy":
            continue
        merged[k] = v
    return merged


def _resolve_copy(record, subs, races):
    """Resolve 5etools _copy for subraces: deep-merge from the referenced base
    subrace, then apply _mod ops and field overrides."""
    if "_copy" not in record:
        return record
    cp = record["_copy"]
    base = None
    for s in subs:
        if s.get("name") == cp.get("name") and s.get("source") == cp.get("source"):
            base = s
            break
    if base is None:
        return {k: v for k, v in record.items() if k != "_copy"}
    merged = _copylib.deepcopy(base)
    # apply the _copy's own _mod first (ops against the base)
    if isinstance(cp.get("_mod"), dict):
        merged = _apply_mod(merged, cp["_mod"])
    for k, v in record.items():
        if k in ("_copy",):
            continue
        merged[k] = v
    return merged


def _resolve_versions(record):
    """Expand a subrace _versions array into concrete subrace records. Each
    version clones the parent template and applies its own _mod / _abstract."""
    versions = record.get("_versions")
    if not versions:
        return [record]
    template = {k: v for k, v in record.items() if k != "_versions"}
    out = []
    for ver in versions:
        inst = _copylib.deepcopy(template)
        # _abstract + _implementations style (variable substitution)
        if "_abstract" in ver:
            abstract = _copylib.deepcopy(ver["_abstract"])
            mod = abstract.pop("_mod", None)
            for impl in ver.get("_implementations", []):
                variant = _copylib.deepcopy(inst)
                merged = _deep_update(variant, _copylib.deepcopy(abstract))
                variables = impl.get("_variables", impl.get("variables", {}))
                for k, v in impl.items():
                    if k in ("_variables", "variables"):
                        continue
                    merged[k] = v
                if isinstance(mod, (dict, list)):
                    merged = _apply_mod(merged, _copylib.deepcopy(mod)
                                        if isinstance(mod, dict) else {"entries": mod})
                merged = _subst_vars(merged, variables)
                out.append(merged)
            continue
        for k, v in ver.items():
            if k == "_mod":
                continue
            inst[k] = v
        if isinstance(ver.get("_mod"), dict):
            inst = _apply_mod(inst, ver["_mod"])
        out.append(inst)
    return out


def _deep_update(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_update(dst[k], v)
        else:
            dst[k] = v
    return dst


def _subst_vars(obj, variables):
    import re as _re
    if isinstance(obj, str):
        def rep(m):
            return str(variables.get(m.group(1), m.group(0)))
        return _re.sub(r"\{\{(\w+)\}\}", rep, obj)
    if isinstance(obj, list):
        return [_subst_vars(x, variables) for x in obj]
    if isinstance(obj, dict):
        return {k: _subst_vars(v, variables) for k, v in obj.items()}
    return obj


# ===========================================================================
# CLASSES  (5etools mechanics; prose -> page refs)
# ===========================================================================

def _ref_key(ref):
    """Parse 'Feature|Class|ClassSource|Level' -> dict."""
    parts = ref.split("|")
    # pad
    while len(parts) < 4:
        parts.append("")
    return parts


def _index_features(flist):
    idx = {}
    for f in flist:
        k = (f.get("name"), f.get("className"), f.get("classSource") or f.get("source"),
             f.get("level"))
        idx[k] = f
    return idx


def _index_sub_features(flist):
    idx = {}
    for f in flist:
        k = (f.get("name"), f.get("className"),
             f.get("subclassShortName"), f.get("level"))
        idx[k] = f
    return idx


SKILL_NAMES = ["Acrobatics", "Animal Handling", "Arcana", "Athletics",
               "Deception", "History", "Insight", "Intimidation",
               "Investigation", "Medicine", "Nature", "Perception",
               "Performance", "Persuasion", "Religion", "Sleight of Hand",
               "Stealth", "Survival"]


def _class_skills(sp):
    if not sp:
        return None
    for block in sp:
        if "choose" in block:
            ch = block["choose"]
            frm = ch.get("from", [])
            return {"count": ch.get("count", 1),
                    "from": [s.capitalize() for s in frm]}
        if "any" in block:
            return {"count": block["any"], "from": "any"}
    return None


def _starting_equipment(se):
    """Keep structured equipment choices as plain strings."""
    out = {"choices": [], "goldAlternative": None}
    if not se:
        return out
    for group in se.get("default", []):
        out["choices"].append(strip_markup(group) if isinstance(group, str)
                              else entries_to_text([group]))
    ga = se.get("goldAlternative")
    if ga:
        out["goldAlternative"] = strip_markup(ga) if isinstance(ga, str) else str(ga)
    return out


def _multiclass(mc):
    if not mc:
        return None
    req = mc.get("requirements", {})
    prof = mc.get("proficienciesGained", {})
    return {
        "requirements": req,
        "proficiencies": {
            "armor": prof.get("armor", []),
            "weapons": prof.get("weapons", []),
            "skills": _class_skills(prof.get("skills")),
            "tools": prof.get("tools", []),
        },
    }


# ===========================================================================
# CLASS RESOURCES (2014) + spellcasting extras (pact / sorcery / conversion)
# ---------------------------------------------------------------------------
# 2014 non-slot resource maximums are mostly stated as prose/formula in the
# data (not as classTableGroups columns), so we emit them here by rule, each
# tagged with a recharge type. Values cited to the 2014 PHB / XGE / TCE.
# maxByLevel is 1-indexed padded to 20 (index i = character/class level i+1).
# ===========================================================================

def _lvl20(fn):
    """Build a 20-length list from a level->value function (1..20)."""
    return [fn(L) for L in range(1, 21)]


def _steps(breakpoints, default=0):
    """breakpoints: list of (level, value); returns a 20-list where value holds
    from its level until the next breakpoint."""
    def val(L):
        v = default
        for lvl, x in breakpoints:
            if L >= lvl:
                v = x
        return v
    return _lvl20(val)


def _read_table_col(c, col_names):
    """Read a classTableGroups column (by any of col_names, case/markup-insensitive)
    into a 20-list of ints. Cells may be str/int/{type:bonus,value}. Returns None
    if no matching column."""
    import re as _re
    for grp in c.get("classTableGroups", []) or []:
        labels = grp.get("colLabels", []) or []
        idx = None
        for i, lab in enumerate(labels):
            plain = _re.sub(r"\{@\w+ ([^|}]*)[^}]*\}", r"\1", str(lab)).strip().lower()
            if plain in [n.lower() for n in col_names]:
                idx = i
                break
        if idx is None:
            continue
        out = []
        for row in grp.get("rows", []):
            if idx >= len(row):
                out.append(0)
                continue
            cell = row[idx]
            if isinstance(cell, dict):
                out.append(cell.get("value", 0))
            elif isinstance(cell, str):
                m = _re.search(r"\d+", cell)
                out.append(int(m.group()) if m else (999 if "unlimited" in cell.lower() else 0))
            elif isinstance(cell, (int, float)):
                out.append(int(cell))
            else:
                out.append(0)
        while len(out) < 20:
            out.append(out[-1] if out else 0)
        return out[:20]
    return None


def _class_resources(c, subclasses):
    """Return the resource list for a 2014 class (+ its allowed subclasses)."""
    name = c.get("name")
    res = []

    if name == "Barbarian":
        rages = _read_table_col(c, ["Rages"]) or _steps(
            [(1, 2), (3, 3), (6, 4), (12, 5), (17, 6), (20, 999)])
        res.append({"key": "rage", "name": "Rage", "recharge": "long",
                    "maxByLevel": rages, "note": "Unlimited at level 20."})

    if name == "Monk":
        ki = _read_table_col(c, ["Ki Points", "Focus Points"]) or _lvl20(
            lambda L: 0 if L < 2 else L)
        res.append({"key": "ki", "name": "Ki Points", "recharge": "short",
                    "maxByLevel": ki})

    if name == "Fighter":
        res.append({"key": "second-wind", "name": "Second Wind", "recharge": "short",
                    "maxByLevel": _lvl20(lambda L: 1)})
        res.append({"key": "action-surge", "name": "Action Surge", "recharge": "short",
                    "maxByLevel": _steps([(2, 1), (17, 2)])})
        res.append({"key": "indomitable", "name": "Indomitable", "recharge": "long",
                    "maxByLevel": _steps([(9, 1), (13, 2), (17, 3)])})

    if name == "Cleric":
        res.append({"key": "channel-divinity", "name": "Channel Divinity", "recharge": "short",
                    "maxByLevel": _steps([(2, 1), (6, 2), (18, 3)])})

    if name == "Paladin":
        res.append({"key": "lay-on-hands", "name": "Lay on Hands (HP pool)", "recharge": "long",
                    "maxByLevel": _lvl20(lambda L: L * 5)})
        res.append({"key": "channel-divinity", "name": "Channel Divinity", "recharge": "short",
                    "maxByLevel": _steps([(3, 1)])})

    if name == "Druid":
        res.append({"key": "wild-shape", "name": "Wild Shape", "recharge": "short",
                    "maxByLevel": _steps([(2, 2)])})

    if name == "Bard":
        # uses = max(1, CHA mod) computed in-app; die stated here by level.
        res.append({"key": "bardic-inspiration", "name": "Bardic Inspiration",
                    "recharge": "short", "usesAbility": "cha",
                    "maxByLevel": _lvl20(lambda L: 0),  # resolved to CHA mod in-app
                    "die": _steps([(1, 6), (5, 8), (10, 10), (15, 12)], default=6),
                    "note": "Uses = Charisma modifier (min 1); short rest from level 5."})

    if name == "Wizard":
        res.append({"key": "arcane-recovery", "name": "Arcane Recovery", "recharge": "long",
                    "maxByLevel": _lvl20(lambda L: 1),
                    "note": "Once per day on a short rest; recover slot levels up to ceil(level/2), none above 5th."})

    if name == "Sorcerer":
        sp = _read_table_col(c, ["Sorcery Points"]) or _lvl20(lambda L: 0 if L < 2 else L)
        res.append({"key": "sorcery-points", "name": "Sorcery Points", "recharge": "long",
                    "maxByLevel": sp})

    # Battle Master superiority dice (subclass-scoped)
    for s in subclasses:
        if s.get("shortName") == "Battle Master" or s.get("name") == "Battle Master":
            res.append({"key": "superiority-dice", "name": "Superiority Dice",
                        "recharge": "short", "subclass": s.get("name"),
                        "maxByLevel": _steps([(3, 4), (7, 5), (15, 6)]),
                        "die": _steps([(3, 8), (10, 10), (18, 12)], default=8)})
    return res


def _pact_tables():
    """Warlock Pact Magic: slot count + uniform slot level per warlock level
    (index 0 = level 1). 2014 PHB."""
    count = [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4]
    slvl = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]
    return count, slvl


def _sorcery_conversion():
    """2014 Font of Magic 'Creating Spell Slots' costs (slot level -> SP cost)."""
    return [{"slotLevel": 1, "cost": 2}, {"slotLevel": 2, "cost": 3},
            {"slotLevel": 3, "cost": 5}, {"slotLevel": 4, "cost": 6},
            {"slotLevel": 5, "cost": 7}]


def normalize_classes():
    classes = []
    cdir = os.path.join(TOOLS, "class")
    for fn in sorted(os.listdir(cdir)):
        if not fn.startswith("class-") or not fn.endswith(".json"):
            continue
        data = load_json(os.path.join(cdir, fn))
        feat_idx = _index_features(data.get("classFeature", []))
        subfeat_idx = _index_sub_features(data.get("subclassFeature", []))
        for c in data.get("class", []):
            if not is_allowed(c, INCLUDED, EXCLUDED):
                continue
            # Sidekicks (TCE) are NPC companion rules, not playable classes:
            # no saving-throw proficiencies. Exclude them.
            if "Sidekick" in c["name"]:
                continue
            cname, csrc = c["name"], c["source"]
            features = []
            for ref in c.get("classFeatures", []):
                if isinstance(ref, dict):
                    ref_str = ref.get("classFeature", "")
                    gain_subclass = ref.get("gainSubclassFeature", False)
                else:
                    ref_str = ref
                    gain_subclass = False
                fn_, fc, fcs, lvl = _ref_key(ref_str)[:4]
                try:
                    lvl_i = int(lvl)
                except (ValueError, TypeError):
                    lvl_i = None
                rec = feat_idx.get((fn_, fc, fcs or csrc, lvl_i))
                features.append({
                    "name": fn_,
                    "level": lvl_i,
                    "text": text_from(rec.get("entries")) if rec else None,
                    "textRef": page_ref(rec) if rec else ("See %s" % csrc),
                    "gainSubclass": gain_subclass,
                })
            # subclasses
            subclasses = []
            sub_level = None
            for s in data.get("subclass", []):
                if s.get("className") != cname or s.get("classSource") != csrc:
                    continue
                if not is_allowed(s, INCLUDED, EXCLUDED):
                    continue
                sfeatures = []
                for ref in s.get("subclassFeatures", []):
                    parts = ref.split("|")
                    # Name|Class|ClassSrc|SubShort|SubSrc|Level
                    sfn = parts[0]
                    slvl = None
                    if len(parts) >= 6:
                        try:
                            slvl = int(parts[5])
                        except (ValueError, TypeError):
                            slvl = None
                    sshort = parts[3] if len(parts) > 3 else s.get("shortName")
                    rec = subfeat_idx.get((sfn, cname, sshort, slvl))
                    if slvl is not None and (sub_level is None or slvl < sub_level):
                        sub_level = slvl
                    sfeatures.append({
                        "name": sfn,
                        "level": slvl,
                        "text": text_from(rec.get("entries")) if rec else None,
                        "textRef": page_ref(rec) if rec else ("See %s" % s.get("source")),
                    })
                subclasses.append({
                    "name": s["name"],
                    "shortName": s.get("shortName"),
                    "source": s["source"],
                    "page": s.get("page"),
                    "features": sfeatures,
                })
            saves = c.get("proficiency", [])
            classes.append({
                "name": cname,
                "source": csrc,
                "page": c.get("page"),
                "srd": bool(c.get("srd")),
                "hd": c.get("hd", {"number": 1, "faces": 8}),
                "saves": saves,
                "proficiencies": {
                    "armor": c.get("startingProficiencies", {}).get("armor", []),
                    "weapons": c.get("startingProficiencies", {}).get("weapons", []),
                    "tools": c.get("startingProficiencies", {}).get("tools", []),
                    "skills": _class_skills(c.get("startingProficiencies", {}).get("skills")),
                },
                "startingEquipment": _starting_equipment(c.get("startingEquipment")),
                "multiclassing": _multiclass(c.get("multiclassing")),
                "spellcasting": _class_spellcasting(c),
                "subclassLevel": sub_level or 3,
                "subclassTitle": c.get("subclassTitle", "Subclass"),
                "features": features,
                "subclasses": subclasses,
                "resources": _class_resources(c, subclasses),
                "textRef": page_ref(c),
            })
    return classes


def _class_spellcasting(c):
    sc = {
        "ability": c.get("spellcastingAbility"),
        "progression": c.get("casterProgression"),
        "prepared": bool(c.get("preparedSpells")),
        "cantripProgression": c.get("cantripProgression"),
        "spellsKnown": c.get("spellsKnownProgressionFixed")
        or c.get("spellsKnownProgression"),
    }
    prog = c.get("casterProgression")
    if prog == "pact":
        count, slvl = _pact_tables()
        sc["pact"] = {"countByLevel": count, "slotLevelByLevel": slvl}
    if c.get("name") == "Sorcerer":
        sc["sorceryConversion"] = _sorcery_conversion()
    if c.get("name") == "Wizard":
        sc["arcaneRecovery"] = True
    return sc


# ===========================================================================
# SPELLS  (5etools mechanics + class map; Open5e SRD prose)
# ===========================================================================

_SPELL_SRC_FILES = None


def _spell_class_lookup():
    p = os.path.join(TOOLS, "generated", "gendata-spell-source-lookup.json")
    return load_json(p)


def _fmt_time(time):
    if not time:
        return ""
    t = time[0]
    n = t.get("number", 1)
    unit = t.get("unit", "")
    cond = t.get("condition")
    s = "%s %s" % (n, unit)
    if cond:
        s += ", %s" % strip_markup(cond)
    return s


def _fmt_range(rng):
    if not rng:
        return ""
    typ = rng.get("type")
    dist = rng.get("distance", {})
    if typ == "point":
        dt = dist.get("type")
        if dt == "self":
            return "Self"
        if dt == "touch":
            return "Touch"
        if dt == "sight":
            return "Sight"
        if dt == "unlimited":
            return "Unlimited"
        amt = dist.get("amount")
        return "%s %s" % (amt, dt) if amt is not None else (dt or "")
    if typ in ("radius", "sphere", "cone", "line", "cube", "hemisphere"):
        amt = dist.get("amount")
        return "Self (%s-%s %s)" % (amt, dist.get("type", "feet"), typ)
    if typ == "special":
        return "Special"
    return typ or ""


def _fmt_duration(dur):
    if not dur:
        return ""
    d = dur[0]
    typ = d.get("type")
    if typ == "instant":
        return "Instantaneous"
    if typ == "special":
        return "Special"
    if typ == "permanent":
        return "Until dispelled"
    if typ == "timed":
        amt = d.get("duration", {})
        s = "%s %s" % (amt.get("amount"), amt.get("type"))
        if d.get("concentration"):
            s = "Concentration, up to " + s
        return s
    return typ or ""


def _components(comp):
    if not comp:
        return {"v": False, "s": False, "m": None}
    m = comp.get("m")
    if isinstance(m, dict):
        m = m.get("text")
    elif m is True:
        m = True
    return {"v": bool(comp.get("v")), "s": bool(comp.get("s")), "m": m}


def normalize_spells():
    lookup = _spell_class_lookup()
    o5e = {s["name"].lower(): s for s in _open5e("spells")}
    spells = []
    sdir = os.path.join(TOOLS, "spells")
    for fn in sorted(os.listdir(sdir)):
        if not re.match(r"spells-[a-z0-9]+\.json$", fn):
            continue
        src_slug = fn[len("spells-"):-len(".json")]
        data = load_json(os.path.join(sdir, fn))
        for s in data.get("spell", []):
            if not is_allowed(s, INCLUDED, EXCLUDED):
                continue
            name = s["name"]
            # class list from the generated lookup. Assignments live under
            # both "class" and "classVariant" (XGE/TCE spells often use the
            # latter), each keyed by the class's source book.
            classes = set()
            entry = lookup.get(src_slug, {}).get(name.lower(), {})
            for map_key in ("class", "classVariant"):
                for book, cls in entry.get(map_key, {}).items():
                    if book in EXCLUDED:
                        continue
                    for cname in cls:
                        classes.add(cname)
            srd = bool(s.get("srd"))
            o = o5e.get(name.lower()) if srd else None
            spells.append({
                "name": name,
                "source": s["source"],
                "page": s.get("page"),
                "srd": srd,
                "level": s.get("level", 0),
                "school": SCHOOL.get(s.get("school"), s.get("school")),
                "time": _fmt_time(s.get("time")),
                "range": _fmt_range(s.get("range")),
                "components": _components(s.get("components")),
                "duration": _fmt_duration(s.get("duration")),
                "concentration": _is_concentration(s.get("duration")),
                "ritual": bool((s.get("meta") or {}).get("ritual")),
                "classes": sorted(classes),
                "damageInflict": s.get("damageInflict", []),
                "savingThrow": s.get("savingThrow", []),
                "scaling": _scaling(s.get("scalingLevelDice")),
                "text": _spell_text(s, o),
                "textRef": page_ref(s),
            })
    return spells


def _spell_text(s, o):
    """Prefer Open5e SRD prose; otherwise flatten 5etools entries plus the
    'At Higher Levels' block."""
    if o:
        base = o.get("desc") or ""
        if o.get("higher_level"):
            base += "\n\n**At Higher Levels.** " + o["higher_level"]
        if base:
            return base
    parts = []
    body = entries_to_text(s.get("entries"))
    if body:
        parts.append(body)
    higher = entries_to_text(s.get("entriesHigherLevel"))
    if higher:
        parts.append("At Higher Levels. " + higher)
    return "\n\n".join(parts) if parts else None


def _is_concentration(dur):
    if not dur:
        return False
    return bool(dur[0].get("concentration"))


def _scaling(scaling):
    if not scaling:
        return None
    if isinstance(scaling, list):
        scaling = scaling[0]
    return {
        "label": scaling.get("label"),
        "scaling": scaling.get("scaling"),
    }


# ===========================================================================
# BACKGROUNDS
# ===========================================================================

def normalize_backgrounds():
    data = load_json(os.path.join(TOOLS, "backgrounds.json"))
    o5e = {b["name"].lower(): b for b in _open5e("backgrounds")}
    out = []
    for b in data.get("background", []):
        if not is_allowed(b, INCLUDED, EXCLUDED):
            continue
        name = b["name"]
        o = o5e.get(name.lower())
        feat_name = None
        for e in b.get("entries", []):
            if isinstance(e, dict) and e.get("name") and "Feature:" in str(e.get("name", "")):
                feat_name = e["name"].replace("Feature:", "").strip()
                break
        out.append({
            "name": name,
            "source": b["source"],
            "page": b.get("page"),
            "srd": bool(b.get("srd")),
            "skillProficiencies": _skill_profs(b.get("skillProficiencies")),
            "toolProficiencies": _tool_profs(b.get("toolProficiencies")),
            "languages": _lang_profs(b.get("languageProficiencies")),
            "startingEquipment": _bg_equipment(b.get("startingEquipment")),
            "feature": feat_name or (o.get("feature") if o else None),
            "text": text_from(b.get("entries"), _bg_text(o) if o else None),
            "textRef": page_ref(b),
        })
    return out


def _tool_profs(tp):
    fixed, choose = [], None
    if not tp:
        return {"fixed": [], "choose": None}
    for block in tp:
        for k, v in block.items():
            if k in ("any", "anyArtisansTool", "anyMusicalInstrument"):
                choose = {"count": v, "from": k}
            elif k == "choose":
                choose = {"count": v.get("count", 1), "from": v.get("from", [])}
            elif v is True:
                fixed.append(k.title())
    return {"fixed": fixed, "choose": choose}


def _bg_equipment(se):
    if not se:
        return []
    out = []
    for group in se:
        if isinstance(group, dict):
            for key in ("_", "a", "b"):
                if key in group:
                    items = group[key]
                    parts = []
                    for it in items:
                        if isinstance(it, dict):
                            parts.append(strip_markup(it.get("special")
                                         or it.get("item", "")))
                        else:
                            parts.append(strip_markup(str(it)))
                    out.append(", ".join(p for p in parts if p))
    return out


def _bg_text(o):
    parts = []
    if o.get("desc"):
        parts.append(o["desc"])
    if o.get("feature_desc"):
        parts.append("**Feature: %s.** %s" % (o.get("feature", "Feature"),
                     o["feature_desc"]))
    if o.get("suggested_characteristics"):
        parts.append(o["suggested_characteristics"])
    return "\n\n".join(parts) if parts else None


# ===========================================================================
# FEATS
# ===========================================================================

def normalize_feats():
    data = load_json(os.path.join(TOOLS, "feats.json"))
    out = []
    for f in data.get("feat", []):
        if not is_allowed(f, INCLUDED, EXCLUDED):
            continue
        out.append({
            "name": f["name"],
            "source": f["source"],
            "page": f.get("page"),
            "srd": bool(f.get("srd")),
            "prerequisite": _prereq(f.get("prerequisite")),
            "ability": _ability_list(f.get("ability")),
            "skillProficiencies": _skill_profs(f.get("skillProficiencies")),
            "text": text_from(f.get("entries")),
            "textRef": page_ref(f),
        })
    return out


def _prereq(pr):
    if not pr:
        return []
    out = []
    for block in pr:
        item = {}
        if "level" in block:
            lvl = block["level"]
            item["level"] = lvl.get("level") if isinstance(lvl, dict) else lvl
        if "ability" in block:
            item["ability"] = block["ability"]
        if "race" in block:
            item["race"] = [r.get("name") for r in block["race"]]
        if "spellcasting" in block or "spellcasting2020" in block:
            item["spellcasting"] = True
        if "proficiency" in block:
            item["proficiency"] = block["proficiency"]
        if "other" in block:
            item["other"] = strip_markup(block["other"])
        if item:
            out.append(item)
    return out


# ===========================================================================
# ITEMS  (base items: mundane weapons, armor, gear from SRD)
# ===========================================================================

_ITEM_TYPE = {
    "M": "melee weapon", "R": "ranged weapon", "A": "ammunition",
    "LA": "light armor", "MA": "medium armor", "HA": "heavy armor",
    "S": "shield", "G": "adventuring gear", "AT": "artisan's tools",
    "GS": "gaming set", "INS": "instrument", "T": "tools", "SCF": "focus",
    "P": "potion", "WD": "wand", "RD": "rod", "RG": "ring", "$": "treasure",
    "TG": "trade good", "MNT": "mount", "VEH": "vehicle", "TAH": "tack",
    "FD": "food", "EXP": "explosive", "GV": "generic variant",
}


_ARMOR_TYPE = {"LA": "light", "MA": "medium", "HA": "heavy", "S": "shield"}


def _item_type(t):
    if not t:
        return None
    base = t.split("|")[0]
    return _ITEM_TYPE.get(base, base)


def _armor_block(it):
    """Derive the AC rule for an armor/shield item from its 5etools fields.
    light: base + full Dex; medium: base + Dex (max 2); heavy: base, no Dex;
    shield: flat +value. Returns None for non-armor."""
    base_type = (it.get("type") or "").split("|")[0]
    cat = _ARMOR_TYPE.get(base_type)
    if not cat:
        return None
    ac = it.get("ac")
    if ac is None:
        return None
    if cat == "shield":
        return {"category": "shield", "base": ac, "addDex": False,
                "maxDex": 0, "isShield": True}
    add_dex = cat in ("light", "medium")
    max_dex = 99 if cat == "light" else (2 if cat == "medium" else 0)
    return {
        "category": cat,
        "base": ac,
        "addDex": add_dex,
        "maxDex": max_dex,
        "strengthReq": it.get("strength"),         # STR req (heavy armor)
        "stealthDisadv": bool(it.get("stealth")),  # True -> disadvantage
    }


def _is_magic(it):
    r = it.get("rarity")
    return bool(r and r not in ("none", "unknown", "unknown (magic)", None)) \
        or bool(it.get("wondrous")) or bool(it.get("reqAttune"))


def _attune(it):
    ra = it.get("reqAttune")
    if ra in (None, False):
        return None
    if ra is True:
        return True
    return str(ra)  # e.g. "by an artificer"


def normalize_items(item_fluff=None):
    item_fluff = item_fluff or {}
    out = []
    for fn in ("items-base.json", "items.json"):
        path = os.path.join(TOOLS, fn)
        if not os.path.exists(path):
            continue
        data = load_json(path)
        records = data.get("baseitem", []) + data.get("item", [])
        for it in records:
            magic = _is_magic(it)
            # Mundane items obey the source allowlist (PHB etc.). Magic items are
            # SRD content that lives in DMG, which isn't in the allowlist, so we
            # additionally admit any item flagged srd/basicRules (and not a 2024
            # book) to cover the SRD magic items the user asked for.
            src = it.get("source")
            if src is None or src in EXCLUDED or it.get("edition") == "one":
                continue
            allowed = is_allowed(it, INCLUDED, EXCLUDED) \
                or bool(it.get("srd")) or bool(it.get("basicRules"))
            if not allowed:
                continue
            typ = _item_type(it.get("type"))
            rec = {
                "name": it["name"],
                "source": src,
                "type": typ,
                "rarity": it.get("rarity") if magic else None,
                "isMagic": magic,
                "reqAttune": _attune(it),
                "wondrous": bool(it.get("wondrous")),
                "value": it.get("value"),
                "weight": it.get("weight"),
                "weaponCategory": it.get("weaponCategory"),
                "ac": it.get("ac"),
                "armorBlock": _armor_block(it),
                "bonusAc": it.get("bonusAc"),
                "bonusWeapon": it.get("bonusWeapon"),
                "dmg1": it.get("dmg1"),
                "dmgType": it.get("dmgType"),
                "properties": it.get("property", []),
                "text": text_from(it.get("entries")),
                "textRef": page_ref(it),
            }
            out.append(rec)
    # dedupe by name+source
    seen = {}
    for r in out:
        seen[(r["name"], r["source"])] = r
    return list(seen.values())


# ===========================================================================
# Build the full normalized dataset
# ===========================================================================

def build_dataset():
    return {
        "races": normalize_races(),
        "classes": normalize_classes(),
        "spells": normalize_spells(),
        "backgrounds": normalize_backgrounds(),
        "feats": normalize_feats(),
        "items": normalize_items(),
    }
