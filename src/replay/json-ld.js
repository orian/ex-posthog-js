/**
 * @fileoverview Port of upstream replay/external/json-ld.ts: captures
 * sanitised schema.org JSON-LD as `$json_ld` replay custom events
 * (`session_recording.captureJsonLd`).
 */
import {isArray, isNull, isObject, isString, isUndefined} from '../core/utils.js';

const MAX_JSON_LD_LENGTH = 100000;
const MAX_JSON_LD_OUTPUT_LENGTH = 20000;
const MAX_JSON_LD_TYPE_LENGTH = 100;
const SCHEMA_TERM_PATTERN = /^[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/;
const MAX_JSON_LD_TYPES = 20;
const MAX_JSON_LD_NODES = 2048;
const SCHEMA_CONTEXT = 'https://schema.org';
/** @const {!Array<string>} */
const ANY_ENTITY_TYPES = [];
/** @param {string} id @return {boolean} */
const NO_CAPTURED_DOM_IDS = function(id) {
  return false;
};
const UNIVERSALLY_ALLOWED_PROPERTIES = ('@type @id actionStatus availability bestRating contentRating ' +
    'encodingFormat eventAttendanceMode eventStatus highPrice inLanguage isAccessibleForFree isFamilyFriendly ' +
    'itemCondition itemListOrder lowPrice maximumAttendeeCapacity nonprofitStatus numberOfItems offerCount position ' +
    'price priceCurrency priceValidUntil publicAccess ratingCount ratingValue reviewCount smokingAllowed worstRating')
    .split(' ');
const ACTION_TYPES = 'Action BorrowAction ReadAction SearchAction SeekToAction SolveMathAction WatchAction'.split(' ');
const ORGANIZATION_TYPES = ('AutoDealer Bakery BarOrPub CafeOrCoffeeShop CollegeOrUniversity Corporation DaySpa ' +
    'Dentist EducationalOrganization Electrician FoodEstablishment GovernmentOrganization HealthClub Hotel ' +
    'LegalService Library LibrarySystem LocalBusiness Locksmith LodgingBusiness MedicalBusiness NGO OnlineStore ' +
    'Organization PerformingGroup Pharmacy Physician Plumber RealEstateAgent Restaurant School SportsOrganization Store')
    .split(' ');
const PLACE_TYPES = 'Accommodation AdministrativeArea Country Place State'.split(' ');

/** @const {!Object<string, !Object<string, (boolean|!Array<string>)>>} */
const ENTITY_RULES = {
  'AggregateOffer': {'offers': ['Offer']},
  'Brand': {'name': true},
  'BreadcrumbList': {'itemListElement': ['ListItem']},
  'CreativeWork': {
    'genre': true, 'dateCreated': true, 'dateModified': true, 'datePublished': true, 'expires': true,
    'learningResourceType': true, 'educationalLevel': true, 'educationalUse': true, 'interactivityType': true,
    'aggregateRating': ['AggregateRating'], 'potentialAction': ACTION_TYPES, 'publisher': ORGANIZATION_TYPES,
  },
  'Event': {
    'startDate': true, 'endDate': true, 'previousStartDate': true, 'aggregateRating': ['AggregateRating'],
    'offers': ['AggregateOffer', 'Offer'],
  },
  'ItemList': {'itemListElement': ['ListItem']},
  'ListItem': {'item': ANY_ENTITY_TYPES},
  'Offer': {'seller': ORGANIZATION_TYPES},
  'Organization': {
    'name': true, 'legalName': true, 'foundingDate': true, 'dissolutionDate': true,
    'aggregateRating': ['AggregateRating'], 'brand': ['Brand'],
  },
  'Place': {'aggregateRating': ['AggregateRating']},
  'Product': {
    'name': true, 'sku': true, 'mpn': true, 'gtin': true, 'gtin8': true, 'gtin12': true, 'gtin13': true,
    'gtin14': true, 'productID': true, 'productGroupID': true, 'asin': true, 'model': true, 'category': true,
    'color': true, 'material': true, 'pattern': true, 'size': true, 'productionDate': true, 'releaseDate': true,
    'brand': ['Brand', 'Organization'], 'manufacturer': ORGANIZATION_TYPES, 'offers': ['Offer', 'AggregateOffer'],
    'aggregateRating': ['AggregateRating'],
  },
  'Service': {
    'name': true, 'serviceType': true, 'category': true, 'provider': ORGANIZATION_TYPES, 'areaServed': PLACE_TYPES,
    'offers': ['AggregateOffer', 'Offer'], 'aggregateRating': ['AggregateRating'],
  },
  'OfferCatalog': {'name': true, 'itemListElement': ANY_ENTITY_TYPES},
};

/** @const {!Array<!Array<?>>} */
const INHERITED_RULE_GROUPS = [
  [('3DModel AboutPage Answer Article AudioObject Blog BlogPosting Book Clip CollectionPage Comment ContactPage ' +
    'Course CreativeWorkSeason CreativeWorkSeries DataCatalog DataDownload DataFeed Dataset DiscussionForumPosting ' +
    'Episode FAQPage Game HowTo HowToDirection HowToSection HowToStep HowToTip ImageObject LearningResource ' +
    'MediaObject Message MobileApplication Movie MusicPlaylist MusicRecording NewsArticle Photograph PodcastEpisode ' +
    'PodcastSeries ProfilePage QAPage Question Quiz Recipe Review ScholarlyArticle SearchResultsPage ' +
    'SiteNavigationElement SocialMediaPosting SoftwareApplication TVEpisode TVSeries TechArticle VacationRental ' +
    'VideoGame VideoObject WebApplication WebPage WebPageElement WebSite').split(' '), ENTITY_RULES['CreativeWork']],
  ['BroadcastEvent BusinessEvent EducationEvent Festival MusicEvent SportsEvent TheaterEvent'.split(' '),
    ENTITY_RULES['Event']],
  [ORGANIZATION_TYPES, ENTITY_RULES['Organization']],
  [PLACE_TYPES, ENTITY_RULES['Place']],
  ['Car IndividualProduct ProductGroup ProductModel'.split(' '), ENTITY_RULES['Product']],
];

/** @const {string} */
export const JSON_LD_EVENT_TAG = '$json_ld';

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * @param {!Object} value
 * @param {string} property
 * @return {*}
 */
function getOwnProperty(value, property) {
  return hasOwn.call(value, property) ? value[property] : undefined;
}

/**
 * @param {*} value
 * @return {boolean}
 */
function isScalar(value) {
  const type = typeof value;
  return isNull(value) || type === 'string' || type === 'number' || type === 'boolean';
}

/**
 * @param {*} value
 * @return {boolean}
 */
function isUrl(value) {
  return isString(value) && /^(https?:\/\/|\/|\.\.?\/)/i.test(/** @type {string} */ (value).trim());
}

/**
 * @param {*} value
 * @param {(function(string): (string|undefined))=} maskUrl
 * @return {*}
 */
function maskScalarUrl(value, maskUrl) {
  return maskUrl && isUrl(value) ? maskUrl(/** @type {string} */ (value).trim()) || undefined : value;
}

/**
 * @param {*} value
 * @param {(function(string): (string|undefined))=} maskUrl
 * @return {*}
 */
function sanitizeScalar(value, maskUrl) {
  if (isArray(value) && /** @type {!Array<*>} */ (value).every(isScalar)) {
    return /** @type {!Array<*>} */ (value).map(function(item) {
      return maskScalarUrl(item, maskUrl);
    }).filter(function(item) {
      return !isUndefined(item);
    });
  }
  return isScalar(value) ? maskScalarUrl(value, maskUrl) : undefined;
}

/**
 * @param {*} value
 * @param {function(string): boolean} isCapturedDomId
 * @return {string|undefined}
 */
function sanitizeId(value, isCapturedDomId) {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  const hashIndex = id.indexOf('#');
  const fragment = hashIndex >= 0 ? id.slice(hashIndex + 1) : id;
  if (!fragment || (hashIndex < 0 && (/^[a-z][a-z\d+.-]*:/i.test(id) || id.indexOf('/') !== -1 ||
      id.indexOf('?') !== -1))) {
    return undefined;
  }
  try {
    return isCapturedDomId(fragment) ? fragment : undefined;
  } catch (e) {
    return undefined;
  }
}

/**
 * @param {string} type
 * @return {!Object<string, (boolean|!Array<string>)>|undefined}
 */
function getEntityRules(type) {
  if (hasOwn.call(ENTITY_RULES, type)) return ENTITY_RULES[type];
  for (let i = 0; i < INHERITED_RULE_GROUPS.length; i++) {
    if (INHERITED_RULE_GROUPS[i][0].indexOf(type) !== -1) return INHERITED_RULE_GROUPS[i][1];
  }
  return undefined;
}

/**
 * @param {*} value
 * @return {!Array<string>}
 */
function getEntityTypes(value) {
  const seen = {};
  const values = typeof value === 'string' ? [value] : isArray(value) ? /** @type {!Array<*>} */ (value) : [];
  const types = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'string') continue;
    const type = v.replace(/^https?:\/\/schema\.org\//, '');
    if (type.length > MAX_JSON_LD_TYPE_LENGTH || !SCHEMA_TERM_PATTERN.test(type) || hasOwn.call(seen, type)) continue;
    seen[type] = true;
    types.push(type);
    if (types.length === MAX_JSON_LD_TYPES) break;
  }
  return types;
}

