/**
 * @fileoverview Session replay with the recorder logic compiled in (it
 * registers first, so the extension finds it when it starts). rrweb itself is
 * loaded at runtime from our `recorder.js` next to the SDK script (see
 * `closure_recorder_url` in session-recording.js).
 */
import './recorder.js';
import './shell.js';
