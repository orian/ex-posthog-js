/**
 * @fileoverview HTML sanitiser for web experiment `html` transforms.
 *
 * Port of the html block of upstream `WebExperiments._applyTransforms`
 * (posthog-js 1.450.0), including the DOMPurify 3.4.13 `sanitize()` walk it
 * relies on, specialised to upstream's fixed configuration:
 *   ADD_ATTR: target on <a>, form on form-associated controls;
 *   ADD_URI_SAFE_ATTR: ['form']; NAMESPACE per context element;
 *   RETURN_DOM_FRAGMENT, or IN_PLACE for MathML text integration points.
 * Everything else is DOMPurify's defaults (KEEP_CONTENT, SAFE_FOR_XML,
 * SANITIZE_DOM, no custom elements, text/html parser). Options, hooks,
 * Trusted Types, SAFE_FOR_TEMPLATES and string input are left out.
 * The DOM operations deliberately mirror DOMPurify's (same documents,
 * iterators, cached prototype getters), so browser quirks resolve the same
 * way. Verified against the real library by test/sanitizer-chrome.mjs.
 */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/**
 * @param {string} words space-separated keys (lowercased)
 * @return {!Object<string, boolean>}
 */
function set(words) {
  const out = /** @type {!Object<string, boolean>} */ (Object.create(null));
  words.toLowerCase().split(' ').forEach(function(w) {
    if (w) out[w] = true;
  });
  return out;
}

const HTML_TAGS = 'a abbr acronym address area article aside audio b bdi bdo big blink blockquote body br button ' +
    'canvas caption center cite code col colgroup content data datalist dd decorator del details dfn dialog dir ' +
    'div dl dt element em fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hgroup hr ' +
    'html i img input ins kbd label legend li main map mark marquee menu menuitem meter nav nobr ol optgroup ' +
    'option output p picture pre progress q rp rt ruby s samp search section select shadow slot small source ' +
    'spacer span strike strong style sub summary sup table tbody td template textarea tfoot th thead time tr ' +
    'track tt u ul var video wbr';
const SVG_TAGS = 'svg a altglyph altglyphdef altglyphitem animatecolor animatemotion animatetransform circle ' +
    'clippath defs desc ellipse enterkeyhint exportparts filter font g glyph glyphref hkern image inputmode ' +
    'line lineargradient marker mask metadata mpath part path pattern polygon polyline radialgradient rect ' +
    'stop style switch symbol text textpath title tref tspan view vkern';
const SVG_FILTERS = 'feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting ' +
    'feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur ' +
    'feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile ' +
    'feTurbulence';
const SVG_DISALLOWED = 'animate color-profile cursor discard font-face font-face-format font-face-name ' +
    'font-face-src font-face-uri foreignobject hatch hatchpath mesh meshgradient meshpatch meshrow ' +
    'missing-glyph script set solidcolor unknown use';
const MATHML_TAGS = 'math menclose merror mfenced mfrac mglyph mi mlabeledtr mmultiscripts mn mo mover ' +
    'mpadded mphantom mroot mrow ms mspace msqrt mstyle msub msup msubsup mtable mtd mtext mtr munder ' +
    'munderover mprescripts';
const MATHML_DISALLOWED = 'maction maligngroup malignmark mlongdiv mscarries mscarry msgroup mstack msline ' +
    'msrow semantics annotation annotation-xml mprescripts none';

