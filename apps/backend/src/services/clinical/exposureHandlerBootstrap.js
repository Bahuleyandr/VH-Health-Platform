// src/services/clinical/exposureHandlerBootstrap.js
//
// Makes the blood-borne exposure fan-out real in a process that does not serve
// HTTP.
//
// THE INCIDENT THIS EXISTS FOR. `registerExposureHandler(
// quarantineDevicesExposedToPatient)` is a MODULE-LOAD side effect at the
// bottom of cathDeviceReuseService.js. In the API process that module is
// imported by cathLabRoutes/cssdRoutes/cathReprocessingPolicyRoutes, so
// recording a reactive marker sweeps the cath device register. Nothing in the
// reconciliation sweep's import graph reached it, so the SAME reactive HBsAg
// row, repaired by the operator sweep, notified an EMPTY handler set: the
// marker landed, `notifyExposureHandlers` iterated nothing, and the devices
// used on that patient were never quarantined. The sweep would have reported a
// clean repair while silently skipping the clinical action the marker exists to
// trigger.
//
// Registration is therefore made EXPLICIT and owned here rather than left as an
// emergent property of route wiring:
//
//   • src/app.js imports this module for its side effect, so the API process
//     no longer depends on a route file being mounted to keep the fan-out live.
//   • scripts/reconcile-bloodborne-markers.mjs imports it BEFORE any repair,
//     and refuses to --apply when the count is still zero.
//
// Adding a new exposure-handler owner means adding its import below. The
// authority for "who registers" is `grep -rn 'registerExposureHandler(' src/`;
// today that is exactly one production module.

// Side-effect import: the registration is at cathDeviceReuseService.js's module
// bottom. Nothing is named here on purpose — a named import would invite a
// linter or a bundler to treat it as removable.
import './cathDeviceReuseService.js';
import { exposureHandlerCount } from './bloodborneMarkerRules.js';

export { exposureHandlerCount };

export default { exposureHandlerCount };
