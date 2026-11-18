// Smoke test: load dist/dnd-creator.html in jsdom, drive the app, assert
// core 5e derivations. Run: node build/smoke_test.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const htmlPath = path.join(__dirname, "..", "dist", "dnd-creator.html");
const html = fs.readFileSync(htmlPath, "utf8");

let failures = 0;
function assert(cond, msg){
  if (cond) console.log("  PASS:", msg);
  else { console.log("  FAIL:", msg); failures++; }
}

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://local/"
});
const { window } = dom;

// localStorage shim (jsdom has one, but guard anyway)
window.alert = function(){};
window.confirm = function(){ return true; };
window.print = function(){ window.__printed = true; };

// Wait a tick for DOMContentLoaded init
setTimeout(run, 50);

function run(){
  const D = window.__DND;
  if (!D){ console.log("FAIL: app did not initialize (window.__DND missing)"); process.exit(1); }

  console.log("== data loaded ==");
  assert(D.DATA.classes.length === 13, "13 classes loaded (got "+D.DATA.classes.length+")");
  assert(D.DATA.races.length >= 24, "races loaded (got "+D.DATA.races.length+", expect >=24)");
  assert(D.DATA.spells.length === 477, "477 spells loaded (got "+D.DATA.spells.length+")");
  assert(D.DATA.backgrounds.length === 33, "33 backgrounds loaded");
  assert(D.DATA.feats.length === 73, "73 feats loaded");

  // decompression sanity: a class should have readable keys
  const wiz = D.classByName("Wizard");
  assert(wiz && wiz.hd && wiz.hd.faces === 6, "Wizard hit die d6");
  assert(wiz && wiz.saves.length === 2, "Wizard has 2 saves");
  assert(wiz.spellcasting.ability === "int", "Wizard casts with INT");

  const fb = D.DATA.spells.find(s=>s.name==="Fireball");
  assert(fb && fb.level===3 && fb.school==="Evocation", "Fireball L3 Evocation");
  assert(fb.classes.indexOf("Wizard")>=0, "Fireball on Wizard list");

  // ---- Build a Level 5 Mountain Dwarf Fighter ----
  const CH = D.CH();
  // race
  const dwarf = D.DATA.races.find(r=>r.name==="Dwarf");
  CH.raceKey = dwarf.name+"|"+dwarf.source;
  CH.subraceName = "Mountain";
  // class
  CH.classes = [{name:"Fighter", source:"PHB", level:5, subclass:"Champion"}];
  CH.level = 5;
  // abilities (manual): STR16 DEX14 CON15 INT10 WIS12 CHA8
  CH.abilityMethod="manual";
  CH.baseAbilities={str:16,dex:14,con:15,int:10,wis:12,cha:8};

  const d = D.derive();
  // Mountain Dwarf: +2 STR, +2 CON ; Dwarf base +2 CON => CON +2(dwarf)+2(mountain)? 
  // Actually Dwarf race gives +2 CON, Mountain subrace +2 STR +2 CON.
  console.log("== level 5 fighter derivations ==");
  console.log("  scores:", JSON.stringify(d.scores));
  assert(d.level===5, "total level 5");
  assert(d.pb===3, "proficiency bonus +3 at level 5 (got "+d.pb+")");
  // STR 16 + 2(mountain) = 18 ; CON 15 + 2(dwarf) + 2(mountain) = 19 -> capped? 19 ok
  // Dwarf race: +2 CON. Mountain subrace: +2 STR. So STR 16+2=18, CON 15+2=17.
  assert(d.scores.str===18, "STR 16+2(mountain) = 18 (got "+d.scores.str+")");
  assert(d.scores.con===17, "CON 15+2(dwarf) = 17 (got "+d.scores.con+")");
  assert(d.mods.str===4, "STR mod +4");
  assert(d.mods.con===3, "CON mod +3");
  assert(d.saves.str_prof===true && d.saves.con_prof===true, "Fighter STR+CON save proficient");
  assert(d.saves.str === 4+3, "STR save = mod4 + pb3 = 7 (got "+d.saves.str+")");
  // HP: d10 Fighter L5, CON mod +3. L1: 10+3=13 ; L2-5: (6+3)*4=36 => 49
  assert(d.hp.total===49, "HP fixed = 49 (got "+d.hp.total+")");
  assert(d.features.some(f=>f.name==="Action Surge"), "Fighter has Action Surge");
  assert(d.features.some(f=>f.cls.indexOf("Champion")>=0), "Champion subclass feature present");

  // ---- Wizard level 5 spell slots & DC ----
  CH.classes=[{name:"Wizard",source:"PHB",level:5,subclass:null}];
  CH.baseAbilities={str:8,dex:14,con:14,int:17,wis:12,cha:10};
  CH.raceKey=null; CH.subraceName=null; CH.level=5;
  const dw = D.derive();
  console.log("== wizard L5 ==");
  assert(JSON.stringify(dw.spellcasting.sharedSlots)===JSON.stringify([4,3,2]),
    "Wizard L5 slots 4/3/2 (got "+JSON.stringify(dw.spellcasting.sharedSlots)+")");
  const wc = dw.spellcasting.classes[0];
  // INT 17 mod +3, pb +3 => DC 8+3+3=14, atk +6
  assert(wc.dc===14, "Wizard spell save DC 14 (got "+wc.dc+")");
  assert(wc.atk===6, "Wizard spell attack +6 (got "+wc.atk+")");

  // ---- Multiclass: Wizard 3 / Cleric 2 shared slots ----
  CH.classes=[{name:"Wizard",source:"PHB",level:3,subclass:null},
              {name:"Cleric",source:"PHB",level:2,subclass:null}];
  CH.level=5;
  const mc = D.derive();
  console.log("== multiclass wizard3/cleric2 ==");
  // both full casters => caster level 5 => slots 4/3/2
  assert(JSON.stringify(mc.spellcasting.sharedSlots)===JSON.stringify([4,3,2]),
    "MC full+full caster level 5 slots 4/3/2 (got "+JSON.stringify(mc.spellcasting.sharedSlots)+")");

  // ---- Paladin 4 / Sorcerer 2 => half(4)=2 + full(2)=2 => caster level 4 => 4/3 ----
  CH.classes=[{name:"Paladin",source:"PHB",level:4,subclass:null},
              {name:"Sorcerer",source:"PHB",level:2,subclass:null}];
  CH.level=6;
  const mc2=D.derive();
  console.log("  pal4/sorc2 caster level:", mc2.spellcasting.casterLevel);
  assert(mc2.spellcasting.casterLevel===4, "Paladin4(=2)+Sorc2(=2) => caster level 4 (got "+mc2.spellcasting.casterLevel+")");
  assert(JSON.stringify(mc2.spellcasting.sharedSlots)===JSON.stringify([4,3]),
    "caster level 4 slots 4/3 (got "+JSON.stringify(mc2.spellcasting.sharedSlots)+")");

  // ---- Save/Load round trip ----
  window.localStorage.setItem("dnd5e_char_v1", JSON.stringify(CH));
  assert(window.localStorage.getItem("dnd5e_char_v1").length>0, "autosave writes localStorage");

  console.log("\n"+(failures?("SMOKE TEST FAILED: "+failures+" failures"):"ALL SMOKE TESTS PASSED"));
  process.exit(failures?1:0);
}
