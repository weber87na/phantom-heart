const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const readingIds = ['acc-x', 'acc-y', 'acc-z', 'accG-x', 'accG-y', 'accG-z',
    'rot-alpha', 'rot-beta', 'rot-gamma'];
const noData = { acceleration: null, accelerationIncludingGravity: null, rotationRate: null };

function createPage(options = {}) {
    const elements = new Map();
    for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/gi)) {
        let text = match[4];
        const listeners = new Map();
        elements.set(match[3], {
            id: match[3],
            className: match[2].match(/class="([^"]*)"/)?.[1] || '',
            style: {},
            disabled: false,
            hidden: false,
            get textContent() { return text; },
            set textContent(value) { text = String(value); },
            get innerText() { return text; },
            set innerText(value) { text = String(value); },
            addEventListener(type, callback) { listeners.set(type, callback); },
            async click() { await listeners.get('click')?.(); },
            setAttribute(name, value) { this[name] = String(value); }
        });
    }

    let now = 0;
    let timerId = 0;
    const timers = new Map();
    const listeners = new Map();
    const navigator = {
        userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
        ...options.navigator
    };
    const sandbox = {
        document: { getElementById: id => elements.get(id) },
        navigator,
        isSecureContext: options.secure !== false,
        console: { log() {}, warn() {}, error() {} },
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, due: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(callback);
        },
        removeEventListener(type, callback) { listeners.get(type)?.delete(callback); }
    };
    if (options.supported !== false) {
        sandbox.DeviceMotionEvent = options.motionApi || function DeviceMotionEvent() {};
    }
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(script, context, { filename: 'index.html' });

    return {
        elements,
        timers,
        get status() { return elements.get('status'); },
        get button() { return elements.get('startBtn'); },
        start() { return elements.get('startBtn').click(); },
        listenerCount(type = 'devicemotion') { return listeners.get(type)?.size || 0; },
        emit(type, event = {}) {
            for (const listener of [...(listeners.get(type) || [])]) listener(event);
        },
        advance(ms) {
            const until = now + ms;
            while (true) {
                const next = [...timers].filter(([, timer]) => timer.due <= until)
                    .sort((a, b) => a[1].due - b[1].due)[0];
                if (!next) break;
                now = next[1].due;
                timers.delete(next[0]);
                next[1].callback();
            }
            now = until;
        }
    };
}

function assertWaiting(page) {
    assert.doesNotMatch(page.status.className, /success/);
    assert.match(page.status.textContent, /等待/);
    assert.equal(page.listenerCount(), 1);
    assert.notEqual(page.button.style.display, 'none');
}

test('API support alone does not report success; start waits for real data', async () => {
    const page = createPage();
    await page.start();
    assertWaiting(page);
    assert.equal(page.button.disabled, false);
});

test('permission grant still waits for data and uses platform-neutral status', async () => {
    let calls = 0;
    const page = createPage({ motionApi: { requestPermission: async () => { calls++; return 'granted'; } } });
    await page.start();
    assert.equal(calls, 1);
    assertWaiting(page);
    assert.doesNotMatch(page.status.textContent, /iOS|Android/);
});

test('duplicate starts while permission is pending issue only one request', async () => {
    let resolvePermission;
    let calls = 0;
    const page = createPage({ motionApi: { requestPermission: () => {
        calls++;
        return new Promise(resolve => { resolvePermission = resolve; });
    } } });
    const first = page.start();
    assert.equal(page.button.disabled, true);
    await page.start();
    assert.equal(calls, 1);
    assert.doesNotMatch(page.status.className, /success/);
    resolvePermission('granted');
    await first;
    assertWaiting(page);
});

test('null and non-finite samples cannot activate sensing; zero is valid', async () => {
    const page = createPage();
    await page.start();
    page.emit('devicemotion', noData);
    assertWaiting(page);
    for (const id of readingIds) assert.equal(page.elements.get(id).textContent, 'N/A');
    page.emit('devicemotion', { acceleration: { x: NaN, y: Infinity, z: -Infinity } });
    assertWaiting(page);
    page.emit('devicemotion', { acceleration: { x: 0, y: null, z: null } });
    assert.match(page.status.className, /success/);
    assert.equal(page.elements.get('acc-x').textContent, '0.00');
    assert.equal(page.elements.get('rot-alpha').textContent, 'N/A');
});

