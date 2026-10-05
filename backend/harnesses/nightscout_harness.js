// Dose Check harness for nightscout/cgm-remote-monitor boluswizardpreview.js (AGPL-3.0).
// Requires the UNMODIFIED real plugin and drives its real bwp.calc(sbx) through a
// faithful `sbx` sandbox (the same object the running server passes it). The only
// shim is lib/times (see targets_src/times.js). No bolus logic is reimplemented.
//
// Reads JSON {cases:[...]} on stdin, prints JSON {results:[...]} on stdout.
// Each case: {id, bg, iob, sens, target_high, target_low, basal, carbRatio, sgvCurrent}
// bg is the sensor glucose (mg/dL), iob is units of insulin already on board.

'use strict';
const fs = require('fs');
const path = require('path');

const init = require(path.join(__dirname, '..', 'targets_src',
  'nightscout_cgm-remote-monitor_boluswizard', 'boluswizardpreview.js'));

function round(x, dp) { const f = Math.pow(10, dp); return Math.round(x * f) / f; }

function buildSbx(c) {
  const profile = {
    hasData: () => true,
    getSensitivity: () => c.sens,
    getHighBGTarget: () => c.target_high,
    getLowBGTarget: () => c.target_low,
    getBasal: () => (c.basal === undefined ? 0 : c.basal),
    getCarbRatio: () => (c.carbRatio === undefined ? 10 : c.carbRatio),
  };
  if (c.missingProfile) { profile.hasData = () => false; }
  if (c.missingFields) { profile.getSensitivity = () => 0; }

  const sgvEntry = { mgdl: c.bg };
  const sbx = {
    time: 0,
    settings: { thresholds: { bgTargetTop: 180 }, units: 'mg/dl' },
    extendedSettings: {},
    levels: { URGENT: 2, WARN: 1, toDisplay: (l) => (l === 2 ? 'Urgent' : 'Warning') },
    language: { translate: (s) => s },
    data: {
      profile: c.noProfile ? null : profile,
      treatments: c.treatments || [],
    },
    properties: {},
    lastScaledSGV: () => c.bg,
    lastSGVEntry: () => sgvEntry,
    isCurrent: () => (c.sgvCurrent === undefined ? true : c.sgvCurrent),
    scaleMgdl: (v) => v,
    roundInsulinForDisplayFormat: (v) => round(v, 2),
    roundBGToDisplayFormat: (v) => round(v, 0),
  };
  // IOB property: omit entirely to test the "Missing IOB" guard.
  if (!c.noIob) { sbx.properties.iob = { iob: c.iob === undefined ? 0 : c.iob }; }
  return sbx;
}

function runCase(c) {
  const ctx = { language: { translate: (s) => s }, levels: { URGENT: 2, WARN: 1, toDisplay: () => '' } };
  const bwp = init(ctx);
  const sbx = buildSbx(c);
  const res = bwp.calc(sbx);
  return {
    id: c.id,
    inputs: { bg: c.bg, iob: c.iob, sens: c.sens, target_high: c.target_high, target_low: c.target_low },
    errors: res.errors || null,
    iob_effect: res.effect,
    outcome: res.outcome,
    displayed_bolus: res.errors ? null : round(res.bolusEstimate, 2),
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
