const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
    app,
    BrowserWindow,
    ipcMain,
    Tray,
    Menu,
    Notification,
    dialog,
    shell,
    globalShortcut,
    screen
} = require('electron');

const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');
const ioClient = require('socket.io-client');
const { machineIdSync } = require('node-machine-id');
const si = require('systeminformation');

const {
    createZoomMouseService
} = require('./zoom-mouse-service');

createZoomMouseService({
    ipcMain,
    app,
    globalShortcut,
    screen
});

console.log('[ZOOM] Zoom Mouse Service berhasil dimuat');

// ================== PENGIRIM HOTKEY INLINE (BASE64 - STABIL DI EXE) ==================
function sendDirectHotkey(hotkeyString = 'CTRL+G') {
    return new Promise((resolve, reject) => {
        if (!hotkeyString) return resolve();

        const upper = hotkeyString.toUpperCase();
        let keys = [];

        // Deteksi tombol modifier
        if (upper.includes('CTRL')) keys.push('0x11');
        if (upper.includes('ALT')) keys.push('0x12');
        if (upper.includes('SHIFT')) keys.push('0x10');

        // Deteksi tombol karakter utama (misal 'G')
        const char = upper.split('+').pop().trim();
        if (char.length === 1) {
            const vkCode = '0x' + char.charCodeAt(0).toString(16);
            keys.push(vkCode);
        }

        if (keys.length === 0) return resolve();

        const pressCmd = keys.map(k => `[Native.Win32]::keybd_event(${k},0,0,0)`).join(';');
        const releaseCmd = keys.slice().reverse().map(k => `[Native.Win32]::keybd_event(${k},0,2,0)`).join(';');

        // Script PowerShell MURNI SIMULASI TOMBOL GLOBAL (Tanpa panggil/fokus aplikasi)
        const rawScript = `
$code = @"
using System;
using System.Runtime.InteropServices;
namespace Native {
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'Native.Win32').Type) {
    Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
}

${pressCmd}
Start-Sleep -milli 50
${releaseCmd}
        `.trim();

        // Encode ke Base64 agar dieksekusi lancar di .exe
        const buffer = Buffer.from(rawScript, 'utf16le');
        const encodedScript = buffer.toString('base64');

        const powershellPath = process.env.SystemRoot
            ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
            : 'powershell.exe';

        execFile(
            powershellPath,
            [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-EncodedCommand',
                encodedScript
            ],
            { windowsHide: true, timeout: 3000 },
            (error) => {
                if (error) {
                    console.error('[GLOBAL HOTKEY ERROR]', error.message);
                    return reject(error);
                }
                console.log(`[GLOBAL HOTKEY SUCCESS] Simulated keypress: ${hotkeyString}`);
                resolve();
            }
        );
    });
}

// ================== CAMERA TRIGGER ==================
async function triggerCameraRule(eventType) {

    if (!cameraTriggerEnabled) {
        console.log(
            `[CAMERA] Trigger OFF — event ${eventType.toUpperCase()} diabaikan.`
        );
        return;
    }

    const rule = hotkeyConfig[eventType];

    if (!rule || !rule.hotkey) {
        console.warn(
            `[CAMERA] Tidak ada konfigurasi untuk event: ${eventType}`
        );
        return;
    }

    if (rule.enabled === false) {
        console.log(
            `[CAMERA] Event ${eventType} sedang disabled.`
        );
        return;
    }

    const now = Date.now();
    const cooldownUntil = triggerCooldowns[eventType] || 0;

    if (now < cooldownUntil) {

        const remaining =
            ((cooldownUntil - now) / 1000).toFixed(1);

        console.log(
            `[CAMERA] ${eventType.toUpperCase()} masih cooldown ${remaining}s`
        );

        return;
    }

    const duration =
        Math.max(1, Number(rule.duration) || 5);

    const cooldown =
        Math.max(0, Number(rule.cooldown) || 0);

    /*
     * Kalau event yang sama masih aktif,
     * jangan kirim ON kedua kali.
     */
    if (triggerRunning[eventType]) {

        console.log(
            `[CAMERA] ${eventType.toUpperCase()} masih aktif, trigger diabaikan.`
        );

        return;
    }

    triggerRunning[eventType] = true;

    triggerCooldowns[eventType] =
        now + (duration + cooldown) * 1000;

    console.log(
        `[CAMERA] ${eventType.toUpperCase()} → ${rule.hotkey} ON selama ${duration}s`
    );

    // =========================
    // HOTKEY ON
    // =========================

    try {

        await sendDirectHotkey(rule.hotkey);

        console.log(
            `[CAMERA] ${eventType.toUpperCase()} HOTKEY ON terkirim: ${rule.hotkey}`
        );

    } catch (err) {

        console.error(
            `[CAMERA] Gagal HOTKEY ON ${eventType}:`,
            err.message
        );

        triggerRunning[eventType] = false;
        return;
    }

    // =========================
    // TIMER OFF
    // =========================

    triggerTimers[eventType] = setTimeout(async () => {

        console.log(
            `[CAMERA] ${eventType.toUpperCase()} waktunya OFF → ${rule.hotkey}`
        );

        try {

            /*
             * Tunggu sedikit sebelum OFF.
             * Ini memberi waktu Windows/TikTok
             * menyelesaikan input ON sebelumnya.
             */
            await new Promise(resolve =>
                setTimeout(resolve, 100)
            );

            await sendDirectHotkey(rule.hotkey);

            console.log(
                `[CAMERA] ${eventType.toUpperCase()} HOTKEY OFF terkirim: ${rule.hotkey}`
            );

        } catch (err) {

            console.error(
                `[CAMERA] Gagal HOTKEY OFF ${eventType}:`,
                err.message
            );

        } finally {

            triggerRunning[eventType] = false;
            triggerTimers[eventType] = null;

        }

    }, duration * 1000);
}

