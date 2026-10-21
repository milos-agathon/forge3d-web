"""Independently enumerate native coverage using Git and Python's parser.

This is an authoring/CI audit, never a browser or package runtime dependency.
The inventory generator uses regular expressions; this audit uses AST nodes.
"""
import ast
from collections import Counter
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
REF = "1f4084af428dc699bdcd108b029736cb73903926"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def main():
    inventory = json.loads((ROOT / "crates/forge3d-web/tests/parity/composite-inventory.json").read_text(encoding="utf-8"))
    records = inventory["records"]
    result = {}
    public_source = git("show", "a55911f021925a3264e476374ce43d1b204f1073:python/forge3d/__init__.py").decode("utf-8")
    assignments = {}
    for node in ast.walk(ast.parse(public_source)):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in ("__all__", "_BUNDLE_EXPORT_NAMES"):
                    assignments[target.id] = ast.literal_eval(node.value)
    exports = set(assignments["__all__"]) | set(assignments["_BUNDLE_EXPORT_NAMES"])
    assert exports == {r["name"] for r in records if r["kind"] == "package-root-export"}
    result["astPublicExports"] = len(exports)
    assert result["astPublicExports"] == 220
    for directory, kind, expected in [("tests", "native-test-file", 211), ("examples", "native-example", 54), ("docs", "native-doc-asset", 88)]:
        paths = git("ls-tree", "-r", "--name-only", REF, "--", directory).decode().splitlines()
        actual = {r["source"]["path"] for r in records if r["kind"] == kind}
        assert set(paths) == actual, (directory, sorted(set(paths) ^ actual))
        assert len(paths) == expected
        result[directory] = len(paths)
        if directory == "docs":
            result["documentationPages"] = sum(p.endswith((".md", ".rst")) for p in paths)
            assert result["documentationPages"] == 53
        if directory != "tests":
            continue
        result["namedTestFiles"] = sum(p.startswith("tests/test_") and p.endswith(".py") for p in paths)
        functions = Counter()
        for path in paths:
            if not path.endswith(".py"):
                continue
            source = git("show", f"{REF}:{path}").decode("utf-8-sig")
            parsed = ast.parse(source, filename=path)
            for node in ast.walk(parsed):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
                    functions[(path, node.name)] += 1
        indexed = Counter((r["source"]["path"], r["name"]) for r in records if r["kind"] == "native-test-definition")
        assert functions == indexed, {"missing": list((functions - indexed).items()), "extra": list((indexed - functions).items())}
        result["astTestDefinitions"] = sum(functions.values())
        assert result["namedTestFiles"] == 191
        assert result["astTestDefinitions"] == 1792
    coverage = json.loads((ROOT / 'docs/parity/w23-coverage.json').read_text(encoding='utf8'))
    examples = {e['nativePath']: set(e['workflows']) for e in coverage['examples']}
    critical = {
        'mini_dem': {'datasets', 'singleTile'}, 'render_triangle_png': {'triangle'},
        'from_hdr': {'ibl'}, 'TerrainOrbitRig': {'rigs'}, 'TerrainRailRig': {'rigs'}, 'TerrainTargetFollowRig': {'rigs'},
        'apply_preset': {'presets'}, 'render_terrain_pbr_pom': {'materials'},
        'MapPlate': {'furniture'}, 'export_svg': {'furniture'}, 'export_pdf': {'furniture'},
        'load_style': {'style'}, 'save_bundle': {'bundle'},
    }
    missing = []
    call_requirements = 0
    for record in records:
        path = record['source']['path']
        if record['kind'] != 'native-example' or not path.endswith(('.py', '.ipynb')):
            continue
        source = git('show', f"{record['source']['ref']}:{path}").decode('utf8')
        if path.endswith('.ipynb'):
            source = '\n'.join(''.join(c['source']) for c in json.loads(source)['cells'] if c['cell_type'] == 'code')
            source = '\n'.join(line for line in source.splitlines() if not line.lstrip().startswith(('%', '!')))
        calls = {n.func.attr if isinstance(n.func, ast.Attribute) else n.func.id for n in ast.walk(ast.parse(source)) if isinstance(n, ast.Call) and isinstance(n.func, (ast.Attribute, ast.Name))}
        for name, destinations in critical.items():
            if name in calls:
                call_requirements += 1
                if not destinations & examples[path]:
                    missing.append({'example': path, 'nativeCall': name, 'requiredBrowserStep': sorted(destinations)})
    assert not missing, missing
    result['criticalExampleCallRequirements'] = call_requirements
    print(json.dumps({"method": "independent Git tree and Python AST enumeration", "commit": REF, **result}))


if __name__ == "__main__":
    main()
