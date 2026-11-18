// Verify the expanded race roster: all requested races present, deduped by name
// (prefer MOT for Centaur/Minotaur), ERLW (not 2024 EFA) for Eberron races, key
// mechanics intact, race-only extension keeps non-race content lean, and Age/Size
// are dropped from the sheet's Features & Traits.
const fs=require("fs");const {JSDOM}=require("jsdom");
const html=fs.readFileSync(require("path").join(__dirname,"..","dist","dnd-creator.html"),"utf8");
let fail=0; const ok=(c,m)=>{console.log((c?"  PASS: ":"  FAIL: ")+m); if(!c)fail++;};
const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://local/"});
const w=dom.window; w.alert=()=>{};w.confirm=()=>true;
const errs=[]; w.addEventListener("error",e=>errs.push(e.error&&e.error.stack||e.message));
setTimeout(()=>{
  const D=w.__DND; const CH=D.CH();
  const byName={}; D.DATA.races.forEach(r=>{ (byName[r.name]=byName[r.name]||[]).push(r); });
  const race=n=>byName[n]&&byName[n][0];

  // ---- all requested races present ----
  const want=["Fairy","Harengon","Aarakocra","Genasi","Changeling","Kalashtar",
    "Shifter","Warforged","Centaur","Loxodon","Minotaur","Simic Hybrid","Vedalken",
    "Leonin","Satyr","Tortle","Locathah","Verdan","Owlin","Dhampir","Hexblood",
    "Giff","Hadozee","Autognome","Thri-kreen"];
  want.forEach(n=> ok(!!race(n), "race present: "+n));

  // ---- dedupe by name (exactly one each; MOT wins for Centaur/Minotaur) ----
  ok((byName["Centaur"]||[]).length===1 && race("Centaur").source==="MOT", "one Centaur, from MOT");
  ok((byName["Minotaur"]||[]).length===1 && race("Minotaur").source==="MOT", "one Minotaur, from MOT");
  const dupes=Object.keys(byName).filter(n=>byName[n].length>1);
  ok(dupes.length===0, "no duplicate race names"+(dupes.length?": "+dupes.join(","):""));

  // ---- ERLW (2014), not EFA (2024) ----
  ["Changeling","Kalashtar","Shifter","Warforged"].forEach(n=>
    ok(race(n).source==="ERLW", n+" comes from ERLW (2014)"));

  // ---- key mechanics ----
  ok(race("Aarakocra").speed.fly===50, "Aarakocra fly speed 50");
  ok(race("Fairy").speed.fly===30, "Fairy fly speed 30");
  ok(race("Centaur").traits.length>=5, "Centaur _copy from GGR resolved (has traits)");
  ok(race("Minotaur").traits.length>=5, "Minotaur _copy resolved (has traits)");
  ok((race("Kalashtar").resist||[]).indexOf("psychic")>=0, "Kalashtar psychic resistance");
  ok((race("Warforged").resist||[]).indexOf("poison")>=0, "Warforged poison resistance");
  const genasi=race("Genasi");
  ok(genasi.subraces.map(s=>s.name).sort().join(",")==="Air,Earth,Fire,Water", "Genasi four element subraces");
  const gnome=race("Gnome");
  ok(gnome.subraces.some(s=>/Svirfneblin|Deep/.test(s.name)), "Deep Gnome/Svirfneblin is a Gnome subrace");

  // ---- race-only extension: no new-book feats/spells/items/backgrounds ----
  const NEW=new Set(["WBtW","EEPC","ERLW","GGR","MOT","TTP","LR","AI","SCC","VRGR","AAG"]);
  ["spells","feats","items","backgrounds"].forEach(cat=>
    ok(D.DATA[cat].every(r=>!NEW.has(r.source)), "no "+cat+" from race-extra books"));

  // ---- Age/Size dropped from sheet Features & Traits ----
  CH.raceKey="Tortle|TTP"; CH.subraceName=null; CH.classes=[]; CH.level=3;
  const body2=()=>w.document.getElementById("step-body");
  const steps2=()=>[...w.document.getElementById("steps").children];
  // pick Fighter through the Class step so active steps/chips rebuild
  steps2().find(c=>c.textContent==="Class").dispatchEvent(new w.Event("click"));
  [...body2().querySelectorAll(".card h3")].find(h=>h.textContent==="Fighter").parentElement.dispatchEvent(new w.Event("click"));
  CH.classes[0].level=3; CH.level=3;
  steps2().find(c=>c.textContent==="Character Sheet").dispatchEvent(new w.Event("click"));
  const featBox=body2().querySelector(".cs-features");
  ok(!!featBox, "sheet Features & Traits box renders");
  const featNames=[...(featBox?featBox.querySelectorAll(".inspectable"):[])].map(e=>e.textContent);
  ok(featNames.indexOf("Age")<0 && featNames.indexOf("Size")<0, "Age and Size not in Features & Traits");
  ok(featNames.length>0, "other racial traits still present on sheet");

  ok(errs.length===0, "no uncaught runtime errors"+(errs.length?": "+errs[0]:""));
  console.log("\n"+(fail?("RACES TEST FAILED: "+fail):"ALL RACES TESTS PASSED"));
  process.exit(fail?1:0);
},150);
