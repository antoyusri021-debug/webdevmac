const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { machineIdSync } = require('node-machine-id');

// ================== KONFIGURASI ==================
const supabase = createClient(
    'https://eqlcidlxjlsalwsiuisu.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxbGNpZGx4amxzYWx3c2l1aXN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNDM1OTIsImV4cCI6MjA4NzYxOTU5Mn0.th-VhkPig0rrcWnPG4CfjgK0acEuyZqrDSFANLuRUHs'
);

let activationWin;
let mainWin;
let tray;
let deviceID = machineIdSync();

app.isQuiting = false;

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
        width: 450,
        height: 550,
        frame: false,
        resizable: false,
        icon: path.join(__dirname, 'wd_logo.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
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
                event.reply('license-status', {
                    success: false,
                    message: 'LISENSI TERKUNCI DI PC LAIN!'
                });
            }
        } else {
            event.reply('license-status', {
                success: false,
                message: 'LISENSI TIDAK DITEMUKAN!'
            });
        }
    } catch (err) {
        event.reply('license-status', {
            success: false,
            message: 'KONEKSI BERMASALAH!'
        });
    }
});

// ================== START APP UTAMA ==================
function startApp() {
    if (mainWin) return; // biar gak double

    mainWin = new BrowserWindow({
        width: 1300,
        height: 850,
        icon: path.join(__dirname, 'wd_logo.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // 🚀 Jalankan server
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

    // ❌ CLOSE → HIDE (BACKGROUND MODE)
    mainWin.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWin.hide();
        }
    });

    // 🧩 TRAY
    if (!tray) {
        tray = new Tray(path.join(__dirname, 'webdev.ico'));

        const menu = Menu.buildFromTemplate([
            {
                label: 'Buka App',
                click: () => mainWin.show()
            },
            {
                label: 'Keluar',
                click: () => {
                    app.isQuiting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('Overlay App');
        tray.setContextMenu(menu);

        tray.on('click', () => {
            mainWin.show();
        });
    }
}

// ================== APP READY ==================
app.whenReady().then(checkAutoLogin);

// ================== MAC / WINDOWS BEHAVIOR ==================
app.on('window-all-closed', () => {
    // Jangan quit karena kita pakai tray
});

app.on('activate', () => {
    if (mainWin) {
        mainWin.show();
    }
});