/** @typedef {{maskUrl: ((function(string): (string|undefined))|undefined), remainingNodes: number, exceeded: boolean}} */
let SanitizationContext;

/**
 * @param {!SanitizationContext} context
 * @return {boolean}
 */
function takeNode(context) {
  if (!context.remainingNodes) {
    context.exceeded = true;
    return false;
  }
  context.remainingNodes--;
  return true;
}

/**
 * @param {!Object} result
 * @param {string} property
 * @param {*} value
 */
function setOwnProperty(result, property, value) {
  Object.defineProperty(result, property, {configurable: true, enumerable: true, value: value, writable: true});
}

/**
 * @param {*} value
 * @param {function(string): boolean} isCapturedDomId
 * @param {!SanitizationContext} context
 * @param {!Array<string>=} allowedTypes
 * @return {*}
 */
function sanitizeEntityValue(value, isCapturedDomId, context, allowedTypes) {
  if (isArray(value)) {
    const items = /** @type {!Array<*>} */ (value).map(function(item) {
      return sanitizeEntityValue(item, isCapturedDomId, context, allowedTypes);
    }).filter(function(item) {
      return !isUndefined(item);
    });
    return items.length ? items : undefined;
  }
  return sanitizeEntity(value, isCapturedDomId, context, allowedTypes) || undefined;
}

