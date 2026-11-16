# Exception capture: upstream behaviour spec

This spec is extracted from posthog-js upstream (see `upstream/packages`). Sources:
- `browser/src/posthog-core.ts` (`captureException`)
- `browser/src/posthog-exceptions.ts`
- `browser/src/extensions/exception-autocapture/index.ts`
- `browser/src/entrypoints/exception-autocapture.ts`
- `core/src/error-tracking/**` (error-properties-builder, coercers/*, parsers/*, chunk-ids, release, exception-steps)
- `core/src/utils/bucketed-rate-limiter.ts`

When this document and the source disagree, the source wins.

## 1. Event
`$exception` properties are built by `ErrorPropertiesBuilder.buildFromUnknown`:
- `$exception_list`: a flat array.
- `$exception_level: 'error'`, always.
- `$exception_steps`: added when steps are enabled (`{enabled:true, max_bytes:32768}` by default), the buffer is non-empty, and the caller didn't supply the key. The buffer is filled by `addExceptionStep(message, props)`; each item is `{$message, $timestamp: ISO, ...props}`. It is cleared after a successful capture, and also when capture throws.
- `$release_id`: from `globalThis._posthogReleaseId` (a non-empty string) or `process.env.POSTHOG_RELEASE_ID`.
- `captureException(error, props)` sends `{...built, ...props}`, so the caller can override anything, for example `$exception_fingerprint`. The SDK never sets `$exception_fingerprint` or `$exception_personURL` itself.

### List items
`{type, value, mechanism, stacktrace?: {type:'raw', frames}}`, built depth first:
- Root mechanism: `{type: mechanism.type || 'generic', handled (default true), synthetic, exception_id: 0}`.
- Each `cause`, and each `AggregateError` member: `{type:'chained', source:'cause'|'member', synthetic, exception_id: <list index>, parent_id}`.
- `stacktrace` is present only when the parsed stack exists. An empty array still counts as present.
- Limits: `MAX_EXCEPTIONS = 50`, `MAX_AGGREGATE_MEMBER_INSPECTIONS = 1000`, wrapper forwarding up to `MAX_WRAPPER_RECURSION = 4`.
- Objects already seen are skipped, which breaks cycles.
- `AggregateError` is detected by walking the prototype chain for a constructor named `'AggregateError'`.
- If coercion throws on a node, it becomes `{type:'Error', value:'Unknown error', synthetic:true}`.

### Frames
A frame is `{platform:'web:javascript', filename, function, in_app, lineno?, colno?, chunk_id?}`.
- `'<anonymous>'` as a function name becomes `'?'`, and a missing function name becomes `'?'`.
- After reversing, a missing `filename` is filled from the last frame.
- `chunk_id` comes from `globalThis._posthogChunkIds` or `globalThis._debugIds`: the SDK parses each key (a stack string) and maps the filename of its last parsed frame to the chunk id.
- Order: oldest call first, throwing frame **last**.
- Limits: `STACKTRACE_FRAME_LIMIT = 50` and `STACKTRACE_LINE_LIMIT = 1000`. Lines longer than 1024 characters are skipped.
- Parsing runs newest first, stops at 50 frames, then reverses the result.
- Recursion: adjacent repeated cycles of length 10 or less are collapsed to a single copy. A stack that is entirely one cycle is rotated to its lexicographically smallest rotation, using the key `function|filename|lineno|colno|module`.
- Line preprocessing:
  - `/\(error: (.*)\)/` is replaced with `$1`.
  - Lines matching `/\S*Error: /` are skipped.
  - `skipFirstLines` (1 by default, 2 for console) applies only when the stack is synthetic.

## 2. Coercers (first match wins)
1. **DOMException / DOMError** (by toString tag):
   - type is the tag.
   - value is `name ? name+': '+message : name`, where `name = err.name || 'DOMException'`.
   - stack is `err.stack`; there is no synthetic stack.
   - cause comes from `err.cause`.
2. **PromiseRejectionEvent** (by tag, or an Event whose `detail` has `reason`):
   - reason is `ev.reason ?? ev.detail.reason ?? ev`.
   - A primitive reason gives `{type:'UnhandledRejection', value:'Non-Error promise rejection captured with value: '+String(reason), synthetic:true}`.
   - Anything else is forwarded to the next coercer.
3. **ErrorEvent** (by tag, when `error != undefined` or `message` is a non-empty string):
   - If `error` is set, it is forwarded.
   - Otherwise `message` goes through the String coercer, with stack `"Error\n    at ${filename}:${lineno}:${colno||0}"` (only when `filename` is non-empty and `lineno !== 0`). synthetic is true.
4. **Error** (tag Error/Exception/DOMException/DOMError/WebAssembly.Exception, or `instanceof Error`):
   - type is `name || constructor.name`.
   - value is `String(message)`, or `message.error.message` if that is a string.
   - stack is `stacktrace || stack`; if neither exists, the synthetic stack is used and synthetic is true.
   - cause comes from `err.cause`.
5. **Event**: type is `constructor.name`, value is `` `${ctor} captured as exception with keys: ${keys}` ``, synthetic is true.
6. **Object**:
   - An own property holding an Error is forwarded.
   - type is `name` (a non-empty string), else `'Error'`.
   - value: `` `'${name}' captured as exception` `` plus `` ` with message: '${message}'` `` when `name` is a string; else `message` when it is a string; else `` `${cls!=='Object' ? "'"+cls+"'" : 'Object'} captured as exception with keys: ${keys}` ``.
   - stack is `stacktrace || stack`, else synthetic.
7. **String**:
   - Pattern: `/^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/i`.
   - type is `g1 ?? 'Error'` and value is `g2 ?? input`. synthetic is true.
8. **Primitive**: `{type:'Error', value:'Primitive value captured as exception: '+String(v), synthetic:true}`.

If nothing matches: `{type:'Error', value:'Unknown error', synthetic:true}`.

`keys` is `Object.keys(obj)` sorted and joined with `', '`, adding keys until the next one would push the length past 40. With no keys it is `'[object has no keys]'`.

## 3. Stack parsers
Lines go to the Chrome parser first, then the Gecko parser.

Chrome:
```
noFn  = /^\s*at (\S+?)(?::(\d+))(?::(\d+))\s*$/i
main  = /^\s*at (?:(.+?\)(?: \[.+\])?|.*?) ?\((?:address at )?)?(?:async )?((?:<anonymous>|[-a-z]+:|.*bundle|\/)?.*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i
eval  = /\((\S*)(?::(\d+))(?::(\d+))\)/   // applied to parts[2] when it starts with 'eval'
```
Gecko:
```
main = /^\s*(.*?)(?:\((.*?)\))?(?:^|@)?((?:[-a-z]+)?:\/.*?|\[native code\]|[^@]*(?:bundle|\d+\.js)|\/[\w\-. /=]+)(?::(\d+))?(?::(\d+))?\s*$/i
eval = /(\S+) line (\d+)(?: > eval line \d+)* > eval/i   // when parts[3] contains ' > eval'; func = parts[1]||'eval', no colno
```
Safari extensions: when the function name contains `safari-extension` or `safari-web-extension`, the function becomes the text before `'@'`, and the filename gets the matching `'<scheme>:'` prefix.

`in_app`:
- `false` when the filename is empty or `'<anonymous>'`.
- Otherwise `true` when the filename has no `/^([a-z][a-z0-9.+-]+):/i` scheme, or its scheme is one of http, https, file, blob, app, capacitor, ionic, webpack, webpack-internal, ng.

## 4. Autocapture
The handlers live in a lazy-loaded bundle upstream (`exception-autocapture`). All of them:
- set the marker `__POSTHOG_INSTRUMENTED__`
- return an unwrap function
- run inside try/catch and never log (to avoid re-entering `console.error`)

**`window.onerror` wrapper**
- Input: `error` if it is non-null; else, when `event` and `source` are strings and `source` is non-empty, `new ErrorEvent('error', {message, filename: source, lineno, colno})`; else `event`.
- Builds with `{mechanism:{handled:false}}`. There is no synthetic exception.
- Calls the original handler and returns its result `?? false`.

**`window.onunhandledrejection` wrapper**
- Uses the same pattern, with `{handled:false}`.

**`console.error` wrapper**
- Ignores the SDK's own logs: more than one argument, a string first argument, and either `/^\[PostHog\.js\](?: |$)/` or `'rrweb logger error:'`.
- Input: the first argument that is `instanceof Error`; else `args[0]` for one argument; else `args.join(' ')`.
- Builds with `{mechanism:{handled:true, type:'onconsole'}, syntheticException, skipFirstLines:2}`.
- Always calls the original `console.error`.

**Configuration** (`capture_exceptions`, default `undefined`):
- The base config has every key false.
- An object is merged over that base, so missing keys stay **false**.
- `true`, or `undefined` while the remote flag is on, enables errors and rejections.
- The remote flag is `autocaptureExceptions` (truthy), persisted under `$exception_capture_enabled_server_side`.
- `startExceptionAutocapture(cfg)` calls `set_config({capture_exceptions: cfg ?? true})`; `stopExceptionAutocapture()` sets it to false.

**Rate limit (autocapture only)**
- A bucketed limiter keyed by `$exception_list[0].type ?? 'Exception'`.
- `bucketSize` is 10, `refillRate` is 1, and `refillInterval` is 10000 ms. Config keys: `error_tracking.exceptionRateLimiterRefillRate` and `error_tracking.exceptionRateLimiterBucketSize`.
- A new bucket is full. On each access it refills `floor(elapsed/interval)*rate`. If it is at 0, the call is limited. Otherwise one token is taken, and the call is also limited if that leaves 0, so 9 events pass in a burst.
- Clamps: bucketSize to 0..100, refillRate to 0..bucketSize.

## 5. Send
`capture('$exception', props, {_noTruncate:true, _batchKey:'exceptionEvent', _originatedFromCaptureException:true})`.
- The client rate limiter still applies.
- A direct `capture('$exception')` without that flag logs a warning.

## 6. Filters (in `sendExceptionEvent`; any match drops the event)
1. **Remote `errorTracking.suppressionRules`** (persisted under `$error_tracking_suppression_rules`):
   - Rules have the form `[{type:'AND'|'OR', values:[{key:'$exception_types'|'$exception_values', operator, value}]}]`.
   - Operators: `exact` (some equals some), `is_not` (every value differs from every target), `regex`/`not_regex`, `icontains`/`not_icontains`, `gt`, `lt`.
   - Targets are collected across the whole list.
2. **Extension frames**, unless `captureExtensionExceptions` is on (the client `error_tracking.captureExtensionExceptions` wins over the server's `$error_tracking_capture_extension_exceptions`):
   - Look for frame filenames starting with chrome-extension://, moz-extension://, safari-extension:, safari-web-extension: or webkit-masked-url:.
   - If every such frame is `webkit-masked-url`, drop only for a known signature: type `NoResponse`, a value containing `isolatedAPI.contexts.topHostname`, or a value exactly `No response from target`.
3. **Injected scripts** (same setting): a value contains `__firefox__` or `__gCrWeb`.
4. **The SDK's own errors**: unless `error_tracking.__capturePostHogExceptions` is set, drop when the throwing frame's filename contains `posthog.com/static`.
