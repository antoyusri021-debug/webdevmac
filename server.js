/**-------------------WEBDEV---------------------
 * CORE MODULE SETUP
 ------------------------------------------------*/
const play = require('play-dl');
const youTubeSearchApi = require('youtube-search-api');
const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const googleTTS = require('google-tts-api');
const si = require('systeminformation');
const ping = require('ping');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });
if (!process.env.GROQ_API_KEY) {
    console.warn('⚠️ GROQ_API_KEY belum diatur. Fitur AI akan gagal sampai environment variable diisi.');
}

const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// =================================================================
// 📂 FILE SYSTEM & STATE INITIALIZATION
// =================================================================
let saveDir = __dirname;
try {
    const { app } = require('electron');
    if (app) {
        saveDir = app.getPath('userData');
    }
} catch (e) {
    // Jalankan normal jika bukan environment Electron
}

const filePath = path.join(saveDir, 'brand-data.json');
// AUTO COIN SCENE: file permanen untuk menyimpan semua aturan video
const coinSceneRulesPath = path.join(saveDir, 'coin-scene-rules.json');

// AUTO COIN SCENE: folder video milik fitur baru
const coinVideoDir = path.join(saveDir, 'coin-videos');

if (!fs.existsSync(coinVideoDir)) {
    fs.mkdirSync(coinVideoDir, { recursive: true });
}

console.log('📁 [COIN VIDEO DIR]', coinVideoDir);

let brandTexts = ["WELCOME TO STREAM"];

if (fs.existsSync(filePath)) {
    try {
        const rawData = fs.readFileSync(filePath, 'utf8');
        brandTexts = JSON.parse(rawData);
    } catch (e) {
        console.log("Gagal load file json, pake default aja", e);
    }
}


// =================================================================
// 🎶 HELPER FITUR LIRIK (LRCLIB & LRC PARSER)
// =================================================================

// 1. Membersihkan Judul YouTube dari Teks Pengganggu
function cleanYouTubeTitle(title) {
    if (!title) return '';
    return title
        .replace(/\(official music video\)/gi, '')
        .replace(/\(official video\)/gi, '')
        .replace(/\(official audio\)/gi, '')
        .replace(/\[official lyric video\]/gi, '')
        .replace(/\[official video\]/gi, '')
        .replace(/\[lyric video\]/gi, '')
        .replace(/\(lyric\)/gi, '')
        .replace(/\[lyric\]/gi, '')
        .replace(/\(audio\)/gi, '')
        .replace(/\[audio\]/gi, '')
        .replace(/\(mv\)/gi, '')
        .replace(/\[mv\]/gi, '')
        .replace(/\[.*\]/g, '') // Hapus semua teks di dalam [ ]
        .trim();
}

// 2. Parser format LRC [mm:ss.xx] -> Detik
function parseLrc(lrcText) {
    if (!lrcText) return [];
    const lines = lrcText.split('\n');
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
        const match = timeRegex.exec(line);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
            const timeInSeconds = minutes * 60 + seconds + milliseconds / 1000;
            const text = line.replace(timeRegex, '').trim();

            if (text) {
                result.push({
                    time: Number(timeInSeconds.toFixed(2)),
                    text: text
                });
            }
        }
    }
    return result;
}


// =================================================================
// ⚡ CACHE LIRIK AGAR TIDAK MENGAMBIL ULANG
// =================================================================
const lyricsCache = new Map();

async function getLyricsCached(title) {
    const cacheKey = String(title || '').trim().toLowerCase();

    if (!cacheKey) return [];

    if (lyricsCache.has(cacheKey)) {
        console.log(`⚡ Lirik dari cache: ${title}`);
        return lyricsCache.get(cacheKey);
    }

    try {
        const cleanedTitle = cleanYouTubeTitle(title);
        let track = cleanedTitle;
        let artist = '';

        if (cleanedTitle.includes('-') || cleanedTitle.includes('–')) {
            const parts = cleanedTitle.split(/[-–]/);
            artist = parts[0].trim();
            track = parts.slice(1).join('-').trim();
        }

        const targetUrl =
            `https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}` +
            `${artist ? `&artist_name=${encodeURIComponent(artist)}` : ''}`;

        const response = await fetch(targetUrl);
        let lyrics = [];

        if (response.ok) {
            const data = await response.json();

            if (data.syncedLyrics) {
                lyrics = parseLrc(data.syncedLyrics)
                    .sort((a, b) => a.time - b.time);
            }
        }

        lyricsCache.set(cacheKey, lyrics);
        return lyrics;
    } catch (error) {
        console.error(`❌ Gagal mengambil lirik ${title}:`, error.message);
        return [];
    }
}


// =================================================================
// 🌐 ROUTE API LIRIK
// =================================================================
app.get('/api/lyrics', async (req, res) => {
    try {
        const rawTitle = req.query.title || '';
        if (!rawTitle) {
            return res.status(400).json({ success: false, message: 'Judul lagu wajib diisi' });
        }

        const cleanedTitle = cleanYouTubeTitle(rawTitle);
        console.log(`🎤 [LIRIK] Mencari lirik untuk: "${cleanedTitle}" (Original: "${rawTitle}")`);

        // Memisah Artis & Judul jika menggunakan separator "-" atau "–"
        let track = cleanedTitle;
        let artist = req.query.artist || '';

        if (!artist && (cleanedTitle.includes('-') || cleanedTitle.includes('–'))) {
            const parts = cleanedTitle.split(/[-–]/);
            artist = parts[0].trim();
            track = parts.slice(1).join('-').trim();
        }

        // Hit ke LRCLIB API
        const targetUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}${artist ? `&artist_name=${encodeURIComponent(artist)}` : ''}`;

        const response = await fetch(targetUrl);

        if (!response.ok) {
            // Jika tidak ketemu dengan nama artis, coba search judulnya saja ke API LRCLIB
            const fallbackUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanedTitle)}`;
            const fallbackRes = await fetch(fallbackUrl);
            if (fallbackRes.ok) {
                const searchData = await fallbackRes.json();
                if (Array.isArray(searchData) && searchData.length > 0 && searchData[0].syncedLyrics) {
                    const parsed = parseLrc(searchData[0].syncedLyrics);
                    return res.json({ success: true, isSynced: true, lyrics: parsed });
                }
            }
            return res.json({ success: false, lyrics: [], message: 'Lirik tidak ditemukan' });
        }

        const data = await response.json();

        if (data.syncedLyrics) {
            const parsedLyrics = parseLrc(data.syncedLyrics);
            return res.json({
                success: true,
                isSynced: true,
                title: data.trackName,
                artist: data.artistName,
                lyrics: parsedLyrics
            });
        } else {
            return res.json({ success: false, lyrics: [], message: 'Synced lyrics tidak tersedia' });
        }

    } catch (error) {
        console.error("❌ [LIRIK ERROR]:", error);
        res.status(500).json({ success: false, message: 'Gagal mengambil lirik' });
    }
});
