// Wrapper untuk tombol tes UI
function sendTikTokHotkey(hotkeyString) {
    return sendDirectHotkey(hotkeyString);
}

// ================== TEST CAMERA TRIGGER ==================
ipcMain.on('test-camera-trigger', async (event, rule) => {
    const targetHotkey = rule.hotkey || 'CTRL+G';
    const durationMs = Number(rule.duration || 5) * 1000;

    console.log(`[CAMERA DEBUG] Menerima request tes hotkey: ${targetHotkey}`);

    try {
        // Tekan Hotkey ON
        await sendDirectHotkey(targetHotkey);
        console.log(`[CAMERA TRIGGER] Hotkey ${targetHotkey} (ON) terkirim.`);

        // Tekan Hotkey OFF setelah durasi habis
        setTimeout(async () => {
            try {
                await sendDirectHotkey(targetHotkey);
                console.log(`[CAMERA TRIGGER] Hotkey ${targetHotkey} (OFF) terkirim.`);
            } catch (err) {
                console.error('[CAMERA TRIGGER] Gagal kirim OFF:', err.message);
            }
        }, durationMs);

    } catch (error) {
        console.error('[CAMERA TRIGGER] Gagal kirim ON:', error.message);
    }
});


let hotkeyConfig = {
    follow: {
        hotkey: "CTRL+F",
        duration: 5,
        cooldown: 3,
        enabled: true
    },
    share: {
        hotkey: "CTRL+S",
        duration: 5,
        cooldown: 3,
        enabled: true
    },
    gift: {
        hotkey: "CTRL+G",
        duration: 5,
        cooldown: 3,
        enabled: true
    }
};

let cameraTriggerEnabled = false;

const triggerCooldowns = {};
const triggerTimers = {};
const triggerRunning = {};


ipcMain.on('camera-trigger-toggle', (event, enabled) => {

    cameraTriggerEnabled = enabled === true;

    console.log(
        `[CAMERA TRIGGER] Master ${cameraTriggerEnabled ? 'AKTIF' : 'NONAKTIF'
        }`
    );

    event.sender.send(
        'camera-trigger-status',
        cameraTriggerEnabled
    );
});

ipcMain.handle('camera-trigger-get-status', () => {
    return cameraTriggerEnabled;
});


// Tangkap update hotkey jika diubah dari UI Kontrol Panel
ipcMain.on('update-hotkey-settings', (event, newSettings) => {

    if (!newSettings || typeof newSettings !== 'object') {
        return;
    }

    for (const [eventType, rule] of Object.entries(newSettings)) {

        if (!rule || !rule.hotkey) {
            continue;
        }

        hotkeyConfig[eventType] = {
            hotkey: String(rule.hotkey).toUpperCase(),
            duration: Math.max(1, Number(rule.duration) || 5),
            cooldown: Math.max(0, Number(rule.cooldown) || 0),
            enabled: rule.enabled !== false
        };
    }

    console.log(
        "⚙️ [CAMERA TRIGGER] Konfigurasi diperbarui:",
        JSON.stringify(hotkeyConfig, null, 2)
    );
});



// MATIKAN DOWNLOAD OTOMATIS (Biar nunggu user klik tombol install update)
autoUpdater.autoDownload = false;
autoUpdater.logger = console;

// DETEKSI HADWARE PERANGKAT
let cachedSpecs = null; // Variabel penyimpan data

