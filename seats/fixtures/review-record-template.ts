// Test-only mutations of an ACTUAL completed verify.ts record, never a hand-written format.
import fs from 'node:fs';
import assert from 'node:assert/strict';
export function reviewFixture(sample: string, bead: string, fields: Record<string, string> = {}): string {
  assert(sample.startsWith('# Verdict — bead '), 'real review sample header missing');
  const boundary = sample.indexOf('\n> Working copy only.'); assert(boundary > 0, 'real review sample boundary changed');
  let header = sample.slice(0, boundary), rest = sample.slice(boundary);
  const replace = (key: string, value: string) => {
    const regex = new RegExp('^- '+key+': .+$', 'gm'); assert.equal([...header.matchAll(regex)].length, 1, 'real sample field '+key);
    header = header.replace(regex, () => '- '+key+': '+value);
  };
  header = header.replace(/^# Verdict — bead .+$/m, () => '# Verdict — bead '+bead); replace('bead', bead);
  for (const [key,value] of Object.entries(fields)) replace(key,value);
  return header + rest;
}
export function writeReviewFixture(root: string, sampleFile: string, bead: string, fields: Record<string,string> = {}) {
  const text = reviewFixture(fs.readFileSync(sampleFile,'utf8'), bead, fields);
  fs.mkdirSync(root+'/seats/verdicts',{recursive:true}); fs.writeFileSync(root+'/seats/verdicts/'+bead+'.md',text); return text;
}
