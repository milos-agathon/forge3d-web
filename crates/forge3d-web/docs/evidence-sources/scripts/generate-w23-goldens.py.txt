"""Execute the original single-tile NumPy workflow with browser-delivered input.

Only the file destination and I/O boundary are adapted; the historical main()
and its float32 normalization execute unchanged. This is a CPU conversion
oracle, not a native GPU visual claim. No browser code generates the oracle.
"""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
from types import SimpleNamespace
import zlib

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REF = '1f4084af428dc699bdcd108b029736cb73903926'
OUT = ROOT / 'tests/golden/w23'
CHECK = '--check' in sys.argv


def save(path, content):
    if CHECK:
        assert path.read_bytes() == content, f'Stale native conversion oracle: {path}'
    else:
        path.write_bytes(content)


def png(rgba):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    height, width, _ = rgba.shape
    scanlines = b''.join(b'\0' + row.tobytes() for row in rgba)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(scanlines)) + chunk(b'IEND', b'')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source = subprocess.check_output(['git', 'show', f'{REF}:examples/terrain_single_tile.py'], cwd=REPO)
    dem = np.load(ROOT / 'assets/datasets/mini_dem.npy').astype(np.float32)
    namespace = {'__name__': 'w23_native_example'}
    exec(compile(source, 'examples/terrain_single_tile.py', 'exec'), namespace)
    observed = {}

    def write_png(_path, rgba):
        observed['rgbaSha256'] = hashlib.sha256(rgba.tobytes()).hexdigest()
        observed['width'], observed['height'] = rgba.shape[1], rgba.shape[0]
        save(OUT / 'terrain-single-tile.png', png(rgba))

    namespace['_import_forge3d'] = lambda: SimpleNamespace(mini_dem=lambda: dem, numpy_to_png=write_png)
    assert namespace['main']() == 0
    manifest = {'generator': 'crates/forge3d-web/scripts/generate-w23-goldens.py', 'source': {'ref': REF, 'path': 'examples/terrain_single_tile.py', 'sha256': hashlib.sha256(source).hexdigest()}, 'input': 'assets/datasets/mini_dem.npy', 'method': 'Unchanged historical main(); browser input/file I/O boundary adapted; NumPy float32 normalization.', **observed}
    save(OUT / 'provenance.json', (json.dumps(manifest, indent=2) + '\n').encode('utf8'))
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
