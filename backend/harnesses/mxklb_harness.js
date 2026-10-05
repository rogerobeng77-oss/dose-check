// Dose Check harness for mxklb/boluscalculator (MIT).
// Loads the UNMODIFIED real source js/main.js inside a Node `vm` with a minimal
// DOM so the project's own functions run exactly as they do in the browser.
// We call the real calcCorrection / calcEffectiveFood / updateCalculations and
// read the real #finalBolus field. No calculator logic is reimplemented here.
//
// Reads JSON {cases:[...]} on stdin, prints JSON {results:[...]} on stdout.
// Each case: {id, bg, carbs, target, isf, icr} where bg/carbs are the strings a
// user would type into the #glucose and #foodbe inputs (so ".3", "0,5", "" and
// negatives exercise the real input handling), target/isf/icr are the therapy
// settings (aim, correction factor mg/dL-per-U, carbs grams-per-U).

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.env.DC_SRC ||
  path.join(__dirname, '..', 'targets_src', 'mxklb_boluscalculator', 'js', 'main.js');

function makeElement() {
  return { value: '', innerHTML: '', selectedIndex: 0, style: {}, currentStyle: null };
}

function buildContext() {
  const elements = {};
  const ids = ['glucose', 'foodbe', 'finalBolus', 'sum', 'settingsAim', 'settingsCorr',
    'settingsBolus', 'carbsunit', 'selectGlucoseUnit', 'selectFoodUnit', 'glucoseAimUnit',
    'correctionUnit', 'settings', 'setupGroup', 'settingsButton', 'setupButton',
    'therapySetup', 'therapyTime'];
  ids.forEach(id => { elements[id] = makeElement(); });

  const document = {
    getElementById: (id) => (elements[id] || (elements[id] = makeElement())),
    getElementsByClassName: () => [],
    documentElement: { clientHeight: 800 },
    body: { scrollHeight: 1000 },
  };
  const sandbox = {
    document,
    window: {},
    navigator: { standalone: false },
    screen: { height: 800 },
    localStorage: null,            // forces supportsLocalStorage()->false, no persistence
    console: { log: () => {} },
    setTimeout: () => {},
    getComputedStyle: () => ({ display: 'none' }),
    scrollTo: () => {},
    // Display-only i18n helpers that live in the project's tr/*.js files (not under
    // test here). Stubbed so the real calc path in updateCalculations() can run.
    updateTranslation: () => {},
    R: () => '',
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const code = fs.readFileSync(SRC, 'utf8');
  vm.runInContext(code, sandbox, { filename: 'main.js' });
  sandbox.__elements = elements;
  return sandbox;
}

function runCase(ctx, c) {
  // Seed the real settings arrays, then configure therapy 0 for this scenario.
  ctx.initDefaultSettings();
  ctx.settings[0] = { aim: c.target, corr: c.isf, bolus: 1.0 };
  ctx.selectedTherapy = 0;
  ctx.foodUnits = 1;              // 0 = bread units, 1 = carbs (grams)
  ctx.glucoseUnits = 0;          // mg/dL
  ctx.carbsFactor = c.icr;       // grams carbohydrate per 1 U

  const els = ctx.__elements;
  els.glucose.value = String(c.bg);
  els.foodbe.value = String(c.carbs);

  const correction = ctx.calcCorrection(0);
  const effectiveFood = ctx.calcEffectiveFood(0);
  ctx.updateCalculations();                 // runs the real app path, writes #finalBolus
  const shown = ctx.__elements.finalBolus.value;

  return {
    id: c.id,
    inputs: { bg: c.bg, carbs: c.carbs, target: c.target, isf: c.isf, icr: c.icr },
    correction_U: Number.isFinite(correction) ? correction : String(correction),
    meal_U: Number.isFinite(effectiveFood) ? effectiveFood : String(effectiveFood),
    displayed_bolus: shown,   // what the UI actually shows the user (string, "" = blank)
  };
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const { cases } = JSON.parse(raw);
  const ctx = buildContext();
  const results = cases.map((c) => {
    try { return runCase(ctx, c); }
    catch (e) { return { id: c.id, error: String(e && e.message || e) }; }
  });
  process.stdout.write(JSON.stringify({ results }));
}
main();
