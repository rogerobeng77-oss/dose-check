"""Registry of the real calculators under test, plus the seed regression probes.

Each target carries what the agent needs to reason: where the code is, its
licence, the input contract, the formula it appears to implement, and a small set
of SEED probes drawn straight from the FDA recall history (leading '.', locale
comma) and the Huckvale error classes. The agent runs these seeds every time so
the recall regressions are always checked, and asks Nemotron to GENERATE further
cases on top. Which ones fail is decided by the oracle, never asserted here.
"""
from __future__ import annotations

from typing import Any

# ---- reference therapy settings used to build the seed probes ---------------
# Typical adult type-1 settings so the numbers are clinically plausible:
#   target (G_target) 100 mg/dL, ISF 50 mg/dL/U, ICR 12 g/U.
T, ISF, ICR = 100, 50, 12


TARGETS: dict[str, dict[str, Any]] = {
    "mxklb": {
        "id": "mxklb",
        "name": "mxklb/boluscalculator",
        "repo": "https://github.com/mxklb/boluscalculator",
        "commit": "7d70c29",
        "licence": "MIT",
        "stars": 6,
        "language": "JavaScript (browser)",
        "harness": "mxklb_harness.js",
        "unit_file": "js/main.js",
        "run_mode": "The real js/main.js is loaded in a Node vm with a DOM stub; "
                    "the project's own calcCorrection / calcEffectiveFood / "
                    "updateCalculations run unchanged.",
        "claimed_formula": "correction = (G - aim)/corr ;  meal = carbs * bolus / "
                           "carbsFactor ;  final = correction + meal   (no IOB term)",
        "input_schema": {
            "bg": "string the user types into #glucose (mg/dL)",
            "carbs": "string the user types into #foodbe (grams of carbohydrate)",
            "target": "therapy target glucose (number, mg/dL)",
            "isf": "correction factor corr (number, mg/dL per U)",
            "icr": "carbsFactor (number, grams per U)",
        },
        "settings": {"target": T, "isf": ISF, "icr": ICR},
    },
    "pancreas": {
        "id": "pancreas",
        "name": "Pancreas-Digital/bolus-calculator",
        "repo": "https://github.com/Pancreas-Digital/bolus-calculator",
        "commit": "90f9622",
        "licence": "GPL-3.0",
        "stars": 5,
        "language": "JavaScript (React / Next.js)",
        "harness": "pancreas_harness.js",
        "unit_file": "components/Calculator/index.js",
        "run_mode": "handleChange (Number(value)) and the handleSubmit formula are "
                    "lifted verbatim from the component and run unchanged; the "
                    "component's React/Chakra shell is not needed to reproduce the dose.",
        "claimed_formula": "res = carbohydrates/ratio + (glycaemia - objective)/"
                           "correction, rounded to the minimum unit   (no IOB term)",
        "input_schema": {
            "glycaemia": "string typed for current glucose (mg/dL)",
            "ratio": "string typed for carb ratio (g/U)",
            "correction": "string typed for correction factor (mg/dL per U)",
            "objective": "string typed for target glucose (mg/dL)",
            "carbohydrates": "string typed for carbohydrates (g)",
            "minimum": "smallest deliverable unit step (number, default 0.5)",
        },
        "settings": {"objective": T, "correction": ISF, "ratio": 10},
    },
    "nightscout": {
        "id": "nightscout",
        "name": "nightscout/cgm-remote-monitor (Bolus Wizard Preview)",
        "repo": "https://github.com/nightscout/cgm-remote-monitor",
        "commit": "92d0834",
        "licence": "AGPL-3.0",
        "stars": 2835,
        "language": "JavaScript (Node)",
        "harness": "nightscout_harness.js",
        "unit_file": "lib/plugins/boluswizardpreview.js",
        "run_mode": "The real boluswizardpreview.js is required and its real "
                    "bwp.calc(sbx) runs against a faithful sandbox object; only "
                    "lib/times is shimmed.",
        "claimed_formula": "effect = IOB*sens ; outcome = BG - effect ; if outcome > "
                           "target_high: bolus = (outcome - target_high)/sens   "
                           "(IOB IS subtracted; refuses on missing info)",
        "input_schema": {
            "bg": "sensor glucose (number, mg/dL)",
            "iob": "units of insulin already on board (number)",
            "sens": "insulin sensitivity (mg/dL per U)",
            "target_high": "upper target (mg/dL)",
            "target_low": "lower target (mg/dL)",
            "noIob": "true to omit the IOB property entirely (tests the guard)",
            "sgvCurrent": "false to make the glucose reading stale (tests the guard)",
        },
        "settings": {"sens": ISF, "target_high": 120, "target_low": 80},
    },
}


