# W23_OUTPUTS: ["crates/forge3d-web/examples/migration/applications-provenance.json","crates/forge3d-web/examples/migration/applications.json","crates/forge3d-web/tests/golden/w23/applications-provenance.json","crates/forge3d-web/tests/golden/w23/applications.json"]
"""Run pure analysis helpers extracted from the original regional examples.

Bounded inputs exercise the original numerical algorithms without downloading
regional datasets or importing their GIS stacks. Browser code is never used
to produce the expected values.
"""
import ast
from dataclasses import dataclass
import hashlib
import heapq
import json
import math
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REF = '1f4084af428dc699bdcd108b029736cb73903926'
SOURCES = {}
CHECK = '--check' in sys.argv


def save(path, value):
    data = (json.dumps(value, indent=2) + '\n').encode('utf8')
    if CHECK:
        assert path.read_bytes() == data, f'Stale native application oracle: {path}'
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def helpers(filename, names, constants=()):
    source = subprocess.check_output(['git', 'show', f'{REF}:examples/{filename}'], cwd=REPO).decode()
    tree = ast.parse(source)
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names]
    namespace = {'__name__': __name__, 'np': np, 'math': math, 'heapq': heapq, 'dataclass': dataclass}
    for n in tree.body:
        if isinstance(n, (ast.Assign, ast.AnnAssign)):
            targets = [t.id for t in n.targets if isinstance(t, ast.Name)] if isinstance(n, ast.Assign) else [n.target.id] if isinstance(n.target, ast.Name) else []
            if any(t in constants for t in targets):
                for t in targets:
                    namespace[t] = ast.literal_eval(n.value)
    code = 'from __future__ import annotations\n' + '\n'.join(ast.unparse(n) for n in nodes)
    exec(compile(code, filename, 'exec'), namespace)
    assert len(nodes) == len(names), (filename, names)
    SOURCES[filename] = {'ref': REF, 'path': 'examples/' + filename, 'sha256': hashlib.sha256(source.encode()).hexdigest(), 'helpers': names}
    return namespace


def main():
    out = {}
    b = helpers('belgium_bivariate_climate_map.py', ['_quantile_breaks', '_classify', '_bivariate_palette_color'], ['BLUEGOLD_4X4'])
    temperature = np.array([4, 8, 9, 7, 12, 13, 15, 18, 17, 19, 20, 22, 21, 23, 26, 28], dtype=np.float32)
    precipitation = np.array([40, 80, 60, 50, 90, 70, 110, 100, 120, 140, 130, 150, 170, 160, 180, 200], dtype=np.float32)
    mask = np.ones(16, dtype=bool)
    tb, pb = [b['_quantile_breaks'](v, (.25, .5, .75)) for v in [temperature, precipitation]]
    tc, pc = b['_classify'](temperature, tb, mask), b['_classify'](precipitation, pb, mask)
    palette = [[b['_bivariate_palette_color'](t, p) for t in range(1, 5)] for p in range(1, 5)]
    out['bivariate'] = {'temperature': temperature.tolist(), 'precipitation': precipitation.tolist(), 'temperatureBreaks': tb, 'precipitationBreaks': pb, 'temperatureClasses': tc.tolist(), 'precipitationClasses': pc.tolist(), 'palette': palette}

    rem = helpers('colorado_rem_forge3d.py', ['_apply_idw_from_neighbors'])
    coordinates = [[x, y] for y in range(4) for x in range(4)]
    river = np.array([[0, 1], [1, 1], [2, 2], [3, 2]], dtype=np.float32)
    values = np.array([2, 2.5, 3, 3.5], dtype=np.float32)
    distances = np.linalg.norm(np.asarray(coordinates)[:, None, :] - river[None, :, :], axis=2).astype(np.float32)
    indices = np.tile(np.arange(4), (16, 1))
    water = rem['_apply_idw_from_neighbors'](distances, indices, values, power=2)
    dem = np.array([4 + x / 2 + y / 3 for x, y in coordinates], dtype=np.float32)
    out['rem'] = {'coordinates': coordinates, 'river': river.tolist(), 'riverHeights': values.tolist(), 'dem': dem.tolist(), 'waterSurface': water.tolist(), 'relativeElevation': (dem - water).tolist()}

    travel = helpers('barcelona_travel_time_3d.py', ['parse_maxspeed', 'dijkstra_seconds'])
    graph = {0: [(1, 30), (2, 100)], 1: [(0, 30), (2, 40), (3, 120)], 2: [(0, 100), (1, 40), (3, 20)], 3: [(1, 120), (2, 20), (4, 15)], 4: [(3, 15)]}
    speeds = [None, '30 mph', '50;60', [40], 'none', '0', 25]
    out['travel'] = {'graph': graph, 'start': 0, 'speeds': speeds, 'parsedSpeeds': [travel['parse_maxspeed'](v) for v in speeds], 'seconds': travel['dijkstra_seconds'](graph, start=0, allowed=set(graph))}

    solar = helpers('rotterdam_solar_potential_shadow_study.py', ['roof_normal_for_solar', 'orientation_factor'])
    solar['city'] = SimpleNamespace(normalize=lambda v: v / max(np.linalg.norm(v), 1e-12))
    roofs = [{'slope_deg': s, 'aspect_deg': a} for s, a in [(0, 180), (35, 180), (35, 0), (60, 90)]]
    assumptions = SimpleNamespace(orientation_penalty=.2, slope_penalty=.15)
    out['solar'] = {'roofs': roofs, 'orientationPenalty': .2, 'slopePenalty': .15, 'normals': [solar['roof_normal_for_solar'](SimpleNamespace(**r)).tolist() for r in roofs], 'factors': [solar['orientation_factor'](SimpleNamespace(**r), assumptions) for r in roofs]}

    transition = helpers('khumbu_icefall_sentinel_timelapse.py', ['FramePlanItem', 'build_frame_plan'], ['DEFAULT_CROSSFADE_FRAMES'])
    scenes = [SimpleNamespace(id='scene-' + str(i)) for i in range(3)]
    plan = transition['build_frame_plan'](scenes, fps=2, duration=4, preview_only=False, crossfade_frames=2)
    out['satellite'] = {'sceneIds': [s.id for s in scenes], 'fps': 2, 'duration': 4, 'crossfadeFrames': 2, 'plan': [{'index': p.index, 'scene': p.scene.id, 'labelScene': p.label_scene.id, 'peer': p.blend_scene.id if p.blend_scene else None, 'alpha': p.blend_alpha, 'opacity': p.label_opacity} for p in plan]}
    from w23_regional_fixtures import build_cases
    out['examples'], regional_sources = build_cases(out)
    SOURCES.update(regional_sources)
    target = ROOT / 'tests/golden/w23'
    save(target / 'applications.json', out)
    save(target / 'applications-provenance.json', {'generator': 'crates/forge3d-web/scripts/generate-w23-application-fixtures.py', 'method': 'Original Python AST helper bodies executed with bounded typed data; independent of browser implementation.', 'sources': SOURCES})
    print(json.dumps({'legacyKernels': 5, 'examples':len(out['examples']),'operations':sum(len(v['operations'])for v in out['examples'].values()), 'sources': len(SOURCES)}))


if __name__ == '__main__':
    main()