ipcMain.handle('get-hardware-specs', async () => {
    if (cachedSpecs) {
        return cachedSpecs;
    }

    try {
        const cpu = await si.cpu();
        const gpu = await si.graphics();
        const mem = await si.mem();

        cachedSpecs = {
            cpu: cpu.brand || 'Unknown CPU',
            gpu: (gpu.controllers && gpu.controllers[0]) ? gpu.controllers[0].model : 'Unknown GPU',
            ram: `${Math.round(mem.total / 1024 / 1024 / 1024)}GB`
        };

        return cachedSpecs;
    } catch (e) {
        return { error: 'Gagal deteksi hardware' };
    }
});

let activationWin;
let mainWin;
let tray;
let deviceID = machineIdSync();

app.isQuiting = false;

let rotatorWin;
let pannerWin;
let blurWin;
let funnyEffectWin;
let playmusikWin;
let soundcloudWin;
let captionWin;
let coinSceneWin;
let aiControlWin;
let cameraTriggerWin = null;
let zoomMouseWin = null;
let giftAnimationWindow = null;
let giftUserMonitorWindow = null;
let subathonWindow = null;



// Tambahkan setelah app siap atau di area deklarasi IPC utama.
// =================================================================
// 🎁 GIFT ANIMATION SETTINGS & IPC HANDLERS
// =================================================================
const giftAnimationSettingsFile = path.join(
    app.getPath('userData'),
    'gift-animation-settings.json'
);

