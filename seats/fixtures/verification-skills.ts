import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRoleBrief } from '../briefs.ts';

export function checkWorkerEvidence(root: string): string[] {
  try {
    const brief = fs.readFileSync(resolveRoleBrief(root, 'worker'), 'utf8');
    const sentences = [
      "When code reads an outside tool's output, capture the real output first, record the command, and build the fixture from that capture.",
      'Every new test leg must be shown to fail with the fix removed; say how in the report.',
      "Report only checks you actually ran, and include each check's exit code.",
    ];
    return sentences.every(sentence => brief.includes(sentence)) ? [] : ['WORKER.md is missing one of the required evidence-discipline sentences'];
  } catch (error) { return [String(error)]; }
}

// Check the shipped tree, not a generated manual. Only the template ships the
// verification-skill compatibility links; installs load .agents/skills directly.
export function checkVerificationSkills(root: string): string[] {
  const errors: string[] = [];
  const bad = (message: string) => errors.push(message);
  const names = ['create-verification', 'maintain-verification'];
  const banned = /lifeos|\.cursor|cursor|claude|codex|pai\b/i;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return ['verification skill root missing'];
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (gitRoot.status !== 0 || !gitRoot.stdout.trim() || fs.realpathSync(gitRoot.stdout.trim()) !== fs.realpathSync(root)) {
    return ['verification skill root is not the intended repository root'];
  }
  let templateLayout: boolean;
  try { templateLayout = resolveRoleBrief(root, 'worker') === path.join(root, 'contracts/WORKER.md'); }
  catch (error) { return [String(error)]; }
  const modes = new Map<string, string[]>();
  if (templateLayout) {
    const staged = spawnSync('git', ['ls-files', '-s', '--', ...names.map(n => `.claude/skills/${n}`)], { cwd: root, encoding: 'utf8' });
    if (staged.status !== 0) bad('cannot read skill symlink index modes');
    for (const line of staged.stdout.split('\n')) {
      const m = line.match(/^(\d{6}) [0-9a-f]+ [0-3]\t(.+)$/);
      if (m) modes.set(m[2], [...(modes.get(m[2]) ?? []), m[1]]);
    }
  }
  for (const name of names) {
    const dir = path.join(root, '.agents/skills', name), skill = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) { bad(`${name}: skill directory missing or not a real directory`); continue; }
    if (!fs.existsSync(skill) || !fs.statSync(skill).isFile()) { bad(`${name}: SKILL.md missing`); }
    else {
      const text = fs.readFileSync(skill, 'utf8');
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!m) bad(`${name}: frontmatter missing`);
      else {
        try {
          const fields = Bun.YAML.parse(m[1]);
          if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw Error('mapping required');
          if (fields.name !== name) bad(`${name}: frontmatter name differs`);
          if (typeof fields.description !== 'string' || !fields.description.trim()) bad(`${name}: description missing`);
          if (typeof fields.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(fields.version)) bad(`${name}: semantic version missing`);
        } catch { bad(`${name}: frontmatter does not parse as a mapping`); }
        if (!text.slice(m[0].length).trimStart().startsWith('Adapted under MIT; see the [source and license notice](../NOTICE-pstack.md).')) bad(`${name}: opening notice pointer missing`);
      }
    }
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) { if (banned.test(fs.readFileSync(file, 'utf8'))) bad(`${path.relative(root, file)}: forbidden tool/dependency name`); }
        else bad(`${path.relative(root, file)}: unexpected non-regular skill entry`);
      }
    };
    visit(dir);
    if (templateLayout) {
      const rel = `.claude/skills/${name}`, link = path.join(root, rel);
      if (!fs.existsSync(link) || !fs.lstatSync(link).isSymbolicLink()) bad(`${name}: compatibility link missing, dangling or not a symlink`);
      else if (fs.readlinkSync(link) !== `../../.agents/skills/${name}` || !fs.existsSync(path.join(link, 'SKILL.md'))) bad(`${name}: compatibility link does not resolve to the real skill`);
      if (JSON.stringify(modes.get(rel)) !== JSON.stringify(['120000'])) bad(`${name}: compatibility link is not indexed once as mode 120000`);
    }
  }
  const notice = path.join(root, '.agents/skills/NOTICE-pstack.md');
  if (!fs.existsSync(notice) || !fs.statSync(notice).isFile()) bad('adaptation notice missing');
  else {
    const text = fs.readFileSync(notice, 'utf8');
    if (!text.includes('Lauren Tan') || !text.includes('MIT')) bad('adaptation notice lacks author or MIT');
    if (!text.includes('Copyright (c) 2026 Lauren Tan')) bad('adaptation copyright missing');
    if (!/github\.com\/cursor\/plugins[^\n]*[0-9a-f]{40}/.test(text)) bad('adaptation source URL lacks pinned commit');
  }
  return errors;
}
if (import.meta.main) {
  const worker = process.argv[2] === '--worker';
  const root = process.argv[worker ? 3 : 2];
  if (!root) { console.error('usage: verification-skills.ts [--worker] <repository-root>'); process.exitCode = 2; }
  else {
    const errors = (worker ? checkWorkerEvidence : checkVerificationSkills)(path.resolve(root));
    for (const error of errors) console.error(`${worker ? 'worker evidence' : 'verification skills'}: ${error}`);
    if (errors.length) process.exitCode = 1;
    else console.log(`${worker ? 'worker evidence' : 'verification skills'}: PASS`);
  }
}
