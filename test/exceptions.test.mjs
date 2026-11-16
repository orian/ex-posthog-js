// Port of upstream posthog-js exception capture unit tests:
//   packages/core/src/error-tracking/parsers/{index,base}.spec.ts
//   packages/core/src/error-tracking/coercers/*.spec.ts
//   packages/core/src/error-tracking/error-properties-builder.{parse,coerce,metadata,aggregate-errors}.spec.ts
//   packages/core/src/error-tracking/{chunk-ids,release,exception-steps}.spec.ts
//   packages/core/src/utils/bucketed-rate-limiter.spec.ts
//   packages/browser/src/__tests__/extensions/exception-autocapture/error-conversion.test.ts
//   packages/browser/src/__tests__/extensions/exception-autocapture/error-wrapping-functions.test.ts
//   packages/browser/src/__tests__/extensions/exception-autocapture/exception-observer.test.ts (pure parts)
//   packages/browser/src/__tests__/extensions/exception-autocapture/internal-console-errors.test.ts (pure parts)
//   packages/browser/src/__tests__/posthog-exceptions.test.ts
// Run: node --test test/exceptions.test.mjs
import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { runInNewContext } from 'node:vm'

// src/core/utils.js captures `window` at import time; the wrapping functions
// and the observer install handlers on it. A bare object keeps the SDK logger
// quiet (it only logs through window.console).
globalThis.window = globalThis.window || {}
const win = globalThis.window

const {
    chromeStackLineParser,
    createDefaultStackParser,
    createFrame,
    createStackParser,
} = await import('../src/exceptions/stack-parser.js')
const {
    EXCEPTION_STEP_MESSAGE,
    EXCEPTION_STEP_TIMESTAMP,
    ErrorPropertiesBuilder,
    ExceptionStepsBuffer,
    buildErrorPropertiesBuilder,
    domExceptionCoercer,
    errorCoercer,
    errorEventCoercer,
    eventCoercer,
    getFilenameToChunkIdMap,
    getInjectedReleaseId,
    getStringInfos,
    getUtf8ByteLength,
    objectCoercer,
    primitiveCoercer,
    promiseRejectionEventCoercer,
    resetChunkIdCache,
    resolveExceptionStepsConfig,
    stringCoercer,
    stripReservedExceptionStepFields,
} = await import('../src/exceptions/error-tracking.js')
const {
    BucketedRateLimiter,
    DEFAULT_EXCEPTION_RATE_LIMITER_BUCKET_SIZE,
    DEFAULT_EXCEPTION_RATE_LIMITER_REFILL_RATE,
    resolveExceptionRateLimiterConfig,
} = await import('../src/exceptions/bucketed-rate-limiter.js')
const { ERROR_TRACKING_CAPTURE_EXTENSION_EXCEPTIONS, ERROR_TRACKING_SUPPRESSION_RULES, PostHogExceptions } =
    await import('../src/exceptions/exceptions.js')
const { ExceptionObserver, wrapConsoleError, wrapOnError, wrapUnhandledRejection } = await import(
    '../src/exceptions/autocapture.js'
)

// ---------------------------------------------------------------------------
// Small stand-ins for vitest's expect helpers.

class Matcher {
    constructor(check, description) {
        this.check = check
        this.description = description
    }
    [inspect.custom]() {
        return this.description
    }
}
const anyString = () => new Matcher((v) => typeof v === 'string', 'any(String)')
const anyArray = () => new Matcher((v) => Array.isArray(v), 'any(Array)')
const objectContaining = (obj) => new Matcher((v) => isMatch(v, obj), 'objectContaining(' + inspect(obj) + ')')

// vitest toMatchObject: objects match on the expected keys, arrays must match element-wise.
function isMatch(actual, expected) {
    if (expected instanceof Matcher) return expected.check(actual)
    if (Array.isArray(expected)) {
        return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => isMatch(actual[i], e))
    }
    if (expected !== null && typeof expected === 'object') {
        return (
            actual !== null &&
            typeof actual === 'object' &&
            Object.keys(expected).every((k) => isMatch(actual[k], expected[k]))
        )
    }
    return Object.is(actual, expected)
}
function assertMatch(actual, expected) {
    assert.ok(isMatch(actual, expected), `expected\n${inspect(actual, { depth: 8 })}\nto match\n${inspect(expected, { depth: 8 })}`)
}

// vitest toEqual ignores properties whose value is undefined.
function dropUndefined(value) {
    if (Array.isArray(value)) return value.map(dropUndefined)
    if (value !== null && typeof value === 'object') {
        const proto = Object.getPrototypeOf(value)
        if (proto !== Object.prototype && proto !== null) return value
        const out = {}
        for (const k of Object.keys(value)) if (value[k] !== undefined) out[k] = dropUndefined(value[k])
        return out
    }
    return value
}
function assertEqual(actual, expected) {
    assert.deepStrictEqual(dropUndefined(actual), dropUndefined(expected))
}

const values = (entries) => entries.map((entry) => entry.value)

// ErrorEvent does not exist in Node; upstream's tests use its runtime brand.
class FakeErrorEvent {
    constructor(typeOrInit, maybeInit) {
        Object.assign(this, typeof typeOrInit === 'string' ? maybeInit : typeOrInit)
    }
    get [Symbol.toStringTag]() {
        return 'ErrorEvent'
    }
}

// Upstream "help out jsdom" class: a plain Event subclass, not a branded PromiseRejectionEvent.
class PromiseRejectionEvent extends Event {
    constructor(type, options) {
        super(type)
        this.promise = options.promise
        this.reason = options.reason
    }
}

class CustomTestError extends Error {
    constructor(message, cause) {
        super(message)
        this.name = 'CustomTestError'
        this.cause = cause
    }
}

// ===========================================================================
// core/src/error-tracking/parsers/index.spec.ts
describe('createDefaultStackParser repeated cycle collapsing', () => {
    const parse = createDefaultStackParser()
    const OVERFLOW = 'RangeError: Maximum call stack size exceeded'
    const frame = (func, line, column = 10) => `    at ${func} (https://posthog.com/app.js:${line}:${column})`
    const recursion = (cycle, repeats) => {
        const frames = []
        for (let i = 0; i < repeats; i++) cycle.forEach((func, index) => frames.push(frame(func, index + 1)))
        return frames
    }
    const overflowStack = (cycle, repeats, dropInnermost = 0) =>
        [OVERFLOW, ...recursion(cycle, repeats).slice(dropInnermost), frame('handleClick', 90), frame('main', 91)].join('\n')
    const names = (stack) => parse(stack).map((f) => f.function)
    const funcCols = (stack) => parse(stack).map((f) => `${f.function}:${f.colno}`)

    test('keeps one copy of a recursion cycle', () => {
        assert.deepEqual(names(overflowStack(['a', 'b'], 30)), ['main', 'handleClick', 'b', 'a'])
    })

    test('keeps one copy when a single function calls itself', () => {
        assert.deepEqual(names(overflowStack(['a'], 60)), ['main', 'handleClick', 'a'])
    })

    test('keeps the outer frames a recursion used to push past the frame limit', () => {
        const frames = names(overflowStack(['a', 'b'], 400))
        assert.ok(frames.includes('main'))
        assert.ok(frames.includes('handleClick'))
    })

    test('gives the same frames wherever the runtime cut the recursion', () => {
        const pair = names(overflowStack(['a', 'b'], 30))
        assert.deepEqual(names(overflowStack(['a', 'b'], 30, 1)), pair)
        const triple = names(overflowStack(['a', 'b', 'c'], 30))
        assert.deepEqual(names(overflowStack(['a', 'b', 'c'], 30, 1)), triple)
        assert.deepEqual(names(overflowStack(['a', 'b', 'c'], 30, 2)), triple)
    })

    test('gives the same frames when the runtime cut everything outside the recursion', () => {
        const recursionOnly = (drop) => names([OVERFLOW, ...recursion(['a', 'b'], 40).slice(drop)].join('\n'))
        assert.deepEqual(recursionOnly(1), recursionOnly(0))
    })

    test('gives the same frames when the stack holds a second repeated section', () => {
        const withOuterRepeat = (drop) =>
            names(
                [
                    OVERFLOW,
                    ...recursion(['a', 'b'], 30).slice(drop),
                    frame('handleClick', 90),
                    frame('walk', 91),
                    frame('walk', 91),
                    frame('main', 92),
                ].join('\n')
            )
        assert.deepEqual(withOuterRepeat(0), ['main', 'walk', 'handleClick', 'b', 'a'])
        assert.deepEqual(withOuterRepeat(1), withOuterRepeat(0))
    })

    test('gives the same frames when a cycle that repeats a call site is all that is left', () => {
        const cycle = [frame('a', 1, 10), frame('b', 2), frame('a', 1, 20), frame('c', 4)]
        const lines = []
        for (let i = 0; i < 30; i++) lines.push(...cycle)
        const fromCut = (drop) => names([OVERFLOW, ...lines.slice(drop)].join('\n'))
        assert.deepEqual(fromCut(0), ['c', 'a', 'b', 'a'])
        for (const drop of [1, 2, 3]) assert.deepEqual(fromCut(drop), fromCut(0))
    })

    test('reads the outer frames a leftover copy would have pushed past the frame limit', () => {
        const callers = []
        for (let i = 0; i < 48; i++) callers.push(frame(`c${i}`, i + 10))
        const withCallers = (drop) => names([OVERFLOW, ...recursion(['a', 'b'], 30).slice(drop), ...callers].join('\n'))
        assert.equal(withCallers(0).length, 50)
        assert.deepEqual(withCallers(1), withCallers(0))

        const withThrowColumn = [OVERFLOW, frame('a', 1, 4), ...recursion(['a', 'b'], 30).slice(1), ...callers].join('\n')
        const frames = parse(withThrowColumn)
        assert.equal(frames.length, 50)
        assert.deepEqual(
            frames.map((f) => f.function),
            [...withCallers(0).slice(1), 'a']
        )
        assert.equal(frames[frames.length - 1].colno, 4)
    })

    test('gives the same frames when the recursion path calls one function twice in a row', () => {
        const cycle = [frame('a', 1), frame('b', 2, 10), frame('b', 2, 20)]
        const lines = []
        for (let i = 0; i < 30; i++) lines.push(...cycle)
        const fromCut = (drop) =>
            names([OVERFLOW, ...lines.slice(drop), frame('handleClick', 90), frame('main', 91)].join('\n'))
        assert.deepEqual(fromCut(0), ['main', 'handleClick', 'b', 'b', 'a'])
        assert.deepEqual(fromCut(1), fromCut(0))
        assert.deepEqual(fromCut(2), fromCut(0))
    })

    test('keeps minified frames that share a name and a line but not a column', () => {
        const stack = [
            'Error: boom',
            frame('i', 1, 310),
            frame('t', 1, 4821),
            frame('t', 1, 9137),
            frame('r', 1, 2210),
            frame('onClick', 1, 640),
        ].join('\n')
        assert.deepEqual(funcCols(stack), ['onClick:640', 'r:2210', 't:9137', 't:4821', 'i:310'])
    })

    for (const header of ['Error: boom', OVERFLOW]) {
        test(`preserves the unnamed throw location for ${header}`, () => {
            const anonymous = (column) => `    at https://posthog.com/app.js:1:${column}`
            const withThrowColumn = (column) => {
                const lines = [anonymous(column)]
                for (let i = 1; i < 40; i++) lines.push(anonymous(10))
                return funcCols([header, ...lines, frame('handleClick', 90), frame('main', 91)].join('\n'))
            }
            assert.deepEqual(withThrowColumn(4), ['main:10', 'handleClick:10', '?:10', '?:4'])
            assert.deepEqual(withThrowColumn(5), ['main:10', 'handleClick:10', '?:10', '?:5'])
            assert.deepEqual(withThrowColumn(10), ['main:10', 'handleClick:10', '?:10'])
        })
    }

    test('preserves the column of the call that ran out of stack', () => {
        const stack = [OVERFLOW, frame('a', 1, 4), ...recursion(['a', 'b'], 3).slice(1), frame('handleClick', 90)].join('\n')
        assert.deepEqual(funcCols(stack), ['handleClick:10', 'b:10', 'a:10', 'a:4'])
    })

    const nameCases = [
        {
            name: 'keeps frames that repeat without a complete second cycle',
            lines: [frame('a', 1), frame('b', 2), frame('a', 1), frame('main', 91)],
            expected: ['main', 'a', 'b', 'a'],
        },
        {
            name: 'invalidates a cycle record subsumed by a later collapse',
            lines: [frame('a', 1), frame('b', 2), frame('a', 1), frame('a', 1), frame('b', 2)],
            expected: ['b', 'a'],
        },
        {
            name: 'keeps disjoint cycle records when a later collapse subsumes another record',
            lines: [
                frame('inner', 90),
                frame('inner', 90),
                frame('a', 1),
                frame('b', 2),
                frame('a', 1),
                frame('a', 1),
                frame('b', 2),
                frame('outer', 91),
                frame('outer', 91),
            ],
            expected: ['outer', 'b', 'a', 'inner'],
        },
        {
            name: 'keeps calls to one function from different call sites',
            lines: [frame('a', 1), frame('a', 2), frame('a', 3), frame('main', 91)],
            expected: ['main', 'a', 'a', 'a'],
        },
    ]
    for (const { name, lines, expected } of nameCases) {
        test(name, () => assert.deepEqual(names(['Error: boom', ...lines].join('\n')), expected))
    }

    for (const column of [4, 5]) {
        test(`preserves the throw column ${column} of an ordinary recursive error`, () => {
            const stack = [
                'Error: boom',
                frame('recurse', 1, column),
                frame('recurse', 1, 10),
                frame('recurse', 1, 10),
                frame('main', 91),
            ].join('\n')
            assert.deepEqual(funcCols(stack), ['main:10', 'recurse:10', `recurse:${column}`])
        })
    }

    test('keeps distinct innermost minified call sites for an ordinary error', () => {
        const stack = ['Error: boom', frame('t', 1, 100), frame('t', 1, 200), frame('main', 91)].join('\n')
        assert.deepEqual(funcCols(stack), ['main:10', 't:200', 't:100'])
    })

    test('canonicalizes recursion-only cycles whose rotations differ only by columns', () => {
        const cycle = [frame('a', 1, 10), frame('b', 1, 20), frame('a', 1, 30), frame('b', 1, 40)]
        const lines = []
        for (let i = 0; i < 30; i++) lines.push(...cycle)
        const fromCut = (drop) => funcCols([OVERFLOW, ...lines.slice(drop)].join('\n'))
        assert.deepEqual(fromCut(0), ['b:40', 'a:30', 'b:20', 'a:10'])
        for (const drop of [1, 2, 3]) assert.deepEqual(fromCut(drop), fromCut(0))
    })
})