def seed_cases(target_id: str) -> list[dict[str, Any]]:
    """Regression probes from the recall history + Huckvale classes, per target."""
    if target_id == "mxklb":
        return [
            {"id": "mxklb-nominal", "category": "nominal",
             "harness_inputs": {"bg": "150", "carbs": "60", "target": T, "isf": ISF, "icr": ICR}},
            {"id": "mxklb-missing-glucose", "category": "missing_value", "field": "glucose",
             "harness_inputs": {"bg": "", "carbs": "60", "target": T, "isf": ISF, "icr": ICR}},
            {"id": "mxklb-missing-meal", "category": "missing_value", "field": "carbs",
             "harness_inputs": {"bg": "150", "carbs": "", "target": T, "isf": ISF, "icr": ICR}},
            {"id": "mxklb-negative-bg", "category": "input_validation",
             "harness_inputs": {"bg": "-50", "carbs": "0", "target": T, "isf": ISF, "icr": ICR}},
            {"id": "mxklb-negative-carbs", "category": "input_validation",
             "harness_inputs": {"bg": "150", "carbs": "-80", "target": T, "isf": ISF, "icr": ICR}},
            {"id": "mxklb-huge-carbs", "category": "upper_bound",
             "harness_inputs": {"bg": "150", "carbs": "1000", "target": T, "isf": ISF, "icr": ICR}},
            {"id": "mxklb-leading-decimal", "category": "locale_decimal",
             "harness_inputs": {"bg": "150", "carbs": ".6", "target": T, "isf": ISF, "icr": ICR},
             "intended_U": None},
            {"id": "mxklb-comma-decimal", "category": "locale_decimal",
             "harness_inputs": {"bg": "150", "carbs": "0,6", "target": T, "isf": ISF, "icr": ICR},
             "intended_U": None},
        ]
    if target_id == "pancreas":
        return [
            {"id": "panc-nominal", "category": "nominal",
             "harness_inputs": {"glycaemia": "150", "ratio": "10", "correction": "50",
                                "objective": "100", "carbohydrates": "60"}},
            {"id": "panc-empty-ratio", "category": "divide_by_zero",
             "harness_inputs": {"glycaemia": "150", "ratio": "", "correction": "50",
                                "objective": "100", "carbohydrates": "60"}},
            {"id": "panc-comma-decimal", "category": "locale_decimal",
             "harness_inputs": {"glycaemia": "150", "ratio": "10", "correction": "50",
                                "objective": "100", "carbohydrates": "0,5"},
             "intended_U": None},
            {"id": "panc-negative-carbs", "category": "input_validation",
             "harness_inputs": {"glycaemia": "150", "ratio": "10", "correction": "50",
                                "objective": "100", "carbohydrates": "-60"}},
            {"id": "panc-iob-stacking", "category": "iob_subtraction",
             "harness_inputs": {"glycaemia": "200", "ratio": "10", "correction": "50",
                                "objective": "100", "carbohydrates": "80"},
             "iob_U": 3.0},
            {"id": "panc-huge-carbs", "category": "upper_bound",
             "harness_inputs": {"glycaemia": "150", "ratio": "10", "correction": "50",
                                "objective": "100", "carbohydrates": "500"}},
        ]
    if target_id == "nightscout":
        return [
            {"id": "ns-high-noiob", "category": "nominal",
             "harness_inputs": {"bg": 250, "iob": 0, "sens": ISF, "target_high": 120, "target_low": 80}},
            {"id": "ns-iob-covers", "category": "iob_subtraction",
             "harness_inputs": {"bg": 250, "iob": 3, "sens": ISF, "target_high": 120, "target_low": 80},
             "iob_U": 3.0},
            {"id": "ns-missing-iob", "category": "missing_value",
             "harness_inputs": {"bg": 250, "noIob": True, "sens": ISF, "target_high": 120, "target_low": 80}},
            {"id": "ns-stale-sgv", "category": "missing_value",
             "harness_inputs": {"bg": 250, "iob": 0, "sens": ISF, "target_high": 120,
                                "target_low": 80, "sgvCurrent": False}},
        ]
    return []
