"""The Dose Check agent.

For one real calculator:
  1. LOCATE + GROUND  (Nemotron 3 Super)  read the real source, state the input
                      contract and the formula the code actually implements,
                      and list suspected deviations from the cited reference
                      formula. These are claims, not findings.
  2. PROBE            (Nemotron 3.5 Lightning, tool calling)  Lightning chooses
                      test inputs and calls a `run_test` tool. The tool runs the
                      REAL calculator code in a restricted Node subprocess and
                      returns what the calculator displayed. Seed probes from
                      the FDA recall history always run as well.
  3. SCORE            (plain Python, engine/oracle.py)  pass/fail is decided by
                      the cited formula and rules, never by a model.
  4. ADJUDICATE       (Nemotron 3 Super)  for failures only: true defect, spec
                      ambiguity or test error, with the dose numbers explained.
  5. PROVE            for a file-based target, Super proposes a minimal patch,
                      it is applied to a temp copy, and the failing cases are
                      re-run against the patched real code.
"""
from __future__ import annotations

import json
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

import nemotron
from nemotron import think, LIGHTNING, SUPER
from engine import oracle
from engine.runner import run_harness
from engine.targets import TARGETS, seed_cases

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "targets_src"
CACHE = ROOT / "cache"

SOURCE_FILES = {
    "mxklb": SRC / "mxklb_boluscalculator" / "js" / "main.js",
    "pancreas": SRC / "Pancreas-Digital_bolus-calculator" / "components" / "Calculator" / "index.js",
    "nightscout": SRC / "nightscout_cgm-remote-monitor_boluswizard" / "boluswizardpreview.js",
}

# $ per million tokens (Token Factory catalogue, 2026-10-04)
PRICE = {
    "nvidia/nemotron-3-super-120b-a12b": (0.30, 0.90),
    "nvidia/Nemotron-3_5-Lightning": (0.06, 0.24),
}


# --------------------------------------------------------------------------- adapters
def _num(x: Any) -> float | None:
    if x is None:
        return None
    s = str(x).strip().replace(",", ".")
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def reference_for(target: str, h: dict[str, Any], iob_U: float | None) -> float | None:
    """The reference-formula dose for the intended meaning of these inputs."""
    try:
        if target == "mxklb":
            g, cho = _num(h.get("bg")), _num(h.get("carbs"))
            if g is None or not h["icr"] or not h["isf"]:
                return None
            return oracle.reference_bolus(cho or 0.0, h["icr"], g, h["target"], h["isf"], 0.0)
        if target == "pancreas":
            g, cho = _num(h.get("glycaemia")), _num(h.get("carbohydrates"))
            icr, isf, tgt = _num(h.get("ratio")), _num(h.get("correction")), _num(h.get("objective"))
            if None in (g, cho, icr, isf, tgt) or icr == 0 or isf == 0:
                return None
            return oracle.reference_bolus(cho, icr, g, tgt, isf, iob_U or 0.0)
        if target == "nightscout":
            g = _num(h.get("bg"))
            if g is None or not h.get("sens"):
                return None
            ref = oracle.reference_bolus(0.0, 1.0, g, h["target_high"], h["sens"],
                                         h.get("iob") or 0.0)
            return max(0.0, ref)   # a negative bolus cannot be delivered
    except (KeyError, TypeError):
        return None
    return None


def observe(target: str, res: dict[str, Any]) -> tuple[Any, bool]:
    """(what the calculator showed, whether it refused to give a dose)."""
    if "error" in res:
        return f"harness error: {res['error']}", True
    shown = res.get("displayed_bolus")
    if target == "nightscout":
        if res.get("errors"):
            return "; ".join(res["errors"]), True
        return shown, False
    if shown in ("", None):
        return "", True
    return shown, False


TYPED = {"mxklb": ("bg", "carbs"),
         "pancreas": ("glycaemia", "ratio", "correction", "objective", "carbohydrates"),
         "nightscout": ("bg", "iob", "sens", "target_high", "target_low")}


