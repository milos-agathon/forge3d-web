"""Regenerate the immutable W11 native sources from their pinned Git commit.
Run from anywhere; --check validates both Git provenance and checked-in bytes.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "crates/forge3d-web/tests/golden/w11"
manifest = json.loads((FIXTURES / "provenance.json").read_text())
assert manifest["baselineCommit"] == "bf8db93233e5158f6d226991fc5d230832c2d806"
for entry in manifest["sources"]:
    data = subprocess.check_output(["git", "-C", str(ROOT), "show", manifest["baselineCommit"] + ":" + entry["source"]])
    assert hashlib.sha256(data).hexdigest() == entry["sha256"], entry["source"]
    destination = FIXTURES / "native" / entry["file"]
    if "--check" in sys.argv:
        assert destination.read_bytes() == data, entry["file"]
    else:
        destination.write_bytes(data)
print(f"Verified {len(manifest['sources'])} native W11 source fixtures")
