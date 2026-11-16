/**
 * @fileoverview Core entry point (upstream array.js / init_from_snippet):
 * exposes `window.posthog`, replays calls queued by the standard PostHog HTML
 * snippet and reports `$sdk_dist_channel: 'cdn'`. Optional modules are added
 * by other entries (full.js) or by loading their Closure chunks afterwards.
 */
import {PostHog, exportPublicApi, initFromSnippet} from '../core/posthog.js';
import {registerExtension} from '../core/extensions.js';

exportPublicApi();
const main = initFromSnippet();
main['__registerExtension'] = registerExtension;
main['PostHog'] = PostHog;

export {PostHog};
