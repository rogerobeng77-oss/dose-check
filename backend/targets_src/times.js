// Dependency shim for nightscout cgm-remote-monitor lib/times (only the members
// boluswizardpreview.js uses). Faithful to the real module's contract:
// times.mins(n).msecs === n * 60 * 1000.
'use strict';
function mins(n) { return { msecs: n * 60 * 1000 }; }
function secs(n) { return { msecs: n * 1000 }; }
function hours(n) { return { msecs: n * 60 * 60 * 1000 }; }
module.exports = { mins, secs, hours };
