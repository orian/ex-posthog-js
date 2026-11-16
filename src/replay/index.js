/**
 * @fileoverview Session replay with the recorder logic compiled in (it
 * registers first, so the extension finds it when it starts). rrweb itself is
 * loaded at runtime from `/static/recorder.js` on the assets host.
 */
import './recorder.js';
import './shell.js';
