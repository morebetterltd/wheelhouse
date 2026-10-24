// Conservative test-source audit: filesystem-watch ownership belongs to the
// condition helper. Includes generated JS in shell here-docs/template strings;
// deliberately not a general parser or a regex over a CLI's rendered view.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const helper = 'fixtures/wait-for-condition.cjs';
// Build the audit's own patterns without spelling forbidden source examples.
const name = 'wa' + 'tch';
const accessPattern = new RegExp('\\.\\s*' + name + '(?:File)?\\b|\\b[A-Za-z_$][\\w$]*\\s*\\[\\s*[\'\"]' + name + '(?:File)?[\'\"]\\s*\\]');
const barePattern = new RegExp('\\b' + name + '(?:File)?\\s*\\(');
const importPattern = new RegExp('\\b(?:import|const|let|var)\\s*\\{[^}]*\\b' + name + '(?:File)?\\b[^}]*\\}', 's');
const instrumentation = new Map([
  ['fixtures/concurrency-barrier-observer.mjs', [
    new RegExp('^const nativeWatch = fs\\.' + name + ', write = fs\\.writeSync;$'),
    new RegExp('^fs\\.' + name + ' = function\\(target, \\.\\.\\.args\\) \\{$'),
  ]],
  ['fixtures/drop-watch-events.cjs', [
    new RegExp('^const nativeWatch = fs\\.' + name + ';$'),
    new RegExp('^fs\\.' + name + ' = function droppedWatch\\(\\) \\{$'),
  ]],
]);
function codeFiles(root: string, relative = ''): string[] {
  return fs.readdirSync(path.join(root, relative), {withFileTypes: true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const file = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`watch audit: unverifiable source symlink ${file}`);
    if (entry.isDirectory()) return codeFiles(root, file);
    if(!/\.(?:[cm]?js|ts|sh)$/.test(file))return[];
    assert(entry.isFile(),`watch audit: non-regular source subject ${file}`);
    return[file];
  });
}
export function auditDirectory(root: string): {files: number; helper: string} {
  assert(fs.statSync(root).isDirectory(), `watch audit: missing source directory ${root}`);
  for (const required of [helper, 'adapter.selftest.sh', 'fixtures/dead-seat-pipe.ts', 'fixtures/adapter-census.ts']) {
    assert(fs.statSync(path.join(root, required)).isFile(), `watch audit: missing source subject ${required}`);
  }
  const files = codeFiles(root);
  assert(files.length > 50, `watch audit: wrong source tree (${files.length} code files)`);
  for (const file of files) {
    if (file === helper) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = text.split(/\r?\n/);
    // Match the stored source, including accesses split across lines. Use the
    // originating line only for diagnostics and narrowly approved hook lines.
    for (const pattern of [accessPattern,barePattern]) for (const match of text.matchAll(new RegExp(pattern.source,'g'))) {
      const index=text.slice(0,match.index).split('\n').length-1,line=lines[index];
      if (/^\s*(?:#|\/\/)/.test(line)) continue;
      const allowed=instrumentation.get(file)?.some(pattern=>pattern.test(line));
      assert(allowed, `${file}:${index + 1}: bare filesystem watch outside ${helper}; use waitForCondition with an actual predicate`);
    }
    assert(!importPattern.test(text),
      `${file}: aliased filesystem-watch import outside ${helper}`);
  }
  return {files: files.length, helper};
}
if (import.meta.main) {
  const [root, scratch] = process.argv.slice(2);
  const result = auditDirectory(root);
  console.log(`PASS watch wait audit (${result.files} source files; one shared watcher owner)`);
  fs.cpSync(root, scratch, {recursive: true});
  const file = path.join(scratch, 'fixtures/planted-watch-only.mjs');
  const access = ['fs', name].join('.');
  const bodies=[
    `import fs from 'node:fs';\nawait new Promise(resolve => ${access}(process.argv[2], resolve));\n`,
    `import {${name} as subscribe} from 'node:fs';\nawait new Promise(resolve => subscribe(process.argv[2],resolve));\n`,
    `import fs from 'node:fs';\nconst {${name}:subscribe}=fs;\nawait new Promise(resolve=>subscribe(process.argv[2],resolve));\n`,
    `import fs from 'node:fs';\nconst subscribe=fs.\n${name};\nawait new Promise(resolve=>subscribe(process.argv[2],resolve));\n`,
  ];
  for(const [index,body] of bodies.entries()) {
    fs.writeFileSync(file,body);assert(fs.statSync(file).isFile()); // setup OUTSIDE the rejection assertion
    assert.throws(()=>auditDirectory(scratch), error=>error instanceof Error &&
      error.message.includes('fixtures/planted-watch-only.mjs') && /bare filesystem watch|aliased filesystem-watch import/.test(error.message),
      'planted wait-only watcher was silently accepted');
    console.log(`PASS planted watch wait ${index+1} rejected at its actual source file/line`);
  }
}