/** Allowed tags; `#text` (KEEP_CONTENT) and `tbody` (tables allowed) included. */
const ALLOWED_TAGS = set(HTML_TAGS + ' ' + SVG_TAGS + ' ' + SVG_FILTERS + ' ' + MATHML_TAGS + ' #text tbody');
const ALLOWED_ATTR = set(
    // html
    'accept action align alt autocapitalize autocomplete autopictureinpicture autoplay background bgcolor ' +
    'border capture cellpadding cellspacing checked cite class clear color cols colspan command commandfor ' +
    'controls controlslist coords crossorigin datetime decoding default dir disabled disablepictureinpicture ' +
    'disableremoteplayback download draggable enctype enterkeyhint exportparts face for headers height hidden ' +
    'high href hreflang id inert inputmode integrity ismap kind label lang list loading loop low max maxlength ' +
    'media method min minlength multiple muted name nonce noshade novalidate nowrap open optimum part pattern ' +
    'placeholder playsinline popover popovertarget popovertargetaction poster preload pubdate radiogroup ' +
    'readonly rel required rev reversed role rows rowspan spellcheck scope selected shape size sizes slot span ' +
    'srclang start src srcset step style summary tabindex title translate type usemap valign value width wrap ' +
    'xmlns ' +
    // svg
    'accent-height accumulate additive alignment-baseline amplitude ascent attributename attributetype azimuth ' +
    'basefrequency baseline-shift begin bias by class clip clippathunits clip-path clip-rule color ' +
    'color-interpolation color-interpolation-filters color-profile color-rendering cx cy d dx dy ' +
    'diffuseconstant direction display divisor dominant-baseline dur edgemode elevation end exponent fill ' +
    'fill-opacity fill-rule filter filterunits flood-color flood-opacity font-family font-size ' +
    'font-size-adjust font-stretch font-style font-variant font-weight fx fy g1 g2 glyph-name glyphref ' +
    'gradientunits gradienttransform height href id image-rendering in in2 intercept k k1 k2 k3 k4 kerning ' +
    'keypoints keysplines keytimes lang lengthadjust letter-spacing kernelmatrix kernelunitlength ' +
    'lighting-color local marker-end marker-mid marker-start markerheight markerunits markerwidth ' +
    'maskcontentunits maskunits max mask mask-type media method mode min name numoctaves offset operator ' +
    'opacity order orient orientation origin overflow paint-order path pathlength patterncontentunits ' +
    'patterntransform patternunits points preservealpha preserveaspectratio primitiveunits r rx ry radius ' +
    'refx refy repeatcount repeatdur restart result rotate scale seed shape-rendering slope ' +
    'specularconstant specularexponent spreadmethod startoffset stddeviation stitchtiles stop-color ' +
    'stop-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit ' +
    'stroke-opacity stroke stroke-width style surfacescale systemlanguage tabindex tablevalues targetx ' +
    'targety transform transform-origin text-anchor text-decoration text-orientation text-rendering ' +
    'textlength type u1 u2 unicode values viewbox visibility version vert-adv-y vert-origin-x vert-origin-y ' +
    'width word-spacing wrap writing-mode xchannelselector ychannelselector x x1 x2 xmlns y y1 y2 z ' +
    'zoomandpan ' +
    // mathMl
    'accent accentunder align bevelled close columnalign columnlines columnspacing columnspan denomalign ' +
    'depth dir display displaystyle encoding fence frame height href id largeop length linethickness lquote ' +
    'lspace mathbackground mathcolor mathsize mathvariant maxsize minsize movablelimits notation numalign ' +
    'open rowalign rowlines rowspacing rowspan rspace rquote scriptlevel scriptminsize scriptsizemultiplier ' +
    'selection separator separators stretchy subscriptshift supscriptshift symmetric voffset width xmlns ' +
    // xml
    'xlink:href xml:id xlink:title xml:space xmlns:xlink');
const ALL_SVG_TAGS = set(SVG_TAGS + ' ' + SVG_FILTERS + ' ' + SVG_DISALLOWED);
const ALL_MATHML_TAGS = set(MATHML_TAGS + ' ' + MATHML_DISALLOWED);
const COMMON_SVG_AND_HTML = set('title style font a script');
const MATHML_TEXT_INTEGRATION_POINTS = set('mi mo mn ms mtext');
const FORBID_CONTENTS = set('annotation-xml audio colgroup desc foreignobject head iframe math mi mn mo ms ' +
    'mtext noembed noframes noscript plaintext script selectedcontent style svg template thead title video xmp');
const DATA_URI_TAGS = set('audio video img source image track');
/** DOMPurify defaults plus upstream's ADD_URI_SAFE_ATTR ['form']. */
const URI_SAFE_ATTRIBUTES = set('alt class for id label name pattern placeholder role summary title value ' +
    'style xmlns form');

