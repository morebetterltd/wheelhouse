import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const [fixture, auditor] = process.argv.slice(2);
const { invocationViolations, auditPythonCalls } = await import(pathToFileURL(auditor).href);
let failed = 0, checked = 0;
function check(ok: boolean, name: string, detail = "") { checked++; console.log(`${ok ? "ok" : "not ok"} - ${name}${detail ? ": " + detail : ""}`); if (!ok) failed++; }
const bad: [string,string,string][] = [
 ["direct", "a.sh", "python3 -c 'print(1)'"],
 ["absolute version", "a.sh", "/opt/venv/bin/python3.12 -c 'print(1)'"],
 ["other Python interpreters", "a.sh", "pypy3 -V; python2.7 -V; python -V"],
 ["quoted executable", "a.sh", "'python3' -V"],
 ["escaped executable", "a.sh", "py\\thon3 -V"],
 ["continued executable", "a.sh", "py\\\nthon3 -V"],
 ["ANSI executable", "a.sh", "$'\\x70ython3' -V"],
 ["assignment prefix", "a.sh", "FLAG=1 python3 -V"],
 ["env assignment prefix", "a.sh", "/usr/bin/env -u OTHER FLAG=1 python3 -V"],
 ["env split", "a.sh", "env -S 'python3 -u'"],
 ["env compact split", "a.sh", "env -Spython3"],
 ["env equals split", "a.sh", "env --split-string='python3 -u'"],
 ["command wrapper", "a.sh", "command -- python3 -V"],
 ["dependency probe", "a.sh", "command -v python3"],
 ["exec wrapper", "a.sh", "exec /usr/bin/python3 -V"],
 ["sudo option", "a.sh", "sudo -u fixture python3 -V"],
 ["xargs option", "a.sh", "printf data | xargs -n 1 python3"],
 ["if function and pipe", "a.sh", "f(){ if true; then printf x | python3; fi; }"],
 ["subshell", "a.sh", "(echo data; python3)"],
 ["leading redirection", "a.sh", "2>/dev/null python3 -V"],
 ["leading descriptor duplication", "a.sh", "2>&1 python3 -V"],
 ["command substitution", "a.sh", "OUT=$(python3 -V)"],
 ["quoted command substitution", "a.sh", "printf '%s' \"$(python3 -V)\""],
 ["backtick substitution", "a.sh", "OUT=`python3 -V`"],
 ["quoted backtick substitution", "a.sh", "echo \"`python3 -V`\""],
 ["literal alias", "a.sh", "P=python3; \"$P\" -V"],
 ["braced alias", "a.sh", "P=python3; ${P} -V"],
 ["shell eval", "a.sh", "eval 'python3 -V'"],
 ["shell payload", "a.sh", "bash -c 'python3 -V'"],
 ["shell stdin", "a.sh", "bash <<'SH'\npython3 -V\nSH\n"],
 ["expanding data heredoc", "a.sh", "cat <<DATA\n$(python3 -V)\nDATA\n"],
 ["generated Python peer", "a.sh", "cat > peer <<'PY'\n#!/usr/bin/env python3\nprint(1)\nPY\nchmod +x peer\n"],
 ["generated shell peer", "a.sh", "cat > peer <<'SH'\n#!/bin/sh\npython3 -V\nSH\nchmod +x peer\n"],
 ["Bun eval process API", "a.sh", "bun -e 'Bun.spawnSync([\"python3\",\"-V\"])'"],
 ["Bun stdin process API", "a.sh", "if " + "bun" + " - <<'TS'\nBun.spawnSync(['python3','-V']);\nTS\nthen :; fi\n"],
 ["Node eval process API", "a.sh", "node -e 'require(\"child_process\").spawnSync(\"python3\",[])'"],
 ["JS spawn", "a.ts", "spawnSync('python3', ['-V']);"],
 ["JS partial argument array", "a.ts", "Bun.spawn(['python3', script, ...args]);"],
 ["JS execFile absolute", "a.mjs", "execFile('/usr/bin/python3', ['-V']);"],
 ["JS shell exec", "a.js", "execSync('python3 -V');"],
 ["JS array API", "a.ts", "Bun.spawnSync(['python3','-V']);"],
 ["JS object API", "a.ts", "Bun.spawn({cmd:['python3','-V'],stdout:'pipe'});"],
 ["JS array alias", "a.ts", "const cmd=['python3',script]; Bun.spawn(cmd);"],
 ["JS object shorthand", "a.ts", "const cmd=['python3']; Bun.spawn({cmd});"],
 ["JS literal alias", "a.ts", "const runtime='python3', args=[]; spawnSync(runtime,args);"],
 ["JS import alias", "a.ts", "import { spawnSync as launch } from 'node:child_process'; launch('python3',[]);"],
 ["JS concatenated command", "a.ts", "spawnSync('py'+'thon3',[]);"],
 ["JS escaped command", "a.ts", "spawnSync('\\x70ython3',[]);"],
 ["JS shell payload", "a.ts", "spawnSync('bash',['-c','python3 -V']);"],
 ["JS env payload", "a.ts", "Bun.spawn(['env','-S','python3 -u']);"],
 ["JS nested runtime payload", "a.ts", "spawnSync(process.execPath,['-e',\"Bun.spawn(['python3'])\"]);"],
 ["JS generated executable", "a.ts", "fs.writeFileSync('peer','#!/usr/bin/env python3\\nprint(1)\\n',{mode:0o755});"],
 ["JS generated executable with other mode", "a.ts", "fs.writeFileSync('peer','#!/usr/bin/env python3\\nprint(1)\\n',{mode:0o777});"],
 ["Bun shell tag", "a.ts", "$`python3 -V`;"],
 ["Bun shell tag alias", "a.ts", "import {$ as sh} from 'bun'; sh`python3 -V`;"],
 ["JS template expression", "a.ts", "const text=`result ${spawnSync('python3',[])}`;"],
 ["package script", "package.json", '{"scripts":{"check":"python3 -V"}}'],
 ["document executable fence", "a.md", 'Prose.\n```bash\npython3 -V\n```\n'],
];
const good: [string,string,string][] = [
 ["shell comment", "a.sh", "# python3 -V\nprintf ok"],
 ["shell ordinary argument", "a.sh", "printf '%s\\n' 'python3 -V'"],
 ["shell quoted substitution data", "a.sh", "printf '%s' '$(python3 -V)'"],
 ["shell data heredoc", "a.sh", "cat <<'DATA'\npython3 -V\n#!/usr/bin/env python3\nDATA\n"],
 ["shell data here-string", "a.sh", "cat <<<'python3 -V'"],
 ["case pattern", "a.sh", "case value in\npython3) printf ok;;\nesac"],
 ["function declaration", "a.sh", "python3(){ printf 'not invoked'; }"],
 ["exported ordinary data", "a.sh", "export python3; export LABEL=python3; printf '%s' \"$LABEL\""],
 ["nested parameter quoting", "a.sh", 'cleanup(){ printf "%s" "${ROWS[@]+"${ROWS[@]}"}" "python3"; }'],
 ["JS ordinary string", "a.ts", "const text=\"spawnSync('python3',[])\";"],
 ["JS comment", "a.ts", "// spawnSync('python3',[])\nconst n=1;"],
 ["JS ordinary template", "a.ts", "const text=`python3 -V`;"],
 ["JS literal data array", "a.ts", "const data=['python3','spawnSync(\"python3\",[])'];"],
 ["JS regex data", "a.ts", "const re=/python3/; re.exec('python3');"],
 ["JS nonexecuting fixture write", "a.ts", "fs.writeFileSync('input.txt','python3 -V');"],
 ["Bun inline ordinary string", "a.sh", "bun -e 'console.log(\"python3 -V\")'"],
 ["Node stdin ordinary data", "a.sh", "node - <<'JS'\nconsole.log('python3');\nJS\n"],
 ["captured output", "capture.out", "STOP: python3 isn't available\n"],
 ["captured JSON", "capture.jsonl", '{"message":"python3 -V"}\n'],
 ["ordinary prose", "a.md", "The word `python3` is inert documentation.\n"],
 ["non-command package data", "package.json", '{"description":"python3 is not needed"}'],
 ["different command name", "a.sh", "python3-config --includes"],
];
for (const [expected, rows] of [[true,bad],[false,good]] as const) for (const [name,file,source] of rows) {
  try { const found=invocationViolations(source,file); check(Boolean(found.length)===expected, `${expected ? "reject" : "allow"} ${name}`, Boolean(found.length)===expected ? "" : JSON.stringify(found)); }
  catch (error: any) { check(false, `${expected ? "reject" : "allow"} ${name}`, "parser error is not a detected invocation: "+error.message); }
}
if (process.env.PYTHON_GUARD_PROGRAMS_ONLY === "1") { console.log(`Python invocation programs: ${checked} checks, ${failed} failures`); process.exit(failed ? 1 : 0); }
if (!fs.statSync(path.join(fixture,".wheelhouse-selftest-fixture")).isFile()) throw Error("missing owned fixture marker");
function git(root: string, ...args: string[]) { const r=spawnSync("git",["-C",root,...args],{encoding:"utf8"}); if(r.status!==0) throw Error(r.stderr); return r.stdout; }
function repo(root: string) { fs.mkdirSync(path.join(root,"seats"),{recursive:true}); git(root,"init","-q","-b","main"); git(root,"config","user.name","selftest"); git(root,"config","user.email","selftest@example.invalid"); git(root,"config","commit.gpgsign","false"); }
function throws(fn: ()=>unknown, pattern: RegExp) { try { fn(); return false; } catch(error:any) { return pattern.test(error.message); } }
const root=path.join(fixture,"tracked");repo(root);
check(throws(()=>auditPythonCalls(root),/no tracked seats/),"empty tracked inventory fails closed");
const sample=path.join(root,"seats","name with space\nand newline.sh");fs.writeFileSync(sample,"#!/bin/sh\npython3 -V\n");
check(throws(()=>auditPythonCalls(root),/no tracked seats/),"untracked source does not invent a tracked inventory");git(root,"add","seats");
const result=auditPythonCalls(root);check(result.files===1&&result.errors.length===1&&result.errors[0].includes("forbidden Python invocation"),"NUL-safe tracked filename rejects command");
fs.writeFileSync(sample,"#!/bin/sh\nprintf '%s\\n' 'python3 -V'\n");check(auditPythonCalls(root).errors.length===0,"same tracked path permits inert data");
fs.writeFileSync(path.join(root,"seats","untracked.sh"),"python3 -V\n");check(auditPythonCalls(root).errors.length===0,"invocation scope is tracked source, not untracked fixture data");
fs.unlinkSync(sample);check(auditPythonCalls(root).errors.some((s:string)=>s.includes("cannot audit tracked source")),"missing tracked source fails closed");
const missingCLI=spawnSync("bun",[auditor,root],{encoding:"utf8"});check(missingCLI.status===2&&missingCLI.stderr.includes("cannot audit tracked source"),"missing source is incomplete exit2, not completed-test failure");fs.writeFileSync(sample,"#!/bin/sh\nprintf ok\n");
const plain=path.join(root,"plain");fs.mkdirSync(path.join(plain,"seats"),{recursive:true});check(throws(()=>auditPythonCalls(plain),/wrong tracked root/),"plain subdirectory is not mistaken for project root");
const nested=path.join(root,"nested");repo(nested);fs.writeFileSync(path.join(nested,"seats","bad.sh"),"python3 -V\n");git(nested,"add","seats");check(auditPythonCalls(nested).errors.length===1,"nested repository audits its own tracked source");
git(root,"add","seats");git(root,"commit","-q","-m","fixture source");const wt=path.join(fixture,"owned-worktree");git(root,"worktree","add","-q","-b","fixture-worktree",wt,"main");check(auditPythonCalls(wt).errors.length===1,"worktree audits tracked command from committed source");
const sub=path.join(wt,"sub");fs.mkdirSync(path.join(sub,"seats"),{recursive:true});check(throws(()=>auditPythonCalls(sub),/wrong tracked root/),"worktree subdirectory is not mistaken for root");
const corrupt=path.join(fixture,"bad-index");repo(corrupt);fs.writeFileSync(path.join(corrupt,".git","index"),"bad");const capture=spawnSync("git",["-C",corrupt,"ls-files","-z","--","seats"],{encoding:"utf8"});console.log("Native invalid-index capture: "+JSON.stringify({status:capture.status,stdout:capture.stdout,stderr:capture.stderr}));check(capture.status!==0&&throws(()=>auditPythonCalls(corrupt),/git ls-files failed/),"Git inventory failure is not empty success");
const odd=path.join(fixture,"root with final space ");repo(odd);fs.writeFileSync(path.join(odd,"seats","bad.sh"),"python3 -V\n");git(odd,"add","seats");let oddPassed=false;try { oddPassed=auditPythonCalls(odd).errors.length===1; } catch {} check(oddPassed,"Git root whitespace is data, not display padding");
const noGit=path.join(fixture,"plain-root");fs.mkdirSync(path.join(noGit,"seats"),{recursive:true});const cli=spawnSync("bun",[auditor,noGit],{encoding:"utf8"});check(cli.status===2&&cli.stderr.includes("cannot audit"),"CLI exits2 for unauditable root");
console.log(`Python invocation guard: ${checked} checks, ${failed} failures`);process.exit(failed ? 1 : 0);
