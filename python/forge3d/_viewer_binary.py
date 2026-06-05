from __future__ import annotations

import shutil
import sys
from pathlib import Path

_VIEWER_BINARY_NAMES = ("forge3d-viewer", "interactive_viewer")


def find_viewer_binary(module_file: str) -> str:
    """Resolve the best available native viewer command/binary."""
    suffix = ".exe" if sys.platform == "win32" else ""

    repo_root = Path(module_file).resolve().parent.parent.parent
    cargo_target = repo_root / "target"

    for binary_name in _VIEWER_BINARY_NAMES:
        repo_candidates = []
        for profile in ("release", "debug"):
            binary = cargo_target / profile / f"{binary_name}{suffix}"
            if binary.exists():
                repo_candidates.append(binary)
        if repo_candidates:
            newest = max(repo_candidates, key=lambda path: path.stat().st_mtime_ns)
            return str(newest)

    scripts_dir = Path(sys.executable).resolve().parent
    for binary_name in _VIEWER_BINARY_NAMES:
        installed_script = scripts_dir / f"{binary_name}{suffix}"
        if installed_script.exists():
            return str(installed_script)

    for binary_name in _VIEWER_BINARY_NAMES:
        path_binary = shutil.which(binary_name)
        if path_binary:
            return path_binary

    raise FileNotFoundError(
        "Could not find forge3d-viewer or interactive_viewer. "
        "Install forge3d with pip so the console script is created, "
        "or build with: cargo build --release --bin forge3d-viewer"
    )