const DATA_ATTR = /^data-[\-\w.\u00B7-\uFFFF]+$/;
const ARIA_ATTR = /^aria-[\-\w]+$/;
const IS_ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
const ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;
const ELEMENT_MARKUP_PROBE = /<[/\w!]/;
const COMMENT_MARKUP_PROBE = /<[/\w]/;
const FALLBACK_TAG_CLOSE = /<\/no(script|embed|frames)/i;
const ATTR_COMMENT_HAZARD = /((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i;
// SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION | SHOW_PROCESSING_INSTRUCTION | SHOW_COMMENT
const SHOW_MASK = 0x1 | 0x4 | 0x8 | 0x40 | 0x80;

/**
 * Clobber-safe prototype getter, like DOMPurify's lookupGetter().
 * @param {!Object} proto
 * @param {string} prop
 * @return {function(?): ?}
 */
function getter(proto, prop) {
  for (let o = proto; o; o = Object.getPrototypeOf(o)) {
    const desc = Object.getOwnPropertyDescriptor(o, prop);
    if (desc) {
      const fn = /** @type {!Function} */ (desc.get || desc.value);
      return function(node) {
        return fn.call(node);
      };
    }
  }
  return function() {
    return null;
  };
}

/**
 * Lazily created state, mirroring what createDOMPurify(window) captures.
 * @type {?{doc: !Document, form: !Element, nodeName: function(?): ?, nodeType: function(?): ?,
 *     parentNode: function(?): ?, childNodes: function(?): ?, nextSibling: function(?): ?,
 *     attributes: function(?): ?, ownerDocument: function(?): ?, remove: function(?): ?}}
 */
let env = null;

function initEnv() {
  const elProto = Element.prototype;
  const nodeProto = Node.prototype;
  // Like DOMPurify: work in the template-contents owner document so no
  // custom element registry is inherited.
  const template = document.createElement('template');
  const content = template['content'];
  const doc = content && content.ownerDocument ? content.ownerDocument : document;
  env = {
    doc: doc,
    form: doc.createElement('form'),
    nodeName: getter(nodeProto, 'nodeName'),
    nodeType: getter(nodeProto, 'nodeType'),
    parentNode: getter(elProto, 'parentNode'),
    childNodes: getter(elProto, 'childNodes'),
    nextSibling: getter(elProto, 'nextSibling'),
    attributes: getter(elProto, 'attributes'),
    ownerDocument: getter(nodeProto, 'ownerDocument'),
    remove: getter(elProto, 'remove'),
  };
}

/**
 * One sanitize() call's state.
 * @param {string} namespace NAMESPACE option
 * @param {boolean} inPlace IN_PLACE (true) or RETURN_DOM_FRAGMENT (false)
 * @constructor
 * @struct
 */
function Walk(namespace, inPlace) {
  /** @const */ this.ns = namespace;
  /** @const */ this.inPlace = inPlace;
}

/**
 * @param {?} value
 * @return {boolean}
 */
function isNode(value) {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return typeof env.nodeType(value) === 'number';
  } catch (e) {
    return false;
  }
}

/**
 * @param {?} value
 * @return {boolean}
 */
function isFragment(value) {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return env.nodeType(value) === 11;
  } catch (e) {
    return false;
  }
}

/**
 * DOMPurify _isClobbered: a <form> whose built-ins are shadowed by named children.
 * @param {?} el
 * @return {boolean}
 */
function isClobbered(el) {
  const name = env.nodeName(el);
  if (typeof name !== 'string' || name.toLowerCase() !== 'form') return false;
  return typeof el['nodeName'] !== 'string' || typeof el['textContent'] !== 'string' ||
      typeof el['removeChild'] !== 'function' || el['attributes'] !== env.attributes(el) ||
      typeof el['removeAttribute'] !== 'function' || typeof el['setAttribute'] !== 'function' ||
      typeof el['namespaceURI'] !== 'string' || typeof el['insertBefore'] !== 'function' ||
      typeof el['hasChildNodes'] !== 'function' || el['nodeType'] !== env.nodeType(el) ||
      el['childNodes'] !== env.childNodes(el);
}

