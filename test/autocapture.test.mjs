// Unit tests for the DOM-free parts of autocapture: the $elements_chain
// format, value scrubbing and rage click detection. Expected values follow
// upstream posthog-js 1.450.0 (autocapture-utils.test.ts, rageclick.test.ts).
// Run: node --test test/autocapture.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    getElementsChainString, makeSafeText, shouldCaptureValue, splitClassString, isAngularStyleAttr,
} from '../src/dom/autocapture-utils.js'
import { RageClick, DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS } from '../src/core/rageclick.js'
import { defaultsThatVaryByConfig } from '../src/core/posthog.js'

test('elements chain: tag, sorted classes, sorted attributes, escaping', () => {
    const chain = getElementsChainString([
        {
            tag_name: 'a', $el_text: 'Sign "up"', attr__href: '/signup', attr__class: 'b a', attr__id: 'cta',
            'attr__data-x': 'y', nth_child: 2, nth_of_type: 1, classes: ['b', 'a'],
        },
        { tag_name: 'div', nth_child: 1, nth_of_type: 1 },
        { tag_name: 'body', attr__class: ['z', 'y"q'] },
    ])
    assert.equal(chain,
        'a.a.b:attr__class="b a"attr__data-x="y"attr__href="/signup"attr__id="cta"attr_id="cta"href="/signup"' +
        'nth-child="2"nth-of-type="1"text="Sign \\"up\\"";' +
        'div:nth-child="1"nth-of-type="1";' +
        'body.yq.z:attr__class="y\\"q,z"nth-child="0"nth-of-type="0"')
})

test('elements chain: text and href are truncated, non-arrays give ""', () => {
    const chain = getElementsChainString([{ tag_name: 'a', $el_text: 'x'.repeat(500), attr__href: 'h'.repeat(3000) }])
    assert.ok(chain.includes(`text="${'x'.repeat(400)}"`))
    assert.ok(chain.includes(`href="${'h'.repeat(2048)}"`))
    assert.ok(chain.includes(`attr__href="${'h'.repeat(3000)}"`))
    assert.equal(getElementsChainString(null), '')
    assert.equal(getElementsChainString([]), '')
})

test('shouldCaptureValue scrubs credit cards and SSNs', () => {
    assert.equal(shouldCaptureValue('4111111111111111'), false)
    assert.equal(shouldCaptureValue('4111-1111-1111-1111'), false)
    assert.equal(shouldCaptureValue('123-45-6789'), false)
    assert.equal(shouldCaptureValue('hello'), true)
    assert.equal(shouldCaptureValue(null), false)
    assert.equal(shouldCaptureValue('card 4111 1111 1111 1111 here', false), false)
    assert.equal(shouldCaptureValue('id a123-45-6789b', false), true)
})

test('makeSafeText drops sensitive words, normalises whitespace and truncates', () => {
    assert.equal(makeSafeText('  pay\n 4111111111111111  now '), 'pay now')
    assert.equal(makeSafeText(undefined), null)
    assert.equal(makeSafeText('y'.repeat(300)).length, 255)
})

test('class strings and angular attributes', () => {
    assert.deepEqual(splitClassString('  a \n b  '), ['a', 'b'])
    assert.deepEqual(splitClassString(''), [])
    assert.equal(isAngularStyleAttr('_ngcontent-c1'), true)
    assert.equal(isAngularStyleAttr('_nghost-c1'), true)
    assert.equal(isAngularStyleAttr('data-x'), false)
})

test('RageClick: 3 clicks within 30px and 1s', () => {
    const r = new RageClick(true)
    assert.equal(r.isRageClick(10, 10, 1000), false)
    assert.equal(r.isRageClick(15, 15, 1500), false)
    assert.equal(r.isRageClick(20, 12, 2000), true)
    assert.equal(r.isRageClick(20, 12, 2100), false) // 4th click: no second rageclick
    const far = new RageClick(true)
    far.isRageClick(0, 0, 0)
    far.isRageClick(40, 0, 10)
    assert.equal(far.isRageClick(40, 0, 20), false)
    assert.equal(new RageClick(false).isRageClick(0, 0, 0), false)
    const custom = new RageClick({ click_count: 2, threshold_px: 5, timeout_ms: 100 })
    custom.isRageClick(0, 0, 0)
    assert.equal(custom.isRageClick(2, 2, 50), true)
})

test('rageclick defaults depend on the defaults date', () => {
    assert.equal(defaultsThatVaryByConfig(undefined).rageclick, true)
    assert.deepEqual(defaultsThatVaryByConfig('2025-11-30').rageclick, { content_ignorelist: true })
    assert.deepEqual(defaultsThatVaryByConfig('2026-05-30').rageclick,
        { content_ignorelist: DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS, ignore_text_selection: true })
    assert.deepEqual(DEFAULT_CONTENT_IGNORELIST_WITH_STEPPERS,
        ['next', 'previous', 'prev', '>', '<', '→', '←', '›', '‹', '»', '«', '▶', '◀', '❯', '❮', '+', '-', '−', '–'])
})