test('missing sensor groups clear previous readings and remove success status', async () => {
    const page = createPage();
    await page.start();
    page.emit('devicemotion', {
        acceleration: { x: 1.234, y: -2, z: 3 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
        rotationRate: { alpha: 2, beta: 3, gamma: 4 }
    });
    assert.equal(page.elements.get('acc-x').textContent, '1.23');
    assert.match(page.status.className, /success/);
    page.emit('devicemotion', noData);
    for (const id of readingIds) assert.equal(page.elements.get(id).textContent, 'N/A');
    assert.doesNotMatch(page.status.className, /success/);
});

test('no valid data within eight seconds times out and allows a fresh attempt', async () => {
    const page = createPage();
    await page.start();
    page.advance(4000);
    page.emit('devicemotion', noData);
    page.advance(3999);
    assertWaiting(page);
    page.advance(1);
    assert.match(page.status.className, /error/);
    assert.equal(page.listenerCount(), 0);
    assert.equal(page.button.disabled, false);
    assert.equal(page.timers.size, 0);
    await page.start();
    assertWaiting(page);
});

test('valid data refreshes the timeout, but silent sensors eventually stop', async () => {
    const page = createPage();
    await page.start();
    page.advance(7000);
    page.emit('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 } });
    page.advance(1000);
    assert.match(page.status.className, /success/);
    page.advance(7000);
    assert.match(page.status.className, /error/);
    assert.equal(page.listenerCount(), 0);
    for (const id of readingIds) assert.equal(page.elements.get(id).textContent, 'N/A');
});

test('permission denial leaves a usable retry button and no listener', async () => {
    let response = 'denied';
    const page = createPage({ motionApi: { requestPermission: async () => response } });
    await page.start();
    assert.match(page.status.className, /error/);
    assert.doesNotMatch(page.status.textContent, /iOS|Android/);
    assert.equal(page.listenerCount(), 0);
    assert.equal(page.button.disabled, false);
    response = 'granted';
    await page.start();
    assertWaiting(page);
});

for (const mode of ['rejection', 'synchronous exception']) {
    test(`permission ${mode} is handled without stranding the button`, async () => {
        const page = createPage({ motionApi: { requestPermission() {
            if (mode === 'rejection') return Promise.reject(new Error('blocked'));
            throw new Error('blocked');
        } } });
        await page.start();
        assert.match(page.status.className, /error/);
        assert.doesNotMatch(page.status.textContent, /iOS|Android/);
        assert.equal(page.button.disabled, false);
        assert.equal(page.listenerCount(), 0);
    });
}

test('unsupported API and insecure context fail before requesting permissions', async () => {
    for (const option of [{ supported: false }, { secure: false }]) {
        let requested = false;
        const page = createPage({ ...option, motionApi: { requestPermission() {
            requested = true;
            return Promise.resolve('granted');
        } } });
        await page.start();
        assert.equal(requested, false);
        assert.match(page.status.className, /error/);
        assert.equal(page.listenerCount(), 0);
    }
});

test('clicking again stops sensing and clears its timer', async () => {
    for (const active of [false, true]) {
        const page = createPage();
        await page.start();
        if (active) page.emit('devicemotion', { acceleration: { x: 0 } });
        await page.start();
        assert.equal(page.listenerCount(), 0);
        assert.equal(page.timers.size, 0);
        assert.doesNotMatch(page.status.className, /success/);
        await page.start();
        assertWaiting(page);
    }
});

test('pagehide cleans up active sensing', async () => {
    const page = createPage();
    await page.start();
    page.emit('devicemotion', { acceleration: { x: 0 } });
    page.emit('pagehide');
    assert.equal(page.listenerCount(), 0);
    assert.equal(page.timers.size, 0);
    assert.doesNotMatch(page.status.className, /success/);
});

test('permission resolution after pagehide cannot restart sensing', async () => {
    let resolvePermission;
    const page = createPage({ motionApi: { requestPermission: () => new Promise(resolve => {
        resolvePermission = resolve;
    }) } });
    const pending = page.start();
    page.emit('pagehide');
    resolvePermission('granted');
    await pending;
    assert.equal(page.listenerCount(), 0);
    assert.equal(page.timers.size, 0);
    assert.doesNotMatch(page.status.className, /success/);
});

test('client hints identify Android Chrome without using the permission API', () => {
    const page = createPage({
        navigator: {
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
            userAgentData: {
                platform: 'Android',
                mobile: true,
                brands: [
                    { brand: 'Not_A Brand', version: '99' },
                    { brand: 'Chromium', version: '140' },
                    { brand: 'Google Chrome', version: '140' }
                ]
            }
        }
    });
    assert.equal(page.elements.get('device-os').textContent, 'Android');
    assert.equal(page.elements.get('device-browser').textContent, 'Chrome');
    assert.match(page.elements.get('device-type').textContent, /手機/);
    assert.doesNotMatch(page.status.className, /success/);
});

test('UA fallback distinguishes browsers that also advertise Chrome or Safari', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
    const android = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36';
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const cases = [
        [`${iphone} Version/18.0 Mobile/15E148 Safari/604.1`, 'iOS', 'Safari'],
        [`${iphone} CriOS/140.0.0.0 Mobile/15E148 Safari/604.1`, 'iOS', 'Chrome'],
        [`${iphone} FxiOS/140.0 Mobile/15E148 Safari/605.1.15`, 'iOS', 'Firefox'],
        [`${android} SamsungBrowser/28.0 Chrome/140.0.0.0 Mobile Safari/537.36`, 'Android', 'Samsung Internet'],
        [`${android} Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0`, 'Android', 'Edge'],
        [`${windows} Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0`, 'Windows', 'Edge']
    ];
    for (const [userAgent, os, browser] of cases) {
        const page = createPage({ navigator: { userAgent, maxTouchPoints: 0 } });
        assert.equal(page.elements.get('device-os').textContent, os, userAgent);
        assert.equal(page.elements.get('device-browser').textContent, browser, userAgent);
    }
});

test('iPad desktop UA is marked as an estimate rather than a confirmed Mac', () => {
    const page = createPage({ navigator: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        platform: 'MacIntel',
        maxTouchPoints: 5
    } });
    assert.match(page.elements.get('device-os').textContent, /iPadOS.*推測/);
    assert.match(page.elements.get('device-type').textContent, /平板.*推測/);
    assert.equal(page.elements.get('device-browser').textContent, 'Safari');
});

