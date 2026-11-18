"""Step 5 (validate): fail the build on missing/out-of-range fields and print a
per-category count report."""
from util import load_config

_, EXCLUDED = load_config()


class ValidationError(Exception):
    pass


def _check(cond, msg, errors):
    if not cond:
        errors.append(msg)


def validate(dataset):
    errors = []

    # Races
    for r in dataset["races"]:
        _check(bool(r.get("name")), "race with empty name", errors)
        _check(r.get("source") not in EXCLUDED,
               "race %s from excluded 2024 source %s" % (r.get("name"), r.get("source")),
               errors)
        for sr in r.get("subraces", []):
            _check(bool(sr.get("name")), "subrace with empty name in %s" % r["name"], errors)
            # structural: a leftover inheritance key means a half-merged record
            for k in ("_copy", "_mod", "_versions"):
                _check(k not in sr,
                       "subrace %s in %s still has %s" % (sr.get("name"), r["name"], k),
                       errors)
            # every trait must have text or a page reference (never empty)
            for t in sr.get("traits", []):
                _check(bool(t.get("text")) or bool(t.get("textRef")),
                       "subrace %s trait %s has neither text nor ref"
                       % (sr.get("name"), t.get("name")), errors)

    # Classes
    for c in dataset["classes"]:
        _check(bool(c.get("name")), "class with empty name", errors)
        _check(c.get("source") not in EXCLUDED,
               "class %s from excluded source %s" % (c.get("name"), c.get("source")),
               errors)
        hd = c.get("hd") or {}
        _check(isinstance(hd.get("faces"), int) and hd["faces"] > 0,
               "class %s missing hit die" % c.get("name"), errors)
        _check(len(c.get("saves", [])) == 2,
               "class %s must have exactly 2 saving throws (got %d)"
               % (c.get("name"), len(c.get("saves", []))), errors)
        for f in c.get("features", []):
            lvl = f.get("level")
            _check(lvl is None or 1 <= lvl <= 20,
                   "class %s feature %s level out of range: %s"
                   % (c["name"], f.get("name"), lvl), errors)
            _check(bool(f.get("name")), "class %s has feature with empty name" % c["name"], errors)
        for s in c.get("subclasses", []):
            _check(s.get("source") not in EXCLUDED,
                   "subclass %s from excluded source" % s.get("name"), errors)
            for sf in s.get("features", []):
                lvl = sf.get("level")
                _check(lvl is None or 1 <= lvl <= 20,
                       "subclass %s feature %s level out of range: %s"
                       % (s["name"], sf.get("name"), lvl), errors)

    # Spells
    for s in dataset["spells"]:
        _check(bool(s.get("name")), "spell with empty name", errors)
        lvl = s.get("level")
        _check(isinstance(lvl, int) and 0 <= lvl <= 9,
               "spell %s level out of range 0-9: %s" % (s.get("name"), lvl), errors)
        _check(s.get("source") not in EXCLUDED,
               "spell %s from excluded 2024 source %s" % (s.get("name"), s.get("source")),
               errors)
        _check(bool(s.get("school")), "spell %s missing school" % s.get("name"), errors)

    # Backgrounds
    for b in dataset["backgrounds"]:
        _check(bool(b.get("name")), "background with empty name", errors)
        _check(b.get("source") not in EXCLUDED,
               "background %s from excluded source %s" % (b.get("name"), b.get("source")),
               errors)

    # Feats
    for f in dataset["feats"]:
        _check(bool(f.get("name")), "feat with empty name", errors)
        _check(f.get("source") not in EXCLUDED,
               "feat %s from excluded source %s" % (f.get("name"), f.get("source")),
               errors)

    # Items
    magic_count = 0
    for it in dataset["items"]:
        _check(bool(it.get("name")), "item with empty name", errors)
        _check(it.get("source") not in EXCLUDED,
               "item %s from excluded source %s" % (it.get("name"), it.get("source")),
               errors)
        if it.get("isMagic"):
            magic_count += 1
        arm = it.get("armorBlock")
        if arm:
            _check(isinstance(arm.get("base"), (int, float)),
                   "armor %s has non-numeric base AC" % it.get("name"), errors)
    _check(magic_count > 0, "no magic items were included (expected SRD magic items)", errors)

    # Text policy (relaxed): text-bearing categories must have at least a
    # page reference, and ideally full text.
    for cat in ("spells", "feats", "backgrounds", "races"):
        for r in dataset[cat]:
            _check(bool(r.get("text")) or bool(r.get("textRef")),
                   "%s %s has neither text nor textRef" % (cat[:-1], r.get("name")),
                   errors)

    return errors


