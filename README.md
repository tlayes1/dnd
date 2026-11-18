# D&D 5e (2014) Character Creator

A free, offline, single-file D&D 5e character creator for personal use. The
deliverable is **`dist/dnd-creator.html`** — open it by double-clicking; it works
offline on desktop and mobile with no frameworks, CDNs, fonts, or network calls.

See `design.md` for how the two data sources were inspected and how the pipeline
turns them into the inlined game data.

## Using the app

Just open `dist/dnd-creator.html` in any modern browser. Build a character through
the wizard (Race → Class → Ability Scores → Background → Equipment → Spells →
Details → Character Sheet). The live sheet on the right updates as you choose.
Save/Load exports JSON; the app also autosaves to `localStorage`. Print / PDF
produces a clean sheet. Toggle dark/light with the ◐ button.

On the **Spellcasting** page: track spell slots (click to spend/restore, with a
manual max override), see your spells grouped by level (known/prepared, plus an
always-prepared group and a separate Racial Spells group), and use the "Learn
spells" button to add spells (Wizards can copy spells into a spellbook). Slot
trading is supported: Sorcerer Font of Magic (points ↔ slots), Wizard Arcane
Recovery, and Warlock Pact Magic as its own pool. The **Resources** page tracks
non-slot class resources (Rage, Ki, Channel Divinity, etc.) as spend/restore
counters by recharge type. **Short Rest** and **Long Rest** buttons (top bar)
refill the right pools; Long Rest also restores HP, clears temp HP and death
saves, and returns half your hit dice. **Inspiration** is a clickable toggle on
the sheet.

On the **Race** step: pick a race and subrace (shown as cards). The full merged
trait list (base race + subrace, each trait its own bold paragraph) appears below,
along with choosers for racial options — Half-Elf skills and +1 abilities, Variant
Human skill/feat/+1s, Dragonborn draconic ancestry (sets breath weapon + damage
resistance), and extra languages. Racial spells are tracked separately from class
spells. All choices persist in the saved JSON.

On the **Character Sheet** page:
- **Edit directly:** player name, XP, alignment, current/temp HP, death saves,
  personality/ideals/bonds/flaws, notes, and the equipment list.
- **Computed stats stay computed** (AC, modifiers, saves, skills). Click any of
  them for a breakdown showing every contributing source, and set a **+X misc
  bonus** right in that popover.
- **AC** has an armor dropdown (light/medium/heavy from the SRD) with a shield
  toggle and a **Custom…** option (base / +Dex / max-Dex) for homebrew armor.
- **Magic items:** search and add SRD magic items or define a **custom** item
  (name, description, attunement, optional AC bonus). Attunement is capped at 3
  and attuned AC bonuses flow into the AC breakdown.
- **Hover (or tap) anything** — spells, features, feats, magic items — to read
  its full description inline; click the ⓘ button to pin the popover open.

## Rebuilding the data (optional)

Requires Python 3 and git. Node is only needed for the test suites.

```
python build/build.py --fetch     # clone/pull 5etools, pull Open5e, rebuild
python build/build.py              # rebuild from the cached sources (offline)
python build/build.py --data-only  # normalize+validate, write cache/dataset.json
```

Pipeline stages (`build/`):

1. **fetch.py** — shallow-clones `5etools-mirror-3/5etools-src` and pulls Open5e
   SRD data into the gitignored `cache/`.
2. **normalize.py** — converts both sources into one internal schema. 5etools
   supplies mechanics; Open5e SRD supplies full prose. Non-SRD 5etools prose is
   dropped and replaced with a page reference (e.g. `See PHB p. 72`).
3. **validate.py** — fails the build on out-of-range/missing fields and prints a
   per-category count report.
4. **build.py** — minifies the merged JSON (short-key map) and inlines JSON, CSS,
   and JS into `dist/dnd-creator.html`.

App source (`app/`) and pipeline (`build/`) stay separate; they are merged only in
the assemble step.

## Which books are included

Edit **`config/sources.json`** to toggle books. `included` gates all content
(default: PHB, XGE, TCE, VGM, MTF, SCAG). `racesExtra` additionally allows
**races/subraces only** from more books (default: WBtW, EEPC, ERLW, GGR, MOT,
TTP, LR, AI, SCC, VRGR, AAG) — this adds player races like Fairy, Aarakocra,
Changeling, Tortle, Satyr, etc. without pulling in those books' feats/spells/
items/backgrounds, keeping the file small. All 2024 sources (XPHB, XDMG, XMM, …)
are always excluded. Races that appear in multiple allowed books are deduped to
one entry (MOT preferred over GGR for Centaur/Minotaur).

## Tests

```
node build/smoke_test.js      # data load + 5e derivation correctness (jsdom)
node build/ui_test.js         # wizard renders & navigates without errors (jsdom)
node build/fixes_test.js      # spell selection, skill de-dup, sheet layout
node build/edit_items_test.js # editable sheet, misc bonuses, AC/armor, magic items, tooltips
node build/subrace_test.js    # subrace traits/profs/spells, racial choosers, merge+inheritance
node build/races_test.js      # expanded race roster, name-dedup, race-only source extension
node build/casting_resources_test.js  # spell slots, SP/Arcane Recovery/Pact, class resources, rests
```

The subrace diagnostic (read-only) can be re-run to inspect the raw data:
```
python build/diagnose_subraces.py
```

## Data attribution

- SRD content via [Open5e](https://open5e.com) (SRD 5.1, OGL).
- Mechanical data via the [5etools-src mirror](https://github.com/5etools-mirror-3/5etools-src).

For personal use among friends.