// ===========================================================================
// core/src/error-tracking/parsers/base.spec.ts
for (const platform of ['web:javascript', 'hermes']) {
    describe(`createFrame (${platform})`, () => {
        test('marks ordinary browser frames as in_app', () => {
            assert.equal(createFrame(platform, 'https://example.com/app.js', 'doThing', 1, 2).in_app, true)
        })

        const notInApp = [
            ['Safari masking an extension content script', 'webkit-masked-url://hidden/'],
            ['an Android in-app browser bridge', 'iabjs://navigation_performance_logger_android'],
            ['a Chromium extension content script', 'chrome-extension://abcdef/content.js'],
            ['a Firefox extension content script', 'moz-extension://abcdef/content.js'],
            ['a Safari extension, which the parser prefixes with a bare scheme', 'safari-extension:abcdef/content.js'],
            ['a Safari web extension', 'safari-web-extension:abcdef/content.js'],
            ['an extension with a mixed-case scheme', 'CHROME-Extension://abcdef/content.js'],
            ['an unknown container scheme', 'other-bridge://injected.js'],
            ['an inline data URL', 'data:text/javascript,void 0'],
        ]
        for (const [name, filename] of notInApp) {
            test(`does not mark a frame the container injected as in_app: ${name}`, () => {
                assert.equal(createFrame(platform, filename, 'doThing', 1, 2).in_app, false)
            })
        }

        const inApp = [
            ['a script served over http', 'http://localhost:8000/app.js'],
            ['a Cordova or Electron app served from disk', 'file:///android_asset/www/app.js'],
            ['a worker the page created from a blob', 'blob:https://example.com/6b0b0e6a'],
            ['a Capacitor webview', 'capacitor://localhost/app.js'],
            ['an Ionic webview', 'ionic://localhost/app.js'],
            ['a script with a mixed-case scheme', 'HTTPS://example.com/app.js'],
            ['a webpack source frame', 'webpack:///./src/App.js'],
            ['an Angular JIT component', 'ng:///CheckoutComponent.js'],
            ['a custom app scheme, as an Electron or React Native shell serves', 'app://checkout.js'],
            ['a bundler-rewritten dev frame', 'webpack-internal:///./src/App.js'],
            ['a React Native release bundle, which has no scheme', 'index.android.bundle'],
            ['an absolute path with no scheme', '/data/user/0/com.example/files/index.bundle'],
            ['a Windows path with backslashes', 'C:\\app\\index.bundle'],
            ['a Windows path with forward slashes', 'C:/app/index.bundle'],
        ]
        for (const [name, filename] of inApp) {
            test(`still marks the app's own code as in_app: ${name}`, () => {
                assert.equal(createFrame(platform, filename, 'doThing', 1, 2).in_app, true)
            })
        }

        test('keeps the masked frame rather than discarding it', () => {
            assertMatch(createFrame(platform, 'webkit-masked-url://hidden/', 'someFn', 3, 4), {
                filename: 'webkit-masked-url://hidden/',
                function: 'someFn',
                lineno: 3,
                colno: 4,
            })
        })

        test('does not mark Chromium <anonymous> frames as in_app', () => {
            const frame = createFrame(platform, '<anonymous>', '?', 1, 394)
            assert.equal(frame.in_app, false)
            assertMatch(frame, { filename: '<anonymous>', function: '?', lineno: 1, colno: 394 })
        })

        test('does not mark frames without a filename as in_app', () => {
            assert.equal(createFrame(platform, undefined, 'doThing').in_app, false)
        })

        test('does not mark frames with an empty filename as in_app', () => {
            const frame = createFrame(platform, '', 'sendDataToNative', 1, 10198)
            assert.equal(frame.in_app, false)
            assertMatch(frame, { function: 'sendDataToNative', lineno: 1, colno: 10198 })
        })
    })
}

describe('createDefaultStackParser in_app classification', () => {
    const parse = createDefaultStackParser()

    test('demotes a bare <anonymous> frame from injected code', () => {
        assert.deepEqual(parse("SyntaxError: Failed to execute 'appendChild' on 'Node': boom\n    at <anonymous>:1:394"), [
            { platform: 'web:javascript', filename: '<anonymous>', function: '?', in_app: false, lineno: 1, colno: 394 },
        ])
    })

    const bridgeCases = [
        {
            name: 'demotes the native bridge frames an Android in-app browser injects',
            stack:
                'Error: Error invoking postMessage: Java object is gone\n' +
                '    at sendDataToNative (:1:10198)\n' +
                '    at sendJsBlockingTimeMessage (:1:14668)',
        },
        {
            name: 'demotes the bridge frames an Android in-app browser serves from its own scheme',
            stack:
                'Error: Error invoking postMessage: Java object is gone\n' +
                '    at sendDataToNative (iabjs://navigation_performance_logger_android:1:10198)\n' +
                '    at sendJsBlockingTimeMessage (iabjs://navigation_performance_logger_android:1:14668)',
        },
    ]
    for (const { name, stack } of bridgeCases) {
        test(name, () => {
            assert.deepEqual(
                parse(stack).map((f) => [f.function, f.in_app]),
                [
                    ['sendJsBlockingTimeMessage', false],
                    ['sendDataToNative', false],
                ]
            )
        })
    }

    for (const stackLine of [
        '    at CheckoutComponent_Template (ng:///CheckoutComponent.js:10:5)',
        'CheckoutComponent_Template@ng:///CheckoutComponent.js:10:5',
    ]) {
        test(`keeps Angular JIT application frames as in_app: ${stackLine}`, () => {
            assertMatch(parse(`Error: template failed\n${stackLine}`), [
                objectContaining({
                    filename: 'ng:///CheckoutComponent.js',
                    function: 'CheckoutComponent_Template',
                    lineno: 10,
                    colno: 5,
                    in_app: true,
                }),
            ])
        })
    }

    for (const filename of [
        'webkit-masked-url://hidden/',
        '<anonymous>',
        'iabjs://navigation_performance_logger_android',
        'chrome-extension://abcdef/content.js',
        'moz-extension://abcdef/content.js',
    ]) {
        test(`retains injected frames without demoting the calling app frame: ${filename}`, () => {
            const frames = parse(`Error: boom\n    at injected (${filename}:1:2)\n    at checkout (https://example.com/app.js:10:5)`)
            assert.deepEqual(
                frames.map((f) => [f.filename, f.in_app]),
                [
                    ['https://example.com/app.js', true],
                    [filename, false],
                ]
            )
        })
    }

    test("keeps the page's own eval'd code as in_app", () => {
        const frames = parse(
            'Error: boom\n' +
                '    at eval (eval at <anonymous> (https://example.com/app.js:10:5), <anonymous>:1:394)\n' +
                '    at https://example.com/app.js:10:5'
        )
        assert.deepEqual(
            frames.map((f) => [f.filename, f.in_app]),
            [
                ['https://example.com/app.js', true],
                ['https://example.com/app.js', true],
            ]
        )
    })
})

// ===========================================================================
// core/src/error-tracking/coercers/error-event-coercer.spec.ts
describe('ErrorEventCoercer', () => {
    const builder = new ErrorPropertiesBuilder(
        [errorEventCoercer, errorCoercer, eventCoercer, objectCoercer, stringCoercer, primitiveCoercer],
        createDefaultStackParser()
    )
    const buildException = (input, syntheticException) =>
        builder.buildFromUnknown(input, { syntheticException }).$exception_list[0]

    const matchCases = [
        { name: 'an ErrorEvent carrying an Error', input: new FakeErrorEvent({ error: new Error('boom') }), expected: true },
        { name: 'an ErrorEvent carrying a message', input: new FakeErrorEvent({ message: 'Script error.' }), expected: true },
        { name: 'an ErrorEvent without an error or message', input: new FakeErrorEvent(), expected: false },
        { name: 'an ErrorEvent with an empty message', input: new FakeErrorEvent({ message: '' }), expected: false },
        { name: 'a non-ErrorEvent', input: { message: 'not an ErrorEvent' }, expected: false },
    ]
    for (const { name, input, expected } of matchCases) {
        test(`matches ${name}: ${expected}`, () => assert.equal(errorEventCoercer.match(input), expected))
    }

    test('unwraps the Error carried by the ErrorEvent', () => {
        const error = new Error('Something broke')
        error.name = 'CustomTestError'
        assertMatch(buildException(new FakeErrorEvent({ message: 'ignored', error })), {
            type: 'CustomTestError',
            value: 'Something broke',
            mechanism: { synthetic: false },
        })
    })

    test('preserves the message and location when there is no Error object', () => {
        const exception = buildException(
            new FakeErrorEvent({
                message: 'Uncaught TypeError: x is not a function',
                filename: 'https://example.com/app.js',
                lineno: 42,
                colno: 13,
            })
        )
        assertMatch(exception, {
            type: 'TypeError',
            value: 'x is not a function',
            mechanism: { synthetic: true },
            stacktrace: {
                frames: [objectContaining({ filename: 'https://example.com/app.js', lineno: 42, colno: 13 })],
            },
        })
    })

    const noStackCases = [
        { name: 'a zeroed position', lineno: 0, colno: 0 },
        { name: 'no position at all', lineno: undefined, colno: undefined },
        { name: 'a column but no line', lineno: 0, colno: 13 },
    ]
    for (const { name, lineno, colno } of noStackCases) {
        test(`reports no stack trace for ${name}`, () => {
            const exception = buildException(
                new FakeErrorEvent({
                    message: 'ResizeObserver loop completed with undelivered notifications.',
                    filename: 'https://example.com/dashboard/1',
                    lineno,
                    colno,
                })
            )
            assert.equal(exception.stacktrace, undefined)
            assertMatch(exception, { value: 'ResizeObserver loop completed with undelivered notifications.' })
        })
    }

    test('keeps a frame when only the column is zero', () => {
        const exception = buildException(
            new FakeErrorEvent({
                message: 'Uncaught TypeError: x is not a function',
                filename: 'https://example.com/app.js',
                lineno: 42,
                colno: 0,
            })
        )
        assertMatch(exception.stacktrace.frames, [
            objectContaining({ filename: 'https://example.com/app.js', lineno: 42, colno: 0 }),
        ])
    })

    test('does not parse frame-shaped lines from a multiline message', () => {
        const exception = buildException(
            new FakeErrorEvent({
                message: 'Something broke\n    at injected (https://example.com/injected.js:1:2)',
                filename: 'https://example.com/app.js',
                lineno: 42,
                colno: 13,
            })
        )
        assertMatch(exception.stacktrace.frames, [
            objectContaining({ filename: 'https://example.com/app.js', lineno: 42, colno: 13 }),
        ])
    })
})

// core/src/error-tracking/coercers/promise-rejection-event.spec.ts
// (here the class is branded so that the coercer's match() also accepts it)
describe('PromiseRejectionEventCoercer', () => {
    class BrandedPromiseRejectionEvent extends PromiseRejectionEvent {
        get [Symbol.toStringTag]() {
            return 'PromiseRejectionEvent'
        }
    }

    test('should coerce event with reason is a primitive', () => {
        const pre = new BrandedPromiseRejectionEvent('unhandledrejection', {
            promise: Promise.resolve('wat'),
            reason: 'My house is on fire',
        })
        assert.equal(promiseRejectionEventCoercer.match(pre), true)
        const ctx = { apply: () => ({ type: 'MockType', value: 'MockValue', synthetic: true }), next: () => {} }
        assertMatch(promiseRejectionEventCoercer.coerce(pre, ctx), {
            type: 'UnhandledRejection',
            value: 'Non-Error promise rejection captured with value: My house is on fire',
            synthetic: true,
        })
    })

    test('should coerce event with reason is an error', () => {
        const pre = new BrandedPromiseRejectionEvent('unhandledrejection', {
            promise: Promise.resolve('wat'),
            reason: new CustomTestError('My house is on fire'),
        })
        const ctx = {
            apply: (err) => ({ type: err.name, value: err.message, stack: err.stack, synthetic: false }),
            next: () => {},
        }
        assertMatch(promiseRejectionEventCoercer.coerce(pre, ctx), {
            type: 'CustomTestError',
            value: 'My house is on fire',
            synthetic: false,
        })
    })
})

// core/src/error-tracking/coercers/string-coercer.spec.ts (StringCoercer.getInfos)
describe('StringCoercer.getInfos', () => {
    const cases = [
        { name: 'should parse string', input: 'My house is on fire', expected: [undefined, 'My house is on fire'] },
        {
            name: 'should parse errors',
            input: 'ReferenceError: My house is on fire',
            expected: ['ReferenceError', 'My house is on fire'],
        },
        {
            name: 'should discard prefix',
            input: 'Uncaught exception: ReferenceError: My house is on fire',
            expected: ['ReferenceError', 'My house is on fire'],
        },
        {
            name: 'should not match other patterns',
            input: 'ValueError: ReferenceError: My house is on fire',
            expected: [undefined, 'ValueError: ReferenceError: My house is on fire'],
        },
    ]
    for (const { name, input, expected } of cases) {
        test(name, () => assertMatch(getStringInfos(input), expected))
    }
})

// ===========================================================================
// core/src/error-tracking/error-properties-builder.parse.spec.ts
describe('ErrorPropertiesBuilder parseStacktrace', () => {
    const builder = new ErrorPropertiesBuilder([], createStackParser('web:javascript', chromeStackLineParser))

    // Adapted: upstream expects 13 frames under vitest; the depth of a stack
    // created inside node:test differs, so only check that frames come back.
    test('should parse stacktraces', () => {
        const syntheticError = new Error()
        const parsed = builder.parseStacktrace_(
            { type: 'Error', value: 'Whatever', stack: syntheticError.stack, synthetic: false },
            1,
            undefined
        )
        assert.ok(Array.isArray(parsed.frames))
        assert.ok(parsed.frames.length > 0)
        assert.ok(parsed.frames.length <= 50)
    })
})