/**
 * @param {*} value
 * @param {function(string): boolean} isCapturedDomId
 * @param {!SanitizationContext} context
 * @param {!Array<string>=} allowedTypes
 * @return {?Object}
 */
function sanitizeEntity(value, isCapturedDomId, context, allowedTypes) {
  if (!isObject(value) || !takeNode(context)) return null;
  const obj = /** @type {!Object} */ (value);
  const typeValue = getOwnProperty(obj, '@type');
  const types = getEntityTypes(typeValue);
  const typesWithAllowedFields = types.filter(function(type) {
    return !!getEntityRules(type) && (!allowedTypes || !allowedTypes.length || allowedTypes.indexOf(type) !== -1);
  });
  const result = {};
  UNIVERSALLY_ALLOWED_PROPERTIES.forEach(function(property) {
    const propertyValue = property === '@type' ?
        (types.length ? (typeof typeValue === 'string' ? types[0] : types) : undefined) :
        property === '@id' ? sanitizeId(getOwnProperty(obj, property), isCapturedDomId) :
        sanitizeScalar(getOwnProperty(obj, property), context.maskUrl);
    if (!isUndefined(propertyValue)) setOwnProperty(result, property, propertyValue);
  });
  typesWithAllowedFields.forEach(function(type) {
    const rules = /** @type {!Object<string, (boolean|!Array<string>)>} */ (getEntityRules(type));
    Object.keys(rules).forEach(function(property) {
      const propertyValue = getOwnProperty(obj, property);
      const rule = rules[property];
      if (rule === true) {
        const scalar = sanitizeScalar(propertyValue, context.maskUrl);
        if (!isUndefined(scalar)) setOwnProperty(result, property, scalar);
      } else {
        const nested = sanitizeEntityValue(propertyValue, isCapturedDomId, context,
            /** @type {!Array<string>} */ (rule));
        if (!isUndefined(nested)) setOwnProperty(result, property, nested);
      }
    });
  });
  const graph = sanitizeEntityValue(getOwnProperty(obj, '@graph'), isCapturedDomId, context);
  if (!isUndefined(graph)) setOwnProperty(result, '@graph', graph);
  return Object.keys(result).length ? result : null;
}

/**
 * @param {*} value
 * @param {function(string): boolean} isCapturedDomId
 * @param {!SanitizationContext} context
 * @return {?Object}
 */
