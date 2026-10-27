#!/usr/bin/env bun
// Read-only install gate. The validated manual.ts features --json inventory is
// stdin; the interview is an install-owned record, never inferred from a count.
import fs from 'node:fs';
import path from 'node:path';

const [repo, file, ...extra] = process.argv.slice(2);
if (!repo || !file || extra.length) {
  console.error('usage: install-features.ts <repo> <interview/features.md> < manual-features.json');
  process.exit(2);
}
const refuse = (message: string): never => { console.error('FAIL interview features: ' + message); process.exit(1); };
let mapped: any[], records: any[], confirmed: any[];
try {
  const text = fs.readFileSync(file, 'utf8');
  mapped = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!Array.isArray(mapped) || mapped.some(entry => !entry || typeof entry.slug !== 'string' || typeof entry.howToGetToIt !== 'string')) refuse('invalid manual feature inventory');
  confirmed = [...text.matchAll(/^Confirmed repo: (".*")\s*$/gm)].map(match => JSON.parse(match[1]));
  const blocks = [...text.matchAll(/^```jsonl\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) refuse(file + ': expected one jsonl feature block');
  records = blocks[0][1].split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
} catch (error: any) { refuse(file + ': ' + error.message); }
const target = path.resolve(repo), slugs = new Set<string>();
if (!confirmed.some(value => typeof value === 'string' && path.resolve(value) === target)) refuse(file + ': repo not confirmed: ' + repo);
const expected = records.filter(row => {
  if (!row || typeof row.repo !== 'string' || !row.repo || typeof row.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) || !['[found]', '[owner]'].includes(row.origin) || typeof row.name !== 'string' || !row.name.trim() || !(row.reach === null || typeof row.reach === 'string')) refuse(file + ': malformed feature record');
  return path.resolve(row.repo) === target;
});
for (const row of expected) {
  if (slugs.has(row.slug)) refuse('duplicate feature ' + row.slug + ' for ' + repo);
  slugs.add(row.slug);
  const entry = mapped.find(feature => feature.slug === row.slug);
  if (!entry) refuse(repo + ': missing feature ' + row.slug + ' (' + row.name + ')');
  if (!row.reach || (row.origin === '[owner]' && !entry.howToGetToIt.includes(row.reach))) refuse(repo + ': feature ' + row.slug + ' is missing the owner-confirmed reach');
}
for (const entry of mapped) if (!slugs.has(entry.slug)) refuse(repo + ': unrecorded feature ' + entry.slug + ' — return to question 2e');
if (expected.length !== mapped.length) refuse(repo + ': count mismatch; interview=' + expected.length + ' mapped=' + mapped.length);
console.log('interview features: ' + repo + ' expected=' + expected.length + ' mapped=' + mapped.length);