// ===========================================================================
// core/src/error-tracking/error-properties-builder.coerce.spec.ts
describe('ErrorPropertiesBuilder coerceUnknown', () => {
    const builder = new ErrorPropertiesBuilder(
        [
            domExceptionCoercer,
            errorEventCoercer,
            errorCoercer,
            promiseRejectionEventCoercer,
            eventCoercer,
            objectCoercer,
            stringCoercer,
            primitiveCoercer,
        ],
        createStackParser('web:javascript')
    )
    const coerceInput = (input, error = new Error()) =>
        builder.buildCoercingContext({ handled: false }, { syntheticException: error }).apply(input)

    test('should handle null values', () => {
        const syntheticError = new Error()
        assertMatch(coerceInput(null, syntheticError), {
            type: 'Error',
            value: 'Primitive value captured as exception: null',
            stack: syntheticError.stack,
        })
    })

    const stringCases = [
        { name: 'should handle string', input: 'test', type: 'Error', value: 'test' },
        {
            name: 'should handle exception string',
            input: 'Uncaught exception: InternalError: but somehow still a string',
            type: 'InternalError',
            value: 'but somehow still a string',
        },
    ]
    for (const { name, input, type, value } of stringCases) {
        test(name, () => {
            const syntheticError = new Error()
            assertMatch(coerceInput(input, syntheticError), { type, value, stack: syntheticError.stack })
        })
    }

    const keyCases = [
        ['all keys when they fit', { foo: 'Foo value', bar: 'Bar value' }, 'bar, foo'],
        [
            'the longest key prefix that fits',
            Object.fromEntries(['golf', 'alpha', 'echo', 'bravo', 'foxtrot', 'delta', 'charlie'].map((k) => [k, 1])),
            'alpha, bravo, charlie, delta, echo',
        ],
        ['nothing when the first key is too long', { ['x'.repeat(41)]: 1 }, ''],
    ]
    for (const [name, errorObject, keys] of keyCases) {
        test(`should use ${name} in objects`, () => {
            const syntheticError = new Error()
            assertMatch(coerceInput(errorObject, syntheticError), {
                type: 'Error',
                value: `Object captured as exception with keys: ${keys}`,
                stack: syntheticError.stack,
            })
        })
    }

    test('should summarize the keys of a very wide object quickly', () => {
        const errorObject = Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`k${i}`, i]))
        const start = process.hrtime.bigint()
        const exception = coerceInput(errorObject, new Error())
        assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 1000)
        assert.equal(exception.value, 'Object captured as exception with keys: k0, k1, k10, k100, k1000, k10000, k10001')
    })

    test('should handle object with an error property', () => {
        const nestedError = new CustomTestError('My special error')
        assertMatch(coerceInput({ error: nestedError }, new Error()), {
            type: 'CustomTestError',
            value: 'My special error',
            stack: nestedError.stack,
        })
    })

    test('should handle error', () => {
        const errorObject = new CustomTestError('My special error')
        assertMatch(coerceInput(errorObject), {
            type: 'CustomTestError',
            value: 'My special error',
            stack: errorObject.stack,
        })
    })

    test('should fall back to the synthetic stack when the error has no stack', () => {
        const errorObject = new CustomTestError('My special error')
        errorObject.stack = ''
        const syntheticError = new Error()
        assertMatch(coerceInput(errorObject, syntheticError), {
            type: 'CustomTestError',
            value: 'My special error',
            stack: syntheticError.stack,
            synthetic: true,
        })
    })

    test('should preserve a cross-realm error', () => {
        const crossRealmError = runInNewContext(`new TypeError('cross-realm error', { cause: new Error('cross-realm cause') })`)
        assert.ok(!(crossRealmError instanceof Error))
        assertMatch(coerceInput(crossRealmError), {
            type: 'TypeError',
            value: 'cross-realm error',
            stack: crossRealmError.stack,
            synthetic: false,
            cause: { type: 'Error', value: 'cross-realm cause', stack: crossRealmError.cause.stack, synthetic: false },
        })
    })

    test('should handle error with error cause', () => {
        const secondError = new CustomTestError('My original error')
        const firstError = new CustomTestError('My wrapped error', secondError)
        assertMatch(coerceInput(firstError), {
            type: 'CustomTestError',
            value: 'My wrapped error',
            stack: firstError.stack,
            cause: { type: 'CustomTestError', value: 'My original error', stack: secondError.stack },
        })
    })

    const causeCases = [
        {
            name: 'should handle error with object cause',
            cause: { foo: 'bar', test: 'test' },
            expected: { type: 'Error', value: 'Object captured as exception with keys: foo, test', stack: undefined },
        },
        {
            name: 'should handle error with string cause',
            cause: 'My original error',
            expected: { type: 'Error', value: 'My original error', stack: undefined },
        },
    ]
    for (const { name, cause, expected } of causeCases) {
        test(name, () => {
            const kaboomError = new CustomTestError('Front error', cause)
            assertMatch(coerceInput(kaboomError, new Error()), {
                type: 'CustomTestError',
                value: 'Front error',
                stack: kaboomError.stack,
                cause: expected,
            })
        })
    }

    // Node's Event has no own `isTrusted`, so this matches upstream's Node expectation.
    test('should convert a plain Event to an error', () => {
        class MouseEvent extends Event {}
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
        const syntheticError = new Error()
        assertMatch(coerceInput(event, syntheticError), {
            type: 'MouseEvent',
            value: 'MouseEvent captured as exception with keys: [object has no keys]',
            stack: syntheticError.stack,
            synthetic: true,
        })
    })

    test('should convert a DOM Error to an error', () => {
        class FakeDomError {
            constructor(name, message) {
                this.name = name
                this.message = message
                this[Symbol.toStringTag] = 'DOMError'
            }
        }
        assertMatch(coerceInput(new FakeDomError('click', 'foo')), {
            type: 'DOMError',
            value: 'click: foo',
            stack: undefined,
            synthetic: false,
        })
    })

    test('should convert a DOM Exception to an error', () => {
        const exception = coerceInput(new DOMException('oh no disaster', 'dom-exception'))
        assert.ok(exception)
        assertMatch(exception, { type: 'DOMException', value: 'dom-exception: oh no disaster', synthetic: false })
    })

    test('should extract the buried Error from a CustomEvent wrapping a PromiseRejectionEvent', () => {
        const buriedError = new Error('Extension context invalidated.')
        const customEvent = new CustomEvent('unhandledrejection', {
            detail: { reason: buriedError, promise: Promise.resolve() },
        })
        assertMatch(coerceInput(customEvent), {
            type: 'Error',
            value: 'Extension context invalidated.',
            stack: buriedError.stack,
        })
    })

    test('should preserve an error-like stack from a CustomEvent wrapping a PromiseRejectionEvent', () => {
        const stack = 'TypeError: Extension context invalidated.\n    at extension.js:1:2'
        const customEvent = new CustomEvent('unhandledrejection', {
            detail: { reason: { name: 'TypeError', message: 'Extension context invalidated.', stack } },
        })
        assertMatch(coerceInput(customEvent), {
            type: 'TypeError',
            value: "'TypeError' captured as exception with message: 'Extension context invalidated.'",
            stack,
        })
    })

    const objectCases = [
        {
            name: 'should fall back to Error when the object has no name property',
            input: { message: 'oh no disaster' },
            expected: { type: 'Error', value: 'oh no disaster' },
        },
        {
            name: 'should fall back to Error when the name property is an empty string',
            input: { name: '', message: 'oh no disaster' },
            expected: { type: 'Error' },
        },
    ]
    for (const { name, input, expected } of objectCases) {
        test(name, () => assertMatch(coerceInput(input), expected))
    }

    test('should preserve a string type when name is a stateful accessor', () => {
        let reads = 0
        const candidate = { message: 'boom' }
        Object.defineProperty(candidate, 'name', {
            get() {
                reads += 1
                return reads === 1 ? 'TypeError' : 42
            },
        })
        assertMatch(coerceInput(candidate), { type: 'TypeError', value: 'boom' })
    })
})

// ===========================================================================
// core/src/error-tracking/error-properties-builder.metadata.spec.ts
describe('ErrorPropertiesBuilder relationship metadata', () => {
    const builder = new ErrorPropertiesBuilder(
        [errorEventCoercer, errorCoercer, objectCoercer, stringCoercer, primitiveCoercer],
        createStackParser('web:javascript', chromeStackLineParser)
    )
    const error = (type, value, cause) => {
        const result = new Error(value, { cause })
        result.name = type
        result.stack = undefined
        return result
    }
    const chained = (source, exception_id, parent_id, synthetic = false) => ({
        type: 'chained',
        source,
        synthetic,
        exception_id,
        parent_id,
    })

    test('matches the canonical cause example without inventing nested handled state', () => {
        assertEqual(builder.buildFromUnknown(error('CheckoutError', 'Checkout failed', error('DatabaseError', 'Connection failed'))), {
            $exception_level: 'error',
            $exception_list: [
                {
                    type: 'CheckoutError',
                    value: 'Checkout failed',
                    mechanism: { type: 'generic', handled: true, synthetic: false, exception_id: 0 },
                },
                { type: 'DatabaseError', value: 'Connection failed', mechanism: chained('cause', 1, 0) },
            ],
        })
    })

    test('matches the canonical aggregate example including the second member cause', () => {
        const root = new AggregateError(
            [error('NetworkError', 'Network failed'), error('ValidationError', 'Validation failed', error('ParseError', 'Invalid value'))],
            'Two operations failed'
        )
        root.stack = undefined
        assertEqual(builder.buildFromUnknown(root, { mechanism: { type: 'task', handled: false } }).$exception_list, [
            {
                type: 'AggregateError',
                value: 'Two operations failed',
                mechanism: { type: 'task', handled: false, synthetic: false, exception_id: 0 },
            },
            { type: 'NetworkError', value: 'Network failed', mechanism: chained('member', 1, 0) },
            { type: 'ValidationError', value: 'Validation failed', mechanism: chained('member', 2, 0) },
            { type: 'ParseError', value: 'Invalid value', mechanism: chained('cause', 3, 2) },
        ])
    })

    test('retains the first 50 entries of a deep cause chain with deterministic valid IDs', () => {
        let root = error('Error', '60')
        for (let index = 59; index >= 0; index--) root = error('Error', String(index), root)
        const first = builder.buildFromUnknown(root).$exception_list
        assertEqual(first, builder.buildFromUnknown(root).$exception_list)
        assert.deepEqual(values(first), Array.from({ length: 50 }, (_, i) => String(i)))
        first.forEach((entry, index) => {
            assert.equal(entry.mechanism.exception_id, index)
            if (index) assert.equal(entry.mechanism.parent_id, index - 1)
        })
    })

    test('skips cycles and shared objects globally without spending the emission budget', () => {
        const shared = error('Error', 'shared')
        const root = new AggregateError([], 'root', { cause: shared })
        shared.cause = root
        root.errors = [
            ...Array(150).fill(root),
            ...Array(150).fill(shared),
            ...Array.from({ length: 60 }, (_, i) => error('Error', String(i))),
        ]
        assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), [
            'root',
            'shared',
            ...Array.from({ length: 48 }, (_, i) => String(i)),
        ])
    })

    test('does not read handled properties from user errors or inherit root provenance', () => {
        const child = error('Error', 'native')
        Object.defineProperty(child, 'handled', {
            get() {
                throw new Error('untrusted')
            },
        })
        const root = new AggregateError([child, 'converted'], 'root')
        root.stack = undefined
        const entries = builder.buildFromUnknown(root, {
            syntheticException: new Error('capture'),
            mechanism: { handled: false, type: 'middleware' },
        }).$exception_list
        assertEqual(
            entries.map((e) => e.mechanism),
            [
                { type: 'middleware', handled: false, synthetic: true, exception_id: 0 },
                chained('member', 1, 0),
                chained('member', 2, 0, true),
            ]
        )
    })

    test('preserves typed capture metadata but assigns root linkage at final assembly', () => {
        const root = error('Error', 'root', error('Error', 'child'))
        const entries = builder.buildFromUnknown(root, {
            mechanism: { type: 'custom.integration', handled: false, synthetic: true, exception_id: 81, parent_id: 80, source: 'cause' },
        }).$exception_list
        assertEqual(entries[0].mechanism, { type: 'custom.integration', handled: false, synthetic: true, exception_id: 0 })
        assertEqual(entries[1].mechanism, chained('cause', 1, 0))
    })

    for (const stack of [undefined, '', 123]) {
        test(`keeps a native child without a usable stack non-synthetic: ${inspect(stack)}`, () => {
            const child = error('Error', 'child')
            child.stack = stack
            const entries = builder.buildFromUnknown(new Error('root', { cause: child })).$exception_list
            assert.equal(entries[1].mechanism.synthetic, false)
            assert.equal(entries[1].stacktrace, undefined)
        })
    }

    test('keeps a native child with a throwing stack accessor non-synthetic', () => {
        const child = error('Error', 'child')
        Object.defineProperty(child, 'stack', {
            get() {
                throw new Error('unreadable')
            },
        })
        const entries = builder.buildFromUnknown(new Error('root', { cause: child })).$exception_list
        assertEqual(entries[1], { type: 'Error', value: 'child', mechanism: chained('cause', 1, 0) })
    })

    for (const handled of ['yes', null, 0, {}, []]) {
        test(`omits invalid handled metadata: ${JSON.stringify(handled)}`, () => {
            const entries = builder.buildFromUnknown(error('Error', 'root'), {
                mechanism: { type: '', handled, synthetic: true },
            }).$exception_list
            assertEqual(entries[0].mechanism, { type: 'generic', synthetic: true, exception_id: 0 })
            assert.ok(!('handled' in entries[0].mechanism))
        })
    }

    for (const handled of [undefined, true, false]) {
        test(`preserves the manual capture default and boolean handled metadata: ${handled}`, () => {
            const entries = builder.buildFromUnknown(error('Error', 'root'), { mechanism: { handled } }).$exception_list
            assert.equal(entries[0].mechanism.handled, handled === undefined ? true : handled)
        })
    }

    test('preserves all supplied mechanism fields in the low-level coercion context', () => {
        const mechanism = { type: 'custom', handled: false, synthetic: true, source: 'inner', exception_id: 7, parent_id: 6 }
        const context = builder.buildCoercingContext(mechanism, { mechanism })
        assert.deepEqual(context.mechanism, mechanism)
        context.apply(error('Error', 'root'))
        assert.deepEqual(context.mechanism, mechanism)
    })

    test('deduplicates shared exceptions reached through distinct wrappers', () => {
        const shared = error('Error', 'shared')
        const root = new AggregateError([shared, { error: shared }, { error: shared }, error('Error', 'last')], 'root')
        const entries = builder.buildFromUnknown(root).$exception_list
        assert.deepEqual(values(entries), ['root', 'shared', 'last'])
        assert.deepEqual(
            entries.map((e) => e.mechanism.exception_id),
            [0, 1, 2]
        )
    })

    test('resets the wrapper limit on real cause edges', () => {
        let root = error('Error', '8')
        for (let index = 7; index >= 0; index--) root = error('Error', String(index), { error: root })
        assert.deepEqual(
            values(builder.buildFromUnknown(root).$exception_list),
            Array.from({ length: 9 }, (_, i) => String(i))
        )
    })

    test('bounds consecutive forwarding wrappers without discarding the next member', () => {
        let wrapper = error('Error', 'unreachable')
        for (let index = 0; index < 10; index++) wrapper = { [Symbol.toStringTag]: 'ErrorEvent', error: wrapper }
        const entries = builder.buildFromUnknown(new AggregateError([wrapper, error('Error', 'last')], 'root')).$exception_list
        assert.deepEqual(values(entries), ['root', 'Unknown error', 'last'])
        assert.deepEqual(
            entries.map((e) => e.mechanism.exception_id),
            [0, 1, 2]
        )
    })

    for (const length of [NaN, Infinity, -1, 1.5, 0x100000000, '2']) {
        test(`ignores invalid proxy collection lengths: ${String(length)}`, () => {
            const root = new AggregateError([], 'root')
            let memberReads = 0
            root.errors = new Proxy([], {
                get: (_target, key) => (key === 'length' ? length : (memberReads++, undefined)),
            })
            assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), ['root'])
            assert.equal(memberReads, 0)
        })
    }

    test('reads array length once and ignores later growth', () => {
        const members = [error('Error', 'first')]
        let lengthReads = 0
        const root = new AggregateError([], 'root')
        root.errors = new Proxy(members, {
            get: (target, key) => {
                if (key === 'length') {
                    lengthReads++
                    return members.length
                }
                if (key === '0') members.push(error('Error', 'not in snapshot'))
                return Reflect.get(target, key)
            },
        })
        assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), ['root', 'first'])
        assert.equal(lengthReads, 1)
    })

    test('preserves root and cause when reading the collection length throws', () => {
        const root = new AggregateError([], 'root', { cause: error('Error', 'cause') })
        root.errors = new Proxy([], {
            get() {
                throw new Error('unreadable length')
            },
        })
        assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), ['root', 'cause'])
    })

    test('caps huge proxy member collections before reading beyond 1000 attempts and resets between captures', () => {
        const root = new AggregateError([], 'root')
        let reads = []
        const readMember = (index) => {
            reads.push(index)
            if (index >= 1000) throw new Error('past the inspection budget')
            return root
        }
        root.errors = new Proxy([], {
            get: (_target, key) => (key === 'length' ? 0xffffffff : readMember(Number(key))),
        })
        for (let capture = 0; capture < 2; capture++) {
            reads = []
            assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), ['root'])
            assert.equal(reads.length, 1000)
            assert.equal(reads[reads.length - 1], 999)
        }
        assert.deepEqual(
            values(builder.buildFromUnknown(new AggregateError([error('Error', 'fresh child')], 'fresh root')).$exception_list),
            ['fresh root', 'fresh child']
        )
    })

    test('shares attempted member inspections across groups, including throwing getters, without limiting cause edges', () => {
        const root = new AggregateError([], 'root')
        const first = new AggregateError(Array(600).fill(root), 'first group')
        Object.defineProperty(first.errors, '0', {
            get() {
                throw new Error('unreadable member')
            },
        })
        let cause = error('Error', 'cause 8')
        for (let index = 7; index >= 0; index--) cause = error('Error', `cause ${index}`, cause)
        const second = new AggregateError([...Array(397).fill(root), cause, error('Error', 'past budget')], 'second group')
        let lastRootMemberReads = 0
        root.errors = [first, second]
        Object.defineProperty(root.errors, '2', {
            get: () => {
                lastRootMemberReads++
                return error('Error', 'unread root member')
            },
        })
        const entries = builder.buildFromUnknown(root).$exception_list
        assert.deepEqual(values(entries), [
            'root',
            'first group',
            'Unknown error',
            'second group',
            ...Array.from({ length: 9 }, (_, i) => `cause ${i}`),
        ])
        assert.equal(lastRootMemberReads, 0)
        entries.forEach((entry, index) => {
            assert.equal(entry.mechanism.exception_id, index)
            if (index > 0) {
                assertEqual(
                    entry.mechanism,
                    chained(index > 4 ? 'cause' : 'member', index, index === 1 || index === 3 ? 0 : index - 1, index === 2)
                )
            }
        })
    })
})