function sanitizeRoot(value, isCapturedDomId, context) {
  if (!isObject(value)) return null;
  const schemaContext = getOwnProperty(/** @type {!Object} */ (value), '@context');
  if (typeof schemaContext !== 'string' || !/^https?:\/\/schema\.org\/?$/.test(schemaContext)) return null;
  const entity = sanitizeEntity(value, isCapturedDomId, context);
  if (!entity) return null;
  const out = {'@context': SCHEMA_CONTEXT};
  for (const k in entity) out[k] = entity[k];
  return out;
}

/**
 * @param {string} text
 * @param {(function(string): boolean)=} isCapturedDomId
 * @param {(function(string): (string|undefined))=} maskUrl
 * @return {?Array<*>} [sanitized, json]
 */
export function sanitizeJsonLd(text, isCapturedDomId, maskUrl) {
  if (!text || text.length > MAX_JSON_LD_LENGTH) return null;
  const isCaptured = isCapturedDomId || NO_CAPTURED_DOM_IDS;
  try {
    const value = JSON.parse(text);
    /** @type {!SanitizationContext} */
    const context = {maskUrl: maskUrl, remainingNodes: MAX_JSON_LD_NODES, exceeded: false};
    const sanitized = isArray(value) ? /** @type {!Array<*>} */ (value).map(function(root) {
      return sanitizeRoot(root, isCaptured, context);
    }) : sanitizeRoot(value, isCaptured, context);
    if (context.exceeded || isNull(sanitized) ||
        (isArray(sanitized) && (!/** @type {!Array<*>} */ (sanitized).length ||
        /** @type {!Array<*>} */ (sanitized).some(isNull)))) {
      return null;
    }
    const output = JSON.stringify(sanitized);
    return output.length <= MAX_JSON_LD_OUTPUT_LENGTH ? [sanitized, output] : null;
  } catch (e) {
    return null;
  }
}

/**
 * @param {!Node} node
 * @return {boolean}
 */
function isJsonLdScript(node) {
  if (node.nodeName !== 'SCRIPT') return false;
  const t = /** @type {!Element} */ (node).getAttribute('type');
  return !!t && t.trim().toLowerCase() === 'application/ld+json';
}

/**
 * @typedef {{
 *   maskUrl: ((function(string): (string|undefined))|undefined),
 *   attributeFilter: (!Array<string>|undefined),
 *   blockClass: (string|!RegExp|undefined),
 *   blockSelector: (?string|undefined),
 *   isRecordedElement: ((function(!Element): boolean)|undefined),
 *   maskAllElementAttributes: (boolean|undefined),
 *   maskAttributeFn: (?Function|undefined),
 *   maskTextClass: (string|!RegExp|undefined),
 *   maskTextSelector: (?string|undefined),
 *   emit: function(*): boolean,
 *   getCaptureState: ((function(): ?boolean)|undefined),
 * }}
 */
export let JsonLdOptions;

/**
 * @param {!Element} element
 * @param {string|!RegExp|undefined} classRule
 * @param {?string|undefined} selector
 * @return {boolean}
 */
function matchesPrivacyRule(element, classRule, selector) {
  if (typeof classRule === 'string' ? element.classList.contains(classRule) :
      !!classRule && Array.prototype.slice.call(element.classList).some(function(className) {
        const re = /** @type {!RegExp} */ (classRule);
        re.lastIndex = 0;
        return re.test(className);
      })) {
    return true;
  }
  try {
    return !!selector && element.matches(selector);
  } catch (e) {
    return false;
  }
}

/**
 * @param {!Element} element
 * @param {string|!RegExp|undefined} classRule
 * @param {?string|undefined} selector
 * @return {boolean}
 */
function isWithinBoundary(element, classRule, selector) {
  for (let current = /** @type {?Element} */ (element); current;) {
    if (matchesPrivacyRule(current, classRule, selector)) return true;
    const parentNode = current.parentNode;
    current = current.parentElement ||
        (parentNode && parentNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE ?
            /** @type {!ShadowRoot} */ (parentNode).host : null);
  }
  return false;
}

/**
 * @param {!Element} element
 * @param {!JsonLdOptions} options
 * @return {boolean}
 */
function isWithinPrivacyBoundary(element, options) {
  return isWithinBoundary(element, options.blockClass, options.blockSelector) ||
      isWithinBoundary(element, options.maskTextClass, options.maskTextSelector);
}

