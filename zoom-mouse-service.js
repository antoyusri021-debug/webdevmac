const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

function createZoomMouseService({ ipcMain, app, globalShortcut, screen }) {
    const state = {
        connected: false,
        active: false,
        host: '127.0.0.1',
        port: 4455,
        password: '',
        sceneName: '',
        sourceName: '',
        hotkey: 'CommandOrControl+Shift+Z',
        hotkeyMode: 'toggle',
        zoomLevel: 1.5,
        smoothing: 0.18,
        ws: null,
        requestId: 0,
        pending: new Map(),
        timer: null,
        baseTransform: null,
        baseKey: '',
        canvas: { width: 1920, height: 1080 },
        lastCursor: null,
        lastSent: 0
    };

    const settingsPath = path.join(app.getPath('userData'), 'zoom-mouse-settings.json');

    function loadSettings() {
        try {
            if (!fs.existsSync(settingsPath)) return;
            const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (saved.host) state.host = String(saved.host);
            if (saved.port) state.port = Number(saved.port) || 4455;
            if (saved.password !== undefined) state.password = String(saved.password);
            if (saved.sceneName) state.sceneName = String(saved.sceneName);
            if (saved.sourceName) state.sourceName = String(saved.sourceName);
            if (saved.hotkey) state.hotkey = String(saved.hotkey);
            if (saved.hotkeyMode) state.hotkeyMode = String(saved.hotkeyMode);
            if (Number.isFinite(Number(saved.zoomLevel))) state.zoomLevel = Number(saved.zoomLevel);
            if (Number.isFinite(Number(saved.smoothing))) state.smoothing = Number(saved.smoothing);
            console.log('[ZOOM SETTINGS] Konfigurasi dipulihkan dari file.');
        } catch (error) {
            console.warn('[ZOOM SETTINGS] Gagal membaca konfigurasi:', error.message);
        }
    }

    function saveSettings() {
        try {
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify({
                host: state.host,
                port: state.port,
                password: state.password,
                sceneName: state.sceneName,
                sourceName: state.sourceName,
                hotkey: state.hotkey,
                hotkeyMode: state.hotkeyMode,
                zoomLevel: state.zoomLevel,
                smoothing: state.smoothing
            }, null, 2), 'utf8');
        } catch (error) {
            console.warn('[ZOOM SETTINGS] Gagal menyimpan konfigurasi:', error.message);
        }
    }

    loadSettings();

    const status = () => ({
        connected: state.connected,
        active: state.active,
        sceneName: state.sceneName,
        sourceName: state.sourceName,
        hotkey: state.hotkey,
        hotkeyMode: state.hotkeyMode,
        zoomLevel: state.zoomLevel,
        smoothing: state.smoothing,
        cursor: state.lastCursor,
        lastError: state.lastError || ''
    });

    const auth = value => crypto.createHash('sha256').update(value).digest('base64');

    function rejectPending(error) {
        for (const p of state.pending.values()) {
            clearTimeout(p.timer);
            p.reject(error);
        }
        state.pending.clear();
    }

    function send(packet) {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            throw new Error('OBS WebSocket belum terhubung.');
        }
        state.ws.send(JSON.stringify(packet));
    }

    function request(requestType, requestData = {}) {
        return new Promise((resolve, reject) => {
            if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('OBS WebSocket belum terhubung.'));
                return;
            }
            const requestId = `zoom-${++state.requestId}`;
            const timer = setTimeout(() => {
                state.pending.delete(requestId);
                reject(new Error(`Timeout OBS: ${requestType}`));
            }, 5000);
            state.pending.set(requestId, { resolve, reject, timer });
            try {
                send({ op: 6, d: { requestType, requestId, requestData } });
            } catch (error) {
                clearTimeout(timer);
                state.pending.delete(requestId);
                reject(error);
            }
        });
    }

    async function readBaseTransform() {
        if (!state.sceneName || !state.sourceName) throw new Error('Scene dan Source belum dipilih.');
        const item = await request('GetSceneItemId', { sceneName: state.sceneName, sourceName: state.sourceName });
        const transform = await request('GetSceneItemTransform', {
            sceneName: state.sceneName,
            sceneItemId: item.sceneItemId
        });
        state.baseTransform = sanitizeTransform(
            JSON.parse(JSON.stringify(transform.sceneItemTransform))
        );
        return state.baseTransform;
    }

    async function readCanvas() {
        try {
            const result = await request('GetVideoSettings');
            state.canvas.width = Number(result.baseWidth) || 1920;
            state.canvas.height = Number(result.baseHeight) || 1080;
        } catch (_) {}
    }

    function sanitizeTransform(transform) {
        const clean = { ...(transform || {}) };

        // OBS dapat mengembalikan boundsWidth/boundsHeight = 0
        // untuk Display Capture dengan boundsType OBS_BOUNDS_NONE.
        // SetSceneItemTransform menolak nilai di bawah 1.
        if (!Number.isFinite(Number(clean.boundsWidth)) || Number(clean.boundsWidth) < 1) {
            delete clean.boundsWidth;
        }
        if (!Number.isFinite(Number(clean.boundsHeight)) || Number(clean.boundsHeight) < 1) {
            delete clean.boundsHeight;
        }
        if (clean.boundsType === 'OBS_BOUNDS_NONE') {
            delete clean.boundsType;
        }

        return clean;
    }

    async function restore() {
        if (!state.baseTransform || !state.sceneName || !state.sourceName) return;
        const item = await request('GetSceneItemId', { sceneName: state.sceneName, sourceName: state.sourceName });
        await request('SetSceneItemTransform', {
            sceneName: state.sceneName,
            sceneItemId: item.sceneItemId,
            sceneItemTransform: sanitizeTransform(state.baseTransform)
        });
    }

    function cursorToCanvas() {
        const point = screen.getCursorScreenPoint();
        const display = screen.getPrimaryDisplay();
        const b = display.bounds;
        const x = Math.max(0, Math.min(state.canvas.width, ((point.x - b.x) / b.width) * state.canvas.width));
        const y = Math.max(0, Math.min(state.canvas.height, ((point.y - b.y) / b.height) * state.canvas.height));
        state.lastCursor = { x: Math.round(x), y: Math.round(y) };
        return state.lastCursor;
    }

    async function applyZoom() {
        if (!state.active || !state.baseTransform) return;
        const cursor = cursorToCanvas();
        const base = state.baseTransform;
        const zoom = Math.max(1, Number(state.zoomLevel) || 1.5);
        const baseScaleX = Number(base.scaleX) || 1;
        const baseScaleY = Number(base.scaleY) || 1;
        const nextScaleX = baseScaleX * zoom;
        const nextScaleY = baseScaleY * zoom;
        const baseX = Number(base.positionX) || 0;
        const baseY = Number(base.positionY) || 0;
        const targetX = cursor.x - ((cursor.x - baseX) * zoom);
        const targetY = cursor.y - ((cursor.y - baseY) * zoom);
        const alpha = Math.max(0.01, Math.min(1, Number(state.smoothing) || 0.18));
        const previous = state.lastTransform || base;
        const sceneItemId = state.sceneItemId;
        const next = {
            ...base,
            scaleX: Number(previous.scaleX || baseScaleX) + (nextScaleX - Number(previous.scaleX || baseScaleX)) * alpha,
            scaleY: Number(previous.scaleY || baseScaleY) + (nextScaleY - Number(previous.scaleY || baseScaleY)) * alpha,
            positionX: Number(previous.positionX || baseX) + (targetX - Number(previous.positionX || baseX)) * alpha,
            positionY: Number(previous.positionY || baseY) + (targetY - Number(previous.positionY || baseY)) * alpha
        };
        state.lastTransform = next;
        const now = Date.now();
        if (now - state.lastSent < 30) return;
        state.lastSent = now;
        try {
            await request('SetSceneItemTransform', {
                sceneName: state.sceneName,
                sceneItemId,
                sceneItemTransform: sanitizeTransform(next)
            });
        } catch (error) {
            state.lastError = error.message;
        }
    }

    function startLoop() {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(() => { applyZoom().catch(() => {}); }, 33);
    }

    function stopLoop() {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
    }

    async function activate(payload = {}) {
        if (state.active) {
            await deactivate();
        }
        state.sceneName = payload.sceneName !== undefined
            ? String(payload.sceneName)
            : state.sceneName;
        state.sourceName = payload.sourceName !== undefined
            ? String(payload.sourceName)
            : state.sourceName;

        // Jangan mengisi default ketika activate() dipanggil dari hotkey.
        // Hotkey memanggil activate() tanpa payload dan harus memakai
        // setting terakhir yang tersimpan di state/service.
        if (payload.zoomLevel !== undefined && Number.isFinite(Number(payload.zoomLevel))) {
            state.zoomLevel = Math.max(1, Number(payload.zoomLevel));
        }
        if (payload.smoothing !== undefined && Number.isFinite(Number(payload.smoothing))) {
            state.smoothing = Math.max(0.01, Math.min(1, Number(payload.smoothing)));
        }
        if (payload.hotkeyMode !== undefined) state.hotkeyMode = String(payload.hotkeyMode);
        saveSettings();
        if (!state.connected) throw new Error('OBS belum terhubung.');
        const item = await request('GetSceneItemId', { sceneName: state.sceneName, sourceName: state.sourceName });
        state.sceneItemId = item.sceneItemId;
        await readCanvas();
        const targetKey = `${state.sceneName}::${state.sourceName}`;
        if (!state.baseTransform || state.baseKey !== targetKey) {
            await readBaseTransform();
            state.baseKey = targetKey;
        }
        state.lastTransform = JSON.parse(JSON.stringify(state.baseTransform));
        registerHotkey(state.hotkey);
        state.active = true;
        startLoop();
        return status();
    }

    async function deactivate() {
        state.active = false;
        stopLoop();
        try { await restore(); } catch (error) { state.lastError = error.message; }
        return status();
    }

    function disconnect(removeHotkey = true) {
        state.active = false;
        stopLoop();
        if (removeHotkey) {
            globalShortcut.unregister(state.hotkey);
            state.hotkeyRegistered = false;
        }
        rejectPending(new Error('OBS disconnected'));
        if (state.ws) { try { state.ws.close(); } catch (_) {} }
        state.ws = null;
        state.connected = false;
    }

    function registerHotkey(hotkey = 'CommandOrControl+Shift+Z') {
        if (state.hotkeyRegistered && state.hotkey === hotkey) {
            return true;
        }
        globalShortcut.unregister(state.hotkey);
        state.hotkey = hotkey;
        saveSettings();
        state.hotkeyRegistered = globalShortcut.register(state.hotkey, async () => {
            try {
                if (state.active) await deactivate();
                else if (state.connected && state.sceneName && state.sourceName) await activate();
            } catch (error) {
                state.lastError = error.message;
                console.error('[ZOOM HOTKEY ERROR]', error.message);
            }
        });
        if (!state.hotkeyRegistered) {
            console.warn(`[ZOOM HOTKEY] Gagal mendaftarkan hotkey: ${state.hotkey}`);
        } else {
            console.log(`[ZOOM HOTKEY] Terdaftar: ${state.hotkey}`);
        }
        return state.hotkeyRegistered;
    }

    function connect(payload = {}) {
        return new Promise(resolve => {
            // Reconnect OBS tidak boleh menghapus hotkey global yang sudah terdaftar.
            disconnect(false);
            state.host = String(payload.host || '127.0.0.1');
            state.port = Number(payload.port) || 4455;
            state.password = String(payload.password || '');
            saveSettings();
            const ws = new WebSocket(`ws://${state.host}:${state.port}`);
            state.ws = ws;
            let done = false;
            const finish = result => { if (!done) { done = true; resolve(result); } };
            ws.on('message', raw => {
                let packet;
                try { packet = JSON.parse(raw.toString()); } catch (_) { return; }
                if (packet.op === 0) {
                    const hello = packet.d || {};
                    const identify = { rpcVersion: 1 };
                    if (hello.authentication) {
                        const secret = auth(state.password + hello.authentication.salt);
                        identify.authentication = auth(secret + hello.authentication.challenge);
                    }
                    send({ op: 1, d: identify });
                } else if (packet.op === 2) {
                    state.connected = true;
                    state.lastError = '';
                    finish({ success: true, status: status() });
                } else if (packet.op === 7) {
                    const data = packet.d || {};
                    const p = state.pending.get(data.requestId);
                    if (!p) return;
                    state.pending.delete(data.requestId);
                    clearTimeout(p.timer);
                    if (data.requestStatus?.result) p.resolve(data.responseData || {});
                    else p.reject(new Error(data.requestStatus?.comment || 'OBS request gagal.'));
                }
            });
            ws.on('error', error => {
                state.lastError = error.message;
                finish({ success: false, message: error.message });
            });
            ws.on('close', () => {
                state.connected = false;
                state.active = false;
                stopLoop();
                rejectPending(new Error('Koneksi OBS terputus.'));
                finish({ success: false, message: 'Koneksi OBS terputus.' });
            });
            setTimeout(() => finish({ success: false, message: `Tidak bisa terhubung ke ws://${state.host}:${state.port}` }), 8000);
        });
    }

    ipcMain.handle('zoom-mouse-connect', (_event, payload) => connect(payload));
    ipcMain.handle('zoom-mouse-get-status', () => status());
    ipcMain.handle('zoom-mouse-get-scenes', async () => {
        try { const r = await request('GetSceneList'); return { success: true, scenes: (r.scenes || []).map(x => x.sceneName) }; }
        catch (e) { return { success: false, scenes: [], message: e.message }; }
    });
    ipcMain.handle('zoom-mouse-get-sources', async (_event, payload) => {
        try { const r = await request('GetSceneItemList', { sceneName: typeof payload === 'string' ? payload : payload.sceneName }); return { success: true, sources: r.sceneItems || [] }; }
        catch (e) { return { success: false, sources: [], message: e.message }; }
    });
    ipcMain.on('zoom-mouse-disconnect', () => disconnect());
    ipcMain.on('zoom-mouse-select-target', (_event, p = {}) => { state.sceneName = p.sceneName || ''; state.sourceName = p.sourceName || ''; saveSettings(); });
    ipcMain.on('zoom-mouse-update-settings', (_event, p = {}) => {
        if (p.sceneName) state.sceneName = String(p.sceneName);
        if (p.sourceName) state.sourceName = String(p.sourceName);
        if (Number.isFinite(Number(p.zoomLevel))) state.zoomLevel = Math.max(1, Number(p.zoomLevel));
        if (Number.isFinite(Number(p.smoothing))) state.smoothing = Math.max(0.01, Math.min(1, Number(p.smoothing)));
        if (p.hotkeyMode) state.hotkeyMode = String(p.hotkeyMode);
        saveSettings();
    });
    ipcMain.handle('zoom-mouse-activate', async (_event, p) => { try { return { success: true, ...(await activate(p)) }; } catch (e) { state.lastError = e.message; return { success: false, message: e.message }; } });
    ipcMain.handle('zoom-mouse-deactivate', async () => ({ success: true, ...(await deactivate()) }));
    ipcMain.handle('zoom-mouse-reset', async () => { await deactivate(); return status(); });
    ipcMain.on('zoom-mouse-clear-hotkey', () => { globalShortcut.unregister(state.hotkey); });
    ipcMain.on('zoom-mouse-register-hotkey', (_event, hotkey = 'CommandOrControl+Shift+Z') => {
        registerHotkey(hotkey);
    });
    ipcMain.on('zoom-mouse-deactivate', () => { deactivate().catch(() => {}); });
    ipcMain.on('zoom-mouse-reset', () => { deactivate().catch(() => {}); });
    app.on('will-quit', () => disconnect());

    app.whenReady().then(async () => {
        registerHotkey(state.hotkey);
        if (state.password) {
            const result = await connect({
                host: state.host,
                port: state.port,
                password: state.password
            });
            if (!result.success) {
                console.warn('[ZOOM AUTO CONNECT]', result.message);
            }
        }
    });

    return { state, connect, disconnect, activate, deactivate, status };
}

module.exports = { createZoomMouseService };