// ===========================================================================
// core/src/error-tracking/error-properties-builder.aggregate-errors.spec.ts
// Skipped: 'retains children and siblings when a member stack cannot be parsed'
// (needs the Node stack line parser, which is not ported).
describe('ErrorPropertiesBuilder AggregateError children', () => {
    const builder = new ErrorPropertiesBuilder(
        [errorEventCoercer, promiseRejectionEventCoercer, errorCoercer, objectCoercer, stringCoercer, primitiveCoercer],
        createStackParser('web:javascript', chromeStackLineParser)
    )

    test('retains aggregate members when root coercion fails', () => {
        const root = new AggregateError([new Error('first'), new Error('second')], 'root')
        Object.defineProperty(root, 'message', {
            get: () => {
                throw new Error('unreadable message')
            },
        })
        const entries = builder.buildFromUnknown(root).$exception_list
        assert.deepEqual(values(entries), ['Unknown error', 'first', 'second'])
        assert.equal(entries[0].mechanism.synthetic, true)
        assertMatch(entries[1].mechanism, { exception_id: 1, parent_id: 0, source: 'member' })
        assertMatch(entries[2].mechanism, { exception_id: 2, parent_id: 0, source: 'member' })
    })

    test('captures rejected alternatives and their frames from native Promise.any', async () => {
        const first = new TypeError('first alternative')
        const second = new RangeError('second alternative')
        const aggregate = await Promise.any([Promise.reject(first), Promise.reject(second)]).catch((e) => e)
        assert.ok(aggregate instanceof AggregateError)
        assert.deepEqual(aggregate.errors, [first, second])
        const exceptions = builder.buildFromUnknown(aggregate).$exception_list
        assert.equal(exceptions[0].type, 'AggregateError')
        for (const child of [first, second]) {
            const directFrames = builder.buildFromUnknown(child).$exception_list[0].stacktrace?.frames
            assert.ok(directFrames.length > 0)
            const captured = exceptions.find((e) => e.value === child.message)
            assert.ok(captured)
            assert.deepEqual(captured.stacktrace.frames, directFrames)
        }
    })

    test('captures array-valued errors from a custom-named cross-realm aggregate', () => {
        const aggregate = runInNewContext(`(() => {
            const error = new AggregateError([new TypeError('cross-realm alternative')], 'group')
            error.name = 'CustomGroupError'
            return error
        })()`)
        assert.ok(!(aggregate instanceof Error))
        const exceptions = builder.buildFromUnknown(aggregate).$exception_list
        assertMatch(exceptions[0], { type: 'CustomGroupError', value: 'group' })
        assert.ok(exceptions.some((e) => isMatch(e, { type: 'TypeError', value: 'cross-realm alternative' })))
    })

    for (const name of ['ValidationError', 'AggregateError']) {
        test(`does not treat a domain error named ${name} as an aggregate`, () => {
            const cause = new Error('underlying cause')
            const domainError = Object.assign(new Error('invalid input', { cause }), {
                name,
                errors: [{ path: 'email', message: 'invalid email' }, new Error('validation detail')],
            })
            const exceptions = builder.buildFromUnknown(domainError).$exception_list
            assert.deepEqual(values(exceptions), ['invalid input', 'underlying cause'])
            assertMatch(exceptions[1].mechanism, { exception_id: 1, parent_id: 0, source: 'cause' })
        })
    }

    test('does not read the errors accessor of an ordinary error', () => {
        const domainError = new Error('invalid input')
        let reads = 0
        Object.defineProperty(domainError, 'errors', {
            get: () => {
                reads++
                return [new Error('validation detail')]
            },
        })
        assert.equal(builder.buildFromUnknown(domainError).$exception_list.length, 1)
        assert.equal(reads, 0)
    })

    test('does not traverse domain-error details inside a native aggregate', () => {
        const domainError = Object.assign(new Error('invalid input'), { errors: [new Error('validation detail')] })
        const aggregate = new AggregateError([domainError, new Error('next member')], 'group')
        const exceptions = builder.buildFromUnknown(aggregate).$exception_list
        assert.deepEqual(values(exceptions), ['group', 'invalid input', 'next member'])
        assertMatch(exceptions[2].mechanism, { exception_id: 2, parent_id: 0, source: 'member' })
    })

    test('does not treat cross-realm validation errors as aggregates', () => {
        const domainError = runInNewContext(`(() => {
            class ValidationError extends Error {
                errors = [{ message: 'invalid email' }]
            }
            return new ValidationError('invalid input')
        })()`)
        assert.ok(!(domainError instanceof Error))
        assert.equal(builder.buildFromUnknown(domainError).$exception_list.length, 1)
    })

    test('preserves custom-named cross-realm aggregate subclasses', () => {
        const aggregate = runInNewContext(`(() => {
            class CustomGroupError extends AggregateError {}
            const error = new CustomGroupError([new Error('member')], 'group')
            error.name = 'CustomGroupError'
            return error
        })()`)
        const exceptions = builder.buildFromUnknown(aggregate).$exception_list
        assert.ok(!(aggregate instanceof AggregateError))
        assert.deepEqual(values(exceptions), ['group', 'member'])
        assertMatch(exceptions[1].mechanism, { exception_id: 1, parent_id: 0, source: 'member' })
    })

    test('bounds aggregate detection of a cyclic proxy prototype without losing the root', () => {
        const errorBuilder = new ErrorPropertiesBuilder([errorCoercer], createStackParser('web:javascript', chromeStackLineParser))
        let inspections = 0
        const input = new Proxy(new Error('malformed prototype'), {
            get: (target, key) => (key === Symbol.toStringTag ? 'Error' : Reflect.get(target, key)),
            getPrototypeOf: () => {
                inspections++
                return input
            },
        })
        assertMatch(errorBuilder.buildFromUnknown(input).$exception_list, [objectContaining({ value: 'malformed prototype' })])
        assert.ok(inspections > 0)
        assert.ok(inspections <= 101)
    })

    test('retains both the ordinary cause and aggregate alternatives', () => {
        const aggregate = new AggregateError([new Error('alternative')], 'group', { cause: new Error('cause') })
        const exceptions = builder.buildFromUnknown(aggregate, {
            mechanism: { handled: false, type: 'onunhandledrejection' },
        }).$exception_list
        assertMatch(exceptions[0], { value: 'group', mechanism: { handled: false } })
        assert.ok(
            exceptions.some((e) =>
                isMatch(e, {
                    value: 'cause',
                    mechanism: { type: 'chained', source: 'cause', synthetic: false, exception_id: 1, parent_id: 0 },
                })
            )
        )
        assert.ok(exceptions.some((e) => e.value === 'alternative'))
    })

    test('keeps root, causes, then children in depth-first input order with their own stacks', () => {
        const cause = new Error('cause', { cause: new Error('cause origin') })
        const child = new Error('first', { cause: new Error('first cause') })
        const nested = new AggregateError([new Error('nested child')], 'nested', { cause: new Error('nested cause') })
        const aggregate = new AggregateError([child, nested, new Error('last')], 'root', { cause })
        const inputs = [aggregate, cause, cause.cause, child, child.cause, nested, nested.cause, nested.errors[0], aggregate.errors[2]]
        for (const [index, input] of inputs.entries()) {
            input.stack = `Error: ${input.message}\n    at frame${index} (https://example.com/file${index}.js:12:34)`
            Object.freeze(input)
        }
        Object.freeze(aggregate.errors)
        const properties = builder.buildFromUnknown(aggregate, { mechanism: { type: 'onunhandledrejection', handled: false } })
        assert.deepEqual(Object.keys(properties).sort(), ['$exception_level', '$exception_list'])
        assert.deepEqual(
            values(properties.$exception_list),
            inputs.map((i) => i.message)
        )
        properties.$exception_list.forEach((exception, index) => {
            assert.deepEqual(Object.keys(exception).sort(), ['mechanism', 'stacktrace', 'type', 'value'])
            assertEqual(
                exception.mechanism,
                index === 0
                    ? { type: 'onunhandledrejection', handled: false, synthetic: false, exception_id: 0 }
                    : {
                          type: 'chained',
                          source: ['cause', 'cause', 'member', 'cause', 'member', 'cause', 'member', 'member'][index - 1],
                          synthetic: false,
                          exception_id: index,
                          parent_id: [0, 1, 0, 3, 0, 5, 5, 0][index - 1],
                      }
            )
            assertMatch(exception.stacktrace.frames, [
                objectContaining({ filename: `https://example.com/file${index}.js`, lineno: 12, colno: 34 }),
            ])
        })
    })

    test('retains deep ordinary cause chains without inventing nested handled state or repeating cycles', () => {
        let error = new Error('6')
        for (let index = 5; index >= 0; index--) error = new Error(String(index), { cause: error })
        const exceptions = builder.buildFromUnknown(error, { mechanism: { handled: false } }).$exception_list
        assert.deepEqual(values(exceptions), ['0', '1', '2', '3', '4', '5', '6'])
        assert.deepEqual(
            exceptions.map((e) => e.mechanism.handled),
            [false, undefined, undefined, undefined, undefined, undefined, undefined]
        )
        error.cause = error
        assert.deepEqual(values(builder.buildFromUnknown(error).$exception_list), ['0'])
    })

    test('retains cause and member edges beyond the old depth bound', () => {
        const tooDeep = new AggregateError([new Error('deep child')], 'depth4', { cause: new Error('deep cause') })
        const depth3 = new Error('depth3', { cause: tooDeep })
        const depth2 = new AggregateError([depth3], 'depth2')
        const depth1 = new Error('depth1', { cause: depth2 })
        const root = new AggregateError([depth1, new Error('sibling')], 'root')
        assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), [
            'root',
            'depth1',
            'depth2',
            'depth3',
            'depth4',
            'deep cause',
            'deep child',
            'sibling',
        ])
    })

    test('omits ancestor cycles and emits shared children only in their first position', () => {
        const shared = new Error('shared')
        const root = new AggregateError([], 'root')
        const nested = new AggregateError([root, shared], 'nested', { cause: root })
        root.errors.push(root, nested, shared, shared)
        assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), ['root', 'nested', 'shared'])
        assert.deepEqual(root.errors, [root, nested, shared, shared])
    })

    test('bounds wide aggregate output to 50 entries including root and causes', () => {
        const children = Array.from({ length: 1000 }, (_, i) => new Error(String(i)))
        let unreadCalls = 0
        Object.defineProperty(children, '48', {
            get: () => {
                unreadCalls++
                throw new Error('past the traversal budget')
            },
        })
        const root = new AggregateError([], 'root', { cause: new Error('cause') })
        root.errors = children
        assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), [
            'root',
            'cause',
            ...Array.from({ length: 48 }, (_, i) => String(i)),
        ])
        assert.equal(unreadCalls, 0)
        assert.equal(builder.buildFromUnknown(new AggregateError([new Error('next')], 'next root')).$exception_list.length, 2)
    })

    test('shares the emission budget across nested groups', () => {
        const groups = Array.from({ length: 100 }, (_, i) => new AggregateError([new Error(`child ${i}`)], `group ${i}`))
        const exceptions = builder.buildFromUnknown(new AggregateError(groups, 'root')).$exception_list
        assert.equal(exceptions.length, 50)
        assert.deepEqual(values(exceptions.slice(-3)), ['group 23', 'child 23', 'group 24'])
    })

    for (const kind of ['error event', 'rejection event', 'object']) {
        test(`unwraps an aggregate in an ${kind} without duplicating entries`, () => {
            const aggregate = new AggregateError([new Error('child')], 'root')
            const input =
                kind === 'error event'
                    ? { [Symbol.toStringTag]: 'ErrorEvent', error: aggregate }
                    : kind === 'rejection event'
                      ? new CustomEvent('unhandledrejection', { detail: { reason: aggregate } })
                      : { error: aggregate }
            assert.deepEqual(values(builder.buildFromUnknown(input).$exception_list), ['root', 'child'])
        })
    }

    test('bounds self-referencing wrappers inside aggregate children', () => {
        const wrapper = { [Symbol.toStringTag]: 'ErrorEvent', error: undefined }
        wrapper.error = wrapper
        const root = new AggregateError([wrapper, new Error('last')], 'root')
        assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), ['root', 'Unknown error', 'last'])
    })

    for (const errors of [undefined, null, 'not an array', { length: 1, 0: new Error('not a child') }]) {
        test(`ignores malformed errors collections: ${inspect(errors)}`, () => {
            const root = new AggregateError([], 'root')
            root.errors = errors
            assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), ['root'])
        })
    }

    test('ignores a throwing errors getter without losing the root or cause', () => {
        const root = new AggregateError([], 'root', { cause: new Error('cause') })
        Object.defineProperty(root, 'errors', {
            get() {
                throw new Error('unreadable')
            },
        })
        assert.deepEqual(values(builder.buildFromUnknown(root).$exception_list), ['root', 'cause'])
    })

    test('uses existing coercers for non-error members and fallback for unreadable members', () => {
        const memberValues = ['text', 42, null, undefined, { message: 'object member' }]
        const root = new AggregateError(memberValues, 'root')
        Object.defineProperty(root.errors, '5', {
            get() {
                throw new Error('unreadable')
            },
        })
        const malformed = new Error('malformed')
        Object.defineProperty(malformed, 'message', {
            get() {
                throw new Error('unreadable message')
            },
        })
        root.errors.push(malformed, new Error('last'))
        const exceptions = builder.buildFromUnknown(root, { syntheticException: new Error('capture site') }).$exception_list
        assertEqual(
            exceptions.slice(1, 6),
            memberValues.map((value, index) => ({
                ...builder.buildFromUnknown(value).$exception_list[0],
                mechanism: { type: 'chained', source: 'member', synthetic: true, exception_id: index + 1, parent_id: 0 },
            }))
        )
        assert.deepEqual(values(exceptions.slice(6)), ['Unknown error', 'Unknown error', 'last'])
        assert.ok(exceptions.slice(1, 8).every((e) => !e.stacktrace))
    })

    // Adapted: frame modifiers are not ported, so only the chunk id half is checked.
    test('applies chunk IDs independently to every entry', () => {
        const inputs = [new AggregateError([], 'root'), new Error('cause'), new Error('child')]
        inputs.forEach((input, index) => {
            input.stack = `Error\n    at f (https://example.com/chunk${index}.js:1:2)`
        })
        inputs[0].cause = inputs[1]
        inputs[0].errors.push(inputs[2])
        resetChunkIdCache()
        globalThis._posthogChunkIds = Object.fromEntries(inputs.map((input, index) => [input.stack, `chunk-${index}`]))
        try {
            const chunkBuilder = new ErrorPropertiesBuilder([errorCoercer], createStackParser('web:javascript', chromeStackLineParser))
            const exceptions = chunkBuilder.buildFromUnknown(inputs[0]).$exception_list
            assert.equal(exceptions.length, 3)
            exceptions.forEach((exception, index) => {
                assertMatch(exception.stacktrace.frames, [objectContaining({ chunk_id: `chunk-${index}` })])
            })
        } finally {
            delete globalThis._posthogChunkIds
            resetChunkIdCache()
        }
    })
})

