"""Dependency-free fixture sanity check; not the Nodeboard implementation or runtime test."""
import json
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[1] / 'fixtures'

def read(name):
    return json.loads((ROOT / name).read_text(encoding='utf-8'))

def check(board):
    classes = board['classes']; nodes = board['nodes']; edges = board['edges']
    ids = {n['id'] for n in nodes}; cids = {c['id'] for c in classes}
    assert len(ids) == len(nodes) and len(cids) == len(classes)
    assert len({e['id'] for e in edges}) == len(edges)
    assert all(n['classId'] in cids for n in nodes)
    assert all(r['to'] in cids for c in classes for r in c.get('relations', []))
    assert [c['key'] for c in classes] == list(range(1, len(classes)+1))
    pairs = Counter(tuple(sorted((c['id'],r['to']))) for c in classes for r in c.get('relations', []))
    dangling = [e['id'] for e in edges if e['from'] not in ids or e['to'] not in ids]
    return any(v > 1 for v in pairs.values()), dangling

assert check(read('legacy-valid.json')) == (False, [])
multi = read('legacy-multi-predicate.json')
assert check(multi) == (True, [])
assert len({(e['from'], e['label'], e['to']) for e in multi['edges']}) == 2
assert multi['nodes'][0]['properties']['extension'] == '00123'
assert check(read('legacy-invalid-endpoint.json')) == (False, ['demo-edge-support'])
print('PASS: all 3 synthetic fixtures match expected structural conditions.')
print('This is not a Nodeboard runtime, migration, or semantic-validation test.')