/**
 * DOMPurify _forceRemove; throws for a parentless node that cannot be detached.
 * @param {?} node
 */
function forceRemove(node) {
  try {
    env.parentNode(node).removeChild(node);
  } catch (e) {
    env.remove(node);
    if (!env.parentNode(node)) {
      throw new TypeError('a node selected for removal could not be detached from its tree ' +
          'and cannot be safely returned; refusing to sanitize in place');
    }
  }
}

/**
 * DOMPurify _checkValidNamespace.
 * @param {?} el
 * @return {boolean}
 * @this {Walk}
 */
Walk.prototype.validNamespace = function(el) {
  let parent = env.parentNode(el);
  if (!parent || !parent['tagName']) parent = {'namespaceURI': this.ns, 'tagName': 'template'};
  const tag = String(el['tagName']).toLowerCase();
  const parentTag = String(parent['tagName']).toLowerCase();
  const ns = el['namespaceURI'];
  const parentNs = parent['namespaceURI'];
  if (ns === SVG_NS) {
    if (parentNs === HTML_NS) return tag === 'svg';
    if (parentNs === MATHML_NS) {
      return tag === 'svg' && (parentTag === 'annotation-xml' || !!MATHML_TEXT_INTEGRATION_POINTS[parentTag]);
    }
    return !!ALL_SVG_TAGS[tag];
  }
  if (ns === MATHML_NS) {
    if (parentNs === HTML_NS) return tag === 'math';
    if (parentNs === SVG_NS) return tag === 'math' && parentTag === 'annotation-xml';
    return !!ALL_MATHML_TAGS[tag];
  }
  if (ns === HTML_NS) {
    if (parentNs === SVG_NS && parentTag !== 'annotation-xml') return false;
    if (parentNs === MATHML_NS && !MATHML_TEXT_INTEGRATION_POINTS[parentTag]) return false;
    return !ALL_MATHML_TAGS[tag] && (!!COMMON_SVG_AND_HTML[tag] || !ALL_SVG_TAGS[tag]);
  }
  return false;
};

/**
 * DOMPurify _sanitizeElements.
 * @param {?} node
 * @param {?} root
 * @return {boolean} whether the node was removed
 * @this {Walk}
 */
Walk.prototype.elements = function(node, root) {
  if (node !== root && env.parentNode(node) === null) return true;
  if (isClobbered(node)) {
    forceRemove(node);
    return true;
  }
  const tag = String(env.nodeName(node)).toLowerCase();
  // _isUnsafeNode: mXSS via namespace confusion, element children in <style>,
  // processing instructions and markup-bearing comments.
  if ((node.hasChildNodes() && !isNode(node['firstElementChild']) &&
       ELEMENT_MARKUP_PROBE.test(node['textContent']) && ELEMENT_MARKUP_PROBE.test(node['innerHTML'])) ||
      (node['namespaceURI'] === HTML_NS && tag === 'style' && isNode(node['firstElementChild'])) ||
      node['nodeType'] === 7 || (node['nodeType'] === 8 && COMMENT_MARKUP_PROBE.test(node['data']))) {
    forceRemove(node);
    return true;
  }
  if (!ALLOWED_TAGS[tag]) {
    // _sanitizeDisallowedNode; custom elements are never kept with the default
    // CUSTOM_ELEMENT_HANDLING, and the walk root is always allowed here.
    if (!FORBID_CONTENTS[tag]) {
      const parent = env.parentNode(node);
      const kids = env.childNodes(node);
      if (kids && parent) {
        for (let i = kids.length - 1; i >= 0; --i) parent.insertBefore(kids[i], env.nextSibling(node));
      }
    }
    forceRemove(node);
    return true;
  }
  if (env.nodeType(node) === 1 && !this.validNamespace(node)) {
    forceRemove(node);
    return true;
  }
  if ((tag === 'noscript' || tag === 'noembed' || tag === 'noframes') &&
      FALLBACK_TAG_CLOSE.test(node['innerHTML'])) {
    forceRemove(node);
    return true;
  }
  return false;
};

/**
 * DOMPurify _isValidAttribute with upstream's ADD_ATTR predicate.
 * @param {string} tag lowercase tag name
 * @param {string} name lowercase attribute name
 * @param {string} value
 * @return {boolean}
 */