// =================================================================
// 🌐 EXPRESS ROUTES
// =================================================================
app.use(express.static(__dirname));
// AUTO COIN SCENE: video dapat dibuka OBS melalui URL localhost
app.use('/coin-videos', express.static(coinVideoDir));
app.use('/themes', express.static(path.join(__dirname, 'themes')));
app.use('/overlays', express.static(path.join(__dirname, 'themes', 'overlaytema')));
app.use('/pages', express.static(path.join(__dirname, 'pages')));
app.use('/musik', express.static(path.join(__dirname, 'themes', 'musik')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/monitoring', (req, res) => res.sendFile(path.join(__dirname, 'monitoring.html')));
app.get('/ai-control', (req, res) => res.sendFile(path.join(__dirname, 'tools', 'ai-control.html')));


// =================================================================
// 📊 GLOBAL STATE MANAGEMENT
// =================================================================
let tiktokConnection = null;
let currentUsername = null;
let isConnected = false;
let liveStartTime = null;

let topGifts = {};
let topLikes = {};
let sebaranUsers = new Set();
let totalFollowers = new Set();
let giftRequestUsers = new Map();





const activeDetectedViewers = new Map();
const VIEWER_STALE_MS = 2 * 60 * 1000;

function normalizeDetectedViewer(data = {}) {
    const nestedUser = data.user && typeof data.user === 'object' ? data.user : {};
    const uniqueId = data.uniqueId || nestedUser.uniqueId || (typeof data.user === 'string' ? data.user : '');
    const nickname = data.nickname || nestedUser.nickname || uniqueId || 'Penonton';
    const profilePictureUrl =
        data.profilePictureUrl ||
        nestedUser.profilePictureUrl ||
        data.userDetails?.profilePictureUrl ||
        null;

    const key = String(uniqueId || nickname).trim();
    if (!key) return null;

    return {
        user: key,
        uniqueId: String(uniqueId || key),
        nickname: String(nickname),
        profilePictureUrl,
        lastSeen: Date.now()
    };
}

function emitActiveDetectedViewers(targetSocket = null) {
    const viewers = Array.from(activeDetectedViewers.values())
        .map(({ lastSeen, ...viewer }) => viewer);

    if (targetSocket) {
        targetSocket.emit('active-viewers', viewers);
    } else {
        io.emit('active-viewers', viewers);
    }
}

function markViewerDetected(data = {}) {
    const viewer = normalizeDetectedViewer(data);
    if (!viewer) return;

    activeDetectedViewers.set(viewer.user, viewer);
    emitActiveDetectedViewers();
}

function removeStaleDetectedViewers() {
    const now = Date.now();
    let changed = false;

    for (const [key, viewer] of activeDetectedViewers) {
        if (now - viewer.lastSeen > VIEWER_STALE_MS) {
            activeDetectedViewers.delete(key);
            changed = true;
        }
    }

    if (changed) emitActiveDetectedViewers();
}

setInterval(removeStaleDetectedViewers, 30 * 1000);


let socialState = {
    enabled: false,
    duration: 5000,
    instagram: "",
    tiktok: "",
    youtube: "",
    discord: ""
};

// Musik & Antrean
let currentRequestMode = 'free';
let isRequestActive = true;
let songQueue = [];
let songHistory = [];
let currentSong = null;

// Data musik yang sedang diputar di Windows
let windowsMedia = {
    active: false,
    id: 'windows-media',
    sourceAppId: '',
    title: '',
    artist: '',
    album: '',
    artworkUrl: '',
    duration: 0,
    currentTime: 0,
    isPlaying: false,
    updatedAt: 0
};


let isKaraokeModeActive = false;
let maxRequestLimit = 1;
let maxDurationMinutes = 5;

// AI & Milestone
let isTanyaJawabActive = true;
let isCurhatActive = true;
let isChatReadingActive = true;
let blacklistKeywords = [];
let aiQueue = [];
let isAiProcessing = false;
let activeMilestones = [];
// AUTO COIN SCENE: aturan video yang diterima dari panel kontrol
let coinSceneRules = [];
if (fs.existsSync(coinSceneRulesPath)) {
    try {
        const savedCoinRules = JSON.parse(
            fs.readFileSync(coinSceneRulesPath, 'utf8')
        );

        coinSceneRules = Array.isArray(savedCoinRules)
            ? savedCoinRules
            : [];
    } catch (error) {
        console.error('[COIN CONFIG] Gagal memuat aturan tersimpan:', error.message);
        coinSceneRules = [];
    }
}




// =================================================================
// ⏱️ GLOBAL SERVER MUSIC TIMER (Bisa dipanggil dari mana saja)
// =================================================================
let serverMusicTimer = null;
let musicStartTime = 0;
let pausedMusicSeconds = 0;
let isMusicPlaying = false;
let musicSession = 0;
let lastNextAt = 0;

function emitMusicTick(currentTime = 0) {
    if (!currentSong) return;

    const fallbackDuration = (maxDurationMinutes || 5) * 60;
    io.emit('music-tick', {
        songId: currentSong.id,
        title: currentSong.title,
        currentTime: Number(Math.max(0, currentTime).toFixed(2)),
        duration: currentSong.duration || fallbackDuration,
        isPlaying: isMusicPlaying,
        session: musicSession
    });
}

function stopServerMusicTimer() {
    if (serverMusicTimer) clearInterval(serverMusicTimer);
    serverMusicTimer = null;
}

function startServerMusicTimer(isNewSong = true) {
    stopServerMusicTimer();
    if (!currentSong) {
        isMusicPlaying = false;
        return;
    }

    if (isNewSong) {
        musicSession++;
        pausedMusicSeconds = 0;
        musicStartTime = Date.now();
    } else if (isMusicPlaying) {
        musicStartTime = Date.now() - (pausedMusicSeconds * 1000);
    }

    emitMusicTick(pausedMusicSeconds);

    // Server tidak lagi menghitung `elapsedSeconds` secara buta dari Date.now().
    // Timer ini HANYA untuk mengecek apakah lagu sudah melewati batas durasi maksimal.
    serverMusicTimer = setInterval(() => {
        if (!currentSong) {
            stopServerMusicTimer();
            return;
        }

        const songDuration = Number(currentSong.duration) || ((maxDurationMinutes || 5) * 60);

        // pausedMusicSeconds sekarang bertindak sebagai `currentActualTime` yang dikirim dari client (dashboard)
        if (isMusicPlaying && pausedMusicSeconds >= songDuration) {
            clearInterval(serverMusicTimer);
            serverMusicTimer = null;

            const laguSelesai = currentSong;
            catatKeRiwayat(laguSelesai);
            isMusicPlaying = false;
            pausedMusicSeconds = 0;

            // Ambil lagu berikutnya terlebih dahulu
            currentSong = songQueue.length > 0 ? songQueue.shift() : null;

            if (currentSong) {
                isMusicPlaying = true;
                io.emit('update-queue', {
                    currentSong,
                    songQueue,
                    songHistory,
                    isPlaying: true,
                    session: musicSession + 1
                });
                startServerMusicTimer(true);
            } else {
                io.emit('update-queue', {
                    currentSong: null,
                    songQueue,
                    songHistory,
                    session: musicSession
                });
            }
            return;
        }

        // Broadcast waktu terakhir yang diketahui (waktu dari client)
        emitMusicTick(pausedMusicSeconds);
    }, 1000);
}

function advanceToNextSong() {
    const now = Date.now();
    if (now - lastNextAt < 300) return false;
    lastNextAt = now;

    stopServerMusicTimer();
    if (currentSong) catatKeRiwayat(currentSong);
    currentSong = songQueue.length > 0 ? songQueue.shift() : null;

    //isMusicPlaying = Boolean(currentSong);
    pausedMusicSeconds = 0;

    io.emit('update-queue', {
        currentSong,
        songQueue,
        songHistory,
        isPlaying: isMusicPlaying,
        session: musicSession + 1
    });
    if (currentSong) startServerMusicTimer(true);
    return true;
}


function catatKeRiwayat(lagu) {
    if (lagu) {
        const isExist = songHistory.some(s => s.id === lagu.id);
        if (!isExist) {
            songHistory.unshift(lagu);
            if (songHistory.length > 10) songHistory.pop();
        }
    }
}





// Mengubah data dari bridge Windows menjadi format yang seragam
function normalizeWindowsMedia(data = {}) {
    const media = data.media || {};
    const timeline = data.timeline || {};
    const playback = data.playback || {};

    const title = String(data.title || media.title || '').trim();
    const artist = String(data.artist || media.artist || '').trim();
    const album = String(data.album || media.albumTitle || '').trim();
    const sourceAppId = String(data.sourceAppId || data.appId || '').trim();

    const duration = Number(data.duration ?? timeline.duration) || 0;
    const currentTime = Math.max(
        0,
        Number(data.currentTime ?? timeline.position) || 0
    );

    const isPlaying = data.isPlaying === true
        || playback.isPlaying === true
        || playback.playbackStatus === 4;

    return {
        active: data.active !== false && Boolean(title || artist || isPlaying),
        id: String(data.id || `windows:${sourceAppId || 'current'}`),
        sourceAppId,
        title,
        artist,
        album,
        artworkUrl: data.artworkUrl || data.thumbnailUrl || '',
        duration,
        currentTime: duration ? Math.min(currentTime, duration) : currentTime,
        isPlaying,
        updatedAt: Date.now()
    };
}

// Meneruskan data media Windows ke semua overlay/dashboard
function publishWindowsMedia(data) {
    windowsMedia = normalizeWindowsMedia(data);
    io.emit('windows-media-update', windowsMedia);
}


// Menjalankan pembaca media Windows di thread terpisah
let windowsMediaWorker = null;

if (process.platform === 'win32') {
    try {
        windowsMediaWorker = new Worker(
            path.join(__dirname, 'windows-media-worker.js')
        );

        //konsol log lagu yg terputar di terminal bacanya
        windowsMediaWorker.on('message', (data) => {
            //console.log(
            //  '🪟 [WINDOWS MEDIA]',
            //data.active
            //  ? `${data.title} - ${data.artist} | ${data.isPlaying ? 'PLAYING' : 'PAUSED'}`
            //: 'Tidak ada media'
            //);
            publishWindowsMedia(data);
        });


        windowsMediaWorker.on('error', (error) => {
            console.error(
                '❌ [WINDOWS MEDIA WORKER] Error:',
                error.message
            );
        });

        windowsMediaWorker.on('exit', (code) => {
            if (code !== 0) {
                console.error(
                    `❌ [WINDOWS MEDIA WORKER] Berhenti dengan kode ${code}`
                );
            }
        });

        console.log('🪟 Windows Media Worker berhasil dijalankan.');
    } catch (error) {
        console.error(
            '❌ [WINDOWS MEDIA] Worker gagal dijalankan:',
            error.message
        );
    }
}


// =================================================================
// 🎵 FUNGSI UTAMA MUSIK & ANTREAN
// =================================================================

// ===== FUNGSI DARI YOUTUBE =====
async function tambahKeQueue(judulLagu, uniqueId, avatarUrl, isVvip = false) {
    const username = uniqueId || 'GUEST';

    try {
        const judulLaguLower = judulLagu.toLowerCase();
        const isKataTerlarang = blacklistKeywords.some(keyword => keyword && judulLaguLower.includes(keyword));

        if (isKataTerlarang) {
            console.log(`❌ Request dari @${username} diblokir karena mengandung kata blacklist: "${judulLagu}"`);
            io.emit('error-notifikasi', `🛡️ Request @${username} ditolak! Mengandung kata terlarang.`);
            io.emit('overlay:request-denied', {
                user: username,
                message: "Judul lagu mengandung kata terlarang!"
            });
            return;
        }

        if (!isVvip) {
            let activeSongsCount = songQueue.filter(song => song.requestedBy === username).length;
            if (currentSong && currentSong.requestedBy === username) {
                activeSongsCount += 1;
            }

            if (activeSongsCount >= maxRequestLimit) {
                console.log(`🚫 [KUOTA PENUH] @${username} ditolak.`);
                io.emit('overlay:request-denied', {
                    user: username,
                    message: `Kuota request kamu penuh! Maksimal ${maxRequestLimit} lagu aktif.`
                });
                return;
            }
        }

        let ytVideoId = '';
        try {
            const searchResult = await youTubeSearchApi.GetListByKeyword(judulLagu, false, 1);
            if (searchResult && searchResult.items && searchResult.items.length > 0) {
                ytVideoId = searchResult.items[0].id;
            } else {
                console.log("⚠️ [YouTube API] Kosong, mencoba alternatif play-dl...");
                const backupSearch = await play.search(judulLagu, { limit: 1 });
                if (backupSearch && backupSearch.length > 0) {
                    ytVideoId = backupSearch[0].id;
                }
            }
        } catch (error) {
            console.error("❌ [YouTube Error] Gagal searching:", error);
            io.emit('overlay:request-denied', { user: username, message: "Gagal mencari lagu di YouTube. Coba lagi!" });
            return;
        }

        if (!ytVideoId) {
            console.log(`❌ Lagu "${judulLagu}" tidak ditemukan di YouTube.`);
            io.emit('overlay:request-denied', { user: username, message: "Lagu tidak ditemukan!" });
            return;
        }

        const normalize = (str) => str.trim().toLowerCase().replace(/\s+/g, " ");
        const judulBaru = normalize(judulLagu);
        const sudahAdaDiQueue = songQueue.some(song => normalize(song.title) === judulBaru);
        const sedangDiputar = currentSong && normalize(currentSong.title) === judulBaru;

        if (sudahAdaDiQueue || sedangDiputar) {
            console.log(`⚠️ [DUPLIKAT DITOLAK] ${judulLagu}`);
            io.emit('overlay:request-denied', { user: username, message: "Lagu sudah ada di antrian!" });
            return;
        }

        let durationApplied = 180;
        let isDurationCut = false;

        try {
            const videoInfo = await play.video_basic_info(`https://www.youtube.com/watch?v=${ytVideoId}`);
            const durasiDetik = videoInfo.video_details.durationInSec || 180;
            const limitDetik = maxDurationMinutes * 60;

            if (durasiDetik > limitDetik) {
                durationApplied = limitDetik;
                isDurationCut = true;
                console.log(`⏱️ [DURASI TIKTOK] Lagu "${videoInfo.video_details.title}" dipotong ke ${limitDetik} detik.`);
            } else {
                durationApplied = durasiDetik;
            }
        } catch (err) {
            console.log("⚠️ Gagal mengambil durasi asli, menggunakan default 180s:", err);
        }

        const dataLagu = {
            id: Date.now(),
            title: judulLagu,
            url: `https://www.youtube.com/watch?v=${ytVideoId}`,
            requestedBy: username,
            userAvatar: avatarUrl,
            youtubeId: ytVideoId,
            vvip: isVvip,
            duration: durationApplied,
            isCut: isDurationCut,
            lyrics: []
        };

        // Ambil lirik sebelum lagu dikirim ke player/antrean
        console.log(`🔍 Menyiapkan lirik: ${dataLagu.title}`);
        dataLagu.lyrics = await getLyricsCached(dataLagu.title);
        console.log(`✅ Lirik siap: ${dataLagu.lyrics.length} baris`);


        let statusPutarTts = "";

        if (!currentSong) {
            currentSong = dataLagu;
            console.log(`[PLAY OTOMATIS] Player kosong, memutar VVIP/Normal: ${judulLagu}`);
            statusPutarTts = "langsung diputar!";
            isMusicPlaying = true;
            startServerMusicTimer(true);
        } else {
            if (isVvip) {
                songQueue.unshift(dataLagu);
                console.log(`🔥 [VVIP JALUR CEPAT] ${judulLagu} masuk antrean urutan #1.`);
                statusPutarTts = "berhasil menyalip ke urutan pertama antrean bosku!";
            } else {
                songQueue.push(dataLagu);
                console.log(`[ANTRE NORMAL] ${judulLagu} masuk antrean belakang.`);
                statusPutarTts = "sudah masuk antrean!";
            }
        }

        const ucapanKece = [
            `Wih, selera musikmu nggak kaleng-kaleng, brow!`,
            `Siap, lagu pilihanmu sudah diamankan. Dompet aman, playlist nyaman!`,
            `Mantap! Telinga kita sebentar lagi naik level.`,
            `Request diterima! Gas langsung pasang sepatu joget.`,
            `Gokil, pilihan lagunya bikin speaker ikut semangat!`,
            `Siap meluncur! Semoga yang denger nggak cuma mantan.`
        ];
        const randomUcapan = ucapanKece[Math.floor(Math.random() * ucapanKece.length)];

        aiQueue.push({
            isLocal: true,
            jawabanLokal: `${randomUcapan} @${dataLagu.requestedBy}. Lagu ${judulLagu} ${statusPutarTts}`,
            mode: 'tanya'
        });

        processAiQueue();
        io.emit('update-queue', { currentSong, songQueue, songHistory });

    } catch (globalError) {
        console.error("🚨 [CRASH SHIELD] Error fatal digagalkan di tambahKeQueue:", globalError);
    }
}

// =================================================================
// 🚀 WEBSOCKET: AUTO CAPTION
// =================================================================
const captionWss = new WebSocketServer({ port: 8080, host: '0.0.0.0' });

captionWss.on('connection', (ws) => {
    console.log('🔗 [WS Caption] Koneksi baru terhubung (App/OBS)');
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (rawData) => {
        try {
            captionWss.clients.forEach((client) => {
                if (client !== ws && client.readyState === 1) {
                    client.send(rawData.toString());
                }
            });
        } catch (err) {
            console.error("Gagal memproses data WS:", err);
        }
    });

    ws.on('close', () => {
        console.log('❌ [WS Caption] Koneksi terputus');
    });
});

setInterval(() => {
    captionWss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

console.log('⚡ WebSocket Caption Server berjalan di ws://localhost:8080');

// =================================================================
// 🚀 WEBSOCKET: NETWORK MONITORING
// =================================================================
const wss = new WebSocket.Server({ port: 9090, host: '0.0.0.0' });
console.log("WebSocket aktif di port 9090");

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

wss.on('connection', (ws) => {
    console.log("Overlay berhasil terhubung ke server!");
});

let monitorInterval = null;

function startNetworkMonitor() {
    if (monitorInterval) {
        console.log("Monitor sudah berjalan");
        return;
    }
    console.log("Network Monitor START");

    monitorInterval = setInterval(async () => {
        try {
            const result = await ping.promise.probe('8.8.8.8');
            const network = await si.networkStats();
            const downloadMbps = ((network[0].rx_sec * 8) / 1000000).toFixed(2);
            const uploadMbps = ((network[0].tx_sec * 8) / 1000000).toFixed(2);

            broadcast({
                ping: result.time,
                download: downloadMbps,
                upload: uploadMbps
            });
        } catch (err) {
            console.log(err);
        }
    }, 10000);
}

function stopNetworkMonitor() {
    if (!monitorInterval) return;
    console.log("Network Monitor STOP");
    clearInterval(monitorInterval);
    monitorInterval = null;
}

app.get('/network/start', (req, res) => {
    startNetworkMonitor();
    res.json({ success: true });
});

app.get('/network/stop', (req, res) => {
    stopNetworkMonitor();
    res.json({ success: true });
});

// =================================================================
// 🤖 AI QUEUE PROCESSOR
// =================================================================
async function processAiQueue() {
    if (isAiProcessing || aiQueue.length === 0) return;
    isAiProcessing = true;

    const currentJob = aiQueue.shift();

    try {
        let responseText = "";

        if (currentJob.isLocal) {
            responseText = currentJob.jawabanLokal;
            console.log(`🤖 [JAWABAN LOKAL] -> ${responseText}`);
        } else {
            const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: 'user', content: currentJob.prompt }],
                model: 'llama-3.1-8b-instant',
            });
            responseText = chatCompletion.choices[0].message.content;
            console.log(`🤖 [AI JAWAB] -> ${responseText}`);
        }

        io.emit('play-ai-tts', {
            text: responseText,
            mode: currentJob.mode
        });

        const estimatedDelay = Math.max(4000, responseText.length * 90);
        await new Promise(resolve => setTimeout(resolve, estimatedDelay));

    } catch (error) {
        console.error("❌ Error di Queue AI:", error);
    } finally {
        isAiProcessing = false;
        processAiQueue();
    }
}