function readGiftAnimationSettings() {
    try {
        if (!fs.existsSync(giftAnimationSettingsFile)) return [];
        const parsed = JSON.parse(fs.readFileSync(giftAnimationSettingsFile, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('[Gift Animation] Gagal membaca settings:', error);
        return [];
    }
}

function writeGiftAnimationSettings(mappings) {
    try {
        fs.mkdirSync(path.dirname(giftAnimationSettingsFile), { recursive: true });
        const validData = Array.isArray(mappings) ? mappings : [];
        fs.writeFileSync(
            giftAnimationSettingsFile,
            JSON.stringify(validData, null, 2),
            'utf8'
        );
        return true;
    } catch (error) {
        console.error('[Gift Animation] Gagal menyimpan settings:', error);
        return false;
    }
}

// 1. Handler Load Data Settings
ipcMain.handle('gift-animation:load-settings', () => {
    return readGiftAnimationSettings();
});

// 2. Handler Save Data Settings + Sync ke Socket Server
ipcMain.handle('gift-animation:save-settings', (_event, mappings) => {
    const success = writeGiftAnimationSettings(mappings);
    if (success && socket && socket.connected) {
        socket.emit('gift-animation:save-settings', mappings);
    }
    return success;
});

// 3. Handler Tombol Test Overlay dari Control Panel
ipcMain.handle('gift-animation:test-video', (_event, mapping) => {
    console.log('🧪 [Gift Animation] Test Trigger dari Control Panel:', mapping);
    if (socket && socket.connected) {
        socket.emit('gift-animation:test', mapping);
    }
    return { ok: true, mapping };
});




// Fungsi pembantu untuk memfokuskan atau memicu pembukaan jendela via IPC
function safeFocusWindow(win, ipcChannel) {
    if (win) {
        win.focus();
    } else {
        ipcMain.emit(ipcChannel);
    }
}

// ======================= security tampilan aplikasi =================
function secureApplicationWindow(win) {
    if (!win || win.isDestroyed()) return;

    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);
    win.removeMenu();

    win.webContents.on('before-input-event', (event, input) => {
        const key = String(input.key || '').toUpperCase();

        // Mengaktifkan kembali Ctrl + R untuk refresh
        if ((input.control || input.meta) && key === 'R' && !input.alt) {
            event.preventDefault();

            if (input.shift) {
                win.webContents.reloadIgnoringCache();
            } else {
                win.webContents.reload();
            }

            return;
        }

        const blockDevTools =
            key === 'F12' ||
            (input.control && input.shift && ['I', 'J', 'C'].includes(key)) ||
            key === 'ALT';

        if (blockDevTools) {
            event.preventDefault();
        }
    });


    win.webContents.on('devtools-opened', () => {
        win.webContents.closeDevTools();
    });
}


// ================== LOGIKA TRAY MENU DINAMIS ==================
function renderTrayMenu(statusText = "Check for Update", enableInstall = false) {
    if (!tray) return;

    const menuTemplate = [
        { label: 'Buka App Utama', click: () => { if (mainWin) mainWin.show(); } },
        { type: 'separator' },
        { label: 'Open Caption Window', click: () => safeFocusWindow(captionWin, 'open-caption-window') },
        { label: 'Open Music Control', click: () => safeFocusWindow(playmusikWin, 'open-playmusik-window') },
        { label: 'Open SoundCloud Studio', click: () => safeFocusWindow(soundcloudWin, 'open-soundcloud-window') },
        { label: 'Open Panner Control', click: () => safeFocusWindow(pannerWin, 'open-panner-window') },
        { label: 'Open Zoom to Mouse Control', click: () => safeFocusWindow(zoomMouseWin, 'open-zoom-mouse-window') },
        { label: 'Open OBS Scene Switcher', click: () => safeFocusWindow(blurWin, 'open-blur-window') },
        { label: 'Open Rotator', click: () => safeFocusWindow(rotatorWin, 'open-rotator-window') },
        { type: 'separator' },
        {
            label: statusText,
            enabled: statusText === "Cek update terbaru",
            click: () => {
                renderTrayMenu("Cek update...", false);
                autoUpdater.checkForUpdates();
            }
        },
        {
            label: 'Install Update Bosku',
            enabled: enableInstall,
            click: () => {
                autoUpdater.quitAndInstall();
            }
        },
        { type: 'separator' },
        {
            label: 'Keluar',
            click: () => {
                app.isQuiting = true;
                app.quit();
            }
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    tray.setContextMenu(menu);
}

// ================== JEMBATAN IPC: BUKA WINDOW AUTO COIN SCENE SWITCHER ==================
ipcMain.on('open-coin-scene-window', () => {
    if (coinSceneWin && !coinSceneWin.isDestroyed()) {
        if (coinSceneWin.isMinimized()) {
            coinSceneWin.restore();
        }

        coinSceneWin.show();
        coinSceneWin.focus();
        return;
    }

    coinSceneWin = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 650,
        resizable: true,
        center: true,
        icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true,
        backgroundColor: '#0f0f13',
        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    coinSceneWin.setMenuBarVisibility(false);

    // Load halaman
    coinSceneWin.loadURL(
        'http://localhost:3000/tools/kontrol-coin-scene.html'
    );

    // Langsung maximize ketika dibuka
    coinSceneWin.maximize();

    coinSceneWin.on('closed', () => {
        coinSceneWin = null;
    });
});

// =================== JEMBATAN IP: BUKA WINDOW TANPIKAN ANIMATION GIFT TRIGGER ==================
ipcMain.on('open-gift-animation-window', () => {
    if (
        giftAnimationWindow &&
        !giftAnimationWindow.isDestroyed()
    ) {
        if (giftAnimationWindow.isMinimized()) {
            giftAnimationWindow.restore();
        }

        giftAnimationWindow.focus();
        return;
    }

    giftAnimationWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 650,
        backgroundColor: '#111111',
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    giftAnimationWindow.loadFile(
        path.join(
            __dirname,
            'tools',
            'gift-animation-control.html'
        )
    );

    // Tampilkan setelah halaman selesai dimuat
    giftAnimationWindow.once('ready-to-show', () => {
        giftAnimationWindow.show();

        // Buka dalam keadaan maximize
        giftAnimationWindow.maximize();
    });

    // Menampilkan error jika HTML gagal dimuat
    giftAnimationWindow.webContents.on(
        'did-fail-load',
        (event, errorCode, errorDescription, validatedURL) => {
            console.error(
                '[Gift Animation] Gagal membuka halaman:',
                errorCode,
                errorDescription,
                validatedURL
            );
        }
    );

    giftAnimationWindow.on('closed', () => {
        giftAnimationWindow = null;
    });
});

// =================== JEMBATAN IPC: BUKA WINDOW SUBATHON ==================
ipcMain.on('open-subathon-window', () => {
    if (subathonWindow && !subathonWindow.isDestroyed()) {
        if (subathonWindow.isMinimized()) {
            subathonWindow.restore();
        }

        subathonWindow.show();
        subathonWindow.focus();
        return;
    }

    subathonWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 650,
        backgroundColor: '#111111',
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    subathonWindow.loadFile(
        path.join(__dirname, 'tools', 'subathon-control.html')
    );

    subathonWindow.once('ready-to-show', () => {
        subathonWindow.show();
        subathonWindow.maximize();
    });

    subathonWindow.webContents.on(
        'did-fail-load',
        (event, errorCode, errorDescription, validatedURL) => {
            console.error(
                '[Subathon] Gagal membuka halaman:',
                errorCode,
                errorDescription,
                validatedURL
            );
        }
    );

    subathonWindow.on('closed', () => {
        subathonWindow = null;
    });
});


// =================== JEMBATAN IPC: BUKA WINDOW MONITORING USER GIFT ==================
ipcMain.on('open-gift-user-monitor-window', () => {
    if (giftUserMonitorWindow && !giftUserMonitorWindow.isDestroyed()) {
        if (giftUserMonitorWindow.isMinimized()) giftUserMonitorWindow.restore();
        giftUserMonitorWindow.show();
        giftUserMonitorWindow.focus();
        return;
    }

    giftUserMonitorWindow = new BrowserWindow({
        width: 560,
        height: 820,
        minWidth: 460,
        minHeight: 500,
        center: true,
        backgroundColor: '#101014',
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    giftUserMonitorWindow.loadFile(
        path.join(__dirname, 'tools', 'gift-user-monitor.html')
    );

    giftUserMonitorWindow.once('ready-to-show', () => {
        giftUserMonitorWindow.show();
    });

    giftUserMonitorWindow.webContents.on(
        'did-fail-load',
        (event, errorCode, errorDescription, validatedURL) => {
            console.error(
                '[Gift User Monitor] Gagal membuka halaman:',
                errorCode,
                errorDescription,
                validatedURL
            );
        }
    );

    giftUserMonitorWindow.on('closed', () => {
        giftUserMonitorWindow = null;
    });
});

// ================== JEMBATAN IPC: BUKA WINDOW TIKTOK CAMERA EFECK TRIGGER ==================
ipcMain.on('open-camera-trigger-window', () => {
    if (cameraTriggerWin && !cameraTriggerWin.isDestroyed()) {
        if (cameraTriggerWin.isMinimized()) {
            cameraTriggerWin.restore();
        }

        cameraTriggerWin.show();
        cameraTriggerWin.focus();
        return;
    }

    cameraTriggerWin = new BrowserWindow({
        width: 1600,
        height: 900,
        resizable: true,
        center: true,
        icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true,
        backgroundColor: '#0f0f13',
        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    cameraTriggerWin.maximize();
    cameraTriggerWin.setMenuBarVisibility(false);
    cameraTriggerWin.loadURL('http://localhost:3000/tools/kontrol-camera-trigger.html');

    cameraTriggerWin.on('closed', () => {
        cameraTriggerWin = null;
    });
});


// ================== JEMBATAN IPC: BUKA WINDOW AI VOICE ASSISTANT ==================
ipcMain.on('open-ai-control-window', () => {

    // ============================================================
    // JIKA WINDOW SUDAH ADA
    // ============================================================
    if (aiControlWin && !aiControlWin.isDestroyed()) {

        if (aiControlWin.isMinimized()) {
            aiControlWin.restore();
        }

        aiControlWin.show();
        aiControlWin.focus();

        if (!aiControlWin.isMaximized()) {
            aiControlWin.maximize();
        }

        return;
    }

    // ============================================================
    // BUAT WINDOW AI CONTROL
    // ============================================================
    aiControlWin = new BrowserWindow({
        width: 1400,
        height: 900,

        minWidth: 1000,
        minHeight: 650,

        resizable: true,
        center: true,

        icon: path.join(__dirname, 'wd_logo.ico'),

        autoHideMenuBar: true,
        backgroundColor: '#0f0f13',

        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    // Hilangkan menu bar
    aiControlWin.setMenuBarVisibility(false);

    // Load AI Control
    aiControlWin.loadURL(
        'http://localhost:3000/ai-control'
    );

    // ============================================================
    // MAXIMIZE OTOMATIS
    // ============================================================
    aiControlWin.maximize();

    // ============================================================
    // WINDOW DITUTUP
    // ============================================================
    aiControlWin.on('closed', () => {
        aiControlWin = null;
    });
});


// ================== JEMBATAN IPC: BUKA WINDOW CAPTION ==================
ipcMain.on('open-caption-window', () => {
    if (captionWin) { captionWin.focus(); return; }
    captionWin = new BrowserWindow({
        width: 800, height: 200, transparent: true, frame: false, alwaysOnTop: true, resizable: true, center: true,
        icon: path.join(__dirname, 'wd_logo.ico'),
        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });
    captionWin.setMenuBarVisibility(false);
    captionWin.loadURL('http://localhost:3000/tools/caption.html');
    captionWin.on('closed', () => { captionWin = null; });
});

// ================== JEMBATAN IPC: BUKA WINDOW DASHBOARD MUSIC YOUTUBE==================
ipcMain.on('open-playmusik-window', () => {
    if (playmusikWin) {
        if (playmusikWin.isMinimized()) {
            playmusikWin.restore();
        }

        playmusikWin.maximize();
        playmusikWin.focus();
        return;
    }

    playmusikWin = new BrowserWindow({
        width: 1500,
        height: 1000,
        minWidth: 900,
        minHeight: 600,
        resizable: true,
        center: true,
        show: false,
        icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true,
        backgroundColor: '#0B0E14',

        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    playmusikWin.setMenuBarVisibility(false);

    playmusikWin.loadURL(
        'http://localhost:3000/playmusik.html'
    );

    playmusikWin.once('ready-to-show', () => {
        playmusikWin.maximize();
        playmusikWin.show();
        playmusikWin.focus();
    });

    playmusikWin.on('closed', () => {
        playmusikWin = null;
    });
});



// ================== JEMBATAN IPC: BUKA WINDOW PANNER ==================
ipcMain.on('open-panner-window', () => {

    // Kalau window sudah terbuka
    if (pannerWin && !pannerWin.isDestroyed()) {

        if (pannerWin.isMinimized()) {
            pannerWin.restore();
        }

        pannerWin.show();
        pannerWin.focus();

        if (!pannerWin.isMaximized()) {
            pannerWin.maximize();
        }

        return;
    }

    pannerWin = new BrowserWindow({

        width: 1400,
        height: 900,

        minWidth: 1000,
        minHeight: 650,

        resizable: true,

        center: true,

        icon: path.join(
            __dirname,
            'wd_logo.ico'
        ),

        autoHideMenuBar: true,

        backgroundColor: '#08090d',

        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }

    });

    pannerWin.setMenuBarVisibility(false);

    pannerWin.loadURL(
        'http://localhost:3000/tools/kontrol-panner.html'
    );

    // Langsung fullscreen/maximized
    pannerWin.maximize();

    pannerWin.on('closed', () => {
        pannerWin = null;
    });

});


// ================== JEMBATAN IPC: BUKA WINDOW ZOOM TO MOUSE ==================
ipcMain.on('open-zoom-mouse-window', () => {
    // Jika window sudah dibuat, tampilkan kembali
    if (zoomMouseWin && !zoomMouseWin.isDestroyed()) {
        if (zoomMouseWin.isMinimized()) {
            zoomMouseWin.restore();
        }

        zoomMouseWin.show();
        zoomMouseWin.focus();

        if (!zoomMouseWin.isMaximized()) {
            zoomMouseWin.maximize();
        }

        return;
    }

    // Buat window baru
    zoomMouseWin = new BrowserWindow({
        width: 1400,
        height: 900,

        minWidth: 1000,
        minHeight: 650,

        resizable: true,
        center: true,

        icon: path.join(__dirname, 'wd_logo.ico'),

        autoHideMenuBar: true,
        backgroundColor: '#08090d',

        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false,

            // Window tetap berjalan saat diminimize/background
            backgroundThrottling: false
        }
    });

    zoomMouseWin.setMenuBarVisibility(false);

    zoomMouseWin.loadURL(
        'http://localhost:3000/tools/kontrol-zoom-mouse.html'
    );

    zoomMouseWin.maximize();

    zoomMouseWin.on('closed', () => {
        zoomMouseWin = null;
    });
});


// ================== JEMBATAN IPC: BUKA WINDOW OBS Gift Scene Switcher ==================
ipcMain.on('open-blur-window', () => {

    // ============================================================
    // KALAU WINDOW SUDAH ADA
    // ============================================================
    if (blurWin && !blurWin.isDestroyed()) {

        // Kalau sedang minimize → restore
        if (blurWin.isMinimized()) {
            blurWin.restore();
        }

        // Tampilkan dan fokus
        blurWin.show();
        blurWin.focus();

        // Pastikan maximize
        if (!blurWin.isMaximized()) {
            blurWin.maximize();
        }

        return;
    }


    // ============================================================
    // BUAT WINDOW BARU
    // ============================================================
    blurWin = new BrowserWindow({

        width: 1400,
        height: 900,

        minWidth: 1000,
        minHeight: 650,

        resizable: true,

        center: true,

        icon: path.join(
            __dirname,
            'wd_logo.ico'
        ),

        autoHideMenuBar: true,

        backgroundColor: '#08090d',

        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }

    });


    // ============================================================
    // HILANGKAN MENU BAR
    // ============================================================
    blurWin.setMenuBarVisibility(false);


    // ============================================================
    // LOAD HALAMAN
    // ============================================================
    blurWin.loadURL(
        'http://localhost:3000/tools/kontrol-blur.html'
    );


    // ============================================================
    // LANGSUNG FULL / MAXIMIZE
    // ============================================================
    blurWin.maximize();


    // ============================================================
    // RESET VARIABLE SAAT WINDOW DITUTUP
    // ============================================================
    blurWin.on('closed', () => {

        blurWin = null;

    });

});

// ================== JEMBATAN IPC: BUKA WINDOW ROTATOR ==================
ipcMain.on('open-rotator-window', () => {

    // Kalau window sudah ada
    if (rotatorWin && !rotatorWin.isDestroyed()) {

        if (rotatorWin.isMinimized()) {
            rotatorWin.restore();
        }

        rotatorWin.show();
        rotatorWin.focus();

        // Pastikan selalu maximize
        if (!rotatorWin.isMaximized()) {
            rotatorWin.maximize();
        }

        return;
    }


    // Buat window baru
    rotatorWin = new BrowserWindow({

        width: 1400,
        height: 900,

        minWidth: 1000,
        minHeight: 650,

        resizable: true,

        center: true,

        icon: path.join(
            __dirname,
            'wd_logo.ico'
        ),

        autoHideMenuBar: true,

        backgroundColor: '#08080c',

        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false,

            // Supaya rotator tetap berjalan
            // walaupun window diminimize
            backgroundThrottling: false
        }

    });

    // Hilangkan menu bar
    rotatorWin.setMenuBarVisibility(false);

    // Load halaman rotator
    rotatorWin.loadURL(
        'http://localhost:3000/tools/rotator.html'
    );

    // Langsung maximize
    rotatorWin.maximize();

    // Ketika window ditutup
    rotatorWin.on('closed', () => {

        rotatorWin = null;

    });

});

/// ================== AUTO LOGIN ==================
async function checkAutoLogin() {
    try {

        console.log("🔐 Mengecek HWID ke Cloudflare License Server...");

        const response = await fetch(
            'https://webdev-license-api.antoyusri021.workers.dev/auto_login',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    hwid: deviceID
                })
            }
        );

        const result = await response.json();

        console.log("🔐 Response Auto Login:", result);

        if (result.success && result.valid) {

            console.log("✅ HWID Terdaftar, Masuk Otomatis...");
            startApp();

        } else {

            console.log("⚠️ HWID belum terdaftar.");
            createActivationWindow();

        }

    } catch (err) {

        console.error("❌ Gagal mengecek Auto Login:", err);
        createActivationWindow();

    }
}

// ================== WINDOW AKTIVASI ==================
function createActivationWindow() {
    activationWin = new BrowserWindow({
        width: 450, height: 550, frame: false, resizable: false, icon: path.join(__dirname, 'wd_logo.ico'),
        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    activationWin.loadFile('activation.html');
}

// ================== CEK LICENSE MANUAL ==================
ipcMain.on('check-license', async (event, inputKey) => {
    try {
        const licenseKey = String(inputKey || '').trim();

        if (!licenseKey) {
            event.reply('license-status', {
                success: false,
                message: 'KODE LISENSI HARUS DIISI!'
            });
            return;
        }

        console.log('🔐 Mengecek license ke Cloudflare...');

        const response = await fetch(
            'https://webdev-license-api.antoyusri021.workers.dev/verify_license',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    license_key: licenseKey,
                    hwid: deviceID
                })
            }
        );

        const result = await response.json();

        console.log('🔐 Response License:', result);

        if (result.success && result.valid) {

            event.reply('license-status', {
                success: true,
                name: result.name || ''
            });

            startApp();

        } else {

            event.reply('license-status', {
                success: false,
                message:
                    result.message ||
                    'LISENSI TIDAK VALID!'
            });
        }

    } catch (err) {

        console.error('❌ Error License:', err);

        event.reply('license-status', {
            success: false,
            message: 'KONEKSI KE SERVER LICENSE BERMASALAH!'
        });
    }
});

// ================== START APP UTAMA ==================
function startApp() {
    if (mainWin) return;

    mainWin = new BrowserWindow({
        width: 1200, height: 750, minWidth: 1000, minHeight: 650, center: true, show: false,
        icon: path.join(__dirname, 'wd_logo.ico'), autoHideMenuBar: true,
        webPreferences: {
            devTools: false,
            nodeIntegration: true,
            contextIsolation: false
        }

    });
    mainWin.maximize();
    mainWin.show();

    // ================== TIKTOK SERVER ==================
    try {
        require('./server.js');
    } catch (e) {
        console.log("Server status:", e.message);
    }

    // ================== YOUTUBE SERVER ==================
    try {
        require('./youtube-server.js');
        console.log("▶️ YouTube Server berhasil dijalankan.");
    } catch (e) {
        console.error("❌ YouTube Server gagal dijalankan:", e.message);
    }

    // Load UI
    setTimeout(() => {
        mainWin.loadURL('http://localhost:3000/index.html');

        if (activationWin) {
            activationWin.close();
            activationWin = null;
        }
    }, 1500);

    // ❌ CLOSE → HIDE (BACKGROUND MODE) + NOTIFIKASI
    mainWin.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWin.hide();

            if (Notification.isSupported()) {
                const trayNotif = new Notification({
                    title: 'WebDev Overlay Stream',
                    body: 'Aplikasi disembunyikan dan tetap berjalan aktif di system tray kamu.',
                    icon: path.join(__dirname, 'webdev.ico'),
                    silent: false
                });

                trayNotif.show();
                trayNotif.on('click', () => { mainWin.show(); });
            }
        }
    });

    // 🧩 TRAY INITIALIZATION
    if (!tray) {
        tray = new Tray(path.join(__dirname, 'webdev.ico'));
        tray.setToolTip('WebDev Sync App');
        renderTrayMenu(); // Panggil fungsi render menu dinamis pertama kali

        tray.on('click', () => {
            mainWin.show();
        });
    }

    // Jalankan pengecekan update diam-diam saat aplikasi masuk dashboard utama
    autoUpdater.checkForUpdatesAndNotify();
}