test('unrecognized clients keep device information unknown', () => {
    const page = createPage({ navigator: { userAgent: '', platform: '', maxTouchPoints: 0 } });
    for (const key of ['os', 'browser', 'type']) {
        assert.equal(page.elements.get(`device-${key}`).textContent, '無法辨識');
    }
    assert.equal(page.elements.get('device-model').textContent, '瀏覽器未提供');
});

test('empty, reduced, denied, and missing model hints keep the model unknown', async () => {
    const responses = [
        () => Promise.resolve({ model: '' }),
        () => Promise.resolve({ model: '  ' }),
        () => Promise.resolve({ model: ' K ' }),
        () => Promise.resolve({}),
        () => Promise.reject(new Error('permission policy denied'))
    ];
    for (const getHighEntropyValues of responses) {
        const page = createPage({ navigator: { userAgentData: { getHighEntropyValues } } });
        await new Promise(setImmediate);
        assert.equal(page.elements.get('device-model').textContent, '瀏覽器未提供');
        await page.start();
        assertWaiting(page);
    }
});

test('a pending model lookup does not block sensor permission or activation', async () => {
    let resolveModel;
    let requestedHints;
    let permissionCalls = 0;
    const page = createPage({
        navigator: { userAgentData: {
            platform: 'Android', mobile: true,
            brands: [{ brand: 'Google Chrome', version: '140' }],
            getHighEntropyValues(hints) {
                requestedHints = Array.from(hints);
                return new Promise(resolve => { resolveModel = resolve; });
            }
        } },
        motionApi: { requestPermission: async () => { permissionCalls++; return 'granted'; } }
    });
    assert.deepEqual(requestedHints, ['model']);
    assert.equal(page.elements.get('device-model').textContent, '瀏覽器未提供');
    await page.start();
    assert.equal(permissionCalls, 1);
    assertWaiting(page);
    page.emit('devicemotion', { acceleration: { x: 0 } });
    assert.match(page.status.className, /success/);
    resolveModel({ model: ' Pixel 9 ' });
    await new Promise(setImmediate);
    assert.equal(page.elements.get('device-model').textContent, 'Pixel 9');
    assert.match(page.status.className, /success/);
});
