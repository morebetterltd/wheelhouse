#!/usr/bin/env python3
"""Assert inner full-sweep coverage, excluding the migration bridge's receipt."""
from collections import Counter
from pathlib import Path
import json
import re
import sys

log, inventory, exit_file = map(Path, sys.argv[1:])
assert log.is_file() and inventory.is_file() and exit_file.is_file()
expected = inventory.read_text().splitlines()
assert expected and len(expected) == len(set(expected))
records = {kind: [] for kind in ('START', 'PASS', 'FAIL')}
bridge = {kind: [] for kind in records}
summaries = []
for line in log.read_text().splitlines():
    for kind in records:
        prefix = f'selftest-sweep: {kind} '
        if line.startswith(prefix):
            subject = line[len(prefix):]
            summary = re.fullmatch(r'\((\d+) suite\(s\)\)', subject)
            if summary:
                assert kind == 'PASS', line
                summaries.append(int(summary[1]))
                continue
            if subject.endswith('/bridge.selftest.sh'):
                bridge[kind].append(subject)
            else:
                assert '/seats/' in subject, subject
                records[kind].append('seats/' + subject.split('/seats/', 1)[1])
assert Counter(records['START']) == Counter(expected), records['START']
assert Counter(records['PASS']) == Counter(expected), records['PASS']
assert not records['FAIL'], records['FAIL']
assert len(bridge['START']) == len(bridge['PASS']) == 1 and not bridge['FAIL']
assert sorted(summaries) == sorted([len(expected), 1]), summaries
assert exit_file.read_text().strip() == '0'
assert 'umbrella safety: PASS (' in log.read_text()
assert 'STOP unsafe umbrella mutation' not in log.read_text()
print(json.dumps({'innerStart': len(records['START']),
                  'innerPass': len(records['PASS']), 'innerFail': 0,
                  'bridgeStart': 1, 'bridgePass': 1, 'exit': 0,
                  'inventoryExact': True}, sort_keys=True))
