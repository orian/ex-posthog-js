/**
 * @fileoverview Registers the toolbar loader, published as `posthog.toolbar`
 * like upstream (`posthog.loadToolbar(params)` delegates to it). Needs only
 * the core. Loaded as a chunk, it reads the URL hash when the chunk is parsed.
 */
import {registerExtension} from '../core/extensions.js';
import {Toolbar} from './toolbar.js';

const p = Toolbar.prototype;
p['loadToolbar'] = p.loadToolbar;
p['maybeLoadToolbar'] = p.maybeLoadToolbar;
p['maybeLoadEditor'] = p.maybeLoadEditor;
p['initialize'] = p.onInit;

registerExtension('toolbar', function(instance) {
  return new Toolbar(instance);
});
