"""Verify pinned W12 provenance and convert the shipped Luxembourg rail GPKG.
Run with --check to compare source hashes and regenerated network bytes.
The fixed projection conversion belongs to this fixture, not the W14 CRS API.
"""
from pathlib import Path
import hashlib
import json
import sqlite3
import struct
import subprocess
import sys
import tempfile
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "crates/forge3d-web/tests/golden/w12"
manifest = json.loads((BASE / "provenance.json").read_text(encoding="utf-8"))
commit = manifest["baselineCommit"]
assert commit == "bf8db93233e5158f6d226991fc5d230832c2d806"
for entry in manifest["sources"]:
    data = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{entry.get('commit', commit)}:{entry['source']}"])
    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
    if "commit" not in entry:
        contract = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{manifest['contractCommit']}:{entry['source']}"])
        assert contract == data, f"Native contract drift: {entry['source']}"
    destination = BASE / "native" / entry["file"]
    if "--check" in sys.argv:
        assert destination.read_bytes() == data
    else:
        destination.write_bytes(data)

def geometry(data, offset=0):
    endian = "<" if data[offset] else ">"
    kind = struct.unpack_from(endian + "I", data, offset + 1)[0]
    offset += 5
    dimensions = 2 if kind < 1000 else 3
    kind %= 1000
    count = struct.unpack_from(endian + "I", data, offset)[0]
    offset += 4
    if kind == 2:
        points = []
        for _ in range(count):
            values = struct.unpack_from(endian + "d" * dimensions, data, offset)
            offset += dimensions * 8
            points.append(values[:2])
        return [points], offset
    if kind == 5:
        lines = []
        for _ in range(count):
            more, offset = geometry(data, offset)
            lines.extend(more)
        return lines, offset
    raise ValueError(f"unsupported rail WKB type {kind}")

asset = "assets/gpkg/luxembourg_rail.gpkg"
data = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{commit}:{asset}"])
with tempfile.TemporaryDirectory(prefix="forge3d-w12-") as temporary:
    path = Path(temporary) / "rails.gpkg"
    path.write_bytes(data)
    connection = sqlite3.connect(path)
    table, column, srs = connection.execute("SELECT table_name,column_name,srs_id FROM gpkg_geometry_columns").fetchone()
    organization, code = connection.execute("SELECT organization,organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id=?", (srs,)).fetchone()
    transform = Transformer.from_crs(f"{organization}:{code}", "EPSG:3035", always_xy=True)
    lines = []
    for feature_id, binary in connection.execute(f'SELECT rowid,"{column}" FROM "{table}" ORDER BY rowid'):
        if binary is None:
            continue
        flags = binary[3]
        envelope = (flags >> 1) & 7
        offset = 8 + {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}[envelope] * 8
        parts, _ = geometry(binary, offset)
        for part in parts:
            projected = [transform.transform(x, y) for x, y in part]
            if len(projected) >= 2:
                lines.append((feature_id, projected))
    connection.close()
all_points = [p for _, line in lines for p in line]
min_x, max_x = min(p[0] for p in all_points), max(p[0] for p in all_points)
min_y, max_y = min(p[1] for p in all_points), max(p[1] for p in all_points)
center = [(min_x + max_x) / 2, (min_y + max_y) / 2]
scale = 500 / max(max_x - min_x, max_y - min_y)
features = [{"id": index + 1, "kind": "line", "positions": [[round((x - center[0]) * scale, 6), 0, round(-(y - center[1]) * scale, 6)] for x, y in line], "properties": {"nativeFeatureId": feature_id}} for index, (feature_id, line) in enumerate(lines)]
output = {"source": {"commit": commit, "path": asset, "sha256": hashlib.sha256(data).hexdigest(), "crs": "EPSG:3035", "origin": center, "worldUnitsPerMetre": scale}, "features": features}
encoded = (json.dumps(output, separators=(",", ":")) + "\n").encode()
destination = ROOT / "crates/forge3d-web/assets/w12/luxembourg-rail.json"
if "--check" in sys.argv:
    assert destination.read_bytes() == encoded
else:
    destination.write_bytes(encoded)
print(f"Verified {len(manifest['sources'])} native sources; converted {len(features)} Luxembourg rail lines / {len(all_points)} positions")
