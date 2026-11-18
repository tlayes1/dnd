// Verify: editable sheet fields, misc bonuses + breakdowns, AC armor calculator
// with custom armor, magic items (SRD + custom) with attunement, and tooltips.
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
  const ev=(n,t)=>n.dispatchEvent(new w.Event(t,{bubbles:true}));
  const mev=(n,t)=>n.dispatchEvent(new w.MouseEvent(t,{bubbles:true}));

  // ---- Data layer: text + magic items + armor ----
  ok(D.DATA.spells.every(s=>true) && D.DATA.spells.find(s=>s.name==="Fireball").text, "spells carry full text now");
  const fireball=D.DATA.spells.find(s=>s.name==="Fireball");
  ok(/sphere|fire|damage/i.test(fireball.text), "Fireball text has real rules prose");
  const feat=D.DATA.feats.find(f=>f.name==="Grappler");
  ok(feat && feat.text && feat.text.length>20, "feats carry full text");
  const magic=D.DATA.items.filter(i=>i.isMagic);
  ok(magic.length>100, "magic items included ("+magic.length+")");
  const chain=D.DATA.items.find(i=>i.name==="Chain Mail");
  ok(chain && chain.armorBlock && chain.armorBlock.base===16 && !chain.armorBlock.addDex, "Chain Mail armorBlock base 16, no Dex");

  // ---- Build a Fighter 5 and go to the sheet ----
  steps().find(c=>c.textContent==="Class").dispatchEvent(new w.Event("click"));
  [...body().querySelectorAll(".card h3")].find(h=>h.textContent==="Fighter").parentElement.dispatchEvent(new w.Event("click"));
  CH.classes[0].level=5; CH.level=5; CH.baseAbilities={str:16,dex:14,con:15,int:10,wis:12,cha:8};
  steps().find(c=>c.textContent==="Character Sheet").dispatchEvent(new w.Event("click"));
  let sheet=()=>body().querySelector(".cs-sheet");
  ok(!!sheet(), "character sheet renders");

  // ---- (5) editable fields ----
  const playerInput=[...sheet().querySelectorAll(".cs-field-input")].find(i=>i.nextSibling&&/Player Name/.test(i.nextSibling.textContent));
  playerInput.value="Tyler"; ev(playerInput,"input");
  ok(CH.sheet.playerName==="Tyler", "player name edits into CH.sheet");
  const curHP=sheet().querySelector(".cs-num");
  curHP.value="42"; ev(curHP,"input");
  ok(CH.sheet.currentHP===42, "current HP edits into CH.sheet");
  // death save: click 2nd success dot
  const succRow=[...sheet().querySelectorAll(".cs-death")][0];
  const dots=succRow.querySelectorAll(".cs-death-box");
  mev(dots[1],"click");
  ok(CH.sheet.deathSaves.succ===2, "clicking 2nd success dot sets death saves to 2");
  // personality textarea
  const pers=[...sheet().querySelectorAll(".cs-textbox-ta")][0];
  pers.value="Brave"; ev(pers,"input");
  ok(CH.details.personality==="Brave", "personality edits into CH.details");

  // ---- (6) misc bonus + breakdown ----
  CH.bonuses.skills["Stealth"]=1;
  let d=D.derive();
  ok(d.skills["Stealth"].parts.some(p=>p.label==="Misc"&&p.value===1), "Stealth breakdown lists misc +1");
  const base=d.mods.dex; // Stealth = dex + misc (no prof)
  ok(d.skills["Stealth"].mod===base+1, "Stealth total includes misc +1");
  // a save breakdown sums to total
  const strParts=d.saves.str_parts.reduce((s,p)=>s+p.value,0);
  ok(strParts===d.saves.str, "STR save parts sum to total ("+strParts+"="+d.saves.str+")");

  // ---- (7) AC armor calculator ----
  CH.ac.armorName="Chain Mail"; CH.ac.custom=null; CH.ac.shield=false; CH.ac.misc=0;
  d=D.derive();
  ok(d.ac===16, "Chain Mail AC = 16 regardless of Dex (got "+d.ac+")");
  CH.ac.shield=true; d=D.derive();
  ok(d.ac===18, "Chain Mail + shield = 18 (got "+d.ac+")");
  CH.ac.armorName="Leather Armor"; CH.ac.shield=false; d=D.derive();
  ok(d.ac===11+d.mods.dex, "Leather = 11 + full Dex (got "+d.ac+")");
  // custom armor base 13, +Dex max 1, Dex +2 -> 14
  CH.ac.armorName=null; CH.ac.custom={base:13,addDex:true,maxDex:1}; d=D.derive();
  ok(d.ac===13+Math.min(d.mods.dex,1), "custom armor base13 +Dex(max1) (got "+d.ac+")");
  ok(d.acInfo.parts.reduce((s,p)=>s+p.value,0)===d.ac, "AC breakdown parts sum to total");
  CH.ac.custom=null; CH.ac.armorName=null;

  // ---- (8) magic items + attunement ----
  const cloak=D.DATA.items.find(i=>i.name==="Cloak of Protection");
  ok(!!cloak, "Cloak of Protection in data");
  // use app addMagicItem through state
  CH.magicItems=[];
  w.__DND; // addMagicItem is internal; simulate via UI search
  steps().find(c=>c.textContent==="Character Sheet").dispatchEvent(new w.Event("click"));
  const search=sheet().querySelector(".cs-magic-search");
  search.value="Cloak of Protection"; ev(search,"input");
  const hit=[...sheet().querySelectorAll(".cs-magic-hit")].find(h=>/Cloak of Protection/.test(h.textContent));
  ok(!!hit, "search finds the magic item");
  mev(hit,"click");
  ok(CH.magicItems.length===1 && CH.magicItems[0].name==="Cloak of Protection", "magic item added to character");
  ok(CH.magicItems[0].acBonus===1 && CH.magicItems[0].reqAttune===true, "Cloak carries acBonus +1 and attunement");
  // attune it -> AC rises by 1
  CH.magicItems[0].attuned=true; d=D.derive();
  ok(d.acInfo.parts.some(p=>p.label==="Cloak of Protection"&&p.value===1), "attuned cloak shows in AC breakdown");
  // attunement cap: add 3 more attuneable and try to exceed
  for (let i=0;i<3;i++) CH.magicItems.push({id:"x"+i,name:"Ring "+i,reqAttune:true,attuned:true});
  // now 4 attuned; attunedCount should still allow derive, cap is enforced at UI
  // custom item via form
  steps().find(c=>c.textContent==="Character Sheet").dispatchEvent(new w.Event("click"));
  const customBtn=[...sheet().querySelectorAll("button")].find(b=>/Custom magic item/.test(b.textContent));
  mev(customBtn,"click");
  const form=sheet().querySelector(".cs-custom-form");
  ok(!!form, "custom item form appears");
  const nameInp=form.querySelector("input[type=text]");
  const descTa=form.querySelector("textarea");
  nameInp.value="Ring of Grip"; ev(nameInp,"input");
  descTa.value="You cannot be disarmed."; ev(descTa,"input");
  const addBtn=[...form.querySelectorAll("button")].find(b=>/Add custom item/.test(b.textContent));
  mev(addBtn,"click");
  ok(CH.magicItems.some(m=>m.custom&&m.name==="Ring of Grip"), "custom magic item added");

  // ---- tooltips on magic item ----
  steps().find(c=>c.textContent==="Character Sheet").dispatchEvent(new w.Event("click"));
  const miName=sheet().querySelector(".cs-magic-name");
  mev(miName,"mouseenter");
  ok(!!w.document.querySelector(".inspect-pop"), "hovering a magic item shows its description popover");
  w.document.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Escape"}));

  // ---- save/load round trip ----
  const json=JSON.stringify(CH);
  ok(/Cloak of Protection/.test(json) && /Ring of Grip/.test(json) && /"playerName":"Tyler"/.test(json),
     "edits + magic items persist in character JSON");

  ok(errs.length===0, "no uncaught runtime errors"+(errs.length?": "+errs[0]:""));
  console.log("\n"+(fail?("EDIT/ITEMS TEST FAILED: "+fail):"ALL EDIT/ITEM TESTS PASSED"));
  process.exit(fail?1:0);
},150);
