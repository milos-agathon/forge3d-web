"""Reproduce the host-dependent hillshade GEMV without modifying native ASTs.

Optionally compare the complete saved CI candidate, including every unchanged
field: --candidate test-results/ci39505427250/applications.json
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
# Load the same fixed backend before importing any numerical library.
spec = importlib.util.spec_from_file_location('w23_generator', ROOT / 'scripts/generate-w23-application-fixtures.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
import numpy as np
from w23_regional_fixtures import native, SOURCES


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path)
    args = parser.parse_args()
    golden_path = ROOT / 'tests/golden/w23/applications.json'
    golden = json.loads(golden_path.read_text(encoding='utf-8'))
    fused_document = copy.deepcopy(golden)
    helper = native('bosnia_terrain_landcover_viewer.py', ['_hillshade'])['_hillshade']
    rows = []
    for name, example in golden['examples'].items():
        for index, operation in enumerate(example['operations']):
            if 'shade' not in operation['expected']:
                continue
            value = operation['input']
            captured = {}

            def trace(frame, event, result):
                if frame.f_code is helper.__code__ and event == 'return':
                    captured.update(normal=frame.f_locals['normal'].copy(), light=frame.f_locals['light'].copy())

            previous = sys.getprofile()
            try:
                sys.setprofile(trace)
                actual = helper(np.array(value['dem'], dtype=np.float32).reshape(value['height'], value['width']),
                                value['azimuth'], value['elevation'], z_factor=value['zFactor']).ravel()
            finally:
                sys.setprofile(previous)
            expected = np.array(operation['expected']['shade'], dtype=np.float32)
            assert actual.tobytes() == expected.tobytes(), name + ': native non-fused bytes differ'
            # Float32 products are exact in float64. Reproduce each fused
            # multiply-add, rounding to float32 only after the addition.
            fused = []
            light = captured['light']
            for normal in captured['normal'].reshape(-1, 3):
                accumulator = np.float32(normal[0] * light[0])
                for channel in (1, 2):
                    accumulator = np.float32(math.fma(float(normal[channel]), float(light[channel]), float(accumulator)))
                fused.append(accumulator)
            fused = np.clip(np.array(fused, dtype=np.float32), 0, 1)
            changed = int(np.count_nonzero(actual != fused))
            assert changed > 0, name + ': FMA negative control did not change any shade'
            ulps = np.abs(actual.view(np.uint32).astype(np.int64) - fused.view(np.uint32).astype(np.int64))
            rows.append({'example': name, 'changedFloat32Values': changed,
                         'maximumAbsoluteDifference': float(np.max(np.abs(actual - fused))),
                         'maximumUlpDifference': int(ulps.max()),
                         'nativeSha256': hashlib.sha256(actual.tobytes()).hexdigest(),
                         'fusedSha256': hashlib.sha256(fused.tobytes()).hexdigest()})
            fused_document['examples'][name]['operations'][index]['expected']['shade'] = fused.tolist()
    assert len(rows) == 3 and sum(row['changedFloat32Values'] for row in rows) == 78
    candidate_digest = None
    if args.candidate:
        raw = args.candidate.read_bytes()
        candidate = json.loads(raw)
        assert candidate == fused_document, 'CI candidate is not exactly the FMA variant of the native document'
        candidate_digest = hashlib.sha256(raw).hexdigest()
    print(json.dumps({'native': SOURCES['bosnia_terrain_landcover_viewer.py'],
                      'goldenSha256': hashlib.sha256(golden_path.read_bytes()).hexdigest(),
                      'ciCandidateSha256': candidate_digest, 'allOtherCandidateFieldsUnchanged': bool(args.candidate),
                      'cases': rows}, indent=2))


if __name__ == '__main__':
    main()
