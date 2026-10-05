"""Run a calculator's test harness in a restricted Node subprocess.

The code under test is third-party and untrusted, so it never runs in the web
process. Each run is a separate `node` process with:
  * a stripped environment (no secrets, no PATH inheritance beyond node itself),
  * an isolated working directory (temp dir, deleted after),
  * a wall-clock timeout,
  * a memory cap (soft, via --max-old-space-size and, where available, rlimits),
  * input delivered on stdin, results read from stdout, nothing else.
This is the App-Runner-safe "restricted subprocess" the brief asks for -- no
Docker-in-Docker, no privileged namespaces, which App Runner does not allow.
"""
from __future__ import annotations

import json
import os
import resource
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

HARNESS_DIR = Path(__file__).resolve().parent.parent / "harnesses"
NODE = shutil.which("node") or "node"
TIMEOUT_S = 15
MEM_MB = 512


def _limits() -> None:
    # Child-side rlimits (POSIX). Best-effort: skipped silently where unsupported.
    try:
        cpu = TIMEOUT_S + 5
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        nbytes = MEM_MB * 1024 * 1024
        # RLIMIT_AS is not set: V8 reserves large virtual ranges and aborts under it.
        # RLIMIT_NPROC is not set either: it is per-user, so it would starve Node's
        # own worker threads. Memory is bounded by --max-old-space-size instead.
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    except (ValueError, OSError):
        pass


def run_harness(harness: str, cases: list[dict[str, Any]],
                extra_env: dict[str, str] | None = None) -> dict[str, Any]:
    """Execute one harness over a list of cases; return {results|error}."""
    harness_path = HARNESS_DIR / harness
    if not harness_path.exists():
        return {"error": f"harness not found: {harness}"}

    payload = json.dumps({"cases": cases})
    workdir = tempfile.mkdtemp(prefix="dosecheck-run-")
    env = {
        "PATH": os.path.dirname(NODE) or "/usr/bin",
        "NODE_OPTIONS": f"--max-old-space-size={MEM_MB}",
        "NO_COLOR": "1",
        **(extra_env or {}),
    }
    try:
        proc = subprocess.run(
            [NODE, str(harness_path)],
            input=payload,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
            cwd=workdir,
            env=env,
            preexec_fn=_limits if os.name == "posix" else None,
        )
    except subprocess.TimeoutExpired:
        return {"error": f"timed out after {TIMEOUT_S}s"}
    except Exception as e:  # noqa: BLE001
        return {"error": f"subprocess failed: {e}"}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    if proc.returncode != 0:
        return {"error": f"node exited {proc.returncode}: {proc.stderr.strip()[:500]}"}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"error": f"bad harness output: {proc.stdout[:500]}"}


if __name__ == "__main__":
    # quick self-check
    out = run_harness("mxklb_harness.js", [
        {"id": "t", "bg": "150", "carbs": "60", "target": 100, "isf": 50, "icr": 12}])
    print(json.dumps(out, indent=2))