def report(dataset):
    print("\n===== DATA REPORT =====")
    tot = 0
    for cat in ("races", "classes", "spells", "backgrounds", "feats", "items"):
        n = len(dataset[cat])
        tot += n
        extra = ""
        if cat == "races":
            subs = sum(len(r.get("subraces", [])) for r in dataset[cat])
            extra = " (+%d subraces)" % subs
        if cat == "classes":
            subs = sum(len(c.get("subclasses", [])) for c in dataset[cat])
            feats = sum(len(c.get("features", [])) for c in dataset[cat])
            extra = " (+%d subclasses, %d class features)" % (subs, feats)
        if cat == "items":
            magic = sum(1 for it in dataset[cat] if it.get("isMagic"))
            armor = sum(1 for it in dataset[cat] if it.get("armorBlock"))
            extra = " (%d magic, %d armor)" % (magic, armor)
        print("  %-13s %5d%s" % (cat, n, extra))
    print("  %-13s %5d" % ("TOTAL", tot))
    # source breakdown for spells
    from collections import Counter
    src = Counter(s["source"] for s in dataset["spells"])
    print("  spells by source:", dict(src))
    # text coverage (relaxed text policy)
    for cat in ("spells", "feats", "races", "backgrounds"):
        have = sum(1 for r in dataset[cat] if r.get("text"))
        print("  %s with full text: %d / %d" % (cat, have, len(dataset[cat])))
    feat_text = 0
    feat_tot = 0
    for c in dataset["classes"]:
        for f in c.get("features", []):
            feat_tot += 1
            if f.get("text"):
                feat_text += 1
    print("  class features with full text: %d / %d" % (feat_text, feat_tot))

    # ---- subrace coverage report ----
    print("\n  --- subraces (traits / W,A,T profs / racial spells) ---")
    for r in dataset["races"]:
        subs = r.get("subraces", [])
        if not subs:
            continue
        print("  %s: %d subraces" % (r["name"], len(subs)))
        for sr in subs:
            asp = sr.get("additionalSpells") or {}
            n_spells = len(asp.get("known", [])) + sum(len(b.get("spellList", [])) for b in asp.get("innate", [])) + len(asp.get("choose", []))
            nt = len(sr.get("traits", []))
            # a subrace with no named traits is only suspicious if it also
            # grants no ability bonus (standard Human is just +1 to all).
            has_ability = bool(sr.get("ability"))
            flag = "  <-- ZERO TRAITS" if (nt == 0 and not has_ability) else ""
            print("      %-26s traits=%d  prof=%d/%d/%d  spells=%d%s" % (
                sr["name"], nt,
                len(sr.get("weaponProficiencies", [])),
                len(sr.get("armorProficiencies", [])),
                len(sr.get("toolProficiencies", [])),
                n_spells, flag))

    # ---- race roster + duplicate-name check ----
    from collections import Counter as _C
    names = [r["name"] for r in dataset["races"]]
    dupes = {n: c for n, c in _C(names).items() if c > 1}
    print("\n  races (%d total): %s" % (len(names), ", ".join(sorted(names))))
    if dupes:
        print("  DUPLICATE race names (should be none after dedupe):", dupes)
    gnome = next((r for r in dataset["races"] if r["name"] == "Gnome"), None)
    if gnome:
        svf = [s["name"] for s in gnome.get("subraces", []) if "virfneblin" in s["name"] or "Deep" in s["name"]]
        print("  Deep Gnome/Svirfneblin present as Gnome subrace:", svf or "(none)")
    print("=======================\n")
