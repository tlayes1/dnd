# D&D 5e (2014) Character Creator — Design

A free, offline, single-file D&D 5e character creator for personal use. The
deliverable is `dist/dnd-creator.html`: all HTML, CSS, JS, and game data inlined,
no frameworks, CDNs, fonts, or network requests.

This document records what the two data sources actually contain (inspected, not
assumed) and how the build pipeline turns them into the inlined data the app uses.

---

## 1. Data sources — what inspection found

### 1.1 Open5e (https://api.open5e.com, v1 endpoints)

SRD content is identified by `document__slug == "wotc-srd"` (title "5e Core Rules",
SRD 5.1). Other slugs are third-party OGL content (Kobold Press `tob`/`dmag`,
EN Publishing `a5e`, etc.) and are **not** used.

Counts (unfiltered) and the fields that matter:

- **spells** (`/v1/spells/`, count ~1435 across all docs): `slug`, `name`,
  `desc` (markdown prose — SRD text we may keep), `higher_level`, `range`,
  `components` (string "V, S, M"), `material`, `requires_concentration`,
  `casting_time`, `duration`, `level_int` (0–9), `school` (lowercase word),
  `dnd_class` (comma string), `document__slug`.
- **races** (`/v1/races/`, SRD count = 9): `name`, `desc`, `asi` (list of
  `{attributes:[...], value:n}`), `speed` (`{walk:30}`), `size_raw`, `languages`,
  `traits` (markdown), `subraces` (nested), `document__slug`.
- **backgrounds** (`/v1/backgrounds/`): `skill_proficiencies`,
  `tool_proficiencies`, `languages`, `equipment`, `feature`, `feature_desc`,
  `suggested_characteristics` (personality/ideal/bond/flaw tables — useful for the
  Details step), `document__slug`.
- **classes** (`/v1/classes/`, count 12): mechanical fields exist (`hit_dice`,
  `prof_*`, `spellcasting_ability`) but `table` is a **markdown string**, not
  structured. Open5e classes are therefore used only to backfill SRD prose, not
  for mechanics.
- **feats** (`/v1/feats/`): almost entirely non-SRD (a5e, etc.). Not a useful
  source for 2014 SRD feats. 5etools is authoritative here.

**Role of Open5e:** fill descriptive prose for SRD records (spells, races,
backgrounds) where keeping full SRD text is explicitly allowed. It is the *gap
filler*, not the mechanics source.

### 1.2 5etools-src (cloned to `cache/5etools-src`, `/data`)

This is the authoritative **mechanics** source. Key shapes found:

**Edition marker.** Records carry an `edition` field: `"one"` = 2024 content,
`"classic"` or **absent/None** = 2014 content. 2014 feats and most races have
`edition: None`. So the edition filter is: exclude `edition == "one"`, **and**
require `source` to be in the included-source allowlist. Many 2024-only records
also live in sources XPHB/XDMG/XMM/XSenGW which the allowlist excludes anyway.
Records also expose `srd: true` / `basicRules: true` flags.

**Classes** — `data/class/class-<name>.json`, one file per class. Top keys:
`class`, `subclass`, `classFeature`, `subclassFeature`.
- `class[0]`: `name`, `source`, `page`, `hd` (`{number,faces}`), `proficiency`
  (save abilities, e.g. `["str","con"]`), `startingProficiencies`
  (`skills`/`weapons`/`armor`), `startingEquipment` (`default` array of markup
  strings + `goldAlternative`), `multiclassing` (`requirements`,
  `proficienciesGained`), `spellcastingAbility`, `casterProgression`
  (`full`/`half`/`third`/`pact`/`artificer`), `cantripProgression`,
  `spellsKnownProgression*`, `preparedSpells`, `classFeatures` (array of
  reference strings `"Feature|Class|ClassSource|Level"`), `subclassTitle`.
- `classFeature[]`: resolved feature records: `name`, `source`, `page`, `level`,
  `className`, `entries` (prose with `{@tag}` markup).
- `subclass[]`: `name`, `shortName`, `source`, `className`, `subclassFeatures`
  (reference strings), `edition`.
- `subclassFeature[]`: `name`, `source`, `page`, `level`, `subclassShortName`,
  `entries`.

