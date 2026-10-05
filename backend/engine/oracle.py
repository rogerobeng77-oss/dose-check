"""The clinical oracle: the reference formula and the deterministic safety rules.

This is the part a judge should trust more than the language model. The verdict
pass/fail on any single test case is decided HERE, in plain Python, against a
formula and a set of rules taken verbatim from open-access papers. Nemotron is
asked only to explain a failure and to decide whether it is a true defect, a
spec ambiguity, or a bug in our own test -- it never gets to declare a dose safe.

Sources (full text saved under research/evidence/, licences in research/SOURCES.md):
  * Standard bolus formula, Eq. 4 of Zhu et al., Sensors 2020 (PMC7570884, CC BY 4.0):
        bolus = CHO/ICR + (G - G_target)/ISF - IOB
  * ICR / ISF derivation rules, Nutrients 2018 (PMC5793337, CC BY 4.0):
        ICR from the 500/450/300 rule; ISF from 1800 (rapid) or 1500 (regular) / TDD.
  * Error taxonomy, Huckvale et al., BMC Med 2015 (PMC4433091, CC BY 4.0):
        46 insulin dose calculator apps; 91% did no numeric input validation,
        59% calculated with missing values, 67% could give an inappropriate dose,
        most placed no upper limit on the calculated dose.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

# --- the reference formula ---------------------------------------------------
# Eq. 4, Zhu et al. 2020 (PMC7570884). Units: CHO g, ICR g/U, G & G_target mg/dL,
# ISF mg/dL per U, IOB U. Returns units of rapid-acting insulin.
REFERENCE_FORMULA = "bolus = CHO/ICR + (G - G_target)/ISF - IOB"
REFERENCE_CITE = "Zhu et al., Sensors 2020, Eq. 4 (PMC7570884, CC BY 4.0)"


def reference_bolus(cho: float, icr: float, g: float, g_target: float,
                    isf: float, iob: float = 0.0) -> float:
    return cho / icr + (g - g_target) / isf - iob


# A clinical ceiling used only to flag "no upper bound" behaviour. A single
# rapid-acting bolus above this for the scenarios we test would be extraordinary;
# real pumps cap the max bolus (e.g. default 25 U on several systems). We use 30 U
# as a conservative flag threshold, not a treatment recommendation.
UPPER_BOUND_FLAG_U = 30.0

# The six Huckvale 2015 error classes, used as the test categories.
CATEGORIES = {
    "missing_value": "A required input is left blank. A missing measurement must "
                     "not be silently treated as a real number of zero (Huckvale: "
                     "59% of apps calculated with missing values).",
    "input_validation": "A physically impossible input (negative glucose, negative "
                        "carbohydrate) must be rejected (Huckvale: 91% did no "
                        "numeric input validation).",
    "divide_by_zero": "A zero or blank ratio/sensitivity must not produce an "
                      "infinite or nonsensical dose.",
    "locale_decimal": "A decimal typed with a comma ('0,5') must parse as 0.5 or be "
                      "rejected -- never silently become a different number. This is "
                      "the exact class FDA recalled on the Omnipod 5 iOS app "
                      "(Z-2016-2025: '0.1 unit recognized as 1 unit').",
    "upper_bound": "A very large but in-type input must not yield an unbounded dose "
                   "with no warning (Huckvale: most apps placed no upper limit).",
    "iob_subtraction": "Active insulin (IOB) must be subtracted; omitting it stacks "
                       "insulin on a dose already working (cf. Omnipod DASH recall "
                       "Z-2164/2165-2020: IOB not subtracted).",
    "nominal": "In-range inputs should match the reference formula within rounding.",
}


@dataclass
class Verdict:
    case_id: str
    category: str
    inputs: dict[str, Any]
    expected: str                 # what a safe calculator should do
    reference_U: float | None     # the reference-formula dose, when defined
    observed: Any                 # what the real code displayed
    status: str                   # "pass" | "fail"
    rule: str                     # which rule decided it
    severity: str = "info"        # "critical" | "high" | "medium" | "info"
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _is_number(x: Any) -> bool:
    try:
        f = float(x)
        return f == f and f not in (float("inf"), float("-inf"))
    except (TypeError, ValueError):
        return False


def _as_float(x: Any) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def evaluate(case: dict[str, Any], observed_U: Any, *,
             reference_U: float | None = None,
             blocked: bool | None = None) -> Verdict:
    """Decide pass/fail for one executed case.

    `observed_U` is what the calculator actually showed (a number, or a string
    like "", "Infinity", "NaN"). `blocked` is True when the calculator refused to
    produce a dose (showed an error / blank) -- that is the safe response to a
    bad input. `reference_U` is supplied for nominal and IOB cases.
    """
    cat = case["category"]
    cid = case["id"]
    inputs = case.get("inputs", {})
    observed_is_num = _is_number(observed_U)
    is_blocked = bool(blocked) or (observed_U in ("", None) and reference_U is None) \
        or observed_U in ("Infinity", "NaN", "-Infinity")

    def V(expected, status, rule, severity, detail):
        return Verdict(cid, cat, inputs, expected, reference_U, observed_U,
                       status, rule, severity, detail)

    if cat == "missing_value":
        # Safe: blank / error. Unsafe: a finite dose computed from the missing field.
        # A blank carbohydrate box is often "no meal", so it is rated lower than a
        # blank glucose, ratio or IOB, where a guess changes the dose materially.
        if observed_is_num:
            sev = "medium" if case.get("field") == "carbs" else "high"
            return V("Block the calculation and prompt for the missing value",
                     "fail", "missing input produced a finite dose",
                     sev,
                     f"A required field was blank yet the calculator showed "
                     f"{observed_U} U, treating the missing value as zero.")
        return V("Block the calculation and prompt for the missing value",
                 "pass", "missing input was not turned into a dose", "info",
                 "Calculator did not produce a dose from the missing field.")

    if cat == "input_validation":
        if observed_is_num:
            return V("Reject the impossible input",
                     "fail", "impossible input accepted",
                     "high",
                     f"Input {inputs} is physically impossible yet the calculator "
                     f"returned {observed_U} U instead of rejecting it.")
        return V("Reject the impossible input", "pass",
                 "impossible input not turned into a dose", "info", "")

    if cat == "divide_by_zero":
        if observed_U in ("Infinity", "-Infinity") or (observed_is_num and abs(float(observed_U)) > 1e6):
            return V("Reject a zero/blank ratio or sensitivity",
                     "fail", "division by zero produced an infinite dose",
                     "critical",
                     f"A blank/zero divisor produced {observed_U} U. On a pump this "
                     f"is an unbounded over-delivery.")
        if observed_is_num:
            return V("Reject a zero/blank ratio or sensitivity",
                     "fail", "zero divisor silently absorbed into a dose",
                     "medium",
                     f"A blank/zero divisor still produced {observed_U} U.")
        return V("Reject a zero/blank ratio or sensitivity", "pass",
                 "zero divisor not turned into a dose", "info", "")

    if cat == "locale_decimal":
        # Safe: the comma value parsed to the intended number, or was rejected.
        intended = case.get("intended_U")
        if observed_U in ("NaN",) or (observed_U in ("", None)):
            return V("Parse '0,5' as 0.5 or reject the input",
                     "fail", "comma decimal rejected without telling the user",
                     "medium",
                     f"A comma decimal ({inputs}) produced {observed_U!r} -- the "
                     f"calculator neither parsed it nor told the user why.")
        if observed_is_num and intended is not None and abs(float(observed_U) - intended) > 0.01:
            return V("Parse '0,5' as 0.5 or reject the input",
                     "fail", "comma decimal changed the dose",
                     "critical",
                     f"A comma decimal produced {observed_U} U but the intended "
                     f"dose was {intended} U -- the exact Omnipod 5 iOS recall class.")
        return V("Parse '0,5' as 0.5 or reject the input", "pass",
                 "comma decimal parsed to the intended dose", "info", "")

    if cat == "upper_bound":
        f = _as_float(observed_U)
        if f is not None and f > UPPER_BOUND_FLAG_U:
            return V(f"Cap or warn above a safe maximum (~{UPPER_BOUND_FLAG_U:g} U)",
                     "fail", "dose exceeds a safe ceiling with no warning",
                     "high",
                     f"The calculator showed {observed_U} U with no upper-bound "
                     f"warning (Huckvale: most apps placed no dose limit).")
        return V(f"Cap or warn above a safe maximum (~{UPPER_BOUND_FLAG_U:g} U)",
                 "pass", "dose within the flag ceiling", "info", "")

    if cat == "iob_subtraction":
        f = _as_float(observed_U)
        if f is not None and reference_U is not None and f - reference_U > 0.25:
            return V("Subtract active insulin (IOB) from the dose",
                     "fail", "IOB not subtracted -> over-recommendation",
                     "high",
                     f"With active insulin on board the reference dose is "
                     f"{reference_U:.2f} U but the calculator recommended "
                     f"{observed_U} U -- it never subtracts IOB.")
        return V("Subtract active insulin (IOB) from the dose", "pass",
                 "IOB accounted for", "info", "")

    # nominal
    f = _as_float(observed_U)
    if f is not None and reference_U is not None and abs(f - reference_U) <= 0.5:
        return V("Match the reference formula within rounding", "pass",
                 "matches reference", "info",
                 f"{observed_U} U vs reference {reference_U:.2f} U.")
    if f is not None and reference_U is not None:
        return V("Match the reference formula within rounding", "fail",
                 "diverges from reference", "medium",
                 f"{observed_U} U vs reference {reference_U:.2f} U.")
    if f is None and reference_U is not None:
        return V("Match the reference formula within rounding", "fail",
                 "no dose for a valid input", "medium",
                 f"Valid inputs gave no dose ({observed_U!r}); reference is {reference_U:.2f} U.")
    return V("Match the reference formula within rounding", "pass",
             "no numeric reference to compare", "info", "")