/**
 * @param {!Document} doc
 * @param {!JsonLdOptions} options
 * @return {function(string): boolean}
 */
function createCapturedDomIdMatcher(doc, options) {
  const attributeFilter = options.attributeFilter;
  if (options.maskAllElementAttributes || options.maskAttributeFn ||
      (attributeFilter && attributeFilter.length && attributeFilter.indexOf('id') === -1)) {
    return NO_CAPTURED_DOM_IDS;
  }
  return function(id) {
    const element = doc.getElementById(id);
    return !!element && element.nodeName !== 'SCRIPT' &&
        (!options.isRecordedElement || options.isRecordedElement(element)) &&
        !isWithinBoundary(element, options.blockClass, options.blockSelector);
  };
}

/**
 * @param {!Node} node
 * @return {!Array<!HTMLScriptElement>}
 */
function getJsonLdScripts(node) {
  if (isJsonLdScript(node)) return [/** @type {!HTMLScriptElement} */ (node)];
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  return Array.prototype.slice.call(/** @type {!Element} */ (node).querySelectorAll('script')).filter(isJsonLdScript);
}

/**
 * @param {!Document} doc
 * @param {function(new:MutationObserver, function(!Array<!MutationRecord>, !MutationObserver))} MutationObserverClass
 * @param {!JsonLdOptions} options
 * @return {{scan: function(boolean=), stop: function()}}
 */
export function startJsonLdCapture(doc, MutationObserverClass, options) {
  const lastJsonByScript = new WeakMap();
  const getCaptureState = options.getCaptureState || function() {
    return true;
  };
  let remainingLength = MAX_JSON_LD_LENGTH;
  const hasCapturedDomId = createCapturedDomIdMatcher(doc, options);

  /** @param {!HTMLScriptElement} script */
  const captureScript = function(script) {
    try {
      const captureState = getCaptureState();
      if (!remainingLength || captureState === false || !script.isConnected || script.ownerDocument !== doc ||
          isWithinPrivacyBoundary(script, options)) {
        return;
      }
      const sanitized = sanitizeJsonLd(script.text, hasCapturedDomId, options.maskUrl);
      if (!sanitized) {
        lastJsonByScript.delete(script);
        return;
      }
      const jsonLd = sanitized[0];
      const json = /** @type {string} */ (sanitized[1]);
      if (isNull(captureState)) {
        lastJsonByScript.set(script, json);
        return;
      }
      if (lastJsonByScript.get(script) !== json) {
        if (json.length > remainingLength) {
          remainingLength = 0;
          return;
        }
        if (options.emit(jsonLd)) {
          lastJsonByScript.set(script, json);
          remainingLength -= json.length;
        }
      }
    } catch (e) {
      return;
    }
  };

  try {
    const observer = new MutationObserverClass(function(mutations) {
      try {
        if (!remainingLength || getCaptureState() === false) return;
        /** @param {!Node} node */
        const captureScripts = function(node) {
          getJsonLdScripts(node).forEach(captureScript);
        };
        mutations.forEach(function(mutation) {
          if (mutation.type === 'childList') {
            if (isJsonLdScript(/** @type {!Node} */ (mutation.target))) captureScript(/** @type {!HTMLScriptElement} */ (mutation.target));
            Array.prototype.forEach.call(mutation.addedNodes, captureScripts);
          } else if (mutation.type === 'characterData') {
            const parent = mutation.target.parentNode;
            if (parent && isJsonLdScript(parent)) captureScript(/** @type {!HTMLScriptElement} */ (parent));
          } else if (mutation.type === 'attributes' && isJsonLdScript(/** @type {!Node} */ (mutation.target))) {
            captureScript(/** @type {!HTMLScriptElement} */ (mutation.target));
          }
        });
      } catch (e) {
        return;
      }
    });
    observer.observe(doc, /** @type {!MutationObserverInit} */ ({
      'attributes': true, 'attributeFilter': ['type'], 'characterData': true, 'childList': true, 'subtree': true,
    }));
    /** @param {boolean=} force */
    const scan = function(force) {
      if (!remainingLength || getCaptureState() === false) return;
      getJsonLdScripts(/** @type {!Node} */ (doc.documentElement)).forEach(function(script) {
        if (force) lastJsonByScript.delete(script);
        captureScript(script);
      });
    };
    return {scan: scan, stop: function() {
      observer.disconnect();
    }};
  } catch (e) {
    return {scan: function(force) {}, stop: function() {}};
  }
}