**Spells** — `data/spells/spells-<source>.json`, per source. Exclude
`spells-xphb.json` (2024). Spell shape: `name`, `source`, `page`, `level` (0–9),
`school` (single letter), `time` (`[{number,unit}]`), `range` (`{type,distance}`),
`components` (`{v,s,m}`), `duration` (`[{type,...}]`), `damageInflict`,
`savingThrow`, `scalingLevelDice`, `entries` (prose markup), `reprintedAs`
(points at XPHB version).
School letters: `A`=Abjuration, `C`=Conjuration, `D`=Divination,
`E`=Enchantment, `V`=Evocation, `I`=Illusion, `N`=Necromancy, `T`=Transmutation.

**Spell→class mapping** — not on the spell records. Lives in
`data/generated/gendata-spell-source-lookup.json`, keyed
`sourceSlug -> spellNameLower -> { class: { SRCBOOK: { ClassName: true } }, subclass: {...} }`.
This is how we attach `classes` to each spell.

**Races** — `data/races.json`: `race[]` and `subrace[]`.
- `race`: `name`, `source`, `page`, `size` (`["M"]`), `speed` (num or obj),
  `ability` (`[{dex:2,...}]`), `darkvision`, `traitTags`, `skillProficiencies`,
  `languageProficiencies`, `entries`.
- `subrace`: `name` (may be absent — a nameless record is the race's default
  variant), `raceName`, `raceSource`, `source`, `ability`, `speed`,
  `darkvision`, `resist`, `traitTags`, `languageProficiencies`,
  `skillProficiencies`, `weaponProficiencies`/`armorProficiencies`/
  `toolProficiencies` (arrays of `{"name|src":true}`), `additionalSpells`, and
  `entries` (named trait blocks; some carry `data.overwrite:"<base trait>"`).

  **Subrace extraction & inheritance (rewritten).** The normalizer now:
  1. Resolves inheritance so no record is half-merged: `_copy` (deep-merge from
     a referenced base + its `_mod`), `_mod` ops (`replaceArr`/`appendArr`/
     `insertArr`/`removeArr`/`prependArr` matched by entry `name`), and
     `_versions` (expands a template into concrete variants, applying each
     version's `_mod` or `_abstract`+`_implementations` with `{{var}}`
     substitution). Any leftover `_copy`/`_mod`/`_versions` key fails validation.
  2. Extracts every field above, converting proficiency blocks to display names
     and `additionalSpells` into `{known, innate:[{level,freq,recharge,spellList}],
     choose, ability}`. **Innate spells and racial actives keep their usage
     frequency tagged with a recharge type** (`at-will`/`short`/`long`/`dawn`)
     so the Resources tab can track them (e.g. Dragonborn Breath Weapon =
     `recharge:"short"`; Draconic Ancestry table preserved for the ancestry
     chooser).
  3. Emits traits as `[{name, text|textRef, overwrite?, recharge?}]` honoring the
     text policy (never an empty paragraph). The app's `mergedRace()` unions base
     + subrace traits (dedupe by name; `data.overwrite` replaces the named base
     trait, e.g. Drow "Superior Darkvision"→Darkvision), overrides scalars
     (speed/darkvision) when the subrace sets them, respects record-level
     `overwrite:{ability|languageProficiencies|...}`, and concatenates
     proficiencies + racial spells. Diagnostic: Tiefling = 14 subrace records,
     Dwarf = 3 (incl. Duergar MTF); Dragonborn color variants are handled by an
     in-race ancestry chooser rather than as subraces.
  Overwrite markers were confirmed from the raw data (see
  `build/diagnose_subraces.py`), not assumed.

**Backgrounds** — `data/backgrounds.json`: `background[]` with `ability`,
`feats`, `skillProficiencies`, `toolProficiencies`, `languageProficiencies`,
`startingEquipment`, `entries`. Edition split ~101 classic / 74 one.

**Feats** — `data/feats.json`: `feat[]` with `name`, `source`, `page`,
`prerequisite` (list of condition objects: `{level}`, `{ability:[{str:13}]}`,
`{race}`, `{spellcasting}`, `{other}`), `skillProficiencies`, `expertise`,
`senses`, `entries`. All `edition: None`; filtered by source allowlist.

**Items** — `data/items.json` + `data/items-base.json`: weapons, armor, gear
with `type`, `rarity`, `value`, `weight`, `ac`, `dmg1`, `dmgType`, `property`,
`weaponCategory`, `source`. Base items (SRD mundane gear/weapons/armor) are in
`items-base.json`.

### 1.3 Markup

