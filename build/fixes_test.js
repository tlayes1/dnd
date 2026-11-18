// Verify the four fixes: (1) spell selection, (2) skill no-stacking,
// (3) step renamed to Character Sheet, (4) official-style sheet renders.
const fs=require("fs");const {JSDOM}=require("jsdom");
const html=fs.readFileSync(require("path").join(__dirname,"..","dist","dnd-creator.html"),"utf8");
let fail=0; const ok=(c,m)=>{console.log((c?"  PASS: ":"  FAIL: ")+m); if(!c)fail++;};
const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://local/"});
const w=dom.window; w.alert=()=>{};w.confirm=()=>true;w.print=()=>{};
const errs=[]; w.addEventListener("error",e=>errs.push(e.error&&e.error.stack||e.message));
setTimeout(()=>{
  const D=w.__DND; const CH=D.CH();
  const steps=()=>[...w.document.getElementById("steps").children];
  const body=()=>w.document.getElementById("step-body");

  // ---- (1) spell selection ----
  steps().find(c=>c.textContent==="Class").dispatchEvent(new w.Event("click"));
  [...body().querySelectorAll(".card h3")].find(h=>h.textContent==="Wizard").parentElement.dispatchEvent(new w.Event("click"));
  CH.classes[0].level=5; CH.level=5; CH.baseAbilities={str:8,dex:14,con:14,int:17,wis:12,cha:10};
  steps().find(c=>c.textContent==="Spellcasting").dispatchEvent(new w.Event("click"));
  // switch to "Learn spells" mode to pick spells
  var learnRadio=[...body().querySelectorAll(".inline-opts .opt")].find(o=>/Learn spells/.test(o.textContent));
  if (learnRadio){ var ri=learnRadio.querySelector("input"); ri.checked=true; ri.dispatchEvent(new w.Event("change")); }
  let rows=body().querySelectorAll(".spell-row");
  ok(rows.length>0, "spell rows render ("+rows.length+")");
  const cantrip=[...rows].find(r=>/Cantrip/.test(r.textContent));
  const leveled=[...rows].find(r=>!/Cantrip/.test(r.textContent));
  ok(!!cantrip && !!leveled, "found a cantrip row and a leveled-spell row");
  cantrip.dispatchEvent(new w.Event("click"));
  leveled.dispatchEvent(new w.Event("click"));
  ok(CH.spells.Wizard.cantrips.length===1, "clicking a cantrip selects it");
  ok(CH.spells.Wizard.prepared.length===1, "clicking a leveled spell selects it (prepared)");
  ok(body().querySelectorAll(".spell-row.sel").length===2, "two rows show selected state");
  // no spell lacks a classes array (would crash the list)
  ok(D.DATA.spells.every(s=>Array.isArray(s.classes)), "every spell has a classes array");

  // ---- (2) skill no-stacking ----
  // reset to a clean char
  const CH2=D.CH();
  // Rogue gives 4 skills; Criminal background gives Deception+Stealth fixed.
  CH2.classes=[{name:"Rogue",source:"PHB",level:1,subclass:null}];
  CH2.level=1;
  CH2.background="Criminal|PHB";
  CH2.skillChoices={race:[],class:[],background:[]};
  steps().find(c=>c.textContent==="Class").dispatchEvent(new w.Event("click"));
  // find the class skill chooser options
  let classOpts=[...body().querySelectorAll(".inline-opts .opt")].filter(o=>/Deception|Stealth|Acrobatics|Perception/.test(o.textContent));
  // Deception & Stealth come from Criminal (fixed) -> should be disabled in class chooser
  const decep=classOpts.find(o=>/Deception/.test(o.textContent));
  const stealth=classOpts.find(o=>/Stealth/.test(o.textContent));
  ok(decep && decep.classList.contains("disabled"), "Deception (from background) is blocked in class chooser");
  ok(stealth && stealth.classList.contains("disabled"), "Stealth (from background) is blocked in class chooser");
  // derived skills should never double-count: pick Perception in class, ensure single proficiency
  CH2.skillChoices.class=["Perception"];
  const d2=D.derive();
  ok(d2.skills["Perception"].prof===true, "Perception proficient once");
  // choosing the same skill twice is impossible; collectSkillProfs dedupes:
  CH2.skillChoices.class=["Perception"]; CH2.skillChoices.race=["Perception"];
  const d3=D.derive();
  // proficiency bonus added once (mod = wisMod + pb), not twice
  const wisMod=d3.mods.wis, pb=d3.pb;
  ok(d3.skills["Perception"].mod===wisMod+pb, "duplicate Perception not stacked (mod="+d3.skills["Perception"].mod+", expected "+(wisMod+pb)+")");

  // ---- (3) step renamed ----
  ok(steps().some(c=>c.textContent==="Character Sheet"), "step renamed to 'Character Sheet'");
  ok(!steps().some(c=>c.textContent==="Review"), "'Review' label gone");

  // ---- (4) official sheet renders ----
  steps().find(c=>c.textContent==="Character Sheet").dispatchEvent(new w.Event("click"));
  const sheet=body().querySelector(".cs-sheet");
  ok(!!sheet, "official .cs-sheet renders");
  ok(sheet.querySelectorAll(".cs-abil").length===6, "six ability boxes on sheet");
  ok(!!sheet.querySelector(".cs-header"), "header band present");
  ok(sheet.querySelectorAll(".cs-box-lab").length>=6, "labelled boxes (saves/skills/HP/etc.)");
  const labels=[...sheet.querySelectorAll(".cs-box-lab, .cs-pill-lab, .cs-field-lab")].map(e=>e.textContent);
  ["Saving Throws","Skills","Features & Traits","Proficiency Bonus","Passive Wisdom (Perception)","Character Name"].forEach(L=>{
    ok(labels.indexOf(L)>=0, "sheet has '"+L+"' section");
  });

  ok(errs.length===0, "no uncaught runtime errors"+(errs.length?": "+errs[0]:""));
  console.log("\n"+(fail?("FIXES TEST FAILED: "+fail):"ALL FIXES VERIFIED"));
  process.exit(fail?1:0);
},120);
