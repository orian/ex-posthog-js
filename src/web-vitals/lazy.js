/**
 * @fileoverview The lazy part `web-vitals`: Google's web-vitals 6.2.1
 * (third_party/web-vitals), what upstream's four `/static/web-vitals*.js`
 * flavours bundle. One part serves every flavour; the extension picks the
 * attributed or plain callbacks from it.
 */
import {provideLazy} from '../core/lazy.js';
import {onCLS, onFCP, onINP, onLCP} from '../../third_party/web-vitals/metrics.js';
import {
  onCLS as onCLSWithAttribution, onFCP as onFCPWithAttribution, onINP as onINPWithAttribution,
  onLCP as onLCPWithAttribution, startResourceBuffer,
} from '../../third_party/web-vitals/attribution.js';
import {WEB_VITALS_KIND, WebVitalsPart} from './web-vitals.js';

const callbacks = {'onLCP': onLCP, 'onCLS': onCLS, 'onFCP': onFCP, 'onINP': onINP};

provideLazy(WEB_VITALS_KIND, /** @type {!WebVitalsPart} */ ({
  callbacks: callbacks,
  callbacksWithAttribution: {
    'onLCP': onLCPWithAttribution, 'onCLS': onCLSWithAttribution, 'onFCP': onFCPWithAttribution,
    'onINP': onINPWithAttribution, 'withoutAttribution': callbacks,
  },
  startResourceBuffer: startResourceBuffer,
}));