5etools prose uses `{@tag ...}` markup (`{@damage 1d6}`, `{@dice 1d8}`,
`{@spell fireball}`, `{@condition prone}`, `{@scaledamage}`, `{@filter}`...).
`entries_to_text` + `strip_markup` in `build/util.py` flatten these (including
nested lists and tables) into readable plain text.

**Text policy (updated by user request).** The original plan dropped 5etools
descriptive prose and kept only a page reference. The user later asked for
hover/tap tooltips that show what each spell / feature / feat / magic item does,
so the policy is now relaxed: every record keeps a readable `text` field built
from 5etools `entries` (Open5e SRD prose preferred when available) **and** the
`textRef` page citation. No LLM summaries anywhere. This grows the inlined data
(~1.5 MB), still under the ~2 MB target.

---

## 2. Edition / source filter

Config at `config/sources.json`:
```json
{ "included": ["PHB","XGE","TCE","VGM","MTF","SCAG"],
  "racesExtra": ["WBtW","EEPC","ERLW","GGR","MOT","TTP","LR","AI","SCC","VRGR","AAG"],
  "excluded2024": ["XPHB","XDMG","XMM","XSenGW"] }
```
A 5etools record is **kept** iff: `source ∈ included` AND `source ∉ excluded2024`
AND `edition != "one"`. Open5e records are kept iff `document__slug == "wotc-srd"`.

`racesExtra` is a **race-only** extension: races and subraces from these books
are also kept (so missing player races can be added), but their feats, spells,
items, and backgrounds are **not** — this keeps the inlined file small. The race
normalizer gates on `included ∪ racesExtra`; every other category gates on
`included` alone. When a race name appears in more than one allowed book, the
pipeline keeps a single entry by source priority (`SOURCE_PRIORITY` in
`normalize.py`; core first, then MOT before GGR, etc.) and merges the dropped
printings' subraces onto the survivor. `sources.json` lets the user toggle books
without touching code.

---

## 3. Internal schema (normalized, one shape per category)

Every record: `{ name, source, page, srd (bool), text, textRef, ...mechanics }`
where `text` is full SRD prose (Open5e) when available and allowed, otherwise
`text` is null and `textRef` is `"See <SRC> p. <n>"`.

- **race**: `name, source, page, size, speed{walk,...}, ability[], darkvision,
  languages[], traits[{name,textRef|text}], skillProficiencies, subraces[slug]`
- **subrace**: `name, nameless?, source, page, ability[], speed?, darkvision?,
  resist[], traitTags[], languages, skill/weapon/armor/toolProficiencies,
  additionalSpells{known,innate,choose}, overwriteFields[],
  traits[{name,text|textRef,overwrite?,recharge?}]`
- **class**: `name, source, page, hd{number,faces}, saves[2], proficiencies
  {armor,weapons,tools,skills{choose,from}}, startingEquipment{choices[],
  goldAlternative}, multiclassing{requirements,proficiencies}, spellcasting
  {ability, progression, cantripsKnown[21], spellsKnown?[21], prepared?,
  slots[21][10]}, features[{name,level,textRef|text}], subclasses[slug],
  subclassLevel, subclassTitle`
- **subclass**: `name, class, source, page, features[{name,level,textRef}]`
- **feature**: embedded in class/subclass (name, level, textRef|text)
- **spell**: `name, source, page, level(0-9), school(full word), time, range,
  components{v,s,m,material}, duration, concentration, ritual, classes[],
  damage{dice,type}, save, scaling, text/textRef`
- **background**: `name, source, page, skillProficiencies[], toolProficiencies[],
  languages, startingEquipment, feature{name}, text/textRef,
  characteristics{traits,ideals,bonds,flaws}`
- **feat**: `name, source, page, prerequisite[], grants{skills,asi,...},
  text/textRef`
- **item**: `name, source, type, category, cost, weight, ac?, damage?, properties[]`

Spell-slot, caster-progression, proficiency-bonus, and multiclass-slot tables are
**derived in-app** from standard 5e rules (deterministic, not LLM-generated) keyed
off `casterProgression`, so the inlined data stays small.

---

## 4. Build pipeline (`build.py`)

1. **fetch** — `git clone --depth 1` (or `pull`) 5etools-src into `cache/`
   (gitignored); pull Open5e `wotc-srd` spells/races/backgrounds/classes via API
   into `cache/open5e/*.json` (paginated, cached so re-runs are offline).
2. **normalize** — read both, emit the internal schema per category.
3. **merge** — dedupe by `name+source`; prefer 5etools mechanics; use Open5e only
   to fill `text` for SRD records and to supply SRD prose.