// ================== EVENT LISTENER AUTO UPDATER ==================
autoUpdater.on('update-available', (info) => {
    renderTrayMenu("Downloading update v" + info.version + "...", false);
    autoUpdater.downloadUpdate();
});

autoUpdater.on('update-not-available', () => {
    renderTrayMenu("Check for Update", false);

    // dialog.showMessageBox({ 
    //     type: 'info',
    //     title: 'Info Update',
    //     message: "Aplikasi kamu sudah versi terbaru, brow!" 
    // });

    renderTrayMenu();
});

autoUpdater.on('update-downloaded', (info) => {
    renderTrayMenu("Update v" + info.version + " Ready!", true);

    dialog.showMessageBox({
        type: 'info',
        title: 'Update Sukses Diunduh!',
        message: `Versi ${info.version} berhasil didownload! Silakan klik kanan ikon di Tray bawah lalu klik 'Install Update 🚀' untuk memperbarui aplikasi otomatis.`,
        buttons: ['OK']
    });
});

autoUpdater.on('error', (err) => {
    renderTrayMenu("Check for Update", false);
    console.error("Gagal melakukan update:", err);
    renderTrayMenu();
});


// ================== APP READY ==================
app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    checkAutoLogin();
});


app.on('browser-window-created', (event, window) => {
    secureApplicationWindow(window);

    window.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const target = new URL(url);
            const hostname = target.hostname.toLowerCase();

            const isTikTok =
                hostname === 'tiktok.com' ||
                hostname.endsWith('.tiktok.com');

            const isSociabuzz =
                hostname === 'sociabuzz.com' ||
                hostname.endsWith('.sociabuzz.com');

            const isAllowedExternal =
                target.protocol === 'https:' &&
                (isTikTok || isSociabuzz);

            if (isAllowedExternal) {
                shell.openExternal(target.toString());
                return { action: 'deny' };
            }


            const isInternalApp =
                target.protocol === 'http:' &&
                (target.hostname === 'localhost' || target.hostname === '127.0.0.1') &&
                (target.port === '3000' || target.port === '');

            if (isInternalApp) {
                return { action: 'allow' };
            }
        } catch (error) {
            console.error('Gagal membuka link eksternal:', error);
        }

        return { action: 'deny' };
    });

});

app.on('window-all-closed', () => {
    // Jangan quit karena kita pakai tray
});

app.on('activate', () => {
    if (mainWin) {
        mainWin.show();
    }
});


// =================================================================
// 🔗 SOCKET LISTENERS UNTUK EVENT TIKTOK & TOMBOL TEST
// =================================================================

const socket = ioClient('http://127.0.0.1:3000', {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 15000
});

socket.on('connect', () => {
    console.log('🟢 [CAMERA SOCKET] Electron terhubung ke server Socket.IO');
});

socket.on('disconnect', (reason) => {
    console.log('🔴 [CAMERA SOCKET] Terputus:', reason);
});

// Listener untuk Event Follow (Aktif 5 Detik)
socket.on('new-follower', (data) => {

    console.log("🔔 [EVENT FOLLOW] Trigger Camera");

    triggerCameraRule('follow');

});


socket.on('new-share', (data) => {

    console.log("🔔 [EVENT SHARE] Trigger Camera");

    triggerCameraRule('share');

});


socket.on('new-gift', (data) => {

    console.log("🔔 [EVENT GIFT] Trigger Camera");

    triggerCameraRule('gift');

});
