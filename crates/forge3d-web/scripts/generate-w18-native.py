"""Freeze W18's actual final native contracts; never derive oracles from the web port."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import types

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = ROOT / "crates/forge3d-web"
COMMIT = "a55911f021925a3264e476374ce43d1b204f1073"
OUT = PACKAGE / "tests/fixtures/w18"
OUT.mkdir(parents=True, exist_ok=True)
def source(path, commit=COMMIT):
    return subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=ROOT)
paths = ["python/forge3d/diagnostics.py", "python/forge3d/map_scene.py", "python/forge3d/style.py"]
paths += [p for p in subprocess.check_output(["git", "ls-tree", "-r", "--name-only", COMMIT, "tests"], cwd=ROOT).decode().splitlines()
          if p.startswith(("tests/test_diagnostics_", "tests/test_mapscene_")) or p in (
              "tests/test_p1_diagnostics_contract.py", "tests/test_p2_diagnostics_contract.py",
              "tests/test_p2_large_scene_cache_lod_instancing.py", "tests/test_p2_textured_building_mapscene.py",
              "tests/test_p2_determinism_noop.py", "tests/test_p1_tiles3d_support.py",
              "tests/test_p2_large_scene_memory.py", "tests/test_p2_large_scene_bottlenecks.py")]
entries = []
for path in paths:
    raw = source(path)
    tree = ast.parse(raw)
    test_names = [n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name.startswith("test_")]
    target = OUT / "native" / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    historical = source(path, "bf8db93233e5158f6d226991fc5d230832c2d806")
    entries.append(dict(path=path, sha256=hashlib.sha256(raw).hexdigest(), historicalSha256=hashlib.sha256(historical).hexdigest(), tests=test_names))
module = types.ModuleType("w18_native_diagnostics")
sys.modules[module.__name__] = module
exec(source(paths[0]), module.__dict__)
calls = {
 "crs_mismatch": ["EPSG:4326", "EPSG:3857"], "missing_glyphs": [["é", "ß"]],
 "unsupported_style_field": ["roads", ["line-gradient"]], "unsupported_style_layer_type": ["heat", "heatmap"],
 "pro_gated_path": ["native building import"], "placeholder_fallback": ["zero geometry fallback"],
 "experimental_feature": ["curved labels"], "vt_unsupported_family": ["normal"],
 "python_public_3dtiles_incomplete": [], "estimated_gpu_memory": [4096, 2048],
 "label_rejection_summary": [{"collision": 2, "missing_glyph": 1}], "missing_label_field": ["name"],
 "unicode_coverage_gap": [["é", "ß"]], "unsupported_tile_format": ["i3dm"], "unsupported_tile_feature": ["implicit tiling"],
 "missing_external_asset": ["raster"], "missing_texture_path": ["missing.png"], "missing_uvs": [],
 "unsupported_texture_format": ["dds"], "unavailable_cache_lod_stats": ["tiles3d", ["cache_hits", "lod"]],
 "unsupported_instancing_path": ["product instances"], "unavailable_terrain_sampler": [],
}
fixtures, templates = [], {}
for code, args in calls.items():
    fn = getattr(module, code + "_diagnostic")
    kwargs = {"layer_id": "layer", "object_id": "object"}
    sig = __import__("inspect").signature(fn)
    kwargs = {k:v for k,v in kwargs.items() if k in sig.parameters and k not in list(sig.parameters)[:len(args)]}
    if code == "missing_external_asset": kwargs["path"] = "missing.tif"
    value = fn(*args, **kwargs).to_dict()
    fixtures.append(dict(code=code, args=args, kwargs=kwargs, expected=value))
    templates[code] = {k:value[k] for k in ("code", "severity", "message", "remediation", "support_level")}
report = module.ValidationReport(diagnostics=[module.Diagnostic.from_dict(v["expected"]) for v in fixtures])
# Execute the retained native support function independently of the web port.
# Parsing/evaluation is W19; this small record adapter supplies its layer fields.
style_tree = ast.parse(source(paths[2]))
style_globals = dict(module.__dict__)
class StyleSpec:
    def __init__(self, layers): self.layers = layers
style_globals["StyleSpec"] = StyleSpec
style_globals["Any"] = object
style_globals["parse_style"] = lambda raw: StyleSpec([types.SimpleNamespace(id=l.get("id", ""), layer_type=l.get("type", "")) for l in raw.get("layers", [])])
for node in style_tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ("P0_SUPPORTED_STYLE_LAYER_TYPES", "_SUPPORTED_PAINT_FIELDS", "_SUPPORTED_LAYOUT_FIELDS") for t in node.targets):
        exec(compile(ast.Module(body=[node],type_ignores=[]), "native-style-constants", "exec"), style_globals)
    if isinstance(node, ast.FunctionDef) and node.name == "validate_style_support":
        exec(compile(ast.Module(body=[node],type_ignores=[]), "native-style-validation", "exec"), style_globals)
styles = [
    {"layers":[{"id":"land","type":"fill","paint":{"fill-color":"#447744"}},{"id":"roads","type":"line","paint":{"line-width":2}},{"id":"cities","type":"circle","paint":{"circle-radius":4}}]},
    {"layers":[{"id":"roads","type":"line","paint":{"line-color":"white","line-gradient":["get","speed"]},"layout":{"line-sort-key":10}},{"id":"heat","type":"heatmap"}]},
    {"layers":[{"id":"place-labels","type":"symbol","layout":{"text-field":"{name}"}}]},
]
style_fixtures = [dict(input=s,expected=style_globals["validate_style_support"](s).to_dict()) for s in styles]
(OUT / "contract.json").write_text(json.dumps(dict(commit=COMMIT, sources=entries, factories=fixtures, report=report.to_dict(),styles=style_fixtures), indent=2, ensure_ascii=False)+"\n", encoding="utf8")
(PACKAGE / "src-ts/diagnostic-templates.ts").write_text(
    "// Generated from the hash-pinned final native diagnostics by generate-w18-native.py.\n"
    "export const diagnosticTemplates = " + json.dumps(templates, indent=2, ensure_ascii=False) + " as const;\n", encoding="utf8")
