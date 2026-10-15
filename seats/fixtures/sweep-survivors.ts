import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";

const [fix,seats]=process.argv.slice(2);
assert(fs.existsSync(path.join(fix,".wheelhouse-selftest-fixture")));
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const only=process.env.WHEELHOUSE_SURVIVOR_CASE;
assert(!only || ["clean","group","scratch"].includes(only));
const psArgs=["-o","pid=,ppid=,pgid=,lstart=,stat=,command="];
function ps(pid:number) {
  const r=spawnSync("ps",["-p",String(pid),...psArgs],{encoding:"utf8",env:{...process.env,LC_ALL:"C"}});
  assert(!r.error);assert([0,1].includes(r.status!));if(r.status===1)assert.equal(r.stdout,"");
  assert.equal(r.stderr,"");return r;
}
function identity(text:string) {
  const m=/^\s*(\d+)\s+\d+\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+\S+\s+(.*)$/.exec(text.trim());
  assert(m);return [m[1],m[2],m[3],m[4]].join("|"); // parent/state can change
}
for(const mode of ["clean","group","scratch"]) {
  if(only && mode!==only)continue;
  const dir=path.join(fix,mode);fs.mkdirSync(dir);
  const suite=path.join(dir,`${mode}.selftest.sh`),before=path.join(dir,"before.ps"),pidFile=path.join(dir,"child.pid");
  // Both plants hold inherited stdout/stderr. The second changes process group,
  // so only the private scratch boundary can attribute it after its parent exits.
  const launch=mode==="scratch"?`(cd "$TMPDIR" || exit 2; exec perl -MPOSIX=setsid -e 'setsid or die "setsid: $!"; exec @ARGV or die "exec: $!"' sleep 1000) &`:
    `(cd ${mode==="clean"?'"$CHILD_FIX"':quote(dir)} || exit 2; exec sleep 1000) &`;
  fs.writeFileSync(suite,`#!/usr/bin/env bash\nset -eu\n${mode==="clean"?`. ${quote(path.join(seats,"selftest-lib.sh"))}\nCHILD_FIX="$(selftest_make_fixture_dir "$TMPDIR/child.XXXXXX")" || exit 2\nselftest_isolate_git "$CHILD_FIX" || exit 2\nwait(){ printf '%s\\n' "$*" >> ${quote(path.join(dir,"waits"))}; builtin wait "$@"; }\ntrap 'selftest_remove_fixture_dir "$CHILD_FIX"' EXIT\n`:""}${launch}\np=$!\nprintf '%s\\n' "$p" > ${quote(pidFile)}\n# A native exec acknowledgement, not elapsed time, establishes the subject.\nfor i in $(seq 1 200); do\n  comm="$(ps -p "$p" -o comm=)"\n  case "$comm" in *sleep) break;; esac\n  sleep 0.01\ndone\ncase "$comm" in *sleep) ;; *) echo 'sleep did not exec' >&2; exit 3;; esac\nLC_ALL=C ps -p "$p" ${psArgs.map(quote).join(" ")} > ${quote(before)}\nprintf 'fixture ${mode} parent finished\\n'\n`);
  const child=spawn("bash",[path.join(seats,"selftest-sweep.sh")],{env:{...process.env,WHEELHOUSE_SELFTEST_SWEEP_LOCK:path.join(dir,"private.lock"),WHEELHOUSE_SELFTEST_SWEEP_PATTERN:suite},stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";child.stdout!.on("data",b=>stdout+=b);child.stderr!.on("data",b=>stderr+=b);
  let timer:ReturnType<typeof setTimeout>;
  const exited=new Promise<number>((resolve,reject)=>{timer=setTimeout(()=>reject(new Error("fixture runner did not exit")),60000);child.once("error",reject);child.once("exit",(code,signal)=>{clearTimeout(timer);assert.equal(signal,null);resolve(code!);});});
  const closed=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  let pid=0;
  try {
    const rc=await exited;assert(fs.existsSync(before));pid=Number(fs.readFileSync(pidFile,"utf8"));assert(Number.isSafeInteger(pid)&&pid>1);
    const original=fs.readFileSync(before,"utf8");assert.match(original,/sleep 1000/);
    const post=ps(pid);fs.writeFileSync(path.join(dir,"after.ps"),post.stdout);fs.writeFileSync(path.join(dir,"after.exit"),post.status+"\n");
    assert.equal(rc,mode==="clean"?0:1,`wrong runner result for ${mode}: ${stdout}${stderr}`);
    if(mode==="clean")assert(fs.readFileSync(path.join(dir,"waits"),"utf8").trim().split("\n").includes(String(pid)),"teardown did not wait for its child");
    // A zombie has no FDs and cannot keep the output pipe open.
    assert(post.status===1 || /\sZ\S*\s/.test(post.stdout),`child survived ${mode}: ${post.stdout}`);
    await Promise.race([closed,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error("suite output did not reach EOF")),5000);t.unref();})]);
    if(mode!=="clean") {assert(stderr.includes(`selftest-sweep: LEAK ${suite} pid=${pid}`));assert(stderr.includes(`via=${mode}`));assert(!stdout.includes(`selftest-sweep: PASS ${suite}`));assert(stdout.includes(`selftest-sweep: FAIL ${suite} rc=1`));}
    process.stdout.write(stdout);process.stderr.write(stderr);
    console.log(`post-suite child pid=${pid}: native ps exit=${post.status}, stdout=${JSON.stringify(post.stdout)}, stderr=${JSON.stringify(post.stderr)}`);
    console.log(`PASS ${mode}: runner=${rc}, no live child, output EOF${mode==="clean"?", fixture teardown reaped child":", named suite failure"}`);
  } finally {
    clearTimeout(timer!);
    fs.writeFileSync(path.join(dir,"runner.stdout"),stdout);fs.writeFileSync(path.join(dir,"runner.stderr"),stderr);fs.writeFileSync(path.join(dir,"runner.exit"),String(child.exitCode)+"\n");
    if(child.exitCode===null) {
      const current=ps(child.pid!);
      if(current.status===0) {assert.match(current.stdout,new RegExp(`^\\s*${child.pid}\\s+${process.pid}\\s+`));assert(current.stdout.includes(path.join(seats,"selftest-sweep.sh")));child.kill("SIGTERM");}
    }
    // Negative controls may omit the check. Reap only this fixture's freshly
    // matching native PID/start/group/argv, never a broad host name match.
    if(!pid && fs.existsSync(pidFile))pid=Number(fs.readFileSync(pidFile,"utf8"));
    if(pid && fs.existsSync(before)) {
      const current=ps(pid);if(current.status===0 && !/\sZ\S*\s/.test(current.stdout)) {
        assert.equal(identity(current.stdout),identity(fs.readFileSync(before,"utf8")),"owned plant identity changed; not signaled");
        process.kill(pid,"SIGKILL");console.error(`control cleanup: stopped owned planted child ${pid}`);
      }
    }
  }
}
