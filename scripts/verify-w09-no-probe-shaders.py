"""Prove the no-probe shared shader text equals the pinned W08 source."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def without_probes(source):
    stack = []
    active = True
    out = []
    for line in source.splitlines(keepends=True):
        token = line.strip()
        if token.startswith('// #if '):
            probe = token == '// #if probes'
            stack.append((probe, active))
            if probe:
                active = False
                continue
        elif token == '// #else' and stack and stack[-1][0]:
            active = stack[-1][1] and not active
            continue
        elif token == '// #endif' and stack:
            probe, parent = stack.pop()
            if probe:
                active = parent
                continue
        if active:
            out.append(line)
    assert not stack
    return ''.join(out)

report = []
for name in ['lighting.wgsl', 'terrain_material.wgsl']:
    relative = f'crates/forge3d-web/src/runtime/{name}'
    baseline = subprocess.check_output(['git','-c',f'safe.directory={ROOT.as_posix()}','-C',str(ROOT),'show',f'2dc0b9e:{relative}']).decode()
    current = without_probes((ROOT / relative).read_text(encoding='utf-8'))
    if current != baseline:
        import difflib
        raise RuntimeError(''.join(difflib.unified_diff(baseline.splitlines(True), current.splitlines(True), fromfile='W08', tofile='W09-no-probes')))
    report.append(dict(file=relative,bytes=len(current.encode()),sha256=hashlib.sha256(current.encode()).hexdigest(),exact=True))
assert without_probes((ROOT/'crates/forge3d-web/src/runtime/terrain_probes.wgsl').read_text(encoding='utf-8')) == ''
print(json.dumps(dict(baseline='2dc0b9e',sharedShaders=report,probeModuleAbsent=True),indent=2))
