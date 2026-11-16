// Human-like input over CDP (Input.dispatchMouseEvent / dispatchKeyEvent / insertText).
//
// Every decision (paths, delays, typos, pauses) comes from a seeded PRNG, and time
// is a *planned* clock: each action advances `clock` by its planned duration and
// waits until that wall-clock moment. If the page lags (e.g. 4x CPU throttling plus a
// heavy SDK), the next action starts late but the plan doesn't change, so every
// variant replays exactly the same sequence of inputs. Journeys stop on the planned
// clock, not on wall time, for the same reason.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const FRAME = 1000 / 60

export function prng(seed) {
    let a = seed >>> 0
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return {
        next,
        range: (lo, hi) => lo + next() * (hi - lo),
        int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
        pick: (arr) => arr[Math.floor(next() * arr.length)],
        chance: (p) => next() < p,
        // roughly normal (Irwin-Hall), clamped to [mean - 2.5 sd, mean + 2.5 sd]
        normal: (mean, sd) => mean + sd * Math.max(-2.5, Math.min(2.5, (next() + next() + next() + next() - 2) * 1.732)),
    }
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const bezier = (p0, p1, p2, p3, t) => {
    const u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

// Neighbouring keys on a QWERTY keyboard, for realistic typos.
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
function neighbour(ch, r) {
    const lower = ch.toLowerCase()
    for (let y = 0; y < ROWS.length; y++) {
        const x = ROWS[y].indexOf(lower)
        if (x === -1) continue
        const opts = [ROWS[y][x - 1], ROWS[y][x + 1], ROWS[y - 1]?.[x], ROWS[y + 1]?.[x]].filter(Boolean)
        return r.pick(opts)
    }
    return null
}

const KEYS = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

export class BudgetSpent extends Error {}

export class Human {
    /**
     * @param page   test/diff/chrome.mjs page
     * @param seed   PRNG seed (same seed => same session)
     * @param opts   { budgetMs: planned duration after which `done` turns true, viewport: {width, height} }
     */
    constructor(page, seed, { budgetMs = 60000, viewport = { width: 1280, height: 800 } } = {}) {
        this.page = page
        this.r = prng(seed)
        this.budgetMs = budgetMs
        this.vw = viewport.width
        this.vh = viewport.height
        this.x = Math.round(this.vw * 0.5)
        this.y = Math.round(this.vh * 0.3)
        this.clock = 0
        this.t0 = Date.now()
        this.stats = { moves: 0, clicks: 0, keys: 0, wheels: 0, typos: 0, lagMs: 0, missing: [] }
    }

    get done() { return this.clock >= this.budgetMs }

    /**
     * Advances the planned clock by `ms` and waits until that moment (no wait if behind).
     * Throws BudgetSpent once the planned budget is used up, ending the session at the
     * same planned moment (so after the same input) in every variant.
     */
    async wait(ms) {
        if (this.clock >= this.budgetMs) throw new BudgetSpent()
        this.clock += ms
        const late = Date.now() - (this.t0 + this.clock)
        if (late < 0) await sleep(-late)
        else this.stats.lagMs = Math.max(this.stats.lagMs, late)
    }

    cdp(method, params) { return this.page.cdp(method, params) }

    async mouse(type, x, y, extra = {}) {
        this.x = x
        this.y = y
        await this.cdp('Input.dispatchMouseEvent', { type, x, y, ...extra })
    }

    /** Curved, eased mouse path to (tx, ty), sampled at 60 Hz, with an occasional overshoot. */
    async moveTo(tx, ty) {
        const r = this.r
        tx = Math.max(1, Math.min(this.vw - 2, tx))
        ty = Math.max(1, Math.min(this.vh - 2, ty))
        const dx = tx - this.x
        const dy = ty - this.y
        const dist = Math.hypot(dx, dy)
        if (dist < 2) return
        const overshoot = dist > 150 && r.chance(0.35)
        const ex = overshoot ? tx + dx * r.range(0.03, 0.08) + r.normal(0, 4) : tx
        const ey = overshoot ? ty + dy * r.range(0.03, 0.08) + r.normal(0, 4) : ty
        // Fitts-like duration, control points pushed sideways for a curved path.
        const duration = Math.max(100, 100 + 80 * Math.log2(dist / 30 + 1) + r.normal(0, 30))
        const nx = -dy / dist
        const ny = dx / dist
        const bend = r.normal(0, dist * 0.18)
        const sx = this.x
        const sy = this.y
        const c1x = sx + dx * 0.3 + nx * bend
        const c1y = sy + dy * 0.3 + ny * bend
        const c2x = sx + dx * 0.75 + nx * bend * 0.4
        const c2y = sy + dy * 0.75 + ny * bend * 0.4
        const steps = Math.max(2, Math.round(duration / FRAME))
        for (let i = 1; i <= steps; i++) {
            const t = easeInOut(i / steps)
            const jitter = i < steps ? r.normal(0, 0.6) : 0
            await this.mouse('mouseMoved', Math.round(bezier(sx, c1x, c2x, ex, t) + jitter), Math.round(bezier(sy, c1y, c2y, ey, t) + jitter))
            this.stats.moves++
            await this.wait(FRAME)
        }
        if (overshoot) {
            await this.wait(r.range(40, 110))
            const back = Math.max(3, Math.round(r.range(90, 180) / FRAME))
            const bx = this.x
            const by = this.y
            for (let i = 1; i <= back; i++) {
                const t = easeInOut(i / back)
                await this.mouse('mouseMoved', Math.round(bx + (tx - bx) * t), Math.round(by + (ty - by) * t))
                this.stats.moves++
                await this.wait(FRAME)
            }
        }
    }

    /** Bounding box of the n-th visible match (modulo the count; negative from the end), or null. */
    async rect(selector, n = 0) {
        return this.page.evaluate(`(() => {
            const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((e) => {
                const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
            })
            const e = els[((${n} % els.length) + els.length) % els.length] // n < 0 counts from the end
            if (!e) return null
            const r = e.getBoundingClientRect()
            // Nearest scrollable ancestor (wheel events scroll what is under the pointer).
            let s = e.parentElement
            while (s && s !== document.body && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight)) s = s.parentElement
            const c = s && s !== document.body ? s.getBoundingClientRect() : null
            return { x: r.left, y: r.top, w: r.width, h: r.height, count: els.length,
                box: c ? { x: c.left, y: c.top, w: c.width, h: c.height } : null }
        })()`)
    }

    async waitForSelector(selector, timeoutMs = 5000) {
        const end = Date.now() + timeoutMs
        while (Date.now() < end) {
            const r = await this.rect(selector)
            if (r) return r
            await sleep(50)
        }
        return null
    }

    /** One momentum wheel burst: a flick then exponentially decaying deltas at 60 Hz. */
    async wheelBurst(direction, strength = 1) {
        const r = this.r
        let delta = r.range(70, 130) * strength
        const decay = r.range(0.82, 0.9)
        while (delta > 3) {
            await this.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.x, y: this.y, deltaX: 0, deltaY: Math.round(delta) * direction })
            this.stats.wheels++
            await this.wait(FRAME)
            delta *= decay
        }
    }

    /** Scrolls about `dy` pixels (negative = up) in bursts separated by short pauses. */
    async scroll(dy) {
        const r = this.r
        let left = Math.abs(dy)
        const dir = Math.sign(dy) || 1
        while (left > 40) {
            const strength = Math.min(1.6, Math.max(0.5, left / 700))
            await this.wheelBurst(dir, strength)
            left -= 600 * strength // ~ sum of a burst's deltas
            await this.wait(r.range(120, 420))
        }
    }

    /**
     * Brings an element into view by wheeling, over its scroll container if it has one
     * (falls back to scrollIntoView when wheeling doesn't move it).
     */
    async reveal(selector, n = 0) {
        let lastY = null
        for (let i = 0; i < 8; i++) {
            const b = await this.rect(selector, n)
            if (!b) return null
            const box = b.box || { x: 0, y: 64, w: this.vw, h: this.vh - 64 }
            const top = Math.max(80, box.y + 10)
            const bottom = Math.min(this.vh - 60, box.y + box.h - 10)
            if (b.y >= top && b.y + b.h <= bottom) return b
            if (lastY !== null && Math.abs(b.y - lastY) < 2) break // wheel doesn't move it
            lastY = b.y
            if (this.x < box.x || this.x > box.x + box.w || this.y < box.y || this.y > box.y + box.h) {
                await this.moveTo(box.x + box.w * this.r.range(0.3, 0.7), Math.max(box.y, 64) + (Math.min(box.y + box.h, this.vh) - Math.max(box.y, 64)) * this.r.range(0.3, 0.7))
            }
            await this.scroll(b.y + b.h / 2 - (top + bottom) / 2)
            await this.wait(100)
        }
        await this.page.evaluate(`(() => { const els = document.querySelectorAll(${JSON.stringify(selector)}); const e = els[((${n} % els.length) + els.length) % els.length]; e && e.scrollIntoView({ block: 'center' }) })()`)
        return this.rect(selector, n)
    }

    /** Moves over an element (hover) and dwells. Returns false if it doesn't exist. */
    async hover(selector, { n = 0, dwell = [250, 900] } = {}) {
        const b = await this.reveal(selector, n)
        if (!b) { this.stats.missing.push(selector); return false }
        await this.moveTo(b.x + b.w * this.r.range(0.3, 0.7), b.y + b.h * this.r.range(0.3, 0.7))
        await this.wait(this.r.range(dwell[0], dwell[1]))
        return true
    }

    async click(selector, { n = 0, wait = 0 } = {}) {
        const r = this.r
        const b = wait ? await this.waitForSelector(selector, wait) && await this.reveal(selector, n) : await this.reveal(selector, n)
        if (!b) { this.stats.missing.push(selector); return false }
        const px = b.x + b.w * Math.min(0.85, Math.max(0.15, r.normal(0.5, 0.12)))
        const py = b.y + b.h * Math.min(0.8, Math.max(0.2, r.normal(0.5, 0.12)))
        await this.moveTo(px, py)
        await this.wait(r.range(60, 220)) // aim
        await this.mouse('mousePressed', Math.round(px), Math.round(py), { button: 'left', buttons: 1, clickCount: 1 })
        await this.wait(r.range(50, 120))
        await this.mouse('mouseReleased', Math.round(px), Math.round(py), { button: 'left', buttons: 0, clickCount: 1 })
        this.stats.clicks++
        await this.wait(r.range(120, 300))
        return true
    }

    async key(name) {
        const k = KEYS[name]
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...k })
        await this.wait(this.r.range(40, 90))
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode })
        this.stats.keys++
    }

    async char(ch) {
        const code = /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch : undefined
        const vk = /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : undefined
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk })
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk })
        this.stats.keys++
    }

    /** Types into the focused element: per-key jitter, pauses after words, ~3% typos fixed with Backspace. */
    async type(text, { wpm = 70, typos = 0.03 } = {}) {
        const r = this.r
        const base = 60000 / (wpm * 5)
        for (const ch of text) {
            if (ch === '\n') { await this.key('Enter'); await this.wait(r.range(200, 500)); continue }
            if (/[a-z]/i.test(ch) && r.chance(typos)) {
                const wrong = neighbour(ch, r)
                if (wrong) {
                    await this.char(wrong)
                    await this.wait(r.range(base * 0.6, base * 1.4))
                    if (r.chance(0.4)) { // noticed one key late
                        await this.char(ch === ch.toUpperCase() ? ch : r.pick('aeiou'))
                        await this.wait(r.range(150, 350))
                        await this.key('Backspace')
                        await this.wait(r.range(60, 140))
                    }
                    await this.wait(r.range(150, 400)) // notice
                    await this.key('Backspace')
                    await this.wait(r.range(80, 200))
                    this.stats.typos++
                }
            }
            await this.char(ch)
            let d = Math.max(25, r.normal(base, base * 0.35))
            if (ch === ' ') d += r.range(20, 160)
            if (/[.,!?]/.test(ch)) d += r.range(150, 450)
            await this.wait(d)
        }
    }

    /** Pastes text (insertText), like a password manager or clipboard paste. */
    async paste(text) {
        await this.cdp('Input.insertText', { text })
        this.stats.keys++
        await this.wait(this.r.range(150, 400))
    }

    async fill(selector, text, opts) {
        if (!await this.click(selector, opts)) return false
        await this.type(text, opts)
        await this.wait(this.r.range(200, 600))
        return true
    }

    /** Reading pause: mostly still, with small idle mouse drifts. */
    async read(ms) {
        const r = this.r
        const end = this.clock + ms
        while (this.clock < end) {
            const chunk = Math.min(end - this.clock, r.range(600, 2200))
            await this.wait(chunk)
            if (this.clock < end && r.chance(0.45)) await this.moveTo(this.x + r.normal(0, 60), this.y + r.normal(0, 40))
        }
    }
}