// ===========================================================================
// core/src/error-tracking/chunk-ids.spec.ts
describe('getFilenameToChunkIdMap', () => {
    const stackParser = (stack) => [{ platform: 'web:javascript', filename: stack.split('|')[0] }]
    const clear = () => {
        resetChunkIdCache() // upstream: vi.resetModules()
        delete globalThis._posthogChunkIds
        delete globalThis._debugIds
    }
    beforeEach(clear)
    afterEach(clear)

    test('maps native debug IDs to filenames', () => {
        globalThis._debugIds = { 'https://example.com/chunk.js|native': 'native-debug-id' }
        assert.deepEqual(getFilenameToChunkIdMap(stackParser), { 'https://example.com/chunk.js': 'native-debug-id' })
    })

    test('prefers PostHog chunk IDs over native debug IDs for the same file', () => {
        globalThis._debugIds = { 'https://example.com/chunk.js|native': 'native-debug-id' }
        globalThis._posthogChunkIds = { 'https://example.com/chunk.js|posthog': 'posthog-chunk-id' }
        assert.deepEqual(getFilenameToChunkIdMap(stackParser), { 'https://example.com/chunk.js': 'posthog-chunk-id' })
    })

    test('refreshes the cached map when native debug IDs are added', () => {
        globalThis._debugIds = { 'https://example.com/one.js|native': 'one' }
        assert.deepEqual(getFilenameToChunkIdMap(stackParser), { 'https://example.com/one.js': 'one' })
        globalThis._debugIds['https://example.com/two.js|native'] = 'two'
        assert.deepEqual(getFilenameToChunkIdMap(stackParser), {
            'https://example.com/one.js': 'one',
            'https://example.com/two.js': 'two',
        })
    })

    test('refreshes the cached map when a debug ID map is replaced with the same number of entries', () => {
        globalThis._debugIds = { 'https://example.com/one.js|native': 'one' }
        assert.deepEqual(getFilenameToChunkIdMap(stackParser), { 'https://example.com/one.js': 'one' })
        globalThis._debugIds = { 'https://example.com/two.js|native': 'two' }
        assert.deepEqual(getFilenameToChunkIdMap(stackParser), { 'https://example.com/two.js': 'two' })
    })
})

// ===========================================================================
// core/src/error-tracking/release.spec.ts
describe('getInjectedReleaseId', () => {
    const originalReleaseId = process.env.POSTHOG_RELEASE_ID
    afterEach(() => {
        if (originalReleaseId === undefined) delete process.env.POSTHOG_RELEASE_ID
        else process.env.POSTHOG_RELEASE_ID = originalReleaseId
        delete globalThis._posthogReleaseId
    })

    const cases = [
        { name: 'reads and trims POSTHOG_RELEASE_ID', env: '  release-from-environment  ', injected: undefined, expected: 'release-from-environment' },
        {
            name: 'prefers POSTHOG_RELEASE_ID over the injected global',
            env: 'release-from-environment',
            injected: 'release-from-injection',
            expected: 'release-from-environment',
        },
        {
            name: 'falls back to the injected global when the environment value is empty',
            env: '   ',
            injected: 'release-from-injection',
            expected: 'release-from-injection',
        },
    ]
    for (const { name, env, injected, expected } of cases) {
        test(name, () => {
            process.env.POSTHOG_RELEASE_ID = env
            if (injected !== undefined) globalThis._posthogReleaseId = injected
            assert.equal(getInjectedReleaseId(), expected)
        })
    }
})

// ===========================================================================
// core/src/error-tracking/exception-steps.spec.ts
describe('exception steps', () => {
    describe('resolveExceptionStepsConfig', () => {
        test('uses defaults when no config is passed', () => {
            assert.deepEqual(resolveExceptionStepsConfig(), { enabled: true, max_bytes: 32768 })
        })
        test('falls back to defaults for invalid values', () => {
            assert.deepEqual(resolveExceptionStepsConfig({ max_bytes: Number.NaN }), { enabled: true, max_bytes: 32768 })
        })
    })

    describe('stripReservedExceptionStepFields', () => {
        test('strips reserved fields and keeps custom properties', () => {
            assert.deepEqual(
                stripReservedExceptionStepFields({
                    [EXCEPTION_STEP_MESSAGE]: 'should-strip',
                    [EXCEPTION_STEP_TIMESTAMP]: 'should-strip',
                    custom: true,
                }),
                { sanitizedProperties: { custom: true }, droppedKeys: [EXCEPTION_STEP_MESSAGE, EXCEPTION_STEP_TIMESTAMP] }
            )
        })
    })

    describe('ExceptionStepsBuffer', () => {
        const makeStep = (message) => ({
            [EXCEPTION_STEP_MESSAGE]: message,
            [EXCEPTION_STEP_TIMESTAMP]: '2026-01-01T00:00:00.000Z',
        })
        const bytesOf = (step) => getUtf8ByteLength(JSON.stringify(step))

        const cases = [
            {
                desc: 'evicts oldest steps when max bytes are exceeded',
                config: { max_bytes: bytesOf(makeStep('two')) + bytesOf(makeStep('three')) },
                steps: [makeStep('one'), makeStep('two'), makeStep('three')],
                expected: ['two', 'three'],
            },
            {
                desc: 'keeps the most recent step when budget fits only one',
                config: { max_bytes: bytesOf(makeStep('one')) },
                steps: [makeStep('one'), makeStep('two')],
                expected: ['two'],
            },
            {
                desc: 'skips malformed steps that cannot be normalized',
                config: { max_bytes: 10000 },
                steps: [{ $message: '', $timestamp: '2026-01-01T00:00:00.000Z' }, makeStep('valid')],
                expected: ['valid'],
            },
            {
                desc: 'drops a step that exceeds the entire budget on its own',
                config: { max_bytes: 10 },
                steps: [makeStep('this message is way too long for the tiny budget')],
                expected: [],
            },
        ]
        for (const { desc, config, steps, expected } of cases) {
            test(desc, () => {
                const buffer = new ExceptionStepsBuffer(config)
                for (const step of steps) buffer.add(step)
                assert.deepEqual(
                    buffer.getAttachable().map((s) => s.$message),
                    expected
                )
            })
        }

        test('clears all steps', () => {
            const buffer = new ExceptionStepsBuffer({ max_bytes: 10000 })
            buffer.add(makeStep('one'))
            buffer.clear()
            assert.equal(buffer.size(), 0)
        })
    })
})

// ===========================================================================
// core/src/utils/bucketed-rate-limiter.spec.ts
// Skipped: the 'callback behavior' block (`_onBucketRateLimited` is not ported).
describe('resolveExceptionRateLimiterConfig', () => {
    const cases = [
        {
            name: 'falls back to the shared defaults when nothing is configured',
            input: undefined,
            expected: { refillRate: DEFAULT_EXCEPTION_RATE_LIMITER_REFILL_RATE, bucketSize: DEFAULT_EXCEPTION_RATE_LIMITER_BUCKET_SIZE },
        },
        {
            name: 'prefers the first-class options',
            input: { exceptionRateLimiterRefillRate: 2, exceptionRateLimiterBucketSize: 20 },
            expected: { refillRate: 2, bucketSize: 20 },
        },
        {
            name: 'honours the deprecated double-underscore options as a fallback',
            input: { __exceptionRateLimiterRefillRate: 3, __exceptionRateLimiterBucketSize: 30 },
            expected: { refillRate: 3, bucketSize: 30 },
        },
        {
            name: 'lets the first-class options win over the deprecated ones',
            input: {
                exceptionRateLimiterRefillRate: 5,
                __exceptionRateLimiterRefillRate: 3,
                exceptionRateLimiterBucketSize: 50,
                __exceptionRateLimiterBucketSize: 30,
            },
            expected: { refillRate: 5, bucketSize: 50 },
        },
    ]
    for (const { name, input, expected } of cases) {
        test(name, () => assert.deepEqual(resolveExceptionRateLimiterConfig(input), expected))
    }
})

describe('BucketedRateLimiter', () => {
    const START = 1_700_000_000_000
    let rateLimiter
    const buckets = (limiter) => limiter.buckets_
    const advance = (ms) => mock.timers.tick(ms)

    beforeEach(() => {
        mock.timers.enable({ apis: ['Date'], now: START })
        rateLimiter = new BucketedRateLimiter({ bucketSize: 10, refillRate: 1, refillInterval: 1000 })
    })
    afterEach(() => mock.timers.reset())

    describe('basic consumption', () => {
        test('it is not rate limited by default', () => {
            assert.equal(rateLimiter.consumeRateLimit('ResizeObserver'), false)
        })

        test('returns bucket is rate limited if no mutations are left', () => {
            buckets(rateLimiter)['ResizeObserver'] = { tokens: 0, lastAccess: Date.now() }
            assert.equal(rateLimiter.consumeRateLimit('ResizeObserver'), true)
        })

        for (const { bucketSize, consumptions } of [
            { bucketSize: 1, consumptions: 1 },
            { bucketSize: 5, consumptions: 5 },
            { bucketSize: 10, consumptions: 10 },
            { bucketSize: 50, consumptions: 50 },
        ]) {
            test(`exhausts bucket of size ${bucketSize} after ${consumptions} consumptions`, () => {
                const limiter = new BucketedRateLimiter({ bucketSize, refillRate: 1, refillInterval: 1000 })
                for (let i = 0; i < consumptions - 1; i++) assert.equal(limiter.consumeRateLimit('test'), false)
                assert.equal(limiter.consumeRateLimit('test'), true)
                assert.equal(limiter.consumeRateLimit('test'), true)
            })
        }
    })

    describe('refill behavior', () => {
        test('refills tokens based on elapsed time', () => {
            const key = 'ResizeObserver'
            for (let i = 0; i < 9; i++) assert.equal(rateLimiter.consumeRateLimit(key), false)
            assert.equal(rateLimiter.consumeRateLimit(key), true)
            advance(2000)
            assert.equal(rateLimiter.consumeRateLimit(key), false)
            assert.equal(buckets(rateLimiter)[key].tokens, 1)
        })

        test('refills to bucket size maximum', () => {
            const key = 'ResizeObserver'
            rateLimiter.consumeRateLimit(key)
            advance(20000)
            rateLimiter.consumeRateLimit(key)
            assert.equal(buckets(rateLimiter)[key].tokens, 9)
        })

        test('partial refill intervals do not refill tokens', () => {
            for (let i = 0; i < 9; i++) rateLimiter.consumeRateLimit('test')
            advance(999)
            rateLimiter.consumeRateLimit('test')
            assert.equal(buckets(rateLimiter)['test'].tokens, 0)
        })

        for (const { refillRate, intervals, tokensLeft = 9, expected } of [
            { refillRate: 1, intervals: 1, expected: 9 },
            { refillRate: 2, intervals: 1, expected: 9 },
            { refillRate: 1, intervals: 2, expected: 9 },
            { refillRate: 3, intervals: 1, tokensLeft: 5, expected: 7 },
            { refillRate: 2, intervals: 2, tokensLeft: 5, expected: 8 },
        ]) {
            test(`with rate ${refillRate}, ${intervals} intervals, starting at ${tokensLeft} tokens, ends at ${expected}`, () => {
                const limiter = new BucketedRateLimiter({ bucketSize: 10, refillRate, refillInterval: 1000 })
                for (let i = 0; i < 10 - tokensLeft; i++) limiter.consumeRateLimit('test')
                advance(intervals * 1000)
                limiter.consumeRateLimit('test')
                assert.equal(buckets(limiter)['test'].tokens, expected)
            })
        }
    })

    describe('bucket isolation', () => {
        test('different keys maintain separate buckets', () => {
            for (let i = 0; i < 9; i++) rateLimiter.consumeRateLimit('bucket1')
            assert.equal(rateLimiter.consumeRateLimit('bucket1'), true)
            assert.equal(rateLimiter.consumeRateLimit('bucket2'), false)
            assert.equal(buckets(rateLimiter)['bucket1'].tokens, 0)
            assert.equal(buckets(rateLimiter)['bucket2'].tokens, 9)
        })

        test('supports both string and number keys', () => {
            const limiter = new BucketedRateLimiter({ bucketSize: 5, refillRate: 1, refillInterval: 1000 })
            for (let i = 0; i < 4; i++) {
                limiter.consumeRateLimit('string-key')
                limiter.consumeRateLimit(123)
            }
            assert.equal(buckets(limiter)['string-key'].tokens, 1)
            assert.equal(buckets(limiter)['123'].tokens, 1)
        })
    })

    describe('stop method', () => {
        test('clears all buckets', () => {
            rateLimiter.consumeRateLimit('key1')
            rateLimiter.consumeRateLimit('key2')
            assert.equal(Object.keys(buckets(rateLimiter)).length, 2)
            rateLimiter.stop()
            assert.equal(Object.keys(buckets(rateLimiter)).length, 0)
        })

        test('resets state after stop', () => {
            for (let i = 0; i < 9; i++) rateLimiter.consumeRateLimit('test')
            rateLimiter.stop()
            assert.equal(rateLimiter.consumeRateLimit('test'), false)
            assert.equal(buckets(rateLimiter)['test'].tokens, 9)
        })
    })

    describe('timestamp tracking', () => {
        test('preserves fractional intervals', () => {
            const key = 'test'
            const startTime = Date.now()
            rateLimiter.consumeRateLimit(key)
            assert.equal(buckets(rateLimiter)[key].lastAccess, startTime)
            assert.equal(buckets(rateLimiter)[key].tokens, 9)
            advance(500)
            rateLimiter.consumeRateLimit(key)
            assert.equal(buckets(rateLimiter)[key].lastAccess, startTime)
            assert.equal(buckets(rateLimiter)[key].tokens, 8)
            advance(600)
            rateLimiter.consumeRateLimit(key)
            assert.equal(buckets(rateLimiter)[key].lastAccess, startTime + 1000)
            assert.equal(buckets(rateLimiter)[key].tokens, 8)
        })

        test('advances lastAccess by complete intervals on refill', () => {
            const key = 'test'
            const startTime = Date.now()
            for (let i = 0; i < 9; i++) rateLimiter.consumeRateLimit(key)
            assert.equal(buckets(rateLimiter)[key].lastAccess, startTime)
            advance(2500)
            rateLimiter.consumeRateLimit(key)
            assert.equal(buckets(rateLimiter)[key].lastAccess, startTime + 2000)
            assert.equal(buckets(rateLimiter)[key].tokens, 2)
        })
    })
})

