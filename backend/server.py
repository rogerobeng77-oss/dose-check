"""Dose Check API + static React build, one port."""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine import agent
from engine.targets import TARGETS

app = FastAPI(title="Dose Check")
DIST = Path(os.environ.get("DIST_DIR", Path(__file__).resolve().parent.parent / "frontend" / "dist"))

_live_lock = threading.Lock()
_live_runs: dict[str, dict] = {}
_live_count = {"n": 0, "window": time.time()}
LIVE_LIMIT_PER_HOUR = 6


def _view(run: dict) -> dict:
    return run


@app.get("/api/targets")
def targets():
    out = []
    for tid, spec in TARGETS.items():
        run = _live_runs.get(tid) or agent.load_cached(tid)
        s = run["summary"] if run else None
        out.append({"id": tid, "name": spec["name"], "licence": spec["licence"],
                    "language": spec["language"], "stars": spec["stars"],
                    "summary": s})
    return out


@app.get("/api/runs/{tid}")
def run(tid: str):
    if tid not in TARGETS:
        raise HTTPException(404)
    r = _live_runs.get(tid) or agent.load_cached(tid)
    if not r:
        raise HTTPException(404, "no run")
    return r


@app.get("/api/schema/{tid}")
def schema(tid: str):
    if tid not in TARGETS:
        raise HTTPException(404)
    s = TARGETS[tid]
    return {"input_schema": s["input_schema"], "settings": s["settings"],
            "typed": agent.TYPED[tid]}


class Probe(BaseModel):
    inputs: dict


@app.post("/api/probe/{tid}")
def probe(tid: str, body: Probe):
    """Run the real calculator on one input set and score it. No model call."""
    if tid not in TARGETS:
        raise HTTPException(404)
    h = dict(TARGETS[tid]["settings"])
    for k, v in body.inputs.items():
        h[k] = v
    if tid == "mxklb":
        for k in ("target", "isf", "icr"):
            h[k] = float(h[k])
    if tid == "nightscout":
        for k in agent.TYPED[tid]:
            if k in h:
                h[k] = agent._num(h[k])
        if h.get("iob") is None:
            h["iob"] = 0
    # let the oracle infer what kind of probe this is
    cat = "nominal"
    probe_case = {"id": "try", "category": "nominal", "harness_inputs": h}
    vals = [str(h.get(k, "")).strip() for k in agent.TYPED[tid] if k in h]
    nums = [agent._num(v) for v in vals]
    if any(n is not None and n < 0 for n in nums):
        cat = "input_validation"
    elif any(v == "" for v in vals):
        cat = "missing_value"
    elif any("," in v or v.startswith(".") for v in vals):
        cat = "locale_decimal"
    elif tid == "pancreas" and (agent._num(h.get("ratio")) == 0 or agent._num(h.get("correction")) == 0):
        cat = "divide_by_zero"
    probe_case["category"] = cat
    if tid == "pancreas" and h.get("iob_U"):
        probe_case["iob_U"] = agent._num(h.get("iob_U"))
    try:
        res = agent.execute(tid, [probe_case])[0]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e))
    return res


@app.post("/api/run/{tid}")
def live_run(tid: str):
    """Re-run the whole agent against Token Factory. Costs tokens; rate limited."""
    if tid not in TARGETS:
        raise HTTPException(404)
    with _live_lock:
        now = time.time()
        if now - _live_count["window"] > 3600:
            _live_count.update(n=0, window=now)
        if _live_count["n"] >= LIVE_LIMIT_PER_HOUR:
            raise HTTPException(429, "Live run limit reached. Try again later.")
        _live_count["n"] += 1
        try:
            r = agent.run_agent(tid, write=False)
        except SystemExit as e:
            raise HTTPException(503, str(e))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"{type(e).__name__}: {e}")
        _live_runs[tid] = r
        return r


@app.get("/api/health")
def health():
    return {"ok": True}


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        if path and f.is_file():
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
