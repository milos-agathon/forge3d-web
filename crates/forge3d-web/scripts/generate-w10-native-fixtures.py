"""Regenerate W10 truth by running pinned native sources, never web implementations.
Run after cargo test has built glam in CARGO_TARGET_DIR (or pass --cargo-target-dir).
"""
import argparse, hashlib, json, os, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "crates/forge3d-web/tests/golden/w10"
BUILD = ROOT / "target/w10-reference"
DEEP = "bf8db93233e5158f6d226991fc5d230832c2d806"
TV6 = "1f4084a"

def native(commit, path):
    return subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=ROOT).decode()

def digest(source):
    return hashlib.sha256(source.encode()).hexdigest()

def save(name, data):
    (FIXTURES / f"{name}.json").write_text(json.dumps(data, indent=2) + "\n")

def execute(path, dependencies=()):
    exe = BUILD / (path.stem + (".exe" if os.name == "nt" else ""))
    subprocess.run(["rustc", "--edition=2021", str(path), *dependencies, "-o", str(exe)], check=True)
    return subprocess.check_output([str(exe)]).decode().splitlines()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cargo-target-dir", default=os.environ.get("CARGO_TARGET_DIR", str(ROOT / "target")))
    args = parser.parse_args()
    BUILD.mkdir(parents=True, exist_ok=True)
    for name in ["sky", "clouds", "volumetric", "water_surface"]:
        path = f"src/shaders/{name}.wgsl"
        source = native(DEEP, path)
        save(name, dict(commit=DEEP, path=path, sha256=digest(source), source=source))
    path = "src/lighting/ephemeris.rs"
    source = native(DEEP, path)
    (BUILD / "ephemeris.rs").write_text(source)
    driver = BUILD / "main.rs"
    driver.write_text((FIXTURES / "harness/sun_main.rs").read_text())
    truth = json.loads((FIXTURES / "sun.json").read_text())
    for case, row in zip(truth["cases"], execute(driver), strict=True):
        azimuth, elevation, *direction = map(float, row.split(","))
        case.update(azimuth=azimuth, elevation=elevation, direction=direction)
    truth.update(commit=DEEP, path=path, sha256=digest(source), executor="rustc original native source (no web implementation)")
    truth.update(fixture="sun-vector-v1", tolerances=dict(angularDegrees=5e-9, directionAbs=1e-6, directionConvention="native to_direction: Y up, east -X, north -Z"))
    save("sun", truth)
    path = "src/viewer/terrain/volume_density.rs"
    source = native(TV6, path)
    body = source[source.index("fn generate_density_volume("):source.index("#[cfg(test)]")]
    driver = BUILD / "density.rs"
    driver.write_text((FIXTURES / "harness/density_types.rs").read_text() + body + (FIXTURES / "harness/density_main.rs").read_text())
    deps = Path(args.cargo_target_dir) / "debug/deps"
    glam = next(deps.glob("libglam-*.rlib"))
    rows = execute(driver, ["--extern", f"glam={glam}", "-L", f"dependency={deps}"])
    save("density", dict(provenance=dict(commit=TV6, path=path, sha256=digest(source), executor="rustc running unmodified native generator with its exact context/config types"), cases=[json.loads(row) for row in rows]))

if __name__ == "__main__":
    main()