// ===========================================================================
// browser/src/__tests__/extensions/exception-autocapture/error-conversion.test.ts
describe('Error conversion', () => {
    const builder = buildErrorPropertiesBuilder()
    const errorToProperties = ({ event, error }, hint) =>
        builder.buildFromUnknown(error ?? event, {
            mechanism: { handled: hint?.handled },
            syntheticException: hint?.syntheticException,
        })
    // Adapted: under vitest every frame is an app file, so upstream checks
    // frames[0] (the outermost). Under node:test the outer frames are
    // `node:internal/...`, so check the frame from this file instead.
    const assertHasAppFrame = (exception) => {
        const frames = exception.stacktrace.frames
        const own = frames.find((f) => f.filename && f.filename.endsWith('exceptions.test.mjs'))
        assert.ok(own, 'expected a frame from this test file')
        assert.equal(own.in_app, true)
    }
    const generic = (synthetic) => ({ synthetic, handled: true, type: 'generic', exception_id: 0 })

    test('should convert a string to an error', () => {
        assertEqual(errorToProperties({ event: 'Uncaught exception: InternalError: but somehow still a string' }), {
            $exception_level: 'error',
            $exception_list: [{ type: 'InternalError', value: 'but somehow still a string', mechanism: generic(true) }],
        })
    })

    test('should convert a plain object to an error', () => {
        assertEqual(errorToProperties({ event: { string: 'candidate', foo: 'bar' } }), {
            $exception_level: 'error',
            $exception_list: [
                { type: 'Error', value: 'Object captured as exception with keys: foo, string', mechanism: generic(true) },
            ],
        })
    })

    // Adapted: jsdom gives events an own `isTrusted` key; Node's Event does not.
    test('should convert a plain Event to an error', () => {
        class MouseEvent extends Event {}
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
        assertEqual(errorToProperties({ event }), {
            $exception_level: 'error',
            $exception_list: [
                {
                    type: 'MouseEvent',
                    value: 'MouseEvent captured as exception with keys: [object has no keys]',
                    mechanism: generic(true),
                },
            ],
        })
    })

    test('should convert a plain Error to an error', () => {
        const error = new Error('oh no an error has happened')
        const props = errorToProperties({ event: 'something', error })
        assert.equal(Object.keys(props).length, 2)
        assert.equal(props.$exception_level, 'error')
        const [exception] = props.$exception_list
        assert.equal(exception.type, 'Error')
        assert.equal(exception.value, 'oh no an error has happened')
        assertHasAppFrame(exception)
        assert.equal(exception.mechanism.synthetic, false)
        assert.equal(exception.mechanism.handled, true)
    })

    test('should convert a DOM Error to an error', () => {
        class FakeDomError {
            constructor(name, message) {
                this.name = name
                this.message = message
                this[Symbol.toStringTag] = 'DOMError'
            }
        }
        assertEqual(errorToProperties({ event: new FakeDomError('click', 'foo') }), {
            $exception_level: 'error',
            $exception_list: [{ type: 'DOMError', value: 'click: foo', mechanism: generic(false) }],
        })
    })

    test('should convert a DOM Exception to an error', () => {
        const props = errorToProperties({ event: new DOMException('oh no disaster', 'dom-exception') })
        assert.equal(Object.keys(props).length, 2)
        assert.equal(props.$exception_list[0].type, 'DOMException')
        assert.equal(props.$exception_list[0].value, 'dom-exception: oh no disaster')
        assert.equal(props.$exception_level, 'error')
        assertHasAppFrame(props.$exception_list[0])
    })

    test('should convert an error event to an error', () => {
        const event = new FakeErrorEvent('oh no an error event', { error: new Error('the real error is hidden inside') })
        const props = errorToProperties({ event })
        assert.equal(Object.keys(props).length, 2)
        const [exception] = props.$exception_list
        assert.equal(exception.type, 'Error')
        assert.equal(exception.value, 'the real error is hidden inside')
        assert.equal(props.$exception_level, 'error')
        assertHasAppFrame(exception)
        assert.equal(exception.mechanism.synthetic, false)
        assert.equal(exception.mechanism.handled, true)
    })

    // Adapted: no own `isTrusted` key under Node (see above).
    test('should convert unhandled promise rejection', () => {
        const pre = new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve('wat'), reason: 'My house is on fire' })
        const props = errorToProperties({ event: pre }, { handled: false })
        assert.equal(Object.keys(props).length, 2)
        assert.equal(props.$exception_list[0].type, 'PromiseRejectionEvent')
        assert.equal(props.$exception_list[0].value, 'PromiseRejectionEvent captured as exception with keys: promise, reason')
        assert.equal(props.$exception_level, 'error')
        assert.equal(props.$exception_list[0].mechanism.synthetic, true)
        assert.equal(props.$exception_list[0].mechanism.handled, false)
    })

    test('should use cause when it is an error', () => {
        class CustomError extends Error {
            constructor(message) {
                super(message)
                this.name = 'CustomError'
            }
        }
        const error = new Error('my error', { cause: new CustomError('my original error') })
        const props = errorToProperties({ error, event: undefined })
        assert.equal(Object.keys(props).length, 2)
        assert.equal(props.$exception_list.length, 2)
        assert.ok(props.$exception_list.every((e) => e.stacktrace.frames.length > 0))
        // __snapshots__/error-conversion.test.ts.snap
        assertEqual(
            {
                ...props,
                $exception_list: props.$exception_list.map(({ stacktrace, ...exception }) => ({
                    ...exception,
                    stacktrace: { ...stacktrace, frames: '<normalized stack frames>' },
                })),
            },
            {
                $exception_level: 'error',
                $exception_list: [
                    {
                        mechanism: { exception_id: 0, handled: true, synthetic: false, type: 'generic' },
                        stacktrace: { frames: '<normalized stack frames>', type: 'raw' },
                        type: 'Error',
                        value: 'my error',
                    },
                    {
                        mechanism: { exception_id: 1, parent_id: 0, source: 'cause', synthetic: false, type: 'chained' },
                        stacktrace: { frames: '<normalized stack frames>', type: 'raw' },
                        type: 'CustomError',
                        value: 'my original error',
                    },
                ],
            }
        )
    })

    test('should emit a string cause as a chained exception', () => {
        const error = new Error('my error', { cause: 'original test' })
        const props = errorToProperties({ error, event: undefined })
        assert.equal(Object.keys(props).length, 2)
        assert.equal(props.$exception_list.length, 2)
        assertMatch(props.$exception_list, [
            { type: 'Error', value: 'my error', mechanism: { synthetic: false, handled: true } },
            { type: 'Error', value: 'original test' },
        ])
        assert.equal(props.$exception_level, 'error')
    })

    test('should not forward handled prop when using cause', () => {
        const error = new Error('my error', { cause: new Error('my original error') })
        const props = errorToProperties({ error, event: undefined }, { handled: false, syntheticException: new Error('Synthetic') })
        assert.equal(Object.keys(props).length, 2)
        assert.equal(props.$exception_list.length, 2)
        assert.equal(props.$exception_list[0].mechanism.synthetic, false)
        assert.equal(props.$exception_list[0].mechanism.handled, false)
        assert.deepEqual(props.$exception_list[1].mechanism, {
            type: 'chained',
            source: 'cause',
            synthetic: false,
            exception_id: 1,
            parent_id: 0,
        })
    })
})

// ===========================================================================
// browser/src/__tests__/posthog-exceptions.test.ts
// The upstream instance is a hand-rolled PostHog stub too; this one records
// capture() calls. onRemoteConfig takes the raw response here (upstream wraps
// it in {ok, config}).
function createSuppressionRule(
    type = 'OR',
    ruleValues = [
        { key: '$exception_types', value: ['TypeError', 'ReactError'], operator: 'exact', type: 'error_tracking_issue_property' },
        { key: '$exception_values', value: 'ReactMinified', operator: 'icontains', type: 'error_tracking_issue_property' },
    ]
) {
    return { type, values: ruleValues }
}

function createFakePostHog() {
    const props = {}
    const capture = mock.fn(() => ({ uuid: 'test-uuid', event: '$exception', properties: {} }))
    const posthog = {
        config: { error_tracking: {} },
        persistence: {
            props,
            register(p) {
                Object.assign(props, p)
            },
        },
        get_property: (key) => props[key],
        capture,
        extensions: {},
    }
    posthog.persistence.register({ [ERROR_TRACKING_SUPPRESSION_RULES]: [] })
    return posthog
}