function isValidAttribute(tag, name, value) {
  if (name === 'patchsrc') return false;
  if (name === 'for' && tag !== 'label' && tag !== 'output') return false;
  if ((name === 'id' || name === 'name') && (value in env.doc || value in env.form)) return false;
  if (DATA_ATTR.test(name) || ARIA_ATTR.test(name)) return true;
  const permitted = ALLOWED_ATTR[name] || (name === 'target' && tag === 'a') ||
      (name === 'form' && /^(button|fieldset|input|output|select|textarea)$/.test(tag));
  if (!permitted) return false;
  if (URI_SAFE_ATTRIBUTES[name]) return true;
  if (IS_ALLOWED_URI.test(value.replace(ATTR_WHITESPACE, ''))) return true;
  if ((name === 'src' || name === 'xlink:href' || name === 'href') && tag !== 'script' &&
      value.indexOf('data:') === 0 && DATA_URI_TAGS[tag]) {
    return true;
  }
  return !value;
}

/**
 * DOMPurify _removeAttribute: an `is` attribute cannot really be removed, so
 * the element goes (DOM return) or the value is voided (in place).
 * @param {string} name
 * @param {?} el
 * @this {Walk}
 */
Walk.prototype.removeAttribute = function(name, el) {
  el.removeAttribute(name);
  if (name !== 'is') return;
  try {
    if (this.inPlace) {
      el.setAttribute(name, '');
    } else {
      forceRemove(el);
    }
  } catch (e) {}
};

/**
 * DOMPurify _sanitizeAttributes.
 * @param {?} node
 * @this {Walk}
 */
Walk.prototype.attributes = function(node) {
  const attrs = node['attributes'];
  if (!attrs || isClobbered(node)) return;
  const tag = String(node['nodeName']).toLowerCase();
  for (let l = attrs.length; l--;) {
    const attr = attrs[l];
    const name = attr.name;
    const ns = attr.namespaceURI;
    const initValue = attr.value;
    const lcName = name.toLowerCase();
    const value = name === 'value' ? initValue : initValue.trim();
    if (ATTR_COMMENT_HAZARD.test(value) || (lcName === 'attributename' && /href/.test(value)) ||
        !isValidAttribute(tag, lcName, value)) {
      this.removeAttribute(name, node);
      continue;
    }
    if (value !== initValue) {
      try {
        if (ns) {
          node.setAttributeNS(ns, name, value);
        } else {
          node.setAttribute(name, value);
        }
        if (isClobbered(node)) forceRemove(node);
      } catch (e) {
        this.removeAttribute(name, node);
      }
    }
  }
};

/**
 * Main loop of DOMPurify sanitize() / _sanitizeShadowDOM over `root`
 * (template contents are walked recursively).
 * @param {?} root
 * @this {Walk}
 */
Walk.prototype.walk = function(root) {
  const owner = env.ownerDocument(root);
  const it = (owner || root).createNodeIterator(root, SHOW_MASK, null);
  for (let node; (node = it.nextNode());) {
    this.elements(node, root);
    this.attributes(node);
    if (isFragment(node['content'])) this.walk(node['content']);
  }
};

/**
 * DOMPurify sanitize(fragment, {RETURN_DOM_FRAGMENT: true, NAMESPACE}).
 * Instead of returning a fragment, the sanitised nodes are appended to
 * `container` (which is what upstream does with the returned fragment).
 * @param {!Node} fragment
 * @param {string} namespace
 * @param {!Node} container
 */
function sanitizeToContainer(fragment, namespace, container) {
  const walk = new Walk(namespace, false);
  let body;
  if (namespace === HTML_NS) {
    const parsed = new DOMParser().parseFromString('<!---->', 'text/html');
    body = parsed.getElementsByTagName('body')[0];
  } else {
    // DOMPurify also parses '<!---->' into this root; it makes no difference,
    // since the SVG/MathML-namespace <template> root itself fails the
    // namespace check and is detached either way.
    const xmlDoc = env.doc.implementation.createDocument(namespace, 'template', null);
    body = xmlDoc['body'] || xmlDoc.documentElement;
  }
  body.appendChild(body.ownerDocument.importNode(fragment, true));
  walk.walk(body);
  while (body.firstChild) container.appendChild(body.firstChild);
}

