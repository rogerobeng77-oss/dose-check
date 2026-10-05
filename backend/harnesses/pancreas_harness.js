// Dose Check harness for Pancreas-Digital/bolus-calculator (GPL-3.0).
// The calculator lives inside a React component (components/Calculator/index.js)
// that imports React, Chakra UI and Next, so it cannot be required in plain Node.
// The two pieces that decide the dose are lifted VERBATIM from the source and run
// here unchanged; every other line is harness plumbing. Source lines cited inline.
//
//   handleChange  index.js L60-70:  [name]: Number(value)
//   handleSubmit  index.js L73-84:  res = carbohydrates/ratio + (glycaemia-objective)/correction
//                                    then rounded to the `minimum` unit step.
//
// Reads JSON {cases:[...]} on stdin, prints JSON {results:[...]} on stdout.
// Each case supplies the raw strings a user types; `minimum` is the slider step.

'use strict';
const fs = require('fs');

// --- VERBATIM from components/Calculator/index.js, handleChange (L60-70) -------
function coerceInput(value) {
  return Number(value);                       // [name]: Number(value)
}
// --- VERBATIM from components/Calculator/index.js, handleSubmit (L73-84) --------
function computeDose(form) {
  //food + correction
  let res =
    form.carbohydrates / form.ratio +
    (form.glycaemia - form.objective) / form.correction;
  //Round to minimum and then round for a fix for some strange cases
  res =
    Math.round(
      (Math.round(res / form.minimum) * form.minimum + Number.EPSILON) * 100
    ) / 100;
  return res;
}
// -------------------------------------------------------------------------------

function runCase(c) {
  // Replicate the component's state: each typed field passes through Number(value).
  const form = {
    minimum: c.minimum === undefined ? 0.5 : Number(c.minimum),
    glycaemia: coerceInput(c.glycaemia),
    ratio: coerceInput(c.ratio),
    correction: coerceInput(c.correction),
    objective: coerceInput(c.objective),
    carbohydrates: coerceInput(c.carbohydrates),
  };
  const dose = computeDose(form);
  return {
    id: c.id,
    inputs: {
      glycaemia: c.glycaemia, ratio: c.ratio, correction: c.correction,
      objective: c.objective, carbohydrates: c.carbohydrates, minimum: form.minimum,
    },
    coerced: form,
    displayed_bolus: Number.isFinite(dose) ? dose : String(dose),  // Infinity/NaN shown as text
  };
}

function main() {
  const { cases } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const results = cases.map((c) => {
    try { return runCase(c); }
    catch (e) { return { id: c.id, error: String(e && e.message || e) }; }
  });
  process.stdout.write(JSON.stringify({ results }));
}
main();
