/**
 * @fileoverview Registers the session replay module under upstream's name
 * `sessionRecording` (published as `posthog.sessionRecording`). rrweb itself
 * is loaded at runtime from `/static/recorder.js` on the assets host.
 */
import {registerExtension} from '../core/extensions.js';
import {SessionRecording, exportSessionRecordingApi} from './session-recording.js';

exportSessionRecordingApi();

registerExtension('sessionRecording', function(instance) {
  return new SessionRecording(instance);
});