/**
 * DOMPurify sanitize(root, {IN_PLACE: true, NAMESPACE}). The root is always an
 * allowed, unclobberable MathML token element, so the entry checks cannot
 * fail; the walk throws (like DOMPurify) if the root itself fails the mXSS
 * probe. DOMPurify's pre-pass and fail-closed teardown are omitted: they have
 * no effect on the output (its pre-pass removal of comments calls
 * Element.prototype.remove on them, which throws and is ignored; `for` and
 * `patchsrc` are stripped by the walk anyway), and after a throw upstream
 * discards the context.
 * @param {!Element} root
 * @param {string} namespace
 */
function sanitizeInPlace(root, namespace) {
  new Walk(namespace, true).walk(root);
}

/**
 * Upstream WebExperiments._sanitizeLinkTargets: drops `target` except
 * `_blank` on HTML links, which also get rel="noopener".
 * @param {!Node} context
 */
function sanitizeLinkTargets(context) {
  const root = context['namespaceURI'] === HTML_NS && context['localName'] === 'template' ?
      context['content'] : context;
  const found = root.querySelectorAll('a[target], template');
  for (let i = 0; i < found.length; i++) {
    const el = found[i];
    if (el.localName === 'template') {
      if (el.namespaceURI === HTML_NS) sanitizeLinkTargets(el);
      continue;
    }
    const target = el.getAttribute('target');
    if (el.namespaceURI !== HTML_NS || target === null || target.toLowerCase() !== '_blank') {
      el.removeAttribute('target');
      continue;
    }
    const rel = (el.getAttribute('rel') || '').split(/\s+/).filter(function(token) {
      return !!token && !/^(opener|noopener)$/i.test(token);
    });
    rel.push('noopener');
    el.setAttribute('rel', rel.join(' '));
  }
}

/**
 * Returns the sanitised innerHTML upstream would assign for `html` on
 * `element` (the whole html block of upstream WebExperiments._applyTransforms:
 * inert document, contextual fragment, namespace selection, MathML
 * integration-point IN_PLACE path, template content, DOMPurify with
 * EXPERIMENT_HTML_CONFIG, _sanitizeLinkTargets). Throws where upstream's
 * DOMPurify would (an in-place MathML root that itself fails the mXSS probe).
 * @param {!Element} element target element
 * @param {string} html
 * @return {string}
 */
export function sanitizeExperimentHtml(element, html) {
  if (!env) initEnv();
  const elNs = element.namespaceURI;
  const localName = String(element['localName']);
  const encoding = elNs === MATHML_NS && localName === 'annotation-xml' ?
      (element.getAttribute('encoding') || '').toLowerCase() : '';
  // Parse in an inert document so unsanitised content cannot execute or upgrade custom elements.
  const inertDocument = element.ownerDocument.implementation.createHTMLDocument('');
  const context = inertDocument.createElementNS(elNs, localName);
  if (encoding) context.setAttribute('encoding', encoding);
  const range = inertDocument.createRange();
  range.selectNodeContents(context);
  const namespace = (elNs === SVG_NS && /^(foreignObject|desc|title)$/.test(localName)) ||
      /^(text\/html|application\/xhtml\+xml)$/.test(encoding) ? HTML_NS : (elNs || HTML_NS);
  const fragment = /** @type {!DocumentFragment} */ (range.createContextualFragment(html));
  if (elNs === MATHML_NS && /^(mi|mo|mn|ms|mtext)$/.test(localName)) {
    // Keep the integration-point parent so both HTML and MathML children retain their namespaces.
    context.appendChild(fragment);
    sanitizeInPlace(context, namespace);
  } else {
    const container = context.namespaceURI === HTML_NS && context['localName'] === 'template' ?
        context['content'] : context;
    sanitizeToContainer(fragment, namespace, container);
  }
  sanitizeLinkTargets(context);
  return context.innerHTML;
}
