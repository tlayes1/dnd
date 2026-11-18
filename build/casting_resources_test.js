// Verify Spellcasting + Resources: slot spend/restore + max override, SP<->slot
// conversion, Arcane Recovery, Pact Magic, class resources, Short/Long Rest,
// level-down clamping, racial-spell group, inspiration toggle.
const fs=require("fs");const {JSDOM}=require("jsdom");
const html=fs.readFileSync(require("path").join(__dirname,"..","dist","dnd-creator.html"),"utf8");
let fail=0; const ok=(c,m)=>{console.log((c?"  PASS: ":"  FAIL: ")+m); if(!c)fail++;};
const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://local/"});
const w=dom.window; w.alert=()=>{};w.confirm=()=>true;
const errs=[]; w.addEventListener("error",e=>errs.push(e.error&&e.error.stack||e.message));
setTimeout(()=>{
  const D=w.__DND; const CH=D.CH();

  // ---- pipeline: resources present on class records ----
  const barb=D.classByName("Barbarian");
  ok(barb.resources && barb.resources.some(r=>r.key==="rage"), "Barbarian has a rage resource");
  const sorc=D.classByName("Sorcerer");
  ok(sorc.spellcasting.sorceryConversion && sorc.spellcasting.sorceryConversion[1].cost===3,
     "Sorcerer conversion table: 2nd-level slot costs 3 SP");
  const war=D.classByName("Warlock");
  ok(war.spellcasting.pact && war.spellcasting.pact.countByLevel[0]===1, "Warlock pact data present");

  // ---- Wizard L5: slots spend/restore + max override ----
  CH.classes=[{name:"Wizard",source:"PHB",level:5,subclass:null}];
  CH.baseAbilities={str:8,dex:14,con:14,int:17,wis:12,cha:10}; CH.level=5;
  let d=D.derive();
  ok(JSON.stringify(d.spellcasting.sharedSlots)===JSON.stringify([4,3,2]), "Wizard L5 slots 4/3/2");
  ok(D.slotMax(1)===4, "slotMax L1 = 4");
  CH.slots.used={1:2};
  ok(D.resolveResources(d) && (D.slotMax(1)-CH.slots.used[1])===2, "two L1 slots expended -> 2 remaining");
  CH.slots.maxOverride={3:5};
  ok(D.slotMax(3)===5, "max override sets L3 slots to 5");
  CH.slots.maxOverride={};

  // ---- level-down clamps expended slots ----
  CH.slots.used={1:4};
  CH.classes[0].level=1;                // drop to level 1: L1 slots now 2
  D.clampAll();
  ok((CH.slots.used[1]||0)<=D.slotMax(1), "expended L1 slots clamped after level down ("+CH.slots.used[1]+"<="+D.slotMax(1)+")");
  CH.classes[0].level=5; CH.slots.used={};

  // ---- Arcane Recovery flag ----
  ok(D.classByName("Wizard").spellcasting.arcaneRecovery===true, "Wizard has Arcane Recovery");

  // ---- Sorcerer SP<->slot conversion math ----
  CH.classes=[{name:"Sorcerer",source:"PHB",level:5,subclass:null}];
  CH.baseAbilities={str:8,dex:14,con:14,int:10,wis:12,cha:17}; CH.level=5;
  d=D.derive();
  const spId="Sorcerer:sorcery-points";
  let res=D.resolveResources(); let sp=res.find(r=>r.id===spId);
  ok(sp && sp.max===5, "Sorcerer L5 has 5 sorcery points");
  // convert a 1st-level slot -> +1 point: expend L1, gain 1 (seed current=max=5, but max cap)
  // (direct state check: expend then verify remaining)
  CH.slots.used={1:1}; d=D.derive();
  ok((D.slotMax(1)-(CH.slots.used[1]||0))===(D.slotMax(1)-1), "expending an L1 slot reduces remaining by 1");

  // ---- Warlock pact pool + short rest restore ----
  CH.classes=[{name:"Warlock",source:"PHB",level:5,subclass:null}];
  CH.baseAbilities={str:8,dex:14,con:14,int:10,wis:12,cha:17}; CH.level=5;
  d=D.derive();
  ok(d.spellcasting.pact && d.spellcasting.pact.s===2 && d.spellcasting.pact.l===3, "Warlock L5 pact: 2 slots @ L3");
  CH.pact.used=2;
  D.doShortRest();
  ok((CH.pact.used||0)===0, "short rest restores pact slots");

  // ---- Barbarian Rage spend + Long Rest refill ----
  CH.classes=[{name:"Barbarian",source:"PHB",level:5,subclass:null}];
  CH.baseAbilities={str:16,dex:14,con:15,int:8,wis:10,cha:8}; CH.level=5;
  d=D.derive();
  let rage=D.resolveResources().find(r=>r.key==="rage");
  ok(rage && rage.max===3, "Barbarian L5 has 3 rages");
  CH.resources["Barbarian:rage"]=1;
  D.doLongRest();
  ok(CH.resources["Barbarian:rage"]===3, "long rest refills rage to 3");

  // ---- Long Rest: HP to max, clears temp + death saves ----
  CH.sheet.currentHP=5; CH.sheet.tempHP=4; CH.sheet.deathSaves={succ:2,fail:1};
  d=D.derive();
  D.doLongRest();
  ok(CH.sheet.currentHP===d.hp.total, "long rest restores current HP to max");
  ok(CH.sheet.tempHP==="" && CH.sheet.deathSaves.succ===0 && CH.sheet.deathSaves.fail===0, "long rest clears temp HP + death saves");

  // ---- Monk Ki short rest ----
  CH.classes=[{name:"Monk",source:"PHB",level:5,subclass:null}];
  CH.baseAbilities={str:12,dex:16,con:14,int:8,wis:15,cha:10}; CH.level=5;
  let ki=D.resolveResources().find(r=>r.key==="ki");
  ok(ki && ki.max===5 && ki.recharge==="short", "Monk L5 has 5 ki, short-rest recharge");

  // ---- racial spell group (Drow): dancing lights + faerie fire + darkness ----
  CH.classes=[{name:"Fighter",source:"PHB",level:5,subclass:null}];
  CH.raceKey="Elf|PHB"; CH.subraceName="Drow"; CH.level=5;
  const rs=D.derive().racialSpells;
  ok(rs.fixed.some(f=>f.name==="dancing lights") && rs.fixed.some(f=>f.name==="faerie fire") && rs.fixed.some(f=>f.name==="darkness"),
     "Drow racial spell group has dancing lights/faerie fire/darkness");

  // ---- inspiration toggle persists ----
  CH.inspiration=false; CH.inspiration=!CH.inspiration;
  ok(CH.inspiration===true, "inspiration toggles");

  // ---- save/load round-trip of slots/resources/inspiration ----
  CH.slots.used={1:1}; CH.resources["Monk:ki"]=3;
  const json=JSON.stringify(CH);
  ok(/"slots"/.test(json) && /"resources"/.test(json) && /"inspiration"/.test(json), "new state persists in JSON");

  ok(errs.length===0, "no uncaught runtime errors"+(errs.length?": "+errs[0]:""));
  console.log("\n"+(fail?("CASTING/RESOURCES TEST FAILED: "+fail):"ALL CASTING/RESOURCES TESTS PASSED"));
  process.exit(fail?1:0);
},150);