4. **text policy** — every record keeps full `text` (Open5e SRD prose preferred,
   else flattened 5etools `entries`) plus `textRef="See <SRC> p.N"`. Magic items
   and armor also carry `rarity`, `reqAttune`, `bonusAc`, and an `armorBlock`
   (`base`/`addDex`/`maxDex`/`strengthReq`/`stealthDisadv`) so the app can compute
   AC. No LLM summaries anywhere.
5. **validate** — fail on: spell level outside 0–9; a class missing hit die or not
   exactly 2 saves; feature level outside 1–20; empty names; any leftover record
   whose source is a 2024 book. Print counts per category.
6. **assemble** — minify the merged JSON (short keys, drop nulls), inline into the
   HTML template with CSS and JS. Target < ~2 MB.

Source stays separated: `app/` holds the HTML/CSS/JS template; `build/` holds the
pipeline; only step 6 merges them into `dist/dnd-creator.html`.

---

## 5. App architecture (vanilla JS, single file)

- **State**: one `character` object; a tiny pub/sub store re-renders the live
  sheet on every change. Autosave to `localStorage` wrapped in try/catch.
- **Wizard steps**: Race → Class → Ability Scores → Background → Equipment →
  Spellcasting (conditional) → Resources (conditional) → Details → Character
  Sheet. A stepper component; each step reads from the inlined `DATA` object and
  writes to `character`.
- **Derivations** (pure functions): ability modifiers, proficiency bonus by level,
  AC (base/armor/dex), HP (by hit die + CON, fixed or rolled), initiative, saving
  throws, skills, passive perception, spell save DC, spell attack bonus, spell
  slots by class+level (and combined multiclass slots via the standard caster-
  level table), known/prepared counts.
- **Ability score methods**: standard array (15,14,13,12,10,8), point buy
  (27-point, validated 8–15 pre-racial), manual entry, 4d6-drop-lowest roller.
- **Level 1–20 selector** recomputes features/HP/slots. Subclass offered at the
  class's `subclassLevel`. Multiclassing panel enforces prerequisites and merges
  proficiencies + spell slots.
- **Spellcasting page** (two modes): *Spellcasting* (default) shows editable spell
  slots (click pips to spend/restore, plus a manual max override per level), your
  known/prepared/always-prepared/racial spells grouped by level header, and
  slot-trading panels — Sorcerer Font of Magic (SP↔slot via the 2014 conversion
  table), Wizard Arcane Recovery (recover ≤ ceil(level/2) slot levels once per
  long rest on a short rest), and Warlock Pact Magic as a separate pool. *Learn
  spells* mode is the searchable/filterable picker (known-vs-prepared caps), and
  Wizards can **copy** spells into a spellbook beyond the prepared count. Racial
  spells are shown in their own group, counted apart from class spells.
- **Resources page**: non-slot class resources (Rage, Ki, Channel Divinity,
  Bardic Inspiration, Superiority Dice, Wild Shape, Lay on Hands, Second Wind,
  Action Surge, Indomitable, Sorcery Points…) as spend/restore counters, each
  labelled with its recharge type. Resource maximums are computed in the build
  pipeline from class/level data (2014 rules; `normalize.py` `_class_resources`).
  A compact version shows in the live-sheet sidebar.
- **Short Rest / Long Rest** (top bar): Short restores short-recharge resources +
  Pact Magic slots and lets you spend hit dice to heal (average or rolled + CON);
  Long restores HP to max, clears temp HP + death saves, returns half total hit
  dice (min 1), and refills all slots, sorcery points, and every resource.
  Lowering a class level clamps expended slots/resources to the new maxima.
- **Feats/ASI** offered at levels 4/8/12/16/19 (+ class extras like Fighter 6/14,
  Rogue 10) with prerequisite checks.
- **Theme** toggle (dark/light) via CSS variables; **print CSS** renders a clean
  one/two-page sheet; **responsive** layout collapses to a single column on phones.
- **Save/Load**: export/import the `character` JSON; autosave restore on load.

---

## 6. Build order (layers), with spot-checks after each

1. Pipeline + schema + validation harness.
2. Race/Subrace, Class/Subclass + features, Ability Scores.
3. Backgrounds + Equipment/items.
4. Spells + spell-to-class mapping + slot tables.
5. Multiclassing + feats/ASI.

After each layer: regenerate, print the per-category count report, and spot-check
3 entries per category against the source books (page refs) and the live app.