def effective_category(target: str, case: dict[str, Any]) -> str:
    """A probe only counts under a category if its inputs really are that kind of probe.
    Lightning sometimes mislabels a case; the oracle must not call an ordinary input
    "impossible". Anything whose precondition is not met is scored as nominal."""
    h = case["harness_inputs"]
    vals = [h.get(k) for k in TYPED[target] if k in h]
    sv = [str(v).strip() if v is not None else "" for v in vals]
    cat = case["category"]
    nums = [_num(v) for v in sv]
    ok = {
        "missing_value": any(v == "" for v in sv) or h.get("noIob") or h.get("sgvCurrent") is False,
        "input_validation": any(n is not None and n < 0 for n in nums),
        "divide_by_zero": any(v == "" or n == 0 for v, n in zip(sv, nums)
                              if True) and any(k in h for k in ("ratio", "correction", "sens", "icr", "isf")),
        "locale_decimal": any("," in v or v.startswith(".") for v in sv),
    }
    if cat == "iob_subtraction" and any(n is not None and n < 0 for n in nums):
        cat = "input_validation"      # negative insulin on board is impossible
    if cat in ok and not ok[cat]:
        cat = "nominal"
    gl = [_num(h.get(k)) for k in ("bg", "glycaemia") if k in h]
    if cat == "nominal" and any(g is not None and 0 < g < 20 for g in gl):
        return "input_validation"   # a glucose under 20 mg/dL is not a real reading
    return cat


def score(target: str, case: dict[str, Any], res: dict[str, Any]) -> dict[str, Any]:
    h = case["harness_inputs"]
    observed, blocked = observe(target, res)
    ref = reference_for(target, h, case.get("iob_U"))
    c = dict(case)
    c["category"] = effective_category(target, case)
    c["inputs"] = {k: v for k, v in h.items()}
    if c["category"] == "locale_decimal":
        c["intended_U"] = ref
    v = oracle.evaluate(c, observed, reference_U=ref, blocked=blocked)
    d = v.to_dict()
    d["source"] = case.get("source", "seed")
    d["labelled_as"] = case["category"]
    d["rationale"] = case.get("rationale", "")
    d["intended_U"] = c.get("intended_U")
    d["raw"] = {k: v for k, v in res.items() if k not in ("id", "inputs")}
    return d