// =================================================================
// 📱 TIKTOK LIVE CONNECTION HANDLER
// =================================================================
function setupTikTokEvents(username, socket) {
    if (tiktokConnection) {
        tiktokConnection.removeAllListeners();
        tiktokConnection.disconnect();
    }

    tiktokConnection = new WebcastPushConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestOptions: { timeout: 10000 },
        clientParams: { "app_language": "id-ID", "device_platform": "web" }
    });


    // =================================================================
    // KONEKSI AKUN TIKTOK
    // =================================================================
    const namaAkun = String(username || '').replace(/^@/, '');

    socket.emit('server-log', {
        level: 'warn',
        message: `📡 Radar TikTok aktif. Mencari sinyal LIVE dari @${namaAkun}...`
    });

    console.log(`📡 [TIKTOK] Mencari sinyal LIVE dari @${namaAkun}...`);

    tiktokConnection.connect().then(state => {
        isConnected = true;
        currentUsername = username;
        liveStartTime = Date.now();

        const pesanBerhasil = [
            `🎉 @${namaAkun} berhasil ditangkap! Sinyal LIVE aman terkendali.`,
            `🚀 Koneksi ke @${namaAkun} sukses. Mesin overlay siap meluncur!`,
            `✅ @${namaAkun} sudah tersambung. Server tidak jadi galau hari ini.`,
            `🔥 LIVE terdeteksi! @${namaAkun} siap menerima penonton dan gift.`,
            `🎯 Room ID ${state.roomId} berhasil ditemukan. Tidak perlu pancing-pancing akun lain!`
        ];

        const pesanRandom =
            pesanBerhasil[Math.floor(Math.random() * pesanBerhasil.length)];

        console.log(`✅ [TIKTOK] ${pesanRandom}`);
        console.log(`🆔 [ROOM] Room ID: ${state.roomId}`);
        console.log(`🟢 [SYSTEM] Overlay, chat, gift, dan viewer siap digunakan.`);

        socket.emit('server-log', {
            level: 'success',
            message: pesanRandom
        });

        socket.emit('server-log', {
            level: 'info',
            message: `🆔 Room ID: ${state.roomId}`
        });

        socket.emit('server-log', {
            level: 'success',
            message: '🟢 Overlay, chat, gift dll.. , serta viewer siap digunakan.'
        });

        io.emit('tiktok-connected', {
            startTime: liveStartTime
        });

        socket.emit('status', `Tersambung: ${username}`);

    }).catch(err => {
        isConnected = false;
        currentUsername = null;
        liveStartTime = null;

        console.error('❌ [TIKTOK] Koneksi gagal:', err);
        console.error(`💡 [INFO] @${namaAkun} kemungkinan sedang offline atau username tidak ditemukan.`);

        const pesanGagal = [
            `😴 @${namaAkun} belum LIVE. Mungkin sedang ngopi dulu, brow.`,
            `🫥 Sinyal @${namaAkun} belum terlihat. LIVE-nya mungkin masih malu-malu.`,
            `📴 @${namaAkun} belum aktif LIVE atau username-nya kurang tepat.`,
            `🔍 Radar gagal menemukan @${namaAkun}. Coba cek username dan status LIVE.`,
            `🐌 Koneksi belum berhasil. TikTok-nya mungkin sedang pemanasan.`
        ];

        const pesanRandom =
            pesanGagal[Math.floor(Math.random() * pesanGagal.length)];

        socket.emit('server-log', {
            level: 'warn',
            message: pesanRandom
        });

        socket.emit('server-log', {
            level: 'error',
            message: 'ℹ️ Pastikan username benar dan akun sedang melakukan LIVE.'
        });

        socket.emit(
            'status',
            'Gagal: Akun TikTok tidak sedang live atau username tidak ditemukan.'
        );
    });

    //==================


    tiktokConnection.on('viewerCount', (data) => {
        let count = (data && typeof data === 'object') ? (data.viewerCount || 0) : (data || 0);
        io.emit('update-viewer-count', { count: count });
    });

    tiktokConnection.on('roomUser', (data) => {
        if (data && data.viewerCount) {
            io.emit('update-viewer-count', { count: data.viewerCount });
        }
    });

    tiktokConnection.removeAllListeners('chat');

    tiktokConnection.on('chat', async (data) => {
        try {
            io.emit('new-chat-monitor', { user: data.uniqueId, nickname: data.nickname, message: data.comment, profilePictureUrl: data.profilePictureUrl });
            io.emit('chat', data);

            const pesan = (data.comment || "").trim();
            const cekKataGglobal = pesan.toLowerCase();

            const keywordKreator = [
                'webdev siapa', 'siapa webdev', 'siapa yusrianto', 'siapa lana',
                'siapa pencipta', 'siapa pembuat', 'siapa owner', 'siapa developer',
                'siapa yang buat', 'siapa yang bikin', 'kreatornya siapa',
                'ownernya siapa', 'aplikasi buatan siapa'
            ];

            const isNanyainKreator = keywordKreator.some(keyword => cekKataGglobal.includes(keyword));

            if (isNanyainKreator) {
                console.log(`🤖 [MODE TANYA LOKAL] Dari @${data.uniqueId}: ${pesan}`);
                io.emit('ai-log-monitor', { time: new Date().toLocaleTimeString('id-ID'), user: data.uniqueId, pesan: pesan, mode: 'tanya' });

                const jawabanLokal = "Aplikasi overlay stream WebDev ini diciptakan oleh Kak Yusrianto Lana. Jika Anda ingin menggunakan aplikasi ini, silakan kunjungi profil TikTok beliau. Kak Yusrianto sudah menyediakan aplikasi versi gratis sebelum Anda memutuskan untuk menggunakan versi pro.";
                console.log(`🤖 [JAWABAN LOKAL] -> ${jawabanLokal}`);

                aiQueue.push({ isLocal: true, jawabanLokal: jawabanLokal, mode: 'tanya' });
                processAiQueue();
                return;
            }

            if (isTanyaJawabActive && cekKataGglobal.startsWith('#')) {
                const pertanyaan = pesan.slice(1).trim();
                if (pertanyaan) {
                    console.log(`🤖 [MODE TANYA GROQ] Dari @${data.uniqueId}: ${pertanyaan}`);
                    io.emit('ai-log-monitor', { time: new Date().toLocaleTimeString('id-ID'), user: data.uniqueId, pesan: pesan, mode: 'tanya' });

                    aiQueue.push({
                        isLocal: false,
                        prompt: `Anda adalah asisten Live Streaming Web Developer yang cerdas, ahli coding, dan profesional. Jawablah dengan gaya yang sopan, ramah, jelas, padat, dan langsung ke intinya menggunakan bahasa Indonesia yang baik dan benar (gunakan kata 'Saya' dan 'Anda' atau 'Kak'). MAKSIMAL HANYA 2 KALIMAT SAJA DAN JANGAN BERTELE-TELE! Pertanyaan: ${pertanyaan}`,
                        mode: 'tanya'
                    });
                    processAiQueue();
                }
                return;
            }
            else if (isCurhatActive && pesan.startsWith('* ')) {
                const curhatan = pesan.slice(2).trim();
                if (curhatan) {
                    console.log(`🎭 [MODE CURHAT] Dari @${data.uniqueId}: ${curhatan}`);
                    io.emit('ai-log-monitor', { time: new Date().toLocaleTimeString('id-ID'), user: data.uniqueId, pesan: pesan, mode: 'curhat' });

                    aiQueue.push({
                        isLocal: false,
                        prompt: `Anda adalah asisten Live Streaming yang empati, ramah, dan bersahabat. Dengarkan curhatan penonton berikut dan berikan tanggapan singkat, bijak, dan menenangkan dalam bahasa Indonesia. MAKSIMAL HANYA 2 KALIMAT SAJA DAN JANGAN BERTELE-TELE! Curhatan: ${curhatan}`,
                        mode: 'curhat'
                    });
                    processAiQueue();
                }
                return;
            }

            const pesanLower = pesan.toLowerCase();

            if (
                !pesanLower.startsWith('!req ') &&
                !pesanLower.startsWith('!play ')
            ) {
                return;
            }





            if (!isRequestActive) {
                console.log(`🚫 [REQUEST BLOCKED] @${data.uniqueId} mencoba request, tapi sesi sedang OFF.`);
                io.emit('song-request-denied', {
                    user: data.uniqueId,
                    nickname: data.nickname,
                    profilePictureUrl: data.profilePictureUrl,
                    message: "Sesi request lagu sedang dinonaktifkan oleh Host! 🔒"
                });
                return;
            }

            const query = pesan.replace(/^!(req|play)\s+/i, '').trim();

            if (!query) return;

            const giftData = giftRequestUsers.get(data.uniqueId);
            const isVipUser = (giftData && giftData.expire > Date.now());

            if (isVipUser) {
                await tambahKeQueue(query, data.uniqueId, data.profilePictureUrl, true);
                giftRequestUsers.delete(data.uniqueId);
                console.log(`👑 [VVIP PRIORITAS] "${query}" dari @${data.uniqueId} berhasil diproses.`);
                return;
            }

            if (currentRequestMode === 'free') {
                let activeSongsCount = songQueue.filter(song => song.requestedBy === data.uniqueId).length;
                if (currentSong && currentSong.requestedBy === data.uniqueId) activeSongsCount += 1;

                if (activeSongsCount < maxRequestLimit) {
                    await tambahKeQueue(query, data.uniqueId, data.profilePictureUrl, false);
                    console.log(`🎵 [FREE REQUEST] "${query}" dari @${data.uniqueId} sukses dimasukkan.`);
                } else {
                    console.log(`🚫 [KUOTA PENUH] @${data.uniqueId} ditolak.`);
                }
            } else if (currentRequestMode === 'gift') {
                io.emit('song-request-denied', {
                    user: data.uniqueId,
                    nickname: data.nickname,
                    profilePictureUrl: data.profilePictureUrl,
                    message: "Kirim gift terlebih dahulu untuk request lagu 🎁"
                });
                console.log(`🚫 [REQUEST DITOLAK] @${data.uniqueId} belum gift.`);
            }
        } catch (err) {
            console.error("Error processing chat event:", err);
        }
    });

    tiktokConnection.on('gift', async (data) => {
        try {
            if (!data || typeof data !== "object") return;

            console.log('[COIN DEBUG FULL]', JSON.stringify(data, null, 2));

            console.log('[COIN DEBUG]', {
                uniqueId: data.uniqueId,
                giftName: data.giftName,
                repeatCount: data.repeatCount,
                repeatEnd: data.repeatEnd,
                giftType: data.giftType,
                extendedGiftInfo: data.extendedGiftInfo
            });


            if (currentRequestMode === 'gift') {
                giftRequestUsers.set(data.uniqueId, { expire: Date.now() + (5 * 60 * 1000) });
            }
            console.log(`🎁 @${data.uniqueId} dapat 1 tiket VVIP! Silakan ketik di chat: !req atau !play judul lagu - nama artis`);

            let giftIcon = data.giftPictureUrl || (data.extendedGiftInfo?.icon?.urls?.[0]) || null;

            io.emit("tiktok-gift-alert", { giftName: data.giftName, count: data.repeatCount });
            io.emit("new-gift", {
                user: data.uniqueId,
                nickname: data.nickname,
                profilePictureUrl: data.profilePictureUrl,
                giftName: data.giftName,
                count: data.repeatCount,
                giftIcon
            });

            if (!topGifts[data.uniqueId]) {
                topGifts[data.uniqueId] = { user: data.uniqueId, nickname: data.nickname, profilePic: data.profilePictureUrl, total: 0 };
            }
            topGifts[data.uniqueId].total += data.repeatCount;
            io.emit('update-top-gift', Object.values(topGifts));

            if (isKaraokeModeActive) return;

            // AUTO COIN SCENE: hitung coin final dari satu event gift
            const isFinalGiftEvent = data.giftType !== 1 || data.repeatEnd === true;

            if (isFinalGiftEvent) {
                const coinPerGift = Number(
                    data.extendedGiftInfo?.diamond_count
                    ?? data.extendedGiftInfo?.diamondCount
                    ?? data.diamondCount
                    ?? 0
                );

                const jumlahGift = Math.max(1, Number(data.repeatCount ?? 1));
                const totalCoinEvent = coinPerGift * jumlahGift;

                console.log(
                    `🪙 [COIN EVENT] @${data.uniqueId} | ${data.giftName} | ` +
                    `${jumlahGift} gift x ${coinPerGift} coin = ${totalCoinEvent} coin`
                );

                // Cari semua aturan yang targetnya terpenuhi oleh satu event gift.
                // Karena coinSceneRules sudah diurutkan dari target terkecil,
                // antrean akan berjalan dari target kecil ke target besar.
                // Pilih target terbesar yang terpenuhi oleh event ini.
                const eligibleCoinRules = coinSceneRules
                    .filter(rule => totalCoinEvent >= Number(rule.targetCoins))
                    .sort((a, b) => Number(a.targetCoins) - Number(b.targetCoins));

                const selectedCoinRule = eligibleCoinRules[eligibleCoinRules.length - 1];

                if (selectedCoinRule) {
                    const targetCoins = Number(selectedCoinRule.targetCoins);
                    const jumlahPutar = 1; // 👈 Ubah di sini agar berapapun koinnya (asal lewat target), tetap putar 1x

                    // Rule yang sama dikirim berulang sesuai jumlah kelipatan target.
                    const repeatedCoinRules = Array.from(
                        { length: jumlahPutar },
                        () => ({
                            ...selectedCoinRule,
                            repeatCount: jumlahPutar
                        })
                    );

                    const coinSceneTrigger = {
                        eventId: Date.now(),
                        user: data.uniqueId,
                        nickname: data.nickname,
                        giftName: data.giftName,
                        totalCoins: totalCoinEvent,
                        selectedTarget: targetCoins,
                        repeatCount: jumlahPutar,
                        rules: repeatedCoinRules
                    };

                    io.emit('coin-scene-trigger', coinSceneTrigger);

                    console.log(
                        `🎬 [COIN TRIGGER] ${totalCoinEvent} coin → ` +
                        `target ${targetCoins} coin, diputar ${jumlahPutar} kali.`
                    );
                }


            }


            giftRequestUsers.set(data.uniqueId, { expire: Date.now() + (5 * 60 * 1000) });

            const text = data.comment || "";
            const textLower = text.toLowerCase();

            if (textLower.startsWith('!req ') || textLower.startsWith('!play ')) {
                const query = text.replace(/^!(req|play)\s+/i, '').trim();

                if (query) {
                    await tambahKeQueue(query, data.uniqueId, data.profilePictureUrl, true);
                    aiQueue.push({
                        isLocal: true,
                        jawabanLokal: `Waduh mantap Sultan ${data.uniqueId} kirim gift! Lagu ${query} langsung meluncur ke urutan pertama!`,
                        mode: 'tanya'
                    });
                    processAiQueue();
                    giftRequestUsers.delete(data.uniqueId);
                }
            }

            // 📈 HITUNG OTOMATIS MILESTONE DARI LIVE GIFT
            if (activeMilestones.length > 0) {
                let isMilestoneUpdated = false;
                activeMilestones = activeMilestones.map(milestone => {
                    const namaGiftLive = data.giftName.toLowerCase().replace(/\s+/g, '');
                    const namaGiftTarget = milestone.giftName.toLowerCase().replace(/\s+/g, '');

                    if (namaGiftLive === namaGiftTarget) {
                        const jumlahBaru = milestone.currentValue + (data.repeatCount || 1);
                        isMilestoneUpdated = true;
                        return {
                            ...milestone,
                            currentValue: jumlahBaru > milestone.targetValue ? milestone.targetValue : jumlahBaru
                        };
                    }
                    return milestone;
                });

                if (isMilestoneUpdated) {
                    io.emit('sync-active-milestones', activeMilestones);
                }
            }
        } catch (giftErr) {
            console.error("🚨 Error di penanganan Gift TikTok:", giftErr);
        }
    });

    tiktokConnection.on('social', (data) => {
        let type = 'SOCIAL';
        if (data.displayType && data.displayType.includes('follow')) {
            type = 'FOLLOW';
            totalFollowers.add(data.uniqueId);
            io.emit('update-follower-count', { total: totalFollowers.size });
            io.emit('new-follower', { user: data.uniqueId, nickname: data.nickname, profilePictureUrl: data.profilePictureUrl });
            console.log(`✨ [New Follow] ${data.nickname} baru saja follow!`);
        }

        if (data.displayType && data.displayType.includes('share')) {
            type = 'SHARE';
            io.emit('new-share', { user: data.uniqueId, nickname: data.nickname, profilePictureUrl: data.profilePictureUrl });
            console.log(`📢 ${data.nickname} membagikan Live!`);
        }

        io.emit('new-social-monitor', { user: data.uniqueId, nickname: data.nickname, type: type });
        io.emit('social', data);
    });

    // Tambahkan variabel penahan spam
    let pendingLikesEmit = false;

    tiktokConnection.on('like', (data) => {
        const uid = data.uniqueId;
        if (!uid) return;

        // Ambil jumlah like (sesuaikan jika data.likeCount adalah total akumulasi user)
        const tapSekarang = parseInt(data.likeCount) || 1;

        if (!topLikes[uid]) {
            topLikes[uid] = {
                nickname: data.nickname || uid,
                profilePictureUrl: data.profilePictureUrl || null,
                count: 0
            };
        }

        // Update avatar & nickname jika sebelumnya kosong
        if (data.profilePictureUrl) topLikes[uid].profilePictureUrl = data.profilePictureUrl;
        if (data.nickname) topLikes[uid].nickname = data.nickname;

        // Jika data.likeCount dari TikTok sudah akumulatif per-user, gunakan penugasan langsung:
        // topLikes[uid].count = tapSekarang;
        // Jika data.likeCount adalah tap instan per-event, gunakan akumulasi:
        topLikes[uid].count += tapSekarang;

        // Throttling 1.5 detik untuk efisiensi bandwidth Socket.io
        if (!pendingLikesEmit) {
            pendingLikesEmit = true;
            setTimeout(() => {
                const totalSemuaLike = Object.values(topLikes).reduce((sum, u) => sum + u.count, 0);

                io.emit('like-stats', { totalLikeCount: totalSemuaLike });
                io.emit('new-like', { allLikes: topLikes });

                pendingLikesEmit = false;
            }, 1500);
        }
    });

    tiktokConnection.on('member', (data) => {
        if (data.uniqueId) {
            sebaranUsers.add(data.uniqueId);
            io.emit('update-sebaran', { total: sebaranUsers.size });
        }
        io.emit('new-join-monitor', { user: data.uniqueId, nickname: data.nickname });

        const profilePic = data.profilePictureUrl || (data.userDetails ? data.userDetails.profilePictureUrl : null);
        io.emit('new-join', {
            user: data.uniqueId || data.nickname,
            uniqueId: data.uniqueId,
            nickname: data.nickname,
            profilePictureUrl: profilePic
        });

        io.emit('member', data);
    });

    tiktokConnection.on('disconnected', () => {
        isConnected = false;
        activeDetectedViewers.clear();
        emitActiveDetectedViewers();

        console.log('🔌 Koneksi TikTok Terputus');
        io.emit('status', 'Terputus... Mencoba menyambung kembali otomatis');
        io.emit('tiktok-disconnected');
        io.emit('update-viewer-count', { count: 0 });

        setTimeout(() => {
            if (!isConnected && currentUsername) {
                console.log(`🔄 [Auto-Reconnect] Menghubungkan kembali ke: ${currentUsername}`);
                setupTikTokEvents(currentUsername, socket);
            }
        }, 5000);
    });

    tiktokConnection.on('viewerCountUpdate', (data) => {
        io.emit('update-stats', { viewerCount: data.viewerCount, liveStatus: "LIVE" });
    });
}

