const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { execFile } = require('child_process'); // 👈 Gunakan execFile
const ioClient = require('socket.io-client');
const { createClient } = require('@supabase/supabase-js');
const { machineIdSync } = require('node-machine-id');
const si = require('systeminformation');

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


// ================== KONFIGURASI ==================
const supabase = createClient(
    'https://eqlcidlxjlsalwsiuisu.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxbGNpZGx4amxzYWx3c2l1aXN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNDM1OTIsImV4cCI6MjA4NzYxOTU5Mn0.th-VhkPig0rrcWnPG4CfjgK0acEuyZqrDSFANLuRUHs'
);

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

let karaokeWin;
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


// Fungsi pembantu untuk memfokuskan atau memicu pembukaan jendela via IPC
function safeFocusWindow(win, ipcChannel) {
    if (win) {
        win.focus();
    } else {
        ipcMain.emit(ipcChannel);
    }
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
        { label: 'Open OBS Scene Switcher', click: () => safeFocusWindow(blurWin, 'open-blur-window') },
        { label: 'Open Karaoke Premium', click: () => safeFocusWindow(karaokeWin, 'open-karaoke-window') },
        { label: 'Open Rotator', click: () => safeFocusWindow(rotatorWin, 'open-rotator-window') },
        { type: 'separator' },
        {
            label: statusText,
            enabled: statusText === "Check for Update",
            click: () => {
                renderTrayMenu("Checking updates...", false);
                autoUpdater.checkForUpdates();
            }
        },
        {
            label: 'Install Update 🚀',
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
        width: 820,
        height: 900,
        resizable: true,
        center: true,
        icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true,
        backgroundColor: '#0f0f13',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    coinSceneWin.setMenuBarVisibility(false);
    coinSceneWin.loadURL('http://localhost:3000/tools/kontrol-coin-scene.html');

    coinSceneWin.on('closed', () => {
        coinSceneWin = null;
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
    if (aiControlWin && !aiControlWin.isDestroyed()) {
        if (aiControlWin.isMinimized()) {
            aiControlWin.restore();
        }
        aiControlWin.show();
        aiControlWin.focus();
        return;
    }

    aiControlWin = new BrowserWindow({
        width: 900,
        height: 780,
        minWidth: 720,
        minHeight: 600,
        resizable: true,
        center: true,
        icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true,
        backgroundColor: '#0f0f13',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    aiControlWin.setMenuBarVisibility(false);
    aiControlWin.loadURL('http://localhost:3000/ai-control');


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
        webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
    });
    captionWin.setMenuBarVisibility(false);
    captionWin.loadURL('http://localhost:3000/tools/caption.html');
    captionWin.on('closed', () => { captionWin = null; });
});

// ================== JEMBATAN IPC: BUKA WINDOW DASHBOARD MUSIC YOUTUBE==================
ipcMain.on('open-playmusik-window', () => {
    if (playmusikWin) { playmusikWin.focus(); return; }
    playmusikWin = new BrowserWindow({
        width: 1300,
        height: 960,
        resizable: true,
        center: true,
        icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true,
        backgroundColor: '#0B0E14',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    playmusikWin.setMenuBarVisibility(false);
    playmusikWin.loadURL('http://localhost:3000/playmusik.html');
    playmusikWin.on('closed', () => { playmusikWin = null; });
});


// ================== JEMBATAN IPC: BUKA WINDOW PANNER ==================
ipcMain.on('open-panner-window', () => {
    if (pannerWin) { pannerWin.focus(); return; }
    pannerWin = new BrowserWindow({
        width: 720, height: 780, resizable: false, center: true, icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true, backgroundColor: '#0f0f13',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    pannerWin.setMenuBarVisibility(false);
    pannerWin.loadURL('http://localhost:3000/tools/kontrol-panner.html');
    pannerWin.on('closed', () => { pannerWin = null; });
});


// ================== JEMBATAN IPC: BUKA WINDOW OBS Gift Scene Switcher ==================
ipcMain.on('open-blur-window', () => {
    if (blurWin) { blurWin.focus(); return; }
    blurWin = new BrowserWindow({
        width: 800, height: 900, resizable: false, center: true, icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true, backgroundColor: '#0f0f13',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    blurWin.setMenuBarVisibility(false);
    blurWin.loadURL('http://localhost:3000/tools/kontrol-blur.html');
    blurWin.on('closed', () => { blurWin = null; });
});

// ================== JEMBATAN IPC: BUKA WINDOW KARAOKE PREMIUM ==================
ipcMain.on('open-karaoke-window', () => {
    if (karaokeWin) { karaokeWin.focus(); return; }
    karaokeWin = new BrowserWindow({
        width: 960, height: 580, minWidth: 800, minHeight: 500, center: true, icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true, backgroundColor: '#0f111a',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    karaokeWin.setMenuBarVisibility(false);
    karaokeWin.loadURL('http://localhost:3000/karaoke.html');
    karaokeWin.on('closed', () => { karaokeWin = null; });
});

// ================== JEMBATAN IPC: BUKA WINDOW ROTATOR ==================
ipcMain.on('open-rotator-window', () => {
    if (rotatorWin) { rotatorWin.focus(); return; }
    rotatorWin = new BrowserWindow({
        width: 900, height: 700, minWidth: 800, minHeight: 600, center: true, icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true, backgroundColor: '#0f0f13',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    rotatorWin.setMenuBarVisibility(false);
    rotatorWin.loadURL('http://localhost:3000/tools/rotator.html');
    rotatorWin.on('closed', () => { rotatorWin = null; });
});

// ================== AUTO LOGIN ==================
async function checkAutoLogin() {
    try {
        const { data, error } = await supabase
            .from('licenses')
            .select('*')
            .eq('hwid', deviceID)
            .single();

        if (data && !error) {
            console.log("HWID Terdaftar, Masuk Otomatis...");
            startApp();
        } else {
            createActivationWindow();
        }
    } catch (err) {
        createActivationWindow();
    }
}

// ================== WINDOW AKTIVASI ==================
function createActivationWindow() {
    activationWin = new BrowserWindow({
        width: 450, height: 550, frame: false, resizable: false, icon: path.join(__dirname, 'wd_logo.ico'),
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    activationWin.loadFile('activation.html');
}

// ================== CEK LICENSE MANUAL ==================
ipcMain.on('check-license', async (event, inputKey) => {
    try {
        const { data, error } = await supabase
            .from('licenses')
            .select('*')
            .eq('license_key', inputKey)
            .single();

        if (data) {
            if (!data.hwid || data.hwid === "" || data.hwid === "NULL") {
                await supabase
                    .from('licenses')
                    .update({ hwid: deviceID })
                    .eq('license_key', inputKey);

                event.reply('license-status', { success: true });
                startApp();
            }
            else if (data.hwid === deviceID) {
                event.reply('license-status', { success: true });
                startApp();
            }
            else {
                event.reply('license-status', { success: false, message: 'LISENSI TERKUNCI DI PC LAIN!' });
            }
        } else {
            event.reply('license-status', { success: false, message: 'LISENSI TIDAK DITEMUKAN!' });
        }
    } catch (err) {
        event.reply('license-status', { success: false, message: 'KONEKSI BERMASALAH!' });
    }
});

// ================== START APP UTAMA ==================
function startApp() {
    if (mainWin) return;

    mainWin = new BrowserWindow({
        width: 1200, height: 750, minWidth: 1000, minHeight: 650, center: true, show: false,
        icon: path.join(__dirname, 'wd_logo.ico'), autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }

    });
    mainWin.maximize();
    mainWin.show();

    try {
        require('./server.js');
    } catch (e) {
        console.log("Server status:", e.message);
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
    checkAutoLogin();
});

app.on('browser-window-created', (event, window) => {
    window.setMenuBarVisibility(false);
    window.setAutoHideMenuBar(true);

    window.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const target = new URL(url);
            const isTikTok =
                target.protocol === 'https:' &&
                (target.hostname === 'tiktok.com' ||
                    target.hostname === 'www.tiktok.com' ||
                    target.hostname.endsWith('.tiktok.com'));

            if (isTikTok) {
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
            console.error('Gagal membuka profil TikTok:', error);
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
    transports: ['websocket', 'polling'],
    reconnection: true
});

socket.on('connect', () => {
    console.log("🔗 Electron Main Process berhasil terhubung ke Socket Server!");
});

socket.on('connect', () => {
    console.log('🟢 [CAMERA SOCKET] Terhubung ke server Socket.IO');
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