def execute(target: str, cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    spec = TARGETS[target]
    payload = [dict(id=c["id"], **c["harness_inputs"]) for c in cases]
    out = run_harness(spec["harness"], payload)
    if "error" in out:
        raise RuntimeError(out["error"])
    by_id = {r["id"]: r for r in out["results"]}
    return [score(target, c, by_id[c["id"]]) for c in cases]


# --------------------------------------------------------------------------- 1. locate
def locate(target: str) -> dict[str, Any]:
    spec = TARGETS[target]
    code = SOURCE_FILES[target].read_text()
    msg = [{"role": "system", "content":
            "You are a careful clinical-software test engineer. Answer with JSON only."},
           {"role": "user", "content": f"""Reference formula (Zhu et al., Sensors 2020, Eq. 4, PMC7570884):
  bolus = CHO/ICR + (G - G_target)/ISF - IOB

Below is the real source file `{spec['unit_file']}` of the open-source insulin bolus calculator
{spec['name']}. Read it and return JSON with exactly these keys:
  "dose_function": name of the function(s) that decide the dose,
  "inputs": list of {{"name","unit","where_parsed"}} for every user-typed input,
  "implemented_formula": one line, what the code actually computes,
  "suspected_deviations": list of up to 5 {{"claim","line_hint","why_it_matters"}} where the code
     may deviate from the reference formula or lacks a safety check (missing value, negative value,
     zero divisor, comma decimal, no dose ceiling, IOB). Each is a CLAIM to be tested, not a finding.
Keep each string under 160 characters.

```js
{code[:60000]}
```"""}]
    return think(msg, SUPER, json_out=True, max_tokens=6000, reasoning_effort="low")


# --------------------------------------------------------------------------- 2. probe (Lightning tools)
def _cats(target: str) -> list[str]:
    # mxklb has no IOB input at all, so an IOB probe cannot even be expressed.
    skip = {"mxklb": {"iob_subtraction"}, "nightscout": {"locale_decimal"}}.get(target, set())
    return [c for c in oracle.CATEGORIES if c not in skip]


def _tool_schema(target: str) -> list[dict[str, Any]]:
    spec = TARGETS[target]
    props = {k: {"type": ["string", "number", "boolean"], "description": v}
             for k, v in spec["input_schema"].items()}
    return [{"type": "function", "function": {
        "name": "run_test",
        "description": "Run the REAL calculator code on one input set and return what it displayed.",
        "parameters": {"type": "object", "properties": {
            "category": {"type": "string", "enum": _cats(target)},
            "inputs": {"type": "object", "properties": props,
                       "description": "Exactly the fields of the calculator's input schema. "
                                      "Typed fields are STRINGS exactly as a user would type them."},
            "iob_U": {"type": "number", "description": "Active insulin on board in units, only for "
                                                       "iob_subtraction when the calculator takes IOB"},
            "rationale": {"type": "string", "description": "one sentence: what this probes"}},
            "required": ["category", "inputs", "rationale"]}}}]


def probe(target: str, contract: dict[str, Any], budget_rounds: int = 4) -> tuple[list[dict], list[dict]]:
    """Lightning drives the real calculator through the run_test tool."""
    spec = TARGETS[target]
    cats = "\n".join(f"  - {k}: {v}" for k, v in oracle.CATEGORIES.items() if k in _cats(target))
    seeds = seed_cases(target)
    seeded = "\n".join(f"  {json.dumps(s['harness_inputs'])}" for s in seeds)
    settings = json.dumps(spec["settings"])
    messages = [
        {"role": "system", "content":
         "You are the test-writing arm of a coding agent that probes insulin dose calculators. "
         "You call the run_test tool to execute REAL calculator code. Do not guess outputs; call the tool. "
         "Make several run_test calls in one turn."},
        {"role": "user", "content": f"""Target: {spec['name']}  ({spec['language']})
Input schema: {json.dumps(spec['input_schema'])}
Typical therapy settings: {settings}
Formula the code implements: {contract.get('implemented_formula')}
Suspected deviations: {json.dumps(contract.get('suspected_deviations'))}

Test categories (from Huckvale et al. 2015 plus the FDA-recalled Omnipod 5 input defects):
{cats}

Already covered by seed probes (do not repeat these exactly):
{seeded}

Write 8 NEW, distinct probes now, chosen to expose the suspected deviations or to find a
defect the seeds miss. Include at least: a leading-decimal input like ".5", a comma decimal like "1,5",
a blank required input other than the one seeded, a zero divisor, a plausible-but-extreme input,
and an in-range nominal case with different numbers. Typed fields must be strings, therapy settings numbers.
Call run_test once per probe."""}]
    cases: list[dict] = []
    trace: list[dict] = []
    n = 0
    for _ in range(budget_rounds):
        msg = think(messages, LIGHTNING, tools=_tool_schema(target), max_tokens=6000,
                    temperature=0.3)
        calls = getattr(msg, "tool_calls", None) or []
        messages.append({"role": "assistant", "content": msg.content or "",
                         "tool_calls": [{"id": c.id, "type": "function",
                                         "function": {"name": c.function.name,
                                                      "arguments": c.function.arguments}}
                                        for c in calls]})
        if not calls:
            break
        for c in calls:
            try:
                args = json.loads(c.function.arguments)
                inputs = args["inputs"]
                cat = args["category"]
                if cat not in _cats(target):
                    raise ValueError(f"unknown category {cat}")
                for k, v in spec["settings"].items():     # fill therapy settings if omitted
                    inputs.setdefault(k, v)
                if target == "mxklb":
                    for k in ("target", "isf", "icr"):
                        inputs[k] = float(inputs[k])
                if target == "nightscout":          # CGM/profile values arrive as numbers
                    for k in list(inputs):
                        if k in TYPED[target]:
                            inputs[k] = _num(inputs[k])
                    if inputs.get("iob") is None:
                        inputs["iob"] = 0
                n += 1
                case = {"id": f"gen-{n:02d}", "category": cat, "harness_inputs": inputs,
                        "source": "lightning", "rationale": args.get("rationale", ""),
                        "iob_U": args.get("iob_U")}
                if cat == "missing_value":
                    case["field"] = "carbs" if "carbs" in json.dumps(inputs) and \
                        str(inputs.get("carbs", "x")).strip() == "" else "other"
                scored = execute(target, [case])[0]
                result_txt = f"calculator displayed: {scored['observed']!r}"
                cases.append(case)
                trace.append({"id": case["id"], "tool": "run_test", "category": cat,
                              "inputs": inputs, "returned": scored["observed"]})
            except Exception as e:  # noqa: BLE001
                result_txt = f"tool error: {e}"
                trace.append({"tool": "run_test", "error": str(e)})
            messages.append({"role": "tool", "tool_call_id": c.id, "content": result_txt})
        if len(cases) >= 8:
            break
        messages.append({"role": "user", "content": "Continue with remaining probes if fewer than 8 ran; otherwise reply DONE."})
    return cases, trace


# --------------------------------------------------------------------------- 4. adjudicate
def adjudicate(target: str, contract: dict[str, Any], fails: list[dict[str, Any]]) -> dict[str, Any]:
    if not fails:
        return {}
    spec = TARGETS[target]
    code = SOURCE_FILES[target].read_text()
    rows = [{"case_id": f["case_id"], "category": f["category"], "inputs": f["inputs"],
             "observed_by_the_real_code": f["observed"], "reference_dose_U": f["reference_U"],
             "intermediate_values_from_the_real_code": f.get("raw"),
             "oracle_rule": f["rule"]} for f in fails]
    msg = [{"role": "system", "content": "You are a clinical-software failure analyst. JSON only."},
           {"role": "user", "content": f"""Calculator: {spec['name']}. Reference formula (PMC7570884 Eq. 4):
bolus = CHO/ICR + (G - G_target)/ISF - IOB.
The deterministic oracle flagged these test cases as failures (each ran on the real code):
{json.dumps(rows, indent=1)}

Source of the dose code:
```js
{code[:40000]}
```
Rules: the observed and reference numbers above are measured facts, quote them verbatim and do NOT
recompute arithmetic. An intermediate value of NaN/Infinity/"" is what the code really produced; explain
the mechanism from the source (e.g. which JavaScript conversion yields NaN) rather than guessing.
For each case_id decide: "true_defect" (the code does the wrong thing), "spec_ambiguity" (reasonable
people could differ) or "test_error" (our test is unfair). Return JSON:
{{"adjudications": [{{"case_id","verdict","cause" (the exact code line or mechanism, max 150 chars),
"explanation" (2 sentences, plain words, include the dose numbers),
"fix" (one sentence)}}]}}"""}]
    out = think(msg, SUPER, json_out=True, max_tokens=8000, reasoning_effort="low")
    return {a["case_id"]: a for a in out.get("adjudications", [])}


# --------------------------------------------------------------------------- 5. prove (patch + re-run)
def prove(target: str, contract: dict[str, Any], scored: list[dict[str, Any]],
          cases: list[dict[str, Any]]) -> dict[str, Any] | None:
    if target != "mxklb":
        return None
    fails = [s for s in scored if s["status"] == "fail" and s["category"] == "missing_value"]
    if not fails:
        return None
    code = SOURCE_FILES[target].read_text()
    msg = [{"role": "system", "content": "You write minimal safe patches. JSON only."},
           {"role": "user", "content": f"""In this calculator source, the function calcEffectiveFood is meant to
return NaN when the meal field is blank, but a blank meal currently yields a correction-only dose.
Propose the smallest patch: JSON {{"find": "<exact existing text, a single line>", "replace": "<new text>",
"why": "<one sentence>"}}. `find` must occur exactly once in the file.

```js
{code[code.find('function calcEffectiveFood'):][:900]}
```"""}]
    p = think(msg, SUPER, json_out=True, max_tokens=4000, reasoning_effort="low")
    if code.count(p["find"]) != 1:
        return {"error": "model patch did not match exactly once", "patch": p}
    tmp = Path(tempfile.mkdtemp(prefix="dosecheck-patch-"))
    try:
        patched = tmp / "main.js"
        patched.write_text(code.replace(p["find"], p["replace"]))
        ids = {f["case_id"] for f in fails}
        sel = [c for c in cases if c["id"] in ids]
        payload = [dict(id=c["id"], **c["harness_inputs"]) for c in sel]
        out = run_harness(TARGETS[target]["harness"], payload, extra_env={"DC_SRC": str(patched)})
        by_id = {r["id"]: r for r in out["results"]}
        after = [score(target, c, by_id[c["id"]]) for c in sel]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"find": p["find"], "replace": p["replace"], "why": p.get("why", ""),
            "rerun": [{"case_id": a["case_id"], "before": next(f["observed"] for f in fails if f["case_id"] == a["case_id"]),
                       "after": a["observed"], "status_after": a["status"]} for a in after]}


