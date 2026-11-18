"""Top-level build: fetch -> normalize -> merge -> text policy -> validate ->
assemble into dist/dnd-creator.html. Keeps app code and data separate in source;
only this assemble step merges them.

Usage:
  python build/build.py                 # full build (uses cached fetch)
  python build/build.py --fetch         # refresh sources first
  python build/build.py --data-only     # write cache/dataset.json, skip assemble
"""
import json
import os
import sys

import fetch
import normalize
import validate as validate_mod
from util import CACHE, ROOT

APP_DIR = os.path.join(ROOT, "app")
DIST = os.path.join(ROOT, "dist")

# Short-key map to shrink the inlined JSON. Applied to every record dict.
KEYMAP = {
    "name": "n", "source": "s", "page": "p", "srd": "d", "size": "sz",
    "speed": "sp", "ability": "ab", "darkvision": "dv", "languages": "lg",
    "skillProficiencies": "sk", "traitTags": "tt", "traits": "tr", "text": "x",
    "textRef": "xr", "subraces": "sr", "choose": "ch", "count": "c", "from": "f",
    "amount": "am", "fixed": "fx", "hd": "hd", "saves": "sv",
    "proficiencies": "pr", "armor": "ar", "weapons": "wp", "tools": "tl",
    "skills": "sks", "startingEquipment": "eq", "choices": "chs",
    "goldAlternative": "ga", "multiclassing": "mc", "requirements": "rq",
    "spellcasting": "sc", "progression": "pg", "prepared": "pp",
    "cantripProgression": "cp", "spellsKnown": "sn", "subclassLevel": "scl",
    "subclassTitle": "sct", "features": "ft", "subclasses": "scs", "level": "l",
    "gainSubclass": "gs", "shortName": "sh", "spells": "SP", "classes": "CL",
    "races": "RA", "backgrounds": "BG", "feats": "FE", "items": "IT",
    "school": "sl", "time": "ti", "range": "rn", "components": "co",
    "duration": "du", "concentration": "cn", "ritual": "ri",
    "damageInflict": "di", "savingThrow": "st", "scaling": "scg", "label": "lb",
    "prerequisite": "pq", "feature": "fe", "toolProficiencies": "tp",
    "rarity": "ra", "value": "vl", "weight": "wt", "weaponCategory": "wc",
    "ac": "ac", "dmg1": "d1", "dmgType": "dt", "properties": "pt",
    "type": "ty", "walk": "wk",
    # item / magic-item / armor fields (distinct keys to avoid collisions)
    "isMagic": "im", "reqAttune": "at", "wondrous": "wo", "bonusAc": "ba",
    "bonusWeapon": "bw", "armorBlock": "arb", "category": "cat", "base": "bse",
    "addDex": "ad", "maxDex": "mx", "strengthReq": "sreq", "stealthDisadv": "sd",
    "isShield": "ish",
    # subrace / race extraction fields (distinct keys)
    "weaponProficiencies": "wpf", "armorProficiencies": "apf",
    "resist": "rst", "additionalSpells": "asp", "known": "kn",
    "innate": "inn", "recharge": "rch", "freq": "frq", "overwrite": "ow",
    "overwriteFields": "owf", "active": "act", "nameless": "nml",
    "atLevel": "atl", "spellList": "spl", "tag": "tg",
    # class resources + spellcasting extras (distinct keys)
    "resources": "RES", "maxByLevel": "mbl", "die": "die", "key": "ky",
    "pact": "pct", "countByLevel": "cbl", "slotLevelByLevel": "slbl",
    "sorceryConversion": "scv", "slotLevel": "slv", "cost": "cst",
    "arcaneRecovery": "arc", "usesAbility": "ua", "subclass": "sbc",
}


def _compress(obj):
    """Recursively rename keys via KEYMAP and drop null/empty values to shrink."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            cv = _compress(v)
            if cv is None or cv == [] or cv == {} or cv == "":
                continue
            out[KEYMAP.get(k, k)] = cv
        return out
    if isinstance(obj, list):
        return [_compress(x) for x in obj]
    return obj


def run_pipeline(do_fetch):
    if do_fetch:
        fetch.main()
    print("[build] normalizing + merging ...")
    dataset = normalize.build_dataset()
    print("[build] validating ...")
    errors = validate_mod.validate(dataset)
    validate_mod.report(dataset)
    if errors:
        print("[build] VALIDATION FAILED (%d issues):" % len(errors))
        for e in errors[:50]:
            print("   -", e)
        raise SystemExit(1)
    print("[build] validation passed")
    return dataset


def assemble(dataset):
    os.makedirs(DIST, exist_ok=True)
    # compress (keymap already uses top-level category keys)
    compact = {KEYMAP.get(k, k): normalize_list(v) for k, v in dataset.items()}
    data_json = json.dumps(compact, separators=(",", ":"), ensure_ascii=False)

    html_path = os.path.join(APP_DIR, "index.html")
    css_path = os.path.join(APP_DIR, "styles.css")
    js_path = os.path.join(APP_DIR, "app.js")
    html = _read(html_path)
    css = _read(css_path)
    js = _read(js_path)

    out = html.replace("/*__CSS__*/", css)
    out = out.replace("/*__DATA__*/", "window.DND_DATA=" + data_json + ";")
    out = out.replace("/*__APP__*/", js)
    # also expose keymap so the app can decompress
    out = out.replace("/*__KEYMAP__*/",
                      "window.DND_KEYMAP=" + json.dumps(KEYMAP, separators=(",", ":")) + ";")

    dist_file = os.path.join(DIST, "dnd-creator.html")
    with open(dist_file, "w", encoding="utf-8") as fh:
        fh.write(out)
    size = os.path.getsize(dist_file)
    print("[build] wrote %s (%.2f MB)" % (dist_file, size / (1024 * 1024)))
    if size > 2.2 * 1024 * 1024:
        print("[build] WARNING: output exceeds ~2 MB target")


def normalize_list(lst):
    return [_compress(x) for x in lst]


def _read(path):
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def main():
    do_fetch = "--fetch" in sys.argv
    dataset = run_pipeline(do_fetch)

    # always write the uncompressed dataset for inspection/spot-checks
    with open(os.path.join(CACHE, "dataset.json"), "w", encoding="utf-8") as fh:
        json.dump(dataset, fh, ensure_ascii=False, indent=1)
    print("[build] wrote cache/dataset.json for inspection")

    if "--data-only" in sys.argv:
        return
    assemble(dataset)


if __name__ == "__main__":
    main()