// =================================================================
// 🔗 SOCKET.IO CORE HANDLERS
// =================================================================
io.on('connection', (socket) => {

    socket.emit('server-log', {
        level: 'info',
        message: `Server WebDev aktif | Port ${PORT}`
    });

    socket.emit('server-log', {
        level: 'info',
        message: 'Socket.IO client terhubung ke dashboard'
    });


    emitActiveDetectedViewers(socket);

    socket.on('get-active-viewers', () => {
        emitActiveDetectedViewers(socket);
    });


    socket.emit('sync-active-milestones', activeMilestones);

    // AUTO COIN SCENE: kirim konfigurasi terakhir ke panel yang baru terhubung
    socket.emit('coin-scene-config:sync', coinSceneRules);

    // AUTO COIN SCENE: menerima daftar aturan video dari panel kontrol
    socket.on('coin-scene-config:update', (rules) => {
        if (!Array.isArray(rules)) return;

        coinSceneRules = rules
            .filter(rule => Number(rule.targetCoins) >= 1)
            .map(rule => ({
                ...rule,
                targetCoins: Number(rule.targetCoins),
                duration: rule.duration ? Number(rule.duration) : null
            }))
            .sort((a, b) => a.targetCoins - b.targetCoins);

        fs.writeFile(
            coinSceneRulesPath,
            JSON.stringify(coinSceneRules, null, 2),
            'utf8',
            (error) => {
                if (error) {
                    console.error('[COIN CONFIG] Gagal menyimpan aturan:', error.message);
                } else {
                    console.log('[COIN CONFIG] Aturan tersimpan permanen di file server.');
                }
            }
        );

        console.log(`🪙 [COIN CONFIG] ${coinSceneRules.length} aturan video diterima dari panel.`);
        io.emit('coin-scene-config:sync', coinSceneRules);
    });


    // AUTO COIN SCENE: simulasi trigger dari panel kontrol
    socket.on('coin-scene-test-event', (payload = {}) => {
        const totalCoins = Number(payload.totalCoins);

        if (!Number.isFinite(totalCoins) || totalCoins < 1) {
            console.warn('⚠️ [COIN TEST] Jumlah coin simulasi tidak valid.');
            return;
        }

        // Test Trigger memakai aturan yang sama dengan gift asli:
        // pilih target terbesar, lalu ulangi video sesuai kelipatan coin.
        const eligibleRules = coinSceneRules
            .filter(rule => totalCoins >= Number(rule.targetCoins))
            .sort((a, b) => Number(a.targetCoins) - Number(b.targetCoins));

        const selectedRule = eligibleRules[eligibleRules.length - 1];

        if (!selectedRule) {
            console.log(
                `🧪 [COIN TEST] Tidak ada target yang terpenuhi untuk ${totalCoins} coin.`
            );
            return;
        }

        const targetCoins = Number(selectedRule.targetCoins);
        const jumlahPutar = 1; // 👈 Ubah juga di sini untuk fitur simulasi test

        const repeatedRules = Array.from(
            { length: jumlahPutar },
            () => ({
                ...selectedRule,
                repeatCount: jumlahPutar
            })
        );

        io.emit('coin-scene-trigger', {
            eventId: Date.now(),
            user: payload.user || 'panel-tester',
            nickname: payload.nickname || 'Panel Tester',
            giftName: payload.giftName || 'Simulasi Gift',
            totalCoins,
            selectedTarget: targetCoins,
            repeatCount: jumlahPutar,
            rules: repeatedRules
        });

        console.log(
            `🧪 [COIN TEST] ${totalCoins} coin → ` +
            `target ${targetCoins} coin, dikirim ${jumlahPutar} kali ke overlay.`
        );

    });


    // AUTO COIN SCENE: teruskan sinyal video selesai dari overlay ke panel kontrol
    socket.on('coin-video-ended', (payload = {}) => {
        io.emit('coin-video-ended', {
            targetCoins: Number(payload.targetCoins),
            videoUrl: payload.videoUrl || ''
        });

        console.log(
            `✅ [COIN VIDEO END] Target ${payload.targetCoins} coin selesai diputar.`
        );
    });


    // AUTO COIN SCENE: menerima dan menyalin video lokal dari panel
    socket.on('coin-scene-upload-video', async (payload, callback) => {
        try {
            const sourcePath = String(payload?.filePath || '');
            const originalName = String(payload?.originalName || 'video');

            if (!sourcePath || !path.isAbsolute(sourcePath)) {
                throw new Error('Path video tidak valid.');
            }

            const extension = path.extname(originalName).toLowerCase();
            const allowedExtensions = ['.mp4', '.webm', '.mov'];

            if (!allowedExtensions.includes(extension)) {
                throw new Error('Format video harus MP4, WebM, atau MOV.');
            }

            const baseName = path.basename(originalName, extension)
                .replace(/[^a-zA-Z0-9_-]/g, '-')
                .replace(/-+/g, '-')
                .slice(0, 60) || 'video';

            const storedName = `${Date.now()}-${baseName}${extension}`;
            const destinationPath = path.join(coinVideoDir, storedName);

            await fs.promises.copyFile(sourcePath, destinationPath);

            const videoUrl = `/coin-videos/${encodeURIComponent(storedName)}`;

            console.log(`🎞️ [COIN VIDEO] Video tersimpan: ${storedName}`);

            if (typeof callback === 'function') {
                callback({
                    success: true,
                    fileName: storedName,
                    url: videoUrl
                });
            }
        } catch (error) {
            console.error('❌ [COIN VIDEO] Gagal menyimpan video:', error.message);

            if (typeof callback === 'function') {
                callback({
                    success: false,
                    message: error.message
                });
            }
        }
    });

    // AUTO COIN SCENE: reset seluruh file video dan seluruh aturan
    socket.on('coin-scene-reset-all', async (callback) => {
        try {
            const entries = await fs.promises.readdir(coinVideoDir, {
                withFileTypes: true
            });

            let deletedFiles = 0;

            for (const entry of entries) {
                if (!entry.isFile()) continue;

                const fileToDelete = path.join(coinVideoDir, entry.name);
                await fs.promises.unlink(fileToDelete);
                deletedFiles++;
            }

            // Kosongkan state server dan file konfigurasi permanen.
            coinSceneRules = [];
            await fs.promises.writeFile(
                coinSceneRulesPath,
                JSON.stringify([], null, 2),
                'utf8'
            );

            // Beri tahu semua panel agar menghapus rule yang tampil.
            io.emit('coin-scene-config:sync', []);

            console.log(
                `🧹 [COIN RESET] ${deletedFiles} file video dan semua aturan dihapus.`
            );

            if (typeof callback === 'function') {
                callback({
                    success: true,
                    deletedFiles
                });
            }
        } catch (error) {
            console.error('[COIN RESET] Gagal menghapus data:', error.message);

            if (typeof callback === 'function') {
                callback({
                    success: false,
                    message: error.message
                });
            }
        }
    });


    socket.on('update-milestones-data', (newMilestones) => {
        activeMilestones = newMilestones;
        io.emit('sync-active-milestones', activeMilestones);
    });

    socket.on('reset-milestones', () => {
        activeMilestones = [];
        io.emit('sync-active-milestones', activeMilestones);
    });

    socket.on('change-blacklist-keywords', (keywords) => {
        blacklistKeywords = keywords;
        console.log("🛡️ Blacklist ter-update di server:", blacklistKeywords);
        io.emit('sync-blacklist-keywords', blacklistKeywords);
    });
    socket.emit('sync-blacklist-keywords', blacklistKeywords);

    // Kirim state lengkap, termasuk status isMusicPlaying agar dashboard tahu lagu sedang berjalan
    // Kirim state lengkap SAAT KONEKSI AWAL
    socket.emit('update-queue', {
        currentSong: currentSong,
        songQueue: songQueue,
        songHistory: songHistory,
        isPlaying: isMusicPlaying,
        session: musicSession,
        isRefresh: true // Tambahkan penanda ini
    });

    // Kirim data Windows terakhir saat overlay baru terhubung
    socket.emit('windows-media-update', windowsMedia);

    // Menerima data dari bridge pembaca media Windows
    socket.on('windows-media-bridge:update', (data) => {
        try {
            const safeData = data && typeof data === 'object' ? data : {};
            publishWindowsMedia(safeData);
        } catch (error) {
            console.error(
                '❌ [WINDOWS MEDIA] Data bridge tidak valid:',
                error.message
            );
        }
    });


    socket.emit('sync-request-mode', currentRequestMode);
    socket.emit('brand-texts-changed', brandTexts);

    socket.on('update-brand-texts', (newData) => {
        brandTexts = newData;
        fs.writeFile(filePath, JSON.stringify(brandTexts, null, 2), 'utf8', (err) => {
            if (err) {
                console.log("Gagal save brand text:", err);
            } else {
                console.log("Data brand text berhasil di-save di background");
            }
        });
        io.emit('brand-texts-changed', brandTexts);
    });

    socket.emit('sync-max-duration', maxDurationMinutes);
    socket.on('change-max-duration', (newDuration) => {
        maxDurationMinutes = parseInt(newDuration) || 5;
        console.log(`⏱️ [SYSTEM] Batas durasi per lagu diubah menjadi: ${maxDurationMinutes} Menit (${maxDurationMinutes * 60} Detik)`);
        io.emit('sync-max-duration', maxDurationMinutes);
    });

    function catatKeRiwayat(lagu) {
        if (lagu) {
            const isExist = songHistory.some(s => s.id === lagu.id);
            if (!isExist) {
                songHistory.unshift(lagu);
                if (songHistory.length > 10) songHistory.pop();
            }
        }
    }

    socket.emit('sync-ai-modes', { tanya: isTanyaJawabActive, curhat: isCurhatActive });
    socket.on('update-ai-modes', (data) => {
        isTanyaJawabActive = data.tanya;
        isCurhatActive = data.curhat;
        console.log(`🤖 [AI MODE UPDATE] Tanya: ${isTanyaJawabActive} | Curhat: ${isCurhatActive}`);
        io.emit('sync-ai-modes', { tanya: isTanyaJawabActive, curhat: isCurhatActive });
    });

    socket.emit('sync-chat-reading', isChatReadingActive);
    socket.on('update-chat-reading', (data) => {
        isChatReadingActive = data?.aktif !== false;
        console.log(`🔊 [CHAT VOICE] Baca chat: ${isChatReadingActive ? 'AKTIF' : 'NONAKTIF'}`);
        io.emit('sync-chat-reading', isChatReadingActive);
    });


    socket.on('change-request-mode', (mode) => {
        currentRequestMode = mode;
        console.log(`⚙️ Mode Request Diubah ke: ${currentRequestMode.toUpperCase()}`);
        io.emit('sync-request-mode', currentRequestMode);
    });

    socket.on("set-karaoke-mode", (status) => {
        isKaraokeModeActive = status;
        console.log(`🔒 [SYSTEM] Mode Karaoke diubah menjadi: ${isKaraokeModeActive ? "AKTIF (Request Viewer Ditutup)" : "NONAKTIF"}`);
    });

    socket.emit('sync-max-quota', maxRequestLimit);
    socket.on('change-max-quota', (newLimit) => {
        maxRequestLimit = parseInt(newLimit);
        console.log(`[INFO] Batas kuota request per user diubah menjadi: ${maxRequestLimit}`);
        io.emit('sync-max-quota', maxRequestLimit);
    });

    socket.emit('sync-request-active-state', isRequestActive);
    socket.on('change-request-active-state', (state) => {
        isRequestActive = state;
        console.log(`[INFO] Sesi Request Lagu diubah menjadi: ${isRequestActive ? 'AKTIF (ON) 🟢' : 'NONAKTIF (OFF) 🔴'}`);
        io.emit('sync-request-active-state', isRequestActive);
    });

    socket.on('play-request-song', (songId) => {
        console.log("▶ PLAY REQUEST MANUAL ID:", songId);
        const index = songQueue.findIndex(s => s.id === songId);
        if (index === -1) return;

        catatKeRiwayat(currentSong);
        const selectedSong = songQueue[index];
        songQueue.splice(index, 1);
        currentSong = selectedSong;
        isMusicPlaying = true;
        pausedMusicSeconds = 0;

        console.log("🎵 Now Playing:", currentSong.title);
        io.emit('update-queue', { currentSong, songQueue, songHistory, isPlaying: true });
        startServerMusicTimer(true);
    });

    socket.on('kontrol-musik', (aksi) => {
        console.log("Menerima perintah kontrol:", aksi);

        if (aksi === 'play' && currentSong) {
            isMusicPlaying = true;
            startServerMusicTimer(false);
        } else if (aksi === 'pause' && currentSong) {
            pausedMusicSeconds = Math.min(
                Number(currentSong.duration) || ((maxDurationMinutes || 5) * 60),
                (Date.now() - musicStartTime) / 1000
            );
            isMusicPlaying = false;
            stopServerMusicTimer();
            emitMusicTick(pausedMusicSeconds);
        } else if (aksi === 'next') {
            advanceToNextSong();
            return;
        }

        io.emit('terima-kontrol', aksi);
        if (currentSong) emitMusicTick(isMusicPlaying ? (Date.now() - musicStartTime) / 1000 : pausedMusicSeconds);
    });

    socket.on('next-song', () => {
        console.log("⏭️ Next song triggered");
        advanceToNextSong();
    });
    // TAMBAHKAN BARIS INI UNTUK MENANGKAP EVENT DARI YOUTUBE PLAYER
    socket.on('player-ended', () => {
        console.log("✅ [YOUTUBE] Video selesai diputar. Melanjutkan ke lagu berikutnya...");
        advanceToNextSong();
    });

    socket.on('next-song-manual', () => {
        console.log("⏭️ Next song manual triggered");
        advanceToNextSong();
    });

    socket.on('reset-queue', () => {
        console.log("🧹 Queue & History direset dari dashboard");
        songQueue = [];
        songHistory = [];
        currentSong = null;
        isMusicPlaying = false;
        pausedMusicSeconds = 0;
        stopServerMusicTimer();
        io.emit('update-queue', { currentSong, songQueue, songHistory, isPlaying: false });
    });

    socket.on('delete-song', (songId) => {
        console.log(`🗑️ Menghapus lagu ID: ${songId}`);
        songQueue = songQueue.filter(song => song.id !== songId);
        io.emit('update-queue', { currentSong, songQueue, songHistory });
    });

    socket.on("manual-add-song", async (song) => {
        console.log("🔥 REQUEST MANUAL MERAPAT — DJ HOST TURUN TANGAN!:", song);
        if (!song || !song.title) return;

        try {
            const query = `${song.title} ${song.artist || ''}`.trim();
            console.log(`[YouTube] Lagi berburu lagu: ${query}... Semoga ketemu, bukan kenangan.`);

            const searchResults = await play.search(query, { limit: 1 });
            if (!searchResults || searchResults.length === 0) {
                console.log("Lagu nggak ketemu, brow! Mungkin lagi healing di YouTube.");
                return;
            }

            const topVideo = searchResults[0];
            const durasiDetik = topVideo.durationInSec || 180;
            const limitDetik = maxDurationMinutes * 60;
            let durationApplied = durasiDetik;
            let isDurationCut = false;

            if (durasiDetik > limitDetik) {
                durationApplied = limitDetik;
                isDurationCut = true;
                console.log(`⏱️ [MANUAL REQ] Lagu "${topVideo.title}" kepanjangan, jadi kita potong biar nggak berubah jadi konser 3 jam! Durasi: ${limitDetik} detik.`);
            } else {
                console.log(`⏱️ [MANUAL REQ] Lagu "${topVideo.title}" aman terkendali. Durasi: ${durasiDetik}s | Batas maksimal: ${limitDetik}s.`);
            }

            const newSongRequest = {
                id: Date.now(),
                title: topVideo.title,
                url: topVideo.url,
                youtubeId: topVideo.id,
                requestedBy: "HOST",
                userAvatar: "",
                vvip: false,
                duration: durationApplied,
                isCut: isDurationCut
            };

            let isMulaiDiputar = false;
            if (!currentSong) {
                currentSong = newSongRequest;
                isMulaiDiputar = true;
                console.log(`[PLAY OTOMATIS] Player masih kosong, lagunya langsung naik panggung: ${topVideo.title}`);
                setTimeout(() => io.emit('terima-kontrol', 'play'), 1000);
                isMusicPlaying = true;
                startServerMusicTimer(true);
            } else {
                songQueue.push(newSongRequest);
                console.log(`[ANTRE NORMAL] ${topVideo.title} masuk antrean. Sabar ya, semua akan joget pada waktunya.`);
            }

            const ucapanKece = [
                `Wih, selera musikmu nggak kaleng-kaleng, brow!`,
                `Siap, lagu pilihanmu sudah diamankan. Dompet aman, playlist nyaman!`,
                `Mantap! Telinga kita sebentar lagi naik level.`,
                `Request diterima! Gas langsung pasang sepatu joget.`,
                `Gokil, pilihan lagunya bikin speaker ikut semangat!`,
                `Siap meluncur! Semoga yang denger nggak cuma mantan.`
            ];
            const randomUcapan = ucapanKece[Math.floor(Math.random() * ucapanKece.length)];

            aiQueue.push({
                isLocal: true,
                jawabanLokal: `${randomUcapan} Request dari ${newSongRequest.requestedBy}. Lagu "${topVideo.title}" ${isMulaiDiputar ? 'langsung diputar, gaskeun!' : 'sudah masuk antrean!'}`,
                mode: 'tanya'
            });
            processAiQueue();
            io.emit('update-queue', { currentSong, songQueue, songHistory });
            io.emit("song-request", { user: "HOST", nickname: "HOST", query, source: "manual" });

        } catch (error) {
            console.error("[YouTube Error] Waduh, lagu gagal diproses. YouTube-nya mungkin sedang ngopi:", error);
        }
    });

    socket.on('request-by-link', async (data) => {
        try {
            let { url, requestedBy } = data;
            console.log("Menerima link mentah:", url);

            if (url.includes('youtube.com/watch')) {
                const urlObj = new URL(url);
                const videoId = urlObj.searchParams.get('v');
                if (videoId) url = `https://www.youtube.com/watch?v=${videoId}`;
            }

            const ytValidate = play.yt_validate(url);
            if (!ytValidate || (ytValidate !== 'video' && !url.includes('youtu.be') && !url.includes('v='))) {
                console.log("Link yang dimasukkan bukan link video YouTube valid.");
                return;
            }

            console.log("Mengekstrak data dari link bersih:", url);
            const videoInfo = await play.video_basic_info(url);
            const videoTitle = videoInfo.video_details.title;
            const extractedId = videoInfo.video_details.id;
            console.log("Berhasil mendapatkan YouTube ID:", extractedId);

            const durasiDetik = videoInfo.video_details.durationInSec || 180;
            const limitDetik = maxDurationMinutes * 60;
            let durationApplied = durasiDetik;
            let isDurationCut = false;

            if (durasiDetik > limitDetik) {
                durationApplied = limitDetik;
                isDurationCut = true;
                console.log(`⏱️ [DURATION CHECK] Lagu Link "${videoTitle}" berdurasi ${durasiDetik}s dipotong ke ${limitDetik}s!`);
            } else {
                console.log(`⏱️ [DURATION CHECK] Lagu Link "${videoTitle}" aman. Durasi asli: ${durasiDetik}s`);
            }

            const newSongRequest = {
                id: Date.now(),
                title: videoTitle,
                url: url,
                youtubeId: extractedId,
                requestedBy: requestedBy || "Admin / User Link",
                userAvatar: "",
                duration: durationApplied,
                isCut: isDurationCut
            };

            if (!currentSong) {
                currentSong = newSongRequest;
                console.log(`[PLAY OTOMATIS] Pemutar kosong, langsung memutar: ${videoTitle}`);
                setTimeout(() => io.emit('terima-kontrol', 'play'), 1000);
                startServerMusicTimer();
            } else {
                songQueue.push(newSongRequest);
                console.log(`[ANTRE] Ada lagu sedang berputar, ${videoTitle} masuk list.`);
            }
            io.emit('update-queue', { currentSong, songQueue, songHistory });

        } catch (error) {
            console.error("Gagal memproses link YouTube:", error);
        }
    });

    socket.on('reorder-queue', (newQueue) => {
        songQueue = newQueue;
        io.emit('update-queue', { currentSong, songQueue, songHistory });
    });

    socket.on('simulateJoin', (data) => {
        console.log(`[SIMULASI JOIN] ${data.nickname} memicu overlay!`);
        io.emit('new-join', data);
    });

    socket.on('test-join', () => {
        console.log('🧪 TEST JOIN');
        io.emit('new-join', {
            user: 'WebDev Tester',
            nickname: 'WebDev Tester',
            profilePictureUrl: 'https://www.w3schools.com/howto/img_avatar.png'
        });
    });

    socket.on('test-gift', () => {
        io.emit('new-gift', {
            nickname: 'WebDev Tester',
            giftName: 'Rose',
            count: 1,
            giftIcon: 'https://p16-va-default.akamaized.net/obj/v-us/7074251703138307077'
        });
    });

    socket.on('toggle-chat-visibility', (isVisible) => {
        io.emit('toggle-chat-visibility', isVisible);
        console.log(`[REMOTE CONTROL] Status visibility dirubah ke: ${isVisible ? 'TAMPIL' : 'SEMBUNYI'}`);
    });

    socket.on('toggle-visibility', (isVisible) => {
        io.emit('toggle-chat-visibility', isVisible);
    });

    socket.on("test-gift-trigger", () => {
        console.log("Server menerima request TEST. Membuat data tiruan...");
        const mockGiftData = {
            nickname: "Sultan_Preview",
            giftName: "Rose",
            count: 1,
            profilePictureUrl: "https://i.imgur.com/7k12EPD.png"
        };
        io.emit("new-gift", mockGiftData);

        if (activeMilestones.length > 0) {
            let isMilestoneUpdated = false;
            activeMilestones = activeMilestones.map(milestone => {
                const namaGiftLive = mockGiftData.giftName.toLowerCase().replace(/\s+/g, '');
                const namaGiftTarget = milestone.giftName.toLowerCase().replace(/\s+/g, '');

                if (namaGiftLive === namaGiftTarget) {
                    const jumlahBaru = milestone.currentValue + (mockGiftData.count || 1);
                    isMilestoneUpdated = true;
                    console.log(`📈 [MILESTONE MATCHED] ${milestone.title}: +${mockGiftData.count || 1}`);
                    return { ...milestone, currentValue: Math.min(jumlahBaru, milestone.targetValue) };
                }
                return milestone;
            });
            if (isMilestoneUpdated) io.emit('sync-active-milestones', activeMilestones);
        }
    });

    socket.on('get-status', () => {
        if (isConnected && currentUsername) {
            socket.emit('status', `Tersambung: ${currentUsername}`);
            socket.emit('tiktok-connected', { startTime: liveStartTime });
            socket.emit('sync-user-input', currentUsername);
            socket.emit('update-sebaran', { total: sebaranUsers.size });
            if (tiktokConnection && tiktokConnection.roomInfo && tiktokConnection.roomInfo.likeCount) {
                socket.emit('like-stats', { totalLikeCount: tiktokConnection.roomInfo.likeCount });
            }
        } else {
            socket.emit('status', 'Terputus');
        }
    });

    socket.on('test-gift-combo', () => {
        console.log("Sinyal test diterima, menyebarkan ke overlay...");
        io.emit('new-gift', { user: 'WebDev Test', giftName: 'Rose', count: 1 });
    });

    socket.on("social:update", (data) => {
        socialState = data;
        console.log("📢 Social Update:", socialState);
        io.emit("social:update", socialState);
    });

    socket.on("social:request", () => {
        socket.emit("social:update", socialState);
    });

    socket.on('test-share', () => {
        console.log("🧪 Menjalankan simulasi Share...");
        io.emit('new-share', {
            user: 'webdev_tester',
            nickname: 'WebDev Tester',
            profilePictureUrl: 'https://p16-sign-va.tiktokcdn.com/tos-maliva-avt-0068/default_avatar~tplv-tiktok-shrink:100:100.jpeg'
        });
    });

    console.log('🖥️ Client terhubung ke Dashboard/Monitoring');

    if (Object.keys(topGifts).length > 0) {
        let sortedSultans = Object.values(topGifts).sort((a, b) => b.total - a.total).slice(0, 5);
        socket.emit('update-top-gift', sortedSultans);
    }
    if (Object.keys(topLikes).length > 0) {
        socket.emit('new-like', { allLikes: topLikes });
    }

    socket.on('set-target', (username) => {

        socket.emit('server-log', {
            level: 'info',
            message: `Memulai koneksi TikTok: @${String(username || '').replace(/^@/, '')}`
        });

        if (!username) return socket.emit('status', 'Username kosong!');
        setupTikTokEvents(username, socket);
    });

    socket.on('send-to-overlay', (data) => {
        // Tetap tampilkan chat pada overlay.
        // Baris ini jangan dihapus.
        io.emit('display-chat', data);

        // Suara hanya dipicu oleh monitoring:
        // - saat chat diklik
        // - atau saat AUTO aktif
        //
        // Tombol baca chat pada AI Control tetap menjadi sakelar utama.
        if (isChatReadingActive && data?.message) {
            io.emit('play-chat-tts', {
                user: data.nickname || data.uniqueId || 'Penonton',
                text: String(data.message).slice(0, 160)
            });
        }
    });


    socket.on('reset-session', () => {
        isConnected = false;
        currentUsername = null;
        liveStartTime = null;

        if (tiktokConnection) {
            tiktokConnection.disconnect();
            tiktokConnection = null;
        }

        aiQueue = [];
        isAiProcessing = false;
        topGifts = {};
        topLikes = {};
        sebaranUsers = new Set();
        totalFollowers = new Set();
        activeDetectedViewers.clear();


        io.emit('status', 'Terputus (Reset)');
        io.emit('update-sebaran', { total: 0 });
        io.emit('update-top-gift', []);
        io.emit('new-like', { allLikes: {} });
        io.emit('update-viewer-count', { count: 0 });
        io.emit('update-follower-count', { total: 0 });
        io.emit('active-viewers', []);
        io.emit('tiktok-disconnected');
        console.log('🧹 Sesi direset oleh user');
    });

    socket.on('get-brand-texts', () => {
        socket.emit('brand-texts-changed', brandTexts);
    });

    socket.on('test-follower-milestone', () => {
        if (typeof global.testFollowCount === 'undefined') global.testFollowCount = 0;
        global.testFollowCount += 1;
        io.emit('update-follower-count', { total: global.testFollowCount });
        console.log("Test Follower: " + global.testFollowCount);
    });

    socket.on('test-follow', () => {
        io.emit('new-follower', {
            user: 'tester_squad',
            nickname: 'Follower Baru',
            profilePictureUrl: 'https://www.w3schools.com/howto/img_avatar.png'
        });
        console.log("🧪 Simulasi Follower dikirim ke overlay.");
    });

    socket.on('reset-battle', () => {
        io.emit('reset-battle');
    });

    socket.on('start-tebak', (data) => {
        console.log("Menerima perintah tebak kata:", data);
        io.emit('start-tebak', data);
    });

    socket.on('start-monster', (data) => {
        io.emit('start-monster', data);
    });

    socket.on('simulateGift', (data) => {
        console.log("🔥 Menyebarkan data simulasi gift dari dashboard ke overlay...");
        io.emit('new-gift', data);

        if (activeMilestones.length > 0) {
            let isMilestoneUpdated = false;
            activeMilestones = activeMilestones.map(milestone => {
                const namaGiftLive = data.giftName ? data.giftName.toLowerCase().replace(/\s+/g, '') : '';
                const namaGiftTarget = milestone.giftName.toLowerCase().replace(/\s+/g, '');

                if (namaGiftLive === namaGiftTarget) {
                    isMilestoneUpdated = true;
                    const jumlahTambah = parseInt(data.count || data.repeatCount || 1);
                    return { ...milestone, currentValue: Math.min(milestone.targetValue, milestone.currentValue + jumlahTambah) };
                }
                return milestone;
            });
            if (isMilestoneUpdated) io.emit('sync-active-milestones', activeMilestones);
        }

        const mockChatGift = {
            uniqueId: data.uniqueId || 'tester_ganteng',
            nickname: data.nickname || 'Tester Ganteng',
            comment: `🎁 Mengirim Gift ${data.giftName} x${data.count || data.repeatCount || 1}`,
            profilePictureUrl: data.profilePictureUrl || 'https://www.w3schools.com/howto/img_avatar.png'
        };
        io.emit('display-chat', mockChatGift);
    });

    socket.on('sync-actual-time', (data) => {
        if (currentSong && currentSong.id === data.songId) {
            // Update waktu aktual yang dilaporkan oleh YouTube Player
            pausedMusicSeconds = data.currentTime;

            // Opsional: Jika status isPlaying berbeda, bisa update state
            if (data.isPlaying !== undefined) {
                isMusicPlaying = data.isPlaying;
            }
        }
    });



});

//app.get('/soundcloud-studio', (req, res) => {
//res.sendFile(path.join(__dirname, 'soundcloud-studio.html'));
//});


/*SERVER STARTUP*/
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server Berjalan di port ${PORT}\n🔗 Dashboard: http://127.0.0.1:${PORT}\n`);
});