# --------------------------------------------------------------------------- orchestrate
def _cost() -> float:
    total = 0.0
    for m, u in nemotron.USAGE.items():
        pi, po = PRICE.get(m, (0.3, 0.9))
        total += u["in"] / 1e6 * pi + u["out"] / 1e6 * po
    return round(total, 4)


def run_agent(target: str, write: bool = True) -> dict[str, Any]:
    """The full live run. Spends Token Factory tokens."""
    t0 = time.time()
    nemotron.USAGE.clear()
    spec = TARGETS[target]
    contract = locate(target)
    gen_cases, trace = probe(target, contract)
    cases = seed_cases(target) + gen_cases
    for c in cases:
        c.setdefault("source", "seed")
    scored = execute(target, cases)
    fails = [s for s in scored if s["status"] == "fail"]
    adj = adjudicate(target, contract, fails)
    for s in scored:
        if s["case_id"] in adj:
            s["adjudication"] = adj[s["case_id"]]
    proof = prove(target, contract, scored, cases)
    summary = {
        "tests": len(scored),
        "passed": sum(1 for s in scored if s["status"] == "pass"),
        "failed": len(fails),
        "true_defects": sum(1 for a in adj.values() if a.get("verdict") == "true_defect"),
        "by_severity": {sev: sum(1 for f in fails if f["severity"] == sev)
                        for sev in ("critical", "high", "medium")},
    }
    run = {
        "target": {k: spec[k] for k in ("id", "name", "repo", "commit", "licence", "stars",
                                        "language", "unit_file", "run_mode", "claimed_formula")},
        "reference": {"formula": oracle.REFERENCE_FORMULA, "cite": oracle.REFERENCE_CITE},
        "contract": contract,
        "tool_trace": trace,
        "results": scored,
        "proof": proof,
        "summary": summary,
        "models": {"locate_adjudicate_patch": SUPER, "test_tools": LIGHTNING},
        "usage": nemotron.USAGE,
        "cost_usd": _cost(),
        "seconds": round(time.time() - t0, 1),
        "generated_at": time.strftime("%Y-%m-%d"),
    }
    if write:
        CACHE.mkdir(exist_ok=True)
        (CACHE / f"{target}.json").write_text(json.dumps(run, indent=2))
    return run


def load_cached(target: str) -> dict[str, Any] | None:
    p = CACHE / f"{target}.json"
    return json.loads(p.read_text()) if p.exists() else None