describe('PostHogExceptions', () => {
    let posthog
    let exceptions
    let captureMock
    const calls = () => captureMock.mock.calls.map((c) => c.arguments)
    const assertCapturedWith = (properties) => {
        assert.equal(captureMock.mock.callCount(), 1)
        const [name, props, options] = calls()[0]
        assert.equal(name, '$exception')
        assertEqual(props, properties)
        assert.ok(options != null)
    }
    const assertNotCaptured = () => assert.equal(captureMock.mock.callCount(), 0)

    beforeEach(() => {
        posthog = createFakePostHog()
        captureMock = posthog.capture
        exceptions = new PostHogExceptions(posthog)
    })
    afterEach(() => mock.timers.reset())

    describe('onRemoteConfig', () => {
        test('persists the suppression rules', () => {
            const suppressionRule = createSuppressionRule()
            exceptions.onRemoteConfig({ errorTracking: { suppressionRules: [suppressionRule] } })
            assert.deepEqual(exceptions.suppressionRules_, [suppressionRule])
            assert.deepEqual(posthog.persistence.props[ERROR_TRACKING_SUPPRESSION_RULES], [suppressionRule])
        })

        // Upstream's spec builds a new instance once persistence exists and
        // expects it to read the persisted rules back. In upstream's default
        // bundle (array.js, which the diff test compares against) `exceptions`
        // is constructed in the PostHog constructor, before persistence exists,
        // so persisted rules are never read at startup; the port follows that
        // bundle (see the constructor comment in src/exceptions/exceptions.js).
        test('persists the suppression rules: a new instance starts empty (default-bundle behaviour)', () => {
            const suppressionRule = createSuppressionRule()
            exceptions.onRemoteConfig({ errorTracking: { suppressionRules: [suppressionRule] } })
            assert.deepEqual(new PostHogExceptions(posthog).suppressionRules_, [])
        })

        test('does not overwrite persistence when called with empty config', () => {
            const suppressionRule = createSuppressionRule()
            posthog.persistence.register({
                [ERROR_TRACKING_SUPPRESSION_RULES]: [suppressionRule],
                [ERROR_TRACKING_CAPTURE_EXTENSION_EXCEPTIONS]: true,
            })
            new PostHogExceptions(posthog).onRemoteConfig({})
            assert.deepEqual(posthog.persistence.props[ERROR_TRACKING_SUPPRESSION_RULES], [suppressionRule])
            assert.equal(posthog.persistence.props[ERROR_TRACKING_CAPTURE_EXTENSION_EXCEPTIONS], true)
        })

        test('updates persistence when errorTracking key is present', () => {
            posthog.persistence.register({
                [ERROR_TRACKING_SUPPRESSION_RULES]: [createSuppressionRule()],
                [ERROR_TRACKING_CAPTURE_EXTENSION_EXCEPTIONS]: true,
            })
            new PostHogExceptions(posthog).onRemoteConfig({
                errorTracking: { suppressionRules: [], captureExtensionExceptions: false },
            })
            assert.deepEqual(posthog.persistence.props[ERROR_TRACKING_SUPPRESSION_RULES], [])
            assert.equal(posthog.persistence.props[ERROR_TRACKING_CAPTURE_EXTENSION_EXCEPTIONS], false)
        })
    })

    describe('sendExceptionEvent', () => {
        test('captures the event when no suppression rules are provided', () => {
            exceptions.sendExceptionEvent({ custom_property: true })
            assertCapturedWith({ custom_property: true })
        })

        test('attaches the injected release id when present', () => {
            const originalReleaseId = process.env.POSTHOG_RELEASE_ID
            delete process.env.POSTHOG_RELEASE_ID
            globalThis._posthogReleaseId = 'release-row-id'
            try {
                exceptions.sendExceptionEvent({ custom_property: true })
                assertCapturedWith({ custom_property: true, $release_id: 'release-row-id' })
            } finally {
                delete globalThis._posthogReleaseId
                if (originalReleaseId !== undefined) process.env.POSTHOG_RELEASE_ID = originalReleaseId
            }
        })

        test('fails gracefully with a warning when capture throws', () => {
            captureMock.mock.mockImplementationOnce(() => {
                throw new Error('capture failed')
            })
            assert.doesNotThrow(() => exceptions.sendExceptionEvent({ custom_property: true }))
        })

        for (const [type, value] of [
            ['TypeError', 'This is a type error'],
            ['GenericError', 'This is a message that contains a ReactMinified error'],
        ]) {
            test(`drops the event if a suppression rule matches: ${type}`, () => {
                exceptions.onRemoteConfig({ errorTracking: { suppressionRules: [createSuppressionRule('OR')] } })
                exceptions.sendExceptionEvent({ $exception_list: [{ type, value }] })
                assertNotCaptured()
            })
        }

        const capturedCases = [
            {
                name: 'captures an exception if no $exception_list property exists',
                rule: createSuppressionRule('AND'),
                properties: { custom_property: true },
            },
            {
                name: 'captures an exception if all rule conditions do not match',
                rule: createSuppressionRule('AND'),
                properties: { $exception_list: [{ type: 'TypeError', value: 'This is a type error' }] },
            },
            {
                name: 'captures the exception when a rule uses an operator the SDK does not implement',
                rule: createSuppressionRule('AND', [{ key: '$lib', value: 'is_not_set', operator: 'is_not_set', type: 'event_property' }]),
                properties: { $exception_list: [{ type: 'TypeError', value: 'This is a type error' }] },
            },
            {
                name: 'captures the exception when a rule uses a negative operator on a key the SDK cannot resolve',
                rule: createSuppressionRule('OR', [
                    { key: '$host', value: '(\\.|^)posthog\\.com$', operator: 'not_regex', type: 'event_property' },
                ]),
                properties: { $exception_list: [{ type: 'TypeError', value: 'This is a type error' }] },
            },
            {
                name: 'captures the exception when a rule uses values that are not an array',
                rule: { type: 'AND', values: null },
                properties: { $exception_list: [{ type: 'TypeError', value: 'This is a type error' }] },
            },
            {
                name: 'captures an exception if there are no targets on the rule',
                rule: createSuppressionRule('OR', [
                    { key: '$exception_types', value: [], operator: 'exact', type: 'error_tracking_issue_property' },
                ]),
                properties: { $exception_list: [{ type: 'TypeError', value: 'This is a type error' }] },
            },
        ]
        for (const { name, rule, properties } of capturedCases) {
            test(name, () => {
                exceptions.onRemoteConfig({ errorTracking: { suppressionRules: [rule] } })
                exceptions.sendExceptionEvent(properties)
                assert.equal(captureMock.mock.callCount(), 1)
            })
        }

        describe('Extension exceptions', () => {
            const masked = (fn, inApp) => ({
                filename: 'webkit-masked-url://hidden/',
                function: fn,
                platform: 'javascript:web',
                in_app: inApp,
            })
            const raw = (frames) => ({ frames, type: 'raw' })
            const uBOLValue = "undefined is not an object (evaluating 'isolatedAPI.contexts.topHostname')"

            // [name, exception, enableExtensionCapture, captured]
            const cases = [
                ...[
                    ['chrome', 'chrome-extension://abc/content.js'],
                    ['firefox', 'moz-extension://abc/content.js'],
                    ['safari', 'safari-extension:abc/content.js'],
                    ['safari web', 'safari-web-extension:abc/content.js'],
                ].map(([browser, filename]) => [
                    `does not capture exceptions with frames from ${browser} extensions by default`,
                    { stacktrace: raw([{ filename, platform: 'javascript:web' }]) },
                    false,
                    false,
                ]),
                [
                    'captures exceptions from the page even when a filename merely mentions an extension',
                    { stacktrace: raw([{ filename: 'https://example.com/moz-extension://not-really.js', platform: 'javascript:web' }]) },
                    false,
                    true,
                ],
                [
                    'captures extension exceptions when enabled',
                    { stacktrace: raw([{ filename: 'chrome-extension://', platform: 'javascript:web' }]) },
                    true,
                    true,
                ],
                [
                    'does not capture Safari extension exceptions with only masked frames',
                    { type: 'TypeError', value: uBOLValue, stacktrace: raw([masked('global code', false), masked('uBOL_cssSpecific', false)]) },
                    false,
                    false,
                ],
                ...[
                    ['NoResponse', 'No response from target'],
                    ['NoResponse', ''],
                    ['Error', 'No response from target'],
                ].map(([type, value]) => [
                    `does not capture masked Safari extension messaging failures: ${type} / ${value}`,
                    { type, value, stacktrace: raw([masked('global code', true)]) },
                    false,
                    false,
                ]),
                [
                    'captures ambiguous masked-only application exceptions',
                    { type: 'Error', value: 'application failure', stacktrace: raw([masked('applicationEval', false)]) },
                    false,
                    true,
                ],
                [
                    'does not capture Safari extension exceptions with only masked frames marked in_app',
                    { type: 'TypeError', value: uBOLValue, stacktrace: raw([masked('global code', true), masked('uBOL_cssSpecific', true)]) },
                    false,
                    false,
                ],
                ...[
                    ['TypeError', 'first-party error'],
                    ['NoResponse', 'No response from target'],
                ].map(([type, value]) => [
                    `captures mixed masked and page frames: ${type} / ${value}`,
                    {
                        type,
                        value,
                        stacktrace: raw([
                            { filename: 'webkit-masked-url://hidden/', platform: 'javascript:web', in_app: false },
                            { filename: 'https://example.com/app.js', platform: 'javascript:web', in_app: true },
                        ]),
                    },
                    false,
                    true,
                ]),
                [
                    'captures Safari extension exceptions when enabled',
                    {
                        type: 'NoResponse',
                        value: 'No response from target',
                        stacktrace: raw([{ filename: 'webkit-masked-url://hidden/', platform: 'javascript:web', in_app: false }]),
                    },
                    true,
                    true,
                ],
            ]
            for (const [name, exception, enableExtensionCapture, captured] of cases) {
                test(name, () => {
                    if (enableExtensionCapture) exceptions.onRemoteConfig({ errorTracking: { captureExtensionExceptions: true } })
                    exceptions.sendExceptionEvent({ $exception_list: [exception] })
                    if (captured) assertCapturedWith({ $exception_list: [exception] })
                    else assertNotCaptured()
                })
            }

            for (const [type, value] of [
                ['ReferenceError', "Can't find variable: handleNoResponse"],
                ['Error', 'No response from target server after 30 seconds'],
            ]) {
                test(`captures masked application errors that only mention a messaging signature: ${type} / ${value}`, () => {
                    const error = new Error(value)
                    error.name = type
                    error.stack = 'applicationEval@webkit-masked-url://hidden/:1:1'
                    const properties = exceptions.buildProperties(error)
                    assertMatch(properties.$exception_list[0], {
                        type,
                        value,
                        stacktrace: { frames: [{ filename: 'webkit-masked-url://hidden/' }] },
                    })
                    exceptions.sendExceptionEvent(properties)
                    assert.equal(captureMock.mock.callCount(), 1)
                    assert.equal(calls()[0][1], properties)
                })
            }
        })

        describe('Injected browser script exceptions', () => {
            const pageFrame = { filename: 'https://example.com/project/566302/sessions/index.js', platform: 'javascript:web' }
            const raw = { frames: [pageFrame], type: 'raw' }

            for (const [browser, fields] of [
                ['Firefox for iOS', { type: 'ReferenceError', value: "Can't find variable: __firefox__" }],
                ['Chrome for iOS', { type: 'TypeError', value: "undefined is not an object (evaluating 'window.__gCrWeb.something')" }],
            ]) {
                test(`does not capture exceptions thrown by ${browser} injected scripts`, () => {
                    exceptions.sendExceptionEvent({ $exception_list: [{ ...fields, stacktrace: raw }] })
                    assertNotCaptured()
                })
            }

            test('captures the exception when the value does not reference an injected global', () => {
                const exception = { type: 'ReferenceError', value: 'something is not defined', stacktrace: raw }
                exceptions.sendExceptionEvent({ $exception_list: [exception] })
                assertCapturedWith({ $exception_list: [exception] })
            })

            test('captures injected browser script exceptions when extension capture is enabled', () => {
                exceptions.onRemoteConfig({ errorTracking: { captureExtensionExceptions: true } })
                const exception = { type: 'ReferenceError', value: "Can't find variable: __firefox__", stacktrace: raw }
                exceptions.sendExceptionEvent({ $exception_list: [exception] })
                assertCapturedWith({ $exception_list: [exception] })
            })
        })

        describe('PostHog SDK exceptions', () => {
            const inAppFrame = { filename: '../src/in-app-file.js', platform: 'javascript:web' }
            const posthogFrame = { filename: 'https://internal-t.posthog.com/static/array.js', platform: 'javascript:web' }

            test('does not capture exceptions thrown by the PostHog SDK', () => {
                exceptions.sendExceptionEvent({ $exception_list: [{ stacktrace: { frames: [inAppFrame, posthogFrame], type: 'raw' } }] })
                assertNotCaptured()
            })

            test('captures the exception if a frame from the PostHog SDK is not the kaboom frame', () => {
                const exception = { stacktrace: { frames: [posthogFrame, inAppFrame], type: 'raw' } }
                exceptions.sendExceptionEvent({ $exception_list: [exception] })
                assertCapturedWith({ $exception_list: [exception] })
            })

            test('captures exceptions thrown within the PostHog SDK when enabled', () => {
                posthog.config.error_tracking.__capturePostHogExceptions = true
                const exception = { stacktrace: { frames: [inAppFrame, posthogFrame], type: 'raw' } }
                exceptions.sendExceptionEvent({ $exception_list: [exception] })
                assertCapturedWith({ $exception_list: [exception] })
            })
        })
    })

    describe('exception steps', () => {
        test('attaches buffered exception steps to the next exception and clears after capture', () => {
            exceptions.addExceptionStep('step one', { context: 'A' })
            exceptions.sendExceptionEvent({ custom_property: true })
            exceptions.sendExceptionEvent({ custom_property: true })
            assertMatch(calls()[0][1], {
                custom_property: true,
                $exception_steps: [{ $message: 'step one', context: 'A', $timestamp: anyString() }],
            })
            assert.deepEqual(calls()[1][1], { custom_property: true })
        })

        test('fails gracefully with a warning when buffering a step throws', () => {
            exceptions.stepsBuffer_ = {
                add: () => {
                    throw new Error('buffer add failed')
                },
            }
            assert.doesNotThrow(() => exceptions.addExceptionStep('step one'))
        })

        test('captures without steps when reading buffered steps throws', () => {
            exceptions.stepsBuffer_ = {
                getAttachable: () => {
                    throw new Error('buffer read failed')
                },
                clear: () => {},
            }
            assert.doesNotThrow(() => exceptions.sendExceptionEvent({ custom_property: true }))
            assertCapturedWith({ custom_property: true })
        })

        test('lets manually provided $exception_steps override buffered steps', () => {
            exceptions.addExceptionStep('buffered step')
            const manualSteps = [{ $message: 'manual', $timestamp: '2026-01-01T00:00:00.000Z' }]
            exceptions.sendExceptionEvent({ custom_property: true, $exception_steps: manualSteps })
            assertCapturedWith({ custom_property: true, $exception_steps: manualSteps })
        })

        test('keeps buffered steps when the exception is dropped before capture', () => {
            exceptions.addExceptionStep('kept step')
            exceptions.onRemoteConfig({ errorTracking: { suppressionRules: [createSuppressionRule('OR')] } })
            exceptions.sendExceptionEvent({ $exception_list: [{ type: 'TypeError', value: 'This is a type error' }] })
            assertNotCaptured()
            exceptions.onRemoteConfig({ errorTracking: { suppressionRules: [] } })
            exceptions.sendExceptionEvent({ custom_property: true })
            assert.equal(captureMock.mock.callCount(), 1)
            assertMatch(calls()[0][1], {
                custom_property: true,
                $exception_steps: [
                    { $message: 'kept step', $timestamp: anyString() },
                    { $message: 'Exception dropped: matched a suppression rule', $timestamp: anyString() },
                ],
            })
            assert.deepEqual(Object.keys(calls()[0][1]).sort(), ['$exception_steps', 'custom_property'])
        })

        test('respects max_bytes by evicting oldest steps on add', () => {
            posthog.config.error_tracking = { exception_steps: { max_bytes: 80 } }
            exceptions = new PostHogExceptions(posthog)
            exceptions.addExceptionStep('first')
            exceptions.addExceptionStep('second')
            exceptions.sendExceptionEvent({ custom_property: true })
            assertMatch(calls()[0][1], {
                custom_property: true,
                $exception_steps: [{ $message: 'second', $timestamp: anyString() }],
            })
        })

        test('disables add and attach when exception_steps.enabled is false', () => {
            posthog.config.error_tracking = { exception_steps: { enabled: false } }
            exceptions = new PostHogExceptions(posthog)
            exceptions.addExceptionStep('ignored')
            exceptions.sendExceptionEvent({ custom_property: true })
            assertCapturedWith({ custom_property: true })
        })

        test('drops reserved keys from addExceptionStep properties', () => {
            mock.timers.enable({ apis: ['Date'], now: new Date('2024-06-18T16:34:36.965Z').getTime() })
            exceptions.addExceptionStep('from-message-arg', { $message: 'ignored', $timestamp: 'ignored', custom_property: true })
            exceptions.sendExceptionEvent({ custom_property: true })
            assertMatch(calls()[0][1], {
                custom_property: true,
                $exception_steps: [{ $message: 'from-message-arg', custom_property: true, $timestamp: '2024-06-18T16:34:36.965Z' }],
            })
        })
    })
})

// ===========================================================================
// browser/src/__tests__/extensions/exception-autocapture/error-wrapping-functions.test.ts
// `window` is the bare object installed at the top of this file.
const realConsoleError = console.error

