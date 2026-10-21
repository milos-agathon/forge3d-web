# W23_OUTPUTS: ["crates/forge3d-web/tests/fixtures/w17/trace-sdf-v1.json","crates/forge3d-web/tests/fixtures/w17/native/852b74d/tests/test_sdf_python.py","crates/forge3d-web/tests/fixtures/w17/native/d14577a/tests/*.py"]
"""Independent, byte-reproducible W00 trace-sdf-v1 reference generator."""
import hashlib
import json
import pathlib
import struct
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / "crates/forge3d-web/tests/fixtures/w17"
OUT.mkdir(parents=True, exist_ok=True)
deep = "bf8db93233e5158f6d226991fc5d230832c2d806"
contracts = "d14577a"
paths = subprocess.check_output(
    ["git", "ls-tree", "-r", "--name-only", deep, "src/accel", "src/sdf", "src/path_tracing"], cwd=ROOT, text=True
).splitlines()
shader_paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", deep, "src/shaders"], cwd=ROOT, text=True).splitlines()
paths += [p for p in shader_paths if pathlib.PurePosixPath(p).name.startswith(("pt_", "lbvh_", "sdf_", "hybrid_")) or pathlib.PurePosixPath(p).name in ("bvh_refit.wgsl", "radix_sort_pairs.wgsl", "ao_from_aovs.wgsl", "lighting_media.wgsl")]
sources = [(deep, p) for p in paths]
sources += [(contracts, "tests/" + p) for p in [
    "test_bvh_cpu_vs_gpu.py", "test_mesh_tracing_gpu.py", "test_path_tracing_api.py",
    "test_wavefront_parity.py", "test_restir.py", "test_guiding.py", "test_media_hg.py",
]]
sources += [("852b74d", "tests/test_sdf_python.py"),
            ("1f4084a", "python/forge3d/path_tracing.py"),
            ("1f4084a", "python/forge3d/sdf.py")]
native = []
for ref, path in sources:
    commit = subprocess.check_output(["git", "rev-parse", ref], cwd=ROOT, text=True).strip()
    data = subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=ROOT)
    dest = "native/" + commit[:7] + "/" + path
    target = OUT / dest
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    native.append(dict(commit=commit, source=path, fixture=dest, sha256=hashlib.sha256(data).hexdigest()))

# Two 128x128 tessellated sheets, one at z=0 and one at z=-2.
# IDs and barycentrics are analytic; they do not call either implementation.
triangles = hashlib.sha256()
for layer in range(2):
    for y in range(128):
        for x in range(128):
            a, b, c, d = (x-64, y-64, -2*layer), (x-63, y-64, -2*layer), (x-63, y-63, -2*layer), (x-64, y-63, -2*layer)
            for j, vs in enumerate([(a, b, c), (a, c, d)]):
                triangles.update(struct.pack("<9fII", *(v for p in vs for v in p), 1+layer*32768+2*(y*128+x)+j, 0))
ray_hash, hit_hash = hashlib.sha256(), hashlib.sha256()
for y in range(1024):
    for x in range(1024):
        u, v = (x % 8 + .25)/8, (y % 8 + .5)/8
        ray_hash.update(struct.pack("<6f", x//8-64+u, y//8-64+v, 5, 0, 0, -1))
        index = 1+2*((y//8)*128+x//8)+(v > u)
        bary = (1-u, u-v, v) if v <= u else (1-v, u, v-u)
        hit_hash.update(struct.pack("<If3f", index, 5, *bary))
manifest = dict(schemaVersion=1, fixtureId="trace-sdf-v1", seed=1597463007,
                triangles=65536, sdfPrimitives=128, rays=1048576, spp=[1,4,16,64],
                generator="scripts/generate-w17-fixture.py", triangleSha256=triangles.hexdigest(),
                raySha256=ray_hash.hexdigest(), analyticHitsSha256=hit_hash.hexdigest(),
                sdf="128 unit spheres at (140+3*i,0,0), union in ascending order; 255 DAG nodes",
                imageOracle="Lambert sheet with emission .5, albedo .08, environment .8: .5+.08*.8*(.5+1/(3*pi))",
                nativeSources=native)
(OUT / "trace-sdf-v1.json").write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf-8")
print(json.dumps({k:v for k,v in manifest.items() if k != "nativeSources"}, indent=2))
