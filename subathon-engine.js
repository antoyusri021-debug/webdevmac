'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
    title: 'SUBATHON LIVE',
    accent: '#8b5cf6',
    shape: '12px',
    panelStyle: 'none',
    background: '#0c0f17',
    opacity: 88,
    initialMinutes: 60,
    maxHours: 12,
    rules: [{ minCoins: 100, addSeconds: 60, mode: 'multiple' }]
};

function attachSubathon(io, saveDir) {
    if (!io || typeof io.on !== 'function') throw new TypeError('Socket.IO server wajib diberikan.');
    if (!saveDir) throw new TypeError('Direktori penyimpanan wajib diberikan.');

    const settingsPath = path.join(saveDir, 'subathon-settings.json');
    let settings = { ...DEFAULT_SETTINGS, rules: DEFAULT_SETTINGS.rules.map(rule => ({ ...rule })) };
    let remainingSeconds = settings.initialMinutes * 60;
    let running = false;
    let started = false;
    let lastTick = Date.now();
    let giftMessage = null;

    const validHex = (value, fallback) =>
        typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    const clamp = (number, low, high) => Math.max(low, Math.min(high, number));

    function sanitizeRules(input) {
        if (!Array.isArray(input)) return settings.rules;
        return input.slice(0, 50).map(rule => ({
            minCoins: Math.max(1, Math.floor(Number(rule?.minCoins) || 1)),
            addSeconds: Math.max(1, Math.floor(Number(rule?.addSeconds) || 1)),
            mode: rule?.mode === 'once' ? 'once' : 'multiple'
        }));
    }

    function sanitizeSettings(input = {}, base = settings) {
        const value = input && typeof input === 'object' ? input : {};
        const maxHours = clamp(Number(value.maxHours ?? base.maxHours) || 12, 1, 168);
        return {
            title: String(value.title ?? base.title).slice(0, 40),
            accent: validHex(value.accent, base.accent),
            shape: ['0px', '12px', '26px'].includes(value.shape) ? value.shape : base.shape,
            panelStyle: ['glass', 'solid', 'none'].includes(value.panelStyle) ? value.panelStyle : base.panelStyle,
            background: validHex(value.background, base.background),
            opacity: clamp(Number(value.opacity ?? base.opacity) || 0, 0, 100),
            initialMinutes: clamp(Math.floor(Number(value.initialMinutes ?? base.initialMinutes) || 60), 1, maxHours * 60),
            maxHours,
            rules: sanitizeRules(value.rules ?? base.rules)
        };
    }

    function saveSettings(callback) {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8', error => {
            if (error) {
                console.error('[SUBATHON] Gagal menyimpan konfigurasi:', error.message);
                if (callback) callback({ ok: false, message: 'Gagal menulis file konfigurasi.' });
                return;
            }
            if (callback) callback({ ok: true });
        });
    }

    function getState() {
        const maxSeconds = Math.max(1, settings.maxHours * 3600);
        const initialSeconds = Math.max(1, settings.initialMinutes * 60);
        return {
            timeRemaining: Math.max(0, Math.floor(remainingSeconds)),
            running,
            started,
            progress: clamp((remainingSeconds / initialSeconds) * 100, 0, 100),
            maxSeconds,
            giftMessage
        };
    }

    function emitState() {
        io.emit('subathon:state', getState());
    }

    function calculateGiftAddition(totalCoins) {
        if (!totalCoins || !settings.rules.length) return 0;
        const candidates = settings.rules
            .filter(rule => totalCoins >= rule.minCoins)
            .sort((a, b) => b.minCoins - a.minCoins);
        if (!candidates.length) return 0;

        const rule = candidates[0];
        const increments = rule.mode === 'multiple' ? Math.floor(totalCoins / rule.minCoins) : 1;
        return Math.max(0, increments * rule.addSeconds);
    }

    function handleGift(data = {}) {
        if (!data || typeof data !== 'object' || !started || remainingSeconds <= 0) return;
        const repeat = Math.max(1, Number(data.repeatCount ?? data.count ?? 1));
        const unitCoins = Math.max(0, Number(data.coinPerGift ?? data.diamondCount ?? 0));
        const totalCoins = Math.max(0, Number(data.totalCoins ?? (unitCoins * repeat)));
        const addedSeconds = calculateGiftAddition(totalCoins);
        if (addedSeconds <= 0) return;

        const cap = settings.maxHours * 3600;
        const before = remainingSeconds;
        remainingSeconds = Math.min(cap, remainingSeconds + addedSeconds);
        const actuallyAdded = remainingSeconds - before;
        giftMessage = {
            nickname: String(data.nickname || data.uniqueId || 'Penonton'),
            user: String(data.uniqueId || ''),
            giftName: String(data.giftName || 'Gift'),
            addedSeconds: actuallyAdded,
            totalCoins
        };
        io.emit('subathon:gift', giftMessage);
        emitState();
    }

    try {
        if (fs.existsSync(settingsPath)) {
            settings = sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), settings);
        }
    } catch (error) {
        console.error('[SUBATHON] Gagal membaca konfigurasi:', error.message);
    }
    remainingSeconds = settings.initialMinutes * 60;

    io.on('connection', socket => {
        socket.on('subathon:settings:get', () => {
            socket.emit('subathon:settings', settings);
            socket.emit('subathon:state', getState());
        });

        socket.on('subathon:settings:save', (incoming, callback) => {
            settings = sanitizeSettings(incoming, settings);
            // Jika durasi awal diganti ketika timer belum berjalan, perbarui timer siap.
            if (!running) remainingSeconds = settings.initialMinutes * 60;
            saveSettings(result => {
                if (result.ok) {
                    io.emit('subathon:settings', settings);
                    emitState();
                    console.log('[SUBATHON] Gaya overlay dan pengaturan tersimpan.');
                }
                if (typeof callback === 'function') callback(result);
            });
        });

        socket.on('subathon:timer:settings:save', (incoming, callback) => {
            settings = sanitizeSettings({
                initialMinutes: incoming?.initialMinutes,
                maxHours: incoming?.maxHours,
                rules: incoming?.rules
            }, settings);
            if (!running) remainingSeconds = settings.initialMinutes * 60;
            saveSettings(result => {
                if (result.ok) {
                    io.emit('subathon:settings', settings);
                    emitState();
                }
                if (typeof callback === 'function') callback(result);
            });
        });

        socket.on('subathon:timer:control', (action, callback) => {
            const cap = settings.maxHours * 3600;
            if (action === 'start') {
                if (remainingSeconds <= 0) remainingSeconds = settings.initialMinutes * 60;
                started = true;
                running = true;
                lastTick = Date.now();
            } else if (action === 'pause') {
                if (started && remainingSeconds > 0) running = !running;
                lastTick = Date.now();
            } else if (action === 'add-minute') {
                remainingSeconds = Math.min(cap, remainingSeconds + 60);
            } else if (action === 'subtract-minute') {
                remainingSeconds = Math.max(0, remainingSeconds - 60);
                if (remainingSeconds === 0) running = false;
            } else if (action === 'reset') {
                running = false;
                started = false;
                remainingSeconds = settings.initialMinutes * 60;
                giftMessage = null;
            } else {
                if (typeof callback === 'function') callback({ ok: false, message: 'Aksi timer tidak dikenal.' });
                return;
            }
            emitState();
            if (typeof callback === 'function') callback({ ok: true, state: getState() });
        });

        socket.on('subathon:rules:test', (testData = {}, callback) => {
            const totalCoins = Math.max(1, Number(testData.totalCoins) || 100);
            const addedSeconds = calculateGiftAddition(totalCoins);
            if (typeof callback === 'function') callback({ ok: addedSeconds > 0, addedSeconds });
        });
    });

    setInterval(() => {
        if (!running) return;
        const now = Date.now();
        const elapsed = Math.floor((now - lastTick) / 1000);
        if (elapsed < 1) return;
        lastTick += elapsed * 1000;
        remainingSeconds = Math.max(0, remainingSeconds - elapsed);
        if (remainingSeconds <= 0) running = false;
        emitState();
    }, 250);

    return { handleGift, getSettings: () => ({ ...settings }), getState };
}

module.exports = attachSubathon;
