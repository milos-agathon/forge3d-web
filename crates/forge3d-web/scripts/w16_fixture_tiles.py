"""Branching selection corpus executing the pinned native Python traverser."""
import json
import math
from pathlib import Path


def build_tile_references(dest, native):
    documents = {}
    for mode in ['ADD', 'REPLACE', 'mixed', 'inherited']:
        def tile(depth, path, center, span):
            index = int(path[-1]) if path else 0
            refine = (mode if mode in ['ADD', 'REPLACE'] else
                      ('ADD' if depth % 2 == 0 else 'REPLACE'))
            result = {
                'boundingVolume': ({'sphere': [*center, span]} if depth % 2 == 0 else
                                   {'box': [*center, span, 0, 0, 0, span*.75, 0, 0, 0, span*.5]}),
                'geometricError': 256 * .25**depth * (1 + index*.3),
                'content': {'uri': f'{mode}-{path or "root"}.pnts'},
            }
            if mode != 'inherited' or depth == 0:
                result['refine'] = refine
            if depth < 3:
                result['children'] = [tile(depth+1, path+str(i),
                    [center[0] + (-1 if i % 2 == 0 else 1)*span*.4,
                     center[1] + (-1 if i < 2 else 1)*span*.4,
                     center[2] + (i-1.5)*span*.1], span*.4) for i in range(4)]
                if depth == 1 and index == 2:
                    del result['content']
            return result
        documents[mode] = {'asset': {'version': '1.0'}, 'root': tile(0, '', [16, -23, 5], 256)}

    def native_tile(data):
        # Native _parse_tile defaults omitted refine to REPLACE. Its actual
        # traversal supports inheritance; construct that documented input
        # explicitly instead of silently accepting the parser's different policy.
        bounds = data['boundingVolume']
        shape = next(iter(bounds))
        return native.Tile(native.BoundingVolume(shape, bounds[shape]),
            data['geometricError'], refine=data.get('refine', ''),
            content=native.TileContent(data['content']['uri']) if 'content' in data else None,
            children=[native_tile(child) for child in data.get('children', [])])

    records = []
    for mode, document in documents.items():
        dataset = native.Tileset(Path('.'), '1.0', 256, native_tile(document['root']))
        for i in range(64):
            angle = i/64*2*math.pi
            camera = [16+180*math.cos(angle), -23+160*math.sin(angle), 5+12*2**(11*i/63)]
            # ADD also checks native depth clipping. REPLACE uses full depth:
            # web intentionally retains a coarse parent at its depth cap,
            # while native descends and drops it. That policy difference is
            # recorded explicitly below, not erased from the native data.
            options = {'sseThreshold': [4, 16, 64][i % 3],
                       'maxDepth': [0, 1, 2, 3][i % 4] if mode in ['ADD', 'inherited'] else 3}
            renderer = native.Tiles3dRenderer(sse_threshold=options['sseThreshold'], max_depth=options['maxDepth'])
            fov = [math.pi/4, math.pi/3][i % 2]
            height = [480, 1080, 1440][i % 3]
            renderer.set_viewport(height, fov)
            visible = renderer.get_visible_tiles(dataset, tuple(camera))
            records.append({'document': mode, 'options': options,
                'view': {'position': camera, 'viewportHeight': height, 'fovY': fov},
                'nodes': [{'uri': n.tile.content.uri, 'depth': n.depth, 'sse': round(float(n.sse), 9)} for n in visible]})
    unique = len({tuple(n['uri'] for n in r['nodes']) for r in records})
    assert unique >= 20, unique
    # Refine-negative control executes the same native traversal with REPLACE;
    # the close ADD record must lose its retained root.
    first = next(r for r in records if r['document'] == 'ADD' and r['options']['maxDepth'] == 3)
    mutated = json.loads(json.dumps(documents['ADD']))
    mutated['root']['refine'] = 'REPLACE'
    renderer = native.Tiles3dRenderer(sse_threshold=first['options']['sseThreshold'], max_depth=3)
    renderer.set_viewport(first['view']['viewportHeight'], first['view']['fovY'])
    negative = renderer.get_visible_tiles(native.Tileset(Path('.'), '1.0', 256, native_tile(mutated['root'])), tuple(first['view']['position']))
    assert [n.tile.content.uri for n in negative] != [n['uri'] for n in first['nodes']]
    result = {'schemaVersion': 1, 'oracle': 'pinned native Tiles3dRenderer.get_visible_tiles; direct Tile construction for omitted refine',
        'nativeSource': 'native/python__forge3d__tiles3d.py', 'documents': documents, 'records': records,
        'coverage': {'records': len(records), 'camerasPerDocument': 64, 'nodesPerDocument': 85,
                     'uniqueSelections': unique, 'refineNegativeControl': True},
        'policyDifferences': {'depthCapReplace': 'Web retains the coarse parent at maxDepth; native refines and then drops out-of-depth children.',
                             'geographicAndTransforms': 'Pinned Python does not apply world transforms and uses lon/lat for region centers; those web extensions retain separate unit coverage.'}}
    (dest/'tile-traversal-v2.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf8')
    return result['coverage']


if __name__ == '__main__':
    import ast
    import hashlib
    import sys
    import types
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root.parents[1]/'.tools/python'))
    dest = root/'tests/fixtures/w16'
    source = (dest/'native/python__forge3d__tiles3d.py').read_text(encoding='utf8')
    tree = ast.parse(source)
    tree.body = [n for n in tree.body if not isinstance(n, ast.ImportFrom) or n.level == 0]
    native = types.ModuleType('w16_native_tiles')
    sys.modules[native.__name__] = native
    exec(compile(tree, 'pinned-native-tiles.py', 'exec'), native.__dict__)
    manifest_path = dest/'copc-ept-tiles-v1.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf8'))
    manifest['expandedTileCoverage'] = build_tile_references(dest, native)
    manifest['files'] = [{'path': str(p.relative_to(dest)).replace('\\', '/'),
        'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
        for p in sorted(dest.rglob('*')) if p.is_file() and p.name != manifest_path.name]
    manifest_path.write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf8')
    print(json.dumps(manifest['expandedTileCoverage']))
