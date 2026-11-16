// User journeys for the session benchmark. Each journey is an async function of a
// `Human` (test/bench/human.mjs); all choices come from its seeded PRNG.
import { BudgetSpent } from './human.mjs'

/** Runs `next()`-chosen journeys until the human's planned budget is spent (mid-journey). */
async function runUntilSpent(h, next) {
    const ran = []
    try {
        for (let i = 0; ; i++) {
            const [name, fn] = next(i)
            const t = h.clock
            ran.push({ name, startMs: Math.round(t) })
            await fn(h)
        }
    } catch (e) {
        if (!(e instanceof BudgetSpent)) throw e
    }
    return ran
}

/** Clicks a top-nav entry (SPA route change through history.pushState). */
async function go(h, route) {
    await h.click(`#nav a[href="/site/${route}"]`)
    await h.wait(h.r.range(300, 700))
}

/** Landing page: hero, hover menu, scroll through features, then pricing: filters and a model modal. */
async function browse(h) {
    const r = h.r
    await h.click('.logo')
    await h.read(r.range(800, 1500)) // hero
    await h.hover('#hero-cta', { dwell: [200, 500] })
    await h.hover('#resources-menu > button', { dwell: [400, 800] }) // opens the hover menu
    await h.hover('#resources-list a', { n: r.int(0, 5), dwell: [200, 500] })
    await h.moveTo(r.range(200, 1000), r.range(450, 650)) // leave the menu
    await h.scroll(r.range(700, 1000))
    await h.read(r.range(500, 1000))
    await h.hover('.feature', { n: r.int(0, 5), dwell: [200, 500] })
    await go(h, 'pricing')
    await h.click('#billing button[data-billing="yearly"]')
    await h.click('#chips .chip', { n: r.int(1, 5) })
    await h.hover('.card', { n: r.int(0, 3), dwell: [200, 600] })
    if (r.chance(0.5)) {
        await h.click('#sort .dropdown-toggle')
        await h.click('#sort [role=option]', { n: r.int(1, 3) })
    }
    await h.click('.card .details', { n: r.int(0, 2) })
    await h.read(r.range(1000, 1800)) // modal
    await h.click('#modal-close')
    await h.read(r.range(300, 700))
}

/** A few chat turns while answers stream token by token. */
async function chat(h) {
    const r = h.r
    await go(h, 'chat')
    await h.read(r.range(500, 1000))
    if (r.chance(0.5)) {
        await h.click('#model-select .dropdown-toggle')
        await h.click('#model-select [role=option]', { n: r.int(0, 3) })
    }
    const questions = [
        'Stream it in JS?',
        'SQL for p95 latency',
        'Compare embeddings',
        'Shorter please',
        'How do we cache this?',
    ]
    for (let t = 0; t < 2; t++) {
        if (t === 0) {
            await h.click('#new-chat')
            await h.click('.suggestion', { n: r.int(0, 3) })
            await h.key('Enter')
        } else {
            await h.click('#prompt')
            await h.type(r.pick(questions))
            await h.wait(r.range(200, 600))
            if (r.chance(0.5)) await h.key('Enter'); else await h.click('#send')
        }
        // Watch it stream: read, wheel up a bit in the transcript, come back down.
        await h.hover('#transcript', { dwell: [300, 600] })
        await h.read(r.range(1000, 1800))
        await h.wheelBurst(-1, 0.6)
        await h.read(r.range(500, 1000))
        await h.wheelBurst(1, 1.2)
        await h.read(r.range(800, 1500))
        if (r.chance(0.6)) await h.click('#transcript .code .copy', { n: -1 })
    }
    await h.hover('.conv', { n: r.int(1, 10), dwell: [200, 500] })
}

/** Pricing tier → signup form (text, email, password paste, select, radio, textarea, checkboxes). */
async function signup(h) {
    const r = h.r
    await go(h, 'pricing')
    await h.read(r.range(500, 900))
    await h.click('#tier-pro')
    await h.read(r.range(300, 600))
    await h.fill('#su-name', r.pick(['Ada King', 'Grace Hopper', 'Alan Turing']))
    await h.fill('#su-email', r.pick(['ada@lumen.dev', 'grace@acme.io', 'alan@corp.io']))
    await h.click('#su-password')
    await h.paste('Corr3ct-Horse!') // password manager
    await h.key('Tab') // to the company size <select>: arrows change it without a popup
    for (let i = r.int(1, 3); i > 0; i--) { await h.key('ArrowDown'); await h.wait(r.range(100, 250)) }
    await h.click('.radio', { n: r.int(0, 2) })
    await h.fill('#su-usecase', 'Support replies')
    await h.click('#su-terms')
    if (r.chance(0.5)) await h.click('#su-news')
    await h.click('#su-submit')
    await h.read(r.range(1200, 1800))
}

