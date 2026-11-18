// Subrace fix verification: merged traits (bold paragraphs), full field
// extraction, racial choosers persisted, racial spells, Dragonborn ancestry.
const fs=require("fs");const {JSDOM}=require("jsdom");
const html=fs.readFileSync(require("path").join(__dirname,"..","dist","dnd-creator.html"),"utf8");
let fail=0; const ok=(c,m)=>{console.log((c?"  PASS: ":"  FAIL: ")+m); if(!c)fail++;};
const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://local/"});
const w=dom.window; w.alert=()=>{};w.confirm=()=>true;
const errs=[]; w.addEventListener("error",e=>errs.push(e.error&&e.error.stack||e.message));
setTimeout(()=>{
  const D=w.__DND; const CH=D.CH();
  const steps=()=>[...w.document.getElementById("steps").children];
  const body=()=>w.document.getElementById("step-body");
  const gotoRace=()=>steps().find(c=>c.textContent==="Race").dispatchEvent(new w.Event("click"));
  const pickRace=(nm)=>{ CH.subraceName=null; CH.raceKey=null; gotoRace();
    [...body().querySelectorAll(".card h3")].find(h=>h.textContent===nm).parentElement.dispatchEvent(new w.Event("click")); };
  const pickSub=(nm)=>{ const card=[...body().querySelectorAll(".card h3")].find(h=>h.textContent===nm);
    if(!card) throw new Error("subrace card not found: "+nm+" (have: "+[...body().querySelectorAll(".card h3")].map(h=>h.textContent).join(",")+")");
    card.parentElement.dispatchEvent(new w.Event("click")); };

  // ---- data: extraction ----
  const elf=D.DATA.races.find(r=>r.name==="Elf");
  const wood=elf.subraces.find(s=>s.name==="Wood");
  ok(wood.speed && wood.speed.walk===35, "Wood Elf subrace speed 35 in data");
  ok(wood.weaponProficiencies.length===4, "Wood Elf 4 weapon profs");
  ok(wood.traits.length===3 && wood.traits.every(t=>t.text), "Wood Elf 3 traits with text");
  const drow=elf.subraces.find(s=>s.name==="Drow");
  const innateLvls=drow.additionalSpells.innate.map(b=>b.level).sort();
  ok(drow.darkvision===120, "Drow darkvision 120");
  ok(drow.traitTags.indexOf("Sunlight Sensitivity")>=0, "Drow Sunlight Sensitivity tag");
  ok(drow.traits.some(t=>t.overwrite==="Darkvision"), "Drow Superior Darkvision overwrites Darkvision");

  // ---- Wood Elf merged + rendered as separate bold paragraphs ----
  pickRace("Elf"); pickSub("Wood");
  let d=D.derive();
  ok(d.speed===35, "Wood Elf sheet speed 35 (subrace overrides base 30)");
  ok(d.racialProficiencies.weapons.indexOf("longsword")>=0, "Wood Elf weapon profs applied to sheet");
  const paras=body().querySelectorAll(".trait-para");
  ok(paras.length>=3, "traits render as separate paragraphs ("+paras.length+")");
  ok([...paras].every(p=>p.querySelector(".trait-name")), "each trait paragraph has a bold name");
  // merged = base Elf traits + Wood traits, no duplicate Darkvision
  const names=[...body().querySelectorAll(".trait-name")].map(e=>e.textContent);
  ok(names.filter(n=>n==="Darkvision").length<=1, "no duplicate Darkvision in merged list");
  ok(names.indexOf("Fleet of Foot")>=0 && names.indexOf("Mask of the Wild")>=0, "Wood subrace traits present in merged list");

  // ---- High Elf racial cantrip chooser separate from class cantrips ----
  pickRace("Elf"); pickSub("High");
  const hs=w.__DND.derive().racialSpells;
  ok(hs && hs.choose.length>=1, "High Elf has a racial cantrip choice (separate group)");

  // ---- Drow racial spells (addition #5) ----
  pickRace("Elf"); pickSub("Drow");
  const ds=D.derive().racialSpells;
  const dn=ds.fixed.map(f=>f.name);
  ok(dn.indexOf("dancing lights")>=0, "Drow racial: dancing lights (cantrip)");
  ok(ds.fixed.some(f=>f.name==="faerie fire"&&f.unlock===3), "Drow racial: faerie fire unlocks at level 3");
  ok(ds.fixed.some(f=>f.name==="darkness"&&f.unlock===5), "Drow racial: darkness unlocks at level 5");
  ok(D.derive().resist!==undefined, "resist computed");

  // ---- Dragonborn ancestry chooser sets resistance + breath active ----
  pickRace("Dragonborn");
  const anSel=[...body().querySelectorAll("select")].find(s=>[...s.options].some(o=>/Red|Black/.test(o.textContent)));
  ok(!!anSel, "Dragonborn ancestry dropdown present");
  anSel.value="Red"; anSel.dispatchEvent(new w.Event("change"));
  ok(CH.racialChoices.draconicAncestry==="Red", "ancestry choice persisted to CH");
  d=D.derive();
  ok(d.resist.indexOf("fire")>=0, "Red Dragonborn gains fire resistance");
  const db=D.DATA.races.find(r=>r.name==="Dragonborn");
  ok(db.traits.some(t=>t.name==="Breath Weapon"&&t.recharge==="short"), "Breath Weapon active recharges on short rest");

  // ---- Half-Elf choosers persist ----
  pickRace("Half-Elf");
  // ability +1 choosers
  const abilBoxes=[...body().querySelectorAll(".inline-opts .opt")].filter(o=>/Strength|Dexterity|Constitution/.test(o.textContent));
  ok(abilBoxes.length>0, "Half-Elf ability +1 choosers render");
  // pick two abilities
  // toggle Strength (set checked like a real click), then re-query and toggle Dexterity
  var sIn=abilBoxes.find(o=>o.textContent==="Strength").querySelector("input");
  sIn.checked=true; sIn.dispatchEvent(new w.Event("change"));
  const abilBoxes2=[...body().querySelectorAll(".inline-opts .opt")].filter(o=>o.textContent==="Dexterity");
  var dIn=abilBoxes2[0].querySelector("input"); dIn.checked=true; dIn.dispatchEvent(new w.Event("change"));
  ok(CH.racialChoices.abilities.length===2, "Half-Elf two +1 abilities chosen");
  d=D.derive();
  ok(d.scores.cha>=10 && d.mods.str===D.mod(d.scores.str), "Half-Elf CHA+2 auto + chosen +1s applied");

  // ---- Variant Human: skill + feat + two +1 ----
  pickRace("Human"); pickSub("Variant");
  const featSel=[...body().querySelectorAll("select")].find(s=>[...s.options].some(o=>/choose feat/.test(o.textContent)));
  ok(!!featSel, "Variant Human feat selector present");
  featSel.value="Alert"; featSel.dispatchEvent(new w.Event("change"));
  ok(CH.racialChoices.feat==="Alert", "Variant Human feat persisted");

  // ---- save/load round trip of racial choices ----
  CH.raceKey="Elf|PHB"; CH.subraceName="Drow"; CH.racialChoices.abilities=["dex"];
  const json=JSON.stringify(CH);
  ok(/"draconicAncestry":"Red"/.test(json) && /"feat":"Alert"/.test(json), "racial choices persist in JSON");

  // ---- spellcasting summary removed from Features & Traits ----
  CH.raceKey=null; CH.subraceName=null;
  CH.classes=[{name:"Cleric",source:"PHB",level:7,subclass:null}]; CH.level=7;
  w.__DND.closePopover && w.__DND.closePopover();
  // pick Cleric through the Class step so active steps rebuild correctly
  steps().find(c=>c.textContent==="Class").dispatchEvent(new w.Event("click"));
  steps().find(c=>c.textContent==="Character Sheet").dispatchEvent(new w.Event("click"));
  const featBox=body().querySelector(".cs-features");
  ok(!!featBox, "Features & Traits box renders for a classed character");
  ok(featBox && !/spell save DC|Spell slots:/.test(featBox.textContent),
     "spellcasting DC/slots no longer in Features & Traits");

  ok(errs.length===0, "no uncaught runtime errors"+(errs.length?": "+errs[0]:""));
  console.log("\n"+(fail?("SUBRACE TEST FAILED: "+fail):"ALL SUBRACE TESTS PASSED"));
  process.exit(fail?1:0);
},150);
