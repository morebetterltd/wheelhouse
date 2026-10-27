import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "./fixture-command.cjs";
import { attributePreflight, failedPreflightAudits } from "../preflight-attribution";

const [templateArg, allocationArg, mode = "all", implementationArg] = process.argv.slice(2);
const template = path.resolve(templateArg), allocation = path.resolve(allocationArg);
assert(fs.statSync(path.join(allocation, ".wheelhouse-selftest-fixture")).isFile(), "owned allocation required");
const records: any[] = [];
function save() {
  const out = process.env.WHEELHOUSE_PREFLIGHT_EVIDENCE;
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `records-${mode}.json`), JSON.stringify(records, null, 2) + "\n"); }
}
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", policyTimeoutMs: 10000 }).trim();
function commit(root: string, name: string) { git(root, "add", "."); git(root, "commit", "-qm", name); return git(root, "rev-parse", "HEAD"); }
function put(root: string, file: string, text: string) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
function stop(root: string, suite = "audit.selftest.sh") { return `selftest-sweep: PREFLIGHT FAIL ${root}/seats/${suite} rc=1\nselftest-sweep: PREFLIGHT STOP 1 suite(s) not started\n`; }

async function unit() {
  // Protocol doubles only: no runDispatcherFullSweep, bd, task graph or model.
  const root = path.join(allocation, mode === "quarantine-control" ? "unit-quarantine-control" : "unit"); fs.mkdirSync(root); put(root, "seats/selftest-preflight.list", "# fixture audits\naudit.selftest.sh\nother.selftest.sh\n");
  const main = "a".repeat(40), a = "b".repeat(40), b = "c".repeat(40), c = "d".repeat(40);
  const candidates = { main, candidates: [{ bead: "bead-a", tip: a }, { bead: "bead-b", tip: b }, { bead: "bead-c", tip: c }] };
  const log = path.join(root, "primary.log"); fs.writeFileSync(log, stop(root)); let calls = 0;
  const runAudit = async (tip: string, suite: string) => {
    calls++; const file = path.join(root, `${calls}.log`), bad = tip === b;
    fs.writeFileSync(file, `tip=${tip}\nselftest-sweep: START ${root}/seats/${suite}\nselftest-sweep: ${bad ? "FAIL" : "PASS"} ${root}/seats/${suite} ${bad ? "rc=1 " : ""}elapsed=0s\nfinalTip=${tip}\n`);
    return { rc: bad ? 1 : 0, logPath: file, tip, timings: { suites: [{ suite }] } };
  };
  const input = { rc: 1, logPath: log, scratchCwd: root, candidates, runAudit };
  const expected = `preflight attribution: audit.selftest.sh main ${main.slice(0,12)}=PASS bead-a ${a.slice(0,12)}=PASS bead-b ${b.slice(0,12)}=FAIL bead-c ${c.slice(0,12)}=PASS`;
  assert.deepEqual(await attributePreflight(input), [expected]); assert.equal(calls, 4);
  console.log("PASS unit protocol: four pinned subjects, PASS/PASS/FAIL/PASS");
  fs.writeFileSync(log, stop(root) + stop(root, "other.selftest.sh") + stop(root));
  const multipleBefore = calls, multiple = await attributePreflight(input); assert.equal(multiple.length, 2); assert.equal(calls - multipleBefore, 8);
  console.log("PASS unit protocol: each failed listed audit once per subject, duplicate frames deduplicated");
  for (const kind of ["pass", "ordinary", "unlisted", "no-candidates", "nested"] as const) {
    fs.writeFileSync(log, kind === "ordinary" ? "ordinary failure\n" : kind === "unlisted" ? stop(root, "not-listed.selftest.sh") : kind === "nested" ? stop(root + "/nested") : stop(root));
    const before = calls; assert.deepEqual(await attributePreflight({ ...input, rc: kind === "pass" ? 0 : 1, candidates: kind === "no-candidates" ? undefined : candidates }), []); assert.equal(calls, before);
  }
  console.log("PASS unit protocol: no work for pass/ordinary/unlisted/no-candidates/nested frames");
  fs.writeFileSync(log, stop(root));
  const errors = await attributePreflight({ ...input, runAudit: async () => { throw Error("owned scratch could not be made"); } });
  assert(errors[0].includes("bead-b cccccccccccc=ERROR(owned scratch could not be made)")); assert(!errors[0].includes("=PASS"));
  const timed = await attributePreflight({ ...input, runAudit: async (tip, suite) => {
    const file=path.join(root,"timeout-"+tip+".log");fs.writeFileSync(file,`tip=${tip}\nselftest-sweep: START ${root}/seats/${suite}\nselftest-sweep: FAIL ${root}/seats/${suite} timed out after 1s (TERM then KILL after 1s grace; rc=143) elapsed=1s\nfinalTip=${tip}\n`);return{rc:1,tip,logPath:file,timings:{suites:[{suite}]}};
  } }); assert(timed[0].includes("=ERROR(per-suite timeout)")); assert(!timed[0].includes("=PASS"));
  console.log("PASS unit protocol: scratch failure and timeout records are ERROR, not PASS");
  const stopped = await attributePreflight({ ...input, runAudit: async(tip,suite) => {
    const file=path.join(root,'stopped-'+tip+'.log');fs.writeFileSync(file,`tip=${tip}\n${stop(root,suite)}finalTip=${tip}\n`);return{rc:1,tip,logPath:file,error:'invalid sweep timings: missing tier/full completed footer'};
  }}); assert(stopped[0].includes('bead-b cccccccccccc=FAIL')); assert(!stopped[0].includes('ERROR'));
  console.log('PASS unit protocol: completed preflight FAIL remains FAIL despite absent ordinary timing footer');
  const quarantined = await attributePreflight({ ...input, runAudit: async(tip,suite) => {
    const file=path.join(root,'quarantine-'+tip+'.log');fs.writeFileSync(file,`tip=${tip}\nselftest-sweep: START ${root}/seats/${suite}\nselftest-sweep: QUARANTINED-FAIL ${root}/seats/${suite} rc=1 elapsed=0s\nfinalTip=${tip}\n`);return{rc:0,tip,logPath:file,timings:{suites:[{suite}]}};
  }}); assert(quarantined[0].includes('bead-b cccccccccccc=FAIL'), 'quarantined audit must not pass merely because runner exits0'); assert(!quarantined[0].includes('=PASS'));
  console.log('PASS unit protocol: quarantined audit failure is FAIL even when its runner exits0');
  assert.deepEqual(failedPreflightAudits(stop(root),root,["audit.selftest.sh"]),["audit.selftest.sh"]);
  for (const [name, legacy] of [["call removed", []], ["failure relabelled PASS", [expected.replace("bead-b cccccccccccc=FAIL", "bead-b cccccccccccc=PASS")]], ["main omitted", [expected.replace(/main [a-f0-9]+=PASS /, "")]]] as const) {
    assert.throws(() => assert.deepEqual(legacy, [expected])); console.log(`CONTROL unit ${name}: unchanged attribution-line oracle rejects`);
  }
  records.push({ mode: "unit", expected, calls, errors, timed }); save();
}