/** Checkout, including the card number, expiry and CVC fields. */
async function checkout(h) {
    const r = h.r
    await go(h, 'pricing')
    await h.click('#tier-team')
    await h.click('#upgrade-now') // returning customer: straight to checkout
    await h.read(r.range(300, 600))
    await h.fill('#co-email', 'ada@lumen.dev')
    await h.click('#co-card')
    await h.type('4242424242424242', { wpm: 40, typos: 0 })
    await h.wait(r.range(300, 700))
    await h.key('Tab') // country select
    await h.key('ArrowDown')
    await h.key('Tab')
    await h.type('1229', { wpm: 35, typos: 0 })
    await h.key('Tab')
    await h.type('123', { wpm: 35, typos: 0 })
    if (r.chance(0.3)) {
        await h.fill('#co-promo', 'LAUNCH20')
        await h.click('#co-apply')
    }
    await h.click('#co-pay')
    await h.read(r.range(1600, 2200))
}

/** Settings: tab switching, toggles, profile edits, API keys. */
async function settings(h) {
    const r = h.r
    await go(h, 'settings')
    await h.read(r.range(400, 800))
    await h.click('#st-name')
    for (let i = 0; i < 8; i++) { await h.key('Backspace'); await h.wait(r.range(50, 110)) }
    await h.type('Countess Ada')
    await h.click('#st-save')
    await h.click('#tab-1')
    for (let i = 0; i < 3; i++) {
        await h.click('.switch input', { n: r.int(0, 9) })
        await h.wait(r.range(200, 500))
    }
    await h.click('#tab-2')
    await h.click('#create-key')
    await h.read(r.range(500, 1000))
    await h.click('#tab-3')
    for (let i = 0; i < 2; i++) await h.hover('#usage-chart i', { n: r.int(0, 29), dwell: [100, 300] })
    await h.click('#tab-4')
    await h.click('.dropdown-toggle', { n: r.int(1, 6) })
    await h.click('.dropdown.open [role=option]', { n: r.int(1, 3) })
    await h.read(r.range(500, 1000))
}

// First-pass order: a 60 s session covers browsing, the card form and a streamed answer.
export const SITE_JOURNEYS = { browse, checkout, chat, signup, settings }

/** Runs the demo site journeys back to back (fixed order first, then seeded picks) until the budget is spent. */
export function siteSession(h) {
    const names = Object.keys(SITE_JOURNEYS)
    return runUntilSpent(h, (i) => {
        const name = i < names.length ? names[i] : h.r.pick(names)
        return [name, SITE_JOURNEYS[name]]
    })
}

/**
 * Generic journey for any site: hovers visible links and buttons, scrolls, clicks a
 * few buttons, and types into the first visible text input. Navigation is prevented
 * by the injected guard (see session.mjs), so the session stays on the page.
 */
export function genericSession(h) {
    const r = h.r
    const targets = `a[href], button, [role=button], input[type=submit]`
    const textInput = `input:not([type]), input[type=text], input[type=search], input[type=email], textarea`
    let typed = false
    return runUntilSpent(h, () => ['generic', async () => {
        await h.read(r.range(800, 2000))
        const first = await h.rect(targets)
        const count = first ? first.count : 0
        for (let i = 0; i < 4 && count; i++) await h.hover(targets, { n: r.int(0, Math.min(count - 1, 40)), dwell: [200, 700] })
        if (count && r.chance(0.5)) {
            // Click a button (not a link): menus, tabs, accordions.
            const btn = await h.rect('button:not([type=submit])')
            if (btn) await h.click('button:not([type=submit])', { n: r.int(0, Math.min(btn.count - 1, 15)) })
        }
        if ((!typed || r.chance(0.3)) && await h.rect(textInput)) {
            await h.click(textInput)
            await h.type(r.pick(['pricing for teams', 'how does it work', 'hello world']))
            typed = true
            await h.key('Escape')
        }
        await h.scroll(r.range(600, 1400))
        await h.read(r.range(1000, 2500))
        if (r.chance(0.3)) await h.scroll(-r.range(300, 900))
    }])
}
