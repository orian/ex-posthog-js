/**
 * @fileoverview Registers the session replay module under upstream's name
 * `sessionRecording` (published as `posthog.sessionRecording`): the shell.
 * The recorder logic is the lazy part (recorder.js; index.js loads both), and
 * rrweb is loaded at runtime from our `recorder.js` (see `closure_recorder_url`).
 */
import {registerExtension} from '../core/extensions.js';
import {SessionRecording, exportSessionRecordingApi} from './session-recording.js';

exportSessionRecordingApi();

registerExtension('sessionRecording', function(instance) {
  return new SessionRecording(instance);
});