describe('error wrapping functions', () => {
    let captureFn
    const errorWithThrowingMessage = () => {
        const error = new Error('boom')
        Object.defineProperty(error, 'message', {
            get() {
                throw new TypeError('property building failed')
            },
        })
        return error
    }
    // Firefox throws on every read and call that touches a handler from another compartment.
    const unreachableHandler = () =>
        new Proxy(function () {}, {
            get() {
                throw new TypeError("can't access dead object")
            },
            apply() {
                throw new TypeError("can't access dead object")
            },
        })
    const throwingOnce = () =>
        captureFn.mock.mockImplementationOnce(() => {
            throw new TypeError('capture failed')
        })

    let unwrap
    beforeEach(() => {
        captureFn = mock.fn()
        unwrap = undefined
    })
    afterEach(() => {
        unwrap?.()
        console.error = realConsoleError
    })

    describe('wrapOnError', () => {
        test('does not throw when window.onerror is a non-callable value', () => {
            win.onerror = 'not a function'
            unwrap = wrapOnError(captureFn)
            assert.doesNotThrow(() => win.onerror('message', 'source', 1, 1, new Error('boom')))
            assert.equal(win.onerror('message', 'source', 1, 1, new Error('boom')), false)
            assert.ok(captureFn.mock.callCount() > 0)
        })

        test('still chains to a callable original handler', () => {
            const original = mock.fn(() => true)
            win.onerror = original
            unwrap = wrapOnError(captureFn)
            const result = win.onerror('message', 'source', 1, 1, new Error('boom'))
            const args = original.mock.calls[0].arguments
            assert.deepEqual(args.slice(0, 4), ['message', 'source', 1, 1])
            assert.ok(args[4] instanceof Error)
            assert.equal(result, true)
            assert.ok(captureFn.mock.callCount() > 0)
        })

        test('still chains to the original handler when building exception properties throws', () => {
            const original = mock.fn(() => true)
            const error = errorWithThrowingMessage()
            win.onerror = original
            unwrap = wrapOnError(captureFn)
            assert.doesNotThrow(() => win.onerror('message', 'source', 1, 1, error))
            assert.equal(original.mock.callCount(), 1)
            assert.equal(original.mock.calls[0].arguments[4], error)
            assert.equal(captureFn.mock.callCount(), 0)
        })

        test('still chains to the original handler when the capture callback throws', () => {
            const original = mock.fn(() => true)
            throwingOnce()
            win.onerror = original
            unwrap = wrapOnError(captureFn)
            assert.doesNotThrow(() => win.onerror('message', 'source', 1, 1, new Error('boom')))
            assert.equal(original.mock.callCount(), 1)
        })

        test('does not swallow errors from the original handler', () => {
            const error = new TypeError('original handler failed')
            win.onerror = () => {
                throw error
            }
            unwrap = wrapOnError(captureFn)
            assert.throws(() => win.onerror('message', 'source', 1, 1, new Error('boom')), (e) => e === error)
        })

        test('skips an unreachable original handler instead of throwing', () => {
            win.onerror = unreachableHandler()
            unwrap = wrapOnError(captureFn)
            assert.equal(win.onerror('message', 'source', 1, 1, new Error('boom')), false)
            assert.ok(captureFn.mock.callCount() > 0)
        })

        test('does not throw when reading the handler property throws', () => {
            Object.defineProperty(win, 'onerror', {
                configurable: true,
                get() {
                    throw new TypeError("can't access dead object")
                },
                set() {},
            })
            assert.doesNotThrow(() => {
                unwrap = wrapOnError(captureFn)
            })
            assert.doesNotThrow(() => unwrap())
            unwrap = undefined
            delete win.onerror
        })

        test('restores the original handler when the instrumentation marker cannot be deleted', () => {
            const original = mock.fn(() => true)
            win.onerror = original
            unwrap = wrapOnError(captureFn)
            Object.freeze(win.onerror)
            assert.doesNotThrow(() => unwrap())
            assert.equal(win.onerror, original)
        })

        // jsdom provides ErrorEvent; a branded stand-in is installed for this test only.
        test('collects source/lineno/colno from the positional args when there is no Error object', () => {
            globalThis.ErrorEvent = FakeErrorEvent
            try {
                win.onerror = null
                unwrap = wrapOnError(captureFn)
                win.onerror('Uncaught TypeError: x is not a function', 'https://example.com/app.js', 42, 13, undefined)
                assert.equal(captureFn.mock.callCount(), 1)
                const exception = captureFn.mock.calls[0].arguments[0].$exception_list[0]
                assert.equal(exception.type, 'TypeError')
                assert.equal(exception.value, 'x is not a function')
                assertMatch(exception.stacktrace?.frames?.[0], { filename: 'https://example.com/app.js', lineno: 42, colno: 13 })
            } finally {
                delete globalThis.ErrorEvent
            }
        })
    })

    describe('wrapUnhandledRejection', () => {
        test('does not throw when window.onunhandledrejection is a non-callable value', () => {
            win.onunhandledrejection = 'not a function'
            unwrap = wrapUnhandledRejection(captureFn)
            const ev = { reason: new Error('boom') }
            assert.doesNotThrow(() => win.onunhandledrejection(ev))
            assert.equal(win.onunhandledrejection(ev), false)
            assert.ok(captureFn.mock.callCount() > 0)
        })

        test('still chains to a callable original handler', () => {
            const original = mock.fn(() => true)
            win.onunhandledrejection = original
            unwrap = wrapUnhandledRejection(captureFn)
            const ev = { reason: new Error('boom') }
            const result = win.onunhandledrejection(ev)
            assert.deepEqual(original.mock.calls[0].arguments, [ev])
            assert.equal(result, true)
            assert.ok(captureFn.mock.callCount() > 0)
        })

        test('still chains to the original handler when building exception properties throws', () => {
            const original = mock.fn(() => true)
            const ev = { reason: errorWithThrowingMessage() }
            win.onunhandledrejection = original
            unwrap = wrapUnhandledRejection(captureFn)
            assert.doesNotThrow(() => win.onunhandledrejection(ev))
            assert.equal(original.mock.callCount(), 1)
            assert.equal(original.mock.calls[0].arguments[0], ev)
            assert.equal(captureFn.mock.callCount(), 0)
        })

        test('still chains to the original handler when the capture callback throws', () => {
            const original = mock.fn(() => true)
            throwingOnce()
            win.onunhandledrejection = original
            unwrap = wrapUnhandledRejection(captureFn)
            assert.doesNotThrow(() => win.onunhandledrejection({ reason: new Error('boom') }))
            assert.equal(original.mock.callCount(), 1)
        })

        test('skips an unreachable original handler instead of throwing', () => {
            win.onunhandledrejection = unreachableHandler()
            unwrap = wrapUnhandledRejection(captureFn, true)
            assert.equal(win.onunhandledrejection({ reason: new Error('boom') }), true)
            assert.ok(captureFn.mock.callCount() > 0)
        })

        test('does not swallow errors from the original handler', () => {
            const error = new TypeError('original handler failed')
            win.onunhandledrejection = () => {
                throw error
            }
            unwrap = wrapUnhandledRejection(captureFn)
            assert.throws(() => win.onunhandledrejection({ reason: new Error('boom') }), (e) => e === error)
        })
    })

    describe('wrapConsoleError', () => {
        test('does not throw when console.error is a non-callable value', () => {
            console.error = 'not a function'
            unwrap = wrapConsoleError(captureFn)
            assert.doesNotThrow(() => console.error('boom'))
            assert.ok(captureFn.mock.callCount() > 0)
        })

        test('still chains to a callable original handler', () => {
            const original = mock.fn()
            console.error = original
            unwrap = wrapConsoleError(captureFn)
            console.error('boom')
            assert.deepEqual(original.mock.calls[0].arguments, ['boom'])
            assert.ok(captureFn.mock.callCount() > 0)
        })

        for (const { args, value, synthetic } of [
            { args: ['console message'], value: 'console message', synthetic: true },
            { args: ['console message', 42, 'details'], value: 'console message 42 details', synthetic: true },
            { args: [new Error('logged error')], value: 'logged error', synthetic: false },
            { args: ['context', new Error('logged error'), 42], value: 'logged error', synthetic: false },
        ]) {
            test(`captures ${value} (${args.length} args) as handled with console provenance`, () => {
                const original = mock.fn()
                console.error = original
                unwrap = wrapConsoleError(captureFn)
                console.error(...args)
                assert.equal(original.mock.callCount(), 1)
                assert.deepEqual(original.mock.calls[0].arguments, args)
                assert.equal(captureFn.mock.callCount(), 1)
                assertMatch(captureFn.mock.calls[0].arguments[0].$exception_list, [
                    objectContaining({
                        type: 'Error',
                        value,
                        mechanism: { handled: true, type: 'onconsole', synthetic, exception_id: 0 },
                        stacktrace: { type: 'raw', frames: anyArray() },
                    }),
                ])
                assert.deepEqual(captureFn.mock.calls[0].arguments[0].$exception_list[0].mechanism, {
                    handled: true,
                    type: 'onconsole',
                    synthetic,
                    exception_id: 0,
                })
            })
        }

        test('still calls the original console when building exception properties throws', () => {
            const original = mock.fn()
            const error = errorWithThrowingMessage()
            console.error = original
            unwrap = wrapConsoleError(captureFn)
            assert.doesNotThrow(() => console.error(error))
            assert.equal(original.mock.callCount(), 1)
            assert.equal(original.mock.calls[0].arguments[0], error)
            assert.equal(captureFn.mock.callCount(), 0)
        })

        test('still calls the original console when the capture callback throws', () => {
            const original = mock.fn()
            throwingOnce()
            console.error = original
            unwrap = wrapConsoleError(captureFn)
            assert.doesNotThrow(() => console.error('boom'))
            assert.equal(original.mock.callCount(), 1)
        })

        test('skips an unreachable original console instead of throwing', () => {
            console.error = unreachableHandler()
            unwrap = wrapConsoleError(captureFn)
            assert.doesNotThrow(() => console.error('boom'))
            assert.ok(captureFn.mock.callCount() > 0)
        })

        test('does not swallow errors from the original console', () => {
            const error = new TypeError('original console failed')
            console.error = () => {
                throw error
            }
            unwrap = wrapConsoleError(captureFn)
            assert.throws(() => console.error('boom'), (e) => e === error)
        })
    })
})

// ===========================================================================
// browser/src/__tests__/extensions/exception-autocapture/internal-console-errors.test.ts
// Only the cases that exercise wrapConsoleError directly; the ones that go
// through the SDK logger, the rrweb console plugin or the logs extension are
// skipped.
describe('internal console diagnostics', () => {
    let capture
    let original
    let restore
    beforeEach(() => {
        capture = mock.fn()
        original = mock.fn()
        console.error = original
        restore = []
    })
    afterEach(() => {
        restore.reverse().forEach((stop) => stop())
        console.error = realConsoleError
    })

    for (const prefix of ['[PostHog.js]', '[PostHog.js] [Legacy extension]', 'rrweb logger error:']) {
        test(`recognizes diagnostics from separately loaded bundles: ${prefix}`, () => {
            restore.push(wrapConsoleError(capture))
            const error = new Error('internal failure')
            console.error(prefix, error)
            assert.equal(capture.mock.callCount(), 0)
            assert.deepEqual(original.mock.calls[0].arguments, [prefix, error])
        })
    }

    for (const args of [
        ['[PostHog.js]'],
        ['[PostHog.js] customer message'],
        ['[PostHog.js] [Surveys]'],
        ['[PostHog.js] [Surveys] customer message'],
        ['rrweb logger error:'],
        ['[PostHog.js-extra] customer message'],
        ['[PostHogXjs] customer message'],
        ['customer message mentioning [PostHog.js]'],
        ['customer message', '[PostHog.js]'],
        [new Error('[PostHog.js] customer-created error')],
        [new Error('rrweb logger error: customer-created error')],
        ['rrweb logger error: customer text'],
        [],
    ]) {
        test(`keeps application console errors (${inspect(args)})`, () => {
            restore.push(wrapConsoleError(capture))
            console.error(...args)
            assert.equal(capture.mock.callCount(), 1)
            assert.deepEqual(original.mock.calls[0].arguments, args)
        })
    }

    test('preserves console forwarding when diagnostic classification encounters a throwing getter', () => {
        restore.push(wrapConsoleError(capture))
        const argument = Object.defineProperty({}, Symbol.toStringTag, {
            get() {
                throw new Error('unreachable argument')
            },
        })
        assert.doesNotThrow(() => console.error(argument))
        assert.equal(original.mock.callCount(), 1)
        assert.ok(original.mock.calls[0].arguments[0] === argument)
    })
})

// ===========================================================================
// browser/src/__tests__/extensions/exception-autocapture/exception-observer.test.ts
// With a stub PostHog (capture() is recorded instead of going through
// before_send and the request queue). Skipped: 'does not call
// loadExternalDependency if script is already loaded' (no lazy loading here),
// 'sends captured events to the right URL' (needs the real request path) and
// the posthog.captureException tail of the console provenance test.
describe('Exception Observer', () => {
    let posthog
    let observer
    const captured = () => posthog.capture.mock.calls.map((c) => c.arguments)
    const instrumented = (fn) => fn?.__POSTHOG_INSTRUMENTED__
    const expectNoHandlers = () => {
        assert.equal(instrumented(console.error), undefined)
        assert.equal(instrumented(win.onerror), undefined)
        assert.equal(instrumented(win.onunhandledrejection), undefined)
    }

    beforeEach(() => {
        delete win.onerror
        delete win.onunhandledrejection
        posthog = createFakePostHog()
        posthog.extensions.exceptions = new PostHogExceptions(posthog)
        observer = new ExceptionObserver(posthog)
    })
    afterEach(() => {
        observer.stopCapturing_()
        console.error = realConsoleError
        delete win.onerror
        delete win.onunhandledrejection
    })

    describe('when enabled remotely', () => {
        beforeEach(() => observer.onRemoteConfig({ autocaptureExceptions: true }))

        test('should instrument enabled handlers only when started', () => {
            assert.equal(observer.enabled_(), true)
            assert.equal(instrumented(console.error), undefined)
            assert.equal(instrumented(win.onerror), true)
            assert.equal(instrumented(win.onunhandledrejection), true)
        })

        test('should remove instrument handlers when stopped', () => {
            observer.stopCapturing_()
            expectNoHandlers()
        })

        test('captures an event when an error is thrown', () => {
            win.onerror.call(win, 'message', 'source', 0, 0, new Error('test error'))
            assert.equal(captured().length, 1)
            const [event, properties] = captured()[0]
            assert.equal(event, '$exception')
            assertMatch(properties, {
                $exception_list: [
                    {
                        type: 'Error',
                        value: 'test error',
                        stacktrace: { frames: anyArray() },
                        mechanism: { synthetic: false, handled: false },
                    },
                ],
            })
        })

        // Adapted: no own `isTrusted` key under Node.
        test('captures an event when an unhandled rejection occurs', () => {
            const promiseRejectionEvent = new PromiseRejectionEvent('unhandledrejection', {
                promise: Promise.resolve(),
                reason: new Error('test error'),
            })
            win.onunhandledrejection.call(win, promiseRejectionEvent)
            assert.equal(captured().length, 1)
            assertMatch(captured()[0][1], {
                $exception_list: [
                    {
                        type: 'PromiseRejectionEvent',
                        value: 'PromiseRejectionEvent captured as exception with keys: promise, reason',
                        mechanism: { synthetic: true, handled: false },
                    },
                ],
            })
        })

        test('does not start if disabled locally', () => {
            observer.stopCapturing_()
            expectNoHandlers()
            posthog.config.capture_exceptions = false
            observer = new ExceptionObserver(posthog)
            observer.startIfEnabledOrStop()
            assert.equal(observer.enabled_(), false)
            expectNoHandlers()
        })
    })

    describe('when console error capturing is enabled', () => {
        test('captures an event when console.error is called', () => {
            console.error = mock.fn()
            posthog.config.capture_exceptions = {
                capture_console_errors: true,
                capture_unhandled_errors: false,
                capture_unhandled_rejections: false,
            }
            const consoleObserver = new ExceptionObserver(posthog)
            console.error('console error test')
            consoleObserver.stopCapturing_()
            const call = captured().find((c) => c[1]?.$exception_list?.[0]?.value === 'console error test')
            assert.ok(call)
            assertMatch(call[1], {
                $exception_list: [
                    {
                        type: 'Error',
                        value: 'console error test',
                        stacktrace: { frames: anyArray() },
                        mechanism: { handled: true, type: 'onconsole', synthetic: true },
                    },
                ],
            })
        })
    })

    test('preserves console provenance through reinstalls and stops capturing when disabled', () => {
        const nativeConsoleError = mock.fn()
        console.error = nativeConsoleError
        posthog.config.capture_exceptions = { capture_console_errors: true }
        observer.onConfigChange(posthog.config)
        for (let i = 0; i < 3; i++) {
            observer.startIfEnabledOrStop()
            try {
                throw new Error(`caught error ${i}`)
            } catch (error) {
                console.error('caught', error)
            }
        }
        assert.equal(nativeConsoleError.mock.callCount(), 3)
        assert.equal(captured().length, 3)
        for (const [, properties] of captured()) {
            assert.deepEqual(properties.$exception_list[0].mechanism, {
                exception_id: 0,
                handled: true,
                type: 'onconsole',
                synthetic: false,
            })
        }
        posthog.config.capture_exceptions = false
        observer.onConfigChange(posthog.config)
        observer.startIfEnabledOrStop()
        assert.equal(console.error, nativeConsoleError)
        console.error('disabled console capture')
        assert.equal(nativeConsoleError.mock.callCount(), 4)
        assert.equal(captured().length, 3)
    })

    describe('when there are handlers already present', () => {
        let originalOnError
        let originalOnUnhandledRejection
        beforeEach(() => {
            originalOnError = mock.fn()
            originalOnUnhandledRejection = mock.fn()
            win.onerror = originalOnError
            win.onunhandledrejection = originalOnUnhandledRejection
            observer.onRemoteConfig({ autocaptureExceptions: true })
        })

        test('should wrap original onerror handler if one was present when wrapped', () => {
            assert.ok(win.onerror)
            assert.notEqual(win.onerror, originalOnError)
        })

        test('should wrap original onunhandledrejection handler if one was present when wrapped', () => {
            assert.ok(win.onunhandledrejection)
            assert.notEqual(win.onunhandledrejection, originalOnUnhandledRejection)
        })

        test('should call original onerror handler if one was present when wrapped', () => {
            const error = new Error('test error')
            win.onerror.call(win, 'message', 'source', 0, 0, error)
            assert.deepEqual(originalOnError.mock.calls[0].arguments, ['message', 'source', 0, 0, error])
        })

        test('should call original onunhandledrejection handler if one was present when wrapped', () => {
            const promiseRejectionEvent = new PromiseRejectionEvent('unhandledrejection', {
                promise: Promise.resolve(),
                reason: new Error('test error'),
            })
            win.onunhandledrejection.call(win, promiseRejectionEvent)
            assert.deepEqual(originalOnUnhandledRejection.mock.calls[0].arguments, [promiseRejectionEvent])
        })

        test('should reinstate original onerror handler if one was present when wrapped', () => {
            observer.stopCapturing_()
            assert.equal(win.onerror, originalOnError)
        })

        test('should reinstate original onunhandledrejection handler if one was present when wrapped', () => {
            observer.stopCapturing_()
            assert.equal(win.onunhandledrejection, originalOnUnhandledRejection)
        })
    })

    for (const [name, response] of [
        ['when no flags response', undefined],
        ['when disabled', { autocaptureExceptions: false }],
    ]) {
        describe(name, () => {
            beforeEach(() => response && observer.onRemoteConfig(response))
            test('cannot be started', () => {
                assert.equal(observer.enabled_(), false)
                expectNoHandlers()
                observer.startCapturing_()
                expectNoHandlers()
            })
        })
    }
})

