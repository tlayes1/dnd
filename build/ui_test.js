// UI render test: ensure each wizard step renders into the DOM without throwing,
// the live sheet updates, and interactive flows (select race/class) work.
const fs=require("fs"), path=require("path");
const {JSDOM}=require("jsdom");
const html=fs.readFileSync(path.join(__dirname,"..","dist","dnd-creator.html"),"utf8");
let fail=0; const ok=(c,m)=>{console.log((c?"  PASS: ":"  FAIL: ")+m); if(!c)fail++;};
const errors=[];
const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://local/"});
const w=dom.window;
w.alert=()=>{}; w.confirm=()=>true; w.print=()=>{};
w.addEventListener("error",e=>errors.push(e.error&&e.error.stack||e.message));
setTimeout(()=>{
  const body=w.document.getElementById("step-body");
  const steps=w.document.getElementById("steps");
  const sheet=w.document.getElementById("sheet");
  ok(steps.children.length>=6, "step nav rendered ("+steps.children.length+" steps)");
  ok(body.querySelector(".grid")!==null, "race step shows a card grid");
  ok(sheet.querySelector(".stat-grid")!==null, "live sheet shows ability grid");

  // click Elf race card
  const cards=[...body.querySelectorAll(".card h3")];
  const elf=cards.find(h=>h.textContent==="Elf");
  ok(!!elf, "Elf card present");
  elf.parentElement.dispatchEvent(new w.Event("click"));
  ok(body.querySelector(".panel")!==null, "selecting Elf reveals subrace/traits panel");

  // navigate through every active step, ensure no throw and body populates
  const nav=w.document.getElementById("btn-next");
  let rendered=0;
  for (let i=0;i<8;i++){
    const title=body.querySelector(".step-title");
    if (title) rendered++;
    nav.dispatchEvent(new w.Event("click"));
  }
  ok(rendered>=6, "navigated through steps, each rendered a title ("+rendered+")");

  // pick a class and verify sheet reflects HP/level
  // reset to class step via chip
  const chips=[...w.document.getElementById("steps").children];
  const classChip=chips.find(c=>c.textContent==="Class");
  classChip.dispatchEvent(new w.Event("click"));
  const classCards=[...w.document.getElementById("step-body").querySelectorAll(".card h3")];
  const fighter=classCards.find(h=>h.textContent==="Fighter");
  fighter.parentElement.dispatchEvent(new w.Event("click"));
  const hpVal=[...sheet.querySelectorAll(".combat")].find(c=>c.textContent.indexOf("HP")>=0);
  ok(hpVal && /\d/.test(hpVal.textContent), "selecting Fighter sets HP on sheet ("+(hpVal?hpVal.textContent.replace(/\s+/g," "):"?")+")");

  ok(errors.length===0, "no uncaught runtime errors"+(errors.length?": "+errors[0]:""));
  console.log("\n"+(fail?("UI TEST FAILED: "+fail):"ALL UI TESTS PASSED"));
  process.exit(fail?1:0);
},80);
