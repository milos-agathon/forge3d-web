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
    print(json.dumps({"method": "independent Git tree and Python AST enumeration", "commit": REF, **result}))


if __name__ == "__main__":
    main()
