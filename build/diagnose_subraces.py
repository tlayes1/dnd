"""Task 1 diagnostic: print raw 5etools subrace records (resolved), what the OLD
normalizer read vs dropped, the overwrite markers actually present, and the
regrouping report (Tiefling=14, Dwarf=3 incl. Duergar). Read-only; no changes."""
import json
import os

from util import TOOLS, load_config

INCLUDED, EXCLUDED = load_config()

OLD_READS = {"name", "source", "page", "srd", "ability", "speed", "darkvision",
             "languageProficiencies", "skillProficiencies", "entries"}
MECH_FIELDS = ["ability", "speed", "darkvision", "resist", "traitTags",
               "languageProficiencies", "skillProficiencies",
               "weaponProficiencies", "armorProficiencies", "toolProficiencies",
               "additionalSpells"]


def load_races():
    return json.load(open(os.path.join(TOOLS, "races.json"), encoding="utf-8"))


def allowed_sub(sr):
    src = sr.get("source")
    return src and src not in EXCLUDED and src in INCLUDED and sr.get("edition") != "one"


def trait_overwrites(sr):
    out = []
    for e in sr.get("entries", []) or []:
        if isinstance(e, dict):
            ow = (e.get("data") or {}).get("overwrite")
            if ow:
                out.append((e.get("name"), ow))
    return out


def field_overwrite(sr):
    return sr.get("overwrite")


def dump(sr, parent_default=None):
    name = sr.get("name") or "(NAMELESS/base)"
    print("\n--- %s  [%s p.%s]%s ---" % (
        name, sr.get("source"), sr.get("page"),
        "  srd" if sr.get("srd") else ""))
    present = [f for f in MECH_FIELDS if f in sr]
    print("  mech fields present:", present or "(none - inherits parent)")
    dropped = [f for f in present if f not in OLD_READS]
    print("  OLD normalizer DROPPED:", dropped or "(none)")
    tov = trait_overwrites(sr)
    if tov:
        print("  trait data.overwrite:", tov)
    fov = field_overwrite(sr)
    if fov:
        print("  record-level overwrite:", fov)
    # trait names
    names = [e.get("name") for e in (sr.get("entries") or []) if isinstance(e, dict) and e.get("name")]
    print("  trait entry names:", names or "(none)")
    # inheritance keys
    inh = [k for k in ("_copy", "_mod", "_versions") if k in sr]
    if inh:
        print("  INHERITANCE KEYS:", inh)
    # additionalSpells quick view
    for blk in sr.get("additionalSpells", []) or []:
        print("  additionalSpells: known=%s innate=%s choose=%s ability=%s"
              % (blk.get("known"), blk.get("innate"),
                 blk.get("choose") or [b for b in blk.get("known", {}).values()] if isinstance(blk.get("known"), dict) else None,
                 blk.get("ability")))


def regroup_report(data):
    subs = data.get("subrace", [])
    from collections import defaultdict
    by_race = defaultdict(list)
    for sr in subs:
        rn = sr.get("raceName")
        if rn:
            by_race[rn].append(sr)
    print("\n================ REGROUPING REPORT ================")
    for race in ("Tiefling", "Dwarf", "Elf"):
        recs = by_race.get(race, [])
        incl = [s for s in recs if allowed_sub(s)]
        print("\n%s: %d total subrace records, %d included (2014/allowlist)"
              % (race, len(recs), len(incl)))
        for s in incl:
            nm = s.get("name") or "(NAMELESS base)"
            print("   - %-28s %s p.%s" % (nm, s.get("source"), s.get("page")))
    # Duergar presence
    duergar = [s for s in subs if (s.get("name") == "Duergar" and s.get("raceName") == "Dwarf")]
    print("\nDuergar(Dwarf subrace) records:", [(s.get("source"), allowed_sub(s)) for s in duergar])


def main():
    data = load_races()
    subs = data.get("subrace", [])

    def find(race, name):
        for s in subs:
            if s.get("raceName") == race and (s.get("name") == name):
                return s
        return None

    print("################ RAW SUBRACE DUMP ################")
    for nm in ("Wood", "Drow", "High"):
        s = find("Elf", nm)
        if s:
            dump(s)
    for nm in ("Hill", "Duergar", "Mountain"):
        s = find("Dwarf", nm)
        if s:
            dump(s)
    # all tiefling variants
    print("\n################ TIEFLING VARIANTS ################")
    for s in subs:
        if s.get("raceName") == "Tiefling":
            dump(s)

    regroup_report(data)


if __name__ == "__main__":
    main()
