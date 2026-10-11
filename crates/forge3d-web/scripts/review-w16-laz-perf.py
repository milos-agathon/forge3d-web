#!/usr/bin/env python3
"""Read-only advisory capture and WASM comparison for the W16 codec review."""
import argparse
import datetime
import hashlib
import json
import pathlib
import urllib.request

SOURCE_COMMIT = "d0d3047e05221421fa0b02b3da4e93797edb2c52"
LICENSE_COMMIT = "f2e7491902dc06bf4ce0a4577d3af3b98f280b2a"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, payload=None):
    headers = {"User-Agent": "forge3d-w16-codec-review", "Accept": "application/json"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    request = urllib.request.Request(url, body, headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read()
        return {"url": url, "request": payload, "status": response.status,
                "responseSha256": sha(raw), "response": json.loads(raw)}


def advisories():
    captures = {}
    queries = {
        "osvNpm": {"version": "0.0.7", "package": {"name": "laz-perf", "ecosystem": "npm"}},
        "osvPublishedSource": {"commit": SOURCE_COMMIT},
        "osvLicenseSource": {"commit": LICENSE_COMMIT},
    }
    for name, query in queries.items():
        captures[name] = fetch("https://api.osv.dev/v1/query", query)
    for kind in ("reviewed", "unreviewed", "malware"):
        captures["github" + kind.title()] = fetch(
            "https://api.github.com/advisories?ecosystem=npm&affects=laz-perf%400.0.7"
            f"&type={kind}&per_page=100")
    captures["githubUpstream"] = fetch(
        "https://api.github.com/repos/hobuinc/laz-perf/security-advisories?per_page=100")
    captures["npmMetadata"] = fetch("https://registry.npmjs.org/laz-perf/0.0.7")
    return {"schemaVersion": 1, "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "sourceCommit": SOURCE_COMMIT, "licenseCommit": LICENSE_COMMIT,
            "captures": captures,
            "interpretation": "Empty lists mean no published matching advisory; they do not certify safety."}


class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def byte(self):
        result = self.data[self.pos]
        self.pos += 1
        return result

    def uleb(self):
        result = shift = 0
        while True:
            byte = self.byte()
            result |= (byte & 127) << shift
            if byte < 128:
                return result
            shift += 7
            if shift > 64:
                raise ValueError("invalid ULEB")

    def name(self):
        size = self.uleb()
        result = self.data[self.pos:self.pos + size].decode("utf8")
        self.pos += size
        return result

    def limits(self):
        flags, minimum = self.uleb(), self.uleb()
        return {"flags": flags, "minimumPages": minimum,
                "maximumPages": self.uleb() if flags & 1 else None}


def inspect(data):
    if data[:8] != b"\x00asm\x01\x00\x00\x00":
        raise ValueError("Expected WebAssembly version 1")
    reader = Reader(data)
    reader.pos = 8
    sections, imports, exports, memories = [], [], [], []
    names = ["custom", "type", "import", "function", "table", "memory", "global",
             "export", "start", "element", "code", "data", "dataCount"]
    while reader.pos < len(data):
        offset, section_id = reader.pos, reader.byte()
        size = reader.uleb()
        payload = data[reader.pos:reader.pos + size]
        sub = Reader(payload)
        name = names[section_id] if section_id < len(names) else str(section_id)
        if section_id == 0:
            name += ":" + sub.name()
        sections.append({"name": name, "id": section_id, "offset": offset,
                         "payloadBytes": size, "payloadSha256": sha(payload)})
        if section_id == 2:
            for _ in range(sub.uleb()):
                module, field, kind = sub.name(), sub.name(), sub.byte()
                entry = {"module": module, "name": field, "kind": kind}
                if kind == 0:
                    entry["typeIndex"] = sub.uleb()
                elif kind == 1:
                    entry["elementType"] = sub.byte()
                    entry["limits"] = sub.limits()
                elif kind == 2:
                    entry["limits"] = sub.limits()
                    memories.append({"imported": True, **entry["limits"]})
                elif kind == 3:
                    entry["valueType"], entry["mutable"] = sub.byte(), sub.byte()
                else:
                    raise ValueError("Unexpected import kind")
                imports.append(entry)
        elif section_id == 5:
            for _ in range(sub.uleb()):
                memories.append({"imported": False, **sub.limits()})
        elif section_id == 7:
            for _ in range(sub.uleb()):
                exports.append({"name": sub.name(), "kind": sub.byte(), "index": sub.uleb()})
        reader.pos += size
    return {"bytes": len(data), "sha256": sha(data), "sections": sections,
            "imports": imports, "exports": exports, "memories": memories}


def compare(published, rebuilt):
    left, right = pathlib.Path(published).read_bytes(), pathlib.Path(rebuilt).read_bytes()
    # Each nonmatching contiguous byte span includes exact original/rebuilt bytes.
    # There is no disassembly normalization or omission of custom sections.
    spans, index = [], 0
    while index < max(len(left), len(right)):
        if left[index:index + 1] == right[index:index + 1]:
            index += 1
            continue
        start = index
        while index < max(len(left), len(right)) and left[index:index + 1] != right[index:index + 1]:
            index += 1
        spans.append({"offset": start, "publishedHex": left[start:index].hex(),
                      "rebuiltHex": right[start:index].hex()})
    return {"schemaVersion": 1, "sourceCommit": SOURCE_COMMIT,
            "published": inspect(left), "rebuilt": inspect(right),
            "byteIdentical": left == right, "byteDifferences": spans}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    advisory = commands.add_parser("advisories")
    advisory.add_argument("--output", required=True)
    comparison = commands.add_parser("compare")
    comparison.add_argument("--published", required=True)
    comparison.add_argument("--rebuilt", required=True)
    comparison.add_argument("--output", required=True)
    args = parser.parse_args()
    result = advisories() if args.command == "advisories" else compare(args.published, args.rebuilt)
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
    print(f"Recorded {args.command}: {output} (sha256 {sha(output.read_bytes())})")


if __name__ == "__main__":
    main()