const runner = `#!/usr/bin/env bash
set -eu
root=$(pwd -P)
bun -e 'import fs from "node:fs";import cp from "node:child_process";fs.appendFileSync(process.env.Q7MP_LEDGER,JSON.stringify({cwd:process.cwd(),tip:cp.execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),pattern:process.env.WHEELHOUSE_SELFTEST_SWEEP_PATTERN||null,marker:process.env.Q7MP_ENV,hermetic:process.env.WHEELHOUSE_SKIP_REAL_PI})+"\\n")'
selected=\${WHEELHOUSE_SELFTEST_SWEEP_PATTERN:-"$root/seats/audit.selftest.sh $root/seats/ordinary.selftest.sh"}
set -- $selected
printf 'selftest-sweep: tier=full suites=%s\\n' "$#"
total=$#; done_count=0; failures=0
for file in "$@"; do
  printf 'selftest-sweep: START %s\\n' "$file"
  rc=0; bash "$file" || rc=$?
  done_count=$((done_count+1))
  if [ "$rc" = 0 ]; then printf 'selftest-sweep: PASS %s elapsed=0s\\n' "$file";
  else
    failures=$((failures+1));printf 'selftest-sweep: FAIL %s rc=%s elapsed=0s\\n' "$file" "$rc"
    case "\${Q7MP_MODE:-normal}:$(basename "$file")" in
      normal:audit.selftest.sh|unlisted:ordinary.selftest.sh)
        printf 'selftest-sweep: PREFLIGHT FAIL %s rc=%s\\n' "$file" "$rc"
        printf 'selftest-sweep: PREFLIGHT STOP %s suite(s) not started\\n' "$((total-done_count))"
        printf 'selftest-sweep: quarantine: none\\nselftest-sweep: FAIL (1 failure(s) of %s suite(s), 0s)\\n' "$total";exit 1;;
    esac
  fi
done
printf 'selftest-sweep: quarantine: none\\n'
if [ "$failures" = 0 ]; then printf 'selftest-sweep: PASS (%s suite(s), 0s)\\n' "$total";
else printf 'selftest-sweep: FAIL (%s failure(s) of %s suite(s), 0s)\\n' "$failures" "$total";exit 1;fi
`;
function world(label: string, badMain = false) {
  const root = path.join(allocation, label); fs.mkdirSync(root); git(root,"init","-q","-b","main");
  put(root,"seats/selftest-sweep.sh",runner);put(root,"seats/selftest-preflight.list","audit.selftest.sh\n");
  put(root,"seats/audit.selftest.sh",'case "${Q7MP_MODE:-normal}" in pass|ordinary|unlisted) exit 0;; esac\n[ ! -f rejected.txt ]\n');
  put(root,"seats/ordinary.selftest.sh",'case "${Q7MP_MODE:-normal}" in ordinary|unlisted) exit 1;; *) exit 0;; esac\n');
  if(badMain)put(root,"rejected.txt","main fault\n");const main=commit(root,"fixture main"),candidates:any[]=[];
  for(const name of ["a","b","c"]){git(root,"checkout","-qb","candidate-"+name,main);put(root,"feature-"+name,"change\n");if(name==="b")put(root,"rejected.txt","candidate fault\n");const tip=commit(root,"candidate "+name);candidates.push({bead:"bead-"+name,tip});}
  git(root,"checkout","-qb","batch",main);for(const c of candidates)git(root,"merge","--no-ff","-qm","Merge fleet/"+c.bead,c.tip);
  return {root,main,candidates,tip:git(root,"rev-parse","HEAD")};
}
async function integration() {
  const implementation = implementationArg ?? path.join(template,"seats/verify.ts");
  const api=await import(pathToFileURL(implementation).href);
  const realBd=process.env.WHEELHOUSE_REAL_BD || process.env.Q7MP_REAL_BD || process.env.PATH!.split(path.delimiter).map(p=>path.join(p,"bd")).find(p=>fs.existsSync(p))!;assert(realBd&&fs.statSync(realBd).isFile());
  const world1=world(mode==="first-only"?"batch-removed":"batch"), logs=path.join(allocation,mode==="first-only"?"removed-logs":"logs");fs.mkdirSync(logs);const ledger=path.join(allocation,mode==="first-only"?"removed-invocations.jsonl":"invocations.jsonl");fs.writeFileSync(ledger,"");
  process.env.Q7MP_LEDGER=ledger;process.env.Q7MP_ENV="same-sweep-environment";
  const count=()=>fs.readFileSync(ledger,"utf8").trim().split("\n").filter(Boolean).length;
  async function invoke(w:ReturnType<typeof world>,name:string,modeName="normal",candidates:any={main:w.main,candidates:w.candidates}) {
    process.env.Q7MP_MODE=modeName;const before=count();
    const result=await api.runDispatcherFullSweep(w.root,w.tip,realBd,process.env.PATH!,{tier:"full",reason:"fixture"},{logDir:logs,logPrefix:name+".",coordinatedSignals:true,preflightCandidates:candidates});
    const text=fs.readFileSync(result.logPath,"utf8"),lines=result.preflightAttribution??[];records.push({name,result,lines,text,runnerInvocations:count()-before});save();return{result,text,lines,ran:count()-before};
  }
  const first=await invoke(world1,"isolated");assert.equal(first.result.rc,1);const expected=`preflight attribution: audit.selftest.sh main ${world1.main.slice(0,12)}=PASS bead-a ${world1.candidates[0].tip.slice(0,12)}=PASS bead-b ${world1.candidates[1].tip.slice(0,12)}=FAIL bead-c ${world1.candidates[2].tip.slice(0,12)}=PASS`;
  assert.deepEqual(first.lines,[expected],"missing preflight attribution or wrong isolated candidate result");assert.equal(first.ran,5);assert(first.text.indexOf(expected)<first.text.indexOf("\nrc=1\n"));
  const prompt=api.sweepPromptLines(first.result,true).join("\n");assert(prompt.includes(expected));assert(prompt.includes("On each CANDIDATE line"));assert(prompt.includes("If rc is not 0, you cannot approve"));
  const rows=fs.readFileSync(ledger,"utf8").trim().split("\n").map(l=>JSON.parse(l));assert.equal(new Set(rows.map(r=>r.cwd)).size,5);for(const r of rows.slice(1)){assert.equal(r.pattern,path.join(r.cwd,"seats/audit.selftest.sh"));assert.equal(r.marker,"same-sweep-environment");assert.equal(r.hermetic,"1");}assert.deepEqual(rows.slice(1).map(r=>r.tip),[world1.main,...world1.candidates.map(c=>c.tip)]);
  console.log("  ok    preflight failure is attributed to the candidate tips that fail it alone");console.log(expected);
  if(mode==="first-only")return;
  const mainFault=world("main-fault",true), inherited=await invoke(mainFault,"main-fault");assert.equal(inherited.result.rc,1);assert(inherited.lines[0].includes(`main ${mainFault.main.slice(0,12)}=FAIL`));for(const c of mainFault.candidates)assert(inherited.lines[0].includes(`${c.bead} ${c.tip.slice(0,12)}=FAIL`));console.log("  ok    a preflight failure already on main is reported as main=FAIL");
  for(const [name,kind,plan]of [["passing","pass",{main:world1.main,candidates:world1.candidates}],["ordinary","ordinary",{main:world1.main,candidates:world1.candidates}],["non-listed","unlisted",{main:world1.main,candidates:world1.candidates}],["no-candidates","normal",undefined]] as const){const r=await invoke(world1,name,kind,plan===undefined?null:plan);assert.equal(r.ran,1);assert.deepEqual(r.lines,[]);assert.equal(r.result.rc,name==="passing"?0:1);}
  console.log("  ok    no attribution runs without a preflight stop");
  const missing={main:world1.main,candidates:world1.candidates.map((c,i)=>i===2?{...c,tip:"0".repeat(40)}:c)},bad=await invoke(world1,"scratch-error","normal",missing);assert(bad.lines[0].includes("bead-c 000000000000=ERROR("));assert.equal(bad.result.rc,1);assert(bad.text.includes("\nrc=1\n"));console.log("  ok    attribution leaves the sweep rc unchanged; scratch-copy failure is ERROR");
  // Use the same first leg/checker with ONLY the dispatcher hook removed.
  const runtime=path.join(allocation,"removed");const files=execFileSync("git",["-C",template,"ls-files","-z","--","seats"],{encoding:"utf8",policyTimeoutMs:10000}).split("\0").filter(Boolean);for(const file of files){const from=path.join(template,file),to=path.join(runtime,file);fs.mkdirSync(path.dirname(to),{recursive:true});if(fs.lstatSync(from).isSymbolicLink())fs.symlinkSync(fs.readlinkSync(from),to);else fs.copyFileSync(from,to);}
  const target=path.join(runtime,"seats/verify.ts"),source=fs.readFileSync(target,"utf8"),start=source.indexOf('  const preflightAttribution = options.preflightCandidates && rc === 1 ? await (await import("./preflight-attribution"))'),end=source.indexOf('\n  }) : [];',start)+'\n  }) : [];'.length;assert(start>=0&&end>start);fs.writeFileSync(target,source.slice(0,start)+'  const preflightAttribution: string[] = [];'+source.slice(end));
  const control=spawnSync("bun",[import.meta.path,template,allocation,"first-only",target],{env:{...process.env,WHEELHOUSE_PREFLIGHT_EVIDENCE:undefined},encoding:"utf8",policyTimeoutMs:180000});records.push({name:"hook-removed",status:control.status,signal:control.signal,error:control.error?.message,stdout:control.stdout,stderr:control.stderr});save();assert.ifError(control.error);assert.equal(control.signal,null);assert.equal(control.status,1);assert(control.stderr.includes("missing preflight attribution"));console.log("CONTROL attribution call removed: same first leg native1 at missing preflight attribution, not setup");
  const moduleFile=path.join(runtime,"seats/preflight-attribution.ts"),moduleText=fs.readFileSync(moduleFile,"utf8"),guard=' && !failures.length && !preflightFailure';assert(moduleText.includes(guard));fs.writeFileSync(moduleFile,moduleText.replace(guard,''));
  const quarantineControl=spawnSync("bun",[path.join(runtime,"seats/fixtures/verify-preflight.ts"),template,allocation,"quarantine-control"],{env:{...process.env,WHEELHOUSE_PREFLIGHT_EVIDENCE:undefined},encoding:"utf8",policyTimeoutMs:30000});records.push({name:"quarantine-guard-removed",status:quarantineControl.status,signal:quarantineControl.signal,error:quarantineControl.error?.message,stdout:quarantineControl.stdout,stderr:quarantineControl.stderr});save();assert.ifError(quarantineControl.error);assert.equal(quarantineControl.signal,null);assert.equal(quarantineControl.status,1);assert(quarantineControl.stderr.includes('quarantined audit must not pass merely because runner exits0'));console.log('CONTROL quarantined-failure guard removed: same module units native1 at quarantined audit must not pass merely because runner exits0');
}
if(mode==="unit"||mode==="quarantine-control") { await unit(); console.log("verify-preflight module units: PASS (NO graph-writing suite result claimed)"); }
else { if(mode!=="first-only")await unit();await integration();console.log("verify-preflight.selftest: PASS"); }
