(function(){
"use strict";

/* =========================================================================
   0. DECOMPRESS inlined data (build applied a short-key map)
   ========================================================================= */
var KM = window.DND_KEYMAP || {};
var INV = {}; for (var k in KM) INV[KM[k]] = k;
function decompress(o){
  if (Array.isArray(o)) return o.map(decompress);
  if (o && typeof o === "object"){
    var out = {};
    for (var key in o){ out[INV[key] || key] = decompress(o[key]); }
    return out;
  }
  return o;
}
var RAW = window.DND_DATA || {};
var DATA = {
  races:       decompress(RAW.RA || []),
  classes:     decompress(RAW.CL || []),
  spells:      decompress(RAW.SP || []),
  backgrounds: decompress(RAW.BG || []),
  feats:       decompress(RAW.FE || []),
  items:       decompress(RAW.IT || [])
};
DATA.classes.sort(byName); DATA.races.sort(byName);
DATA.backgrounds.sort(byName); DATA.feats.sort(byName); DATA.spells.sort(byName);
function byName(a,b){ return a.name<b.name?-1:a.name>b.name?1:0; }

/* =========================================================================
   1. 5e RULES TABLES (derived deterministically, not stored per-record)
   ========================================================================= */
var ABILS = ["str","dex","con","int","wis","cha"];
var ABIL_NAME = {str:"Strength",dex:"Dexterity",con:"Constitution",
                 int:"Intelligence",wis:"Wisdom",cha:"Charisma"};
var SKILLS = {
  "Acrobatics":"dex","Animal Handling":"wis","Arcana":"int","Athletics":"str",
  "Deception":"cha","History":"int","Insight":"wis","Intimidation":"cha",
  "Investigation":"int","Medicine":"wis","Nature":"int","Perception":"wis",
  "Performance":"cha","Persuasion":"cha","Religion":"int",
  "Sleight of Hand":"dex","Stealth":"dex","Survival":"wis"
};

// Proficiency bonus by total level 1..20
function profBonus(level){ return 2 + Math.floor((Math.max(1,level)-1)/4); }

// Full-caster slot table: slots[level][spellLevel 1..9]
var FULL_SLOTS = [
 null,
 [2],[3],[4,2],[4,3],[4,3,2],[4,3,3],[4,3,3,1],[4,3,3,2],[4,3,3,3,1],
 [4,3,3,3,2],[4,3,3,3,2,1],[4,3,3,3,2,1],[4,3,3,3,2,1,1],[4,3,3,3,2,1,1],
 [4,3,3,3,2,1,1,1],[4,3,3,3,2,1,1,1],[4,3,3,3,2,1,1,1,1],[4,3,3,3,3,1,1,1,1],
 [4,3,3,3,3,2,1,1,1],[4,3,3,3,3,2,2,1,1]
];
// Warlock pact magic: {slots, level}
var PACT = [null,
 {s:1,l:1},{s:2,l:1},{s:2,l:2},{s:2,l:2},{s:2,l:3},{s:2,l:3},{s:2,l:4},{s:2,l:4},
 {s:2,l:5},{s:2,l:5},{s:3,l:5},{s:3,l:5},{s:3,l:5},{s:3,l:5},{s:3,l:5},{s:3,l:5},
 {s:4,l:5},{s:4,l:5},{s:4,l:5},{s:4,l:5}];

// Multiclass caster-level weighting -> effective full-caster level
function casterLevelContribution(prog, classLevel){
  if (prog === "full") return classLevel;
  if (prog === "1/2" || prog === "half") return classLevel >= 1 ? Math.floor(classLevel/2) : 0;
  if (prog === "artificer") return Math.ceil(classLevel/2);
  if (prog === "1/3" || prog === "third") return Math.floor(classLevel/3);
  return 0; // pact & non-casters excluded from shared slots
}

function slotsForCasterLevel(cl){
  if (cl <= 0) return [];
  cl = Math.min(cl,20);
  return FULL_SLOTS[cl].slice();
}

function mod(score){ return Math.floor((score-10)/2); }
function sgn(n){ return (n>=0?"+":"")+n; }

/* expose a few for the sheet/derivation modules appended below */
window.__DND = {
  DATA:DATA, ABILS:ABILS, ABIL_NAME:ABIL_NAME, SKILLS:SKILLS,
  profBonus:profBonus, FULL_SLOTS:FULL_SLOTS, PACT:PACT,
  casterLevelContribution:casterLevelContribution,
  slotsForCasterLevel:slotsForCasterLevel, mod:mod, sgn:sgn
};

/* =========================================================================
   2. CHARACTER STATE  (single object + pub/sub)
   ========================================================================= */
function blankChar(){
  return {
    name:"", level:1,
    raceKey:null, subraceName:null,
    classes:[ /* {name, source, level, subclass} */ ],
    primaryClass:null,
    abilityMethod:"standard",      // standard|pointbuy|manual|roll
    baseAbilities:{str:8,dex:8,con:8,int:8,wis:8,cha:8},
    rolledPool:[],                 // for roll method, assignable values
    abilityAssign:{},              // ability -> pool index (roll/standard)
    asiChoices:{},                 // "className:level" -> {type:'asi'|'feat', ...}
    skillChoices:{race:[],class:[],background:[]},
    background:null,
    languages:[],
    spells:{ /* className -> {cantrips:[], known:[], prepared:[]} */ },
    equipment:[],
    chosenEquipment:{},            // className -> [choice index per group]
    details:{alignment:"",personality:"",ideals:"",bonds:"",flaws:"",
             backstory:"",appearance:"",age:"",height:"",weight:""},
    hpMode:"fixed",                // fixed|rolled
    hpRolls:{},                    // level -> rolled value
    // --- directly editable sheet fields (2c) ---
    sheet:{playerName:"", xp:"", currentHP:"", tempHP:"",
           deathSaves:{succ:0, fail:0}, notes:""},
    // --- misc +X bonuses layered on derived stats ---
    bonuses:{ac:0, init:0, speed:0,
             saves:{str:0,dex:0,con:0,int:0,wis:0,cha:0},
             skills:{},            // skill name -> +X
             abilities:{str:0,dex:0,con:0,int:0,wis:0,cha:0}},
    // --- AC / armor selection ---
    ac:{armorName:null, shield:false, custom:null, misc:0},
    // --- magic items (3a) ---
    magicItems:[],                 // {id,name,ref,custom,text,reqAttune,attuned,acBonus,notes}
    // --- racial choices (Half-Elf skills/abilities, Variant Human, Dragonborn
    //     ancestry, extra languages) persisted and fed to the sheet ---
    racialChoices:{abilities:[], skills:[], languages:[], feat:null,
                   draconicAncestry:null},
    // --- spell slots: expended count + optional manual max override per level ---
    slots:{used:{}, maxOverride:{}},   // {1..9: n}
    pact:{used:0},                     // warlock pact-magic slots expended
    alwaysPrepared:{},                 // className -> [spell names] (manual adds)
    spellbook:{},                      // Wizard: className -> [copied spell names]
    // --- class resources current values, keyed "ClassName:resourceKey" ---
    resources:{},
    inspiration:false,
    // --- hit dice spent per class hit-die, keyed "faces" (e.g. "10":n) ---
    hitDiceUsed:{},
    rest:{arcaneRecoveryUsed:false}
  };
}
var CH = blankChar();
var listeners = [];
function subscribe(fn){ listeners.push(fn); }
function emit(){ listeners.forEach(function(f){ f(CH); }); autosave(); }

/* ---- lookups ---- */
function raceByKey(key){
  return DATA.races.find(function(r){ return (r.name+"|"+r.source)===key; });
}
function subraceOf(race){
  if (!race || !CH.subraceName) return null;
  return (race.subraces||[]).find(function(s){ return s.name===CH.subraceName; });
}

/* 2014 Draconic Ancestry table (damage type + breath shape by dragon color). */
var DRACONIC = {
  Black:{dmg:"acid",shape:"5 by 30 ft. line (Dex)"},
  Blue:{dmg:"lightning",shape:"5 by 30 ft. line (Dex)"},
  Brass:{dmg:"fire",shape:"5 by 30 ft. line (Dex)"},
  Bronze:{dmg:"lightning",shape:"5 by 30 ft. line (Dex)"},
  Copper:{dmg:"acid",shape:"5 by 30 ft. line (Dex)"},
  Gold:{dmg:"fire",shape:"15 ft. cone (Dex)"},
  Green:{dmg:"poison",shape:"15 ft. cone (Con)"},
  Red:{dmg:"fire",shape:"15 ft. cone (Dex)"},
  Silver:{dmg:"cold",shape:"15 ft. cone (Con)"},
  White:{dmg:"cold",shape:"15 ft. cone (Con)"}
};

/* Merge base race + selected subrace into one view the sheet/UI consume.
   Traits union by name (subrace wins; data.overwrite replaces named base
   trait). Scalars (speed/darkvision) override when the subrace sets them.
   Proficiencies + additionalSpells concatenate. Dedupe by name. */
function mergedRace(){
  var race = raceByKey(CH.raceKey);
  if (!race) return null;
  var sub = subraceOf(race);
  var out = {
    name: race.name, subraceName: sub?sub.name:null,
    speed: Object.assign({}, race.speed||{}),
    darkvision: race.darkvision||0,
    resist: (race.resist||[]).slice(),
    traitTags: (race.traitTags||[]).slice(),
    weaponProficiencies: (race.weaponProficiencies||[]).slice(),
    armorProficiencies: (race.armorProficiencies||[]).slice(),
    toolProficiencies: (race.toolProficiencies||[]).slice(),
    traits: [], additionalSpells: []
  };
  if (race.additionalSpells) out.additionalSpells.push({from:race.name, spells:race.additionalSpells});
  // base traits, keyed by name for overwrite
  var byName = {};
  (race.traits||[]).forEach(function(t){ byName[t.name]=Object.assign({src:race.name}, t); });
  if (sub){
    // scalar overrides
    if (sub.speed) Object.assign(out.speed, sub.speed);
    if (sub.darkvision) out.darkvision = Math.max(out.darkvision, sub.darkvision);
    if (sub.resist && sub.resist.length) out.resist = out.resist.concat(sub.resist);
    out.traitTags = dedupe(out.traitTags.concat(sub.traitTags||[]));
    out.weaponProficiencies = dedupe(out.weaponProficiencies.concat(sub.weaponProficiencies||[]));
    out.armorProficiencies = dedupe(out.armorProficiencies.concat(sub.armorProficiencies||[]));
    out.toolProficiencies = dedupe(out.toolProficiencies.concat(sub.toolProficiencies||[]));
    if (sub.additionalSpells) out.additionalSpells.push({from:sub.name, spells:sub.additionalSpells});
    // subrace traits: apply data.overwrite (replace named base trait), else add
    (sub.traits||[]).forEach(function(t){
      if (t.overwrite && byName[t.overwrite]) delete byName[t.overwrite];
      byName[t.name]=Object.assign({src:sub.name}, t);
    });
  }
  // Dragonborn: fold the chosen ancestry into resist + a breath-weapon note
  if (race.name==="Dragonborn" && CH.racialChoices.draconicAncestry){
    var anc=DRACONIC[CH.racialChoices.draconicAncestry];
    if (anc){ out.resist=dedupe(out.resist.concat([anc.dmg])); out.draconic=Object.assign({color:CH.racialChoices.draconicAncestry}, anc); }
  }
  // preserve insertion order roughly: base order then any new subrace traits
  var order=[]; (race.traits||[]).forEach(function(t){ if(byName[t.name]&&byName[t.name].src===race.name) order.push(t.name); });
  Object.keys(byName).forEach(function(n){ if(order.indexOf(n)<0) order.push(n); });
  out.traits = order.map(function(n){ return byName[n]; }).filter(Boolean);
  out.resist = dedupe(out.resist);
  return out;
}
function dedupe(arr){ var seen={},out=[]; (arr||[]).forEach(function(x){ if(!seen[x]){seen[x]=1;out.push(x);} }); return out; }

/* Racial spells as a separate group (counted apart from class cantrips/known).
   Returns {ability, fixed:[{name,level,recharge}], choose:[{count,from,atLevel}]}. */
function racialSpells(){
  var mr=mergedRace(); if(!mr) return null;
  var out={ability:null, fixed:[], choose:[]};
  var totLvl=totalLevel();
  mr.additionalSpells.forEach(function(group){
    var as=group.spells; if(!as) return;
    out.ability = out.ability || as.ability;
    // list all racial spells; mark the unlock level and whether it's available
    // at the current character level (locked ones render greyed, not hidden).
    (as.known||[]).forEach(function(k){
      out.fixed.push({name:k.name, level:k.tag==="cantrip"?0:null,
                      unlock:k.atLevel||1, available:(k.atLevel||1)<=totLvl,
                      recharge:"at-will", from:group.from});
    });
    (as.innate||[]).forEach(function(b){
      (b.spellList||[]).forEach(function(sp){
        out.fixed.push({name:sp, level:b.level, unlock:b.level||1,
                        available:(b.level||1)<=totLvl,
                        recharge:b.recharge, freq:b.freq, from:group.from});
      });
    });
    (as.choose||[]).forEach(function(c){
      out.choose.push({count:c.count||1, from:c.from, ability:c.ability,
                       unlock:c.atLevel||1, available:(c.atLevel||1)<=totLvl, from_:group.from});
    });
  });
  return out;
}
function classByName(name){
  return DATA.classes.find(function(c){ return c.name===name; });
}
function bgByName(name){
  return DATA.backgrounds.find(function(b){ return (b.name+"|"+b.source)===name || b.name===name; });
}
function totalLevel(){
  if (!CH.classes.length) return CH.level;
  return CH.classes.reduce(function(s,c){ return s+c.level; },0);
}

/* =========================================================================
   3. DERIVATION ENGINE  (pure-ish: reads CH, returns computed sheet)
   ========================================================================= */
function abilityScores(){
  // base + racial bonuses
  var sc = {}; ABILS.forEach(function(a){ sc[a]=CH.baseAbilities[a]||8; });
  var race = raceByKey(CH.raceKey);
  function applyAbility(list){
    if (!list) return;
    list.forEach(function(blk){
      ABILS.forEach(function(a){ if (blk[a]) sc[a]+=blk[a]; });
      // 'choose' racial bonuses come from the Race-step chooser
      if (blk.choose){
        (CH.racialChoices.abilities||[]).forEach(function(a){
          sc[a]=(sc[a]||8)+(blk.choose.amount||1);
        });
      }
    });
  }
  if (race){
    // record-level overwrite: subrace 'ability' replaces base ability block
    var sr = CH.subraceName ? (race.subraces||[]).find(function(s){return s.name===CH.subraceName;}) : null;
    var subOverridesAbility = sr && (sr.overwriteFields||[]).indexOf("ability")>=0;
    if (!subOverridesAbility) applyAbility(race.ability);
    if (sr) applyAbility(sr.ability);
  }
  // feats / ASI that grant ability increases
  for (var key in CH.asiChoices){
    var ch = CH.asiChoices[key];
    if (ch && ch.type==="asi" && ch.asi){
      for (var a in ch.asi){ sc[a]=(sc[a]||8)+ch.asi[a]; }
    }
  }
  // cap at 20 for display of final
  ABILS.forEach(function(a){ if (sc[a]>20) sc[a]=20; });
  // misc ability bonuses (applied after cap so homebrew items can exceed 20)
  var ab = (CH.bonuses&&CH.bonuses.abilities)||{};
  ABILS.forEach(function(a){ if (ab[a]) sc[a]+=ab[a]; });
  return sc;
}

function derive(){
  var sc = abilityScores();
  var lvl = totalLevel();
  var pb = profBonus(lvl);
  var d = {scores:sc, mods:{}, level:lvl, pb:pb};
  ABILS.forEach(function(a){ d.mods[a]=mod(sc[a]); });

  // saving throw proficiencies: from primary (first) class only, per 5e rules
  var saveProfs = {};
  if (CH.classes.length){
    var firstCls = classByName(CH.classes[0].name);
    if (firstCls) (firstCls.saves||[]).forEach(function(s){ saveProfs[s]=true; });
  }
  var sbon = (CH.bonuses&&CH.bonuses.saves)||{};
  d.saves = {};
  ABILS.forEach(function(a){
    var parts=[{label:ABIL_NAME[a].slice(0,3)+" modifier", value:d.mods[a]}];
    if (saveProfs[a]) parts.push({label:"Proficiency", value:pb});
    if (sbon[a]) parts.push({label:"Misc", value:sbon[a]});
    d.saves[a] = d.mods[a] + (saveProfs[a]?pb:0) + (sbon[a]||0);
    d.saves[a+"_prof"] = !!saveProfs[a];
    d.saves[a+"_parts"] = parts;
  });

  // skill proficiencies collected from race/class/background choices + fixed
  var skillProf = {};
  collectSkillProfs().forEach(function(s){ skillProf[s]=true; });
  var skbon = (CH.bonuses&&CH.bonuses.skills)||{};
  d.skills = {};
  for (var sk in SKILLS){
    var ab2 = SKILLS[sk];
    var sparts=[{label:ABIL_NAME[ab2].slice(0,3)+" modifier", value:d.mods[ab2]}];
    if (skillProf[sk]) sparts.push({label:"Proficiency", value:pb});
    if (skbon[sk]) sparts.push({label:"Misc", value:skbon[sk]});
    var total = d.mods[ab2] + (skillProf[sk]?pb:0) + (skbon[sk]||0);
    d.skills[sk] = {mod:total, prof:!!skillProf[sk], ability:ab2, parts:sparts};
  }
  d.passivePerception = 10 + d.skills["Perception"].mod;

  // ability modifier breakdowns
  d.modParts = {};
  var abon = (CH.bonuses&&CH.bonuses.abilities)||{};
  ABILS.forEach(function(a){
    var mp=[{label:"Score "+sc[a], value:d.mods[a]}];
    d.modParts[a]=mp;
  });

  // HP
  d.hp = computeHP(sc, lvl);

  // AC from chosen armor + shield + magic + misc (with full breakdown)
  d.acInfo = computeAC(d);
  d.ac = d.acInfo.total;
  d.initiative = d.mods.dex + ((CH.bonuses&&CH.bonuses.init)||0);

  // speed / darkvision / resistances / racial proficiencies (merged race+subrace)
  var mr = mergedRace();
  var baseSpeed = mr ? (mr.speed.walk||30) : 30;
  d.speed = baseSpeed + ((CH.bonuses&&CH.bonuses.speed)||0);
  d.darkvision = mr ? mr.darkvision : 0;
  d.resist = mr ? mr.resist : [];
  d.racialProficiencies = mr ? {
    weapons: mr.weaponProficiencies, armor: mr.armorProficiencies, tools: mr.toolProficiencies
  } : {weapons:[],armor:[],tools:[]};
  d.racialSpells = racialSpells();

  // spellcasting (primary caster class for DC/attack; show per class)
  d.spellcasting = computeSpellcasting(sc, pb);

  // features by level
  d.features = collectFeatures();

  return d;
}

/* AC: unarmored 10+Dex by default; else armor base (+Dex per armor rule) +
   shield + attuned magic-item bonuses + misc. Returns {total, parts:[...]}. */
function itemByName(name){
  return DATA.items.find(function(it){ return it.name===name; });
}
function computeAC(d){
  var parts=[];
  var dex=d.mods.dex;
  var acState=CH.ac||{armorName:null,shield:false,custom:null,misc:0};
  var armor = acState.custom ? acState.custom
            : (acState.armorName ? (itemByName(acState.armorName)||{}).armorBlock : null);
  if (armor && armor.base!=null){
    parts.push({label:(acState.custom?"Custom armor":acState.armorName)+" base", value:armor.base});
    if (armor.addDex){
      var dexAdd = armor.maxDex!=null && armor.maxDex<99 ? Math.min(dex, armor.maxDex) : dex;
      parts.push({label:"Dex"+(armor.maxDex!=null&&armor.maxDex<99?(" (max "+armor.maxDex+")"):""), value:dexAdd});
    }
  } else {
    parts.push({label:"Base", value:10});
    parts.push({label:"Dex", value:dex});
  }
  if (acState.shield){ parts.push({label:"Shield", value:2}); }
  // attuned magic items with an AC bonus
  (CH.magicItems||[]).forEach(function(mi){
    if (mi.attuned && mi.acBonus) parts.push({label:mi.name, value:Number(mi.acBonus)});
  });
  if (acState.misc){ parts.push({label:"Misc", value:Number(acState.misc)}); }
  var total=parts.reduce(function(s,p){ return s+(Number(p.value)||0); },0);
  return {total:total, parts:parts};
}

function collectSkillProfs(){
  var out = {};
  (CH.skillChoices.race||[]).forEach(function(s){ out[s]=1; });
  (CH.skillChoices.class||[]).forEach(function(s){ out[s]=1; });
  (CH.skillChoices.background||[]).forEach(function(s){ out[s]=1; });
  // racial choosers (Half-Elf / Variant Human skills)
  (CH.racialChoices && CH.racialChoices.skills || []).forEach(function(s){ out[normSkill(s)]=1; });
  // fixed race skills
  var race = raceByKey(CH.raceKey);
  if (race && race.skillProficiencies && race.skillProficiencies.fixed)
    race.skillProficiencies.fixed.forEach(function(s){ out[normSkill(s)]=1; });
  // fixed background skills
  var bg = CH.background && bgByName(CH.background);
  if (bg && bg.skillProficiencies && bg.skillProficiencies.fixed)
    bg.skillProficiencies.fixed.forEach(function(s){ out[normSkill(s)]=1; });
  return Object.keys(out);
}
function normSkill(s){
  // data sometimes lowercases second word ("Animal handling")
  for (var k in SKILLS){ if (k.toLowerCase()===String(s).toLowerCase()) return k; }
  return s;
}

function computeHP(sc, lvl){
  if (!CH.classes.length) return {total: 0, note:"Choose a class"};
  var conMod = mod(sc.con);
  var total = 0, first = true;
  CH.classes.forEach(function(c){
    var cls = classByName(c.name); if (!cls) return;
    var faces = cls.hd.faces;
    for (var i=1;i<=c.level;i++){
      if (first){ total += faces + conMod; first=false; }
      else {
        if (CH.hpMode==="rolled" && CH.hpRolls[c.name+":"+i]!=null)
          total += CH.hpRolls[c.name+":"+i] + conMod;
        else total += Math.floor(faces/2)+1 + conMod; // fixed average
      }
    }
  });
  return {total: Math.max(total,1)};
}

function computeSpellcasting(sc, pb){
  var out = {classes:[], sharedSlots:[], pact:null, casterLevel:0};
  var casterLevel = 0;
  CH.classes.forEach(function(c){
    var cls = classByName(c.name); if (!cls || !cls.spellcasting || !cls.spellcasting.ability) return;
    var prog = cls.spellcasting.progression;
    var abil = cls.spellcasting.ability;
    var dc = 8 + pb + mod(sc[abil]);
    var atk = pb + mod(sc[abil]);
    out.classes.push({
      name:c.name, ability:abil, prog:prog, dc:dc, atk:atk,
      prepared: cls.spellcasting.prepared, level:c.level
    });
    casterLevel += casterLevelContribution(prog, c.level);
    if (prog==="pact"){
      out.pact = PACT[Math.min(c.level,20)];
    }
  });
  out.casterLevel = casterLevel;
  out.sharedSlots = slotsForCasterLevel(casterLevel);
  return out;
}

function collectFeatures(){
  var out = [];
  CH.classes.forEach(function(c){
    var cls = classByName(c.name); if (!cls) return;
    (cls.features||[]).forEach(function(f){
      if (f.level && f.level<=c.level)
        out.push({cls:c.name, level:f.level, name:f.name, ref:f.textRef, text:f.text});
    });
    if (c.subclass){
      var sub = (cls.subclasses||[]).find(function(s){return s.name===c.subclass;});
      if (sub) (sub.features||[]).forEach(function(f){
        if (f.level && f.level<=c.level)
          out.push({cls:c.name+" ("+c.subclass+")", level:f.level, name:f.name, ref:f.textRef, text:f.text});
      });
    }
  });
  out.sort(function(a,b){ return a.level-b.level; });
  return out;
}

/* =========================================================================
   3b. SLOTS, RESOURCES, REST  (current/expended state layered on derived max)
   ========================================================================= */
/* Max slots for a given spell level (1..9), honoring a manual override. */
function slotMax(d, level){
  var ov = CH.slots.maxOverride[level];
  if (ov!=null && ov!=="") return parseInt(ov,10)||0;
  return (d.spellcasting.sharedSlots[level-1])||0;
}
function slotUsed(level){ return CH.slots.used[level]||0; }
function slotRemaining(d, level){ return Math.max(0, slotMax(d,level)-slotUsed(level)); }
function pactMax(d){ return d.spellcasting.pact ? d.spellcasting.pact.s : 0; }
function pactRemaining(d){ return Math.max(0, pactMax(d)-(CH.pact.used||0)); }

/* Resolve active class resources to {id,name,recharge,max,current,die?,cls}. */
function resolveResources(d){
  var out = [];
  var sc = d.scores;
  CH.classes.forEach(function(c){
    var cls = classByName(c.name); if (!cls) return;
    (cls.resources||[]).forEach(function(r){
      // subclass-scoped resources only if that subclass is chosen
      if (r.subclass && r.subclass!==c.subclass) return;
      var lvlIdx = Math.min(c.level,20)-1;
      var max = (r.maxByLevel && r.maxByLevel[lvlIdx])||0;
      if (r.key==="bardic-inspiration"){ max = Math.max(1, mod(sc.cha)); }       // uses = CHA mod
      if (r.key==="arcane-recovery"){ max = 1; }
      if (max<=0 && r.key!=="bardic-inspiration") return;                        // not yet unlocked
      var id = c.name+":"+r.key;
      var cur = CH.resources[id];
      if (cur==null) cur = max;                                                  // seed full
      cur = Math.min(cur, max);
      var die = r.die ? r.die[lvlIdx] : null;
      out.push({id:id, key:r.key, name:r.name, cls:c.name, recharge:r.recharge,
                max:max, current:cur, die:die, note:r.note});
    });
  });
  return out;
}
function resourceSet(id, val){ CH.resources[id]=val; }

/* Clamp expended slots/resources to current maxima (after a level change). */
function clampAll(){
  var d = derive();
  for (var L=1; L<=9; L++){
    var m = slotMax(d,L);
    if ((CH.slots.used[L]||0) > m) CH.slots.used[L]=m;
  }
  if ((CH.pact.used||0) > pactMax(d)) CH.pact.used = pactMax(d);
  resolveResources(d).forEach(function(r){
    if (CH.resources[r.id]!=null && CH.resources[r.id] > r.max) CH.resources[r.id]=r.max;
  });
}

/* Short rest: restore short-recharge resources, pact slots, let the user spend
   hit dice to heal (handled in UI). Long rest: everything + HP/temp/death/HD. */
function doShortRest(){
  var d = derive();
  resolveResources(d).forEach(function(r){ if (r.recharge==="short") CH.resources[r.id]=r.max; });
  CH.pact.used = 0;                        // Pact Magic returns on a short rest
  emit(); renderWizard();
}
function doLongRest(){
  var d = derive();
  // all resources (short + long + dawn) refill
  resolveResources(d).forEach(function(r){ CH.resources[r.id]=r.max; });
  CH.pact.used = 0;
  CH.slots.used = {};                      // all spell slots return
  CH.rest.arcaneRecoveryUsed = false;
  // HP to max, clear temp HP and death saves
  CH.sheet.currentHP = d.hp.total;
  CH.sheet.tempHP = "";
  CH.sheet.deathSaves = {succ:0, fail:0};
  // regain half of total hit dice (min 1)
  var totalHD = CH.classes.reduce(function(s,c){return s+c.level;},0) || 1;
  var regain = Math.max(1, Math.floor(totalHD/2));
  var used = CH.hitDiceUsed || {};
  // return from the largest pools first
  var pools = CH.classes.map(function(c){ var cl=classByName(c.name); return {faces:cl?cl.hd.faces:8, max:c.level}; });
  pools.sort(function(a,b){ return b.faces-a.faces; });
  pools.forEach(function(pl){
    var key=String(pl.faces);
    while (regain>0 && (used[key]||0)>0){ used[key]--; regain--; }
  });
  CH.hitDiceUsed = used;
  emit(); renderWizard();
}
/* Spend one hit die of a given faces to heal (avg or rolled) + CON mod. */
function spendHitDie(faces, rolled){
  var d = derive();
  var key=String(faces);
  var maxForDie = CH.classes.filter(function(c){var cl=classByName(c.name);return cl&&cl.hd.faces===faces;})
                            .reduce(function(s,c){return s+c.level;},0);
  if ((CH.hitDiceUsed[key]||0) >= maxForDie) return;
  var roll = rolled!=null ? rolled : (Math.floor(faces/2)+1); // average
  var heal = Math.max(0, roll + mod(d.scores.con));
  CH.hitDiceUsed[key]=(CH.hitDiceUsed[key]||0)+1;
  var cur = (CH.sheet.currentHP===""||CH.sheet.currentHP==null)?d.hp.total:CH.sheet.currentHP;
  CH.sheet.currentHP = Math.min(d.hp.total, cur+heal);
  emit(); renderWizard();
}

window.__DND.CH = function(){ return CH; };
window.__DND.derive = derive;
window.__DND.classByName = classByName;
window.__DND.raceByKey = raceByKey;
window.__DND.bgByName = bgByName;
window.__DND.totalLevel = totalLevel;
window.__DND.resolveResources = function(){ return resolveResources(derive()); };
window.__DND.slotMax = function(L){ return slotMax(derive(), L); };
window.__DND.doShortRest = doShortRest;
window.__DND.doLongRest = doLongRest;
window.__DND.clampAll = clampAll;

/* =========================================================================
   4. DOM + TEXT HELPERS
   ========================================================================= */
function el(tag, attrs, children){
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs){
    if (k==="class") e.className=attrs[k];
    else if (k==="html") e.innerHTML=attrs[k];
    else if (k.slice(0,2)==="on" && typeof attrs[k]==="function")
      e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else if (attrs[k]!=null) e.setAttribute(k, attrs[k]);
  }
  if (children!=null){
    (Array.isArray(children)?children:[children]).forEach(function(c){
      if (c==null) return;
      e.appendChild(typeof c==="string"?document.createTextNode(c):c);
    });
  }
  return e;
}
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

// Minimal markdown (Open5e SRD prose) -> HTML: headings, bold/italic, tables, lists.
function mdToHtml(md){
  if (!md) return "";
  var lines = String(md).split(/\r?\n/);
  var html = [], i=0;
  function inline(t){
    t = esc(t);
    t = t.replace(/\*\*\*(.+?)\*\*\*/g,"<strong><em>$1</em></strong>");
    t = t.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");
    t = t.replace(/_([^_]+)_/g,"<em>$1</em>");
    t = t.replace(/\*(.+?)\*/g,"<em>$1</em>");
    return t;
  }
  while (i<lines.length){
    var ln = lines[i];
    if (/^\s*\|.*\|\s*$/.test(ln)){            // table block
      var tbl=[];
      while (i<lines.length && /^\s*\|.*\|\s*$/.test(lines[i])){ tbl.push(lines[i]); i++; }
      html.push(renderMdTable(tbl, inline)); continue;
    }
    if (/^#{1,6}\s/.test(ln)){
      var h = ln.match(/^(#{1,6})\s+(.*)$/);
      html.push("<h"+(h[1].length+2)+">"+inline(h[2])+"</h"+(h[1].length+2)+">"); i++; continue;
    }
    if (/^\s*[-*]\s+/.test(ln)){
      var items=[];
      while (i<lines.length && /^\s*[-*]\s+/.test(lines[i])){
        items.push("<li>"+inline(lines[i].replace(/^\s*[-*]\s+/,""))+"</li>"); i++;
      }
      html.push("<ul>"+items.join("")+"</ul>"); continue;
    }
    if (ln.trim()===""){ html.push(""); i++; continue; }
    var para=[ln]; i++;
    while (i<lines.length && lines[i].trim()!=="" && !/^\s*\|/.test(lines[i])
           && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])){
      para.push(lines[i]); i++;
    }
    html.push("<p>"+inline(para.join(" "))+"</p>");
  }
  return html.join("\n");
}
function renderMdTable(rows, inline){
  var cells = rows.map(function(r){
    return r.trim().replace(/^\||\|$/g,"").split("|").map(function(c){return c.trim();});
  });
  // drop separator row (---)
  var out="<table>", started=false;
  cells.forEach(function(row, idx){
    if (row.every(function(c){return /^:?-{2,}:?$/.test(c);})) return;
    var tag = (idx===0)?"th":"td";
    out+="<tr>"+row.map(function(c){return "<"+tag+">"+inline(c)+"</"+tag+">";}).join("")+"</tr>";
  });
  return out+"</table>";
}

/* =========================================================================
   5. AUTOSAVE (wrapped in try/catch; storage may be unavailable)
   ========================================================================= */
var SAVE_KEY = "dnd5e_char_v1";
var noteEl = null;
function autosave(){
  try{
    localStorage.setItem(SAVE_KEY, JSON.stringify(CH));
    if (noteEl) noteEl.textContent = "Autosaved "+new Date().toLocaleTimeString();
  }catch(e){
    if (noteEl) noteEl.textContent = "Autosave unavailable (storage blocked)";
  }
}
function restore(){
  try{
    var s = localStorage.getItem(SAVE_KEY);
    if (s){ var obj=JSON.parse(s); if (obj && typeof obj==="object"){ CH=merge(blankChar(),obj); return true; } }
  }catch(e){}
  return false;
}
function merge(base, over){
  for (var k in over){
    if (over[k] && typeof over[k]==="object" && !Array.isArray(over[k]) && base[k])
      base[k]=merge(base[k], over[k]);
    else base[k]=over[k];
  }
  return base;
}

/* =========================================================================
   5b. INSPECT POPOVER  (hover on desktop, tap on touch; ESC/outside closes)
   ========================================================================= */
var _popEl=null, _popAnchor=null, _popPinned=false;

function closePopover(){
  if (_popEl && _popEl.parentNode) _popEl.parentNode.removeChild(_popEl);
  _popEl=null; _popAnchor=null; _popPinned=false;
}

/* content builders return a DOM node describing a record */
function spellInspect(s){
  var lvl = s.level===0?"Cantrip":("Level "+s.level+" "+s.school);
  var meta = [lvl, s.time, s.range, s.duration].filter(Boolean).join(" \u00b7 ");
  var comp=[]; if(s.components){ if(s.components.v)comp.push("V"); if(s.components.s)comp.push("S"); if(s.components.m)comp.push("M"); }
  var sub=[];
  if (comp.length) sub.push("Components: "+comp.join(", ")+(typeof s.components.m==="string"?" ("+s.components.m+")":""));
  if (s.concentration) sub.push("Concentration");
  if (s.ritual) sub.push("Ritual");
  if ((s.classes||[]).length) sub.push("Classes: "+s.classes.join(", "));
  return popoverBody(s.name, meta, sub.join(" \u00b7 "), s.text, s.textRef, s.school);
}
function itemInspect(it){
  var bits=[it.type, it.rarity, it.reqAttune?("attunement"+(typeof it.reqAttune==="string"?" "+it.reqAttune:"")):null].filter(Boolean);
  var sub=[];
  if (it.dmg1) sub.push("Damage: "+it.dmg1+" "+(it.dmgType||""));
  if (it.armorBlock) sub.push("Armor: base "+it.armorBlock.base+(it.armorBlock.addDex?(" + Dex"+(it.armorBlock.maxDex<99?" (max "+it.armorBlock.maxDex+")":"")):""));
  if (it.bonusAc) sub.push("AC bonus "+it.bonusAc);
  if (it.properties && it.properties.length) sub.push("Properties: "+it.properties.map(propName).join(", "));
  return popoverBody(it.name, bits.join(" \u00b7 "), sub.join(" \u00b7 "), it.text, it.textRef);
}
function featureInspect(f){
  return popoverBody(f.name, f.level?("Level "+f.level):"", f.cls||"", f.text, f.ref||f.textRef);
}
function featInspect(ft){
  var meta = (ft.prerequisite&&ft.prerequisite.length)?"Prerequisite required":"";
  return popoverBody(ft.name, meta, "", ft.text, ft.textRef);
}
function textInspect(title, meta, text, ref){
  return popoverBody(title, meta||"", "", text, ref);
}
/* Breakdown popover: lists each contributing part summing to a total, with an
   optional editable "+X misc" bound via onMisc(newValue). */
function breakdownInspect(title, parts, total, miscVal, onMisc){
  var body = el("div",{class:"pop-body"});
  body.appendChild(el("div",{class:"pop-head"},[el("span",{class:"pop-title"},title)]));
  var tbl = el("div",{class:"pop-breakdown"});
  parts.forEach(function(p){
    tbl.appendChild(el("div",{class:"pop-brk-row"},[
      el("span",{class:"pop-brk-lab"}, p.label),
      el("span",{class:"pop-brk-val"}, (p.value>=0?"+":"")+p.value)
    ]));
  });
  tbl.appendChild(el("div",{class:"pop-brk-row total"},[
    el("span",{class:"pop-brk-lab"}, "Total"),
    el("span",{class:"pop-brk-val"}, String(total))
  ]));
  body.appendChild(tbl);
  if (onMisc){
    var row = el("div",{class:"pop-misc"});
    row.appendChild(el("label",null,"Misc bonus"));
    var inp = el("input",{type:"number", value:(miscVal||0), style:"width:60px"});
    inp.addEventListener("click", function(e){ e.stopPropagation(); });
    inp.addEventListener("change", function(e){
      onMisc(parseInt(e.target.value,10)||0); emit(); renderSheetStep();
    });
    row.appendChild(inp);
    body.appendChild(row);
  }
  return body;
}
/* re-render whichever view hosts the sheet (wizard step or elsewhere) */
function renderSheetStep(){
  var host = document.getElementById("step-body");
  if (host && host.querySelector(".cs-sheet")){ renderWizard(); }
  renderSheet();
}
/* attach a click/hover breakdown to a sheet cell */
function makeBreakdown(node, title, parts, total, miscVal, onMisc){
  node.classList.add("cs-clickable");
  function build(){ return breakdownInspect(title, parts, total, miscVal, onMisc); }
  node.addEventListener("mouseenter", function(){ if(!_popPinned) openPopover(node, build(), false); });
  node.addEventListener("mouseleave", function(){ if(!_popPinned && _popAnchor===node) closePopover(); });
  node.addEventListener("click", function(e){ e.stopPropagation(); openPopover(node, build(), true); });
  return node;
}
function propName(p){
  if (typeof p==="string") return p.split("|")[0];
  if (p && p.uid) return String(p.uid).split("|")[0];
  return "";
}

function popoverBody(title, meta, subline, text, ref, schoolTag){
  var body = el("div",{class:"pop-body"});
  var head = el("div",{class:"pop-head"},[el("span",{class:"pop-title"},title)]);
  if (schoolTag) head.appendChild(el("span",{class:"pop-tag"}, schoolTag));
  body.appendChild(head);
  if (meta) body.appendChild(el("div",{class:"pop-meta"}, meta));
  if (subline) body.appendChild(el("div",{class:"pop-sub"}, subline));
  if (text) body.appendChild(el("div",{class:"pop-text",html:mdToHtml(text)}));
  else body.appendChild(el("div",{class:"pop-sub muted"},"(No description in data \u2014 see reference.)"));
  if (ref) body.appendChild(el("div",{class:"pop-ref"}, ref));
  return body;
}

function openPopover(anchor, contentNode, pinned){
  if (_popAnchor===anchor && _popPinned && !pinned){ return; } // keep a pinned one
  closePopover();
  _popEl = el("div",{class:"inspect-pop"});
  if (pinned){
    _popEl.appendChild(el("button",{class:"pop-close", onclick:function(e){ e.stopPropagation(); closePopover(); }}, "\u00d7"));
    _popEl.classList.add("pinned");
  }
  _popEl.appendChild(contentNode);
  document.body.appendChild(_popEl);
  _popAnchor=anchor; _popPinned=!!pinned;
  positionPopover(anchor);
}
function positionPopover(anchor){
  if (!_popEl||!anchor) return;
  var r = anchor.getBoundingClientRect();
  var pw = _popEl.offsetWidth, ph = _popEl.offsetHeight;
  var vw = window.innerWidth, vh = window.innerHeight;
  var left = r.left;
  if (left+pw > vw-8) left = Math.max(8, vw-pw-8);
  var top = r.bottom+6;
  if (top+ph > vh-8) top = Math.max(8, r.top-ph-6);  // flip above
  _popEl.style.left = (left+window.scrollX)+"px";
  _popEl.style.top = (top+window.scrollY)+"px";
}

/* Make a node inspectable. builder() returns the content node (lazily). */
function makeInspectable(node, builder){
  node.classList.add("inspectable");
  node.addEventListener("mouseenter", function(){
    if (_popPinned) return;        // don't fight a pinned popover
    openPopover(node, builder(), false);
  });
  node.addEventListener("mouseleave", function(){
    if (!_popPinned && _popAnchor===node) closePopover();
  });
  node.addEventListener("click", function(e){
    e.stopPropagation();
    openPopover(node, builder(), true);   // pin on click/tap
  });
  return node;
}
/* Small circled-i button that pins a popover built by builder() on click. */
function infoBtn(builder){
  var b = el("span",{class:"info-btn", title:"Details"}, "\u24d8");
  b.addEventListener("click", function(e){ e.stopPropagation(); openPopover(b, builder(), true); });
  b.addEventListener("mouseenter", function(){ if(!_popPinned) openPopover(b, builder(), false); });
  b.addEventListener("mouseleave", function(){ if(!_popPinned && _popAnchor===b) closePopover(); });
  return b;
}

// global dismissers
document.addEventListener("keydown", function(e){ if (e.key==="Escape") closePopover(); });
document.addEventListener("click", function(e){
  if (_popEl && _popPinned && !_popEl.contains(e.target) && e.target!==_popAnchor
      && !(_popAnchor&&_popAnchor.contains(e.target))) closePopover();
});
window.addEventListener("resize", function(){ if(_popAnchor) positionPopover(_popAnchor); });

window.__DND.openPopover=openPopover;
window.__DND.closePopover=function(){ return closePopover(); };
window.__DND.spellInspect=spellInspect;

/* =========================================================================
   6. WIZARD
   ========================================================================= */
var STEPS = [
  {id:"race",   title:"Race",          render:stepRace},
  {id:"class",  title:"Class",         render:stepClass},
  {id:"ability",title:"Ability Scores",render:stepAbility},
  {id:"bg",     title:"Background",    render:stepBackground},
  {id:"equip",  title:"Equipment",     render:stepEquipment},
  {id:"spells", title:"Spellcasting",  render:stepSpells, when:hasSpellcasting},
  {id:"resources",title:"Resources",   render:stepResources, when:hasResources},
  {id:"details",title:"Details",       render:stepDetails},
  {id:"review", title:"Character Sheet",render:stepReview}
];
var curStep = 0;

function hasSpellcasting(){
  return CH.classes.some(function(c){
    var cls=classByName(c.name); return cls && cls.spellcasting && cls.spellcasting.ability;
  });
}
function hasResources(){ return resolveResources(derive()).length>0; }
function activeSteps(){ return STEPS.filter(function(s){ return !s.when || s.when(); }); }

function renderSteps(){
  var nav = document.getElementById("steps"); nav.innerHTML="";
  var act = activeSteps();
  act.forEach(function(s, idx){
    var cls = "chip"+(idx===curStep?" active":"");
    nav.appendChild(el("span",{class:cls, onclick:function(){ curStep=idx; renderWizard(); }}, s.title));
  });
}
function renderWizard(){
  var act = activeSteps();
  if (curStep>=act.length) curStep=act.length-1;
  renderSteps();
  var body = document.getElementById("step-body"); body.innerHTML="";
  act[curStep].render(body);
  document.getElementById("btn-prev").disabled = curStep===0;
  var next = document.getElementById("btn-next");
  next.textContent = (curStep===act.length-1)?"Done":"Next \u2192";
}
function go(delta){
  var act = activeSteps();
  curStep = Math.max(0, Math.min(act.length-1, curStep+delta));
  renderWizard();
}

function stepHeader(parent, title, hint){
  parent.appendChild(el("h2",{class:"step-title"},title));
  if (hint) parent.appendChild(el("p",{class:"step-hint"},hint));
}

/* ---------- STEP: RACE ---------- */
function stepRace(p){
  stepHeader(p,"Choose a Race", "Select a race, then a subrace if available.");
  var grid = el("div",{class:"grid"});
  DATA.races.forEach(function(r){
    var key = r.name+"|"+r.source;
    var sel = CH.raceKey===key;
    var abil = (r.ability||[]).map(fmtAbility).join(", ")||"\u2014";
    var card = el("div",{class:"card"+(sel?" selected":""), onclick:function(){
      CH.raceKey = sel?null:key; CH.subraceName=null; CH.skillChoices.race=[];
      emit(); renderWizard();
    }},[
      el("h3",null,r.name),
      el("div",{class:"meta"}, r.source+(r.page?" p."+r.page:"")+" \u00b7 "+abil),
      el("div",{class:"tags"}, [
        el("span",{class:"tag"}, "Speed "+(r.speed.walk||30)),
        r.darkvision?el("span",{class:"tag"},"Darkvision "+r.darkvision):null,
        (r.subraces&&r.subraces.length)?el("span",{class:"tag"},r.subraces.length+" subraces"):null
      ])
    ]);
    grid.appendChild(card);
  });
  p.appendChild(grid);

  var race = raceByKey(CH.raceKey);
  if (race){
    var panel = el("div",{class:"panel"});
    panel.appendChild(el("h3",null, race.name+" traits"));
    // subrace as cards with a trait-name preview
    if (race.subraces && race.subraces.length){
      panel.appendChild(el("label",{class:"muted"},"Subrace"));
      var sgrid = el("div",{class:"grid"});
      race.subraces.forEach(function(sr){
        var s = CH.subraceName===sr.name;
        var preview=(sr.traits||[]).map(function(t){return t.name;}).slice(0,4).join(", ");
        sgrid.appendChild(el("div",{class:"card"+(s?" selected":""), onclick:function(){
          CH.subraceName = s?null:sr.name; CH.racialChoices.draconicAncestry=CH.racialChoices.draconicAncestry; emit(); renderWizard();
        }},[
          el("h3",null, sr.name),
          el("div",{class:"meta"}, (sr.ability&&sr.ability.length?sr.ability.map(fmtAbility).join(", "):"\u2014")+" \u00b7 "+(sr.source||"")),
          preview?el("div",{class:"tags"},[el("span",{class:"tag"},preview)]):null
        ]));
      });
      panel.appendChild(sgrid);
    }
    // race fixed skill choices
    if (race.skillProficiencies && race.skillProficiencies.choose)
      panel.appendChild(skillChooser("race", race.skillProficiencies.choose));

    // racial choosers (Half-Elf / Variant Human / Dragonborn / extra languages)
    appendRacialChoosers(panel, race);

    // merged trait list — each trait its own bold-titled paragraph
    var mr = mergedRace();
    if (mr && mr.traits.length){
      panel.appendChild(el("label",{class:"muted"},"Traits"));
      var tl = el("div",{class:"trait-list"});
      mr.traits.forEach(function(t){ tl.appendChild(traitParagraph(t)); });
      panel.appendChild(tl);
    }
    // racial spells summary
    var rs = racialSpells();
    if (rs && (rs.fixed.length || rs.choose.length)){
      var spn = rs.fixed.map(function(f){ return f.name+(f.level?(" (L"+f.level+")"):" (cantrip)"); });
      rs.choose.forEach(function(c){ spn.push("choose "+c.count); });
      panel.appendChild(el("div",{class:"field"},[
        el("label",null,"Racial Spells"+(rs.ability?(" ("+ABIL_NAME[rs.ability]+")"):"")),
        el("div",{class:"muted",style:"font-size:12px"}, spn.join(", "))
      ]));
    }
    if (mr && mr.resist.length)
      panel.appendChild(el("div",{class:"field"},[el("label",null,"Resistances"),
        el("div",null, mr.resist.map(function(r){return el("span",{class:"badge"},r);}))]));
    p.appendChild(panel);
  }
}

/* each trait: bold name heading + its own paragraph (never concatenated) */
function traitParagraph(t){
  var wrap = el("div",{class:"trait-para"});
  var head = el("div",{class:"trait-name"}, t.name);
  wrap.appendChild(head);
  if (t.text) wrap.appendChild(el("div",{class:"trait-text",html:mdToHtml(t.text)}));
  else wrap.appendChild(el("div",{class:"ref"}, t.textRef||""));
  if (t.recharge) head.appendChild(el("span",{class:"tag",style:"margin-left:6px"}, t.recharge+" rest"));
  return wrap;
}

/* Race-step choosers writing to CH.racialChoices, persisted + fed to the sheet */
function appendRacialChoosers(panel, race){
  var rc = CH.racialChoices;
  // Variant Human: choose skill + feat + two +1s ; Half-Elf: two +1s
  var isVariantHuman = race.name==="Human" && CH.subraceName==="Variant";
  var isHalfElf = race.name==="Half-Elf";

  // --- ability +1 choosers (Half-Elf two, Variant Human two, from a subrace/race choose block) ---
  var abilChoose = findAbilityChoose(race);
  if (abilChoose){
    var need = abilChoose.count||1;
    var f = el("div",{class:"field"});
    f.appendChild(el("label",null,"Ability increases \u2014 choose "+need+" (+"+(abilChoose.amount||1)+" each, different)"));
    var row = el("div",{class:"inline-opts"});
    (abilChoose.from||ABILS).forEach(function(a){
      var on = rc.abilities.indexOf(a)>=0;
      row.appendChild(el("label",{class:"opt"+(on?" sel":"")},[
        el("input",{type:"checkbox",checked:on?"checked":null, onchange:function(ev){
          var arr=rc.abilities.slice();
          if (ev.target.checked){ if(arr.length<need) arr.push(a); else ev.target.checked=false; }
          else arr=arr.filter(function(x){return x!==a;});
          rc.abilities=arr; emit(); renderWizard();
        }}),
        document.createTextNode(ABIL_NAME[a])
      ]));
    });
    f.appendChild(row);
    f.appendChild(el("div",{class:rc.abilities.length===need?"ok":"warn"}, rc.abilities.length+" / "+need));
    panel.appendChild(f);
  }

  // --- Variant Human: one skill of choice (Half-Elf's skills come from its
  //     own race skillProficiencies.choose handled by skillChooser above) ---
  if (isVariantHuman){
    panel.appendChild(racialSkillChooser(1));
  }

  // --- Variant Human: a feat ---
  if (isVariantHuman){
    var ff = el("div",{class:"field"});
    ff.appendChild(el("label",null,"Feat (Variant Human)"));
    var fs = el("select",{onchange:function(e){ rc.feat=e.target.value||null; emit(); renderWizard(); }});
    fs.appendChild(el("option",{value:""},"\u2014 choose feat \u2014"));
    DATA.feats.forEach(function(ft){ var o=el("option",{value:ft.name},ft.name); if(rc.feat===ft.name)o.selected=true; fs.appendChild(o); });
    ff.appendChild(fs);
    if (rc.feat){ var ftr=DATA.feats.find(function(x){return x.name===rc.feat;}); if(ftr) ff.appendChild(infoBtn(function(){return featInspect(ftr);})); }
    panel.appendChild(ff);
  }

  // --- Dragonborn ancestry ---
  if (race.name==="Dragonborn"){
    var df = el("div",{class:"field"});
    df.appendChild(el("label",null,"Draconic Ancestry"));
    var ds = el("select",{onchange:function(e){ rc.draconicAncestry=e.target.value||null; emit(); renderWizard(); }});
    ds.appendChild(el("option",{value:""},"\u2014 choose dragon \u2014"));
    Object.keys(DRACONIC).forEach(function(color){
      var o=el("option",{value:color}, color+" ("+DRACONIC[color].dmg+")"); if(rc.draconicAncestry===color)o.selected=true; ds.appendChild(o);
    });
    df.appendChild(ds);
    if (rc.draconicAncestry){
      var anc=DRACONIC[rc.draconicAncestry];
      df.appendChild(el("div",{class:"muted",style:"font-size:12px"},
        "Breath Weapon: "+anc.shape+", "+anc.dmg+" damage. Resistance: "+anc.dmg+"."));
    }
    panel.appendChild(df);
  }

  // --- extra languages (anyStandard/any on race or subrace) ---
  var langN = extraLanguageCount(race);
  if (langN>0){
    var lf = el("div",{class:"field"});
    lf.appendChild(el("label",null,"Extra languages \u2014 choose "+langN));
    var ltext = el("input",{type:"text", placeholder:"e.g. Draconic, Dwarvish", value:(rc.languages||[]).join(", ")});
    ltext.addEventListener("input", function(e){ rc.languages=e.target.value.split(/,\s*/).filter(Boolean); autosave(); });
    lf.appendChild(ltext);
    panel.appendChild(lf);
  }
}
function findAbilityChoose(race){
  // look on base race ability then subrace ability for a 'choose' block
  function scan(list){ for(var i=0;i<(list||[]).length;i++){ if(list[i].choose) return list[i].choose; } return null; }
  var sub = subraceOf(race);
  return (sub && scan(sub.ability)) || scan(race.ability);
}
function extraLanguageCount(race){
  var n=0;
  if (race.languages && race.languages.choose) n+=race.languages.choose;
  var sub=subraceOf(race);
  if (sub && sub.languages && sub.languages.choose) n+=sub.languages.choose;
  return n;
}
/* Half-Elf/Variant-Human skill chooser writing to CH.racialChoices.skills */
function racialSkillChooser(count){
  var rc=CH.racialChoices;
  var field=el("div",{class:"field"});
  field.appendChild(el("label",null,"Skill proficiencies \u2014 choose "+count));
  var opts=el("div",{class:"inline-opts"});
  Object.keys(SKILLS).forEach(function(sk){
    var on=rc.skills.indexOf(sk)>=0;
    opts.appendChild(el("label",{class:"opt"+(on?" sel":"")},[
      el("input",{type:"checkbox",checked:on?"checked":null,onchange:function(ev){
        var arr=rc.skills.slice();
        if(ev.target.checked){ if(arr.length<count) arr.push(sk); else ev.target.checked=false; }
        else arr=arr.filter(function(x){return x!==sk;});
        rc.skills=arr; emit(); renderWizard();
      }}),
      document.createTextNode(sk)
    ]));
  });
  field.appendChild(opts);
  field.appendChild(el("div",{class:rc.skills.length===count?"ok":"warn"}, rc.skills.length+" / "+count));
  return field;
}
function fmtAbility(blk){
  var parts=[];
  ABILS.forEach(function(a){ if (blk[a]) parts.push(ABIL_NAME[a].slice(0,3)+" "+sgn(blk[a])); });
  if (blk.choose) parts.push("choose "+(blk.choose.count||1)+" "+sgn(blk.choose.amount||1));
  return parts.join(", ");
}

/* Skills a character already has proficiency in, EXCLUDING one bucket's own
   choices. Used so a chooser can block picking a skill granted elsewhere
   (you can't stack/double up proficiency in 5e). Returns a set-like object. */
function skillsFromOtherSources(exceptBucket){
  var out = {};
  function add(s){ if (s) out[normSkill(s)] = true; }
  // fixed race skills
  var race = raceByKey(CH.raceKey);
  if (race && race.skillProficiencies && race.skillProficiencies.fixed)
    race.skillProficiencies.fixed.forEach(add);
  // fixed background skills
  var bg = CH.background && bgByName(CH.background);
  if (bg && bg.skillProficiencies && bg.skillProficiencies.fixed)
    bg.skillProficiencies.fixed.forEach(add);
  // chosen skills from the OTHER buckets
  ["race","class","background"].forEach(function(b){
    if (b===exceptBucket) return;
    (CH.skillChoices[b]||[]).forEach(add);
  });
  return out;
}

/* generic "choose N skills from list" control writing to CH.skillChoices[bucket].
   Skills already granted by another source are shown disabled so the player
   can't stack duplicate proficiencies. */
function skillChooser(bucket, choose){
  var field = el("div",{class:"field"});
  var count = choose.count||1;
  var from = (choose.from==="any")?Object.keys(SKILLS):(choose.from||[]).map(normSkill);
  var blocked = skillsFromOtherSources(bucket);
  field.appendChild(el("label",null,"Skill proficiencies \u2014 choose "+count));
  var opts = el("div",{class:"inline-opts"});
  var chosen = CH.skillChoices[bucket]||[];
  // prune any previously-chosen skill that is now blocked (e.g. the user later
  // picked it as a fixed/other-bucket skill), so stale duplicates can't persist.
  var pruned = chosen.filter(function(sk){ return !blocked[sk]; });
  if (pruned.length !== chosen.length){ CH.skillChoices[bucket] = pruned; chosen = pruned; }
  from.forEach(function(sk){
    var isSel = chosen.indexOf(sk)>=0;
    var isBlocked = !!blocked[sk];
    var atCap = chosen.length>=count && !isSel;
    var cls = "opt"+(isSel?" sel":"")+((isBlocked||atCap)?" disabled":"");
    opts.appendChild(el("label",{class:cls, title:isBlocked?"Already gained from another source":""},[
      el("input",{type:"checkbox", checked:isSel?"checked":null,
        disabled:(isBlocked||atCap)?"disabled":null,
        onchange:function(ev){
          var arr = (CH.skillChoices[bucket]||[]).slice();
          if (ev.target.checked){ if (arr.length<count && !blocked[sk]) arr.push(sk); else ev.target.checked=false; }
          else arr = arr.filter(function(x){return x!==sk;});
          CH.skillChoices[bucket]=arr; emit(); renderWizard();
        }}),
      document.createTextNode(sk + (isBlocked?" (already have)":""))
    ]));
  });
  field.appendChild(opts);
  var n = (CH.skillChoices[bucket]||[]).length;
  field.appendChild(el("div",{class:n===count?"ok":"warn"}, n+" / "+count+" selected"));
  return field;
}

/* ---------- STEP: CLASS (+ multiclass + subclass + ASI/feat) ---------- */
function stepClass(p){
  stepHeader(p,"Choose Class(es)",
    "Pick a primary class. Add more for multiclassing (prerequisites enforced). Set each class level; total must equal character level "+totalLevelTarget()+".");

  var grid = el("div",{class:"grid"});
  DATA.classes.forEach(function(c){
    var taken = CH.classes.find(function(x){return x.name===c.name;});
    var card = el("div",{class:"card"+(taken?" selected":""), onclick:function(){
      toggleClass(c);
    }},[
      el("h3",null,c.name),
      el("div",{class:"meta"}, c.source+(c.page?" p."+c.page:"")+" \u00b7 d"+c.hd.faces+" \u00b7 saves "+(c.saves||[]).map(function(s){return ABIL_NAME[s].slice(0,3);}).join("/")),
      el("div",{class:"tags"},[
        c.spellcasting&&c.spellcasting.ability?el("span",{class:"tag"},"Caster ("+ABIL_NAME[c.spellcasting.ability].slice(0,3)+")"):null,
        el("span",{class:"tag"}, c.subclassTitle+" @"+c.subclassLevel)
      ])
    ]);
    grid.appendChild(card);
  });
  p.appendChild(grid);

  if (!CH.classes.length) return;

  // per-class config
  CH.classes.forEach(function(entry, idx){
    var cls = classByName(entry.name); if (!cls) return;
    var panel = el("div",{class:"panel"});
    panel.appendChild(el("h3",null, entry.name+(idx===0?" (primary)":"")));

    // level
    var lvlField = el("div",{class:"field"},[el("label",null,"Class level")]);
    var sel = el("select",{onchange:function(ev){
      entry.level=parseInt(ev.target.value,10); syncLevel(); emit(); renderWizard();
    }});
    for (var i=1;i<=20;i++){
      var o=el("option",{value:i},""+i); if (i===entry.level) o.selected=true; sel.appendChild(o);
    }
    lvlField.appendChild(sel);
    panel.appendChild(lvlField);

    // multiclass prereq warning
    if (idx>0){
      var ok = meetsMulticlassPrereq(cls);
      panel.appendChild(el("div",{class:ok?"ok":"warn"},
        ok?"Multiclass prerequisites met.":"Prerequisite not met: "+mcPrereqText(cls)));
    }

    // subclass at correct level
    if (cls.subclasses && cls.subclasses.length && entry.level>=cls.subclassLevel){
      var sub = el("div",{class:"field"},[el("label",null,cls.subclassTitle+" (level "+cls.subclassLevel+")")]);
      var opts = el("div",{class:"inline-opts"});
      cls.subclasses.forEach(function(s){
        var chosen = entry.subclass===s.name;
        opts.appendChild(el("label",{class:"opt"+(chosen?" sel":"")},[
          el("input",{type:"radio",name:"sub-"+idx,checked:chosen?"checked":null,
            onchange:function(){ entry.subclass=s.name; emit(); renderWizard(); }}),
          document.createTextNode(s.name)
        ]));
      });
      sub.appendChild(opts); panel.appendChild(sub);
    } else if (cls.subclasses && cls.subclasses.length){
      panel.appendChild(el("div",{class:"ref"}, cls.subclassTitle+" chosen at level "+cls.subclassLevel));
    }

    // class skill choices (only for primary class per 5e multiclass rules)
    if (idx===0 && cls.proficiencies && cls.proficiencies.skills)
      panel.appendChild(skillChooser("class", cls.proficiencies.skills));

    // ASI / feat choices at the right levels
    var asiLevels = asiLevelsFor(entry.name, entry.level);
    if (asiLevels.length){
      panel.appendChild(el("label",{class:"muted"},"Ability Score Improvements / Feats"));
      asiLevels.forEach(function(L){ panel.appendChild(asiChooser(entry.name, L)); });
    }

    panel.appendChild(el("div",{class:"ref"}, cls.textRef));
    p.appendChild(panel);
  });

  // total level check
  var tot = totalLevel();
  p.appendChild(el("div",{class:tot===totalLevelTarget()?"ok":"warn"},
    "Total class levels: "+tot+" / character level "+totalLevelTarget()));
}

function totalLevelTarget(){ return CH.level; }
function syncLevel(){
  // keep CH.level in sync with sum of class levels when multiclassing,
  // capped at 20 total across all classes.
  var sum = CH.classes.reduce(function(s,c){return s+c.level;},0);
  if (sum>20){
    // trim the last class's level so the total never exceeds 20
    var over = sum-20;
    var last = CH.classes[CH.classes.length-1];
    last.level = Math.max(1, last.level-over);
    sum = CH.classes.reduce(function(s,c){return s+c.level;},0);
  }
  if (sum>0) CH.level=sum;
  var lvlSel=document.getElementById("level-select");
  if (lvlSel) lvlSel.value=CH.level;
  clampAll();
}
function toggleClass(c){
  var i = CH.classes.findIndex(function(x){return x.name===c.name;});
  if (i>=0){ CH.classes.splice(i,1); }
  else {
    var lvl = CH.classes.length? 1 : CH.level;
    CH.classes.push({name:c.name, source:c.source, level:lvl, subclass:null});
    if (CH.classes.length===1) CH.primaryClass=c.name;
  }
  syncLevel(); emit(); renderWizard();
}
function meetsMulticlassPrereq(cls){
  if (!cls.multiclassing || !cls.multiclassing.requirements) return true;
  var sc = abilityScores();
  var req = cls.multiclassing.requirements;
  function chk(r){ return ABILS.every(function(a){ return !r[a] || sc[a]>=r[a]; }); }
  if (req.or) return req.or.some(chk);
  return chk(req);
}
function mcPrereqText(cls){
  var req = cls.multiclassing && cls.multiclassing.requirements; if (!req) return "";
  function t(r){ return ABILS.filter(function(a){return r[a];}).map(function(a){return ABIL_NAME[a].slice(0,3)+" "+r[a];}).join(" & "); }
  if (req.or) return req.or.map(t).join(" or ");
  return t(req);
}

/* ASI levels: standard 4/8/12/16/19 plus Fighter 6&14, Rogue 10 */
function asiLevelsFor(className, classLevel){
  var base=[4,8,12,16,19];
  if (className==="Fighter") base=[4,6,8,12,14,16,19];
  if (className==="Rogue") base=[4,8,10,12,16,19];
  return base.filter(function(L){ return L<=classLevel; });
}
function asiChooser(className, level){
  var key = className+":"+level;
  var ch = CH.asiChoices[key] || {type:"asi", asi:{}};
  var wrap = el("div",{class:"panel",style:"margin:6px 0;padding:8px"});
  wrap.appendChild(el("div",{class:"muted",style:"font-size:12px"},"Level "+level));
  var row = el("div",{class:"inline-opts"});
  ["asi","feat"].forEach(function(t){
    row.appendChild(el("label",{class:"opt"+(ch.type===t?" sel":"")},[
      el("input",{type:"radio",name:"asi-"+key,checked:ch.type===t?"checked":null,
        onchange:function(){ ch.type=t; if(t==="asi")ch.asi=ch.asi||{}; CH.asiChoices[key]=ch; emit(); renderWizard(); }}),
      document.createTextNode(t==="asi"?"+2 Ability (or +1/+1)":"Feat")
    ]));
  });
  wrap.appendChild(row);
  if (ch.type==="asi"){
    // two +1 pickers
    var picks = el("div",{class:"row"});
    [0,1].forEach(function(n){
      var cur = (ch.pick&&ch.pick[n])||"";
      var s=el("select",{onchange:function(ev){
        ch.pick=ch.pick||["",""]; ch.pick[n]=ev.target.value;
        ch.asi={}; ch.pick.forEach(function(a){ if(a) ch.asi[a]=(ch.asi[a]||0)+1; });
        CH.asiChoices[key]=ch; emit(); renderWizard();
      }});
      s.appendChild(el("option",{value:""},"\u2014"));
      ABILS.forEach(function(a){ var o=el("option",{value:a},ABIL_NAME[a]); if(cur===a)o.selected=true; s.appendChild(o); });
      picks.appendChild(s);
    });
    wrap.appendChild(picks);
  } else {
    var fs = el("select",{onchange:function(ev){ ch.feat=ev.target.value; CH.asiChoices[key]=ch; emit(); renderWizard(); }});
    fs.appendChild(el("option",{value:""},"\u2014 choose feat \u2014"));
    DATA.feats.forEach(function(f){
      var o=el("option",{value:f.name}, f.name+(f.prerequisite&&f.prerequisite.length?" *":""));
      if (ch.feat===f.name) o.selected=true; fs.appendChild(o);
    });
    wrap.appendChild(fs);
    if (ch.feat){
      var ft = DATA.feats.find(function(x){return x.name===ch.feat;});
      if (ft){
        var pr = prereqMet(ft);
        var line = el("div",{class:pr.ok?"ok":"warn"},[
          document.createTextNode((pr.ok?(ft.textRef||""):("Prereq: "+pr.text))+" "),
          infoBtn(function(){ return featInspect(ft); })
        ]);
        wrap.appendChild(line);
      }
    }
  }
  CH.asiChoices[key]=ch;
  return wrap;
}
function prereqMet(feat){
  if (!feat.prerequisite || !feat.prerequisite.length) return {ok:true, text:""};
  var sc = abilityScores(); var texts=[]; var ok=true;
  feat.prerequisite.forEach(function(pr){
    if (pr.ability){
      var sub = pr.ability.map(function(blk){
        return ABILS.filter(function(a){return blk[a];}).map(function(a){
          if (sc[a]<blk[a]) ok=false; return ABIL_NAME[a].slice(0,3)+" "+blk[a];
        }).join("/");
      }); texts.push(sub.join(" or "));
    }
    if (pr.level){ if (totalLevel()<pr.level) ok=false; texts.push("level "+pr.level); }
    if (pr.spellcasting){ if (!hasSpellcasting()) ok=false; texts.push("spellcasting"); }
    if (pr.race){ texts.push(pr.race.join("/")); }
    if (pr.other){ texts.push(pr.other); }
    if (pr.proficiency){ texts.push("proficiency"); }
  });
  return {ok:ok, text:texts.join("; ")};
}

/* ---------- STEP: ABILITY SCORES ---------- */
var STANDARD_ARRAY=[15,14,13,12,10,8];
var PB_COST={8:0,9:1,10:2,11:3,12:4,13:5,14:7,15:9};
function stepAbility(p){
  stepHeader(p,"Ability Scores","Pick a method. Racial bonuses are added automatically.");
  var methods=[["standard","Standard Array"],["pointbuy","Point Buy (27)"],
               ["manual","Manual Entry"],["roll","4d6 drop lowest"]];
  var mrow=el("div",{class:"inline-opts"});
  methods.forEach(function(m){
    mrow.appendChild(el("label",{class:"opt"+(CH.abilityMethod===m[0]?" sel":"")},[
      el("input",{type:"radio",name:"abm",checked:CH.abilityMethod===m[0]?"checked":null,
        onchange:function(){ CH.abilityMethod=m[0]; initAbilityMethod(); emit(); renderWizard(); }}),
      document.createTextNode(m[1])
    ]));
  });
  p.appendChild(mrow);

  var panel=el("div",{class:"panel"});
  if (CH.abilityMethod==="standard") renderAssign(panel, STANDARD_ARRAY, "Assign the standard array values:");
  else if (CH.abilityMethod==="roll") renderRoll(panel);
  else renderDirect(panel);
  p.appendChild(panel);

  // final scores preview
  var sc=abilityScores();
  var prev=el("div",{class:"panel"}); prev.appendChild(el("h3",null,"Final scores (with racial bonuses)"));
  var t=el("table",{class:"abil-table"});
  var hr=el("tr"); ABILS.forEach(function(a){hr.appendChild(el("th",null,ABIL_NAME[a].slice(0,3)));}); t.appendChild(hr);
  var vr=el("tr"); ABILS.forEach(function(a){vr.appendChild(el("td",null,""+sc[a]));}); t.appendChild(vr);
  var mr=el("tr"); ABILS.forEach(function(a){mr.appendChild(el("td",{class:"mod"},sgn(mod(sc[a]))));}); t.appendChild(mr);
  prev.appendChild(t); p.appendChild(prev);
}
function initAbilityMethod(){
  if (CH.abilityMethod==="standard"){ CH.abilityAssign={}; CH.baseAbilities={str:8,dex:8,con:8,int:8,wis:8,cha:8}; }
  if (CH.abilityMethod==="pointbuy"){ CH.baseAbilities={str:8,dex:8,con:8,int:8,wis:8,cha:8}; }
  if (CH.abilityMethod==="roll" && (!CH.rolledPool||!CH.rolledPool.length)) rollPool();
}
function renderAssign(panel, pool, hint){
  panel.appendChild(el("p",{class:"muted",style:"margin-top:0"},hint+" ["+pool.join(", ")+"]"));
  var used={};
  ABILS.forEach(function(a){ var v=CH.abilityAssign[a]; if(v!=null) used[v]=(used[v]||0)+1; });
  ABILS.forEach(function(a){
    var field=el("div",{class:"field",style:"flex-direction:row;align-items:center;gap:10px"});
    field.appendChild(el("label",{style:"width:110px"},ABIL_NAME[a]));
    var sel=el("select",{onchange:function(ev){
      CH.abilityAssign[a]= ev.target.value===""?null:parseInt(ev.target.value,10);
      applyAssign(pool); emit(); renderWizard();
    }});
    sel.appendChild(el("option",{value:""},"\u2014"));
    pool.forEach(function(v,i){
      var o=el("option",{value:i}, v+(used[i]&&CH.abilityAssign[a]!==i?" (used)":""));
      if (CH.abilityAssign[a]===i) o.selected=true;
      if (used[i]&&CH.abilityAssign[a]!==i) o.disabled=true;
      sel.appendChild(o);
    });
    field.appendChild(sel);
    panel.appendChild(field);
  });
}
function applyAssign(pool){
  ABILS.forEach(function(a){
    var idx=CH.abilityAssign[a];
    CH.baseAbilities[a]= (idx!=null&&pool[idx]!=null)?pool[idx]:8;
  });
}
function renderDirect(panel){
  var isPB=CH.abilityMethod==="pointbuy";
  if (isPB){
    var spent=ABILS.reduce(function(s,a){return s+(PB_COST[CH.baseAbilities[a]]||0);},0);
    var cp=el("div",{class:"pb-counter "+(spent>27?"warn":(spent===27?"ok":""))},
      "Points spent: "+spent+" / 27  (scores 8\u201315 before racial bonus)");
    panel.appendChild(cp);
  }
  ABILS.forEach(function(a){
    var field=el("div",{class:"field",style:"flex-direction:row;align-items:center;gap:10px"});
    field.appendChild(el("label",{style:"width:110px"},ABIL_NAME[a]));
    var inp=el("input",{type:"number",min:isPB?8:1,max:isPB?15:20,value:CH.baseAbilities[a],
      onchange:function(ev){
        var v=parseInt(ev.target.value,10)||8;
        if (isPB){ v=Math.max(8,Math.min(15,v)); }
        else { v=Math.max(1,Math.min(20,v)); }
        CH.baseAbilities[a]=v; emit(); renderWizard();
      }});
    field.appendChild(inp);
    panel.appendChild(field);
  });
}
function rollPool(){
  CH.rolledPool=[];
  for (var i=0;i<6;i++){
    var d=[rd6(),rd6(),rd6(),rd6()].sort(function(x,y){return y-x;});
    CH.rolledPool.push(d[0]+d[1]+d[2]);
  }
  CH.abilityAssign={};
}
function rd6(){ return 1+Math.floor(Math.random()*6); }
function renderRoll(panel){
  panel.appendChild(el("button",{class:"btn",onclick:function(){ rollPool(); emit(); renderWizard(); }},"Roll 4d6 (drop lowest) \u00d76"));
  if (CH.rolledPool&&CH.rolledPool.length){
    renderAssign(panel, CH.rolledPool, "Assign your rolled values:");
  }
}

/* ---------- STEP: BACKGROUND ---------- */
function stepBackground(p){
  stepHeader(p,"Choose a Background","Grants skill/tool proficiencies, equipment, and a feature.");
  var grid=el("div",{class:"grid"});
  DATA.backgrounds.forEach(function(b){
    var key=b.name+"|"+b.source;
    var sel=CH.background===key||CH.background===b.name;
    grid.appendChild(el("div",{class:"card"+(sel?" selected":""),onclick:function(){
      CH.background = sel?null:key; CH.skillChoices.background=[]; emit(); renderWizard();
    }},[
      el("h3",null,b.name),
      el("div",{class:"meta"}, b.source+(b.page?" p."+b.page:"")),
      el("div",{class:"tags"},[
        b.skillProficiencies&&b.skillProficiencies.fixed&&b.skillProficiencies.fixed.length?
          el("span",{class:"tag"}, b.skillProficiencies.fixed.join(", ")):null,
        b.feature?el("span",{class:"tag"}, b.feature):null
      ])
    ]));
  });
  p.appendChild(grid);
  var bg=CH.background&&bgByName(CH.background);
  if (bg){
    var panel=el("div",{class:"panel"});
    panel.appendChild(el("h3",null,bg.name));
    if (bg.skillProficiencies&&bg.skillProficiencies.choose)
      panel.appendChild(skillChooser("background", bg.skillProficiencies.choose));
    if (bg.toolProficiencies&&bg.toolProficiencies.fixed&&bg.toolProficiencies.fixed.length)
      panel.appendChild(el("div",{class:"field"},[el("label",null,"Tool proficiencies"),
        el("div",null,bg.toolProficiencies.fixed.map(function(t){return el("span",{class:"badge"},t);}))]));
    if (bg.startingEquipment&&bg.startingEquipment.length)
      panel.appendChild(el("div",{class:"field"},[el("label",null,"Equipment"),
        el("div",{class:"text-block"},bg.startingEquipment.join("; "))]));
    if (bg.text) panel.appendChild(el("div",{class:"text-block",html:mdToHtml(bg.text)}));
    else panel.appendChild(el("div",{class:"ref"},bg.textRef));
    p.appendChild(panel);
  }
}

/* ---------- STEP: EQUIPMENT ---------- */
function stepEquipment(p){
  stepHeader(p,"Starting Equipment","Pick from your class's starting-equipment options, or note gold to buy gear.");
  if (!CH.classes.length){ p.appendChild(el("div",{class:"warn"},"Choose a class first.")); return; }
  CH.classes.forEach(function(entry,idx){
    var cls=classByName(entry.name); if(!cls) return;
    if (idx>0) return; // only primary class gets starting equipment in 5e
    var panel=el("div",{class:"panel"}); panel.appendChild(el("h3",null,entry.name+" starting equipment"));
    var eq=cls.startingEquipment||{choices:[]};
    (eq.choices||[]).forEach(function(group,gi){
      panel.appendChild(el("div",{class:"field"},[el("div",{class:"text-block"},group)]));
    });
    if (eq.goldAlternative)
      panel.appendChild(el("div",{class:"ref"},"Gold alternative: "+eq.goldAlternative));
    p.appendChild(panel);
  });
  // extra gear free text
  var panel2=el("div",{class:"panel"});
  panel2.appendChild(el("h3",null,"Equipment list (editable)"));
  var ta=el("textarea",{rows:6,style:"width:100%",
    onchange:function(ev){ CH.equipment=ev.target.value.split(/\n+/).filter(Boolean); emit(); }},
    );
  ta.value=(CH.equipment||[]).join("\n");
  panel2.appendChild(ta);
  // quick add from item list
  panel2.appendChild(el("p",{class:"muted"},"Browse items below to append to your list."));
  var search=el("input",{type:"text",placeholder:"search items...",style:"width:100%;margin-bottom:8px",
    oninput:function(ev){ renderItemBrowse(list, ev.target.value); }});
  panel2.appendChild(search);
  var list=el("div",{class:"spell-list"}); panel2.appendChild(list);
  renderItemBrowse(list,"");
  p.appendChild(panel2);
}
function renderItemBrowse(container, q){
  container.innerHTML="";
  q=(q||"").toLowerCase();
  DATA.items.filter(function(it){ return !q || it.name.toLowerCase().indexOf(q)>=0; })
    .slice(0,80).forEach(function(it){
    container.appendChild(el("div",{class:"spell-row",onclick:function(){
      CH.equipment=(CH.equipment||[]).concat([it.name]); emit();
      var ta=document.querySelector(".panel textarea"); if(ta) ta.value=CH.equipment.join("\n");
    }},[
      el("span",{class:"sname"},it.name),
      el("span",{class:"smeta"}, [it.type, it.dmg1?it.dmg1+" "+(it.dmgType||""):null, it.ac?"AC "+it.ac:null].filter(Boolean).join(" \u00b7 "))
    ]));
  });
}

/* ========================= STEP: SPELLCASTING ========================= */
var spellFilter={level:"",school:"",q:""};
var _spellMode="cast";     // "cast" (track) | "learn"
var SCHOOLS_FULL=["Abjuration","Conjuration","Divination","Enchantment","Evocation","Illusion","Necromancy","Transmutation"];

function stepSpells(p){
  stepHeader(p,"Spellcasting","Track your slots and spells. Use \u201cLearn spells\u201d to add to your lists.");
  var casters=CH.classes.filter(function(c){ var cl=classByName(c.name); return cl&&cl.spellcasting&&cl.spellcasting.ability; });
  if (!casters.length){ p.appendChild(el("div",{class:"muted"},"No spellcasting class selected.")); return; }

  // mode toggle + rest buttons
  var bar=el("div",{class:"row",style:"justify-content:space-between;margin-bottom:12px"});
  var modes=el("div",{class:"inline-opts"});
  [["cast","Spellcasting"],["learn","Learn spells"]].forEach(function(m){
    modes.appendChild(el("label",{class:"opt"+(_spellMode===m[0]?" sel":"")},[
      el("input",{type:"radio",name:"spmode",checked:_spellMode===m[0]?"checked":null,
        onchange:function(){ _spellMode=m[0]; renderWizard(); }}),
      document.createTextNode(m[1])
    ]));
  });
  bar.appendChild(modes);
  bar.appendChild(restButtons());
  p.appendChild(bar);

  var d=derive();
  if (_spellMode==="learn"){ casters.forEach(function(entry){ p.appendChild(learnPanel(entry, d)); }); }
  else {
    p.appendChild(slotsPanel(d));
    casters.forEach(function(entry){ p.appendChild(castPanel(entry, d)); });
    var rp=racialSpellPanel();
    if (rp) p.appendChild(rp);
  }
}
/* Racial spells shown as their own group (not counted vs class spell caps). */
function racialSpellPanel(){
  var rs=racialSpells();
  if (!rs || (!rs.fixed.length && !rs.choose.length)) return null;
  var panel=el("div",{class:"panel"});
  panel.appendChild(el("h3",null,"Racial Spells"+(rs.ability?(" ("+ABIL_NAME[rs.ability]+")"):"")));
  panel.appendChild(el("div",{class:"muted",style:"font-size:12px;margin-bottom:6px"},
    "Granted by your race \u2014 separate from class spells."));
  // group by level
  var byL={};
  rs.fixed.forEach(function(f){ (byL[f.level||0]=byL[f.level||0]||[]).push(f); });
  Object.keys(byL).map(Number).sort(function(a,b){return a-b;}).forEach(function(L){
    panel.appendChild(el("div",{class:"spell-grp-hd"}, L===0?"Cantrips":(ordinal(L)+" Level")));
    byL[L].forEach(function(f){
      var spell=spellByName(f.name);
      var meta=f.available?(f.recharge==="at-will"?"at will":rechargeLabel(f.recharge)):("unlocks at level "+f.unlock);
      var line=el("div",{class:"spell-row"+(f.available?"":" locked")},[
        el("span",{class:"sname inspectable"}, titleCase(f.name)),
        el("span",{class:"pill"}, meta),
        spell?infoBtn(function(){ return spellInspect(spell); }):null
      ]);
      if (spell){
        var nm=line.querySelector(".inspectable");
        nm.addEventListener("mouseenter",function(){ if(!_popPinned) openPopover(line, spellInspect(spell), false); });
        nm.addEventListener("mouseleave",function(){ if(!_popPinned && _popAnchor===line) closePopover(); });
      }
      panel.appendChild(line);
    });
  });
  rs.choose.forEach(function(c){
    panel.appendChild(el("div",{class:"muted",style:"font-size:12px"},
      "Choose "+c.count+" "+(c.from||"")+(c.available?"":" (unlocks at level "+c.unlock+")")));
  });
  return panel;
}
function titleCase(s){ return String(s).replace(/\b\w/g,function(m){return m.toUpperCase();}); }

function restButtons(){
  var wrap=el("div",{class:"inline-opts"});
  wrap.appendChild(el("button",{class:"btn",onclick:function(){ doShortRest(); }},"Short Rest"));
  wrap.appendChild(el("button",{class:"btn",onclick:function(){ doLongRest(); }},"Long Rest"));
  return wrap;
}

/* --- editable spell-slot grid (spend/restore pips + max override) --- */
function slotsPanel(d){
  var panel=el("div",{class:"panel"});
  panel.appendChild(el("h3",null,"Spell Slots"));
  var hasAny=false;
  for (var L=1; L<=9; L++){
    var max=slotMax(d,L);
    if (max<=0 && (CH.slots.maxOverride[L]==null||CH.slots.maxOverride[L]==="")) continue;
    hasAny=true;
    panel.appendChild(slotRow(d, L, max));
  }
  // Pact Magic as its own pool
  if (d.spellcasting.pact){
    hasAny=true;
    panel.appendChild(pactRow(d));
  }
  if (!hasAny) panel.appendChild(el("div",{class:"muted"},"No spell slots at this level."));
  return panel;
}
function slotRow(d, L, max){
  var row=el("div",{class:"slot-row"});
  row.appendChild(el("span",{class:"slot-lab"}, "Level "+L));
  var pips=el("span",{class:"slot-pips"});
  var used=slotUsed(L);
  for (var i=1;i<=max;i++){
    (function(n){
      var filled = n>used;   // filled = available
      var pip=el("span",{class:"slot-pip"+(filled?" on":""), title:(filled?"spend":"restore")});
      pip.addEventListener("click",function(){
        // clicking pip n: if available, spend down to n-1 used=max-(n-1); simplest: toggle one
        if (n>slotUsed(L)) CH.slots.used[L]=Math.min(max, (CH.slots.used[L]||0)+1);
        else CH.slots.used[L]=Math.max(0, (CH.slots.used[L]||0)-1);
        emit(); renderWizard();
      });
      pips.appendChild(pip);
    })(i);
  }
  row.appendChild(pips);
  row.appendChild(el("span",{class:"slot-count"}, slotRemaining(d,L)+"/"+max));
  // max override
  var ov=el("input",{type:"number",class:"slot-ov",placeholder:"max",title:"override max",
    value:(CH.slots.maxOverride[L]!=null?CH.slots.maxOverride[L]:"")});
  ov.addEventListener("change",function(e){
    CH.slots.maxOverride[L]= e.target.value===""?"":parseInt(e.target.value,10);
    clampAll(); emit(); renderWizard();
  });
  row.appendChild(ov);
  return row;
}
function pactRow(d){
  var row=el("div",{class:"slot-row"});
  var pact=d.spellcasting.pact;
  row.appendChild(el("span",{class:"slot-lab"}, "Pact (L"+pact.l+")"));
  var pips=el("span",{class:"slot-pips"});
  var used=CH.pact.used||0;
  for (var i=1;i<=pact.s;i++){
    (function(n){
      var filled=n>used;
      var pip=el("span",{class:"slot-pip pact"+(filled?" on":"")});
      pip.addEventListener("click",function(){
        if (n>(CH.pact.used||0)) CH.pact.used=Math.min(pact.s,(CH.pact.used||0)+1);
        else CH.pact.used=Math.max(0,(CH.pact.used||0)-1);
        emit(); renderWizard();
      });
      pips.appendChild(pip);
    })(i);
  }
  row.appendChild(pips);
  row.appendChild(el("span",{class:"slot-count"}, pactRemaining(d)+"/"+pact.s));
  row.appendChild(el("span",{class:"muted",style:"font-size:11px"}," restores on short rest"));
  return row;
}

/* --- cast/track panel per class: DC/attack, spells grouped by level, trading --- */
function castPanel(entry, d){
  var cls=classByName(entry.name);
  CH.spells[entry.name]=CH.spells[entry.name]||{cantrips:[],known:[],prepared:[]};
  var st=CH.spells[entry.name];
  var panel=el("div",{class:"panel"});
  var scInfo=d.spellcasting.classes.filter(function(x){return x.name===entry.name;})[0];
  panel.appendChild(el("h3",null, entry.name+" Spellcasting"));
  if (scInfo) panel.appendChild(el("div",{class:"muted",style:"font-size:12px;margin-bottom:8px"},
    "Save DC "+scInfo.dc+" \u00b7 attack "+sgn(scInfo.atk)+" ("+ABIL_NAME[scInfo.ability]+")"));

  // group chosen spells by level, with headers (Cantrips, 1st-9th)
  var chosen = st.cantrips.map(function(n){return {n:n,grp:"known"};})
    .concat((st.prepared||[]).map(function(n){return {n:n,grp:"prepared"};}))
    .concat((st.known||[]).map(function(n){return {n:n,grp:"known"};}));
  // always-prepared: domain/oath etc. (manual adds) + racial spells
  var always = (CH.alwaysPrepared[entry.name]||[]);
  var byLevel={};
  function push(level, name, tag){ (byLevel[level]=byLevel[level]||[]).push({name:name, tag:tag}); }
  chosen.forEach(function(c){ var sp=spellByName(c.n); if(sp) push(sp.level, sp.name, c.grp); });
  always.forEach(function(n){ var sp=spellByName(n); if(sp) push(sp.level, sp.name, "always"); });
  var spellbook=(CH.spellbook[entry.name]||[]);
  spellbook.forEach(function(n){ if(chosen.every(function(c){return c.n!==n;})){ var sp=spellByName(n); if(sp) push(sp.level, sp.name, "book"); } });

  var levels=Object.keys(byLevel).map(Number).sort(function(a,b){return a-b;});
  if (!levels.length) panel.appendChild(el("div",{class:"muted"},"No spells learned yet \u2014 use \u201cLearn spells\u201d."));
  levels.forEach(function(L){
    panel.appendChild(el("div",{class:"spell-grp-hd"}, L===0?"Cantrips":(ordinal(L)+" Level")));
    byLevel[L].sort(function(a,b){return a.name<b.name?-1:1;}).forEach(function(sp){
      panel.appendChild(spellLine(entry, sp, L));
    });
  });

  // slot-trading features
  if (entry.name==="Sorcerer") panel.appendChild(sorceryPanel(entry, cls, d));
  if (cls.spellcasting.arcaneRecovery) panel.appendChild(arcaneRecoveryPanel(entry, d));
  return panel;
}
function ordinal(n){ return n+(["th","st","nd","rd"][(n%100>>3^1&&n%10)||0]||"th"); }
function spellByName(n){ return DATA.spells.find(function(s){return s.name===n;}); }

function spellLine(entry, sp, L){
  var spell=spellByName(sp.name);
  var tagTxt = sp.tag==="always"?"always prepared":(sp.tag==="prepared"?"prepared":(sp.tag==="book"?"spellbook":"known"));
  var line=el("div",{class:"spell-row"+(sp.tag==="always"?" always":"")},[
    el("span",{class:"sname inspectable"}, sp.name),
    el("span",{class:"pill"}, tagTxt),
    spell?el("span",{class:"pill"}, spell.school.slice(0,4)):null,
    infoBtn(function(){ return spell?spellInspect(spell):textInspect(sp.name,"","",""); })
  ]);
  if (spell){
    var nameEl=line.querySelector(".inspectable");
    nameEl.addEventListener("mouseenter",function(){ if(!_popPinned) openPopover(line, spellInspect(spell), false); });
    nameEl.addEventListener("mouseleave",function(){ if(!_popPinned && _popAnchor===line) closePopover(); });
  }
  return line;
}

/* --- learn-spells mode: searchable picker (adds to known/prepared), caps shown,
       always-prepared manual add, and Wizard spellbook copy --- */
function learnPanel(entry, d){
  var cls=classByName(entry.name);
  CH.spells[entry.name]=CH.spells[entry.name]||{cantrips:[],known:[],prepared:[]};
  var st=CH.spells[entry.name];
  var limits=spellLimits(cls, entry.level, d.scores);
  var panel=el("div",{class:"panel"});
  panel.appendChild(el("h3",null, "Learn "+entry.name+" spells"));
  var bucketWord = cls.spellcasting.prepared?"Prepared":"Known";
  panel.appendChild(el("div",{class:"muted",style:"font-size:12px;margin-bottom:8px"},
    "Cantrips "+st.cantrips.length+"/"+limits.cantrips+
    "  \u00b7  "+bucketWord+" "+(cls.spellcasting.prepared?st.prepared.length:st.known.length)+"/"+
    (cls.spellcasting.prepared?limits.prepared:limits.known)+
    "  \u00b7  max spell level "+limits.maxLevel));

  // Wizard: copy from a spellbook (ignores the prepared/known cap)
  if (entry.name==="Wizard"){
    panel.appendChild(el("div",{class:"ref",style:"margin-bottom:6px"},
      "Wizards can copy spells into a spellbook beyond the prepared count. Use \u201ccopy\u201d below."));
  }

  // filters
  var f=el("div",{class:"filters"});
  var lvlSel=el("select",{onchange:function(e){spellFilter.level=e.target.value; fill();}});
  lvlSel.appendChild(el("option",{value:""},"All levels"));
  for (var L=0;L<=9;L++){ var o=el("option",{value:L}, L===0?"Cantrip":"Level "+L); if(String(spellFilter.level)===String(L))o.selected=true; lvlSel.appendChild(o); }
  var schSel=el("select",{onchange:function(e){spellFilter.school=e.target.value; fill();}});
  schSel.appendChild(el("option",{value:""},"All schools"));
  SCHOOLS_FULL.forEach(function(s){ var o=el("option",{value:s},s); if(spellFilter.school===s)o.selected=true; schSel.appendChild(o); });
  var q=el("input",{type:"text",placeholder:"search...",value:spellFilter.q,
    oninput:function(e){spellFilter.q=e.target.value; fill();}});
  f.appendChild(lvlSel); f.appendChild(schSel); f.appendChild(q);
  panel.appendChild(f);

  var listBox=el("div",{class:"spell-list"});
  panel.appendChild(listBox);
  function fill(){ renderLearnList(listBox, entry, cls, limits); }
  fill();
  return panel;
}
function spellLimits(cls, level, sc){
  var prog=cls.spellcasting.progression;
  var cantrips=0;
  if (cls.spellcasting.cantripProgression) cantrips=cls.spellcasting.cantripProgression[Math.min(level,20)-1]||0;
  var maxLevel;
  if (prog==="pact") maxLevel=PACT[Math.min(level,20)].l;
  else { var cl2=casterLevelContribution(prog,level); var slots=slotsForCasterLevel(cl2); maxLevel=slots.length; if(prog==="full")maxLevel=FULL_SLOTS[Math.min(level,20)].length; }
  if (!maxLevel) maxLevel = prog==="full"?FULL_SLOTS[Math.min(level,20)].length:Math.max(1,Math.ceil(level/4));
  var out={cantrips:cantrips, maxLevel:maxLevel, prepared:0, known:0};
  if (cls.spellcasting.prepared){
    var abilMod=mod(sc[cls.spellcasting.ability]);
    var casterLvlForPrep = prog==="1/2"||prog==="half"?Math.floor(level/2):(prog==="1/3"||prog==="third"?Math.floor(level/3):(prog==="artificer"?Math.ceil(level/2):level));
    out.prepared=Math.max(1, abilMod + Math.max(1,casterLvlForPrep));
  } else {
    var sk=cls.spellcasting.spellsKnown;
    out.known = Array.isArray(sk)? (sk[Math.min(level,20)-1]||0) : 0;
    if (!out.known) out.known = level+3;
  }
  return out;
}
function renderLearnList(box, entry, cls, limits){
  box.innerHTML="";
  var st=CH.spells[entry.name];
  var isWizard=entry.name==="Wizard";
  var avail=DATA.spells.filter(function(s){
    if ((s.classes||[]).indexOf(entry.name)<0) return false;
    if (s.level>limits.maxLevel) return false;
    if (spellFilter.level!==""&&String(s.level)!==String(spellFilter.level)) return false;
    if (spellFilter.school&&s.school!==spellFilter.school) return false;
    if (spellFilter.q&&s.name.toLowerCase().indexOf(spellFilter.q.toLowerCase())<0) return false;
    return true;
  });
  avail.forEach(function(s){
    var isCantrip=s.level===0;
    var bucket=isCantrip?"cantrips":(cls.spellcasting.prepared?"prepared":"known");
    var chosen=st[bucket].indexOf(s.name)>=0;
    var inBook=isWizard && (CH.spellbook[entry.name]||[]).indexOf(s.name)>=0;
    var children=[
      el("span",{class:"sname"}, s.name),
      el("span",{class:"pill"}, isCantrip?"Cantrip":"L"+s.level),
      el("span",{class:"pill"}, s.school.slice(0,4)),
      infoBtn(function(){ return spellInspect(s); })
    ];
    // Wizard copy button for leveled spells
    if (isWizard && !isCantrip){
      children.splice(3,0, el("button",{class:"mini-btn"+(inBook?" on":""), title:"copy to spellbook",
        onclick:function(e){ e.stopPropagation(); toggleSpellbook(entry.name, s.name); }}, inBook?"copied":"copy"));
    }
    var row=el("div",{class:"spell-row"+(chosen?" sel":""),onclick:function(){
      toggleSpell(entry.name, cls, limits, s, bucket, chosen);
    }}, children);
    row.addEventListener("mouseenter", function(){ if(!_popPinned) openPopover(row, spellInspect(s), false); });
    row.addEventListener("mouseleave", function(){ if(!_popPinned && _popAnchor===row) closePopover(); });
    box.appendChild(row);
  });
  if (!avail.length) box.appendChild(el("div",{class:"muted"},"No spells match."));
}
function toggleSpell(className, cls, limits, s, bucket, chosen){
  var st=CH.spells[className];
  var arr=st[bucket].slice();
  if (chosen){ arr=arr.filter(function(x){return x!==s.name;}); }
  else {
    var cap = bucket==="cantrips"?limits.cantrips:(bucket==="prepared"?limits.prepared:limits.known);
    if (arr.length>=cap){ return; }
    arr.push(s.name);
  }
  st[bucket]=arr; emit(); renderWizard();
}
function toggleSpellbook(className, name){
  CH.spellbook[className]=CH.spellbook[className]||[];
  var i=CH.spellbook[className].indexOf(name);
  if (i>=0) CH.spellbook[className].splice(i,1);
  else CH.spellbook[className].push(name);
  emit(); renderWizard();
}

/* --- Sorcery Points <-> spell slots (Font of Magic) --- */
function sorceryPanel(entry, cls, d){
  var panel=el("div",{class:"panel",style:"margin-top:8px"});
  panel.appendChild(el("h3",null,"Font of Magic"));
  var rid=entry.name+":sorcery-points";
  var rr=resolveResources(d).filter(function(x){return x.id===rid;})[0];
  var pts = rr?rr.current:0, maxPts=rr?rr.max:0;
  panel.appendChild(el("div",{class:"muted",style:"font-size:12px;margin-bottom:6px"},
    "Sorcery Points: "+pts+"/"+maxPts));
  var conv=cls.spellcasting.sorceryConversion||[];
  // create a slot from points
  var createRow=el("div",{class:"inline-opts"});
  conv.forEach(function(cv){
    if (cv.slotLevel>d.spellcasting.sharedSlots.length) return;
    createRow.appendChild(el("button",{class:"btn",title:"spend "+cv.cost+" SP",
      onclick:function(){
        if (pts<cv.cost) return;
        // creating a slot = reduce its used count (gain one available slot)
        var cur=CH.slots.used[cv.slotLevel]||0;
        if (cur<=0){ /* would exceed max; allow bonus slot via negative? keep simple: only if some used */ return; }
        CH.slots.used[cv.slotLevel]=cur-1;
        resourceSet(rid, pts-cv.cost);
        emit(); renderWizard();
      }}, "L"+cv.slotLevel+" slot ("+cv.cost+" SP)"));
  });
  panel.appendChild(el("div",{class:"field"},[el("label",null,"Create spell slot (restores an expended slot)"), createRow]));
  // convert a slot to points
  var convRow=el("div",{class:"inline-opts"});
  for (var L=1; L<=5; L++){
    (function(L){
      if (slotRemaining(d,L)<=0) return;
      convRow.appendChild(el("button",{class:"btn",
        onclick:function(){
          if (slotRemaining(d,L)<=0) return;
          CH.slots.used[L]=(CH.slots.used[L]||0)+1;
          resourceSet(rid, Math.min(maxPts, pts+L));
          emit(); renderWizard();
        }}, "Expend L"+L+" (+"+L+" SP)"));
    })(L);
  }
  panel.appendChild(el("div",{class:"field"},[el("label",null,"Convert slot to Sorcery Points"), convRow]));
  return panel;
}

/* --- Wizard Arcane Recovery --- */
function arcaneRecoveryPanel(entry, d){
  var panel=el("div",{class:"panel",style:"margin-top:8px"});
  panel.appendChild(el("h3",null,"Arcane Recovery"));
  var wlvl=(CH.classes.filter(function(c){return c.name==="Wizard";})[0]||{}).level||1;
  var budget=Math.ceil(wlvl/2);
  if (CH.rest.arcaneRecoveryUsed){
    panel.appendChild(el("div",{class:"muted"},"Already used (once per day, on a short rest). Resets on a long rest."));
    return panel;
  }
  panel.appendChild(el("div",{class:"muted",style:"font-size:12px;margin-bottom:6px"},
    "On a short rest, recover expended slots totaling "+budget+" slot level(s); none above 5th."));
  // build a small selector: recover up to budget by clicking expended slots
  var remaining={v:budget};
  var row=el("div",{class:"inline-opts"});
  for (var L=1; L<=5; L++){
    (function(L){
      var usedCount=CH.slots.used[L]||0;
      if (usedCount<=0) return;
      row.appendChild(el("button",{class:"btn",
        onclick:function(){
          if (L>remaining.v) return;
          if ((CH.slots.used[L]||0)<=0) return;
          CH.slots.used[L]=(CH.slots.used[L]||0)-1;
          remaining.v-=L;
          if (remaining.v<=0){ CH.rest.arcaneRecoveryUsed=true; }
          emit(); renderWizard();
        }}, "Recover L"+L+" slot"));
    })(L);
  }
  panel.appendChild(row);
  panel.appendChild(el("button",{class:"btn primary",style:"margin-top:6px",
    onclick:function(){ CH.rest.arcaneRecoveryUsed=true; emit(); renderWizard(); }},"Done recovering"));
  return panel;
}

/* ========================= STEP: RESOURCES ========================= */
function stepResources(p){
  stepHeader(p,"Resources","Class resources with spend/restore. Rests refill by recharge type.");
  p.appendChild(restButtons());
  var d=derive();
  var list=resolveResources(d);
  if (!list.length){ p.appendChild(el("div",{class:"muted"},"No trackable class resources.")); return; }
  var panel=el("div",{class:"panel",style:"margin-top:10px"});
  list.forEach(function(r){ panel.appendChild(resourceRow(r)); });
  p.appendChild(panel);
}
function resourceRow(r){
  var row=el("div",{class:"res-row"});
  var head=el("div",{class:"res-head"},[
    el("span",{class:"res-name"}, r.name+(r.die?(" (d"+r.die+")"):"")),
    el("span",{class:"res-meta"}, r.cls+" \u00b7 "+rechargeLabel(r.recharge))
  ]);
  row.appendChild(head);
  var ctrl=el("div",{class:"res-ctrl"});
  // pips if small max, else number
  if (r.max<=8){
    var pips=el("span",{class:"slot-pips"});
    for (var i=1;i<=r.max;i++){
      (function(n){
        var filled=n<=r.current;
        var pip=el("span",{class:"slot-pip"+(filled?" on":"")});
        pip.addEventListener("click",function(){
          resourceSet(r.id, (n<=r.current)? n-1 : n); emit(); renderWizard();
        });
        pips.appendChild(pip);
      })(i);
    }
    ctrl.appendChild(pips);
  }
  ctrl.appendChild(el("button",{class:"mini-btn",onclick:function(){ resourceSet(r.id,Math.max(0,r.current-1)); emit(); renderWizard(); }},"\u2212"));
  ctrl.appendChild(el("span",{class:"res-count"}, r.current+"/"+r.max));
  ctrl.appendChild(el("button",{class:"mini-btn",onclick:function(){ resourceSet(r.id,Math.min(r.max,r.current+1)); emit(); renderWizard(); }},"+"));
  row.appendChild(ctrl);
  if (r.note) row.appendChild(el("div",{class:"res-note muted"}, r.note));
  return row;
}
function rechargeLabel(rc){
  return rc==="short"?"short rest":(rc==="long"?"long rest":(rc==="dawn"?"dawn":"manual"));
}

/* ---------- STEP: DETAILS ---------- */
function stepDetails(p){
  stepHeader(p,"Details & Personality","Name your character and record roleplaying details.");
  var panel=el("div",{class:"panel"});
  function tf(label, key, ph, area){
    var field=el("div",{class:"field"});
    field.appendChild(el("label",null,label));
    var inp = area?el("textarea",{rows:3}):el("input",{type:"text",placeholder:ph||""});
    inp.value = key==="name"?CH.name:(CH.details[key]||"");
    inp.style.width="100%";
    inp.addEventListener("input",function(e){ if(key==="name")CH.name=e.target.value; else CH.details[key]=e.target.value; emit(); });
    field.appendChild(inp); panel.appendChild(field);
  }
  tf("Character name","name","e.g. Lidda Nimblefingers");
  var row=el("div",{class:"row"});
  ["alignment","age","height","weight"].forEach(function(k){
    var f=el("div",{class:"field",style:"flex:1"});
    f.appendChild(el("label",null,k[0].toUpperCase()+k.slice(1)));
    var i=el("input",{type:"text"}); i.value=CH.details[k]||""; i.style.width="100%";
    i.addEventListener("input",function(e){CH.details[k]=e.target.value; emit();});
    f.appendChild(i); row.appendChild(f);
  });
  panel.appendChild(row);
  tf("Personality traits","personality",null,true);
  tf("Ideals","ideals",null,true);
  tf("Bonds","bonds",null,true);
  tf("Flaws","flaws",null,true);
  tf("Appearance","appearance",null,true);
  tf("Backstory","backstory",null,true);
  p.appendChild(panel);
}

/* ---------- STEP: REVIEW ---------- */
function stepReview(p){
  stepHeader(p,"Character Sheet","Formatted like the official 5e sheet. Use Print / PDF for a clean copy, or Save JSON to keep this character.");
  p.appendChild(buildOfficialSheet());
}
function kv(k,v){ return el("div",{class:"kv"},[el("span",{class:"k"},k),el("span",null,String(v))]); }

/* Official-style sheet (page 1 of 5E_CharacterSheet_Fillable.pdf):
   header band + three columns. Used in the Character Sheet step and for print. */
function buildOfficialSheet(){
  var d = derive();
  var root = el("div",{class:"cs-sheet"});

  // ---- header band ----
  var header = el("div",{class:"cs-header"});
  header.appendChild(el("div",{class:"cs-charname"},[
    el("div",{class:"cs-field-val big"}, CH.name||"\u00a0"),
    el("div",{class:"cs-field-lab"},"Character Name")
  ]));
  var hgrid = el("div",{class:"cs-headgrid"});
  function hcell(val,lab){ return el("div",{class:"cs-hcell"},[
    el("div",{class:"cs-field-val"}, val||"\u00a0"),
    el("div",{class:"cs-field-lab"}, lab)]); }
  // editable header cell bound to a getter/setter
  function hedit(getv, setv, lab){
    var inp=el("input",{class:"cs-field-input", value:getv()||""});
    inp.addEventListener("input", function(e){ setv(e.target.value); autosave(); });
    inp.addEventListener("change", function(){ renderSheet(); });
    return el("div",{class:"cs-hcell"},[inp, el("div",{class:"cs-field-lab"}, lab)]);
  }
  hgrid.appendChild(hcell(classSummary(),"Class & Level"));
  hgrid.appendChild(hcell((CH.background?(bgByName(CH.background)||{}).name:""),"Background"));
  hgrid.appendChild(hedit(function(){return CH.sheet.playerName;},
                          function(v){CH.sheet.playerName=v;}, "Player Name"));
  hgrid.appendChild(hcell(raceSummary(),"Race"));
  hgrid.appendChild(hedit(function(){return CH.details.alignment;},
                          function(v){CH.details.alignment=v;}, "Alignment"));
  hgrid.appendChild(hedit(function(){return CH.sheet.xp;},
                          function(v){CH.sheet.xp=v;}, "Experience Points"));
  header.appendChild(hgrid);
  root.appendChild(header);

  // ---- three columns ----
  var cols = el("div",{class:"cs-cols"});

  /* ===== COLUMN 1: abilities / inspiration / prof / saves / skills ===== */
  var c1 = el("div",{class:"cs-col"});
  var abilRail = el("div",{class:"cs-abilrail"});
  ABILS.forEach(function(a){
    var cell=el("div",{class:"cs-abil"},[
      el("div",{class:"cs-abil-lab"}, ABIL_NAME[a]),
      el("div",{class:"cs-abil-mod"}, sgn(d.mods[a])),
      el("div",{class:"cs-abil-score"}, String(d.scores[a]))
    ]);
    makeBreakdown(cell, ABIL_NAME[a],
      [{label:"Score "+d.scores[a], value:d.mods[a]}], sgn(d.mods[a]),
      (CH.bonuses.abilities[a]||0), function(v){ CH.bonuses.abilities[a]=v; });
    abilRail.appendChild(cell);
  });
  c1.appendChild(abilRail);

  var c1b = el("div",{class:"cs-col1b"});
  // inspiration (clickable toggle like death saves) + proficiency bonus
  var inspPill=el("div",{class:"cs-pill cs-clickable"},[
    el("div",{class:"cs-pill-val"}, CH.inspiration?"\u25cf":"\u25cb"),
    el("div",{class:"cs-pill-lab"},"Inspiration")]);
  inspPill.addEventListener("click",function(){ CH.inspiration=!CH.inspiration; emit(); renderSheetStep(); });
  c1b.appendChild(inspPill);
  c1b.appendChild(el("div",{class:"cs-pill"},[
    el("div",{class:"cs-pill-val"}, sgn(d.pb)),
    el("div",{class:"cs-pill-lab"},"Proficiency Bonus")]));

  // saving throws (click a row for breakdown + misc bonus)
  var saves = el("div",{class:"cs-box"});
  var saveList = el("div");
  ABILS.forEach(function(a){
    var line=el("div",{class:"cs-line"},[
      el("span",{class:"cs-dot"+(d.saves[a+"_prof"]?" on":"")}),
      el("span",{class:"cs-line-val"}, sgn(d.saves[a])),
      el("span",{class:"cs-line-lab"}, ABIL_NAME[a])
    ]);
    makeBreakdown(line, ABIL_NAME[a]+" Save", d.saves[a+"_parts"], sgn(d.saves[a]),
      (CH.bonuses.saves[a]||0), function(v){ CH.bonuses.saves[a]=v; });
    saveList.appendChild(line);
  });
  saves.appendChild(saveList);
  saves.appendChild(el("div",{class:"cs-box-lab"},"Saving Throws"));
  c1b.appendChild(saves);

  // skills
  var skills = el("div",{class:"cs-box"});
  var skillList = el("div");
  Object.keys(SKILLS).forEach(function(s){
    var info=d.skills[s];
    var line=el("div",{class:"cs-line"},[
      el("span",{class:"cs-dot"+(info.prof?" on":"")}),
      el("span",{class:"cs-line-val"}, sgn(info.mod)),
      el("span",{class:"cs-line-lab"}, s+" "),
      el("span",{class:"cs-line-sub"}, "("+info.ability+")")
    ]);
    (function(sk,inf){
      makeBreakdown(line, sk, inf.parts, sgn(inf.mod),
        (CH.bonuses.skills[sk]||0), function(v){ CH.bonuses.skills[sk]=v; });
    })(s, info);
    skillList.appendChild(line);
  });
  skills.appendChild(skillList);
  skills.appendChild(el("div",{class:"cs-box-lab"},"Skills"));
  c1b.appendChild(skills);

  // passive perception
  c1b.appendChild(el("div",{class:"cs-pill wide"},[
    el("div",{class:"cs-pill-val"}, String(d.passivePerception)),
    el("div",{class:"cs-pill-lab"},"Passive Wisdom (Perception)")]));
  c1.appendChild(c1b);
  cols.appendChild(c1);

  /* ===== COLUMN 2: AC/init/speed, HP, hit dice, death saves, attacks, equip ===== */
  var c2 = el("div",{class:"cs-col"});
  var trio = el("div",{class:"cs-trio"});
  trio.appendChild(acCell(d));
  trio.appendChild(csBoxVal(sgn(d.initiative),"Initiative"));
  trio.appendChild(csBoxVal(d.speed+" ft","Speed"));
  c2.appendChild(trio);

  // HP: computed max (click for breakdown); editable current & temp
  var hp = el("div",{class:"cs-box cs-hp"});
  var maxLine=el("div",{class:"cs-hp-max cs-clickable"}, "Hit Point Maximum  "+d.hp.total);
  makeBreakdown(maxLine, "Hit Point Maximum", hpParts(d), d.hp.total, null, null);
  hp.appendChild(maxLine);
  var hpRow=el("div",{class:"cs-hp-inputs"});
  hpRow.appendChild(numField("Current", function(){return CH.sheet.currentHP;},
    function(v){CH.sheet.currentHP=v;}, d.hp.total));
  hpRow.appendChild(numField("Temp", function(){return CH.sheet.tempHP;},
    function(v){CH.sheet.tempHP=v;}, ""));
  hp.appendChild(hpRow);
  hp.appendChild(el("div",{class:"cs-box-lab"},"Hit Points"));
  c2.appendChild(hp);

  var hdDeath = el("div",{class:"cs-hd-death"});
  var hdTxt = CH.classes.map(function(c){ var cl=classByName(c.name); return c.level+"d"+(cl?cl.hd.faces:8); }).join(" + ")||"\u2014";
  hdDeath.appendChild(csBoxVal(hdTxt,"Hit Dice"));
  var death = el("div",{class:"cs-box"});
  death.appendChild(deathRow("Successes","succ"));
  death.appendChild(deathRow("Failures","fail"));
  death.appendChild(el("div",{class:"cs-box-lab"},"Death Saves"));
  hdDeath.appendChild(death);
  c2.appendChild(hdDeath);

  // attacks & spellcasting
  var atk = el("div",{class:"cs-box cs-attacks"});
  var atkHead = el("div",{class:"cs-atk-head"},[
    el("span",null,"Name"), el("span",null,"Atk Bonus"), el("span",null,"Damage/Type")]);
  atk.appendChild(atkHead);
  weaponAttacks(d).forEach(function(wk){
    atk.appendChild(el("div",{class:"cs-atk-row"},[
      el("span",null,wk.name), el("span",null,wk.bonus), el("span",null,wk.dmg)]));
  });
  if (!weaponAttacks(d).length) atk.appendChild(el("div",{class:"cs-atk-row muted"},[el("span",null,"\u2014"),el("span",null,""),el("span",null,"")]));
  atk.appendChild(el("div",{class:"cs-box-lab"},"Attacks & Spellcasting"));
  c2.appendChild(atk);

  // equipment (editable textarea; one item per line)
  var equip = el("div",{class:"cs-box cs-equip"});
  var eqTa = el("textarea",{class:"cs-equip-ta", rows:5,
    placeholder:"One item per line\u2026"});
  eqTa.value=(CH.equipment||[]).join("\n");
  eqTa.addEventListener("input", function(e){
    CH.equipment=e.target.value.split(/\n+/).map(function(s){return s.trim();}).filter(Boolean);
    autosave();
  });
  eqTa.addEventListener("change", function(){ renderSheet(); });
  equip.appendChild(eqTa);
  equip.appendChild(el("div",{class:"cs-box-lab"},"Equipment"));
  c2.appendChild(equip);

  // magic items manager
  c2.appendChild(magicItemsPanel());
  cols.appendChild(c2);

  /* ===== COLUMN 3: personality / ideals / bonds / flaws + features & traits ===== */
  var c3 = el("div",{class:"cs-col"});
  c3.appendChild(csEditBox(function(){return CH.details.personality;},
    function(v){CH.details.personality=v;}, "Personality Traits"));
  c3.appendChild(csEditBox(function(){return CH.details.ideals;},
    function(v){CH.details.ideals=v;}, "Ideals"));
  c3.appendChild(csEditBox(function(){return CH.details.bonds;},
    function(v){CH.details.bonds=v;}, "Bonds"));
  c3.appendChild(csEditBox(function(){return CH.details.flaws;},
    function(v){CH.details.flaws=v;}, "Flaws"));

  // features & traits  (spellcasting summary lives only on the Spellcasting
  // page now, not here)
  var feats = el("div",{class:"cs-box cs-features"});
  var fl = el("div");
  // racial traits (merged race+subrace), each inspectable
  var mrSheet = mergedRace();
  if (mrSheet){
    mrSheet.traits.forEach(function(t){
      // Age and Size are flavor, not mechanics: omit from the sheet's
      // Features & Traits (still visible in the Race step detail view).
      if (t.name==="Age" || t.name==="Size") return;
      var row=el("div",{class:"cs-feat"},[
        el("span",{class:"cs-feat-lvl"}, "Race "),
        el("span",{class:"inspectable"}, t.name),
        t.recharge?el("span",{class:"tag",style:"margin-left:4px"}, t.recharge+" rest"):null
      ]);
      var tt=t;
      row.querySelector(".inspectable").addEventListener("mouseenter",function(){ if(!_popPinned) openPopover(row, featureInspect({name:tt.name,text:tt.text,ref:tt.textRef}), false); });
      row.querySelector(".inspectable").addEventListener("mouseleave",function(){ if(!_popPinned && _popAnchor===row) closePopover(); });
      fl.appendChild(row);
    });
  }
  // features by level (inspectable)
  d.features.forEach(function(f){
    var row=el("div",{class:"cs-feat"},[
      el("span",{class:"cs-feat-lvl"}, "L"+f.level+" "),
      el("span",{class:"inspectable"}, f.name),
      el("span",null," "),
      infoBtn(function(){ return featureInspect(f); })
    ]);
    var ff=f; // capture
    row.querySelector(".inspectable").addEventListener("mouseenter",function(){ if(!_popPinned) openPopover(row, featureInspect(ff), false); });
    row.querySelector(".inspectable").addEventListener("mouseleave",function(){ if(!_popPinned && _popAnchor===row) closePopover(); });
    fl.appendChild(row);
  });
  if (!d.features.length && !d.spellcasting.classes.length)
    fl.appendChild(el("div",{class:"muted"},"No features yet \u2014 pick a race and class."));
  feats.appendChild(fl);
  feats.appendChild(el("div",{class:"cs-box-lab"},"Features & Traits"));
  c3.appendChild(feats);
  // editable notes
  c3.appendChild(csEditBox(function(){return CH.sheet.notes;},
    function(v){CH.sheet.notes=v;}, "Notes"));
  cols.appendChild(c3);

  root.appendChild(cols);
  return root;
}
function csBoxVal(val,lab){
  return el("div",{class:"cs-box center"},[
    el("div",{class:"cs-box-big"}, val),
    el("div",{class:"cs-box-lab"}, lab)]);
}
/* editable multiline sheet box bound to getter/setter */
function csEditBox(getv, setv, lab){
  var ta=el("textarea",{class:"cs-textbox-ta", rows:3, placeholder:lab+"\u2026"});
  ta.value=getv()||"";
  ta.addEventListener("input", function(e){ setv(e.target.value); autosave(); });
  return el("div",{class:"cs-box cs-textbox"},[ta, el("div",{class:"cs-box-lab"}, lab)]);
}
/* small labelled number/text field for HP current/temp */
function numField(lab, getv, setv, ph){
  var inp=el("input",{type:"number", class:"cs-num", placeholder:(ph===""?"":String(ph))});
  inp.value=(getv()===""||getv()==null)?"":getv();
  inp.addEventListener("input", function(e){ setv(e.target.value===""?"":parseInt(e.target.value,10)); autosave(); });
  return el("div",{class:"cs-numfield"},[inp, el("div",{class:"cs-num-lab"}, lab)]);
}
/* death-save checkbox row bound to CH.sheet.deathSaves[key] (0..3) */
function deathRow(lab, key){
  var wrap=el("div",{class:"cs-death"});
  wrap.appendChild(el("span",null,lab+" "));
  var dots=el("span",{class:"cs-death-dots"});
  for (var i=1;i<=3;i++){
    (function(n){
      var on=(CH.sheet.deathSaves[key]||0)>=n;
      var box=el("span",{class:"cs-death-box"+(on?" on":"")});
      box.addEventListener("click", function(e){
        e.stopPropagation();
        var cur=CH.sheet.deathSaves[key]||0;
        CH.sheet.deathSaves[key] = (cur===n)?n-1:n;  // click toggles up to n
        emit(); renderSheetStep();
      });
      dots.appendChild(box);
    })(i);
  }
  wrap.appendChild(dots);
  return wrap;
}
/* AC cell: big value + breakdown on click + armor/shield dropdown */
function acCell(d){
  var cell=el("div",{class:"cs-box center cs-ac"});
  var big=el("div",{class:"cs-box-big cs-clickable"}, String(d.ac));
  makeBreakdown(big, "Armor Class", d.acInfo.parts, d.ac, (CH.ac.misc||0),
    function(v){ CH.ac.misc=v; });
  cell.appendChild(big);
  cell.appendChild(el("div",{class:"cs-box-lab"},"Armor Class"));
  // armor dropdown
  var sel=el("select",{class:"cs-ac-sel", onchange:function(e){
    var v=e.target.value;
    if (v==="__custom"){ CH.ac.custom=CH.ac.custom||{base:10,addDex:true,maxDex:99}; CH.ac.armorName=null; }
    else if (v===""){ CH.ac.armorName=null; CH.ac.custom=null; }
    else { CH.ac.armorName=v; CH.ac.custom=null; }
    emit(); renderSheetStep();
  }});
  sel.appendChild(el("option",{value:""},"Unarmored (10+Dex)"));
  var armors=DATA.items.filter(function(it){ return it.armorBlock && it.armorBlock.category!=="shield"; })
    .sort(function(a,b){ return a.armorBlock.base-b.armorBlock.base; });
  ["light","medium","heavy"].forEach(function(cat){
    var grp=el("optgroup",{label:cat[0].toUpperCase()+cat.slice(1)+" armor"});
    armors.filter(function(a){return a.armorBlock.category===cat;}).forEach(function(a){
      var o=el("option",{value:a.name}, a.name+" ("+a.armorBlock.base+(a.armorBlock.addDex?"+Dex":"")+")");
      if (CH.ac.armorName===a.name) o.selected=true;
      grp.appendChild(o);
    });
    sel.appendChild(grp);
  });
  var co=el("option",{value:"__custom"},"Custom\u2026"); if(CH.ac.custom)co.selected=true; sel.appendChild(co);
  cell.appendChild(sel);
  // shield toggle
  var shieldLbl=el("label",{class:"cs-ac-shield"},[
    (function(){ var cb=el("input",{type:"checkbox"}); if(CH.ac.shield)cb.checked=true;
      cb.addEventListener("change",function(e){ CH.ac.shield=e.target.checked; emit(); renderSheetStep(); }); return cb; })(),
    document.createTextNode(" Shield (+2)")
  ]);
  cell.appendChild(shieldLbl);
  // custom armor inputs
  if (CH.ac.custom){
    var cust=el("div",{class:"cs-ac-custom"});
    cust.appendChild(acNum("Base", CH.ac.custom.base, function(v){CH.ac.custom.base=v;}));
    var dexCb=el("label",{class:"cs-ac-shield"},[
      (function(){ var cb=el("input",{type:"checkbox"}); if(CH.ac.custom.addDex)cb.checked=true;
        cb.addEventListener("change",function(e){ CH.ac.custom.addDex=e.target.checked; emit(); renderSheetStep(); }); return cb; })(),
      document.createTextNode(" + Dex")
    ]);
    cust.appendChild(dexCb);
    cust.appendChild(acNum("Max Dex", CH.ac.custom.maxDex, function(v){CH.ac.custom.maxDex=v;}));
    cell.appendChild(cust);
  }
  return cell;
}
function acNum(lab, val, setv){
  var inp=el("input",{type:"number", class:"cs-num", value:(val==null?"":val)});
  inp.addEventListener("input", function(e){ setv(e.target.value===""?0:parseInt(e.target.value,10)); autosave(); });
  inp.addEventListener("change", function(){ renderSheetStep(); });
  inp.addEventListener("click", function(e){ e.stopPropagation(); });
  return el("span",{class:"cs-acnum"},[document.createTextNode(lab+" "), inp]);
}
function hpParts(d){
  var parts=[];
  if (!CH.classes.length) return [{label:"No class", value:0}];
  var conMod=d.mods.con, first=true;
  CH.classes.forEach(function(c){
    var cls=classByName(c.name); if(!cls) return;
    var faces=cls.hd.faces;
    for (var i=1;i<=c.level;i++){
      if (first){ parts.push({label:c.name+" L1 (d"+faces+" max)", value:faces}); first=false; }
      else parts.push({label:c.name+" L"+i+" (avg)", value:Math.floor(faces/2)+1});
    }
  });
  var totLvls=CH.classes.reduce(function(s,c){return s+c.level;},0);
  parts.push({label:"Con mod \u00d7 "+totLvls+" levels", value:conMod*totLvls});
  return parts;
}
/* ---------- Magic items manager (sheet + equipment step) ---------- */
var _miSearch="", _miShowCustom=false;
function attunedCount(){ return (CH.magicItems||[]).filter(function(m){return m.attuned;}).length; }
function magicItemsPanel(){
  var box=el("div",{class:"cs-box cs-magic"});
  box.appendChild(el("div",{class:"cs-magic-head"},[
    el("span",null,"Magic Items"),
    el("span",{class:"cs-attune-count"}, "Attuned "+attunedCount()+"/3")
  ]));
  // current list
  var list=el("div",{class:"cs-magic-list"});
  (CH.magicItems||[]).forEach(function(mi, idx){
    var row=el("div",{class:"cs-magic-row"});
    var name=el("span",{class:"cs-magic-name inspectable"}, mi.name);
    (function(m){
      name.addEventListener("mouseenter",function(){ if(!_popPinned) openPopover(name, miInspect(m), false); });
      name.addEventListener("mouseleave",function(){ if(!_popPinned && _popAnchor===name) closePopover(); });
      name.addEventListener("click",function(e){ e.stopPropagation(); openPopover(name, miInspect(m), true); });
    })(mi);
    row.appendChild(name);
    if (mi.reqAttune){
      var at=el("label",{class:"cs-magic-attune"});
      var cb=el("input",{type:"checkbox"}); if(mi.attuned)cb.checked=true;
      cb.addEventListener("change", function(e){
        if (e.target.checked && attunedCount()>=3){ e.target.checked=false; return; }
        mi.attuned=e.target.checked; emit(); renderSheetStep();
      });
      at.appendChild(cb); at.appendChild(document.createTextNode(" attune"));
      row.appendChild(at);
    }
    var del=el("button",{class:"cs-magic-del", title:"Remove", onclick:function(e){
      e.stopPropagation(); CH.magicItems.splice(idx,1); emit(); renderSheetStep();
    }}, "\u00d7");
    row.appendChild(del);
    list.appendChild(row);
  });
  if (!(CH.magicItems||[]).length) list.appendChild(el("div",{class:"muted"},"No magic items yet."));
  box.appendChild(list);

  // picker: search SRD magic items
  var search=el("input",{type:"text", class:"cs-magic-search", placeholder:"Add magic item (search)\u2026", value:_miSearch});
  var results=el("div",{class:"cs-magic-results"});
  search.addEventListener("input", function(e){ _miSearch=e.target.value; fillMagicResults(results); });
  search.addEventListener("click", function(e){ e.stopPropagation(); });
  box.appendChild(search);
  box.appendChild(results);
  fillMagicResults(results);

  // custom item toggle + form
  var customBtn=el("button",{class:"btn", style:"margin-top:6px", onclick:function(e){
    e.stopPropagation(); _miShowCustom=!_miShowCustom; renderSheetStep();
  }}, _miShowCustom?"\u2212 Hide custom form":"+ Custom magic item");
  box.appendChild(customBtn);
  if (_miShowCustom) box.appendChild(customItemForm());
  box.appendChild(el("div",{class:"cs-box-lab"},"Magic Items"));
  return box;
}
function fillMagicResults(container){
  container.innerHTML="";
  var q=_miSearch.trim().toLowerCase();
  if (!q){ return; }
  var hits=DATA.items.filter(function(it){ return it.isMagic && it.name.toLowerCase().indexOf(q)>=0; }).slice(0,12);
  hits.forEach(function(it){
    container.appendChild(el("div",{class:"cs-magic-hit", onclick:function(e){
      e.stopPropagation(); addMagicItem(it); _miSearch=""; emit(); renderSheetStep();
    }},[
      el("span",{class:"sname"}, it.name),
      el("span",{class:"smeta"}, [it.rarity, it.reqAttune?"attune":null].filter(Boolean).join(" \u00b7 "))
    ]));
  });
  if (!hits.length) container.appendChild(el("div",{class:"muted"},"No matches."));
}
function addMagicItem(it){
  CH.magicItems=CH.magicItems||[];
  CH.magicItems.push({
    id:"mi"+Date.now()+Math.floor(Math.random()*1000),
    name:it.name, ref:it.textRef, custom:false, text:it.text||null,
    reqAttune:!!it.reqAttune, attuned:false,
    acBonus: it.bonusAc?Number(String(it.bonusAc).replace("+","")):null,
    notes:""
  });
}
/* custom magic item form, appended under the panel when toggled */
function customItemForm(){
  var f=el("div",{class:"cs-custom-form"});
  var draft={name:"", text:"", reqAttune:false, acBonus:"", notes:""};
  var nm=el("input",{type:"text", placeholder:"Item name"});
  var tx=el("textarea",{rows:3, placeholder:"Description"});
  var acb=el("input",{type:"number", placeholder:"AC bonus (optional)", style:"width:120px"});
  var att=el("input",{type:"checkbox"});
  [nm,tx,acb].forEach(function(i){ i.addEventListener("click",function(e){e.stopPropagation();}); });
  var add=el("button",{class:"btn primary", onclick:function(e){
    e.stopPropagation();
    if (!nm.value.trim()) return;
    CH.magicItems=CH.magicItems||[];
    CH.magicItems.push({
      id:"mi"+Date.now(), name:nm.value.trim(), ref:null, custom:true,
      text:tx.value.trim()||null, reqAttune:att.checked, attuned:false,
      acBonus: acb.value?Number(acb.value):null, notes:""
    });
    emit(); renderSheetStep();
  }}, "Add custom item");
  f.appendChild(el("div",{class:"field"},[el("label",null,"Name"), nm]));
  f.appendChild(el("div",{class:"field"},[el("label",null,"Description"), tx]));
  f.appendChild(el("div",{class:"row"},[
    el("label",{class:"opt"},[att, document.createTextNode(" Requires attunement")]),
    el("div",{class:"field"},[el("label",null,"AC bonus"), acb])
  ]));
  f.appendChild(add);
  return f;
}
function miInspect(mi){
  var bits=[mi.custom?"custom":null, mi.reqAttune?"attunement":null,
            mi.acBonus?("AC +"+mi.acBonus):null].filter(Boolean);
  return popoverBody(mi.name, bits.join(" \u00b7 "), mi.notes||"", mi.text, mi.ref);
}

/* simple weapon attack rows derived from equipment that matches a weapon item */
function weaponAttacks(d){
  var out=[];
  (CH.equipment||[]).forEach(function(line){
    var item=DATA.items.find(function(it){ return it.name.toLowerCase()===String(line).toLowerCase(); });
    if (item && item.dmg1){
      var finesse=(item.properties||[]).some(function(p){return /finesse/i.test(JSON.stringify(p));});
      var ranged=item.type&&/ranged/.test(item.type);
      var abil=(ranged||finesse)?( (ranged||d.mods.dex>=d.mods.str)?"dex":"str"):"str";
      if (finesse) abil = d.mods.dex>=d.mods.str?"dex":"str";
      var bonus=d.mods[abil]+d.pb;
      out.push({name:item.name, bonus:sgn(bonus), dmg:item.dmg1+" "+(item.dmgType||"")+" "+sgn(d.mods[abil])});
    }
  });
  return out;
}
function classSummary(){
  if (!CH.classes.length) return "No class";
  return CH.classes.map(function(c){ return c.name+(c.subclass?" ("+c.subclass+")":"")+" "+c.level; }).join(" / ");
}
function raceSummary(){
  var r=raceByKey(CH.raceKey); if(!r) return "No race";
  return (CH.subraceName?CH.subraceName+" ":"")+r.name;
}

/* =========================================================================
   7. LIVE CHARACTER SHEET
   ========================================================================= */
function renderSheet(){
  var host=document.getElementById("sheet"); host.innerHTML="";
  var d=derive();
  host.appendChild(el("h2",null, CH.name||"Unnamed Character"));
  host.appendChild(el("div",{class:"sub"}, raceSummary()+" \u00b7 "+classSummary()+
    (CH.background?(" \u00b7 "+(bgByName(CH.background)||{}).name):"")));

  // ability grid
  var g=el("div",{class:"stat-grid"});
  ABILS.forEach(function(a){
    g.appendChild(el("div",{class:"stat"},[
      el("div",{class:"lab"},a.toUpperCase()),
      el("div",{class:"val"},""+d.scores[a]),
      el("div",{class:"sub2"},sgn(d.mods[a]))
    ]));
  });
  host.appendChild(g);

  // combat
  var cg=el("div",{class:"combat-grid"});
  cg.appendChild(combat("AC", d.ac));
  cg.appendChild(combat("HP", d.hp.total));
  cg.appendChild(combat("Init", sgn(d.initiative)));
  cg.appendChild(combat("Speed", d.speed));
  cg.appendChild(combat("Prof", sgn(d.pb)));
  cg.appendChild(combat("Pass.Per", d.passivePerception));
  host.appendChild(cg);

  // saves
  var ss=el("div",{class:"sheet-section"}); ss.appendChild(el("h4",null,"Saving Throws"));
  ABILS.forEach(function(a){
    ss.appendChild(el("div",{class:"skill-line"+(d.saves[a+"_prof"]?" prof":"")},[
      el("span",null,(d.saves[a+"_prof"]?"\u25cf ":"\u25cb ")+ABIL_NAME[a]),
      el("span",null,sgn(d.saves[a]))
    ]));
  });
  host.appendChild(ss);

  // skills
  var sk=el("div",{class:"sheet-section"}); sk.appendChild(el("h4",null,"Skills"));
  Object.keys(SKILLS).forEach(function(s){
    var info=d.skills[s];
    sk.appendChild(el("div",{class:"skill-line"+(info.prof?" prof":"")},[
      el("span",null,(info.prof?"\u25cf ":"\u25cb ")+s+" ("+info.ability+")"),
      el("span",null,sgn(info.mod))
    ]));
  });
  host.appendChild(sk);

  // spell slots
  if (d.spellcasting.classes.length){
    var sp=el("div",{class:"sheet-section"}); sp.appendChild(el("h4",null,"Spellcasting"));
    d.spellcasting.classes.forEach(function(c){
      sp.appendChild(el("div",{class:"kv"},[el("span",{class:"k"},c.name),
        el("span",null,"DC "+c.dc+" \u00b7 atk "+sgn(c.atk))]));
    });
    if (d.spellcasting.sharedSlots.length){
      var slotTxt=d.spellcasting.sharedSlots.map(function(n,i){ return "L"+(i+1)+":"+n; }).join("  ");
      sp.appendChild(el("div",{class:"kv"},[el("span",{class:"k"},"Slots"),el("span",null,slotTxt)]));
    }
    if (d.spellcasting.pact){
      sp.appendChild(el("div",{class:"kv"},[el("span",{class:"k"},"Pact Magic"),
        el("span",null, pactRemaining(d)+"/"+d.spellcasting.pact.s+" @ L"+d.spellcasting.pact.l)]));
    }
    // slot usage summary (remaining/max)
    if (d.spellcasting.sharedSlots.length){
      var used=d.spellcasting.sharedSlots.map(function(m,i){ return "L"+(i+1)+" "+slotRemaining(d,i+1)+"/"+slotMax(d,i+1); }).join("  ");
      sp.appendChild(el("div",{class:"kv"},[el("span",{class:"k"},"Slots left"),el("span",{style:"text-align:right;font-size:11px"},used)]));
    }
    // chosen spells
    for (var cn in CH.spells){
      var st=CH.spells[cn];
      var all=st.cantrips.concat(st.prepared||[]).concat(st.known||[]);
      if (all.length) sp.appendChild(el("div",{class:"kv"},[el("span",{class:"k"},cn),
        el("span",{style:"text-align:right"}, all.join(", "))]));
    }
    host.appendChild(sp);
  }

  // compact resources strip
  var resList=resolveResources(d);
  if (resList.length){
    var rs=el("div",{class:"sheet-section"}); rs.appendChild(el("h4",null,"Resources"));
    resList.forEach(function(r){
      rs.appendChild(el("div",{class:"kv"},[el("span",{class:"k"},r.name+(r.die?(" d"+r.die):"")),
        el("span",null, r.current+"/"+r.max)]));
    });
    host.appendChild(rs);
  }

  // features
  if (d.features.length){
    var ft=el("div",{class:"sheet-section"}); ft.appendChild(el("h4",null,"Features"));
    d.features.forEach(function(f){
      ft.appendChild(el("div",{class:"skill-line"},[el("span",null,"L"+f.level+" "+f.name),el("span",{class:"ref"},"")]));
    });
    host.appendChild(ft);
  }

  // equipment
  if ((CH.equipment||[]).length){
    var eq=el("div",{class:"sheet-section"}); eq.appendChild(el("h4",null,"Equipment"));
    CH.equipment.forEach(function(it){ eq.appendChild(el("div",{class:"skill-line"},[el("span",null,it),el("span",null,"")])); });
    host.appendChild(eq);
  }
}
function combat(lab,val){ return el("div",{class:"combat"},[el("div",{class:"lab"},lab),el("div",{class:"val"},String(val))]); }

/* =========================================================================
   8. BOOTSTRAP + TOP-BAR ACTIONS
   ========================================================================= */
function fillLevelSelect(){
  var sel=document.getElementById("level-select"); sel.innerHTML="";
  for (var i=1;i<=20;i++){ var o=el("option",{value:i},""+i); if(i===CH.level)o.selected=true; sel.appendChild(o); }
  sel.onchange=function(e){
    CH.level=parseInt(e.target.value,10);
    if (CH.classes.length===1) CH.classes[0].level=CH.level;
    else if (CH.classes.length>1){
      // scale primary to keep total == level if possible
      var others=CH.classes.slice(1).reduce(function(s,c){return s+c.level;},0);
      CH.classes[0].level=Math.max(1, CH.level-others);
    }
    clampAll(); emit(); renderWizard();
  };
}
function saveJSON(){
  var blob=new Blob([JSON.stringify(CH,null,2)],{type:"application/json"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=(CH.name||"character").replace(/[^\w.-]+/g,"_")+".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){URL.revokeObjectURL(a.href);},1000);
}
function loadJSON(file){
  var r=new FileReader();
  r.onload=function(){
    try{
      var obj=JSON.parse(r.result);
      CH=merge(blankChar(),obj);
      fillLevelSelect(); emit(); curStep=0; renderWizard();
    }catch(e){ alert("Could not load file: "+e.message); }
  };
  r.readAsText(file);
}
function newChar(){
  if (!confirm("Start a new character? Unsaved changes will be lost.")) return;
  CH=blankChar(); curStep=0; fillLevelSelect(); emit(); renderWizard();
}
function toggleTheme(){
  var root=document.documentElement;
  var t=root.getAttribute("data-theme")==="dark"?"light":"dark";
  root.setAttribute("data-theme",t);
  try{ localStorage.setItem("dnd5e_theme",t); }catch(e){}
}

function init(){
  noteEl=document.getElementById("autosave-note");
  try{ var t=localStorage.getItem("dnd5e_theme"); if(t) document.documentElement.setAttribute("data-theme",t); }catch(e){}
  restore();
  fillLevelSelect();
  subscribe(renderSheet);
  document.getElementById("btn-prev").onclick=function(){go(-1);};
  document.getElementById("btn-next").onclick=function(){go(1);};
  document.getElementById("btn-new").onclick=newChar;
  document.getElementById("btn-save").onclick=saveJSON;
  document.getElementById("btn-print").onclick=function(){window.print();};
  document.getElementById("btn-theme").onclick=toggleTheme;
  document.getElementById("btn-short-rest").onclick=function(){ doShortRest(); };
  document.getElementById("btn-long-rest").onclick=function(){ doLongRest(); };
  document.getElementById("file-load").onchange=function(e){ if(e.target.files[0]) loadJSON(e.target.files[0]); };
  renderWizard();
  renderSheet();
}

if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
else init();

})();
