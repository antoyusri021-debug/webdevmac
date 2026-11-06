/**-------------------WEBDEV---------------------
 * CORE MODULE SETUP
 ------------------------------------------------*/
require('dotenv').config();

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
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    maxHttpBufferSize: 500 * 1024 * 1024 // batas 500 MB per file
});


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

// SUBATHON: satu engine menangani persistensi, timer, aturan gift, dan sinkronisasi overlay.
const attachSubathon = require('./subathon-engine');
const subathonEngine = attachSubathon(io, saveDir);

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
// 📂 GIFT ANIMATION SETTINGS (PEMICU & VISUAL)
// =================================================================
const giftAnimationSettingsPath = path.join(saveDir, 'gift-animation-mappings.json');
let giftAnimationMappings = [];

if (fs.existsSync(giftAnimationSettingsPath)) {
    try {
        giftAnimationMappings = JSON.parse(fs.readFileSync(giftAnimationSettingsPath, 'utf8'));
        console.log(`🎁 [GIFT ANIMATION] Berhasil memuat ${giftAnimationMappings.length} mapping.`);
    } catch (e) {
        console.error('❌ [GIFT ANIMATION] Gagal memuat file mapping:', e.message);
    }
}

// Helper untuk menyimpan settings
function saveGiftAnimationMappings(data) {
    giftAnimationMappings = Array.isArray(data) ? data : [];
    fs.writeFile(giftAnimationSettingsPath, JSON.stringify(giftAnimationMappings, null, 2), 'utf8', (err) => {
        if (err) console.error('❌ Gagal simpan gift animation mappings:', err);
        else console.log('✅ Gift animation mappings berhasil disimpan.');
    });
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
const LYRICS_CACHE_MAX_ENTRIES = 200;

function splitLyricsTitle(title, artist = '') {
    const cleanTitle = cleanYouTubeTitle(title);
    const givenArtist = String(artist || '').trim();

    if (givenArtist) {
        const escapedArtist = givenArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const artistPrefix = new RegExp(
            `^${escapedArtist}\\s*[-–—:]\\s*`,
            'i'
        );

        return {
            track: cleanTitle.replace(artistPrefix, '').trim(),
            artist: givenArtist
        };
    }

    // Banyak judul video memakai format "Artis - Judul Lagu".
    const match = cleanTitle.match(/^(.+?)\s[-–—]\s(.+)$/);
    if (match) {
        return {
            artist: match[1].trim(),
            track: match[2].trim()
        };
    }

    return { track: cleanTitle, artist: '' };
}

function isRemixOrDjLyrics(title) {
    return /\b(remix(?:ed)?|bootleg|mash[ -]?up|nightcore|sped[ -]?up|slowed|extended mix|club mix|dance mix|dj set|dj mix|nonstop mix|mix set|dj)\b/i
        .test(String(title || ''));
}

function normalizeLyricsMatch(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function scoreLyricsMatch(record, track, artist, durationSeconds) {
    const resultTitle = normalizeLyricsMatch(record?.trackName || record?.name);
    const wantedTitle = normalizeLyricsMatch(track);
    const resultArtist = normalizeLyricsMatch(record?.artistName);
    const wantedArtist = normalizeLyricsMatch(artist);

    if (!resultTitle || !wantedTitle) return -1;

    let score = 0;

    if (resultTitle === wantedTitle) {
        score += 5;
    } else {
        const wantedWords = [...new Set(
            wantedTitle.split(' ').filter(word => word.length > 1)
        )];
        const resultWords = new Set(resultTitle.split(' '));

        if (!wantedWords.length) return -1;

        const overlap =
            wantedWords.filter(word => resultWords.has(word)).length /
            wantedWords.length;

        // Tolak kandidat yang judulnya terlalu jauh berbeda.
        if (overlap < 0.8) return -1;
        score += overlap * 4;
    }

    if (wantedArtist && resultArtist === wantedArtist) {
        score += 4;
    } else if (wantedArtist && resultArtist.includes(wantedArtist)) {
        score += 2;
    }

    const resultDuration = Number(record?.duration || 0);
    const wantedDuration = Number(durationSeconds || 0);

    if (resultDuration > 0 && wantedDuration > 0) {
        const difference = Math.abs(resultDuration - wantedDuration);
        if (difference <= 3) score += 2;
        else if (difference <= 12) score += 1;
    }

    return score;
}

async function requestLrclib(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'MusicStudioYouTube/1.0 (synced lyrics overlay)'
            }
        });

        if (response.status === 429) {
            console.warn(
                `⚠️ LRCLIB membatasi request. Coba lagi nanti. Retry-After: ${response.headers.get('retry-after') || 'tidak diberikan'
                }`
            );
            return null;
        }

        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.warn('⚠️ Request LRCLIB gagal:', error.message);
        return null;
    }
}

function parseSyncedLyrics(record) {
    if (!record?.syncedLyrics) return [];

    return parseLrc(record.syncedLyrics)
        .filter(line => Number.isFinite(Number(line.time)) && line.text)
        .sort((a, b) => a.time - b.time);
}

async function findLyricsInLrclib(track, artist, durationSeconds = 0) {
    // Percobaan pertama: pencocokan terstruktur dengan artis dan durasi.
    if (artist) {
        const params = new URLSearchParams({
            track_name: track,
            artist_name: artist
        });

        if (Number(durationSeconds) > 0) {
            params.set('duration', String(Math.round(Number(durationSeconds))));
        }

        const exactRecord = await requestLrclib(
            `https://lrclib.net/api/get?${params}`
        );
        const exactLyrics = parseSyncedLyrics(exactRecord);

        if (exactLyrics.length) return exactLyrics;

        // Coba lagi tanpa durasi karena durasi video YouTube bisa berbeda.
        const paramsWithoutDuration = new URLSearchParams({
            track_name: track,
            artist_name: artist
        });

        const recordWithoutDuration = await requestLrclib(
            `https://lrclib.net/api/get?${paramsWithoutDuration}`
        );
        const lyricsWithoutDuration = parseSyncedLyrics(recordWithoutDuration);

        if (lyricsWithoutDuration.length) return lyricsWithoutDuration;
    }

    // Jika pencocokan langsung gagal, cari berdasarkan kata kunci.
    const queries = [...new Set([
        [artist, track].filter(Boolean).join(' '),
        track
    ].filter(Boolean))];

    for (const query of queries) {
        const records = await requestLrclib(
            `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`
        );

        if (!Array.isArray(records)) continue;

        const candidates = records
            .filter(record => record?.syncedLyrics)
            .map(record => ({
                record,
                score: scoreLyricsMatch(record, track, artist, durationSeconds)
            }))
            .filter(candidate => candidate.score >= 5)
            .sort((a, b) => b.score - a.score);

        for (const candidate of candidates) {
            const lyrics = parseSyncedLyrics(candidate.record);
            if (lyrics.length) return lyrics;
        }
    }

    return [];
}

async function getLyricsCached(title, artist = '', durationSeconds = 0) {
    const { track, artist: resolvedArtist } =
        splitLyricsTitle(title, artist);

    if (!track) return [];

    // Lagu remix/DJ tetap masuk dan diputar, tetapi tidak dicari liriknya.
    if (isRemixOrDjLyrics(`${title} ${resolvedArtist}`)) {
        console.log(`⏭️ Lirik dilewati untuk lagu remix/DJ: ${title}`);
        return [];
    }

    const cacheKey = [
        track,
        resolvedArtist,
        Math.round(Number(durationSeconds) || 0)
    ]
        .map(value => String(value).trim().toLowerCase())
        .join('|');

    if (lyricsCache.has(cacheKey)) {
        const cachedLyrics = lyricsCache.get(cacheKey);
        lyricsCache.delete(cacheKey);
        lyricsCache.set(cacheKey, cachedLyrics);
        return cachedLyrics;
    }

    try {
        const lyrics = await findLyricsInLrclib(
            track,
            resolvedArtist,
            durationSeconds
        );

        if (lyrics.length) {
            console.log(
                `✅ LRCLIB menemukan ${lyrics.length} baris lirik: ${track}`
            );
        } else {
            console.warn(
                `⚠️ Lirik tersinkron tidak ditemukan: ${track}` +
                (resolvedArtist ? ` — ${resolvedArtist}` : '')
            );
        }

        lyricsCache.set(cacheKey, lyrics);

        while (lyricsCache.size > LYRICS_CACHE_MAX_ENTRIES) {
            lyricsCache.delete(lyricsCache.keys().next().value);
        }

        return lyrics;
    } catch (error) {
        console.error(
            `❌ Gagal mengambil lirik LRCLIB untuk "${title}":`,
            error.message
        );
        return [];
    }
}


// Ambil lirik di latar belakang setelah lagu masuk currentSong/queue.
// Layanan lirik yang lambat/tidak tersedia tidak lagi menahan request musik.
function loadSongLyricsInBackground(song, title, artist = '', durationSeconds = 0) {
    const songId = String(song?.id ?? '');
    if (!songId) return;

    setImmediate(async () => {
        try {
            const result = await getLyricsCached(title, artist, durationSeconds);
            const target = currentSong && String(currentSong.id) === songId
                ? currentSong
                : songQueue.find(item => String(item.id) === songId);

            // Abaikan hasil lirik jika lagu sudah dihapus dari player/antrean.
            if (!target) return;

            target.lyrics = Array.isArray(result) ? result : [];
            console.log(`🎤 [LYRICS BACKGROUND] ${target.lyrics.length} baris siap untuk "${target.title}".`);
            io.emit('update-queue', { currentSong, songQueue, songHistory });
        } catch (error) {
            console.warn(`⚠️ [LYRICS BACKGROUND] Gagal memuat lirik untuk "${title}", lagu tetap diputar: ${error?.message || error}`);
        }
    });
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
app.get('/monitoringmacOS', (req, res) => { res.sendFile(path.join(__dirname, 'monitoringmacOS.html')); });
app.get('/ai-control', (req, res) => res.sendFile(path.join(__dirname, 'tools', 'ai-control.html')));
// =================================================================
// 🎞️ ROUTE STREAMING VIDEO LOKAL (DRIVE C, D, E, DLL)
// =================================================================
app.get('/stream-video', (req, res) => {
    const rawPath = req.query.path;
    if (!rawPath) return res.status(400).send('Path video kosong');

    const filePath = decodeURIComponent(rawPath);

    if (!fs.existsSync(filePath)) {
        console.error('❌ [STREAM VIDEO] File tidak ditemukan:', filePath);
        return res.status(404).send('File video tidak ditemukan');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
        });
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        });
        fs.createReadStream(filePath).pipe(res);
    }
});


// =================================================================
// 📊 GLOBAL STATE MANAGEMENT
// =================================================================
let tiktokConnection = null;
let currentUsername = null;
let isConnected = false;
let liveStartTime = null;

let topGifts = {};
let topGiftBroadcastTimer = null;
let topLikes = {};
let totalLikeCount = 0;
let sebaranUsers = new Set();
let totalFollowers = new Set();
// Whitelist follower dipisahkan per akun LIVE host agar tidak tercampur saat host diganti.
const followedUsersByHostFile = path.join(saveDir, 'followed-users-by-host.json');
let followedUsersByHost = {};
let followedTikTokUsers = new Set();
let activeFollowHost = '';

function normalizeTikTokId(value) {
    return String(value || '')
        .trim()
        .replace(/^@/, '')
        .toLowerCase();
}

function getTikTokFollowerKeys(userData = {}) {
    const keys = new Set();
    const nestedUser = userData.user && typeof userData.user === 'object'
        ? userData.user
        : {};

    const username = normalizeTikTokId(
        userData.uniqueId ||
        userData.unique_id ||
        userData.username ||
        userData.userName ||
        nestedUser.uniqueId ||
        nestedUser.unique_id ||
        (typeof userData.user === 'string' ? userData.user : '')
    );
    if (username) keys.add(username);

    const userId = String(
        userData.userId ||
        userData.user_id ||
        userData.id ||
        nestedUser.userId ||
        nestedUser.user_id ||
        nestedUser.id ||
        ''
    ).trim();
    if (userId) keys.add(`id:${userId}`);

    return [...keys];
}

try {
    if (fs.existsSync(followedUsersByHostFile)) {
        const saved = JSON.parse(fs.readFileSync(followedUsersByHostFile, 'utf8'));
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            followedUsersByHost = saved;
        }
        console.log(`✅ [FOLLOW GATE] Data follower per-host dimuat dari ${followedUsersByHostFile}`);
    }

    const legacyGlobalFile = path.join(saveDir, 'followed-users.json');
    if (fs.existsSync(legacyGlobalFile)) {
        console.warn(`⚠️ [FOLLOW GATE] File lama ${legacyGlobalFile} tidak dipakai karena tidak terikat ke akun host. Setiap host akan memakai whitelist terpisah agar follower akun lain tidak lolos.`);
    }
} catch (error) {
    console.error('❌ [FOLLOW GATE] Gagal membaca data follower per-host:', error.message);
    followedUsersByHost = {};
}

function setActiveFollowHost(hostUsername) {
    const hostKey = normalizeTikTokId(hostUsername);
    if (!hostKey) {
        activeFollowHost = '';
        followedTikTokUsers = new Set();
        specificGiftRequestProgress.clear();
        specificGiftRequestTickets.clear();
        giftRequestUsers.clear();
        console.warn('⚠️ [FOLLOW GATE] Akun host kosong; whitelist follow dan tiket gift dikosongkan.');
        return;
    }

    if (hostKey === activeFollowHost) return;

    activeFollowHost = hostKey;
    specificGiftRequestProgress.clear();
    specificGiftRequestTickets.clear();
    giftRequestUsers.clear();
    const savedUsers = Array.isArray(followedUsersByHost[hostKey])
        ? followedUsersByHost[hostKey]
        : [];
    followedTikTokUsers = new Set(
        savedUsers.map(value => String(value || '').trim()).filter(Boolean)
    );

    console.log(`🔐 [FOLLOW GATE] Host aktif=@${activeFollowHost}; dimuat ${followedTikTokUsers.size} key follower khusus host ini.`);
}

function saveFollowedTikTokUsers() {
    if (!activeFollowHost) {
        console.error('❌ [FOLLOW GATE] Tidak dapat menyimpan follower: akun host aktif belum ditentukan.');
        return false;
    }

    try {
        fs.mkdirSync(path.dirname(followedUsersByHostFile), { recursive: true });
        followedUsersByHost[activeFollowHost] = [...followedTikTokUsers];
        fs.writeFileSync(
            followedUsersByHostFile,
            JSON.stringify(followedUsersByHost, null, 2),
            'utf8'
        );
        return true;
    } catch (error) {
        console.error('❌ [FOLLOW GATE] Gagal menyimpan daftar follower:', error.message);
        return false;
    }
}

function rememberTikTokFollower(userData = {}) {
    const keys = getTikTokFollowerKeys(userData);
    if (!activeFollowHost) {
        console.warn('⚠️ [FOLLOW EVENT] Event follow diabaikan karena akun host aktif belum diketahui.');
        return false;
    }
    if (!keys.length) {
        console.warn('⚠️ [FOLLOW EVENT] TikTok mengirim event follow tanpa username/userId yang bisa dikenali:', JSON.stringify({
            displayType: userData.displayType,
            uniqueId: userData.uniqueId,
            userId: userData.userId
        }));
        return false;
    }

    const newKeys = keys.filter(key => !followedTikTokUsers.has(key));
    newKeys.forEach(key => followedTikTokUsers.add(key));
    const saved = newKeys.length === 0 || saveFollowedTikTokUsers();

    console.log(
        `${newKeys.length ? '✅' : 'ℹ️'} [FOLLOW EVENT] @${userData.uniqueId || keys[0]} ` +
        `${newKeys.length ? 'berhasil dicatat' : 'sudah tercatat'} untuk host @${activeFollowHost}; ` +
        `keys=${keys.join(',')}; hostKeys=${followedTikTokUsers.size}; saved=${saved}`
    );
    return true;
}

function ensureFollowerForSongRequest(userData = {}) {
    const keys = getTikTokFollowerKeys(userData);
    const matchedKey = keys.find(key => followedTikTokUsers.has(key));
    const username = userData.uniqueId || keys[0] || '(unknown user)';

    if (matchedKey) {
        console.log(`✅ [FOLLOW CHECK] @${username} LOLOS untuk host @${activeFollowHost}; cocok dengan ${matchedKey}.`);
        return true;
    }

    console.warn(
        `🚫 [FOLLOW CHECK] @${username} DITOLAK untuk host @${activeFollowHost || '(belum dipilih)'}; ` +
        `belum follow host ini. requestKeys=${keys.length ? keys.join(',') : '(kosong)'}; ` +
        `hostKeys=${followedTikTokUsers.size}`
    );

    if (keys.length) {
        const primaryKey = keys[0];
        if (primaryKey.startsWith('id:')) giftRequestUsers.delete(primaryKey.slice(3));
        else giftRequestUsers.delete(primaryKey);
    }

    io.emit('song-request-denied', {
        user: userData.uniqueId || '',
        nickname: userData.nickname || userData.uniqueId || 'Penonton',
        profilePictureUrl: userData.profilePictureUrl || '',
        message: `Event request lagu khusus follower @${activeFollowHost || 'host'}. Follow host ini dulu, lalu kirim ulang request lagumu.`
    });
    return false;
}
let giftRequestUsers = new Map();
let isSpecificGiftRequestEnabled = false; // OFF secara default meski konfigurasi gift tersimpan
let specificGiftRequestGiftName = '';
let specificGiftRequestRequiredCount = 1;
const specificGiftRequestProgress = new Map();
const specificGiftRequestTickets = new Map();
const specificGiftRequestSettingsFile = path.join(saveDir, 'specific-gift-request-settings.json');

try {
    if (fs.existsSync(specificGiftRequestSettingsFile)) {
        const savedGiftSettings = JSON.parse(fs.readFileSync(specificGiftRequestSettingsFile, 'utf8'));
        specificGiftRequestGiftName = String(savedGiftSettings.giftName || '').trim();
        specificGiftRequestRequiredCount = Math.max(1, Math.floor(Number(savedGiftSettings.requiredCount) || 1));
        console.log(`🎁 [SPECIFIC GIFT REQUEST] Konfigurasi dimuat: ${specificGiftRequestGiftName || '(belum diatur)'} x${specificGiftRequestRequiredCount}; toggle tetap OFF saat server mulai.`);
    }
} catch (error) {
    console.error('❌ [SPECIFIC GIFT REQUEST] Gagal memuat konfigurasi:', error.message);
}

function normalizeSpecificGiftName(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getSpecificGiftRequestSettings() {
    return {
        enabled: isSpecificGiftRequestEnabled,
        giftName: specificGiftRequestGiftName,
        requiredCount: specificGiftRequestRequiredCount
    };
}

function saveSpecificGiftRequestSettings() {
    try {
        fs.mkdirSync(path.dirname(specificGiftRequestSettingsFile), { recursive: true });
        // Simpan nama/jumlah saja. Toggle sengaja kembali OFF setelah restart.
        fs.writeFileSync(specificGiftRequestSettingsFile, JSON.stringify({
            giftName: specificGiftRequestGiftName,
            requiredCount: specificGiftRequestRequiredCount
        }, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('❌ [SPECIFIC GIFT REQUEST] Gagal menyimpan konfigurasi:', error.message);
        return false;
    }
}

function applySpecificGiftRequestSettings(payload = {}) {
    const oldGiftName = normalizeSpecificGiftName(specificGiftRequestGiftName);
    const oldCount = specificGiftRequestRequiredCount;
    const requestedGiftName = String(payload.giftName ?? specificGiftRequestGiftName).trim();
    const requestedCount = Math.floor(Number(payload.requiredCount ?? specificGiftRequestRequiredCount));

    specificGiftRequestGiftName = requestedGiftName;
    specificGiftRequestRequiredCount = Number.isFinite(requestedCount) && requestedCount > 0
        ? Math.min(requestedCount, 100000)
        : 1;

    const configChanged = oldGiftName !== normalizeSpecificGiftName(specificGiftRequestGiftName)
        || oldCount !== specificGiftRequestRequiredCount;
    if (configChanged) {
        specificGiftRequestProgress.clear();
        specificGiftRequestTickets.clear();
    }

    const wasEnabled = isSpecificGiftRequestEnabled;
    const askedToEnable = payload.enabled === true;
    if (askedToEnable && !normalizeSpecificGiftName(specificGiftRequestGiftName)) {
        isSpecificGiftRequestEnabled = false;
        console.warn('🚫 [SPECIFIC GIFT REQUEST] Tidak dapat diaktifkan: nama gift belum diisi di player.');
    } else {
        isSpecificGiftRequestEnabled = askedToEnable;
    }
    if (!wasEnabled && isSpecificGiftRequestEnabled) {
        giftRequestUsers.clear();
    }
    if (wasEnabled && !isSpecificGiftRequestEnabled) {
        specificGiftRequestProgress.clear();
        specificGiftRequestTickets.clear();
    }

    const saved = saveSpecificGiftRequestSettings();
    console.log(`🎁 [SPECIFIC GIFT REQUEST] ${isSpecificGiftRequestEnabled ? 'AKTIF' : 'NONAKTIF'} | gift=${specificGiftRequestGiftName || '(belum diatur)'} | jumlah minimal=${specificGiftRequestRequiredCount} | saved=${saved}`);
    return getSpecificGiftRequestSettings();
}

function recordSpecificGiftRequestProgress(giftData, repeatCount) {
    if (!isSpecificGiftRequestEnabled) return false;

    const userKey = normalizeTikTokId(giftData?.uniqueId);
    const receivedGiftName = normalizeSpecificGiftName(giftData?.giftName);
    const requiredGiftName = normalizeSpecificGiftName(specificGiftRequestGiftName);
    const count = Math.max(1, Math.floor(Number(repeatCount) || 1));
    if (!userKey || !requiredGiftName || receivedGiftName !== requiredGiftName) return false;

    const now = Date.now();
    const prior = specificGiftRequestProgress.get(userKey);
    const currentCount = prior && prior.expire > now ? prior.count : 0;
    const accumulatedCount = currentCount + count;
    const requestCount = Math.floor(accumulatedCount / specificGiftRequestRequiredCount);
    const remainder = accumulatedCount % specificGiftRequestRequiredCount;

    if (requestCount > 0) {
        const priorTicket = specificGiftRequestTickets.get(userKey);
        const validPriorTickets = priorTicket && priorTicket.expire > now ? priorTicket.count : 0;
        specificGiftRequestTickets.set(userKey, {
            count: validPriorTickets + requestCount,
            expire: now + 5 * 60 * 1000,
            giftName: specificGiftRequestGiftName,
            requiredCount: specificGiftRequestRequiredCount
        });
        if (remainder > 0) {
            specificGiftRequestProgress.set(userKey, { count: remainder, expire: now + 5 * 60 * 1000 });
        } else {
            specificGiftRequestProgress.delete(userKey);
        }
        console.log(`✅ [SPECIFIC GIFT REQUEST] @${giftData.uniqueId} memenuhi ${specificGiftRequestGiftName} x${specificGiftRequestRequiredCount}; tiket baru=${requestCount}, total tiket aktif=${validPriorTickets + requestCount}, sisa progres=${remainder}. Ketik !req judul lagu dalam 5 menit.`);
        return true;
    }

    specificGiftRequestProgress.set(userKey, { count: accumulatedCount, expire: now + 5 * 60 * 1000 });
    console.log(`🎁 [SPECIFIC GIFT REQUEST] @${giftData.uniqueId} progres ${specificGiftRequestGiftName}: ${accumulatedCount}/${specificGiftRequestRequiredCount}.`);
    return false;
}

function consumeSpecificGiftRequestTicket(userKey) {
    const ticket = specificGiftRequestTickets.get(userKey);
    if (!ticket || ticket.expire <= Date.now() || ticket.count <= 0) {
        specificGiftRequestTickets.delete(userKey);
        return false;
    }
    if (ticket.count === 1) specificGiftRequestTickets.delete(userKey);
    else specificGiftRequestTickets.set(userKey, { ...ticket, count: ticket.count - 1 });
    return true;
}
// User yang pernah mengirim gift selama server berjalan.
const giftMonitoringUsers = new Map();

function getGiftMonitoringUsers() {
    return Array.from(giftMonitoringUsers.values())
        .sort((a, b) => b.lastSeen - a.lastSeen);
}

// Gabungkan burst gift agar daftar peringkat tidak dibroadcast berulang-ulang
// untuk setiap event yang tiba dalam jeda 250 ms.
function scheduleTopGiftBroadcast() {
    if (topGiftBroadcastTimer) return;

    topGiftBroadcastTimer = setTimeout(() => {
        topGiftBroadcastTimer = null;
        io.emit('update-top-gift', Object.values(topGifts));
    }, 250);
}

// Tiket request gift kedaluwarsa otomatis; bersihkan entri lama secara berkala.
setInterval(() => {
    const now = Date.now();
    for (const [userId, entry] of giftRequestUsers) {
        if (!entry || entry.expire <= now) giftRequestUsers.delete(userId);
    }
    for (const [userId, entry] of specificGiftRequestProgress) {
        if (!entry || entry.expire <= now) specificGiftRequestProgress.delete(userId);
    }
    for (const [userId, entry] of specificGiftRequestTickets) {
        if (!entry || entry.expire <= now) specificGiftRequestTickets.delete(userId);
    }
}, 60 * 1000);

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
let isFollowRequestEnabled = false; // Default nonaktif; dapat diaktifkan dari dashboard
let isFasttrackEnabled = false; // Battle Fasttrack default nonaktif
let songQueue = [];
let songHistory = [];
let currentSong = null;

// Voting rating dibuka hanya saat lagu selesai alami (bukan tombol skip).
const SONG_RATING_VOTE_MS = 35 * 1000;
const SONG_RATING_RESULTS_MS = 8 * 1000;
let songRatingSession = null;
let songRatingCloseTimer = null;
let songRatingHideTimer = null;

function getSongRatingState() {
    if (!songRatingSession) return { active: false, phase: 'idle' };

    const ratings = [...songRatingSession.votes.entries()]
        .map(([userKey, vote]) => ({
            username: String(vote.username || userKey),
            nickname: String(vote.nickname || vote.username || 'Penonton'),
            score: Number(vote.score) || 0
        }))
        .sort((a, b) => a.nickname.localeCompare(b.nickname, 'id'));

    const totalScore = ratings.reduce((sum, vote) => sum + vote.score, 0);

    return {
        active: true,
        phase: songRatingSession.phase,
        songId: songRatingSession.songId,
        title: songRatingSession.title,
        requestedBy: songRatingSession.requestedBy,
        requesterAvatar: songRatingSession.requesterAvatar,

        // Total semua nilai, misalnya 8 + 9 = 17 poin.
        totalScore,
        voteCount: ratings.length,
        ratings,

        // Dipertahankan agar overlay lama tetap kompatibel selama migrasi.
        rating: ratings.length
            ? Number((totalScore / ratings.length).toFixed(1))
            : null,

        endsAt: songRatingSession.endsAt,
        votingDurationMs: SONG_RATING_VOTE_MS
    };
}


function emitSongRatingState() {
    io.emit('song-rating:state', getSongRatingState());
}

function startSongRating(song) {
    if (!song) return;
    if (songRatingCloseTimer) clearTimeout(songRatingCloseTimer);
    if (songRatingHideTimer) clearTimeout(songRatingHideTimer);

    const now = Date.now();
    songRatingSession = {
        songId: String(song.id ?? now),
        title: String(song.title || 'Lagu tanpa judul'),
        requestedBy: String(song.requestedBy || 'HOST'),
        requesterAvatar: String(song.userAvatar || song.profilePictureUrl || song.avatar || ''),
        phase: 'voting',
        startedAt: now,
        endsAt: now + SONG_RATING_VOTE_MS,
        votes: new Map()
    };

    console.log(`⭐ [SONG RATING] Voting dibuka untuk "${songRatingSession.title}" dari @${songRatingSession.requestedBy}; durasi 35 detik.`);
    emitSongRatingState();
    songRatingCloseTimer = setTimeout(finishSongRatingVoting, SONG_RATING_VOTE_MS);
}

function finishSongRatingVoting() {
    if (!songRatingSession || songRatingSession.phase !== 'voting') return;
    songRatingSession.phase = 'results';
    songRatingSession.endsAt = Date.now() + SONG_RATING_RESULTS_MS;
    const finalState = getSongRatingState();
    console.log(`⭐ [SONG RATING] Hasil "${finalState.title}": ${finalState.rating === null ? 'belum ada rating' : `${finalState.rating}/10`} dari ${finalState.voteCount} voter.`);
    emitSongRatingState();

    songRatingHideTimer = setTimeout(() => {
        songRatingSession = null;
        songRatingCloseTimer = null;
        songRatingHideTimer = null;
        emitSongRatingState();
    }, SONG_RATING_RESULTS_MS);
}

function submitSongRating(userData, score) {
    const ratingValue = Number(score);
    const userKey = normalizeTikTokId(userData?.uniqueId);
    if (!songRatingSession || songRatingSession.phase !== 'voting' || Date.now() > songRatingSession.endsAt) {
        console.log(`ℹ️ [SONG RATING] Rating dari @${userData?.uniqueId || 'unknown'} diabaikan; tidak ada voting aktif.`);
        return false;
    }
    const requesterKey = normalizeTikTokId(songRatingSession.requestedBy);

    if (userKey && requesterKey && userKey === requesterKey) {
        console.log(
            `🚫 [SONG RATING] @${userData.uniqueId} tidak boleh memberi rating pada lagu requestannya sendiri.`
        );
        return false;
    }

    if (!userKey || !Number.isInteger(ratingValue) || ratingValue < 1 || ratingValue > 10) {
        console.log(`🚫 [SONG RATING] Input rating tidak valid dari @${userData?.uniqueId || 'unknown'}; format yang benar !rate 1-10.`);
        return false;
    }

    const previousVote = songRatingSession.votes.get(userKey);
    songRatingSession.votes.set(userKey, {
        score: ratingValue,
        username: String(userData.uniqueId || userKey),
        nickname: String(userData.nickname || userData.uniqueId || 'Penonton')
    });

    const currentState = getSongRatingState();
    console.log(`✅ [SONG RATING] @${userData.uniqueId} memberi ${ratingValue}/10 untuk "${songRatingSession.title}"${previousVote ? ' (mengganti rating sebelumnya)' : ''}; rata-rata=${currentState.rating}/10, voter=${currentState.voteCount}.`);
    emitSongRatingState();
    return true;
}

// Battle Fasttrack berlangsung selama satu lagu aktif. Skor direset saat lagu berikutnya mulai.
let fasttrackRoundNumber = 0;
let fasttrackScores = new Map();

function getFasttrackLeaderboard() {
    const usersWithQueuedSongs = new Map();

    for (const song of songQueue) {
        const username = String(song.requestedBy || '').trim();
        const userKey = normalizeTikTokId(username);
        if (!userKey || userKey === 'host') continue;

        const existing = usersWithQueuedSongs.get(userKey) || {
            userKey,
            username,
            queuedSongs: 0
        };
        existing.queuedSongs += 1;
        usersWithQueuedSongs.set(userKey, existing);
    }

    return [...usersWithQueuedSongs.values()]
        .map(user => {
            const score = fasttrackScores.get(user.userKey);
            return {
                ...user,
                nickname: score?.nickname || user.username,
                coins: Number(score?.coins || 0),
                firstAt: Number(score?.firstAt || Number.MAX_SAFE_INTEGER)
            };
        })
        .sort((a, b) => b.coins - a.coins || a.firstAt - b.firstAt);
}

function getFasttrackState() {
    const leaderboard = getFasttrackLeaderboard();
    const leader = leaderboard.find(user => user.coins > 0) || null;
    return {
        enabled: isFasttrackEnabled,
        active: isFasttrackEnabled && Boolean(currentSong),
        round: fasttrackRoundNumber,
        currentSongTitle: currentSong?.title || '',
        leader: leader ? {
            username: leader.username,
            nickname: leader.nickname,
            coins: leader.coins,
            queuedSongs: leader.queuedSongs
        } : null,
        leaderboard: leaderboard.map(({ firstAt, ...user }) => user)
    };
}

function emitFasttrackState() {
    io.emit('fasttrack:state', getFasttrackState());
}

function startFasttrackRound(song) {
    fasttrackScores.clear();
    if (!isFasttrackEnabled) {
        emitFasttrackState();
        return;
    }
    fasttrackRoundNumber += 1;
    console.log(`⚔️ [FASTTRACK] Ronde ${fasttrackRoundNumber} dimulai untuk lagu: ${song?.title || '(tanpa judul)'}. Skor direset.`);
    emitFasttrackState();
}

function stopFasttrackBattle(reason = 'tidak ada lagu aktif') {
    fasttrackScores.clear();
    console.log(`🏁 [FASTTRACK] Battle berhenti: ${reason}.`);
    emitFasttrackState();
}

function recordFasttrackGift(giftData, totalCoins) {
    const username = String(giftData?.uniqueId || '').trim();
    if (!isFasttrackEnabled) {
        console.log(`ℹ️ [FASTTRACK] Gift dari @${username || 'unknown'} tidak dihitung; fitur Fasttrack sedang OFF.`);
        return false;
    }
    const userKey = normalizeTikTokId(username);
    const coins = Math.max(0, Number(totalCoins) || 0);

    if (!currentSong) {
        console.log(`ℹ️ [FASTTRACK] Gift dari @${username || 'unknown'} tidak dihitung; belum ada lagu aktif.`);
        return false;
    }
    if (!userKey || coins <= 0) {
        console.log(`ℹ️ [FASTTRACK] Gift dari @${username || 'unknown'} tidak memiliki coin/user ID valid.`);
        return false;
    }

    const userSongs = songQueue.filter(song => normalizeTikTokId(song.requestedBy) === userKey);
    if (userSongs.length === 0) {
        console.log(`ℹ️ [FASTTRACK] ${coins} coin dari @${username} tidak dihitung; user belum memiliki lagu yang menunggu di antrean.`);
        return false;
    }

    const existing = fasttrackScores.get(userKey) || {
        username,
        nickname: String(giftData.nickname || username),
        coins: 0,
        firstAt: Date.now()
    };
    existing.username = username;
    existing.nickname = String(giftData.nickname || existing.nickname || username);
    existing.coins += coins;
    fasttrackScores.set(userKey, existing);

    const leader = getFasttrackLeaderboard().find(user => user.coins > 0);
    if (leader) {
        const leaderSongs = songQueue.filter(song => normalizeTikTokId(song.requestedBy) === leader.userKey);
        const remainingSongs = songQueue.filter(song => normalizeTikTokId(song.requestedBy) !== leader.userKey);
        songQueue = [...leaderSongs, ...remainingSongs];
        io.emit('update-queue', { currentSong, songQueue, songHistory, isPlaying: isMusicPlaying });
    }

    console.log(
        `⚔️ [FASTTRACK SCORE] @${username} +${coins} coin; total ronde=${existing.coins}; ` +
        `lagu menunggu=${userSongs.length}; pemimpin=@${leader?.username || '-'} ` +
        `(${leader?.coins || 0} coin); semua lagu pemimpin dipromosikan sesuai urutan request.`
    );
    emitFasttrackState();
    return true;
}

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
let isDurationLimitEnabled = true;

function applyDurationLimit(rawDurationSeconds) {
    const actualDuration = Number(rawDurationSeconds) || 0;

    if (!isDurationLimitEnabled) {
        return { duration: actualDuration, isCut: false };
    }

    const sourceDuration = actualDuration || 180;
    const limitSeconds = Math.max(1, Number(maxDurationMinutes) || 5) * 60;

    return {
        duration: Math.min(sourceDuration, limitSeconds),
        isCut: sourceDuration > limitSeconds
    };
}

// AI & Milestone
let isChatReadingActive = true;
let isWelcomeJoinActive = true;
let blacklistKeywords = [];
let aiQueue = [];
let lastGiftThankYouIndex = -1;
let lastFollowThankYouIndex = -1;
let lastShareThankYouIndex = -1;
let isAiProcessing = false;
let activeMilestones = [];
// AUTO COIN SCENE: aturan video yang diterima dari panel kontrol
let coinSceneRules = [];
// ================================================================
// AUTO COIN SCENE - PENDING QUEUE
// Menyimpan trigger yang belum selesai diputar oleh overlay.
// Jadi jika overlay ditutup lalu dibuka kembali, data tidak hilang.
// ================================================================
let coinScenePendingQueue = [];
// ================================================================
// KIRIM PENDING COIN SCENE KE CLIENT YANG BARU TERHUBUNG
// ================================================================
function syncCoinScenePendingQueue(socket) {
    if (!socket) return;

    if (coinScenePendingQueue.length > 0) {
        socket.emit(
            'coin-scene-pending-sync',
            coinScenePendingQueue
        );

        console.log(
            `🔄 [COIN SYNC] Mengirim ${coinScenePendingQueue.length} pending scene ke client.`
        );
    } else {
        socket.emit(
            'coin-scene-pending-sync',
            []
        );
    }
}
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

    const fallbackDuration = isDurationLimitEnabled
        ? (maxDurationMinutes || 5) * 60
        : 0;
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
        startFasttrackRound(currentSong);
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

        const songDuration = Number(currentSong.duration) || (
            isDurationLimitEnabled
                ? (maxDurationMinutes || 5) * 60
                : 0
        );

        // pausedMusicSeconds berasal dari player. Bila batas mati dan durasi tidak diketahui,
        // server tidak memaksakan penghentian; player tetap melaporkan event player-ended.
        if (
            isMusicPlaying &&
            songDuration > 0 &&
            pausedMusicSeconds >= songDuration
        ) {
            clearInterval(serverMusicTimer);
            serverMusicTimer = null;

            const laguSelesai = currentSong;
            catatKeRiwayat(laguSelesai);
            startSongRating(laguSelesai);
            lastNextAt = Date.now();
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
                stopFasttrackBattle('antrean kosong setelah lagu selesai');
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

function advanceToNextSong(naturalEnd = false, endedSongId = null) {
    const now = Date.now();
    if (now - lastNextAt < 300) return false;
    if (naturalEnd && endedSongId && currentSong && String(endedSongId) !== String(currentSong.id)) {
        console.warn(`ℹ️ [SONG RATING] Event ended stale diabaikan; endedId=${endedSongId}, currentId=${currentSong.id}.`);
        return false;
    }
    lastNextAt = now;

    stopServerMusicTimer();
    if (currentSong) {
        const laguSelesai = currentSong;
        catatKeRiwayat(laguSelesai);
        if (naturalEnd) startSongRating(laguSelesai);
    }
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
    else stopFasttrackBattle('tidak ada lagu berikutnya');
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
function parseYouTubeSearchDuration(lengthValue) {
    if (!lengthValue) return 0;
    const candidates = [];
    if (typeof lengthValue === 'string') candidates.push(lengthValue);
    if (typeof lengthValue === 'object') {
        candidates.push(lengthValue.simpleText, lengthValue.text);
        candidates.push(lengthValue.accessibility?.accessibilityData?.label);
    }
    for (const candidate of candidates) {
        if (!candidate) continue;
        const value = String(candidate).trim();
        // Format durasi YouTube hasil pencarian umumnya H:MM:SS atau M:SS.
        const timeMatch = value.match(/(?:^|\b)(\d{1,2}:)?\d{1,2}:\d{2}(?:\b|$)/);
        if (timeMatch) {
            const time = timeMatch[0].trim();
            const parts = time.split(':').map(Number);
            if (parts.every(Number.isFinite)) {
                return parts.reduce((total, part) => total * 60 + part, 0);
            }
        }
        // Fallback untuk accessibility label seperti "4 minutes, 12 seconds".
        const hours = Number((value.match(/(\d+)\s*(?:hours?|jam)/i) || [])[1] || 0);
        const minutes = Number((value.match(/(\d+)\s*(?:minutes?|menit)/i) || [])[1] || 0);
        const seconds = Number((value.match(/(\d+)\s*(?:seconds?|detik)/i) || [])[1] || 0);
        if (hours || minutes || seconds) return hours * 3600 + minutes * 60 + seconds;
    }
    return 0;
}


function normalizeYouTubeText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreYouTubeCandidate(query, video) {
    const title = normalizeYouTubeText(video?.title);
    const normalizedQuery = normalizeYouTubeText(query);

    if (!title || !normalizedQuery || !video?.id) {
        return { accepted: false, score: 0, reason: 'judul atau ID kosong' };
    }

    // Tolak jenis hasil yang biasanya bukan lagu resmi/versi studio.
    const unwantedPhrases = [
        'live',
        'live performance',
        'live concert',
        'concert',
        'konser',
        'live at',
        'live in',
        'on stage',
        'onstage',
        'stage performance',
        'festival',
        'audience',
        'fan recording',
        'phone recording',
        'recorded live',
        'karaoke',
        'instrumental',
        'cover',
        'remix',
        'nightcore',
        'sped up',
        'slowed',
        '8d audio',
        'reaction',
        'reacts',
        'tutorial',
        'lesson',
        'how to play'
    ];

    const matchedUnwantedPhrase = unwantedPhrases.find(phrase =>
        title.includes(normalizeYouTubeText(phrase))
    );

    if (matchedUnwantedPhrase) {
        return {
            accepted: false,
            score: 0,
            reason: `judul mengandung "${matchedUnwantedPhrase}"`
        };
    }

    // Kata umum yang tidak banyak membantu membedakan hasil pencarian.
    const ignoredWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on',
        'official', 'music', 'video', 'audio', 'mv', 'hd', '4k',
        'topic', 'vevo', 'records', 'record'
    ]);

    const queryWords = normalizedQuery
        .split(' ')
        .filter(word => word.length > 1 && !ignoredWords.has(word));

    const titleWords = new Set(
        title.split(' ').filter(word => word.length > 1)
    );

    // Bila judul request hampir seluruhnya berupa kata umum, jangan menebak.
    if (queryWords.length === 0) {
        return { accepted: false, score: 0, reason: 'kata pencarian terlalu umum' };
    }

    const matchedWords = queryWords.filter(word => titleWords.has(word));
    const matchRatio = matchedWords.length / queryWords.length;

    // Makin banyak kata penting dari request ditemukan di judul video,
    // makin besar skornya.
    let score = matchRatio;

    // Bonus kecil jika frasa pencarian muncul utuh di judul hasil.
    if (title.includes(normalizedQuery)) {
        score += 0.20;
    }

    // Tolak hasil yang kecocokan judulnya terlalu rendah, daripada
    // memasukkan video yang kemungkinan merupakan lagu berbeda.
    const minimumScore = queryWords.length <= 2 ? 0.50 : 0.60;

    if (score < minimumScore) {
        return {
            accepted: false,
            score,
            reason: `kecocokan judul rendah (${matchedWords.length}/${queryWords.length} kata)`
        };
    }

    return {
        accepted: true,
        score,
        reason: `kecocokan ${matchedWords.length}/${queryWords.length} kata`
    };
}


const { exec } = require('child_process');

// Fungsi untuk mengecek musik aktif di macOS via AppleScript
function checkMacOSMedia(io) {
    // Skrip AppleScript untuk mengambil status dari Music & Spotify secara otomatis
    const script = `
        tell application "System Events"
            set appNames to {"Music", "Spotify", "VLC", "Google Chrome", "Safari"}
            set activeApp to ""
            repeat with anApp in appNames
                if (exists process anApp) then
                    set activeApp to anApp
                    exit repeat
                end if
            end repeat
        end tell

        if activeApp is "Spotify" then
            tell application "Spotify"
                if player state is playing then
                    set trackName to name of current track
                    set artistName to artist of current track
                    set trackDuration to (duration of current track) / 1000
                    set playerPosition to player position
                    return "Spotify|" & trackName & "|" & artistName & "|true|" & trackDuration & "|" & playerPosition
                else
                    return "Spotify|||false|0|0"
                end if
            end tell
        else if activeApp is "Music" then
            tell application "Music"
                if player state is playing then
                    set trackName to name of current track
                    set artistName to artist of current track
                    set trackDuration to duration of current track
                    set playerPosition to player position
                    return "Music|" & trackName & "|" & artistName & "|true|" & trackDuration & "|" & playerPosition
                else
                    return "Music|||false|0|0"
                end if
            end tell
        end if
        return "None|||false|0|0"
    `;

    exec(`osascript -e '${script.replace(/\n/g, ' ')}'`, (error, stdout, stderr) => {
        if (error) return;
        const res = stdout.trim().split('|');
        if (res.length >= 6 && res[0] !== 'None' && res[1] !== '') {
            const [sourceApp, title, artist, isPlaying, duration, currentTime] = res;

            // Kirim data ke semua client overlay yang terhubung via socket.io
            io.emit('macos-media-update', {
                active: true,
                id: `${sourceApp}-${title}`,
                title: title,
                artist: artist,
                isPlaying: isPlaying === 'true',
                duration: parseFloat(duration) || 0,
                currentTime: parseFloat(currentTime) || 0,
                sourceAppId: sourceApp
            });
        }
    });
}

// Jalankan pengecekan setiap 1 detik sekali khusus jika server dijalankan di macOS
if (process.platform === 'darwin') {
    setInterval(() => {
        checkMacOSMedia(io);
    }, 1000);
}

// Pencarian manual mencoba play-dl dahulu, lalu YouTube Search API sebagai fallback.
// Bila ada beberapa hasil, utamakan judul yang lolos scoreYouTubeCandidate.
async function searchManualYouTubeVideo(query) {
    let primaryError = null;

    try {
        const results = await play.search(query, { limit: 5 });
        const videos = Array.isArray(results)
            ? results.filter(video => video && String(video.id || '').trim())
            : [];
        if (videos.length) {
            const ranked = videos
                .map(video => ({ video, ...scoreYouTubeCandidate(query, video) }))
                .sort((a, b) => b.score - a.score);
            const selected = ranked.find(item => item.accepted)?.video || videos[0];
            if (!ranked.some(item => item.accepted)) {
                console.warn(`⚠️ [MANUAL SEARCH] Tidak ada hasil yang cocok kuat; memakai hasil pertama sebagai fallback.`);
            }
            return selected;
        }
    } catch (error) {
        primaryError = error;
        console.warn(`⚠️ [MANUAL SEARCH] play.search gagal; mencoba YouTube Search API: ${error?.message || error}`);
    }

    try {
        const result = await youTubeSearchApi.GetListByKeyword(query, false, 12);
        const videos = (result?.items || []).filter(video =>
            video && (!video.type || video.type === 'video') && String(video.id || '').trim()
        );
        if (videos.length) {
            const ranked = videos
                .map(video => ({ video, ...scoreYouTubeCandidate(query, video) }))
                .sort((a, b) => b.score - a.score);
            const selected = ranked.find(item => item.accepted)?.video || videos[0];
            const id = String(selected.id || '').trim();
            return {
                ...selected,
                id,
                url: selected.url || `https://www.youtube.com/watch?v=${id}`,
                durationInSec: Number(selected.durationInSec) || parseYouTubeSearchDuration(selected.length)
            };
        }
    } catch (error) {
        console.error(`❌ [MANUAL SEARCH FALLBACK] YouTube Search API gagal: ${error?.message || error}`);
        if (!primaryError) primaryError = error;
    }

    if (primaryError) throw primaryError;
    return null;
}

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
            return false;
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
                return false;
            }
        }

        // ============================================================
        // 🎵 SMART YOUTUBE SEARCH
        // Hindari Lyric / Karaoke / Cover / Remix yang tidak diinginkan
        // ============================================================

        let ytVideoId = '';
        let selectedVideoTitle = '';
        let selectedVideoDuration = 0;

        try {

            const hasilSearch = await youTubeSearchApi.GetListByKeyword(
                judulLagu,
                false,
                15
            );

            const items = hasilSearch?.items || [];

            console.log(
                `🔎 [YOUTUBE SEARCH] ${items.length} hasil ditemukan untuk: ${judulLagu}`
            );

            const kandidatVideo = items
                // Abaikan hasil yang secara eksplisit bukan video.
                .filter(video => !video.type || video.type === 'video')
                .map(video => {
                    const hasilScore = scoreYouTubeCandidate(judulLagu, video);

                    return {
                        video,
                        ...hasilScore
                    };
                })
                .filter(item => {
                    if (!item.accepted) {
                        console.log(
                            `🚫 [FILTER] Dilewati: ${item.video?.title || '(tanpa judul)'} — ${item.reason}`
                        );
                    }

                    return item.accepted;
                })
                .sort((a, b) => b.score - a.score);

            if (kandidatVideo.length > 0) {
                const videoTerpilih = kandidatVideo[0].video;

                ytVideoId = videoTerpilih.id;
                selectedVideoTitle = videoTerpilih.title || judulLagu;
                selectedVideoDuration = parseYouTubeSearchDuration(videoTerpilih.length);

                console.log(`✅ [YOUTUBE TERPILIH] ${selectedVideoTitle}`);
                console.log(`📊 [YOUTUBE SCORE] ${kandidatVideo[0].score.toFixed(2)}`);
                console.log(`🆔 ID: ${ytVideoId}`);
            } else {
                console.warn(
                    `⚠️ [REQUEST NO CLEAN RESULT] Tidak ada hasil YouTube yang cukup cocok untuk: ${judulLagu}`
                );
            }


        } catch (error) {

            console.error(
                "❌ [YouTube Error] Gagal searching:",
                error
            );

            io.emit(
                'overlay:request-denied',
                {
                    user: username,
                    message: "Gagal mencari lagu di YouTube. Coba lagi!"
                }
            );

            return false;
        }

        if (!ytVideoId || !String(ytVideoId).trim()) {
            console.warn(`⚠️ [REQUEST NO RESULT] Tidak ada video YouTube valid untuk: ${judulLagu}`);
            io.emit('song-request-denied', {
                user: username,
                nickname: username,
                message: `Lagu "${judulLagu}" belum ditemukan. Coba judul atau nama artis lain.`
            });
            io.emit('overlay:request-denied', {
                user: username,
                message: 'Lagu belum ditemukan. Coba judul atau nama artis lain.'
            });
            return false;
        }

        const normalize = (str) => str.trim().toLowerCase().replace(/\s+/g, " ");
        const judulBaru = normalize(judulLagu);
        const sudahAdaDiQueue = songQueue.some(song => normalize(song.title) === judulBaru);
        const sedangDiputar = currentSong && normalize(currentSong.title) === judulBaru;

        if (sudahAdaDiQueue || sedangDiputar) {
            console.log(`⚠️ [DUPLIKAT DITOLAK] ${judulLagu}`);
            io.emit('overlay:request-denied', { user: username, message: "Lagu sudah ada di antrian!" });
            return false;
        }

        // Durasi diambil dari item hasil pencarian YouTube. Tidak ada panggilan play-dl
        // pada jalur request viewer sehingga tidak menambah risiko HTTP 429.
        if (isDurationLimitEnabled && selectedVideoDuration <= 0) {
            console.warn(`⚠️ [REQUEST NO DURATION] Durasi tidak tersedia di hasil pencarian: ${ytVideoId}`);
            io.emit('song-request-denied', {
                user: username,
                nickname: username,
                message: 'Durasi lagu tidak tersedia dari YouTube. Request tidak dimasukkan agar tidak terpotong terlalu cepat.'
            });
            io.emit('overlay:request-denied', {
                user: username,
                message: 'Durasi lagu tidak tersedia. Coba judul lagu lain.'
            });
            return false;
        }

        const durationResult = applyDurationLimit(selectedVideoDuration);
        const durationApplied = durationResult.duration;
        const isDurationCut = durationResult.isCut;
        console.log(`⏱️ [DURASI REQUEST] asli=${selectedVideoDuration}s, dipakai=${durationApplied}s, dipotong=${isDurationCut}`);

        const dataLagu = {
            id: Date.now(),

            // Judul asli dari video YouTube yang sudah lolos filter
            title: selectedVideoTitle || judulLagu,
            requestedQuery: judulLagu,

            url: `https://www.youtube.com/watch?v=${ytVideoId}`,

            requestedBy: username,
            userAvatar: avatarUrl,
            youtubeId: ytVideoId,
            vvip: isVvip,
            duration: durationApplied,
            isCut: isDurationCut,

            lyrics: []
        };

        // Lirik dimuat asynchronous setelah lagu masuk antrean agar tidak menahan request.


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
            `Gas, brow!`,
            `Mantap, request masuk!`,
            `Siap diputar!`,
            `Keren, lagunya aman!`,
            `Request diterima!`,
            `Cus, musik jalan!`
        ];

        const randomUcapan =
            ucapanKece[Math.floor(Math.random() * ucapanKece.length)];

        const jawabanLokal = isVvip
            ? `Request VVIP dari ${dataLagu.requestedBy}! Lagu ${judulLagu} ${statusPutarTts}`
            : `${randomUcapan} @${dataLagu.requestedBy}. Lagu ${judulLagu} ${statusPutarTts}`;

        aiQueue.push({
            isLocal: true,
            jawabanLokal,
            mode: 'tanya'
        });


        processAiQueue();
        io.emit('update-queue', { currentSong, songQueue, songHistory });
        emitFasttrackState();
        loadSongLyricsInBackground(dataLagu, dataLagu.title, '', selectedVideoDuration);
        return true;

    } catch (globalError) {
        console.error("🚨 [CRASH SHIELD] Error fatal digagalkan di tambahKeQueue:", globalError);
        return false;
    }
}

// Throttle bersama untuk permintaan metadata play-dl agar tidak menembak YouTube beruntun.
let playDlChain = Promise.resolve();
let lastPlayDlAt = 0;
function getVideoInfoRateLimited(url) {
    const task = playDlChain.then(async () => {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
            const minGap = 5000;
            const waitMs = Math.max(0, minGap - (Date.now() - lastPlayDlAt));
            if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
            lastPlayDlAt = Date.now();
            try {
                return await play.video_basic_info(url);
            } catch (error) {
                lastError = error;
                const message = String(error?.message || error);
                const isRateLimited = /429|too many requests/i.test(message);
                if (!isRateLimited || attempt === 2) break;
                const backoffMs = 5000 * (attempt + 1);
                console.warn(`⚠️ [YOUTUBE 429] Retry metadata ${attempt + 1}/2 setelah ${backoffMs / 1000} detik.`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
        throw lastError;
    });
    playDlChain = task.catch(() => undefined);
    return task;
}

let viewerSongRequestChain = Promise.resolve();
function enqueueViewerSongRequest(judulLagu, uniqueId, avatarUrl, isVvip = false) {
    const task = viewerSongRequestChain.then(async () => {
        console.log(`🎼 [REQUEST START] @${uniqueId || 'GUEST'} meminta "${judulLagu}"; vvip=${isVvip}`);
        const accepted = await tambahKeQueue(judulLagu, uniqueId, avatarUrl, isVvip);
        if (accepted) {
            console.log(`✅ [REQUEST SUCCESS] Lagu "${judulLagu}" benar-benar diterima untuk @${uniqueId || 'GUEST'}.`);
        } else {
            console.warn(`⚠️ [REQUEST NOT ADDED] Lagu "${judulLagu}" tidak masuk antrean untuk @${uniqueId || 'GUEST'}; cek log penolakan di atas.`);
        }
        return accepted;
    });
    viewerSongRequestChain = task.catch(error => {
        console.error('❌ [VIEWER REQUEST QUEUE] Gagal memproses request:', error?.message || error);
        return false;
    });
    return task;
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
let networkMonitorInFlight = false;

function startNetworkMonitor() {
    if (monitorInterval) {
        console.log("Monitor sudah berjalan");
        return;
    }
    console.log("Network Monitor START");

    monitorInterval = setInterval(async () => {
        if (networkMonitorInFlight) return;
        networkMonitorInFlight = true;

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
            console.warn('[NETWORK MONITOR] Pemeriksaan gagal:', err.message);
        } finally {
            networkMonitorInFlight = false;
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
        const responseText = String(currentJob.jawabanLokal || '').trim();
        if (!currentJob.isLocal || !responseText) {
            throw new Error('Respons antrean lokal tidak valid.');
        }
        console.log(`🤖 [JAWABAN LOKAL] -> ${responseText}`);
        io.emit('play-ai-tts', {
            text: responseText,
            mode: currentJob.mode
        });
        const estimatedDelay = Math.max(4000, responseText.length * 90);
        await new Promise(resolve => setTimeout(resolve, estimatedDelay));
    } catch (error) {
        console.error('❌ Error di Queue AI:', error?.message || error);
        io.emit('ai-error', {
            mode: currentJob.mode || 'tanya',
            message: 'Respons suara gagal diproses.'
        });
    } finally {
        isAiProcessing = false;
        processAiQueue();
    }
}
// =================================================================
// =================================================================
// 📱 TIKTOK LIVE CONNECTION HANDLER
// =================================================================
function setupTikTokEvents(username, socket) {
    setActiveFollowHost(username);
    if (tiktokConnection) {
        tiktokConnection.removeAllListeners();
        tiktokConnection.disconnect();
    }

    tiktokConnection = new WebcastPushConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,

        // PENTING:
        // Jangan gunakan WebSocket upgrade
        enableWebsocketUpgrade: false,

        requestOptions: {
            timeout: 15000
        },

        clientParams: {
            "app_language": "id-ID",
            "device_platform": "web"
        }
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

        const errorMessage =
            err?.message ||
            String(err);

        console.error(
            '❌ [TIKTOK] Koneksi gagal:',
            errorMessage
        );

        // ============================================================
        // BEDAKAN JENIS ERROR
        // ============================================================

        let pesanGagal = '';

        if (
            errorMessage.toLowerCase().includes('websocket')
        ) {

            pesanGagal =
                `⚠️ Koneksi WebSocket TikTok gagal untuk @${namaAkun}. ` +
                `Mencoba metode koneksi alternatif.`;

        }

        else if (
            errorMessage.toLowerCase().includes('timeout')
        ) {

            pesanGagal =
                `⏱️ Koneksi ke @${namaAkun} timeout. ` +
                `TikTok belum memberikan respons.`;

        }

        else if (
            errorMessage.toLowerCase().includes('not found') ||
            errorMessage.toLowerCase().includes('user not found')
        ) {

            pesanGagal =
                `🔍 Username @${namaAkun} tidak ditemukan. ` +
                `Silakan periksa kembali username TikTok.`;

        }

        else {

            pesanGagal =
                `❌ Gagal terhubung ke @${namaAkun}. ` +
                `Periksa koneksi jaringan dan status LIVE.`;

        }


        // ============================================================
        // LOG DETAIL UNTUK DEBUG
        // ============================================================

        console.error(
            `💡 [TIKTOK ERROR DETAIL] ${errorMessage}`
        );


        socket.emit('server-log', {
            level: 'error',
            message: pesanGagal
        });


        socket.emit('server-log', {
            level: 'info',
            message:
                `🔎 Detail error: ${errorMessage}`
        });


        socket.emit(
            'status',
            `Gagal terhubung ke ${username}`
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
            const pesanLower = pesan.toLowerCase();
            const cekKataGglobal = pesanLower;

            const cancelMatch = pesan.match(/^!(?:cancel|batal)(?:\s+(.+))?$/i);
            if (cancelMatch) {
                const requesterKey = normalizeTikTokId(data.uniqueId);
                if (!requesterKey) {
                    console.warn('⚠️ [REQUEST CANCEL] Identitas TikTok kosong; pembatalan ditolak.');
                    return;
                }

                const requestedTitle = String(cancelMatch[1] || '').trim();
                const normalizeSongText = value => String(value || '')
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, ' ')
                    .trim()
                    .replace(/\s+/g, ' ');

                const ownedQueueEntries = songQueue
                    .map((song, index) => ({ song, index }))
                    .filter(({ song }) => normalizeTikTokId(song.requestedBy) === requesterKey);

                if (!ownedQueueEntries.length) {
                    aiQueue.push({
                        isLocal: true,
                        jawabanLokal: `@${data.uniqueId}, kamu tidak punya lagu yang sedang menunggu untuk dibatalkan. Lagu yang sedang diputar tidak bisa dibatalkan dengan perintah ini.`,
                        mode: 'tanya'
                    });
                    processAiQueue();
                    return;
                }

                let candidates = ownedQueueEntries;
                if (requestedTitle) {
                    const normalizedQuery = normalizeSongText(requestedTitle);
                    candidates = ownedQueueEntries.filter(({ song }) =>
                        normalizeSongText(song.title) === normalizedQuery ||
                        normalizeSongText(song.requestedQuery) === normalizedQuery
                    );
                } else {
                    // Tanpa judul, batalkan request terbaru milik pengguna yang masih menunggu.
                    candidates = [ownedQueueEntries.reduce((latest, entry) =>
                        Number(entry.song.id) > Number(latest.song.id) ? entry : latest
                    )];
                }

                if (candidates.length !== 1) {
                    const reply = candidates.length > 1
                        ? `@${data.uniqueId}, ada beberapa lagu yang cocok. Sebutkan judul yang lebih spesifik: !cancel judul lagu.`
                        : `@${data.uniqueId}, lagu itu tidak ditemukan di antreanmu. Gunakan !cancel tanpa judul untuk membatalkan request terakhirmu yang masih menunggu.`;
                    aiQueue.push({ isLocal: true, jawabanLokal: reply, mode: 'tanya' });
                    processAiQueue();
                    return;
                }

                const [{ song, index }] = candidates;
                songQueue.splice(index, 1);
                io.emit('update-queue', { currentSong, songQueue, songHistory, isPlaying: isMusicPlaying });
                io.emit('song-request-cancelled', {
                    user: data.uniqueId,
                    songId: song.id,
                    title: song.title,
                    message: `Request "${song.title}" dari @${data.uniqueId} berhasil dibatalkan.`
                });
                aiQueue.push({
                    isLocal: true,
                    jawabanLokal: `Siap @${data.uniqueId}, request lagu ${song.title} sudah dibatalkan. Kuota request kamu terbuka satu.`,
                    mode: 'tanya'
                });
                processAiQueue();
                console.log(`🗑️ [REQUEST CANCELLED] @${data.uniqueId} membatalkan "${song.title}"; sisa lagu antrean miliknya=${ownedQueueEntries.length - 1}.`);
                return;
            }

            if (/^!(rate|rating)\b/i.test(pesan)) {
                const ratingCommand = pesan.match(/^!(?:rate|rating)\s+(\d{1,2})\s*$/i);
                if (!ratingCommand) {
                    console.log(`🚫 [SONG RATING] Format salah dari @${data.uniqueId}; gunakan !rate 1-10.`);
                } else {
                    submitSongRating(data, Number(ratingCommand[1]));
                }
                return;
            }

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
            console.log(`📨 [REQUEST COMMAND] @${data.uniqueId || '(tanpa uniqueId)'}: ${query}`);
            if (isFollowRequestEnabled && !ensureFollowerForSongRequest(data)) return;
            if (!isFollowRequestEnabled) console.log(`ℹ️ [FOLLOW CHECK] Syarat follow OFF; request @${data.uniqueId} dilanjutkan.`);
            const specialGiftTicket = specificGiftRequestTickets.get(normalizeTikTokId(data.uniqueId));
            const hasSpecialGiftTicket = Boolean(
                isSpecificGiftRequestEnabled &&
                specialGiftTicket &&
                specialGiftTicket.expire > Date.now() &&
                specialGiftTicket.count > 0
            );

            if (isSpecificGiftRequestEnabled && !hasSpecialGiftTicket) {
                const requiredGift = specificGiftRequestGiftName || 'gift yang ditentukan host';
                io.emit('song-request-denied', {
                    user: data.uniqueId,
                    nickname: data.nickname,
                    profilePictureUrl: data.profilePictureUrl,
                    message: `Request lagu perlu ${requiredGift} x${specificGiftRequestRequiredCount} terlebih dahulu. Setelah memenuhi, ketik !req judul lagu dalam 5 menit.`
                });
                console.log(`🚫 [SPECIFIC GIFT REQUEST] @${data.uniqueId} ditolak; belum punya tiket ${requiredGift} x${specificGiftRequestRequiredCount}.`);
                return;
            }

            if (hasSpecialGiftTicket) {
                const accepted = await enqueueViewerSongRequest(query, data.uniqueId, data.profilePictureUrl, true);
                if (accepted) {
                    consumeSpecificGiftRequestTicket(normalizeTikTokId(data.uniqueId));
                    console.log(`✅ [SPECIFIC GIFT REQUEST SUCCESS] "${query}" dari @${data.uniqueId} diterima; sisa tiket=${specificGiftRequestTickets.get(normalizeTikTokId(data.uniqueId))?.count || 0}.`);
                }
                return;
            }

            const giftData = giftRequestUsers.get(data.uniqueId);
            const isVipUser = (giftData && giftData.expire > Date.now());

            if (isVipUser) {
                const accepted = await enqueueViewerSongRequest(query, data.uniqueId, data.profilePictureUrl, true);
                if (accepted) {
                    giftRequestUsers.delete(data.uniqueId);
                    console.log(`👑 [VVIP REQUEST SUCCESS] "${query}" dari @${data.uniqueId} berhasil diproses.`);
                }
                return;
            }

            if (currentRequestMode === 'free') {
                let activeSongsCount = songQueue.filter(song => song.requestedBy === data.uniqueId).length;
                if (currentSong && currentSong.requestedBy === data.uniqueId) activeSongsCount += 1;

                if (activeSongsCount < maxRequestLimit) {
                    const accepted = await enqueueViewerSongRequest(query, data.uniqueId, data.profilePictureUrl, false);
                    if (accepted) {
                        console.log(`🎵 [FREE REQUEST SUCCESS] "${query}" dari @${data.uniqueId} sukses dimasukkan.`);
                    }
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

            // Gift streak mengirim update selama combo berlangsung.
            // Proses hanya event final agar tidak tercatat berulang.
            if (Number(data.giftType) === 1 && data.repeatEnd !== true) {
                return;
            }

            // -------------------------------------------------------------
            // 🎬 CEK MATCHING MAPPING GIFT ANIMATION (PEMICU -> VISUAL)
            // -------------------------------------------------------------
            if (giftAnimationMappings.length > 0) {
                const matchedMapping = giftAnimationMappings.find(item => {
                    if (!item.enabled) return false;
                    const nameLive = String(data.giftName || '').toLowerCase().trim();
                    const nameRule = String(item.giftName || '').toLowerCase().trim();
                    return nameLive === nameRule;
                });

                if (matchedMapping) {
                    console.log(`🔥 [GIFT ANIMATION MATCH] Pemicu: ${data.giftName} -> Visual: ${matchedMapping.visualGiftName}`);

                    const payloadToSend = {
                        ...matchedMapping,
                        senderUser: data.uniqueId,
                        senderNickname: data.nickname,
                        senderAvatar: data.profilePictureUrl,
                        repeatCount: data.repeatCount || 1
                    };

                    // Trigger ke Overlay Video & Overlay Info
                    io.emit('play-gift-video', payloadToSend);
                    io.emit('play-gift-info', payloadToSend);
                }
            }

            if (currentRequestMode === 'gift' && !isSpecificGiftRequestEnabled) {
                giftRequestUsers.set(data.uniqueId, { expire: Date.now() + (5 * 60 * 1000) });
            }
            if (!isSpecificGiftRequestEnabled) {
                console.log(`🎁 @${data.uniqueId} dapat 1 tiket VVIP! Silakan ketik di chat: !req atau !play judul lagu - nama artis`);
            }

            let giftIcon = data.giftPictureUrl || (data.extendedGiftInfo?.icon?.urls?.[0]) || null;
            const repeatCount = Math.max(1, Number(data.repeatCount ?? 1));
            const coinPerGift = Number(
                data.extendedGiftInfo?.diamond_count
                ?? data.extendedGiftInfo?.diamondCount
                ?? data.diamondCount
                ?? 0
            );
            const totalCoins = coinPerGift * repeatCount;
            recordSpecificGiftRequestProgress(data, repeatCount);
            // Gift streak dikirim berkali-kali oleh TikTok; hitung hanya saat combo final.
            if (data.giftType !== 1 || data.repeatEnd === true) {
                subathonEngine.handleGift({
                    nickname: data.nickname,
                    uniqueId: data.uniqueId,
                    giftName: data.giftName,
                    repeatCount,
                    coinPerGift,
                    totalCoins
                });
            }
            const userId = String(data.uniqueId || data.nickname || 'unknown-user');
            const previousUser = giftMonitoringUsers.get(userId);
            const monitoringUser = {
                userId,
                username: userId,
                nickname: String(data.nickname || userId),
                avatar: data.profilePictureUrl || null,
                profilePictureUrl: data.profilePictureUrl || null,
                totalCoins: (previousUser?.totalCoins || 0) + totalCoins,
                totalGiftCount: (previousUser?.totalGiftCount || 0) + repeatCount,
                lastGiftName: String(data.giftName || 'Gift'),
                lastGiftCoins: totalCoins,
                lastGiftCount: repeatCount,
                lastSeen: Date.now()
            };
            giftMonitoringUsers.set(userId, monitoringUser);

            io.emit("tiktok-gift-alert", { giftName: data.giftName, count: data.repeatCount });
            io.emit("new-gift", {
                user: data.uniqueId,
                userId,
                uniqueId: userId,
                username: userId,
                nickname: data.nickname,
                avatar: data.profilePictureUrl,
                profilePictureUrl: data.profilePictureUrl,
                giftName: data.giftName,
                count: repeatCount,
                repeatCount,
                giftIcon,
                coinPerGift,
                totalCoins,
                coins: totalCoins,
                userTotalCoins: monitoringUser.totalCoins,
                userTotalGiftCount: monitoringUser.totalGiftCount
            });
            io.emit('gift-users:updated', getGiftMonitoringUsers());

            // Ucapkan terima kasih secara lokal, tanpa memakai kuota Groq.
            const pengirimGift = String(data.nickname || data.uniqueId || 'Kak').trim();
            const namaGiftTerimaKasih = String(data.giftName || 'gift').trim();
            const variasiTerimaKasihGift = [
                `Wih, ${pengirimGift} ngasih ${namaGiftTerimaKasih}! Makasih, Kak—baik banget, bikin host auto senyum sampai lupa kedip!`,
                `Perhatian, ada sultan lewat! ${pengirimGift} kirim ${namaGiftTerimaKasih}—makasih banyak, Kak, rezekinya bikin host mau joget kemenangan!`,
                `${namaGiftTerimaKasih} dari ${pengirimGift} mendarat dengan mulus! Makasih ya, Kak—semoga hoki nempel terus kayak perangko!`
            ];
            const pilihanGiftTersedia = variasiTerimaKasihGift
                .map((_, index) => index)
                .filter(index => index !== lastGiftThankYouIndex);
            const indeksUcapanGift = pilihanGiftTersedia[
                Math.floor(Math.random() * pilihanGiftTersedia.length)
            ];
            lastGiftThankYouIndex = indeksUcapanGift;
            aiQueue.unshift({
                isLocal: true,
                jawabanLokal: variasiTerimaKasihGift[indeksUcapanGift],
                mode: 'tanya'
            });
            processAiQueue();

            if (!topGifts[data.uniqueId]) {
                topGifts[data.uniqueId] = { user: data.uniqueId, nickname: data.nickname, profilePic: data.profilePictureUrl, total: 0 };
            }
            topGifts[data.uniqueId].total += data.repeatCount;
            scheduleTopGiftBroadcast();

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


            if (!isSpecificGiftRequestEnabled) {
                giftRequestUsers.set(data.uniqueId, { expire: Date.now() + (5 * 60 * 1000) });
            }

            const text = data.comment || "";
            const textLower = text.toLowerCase();

            if (textLower.startsWith('!req ') || textLower.startsWith('!play ')) {
                const query = text.replace(/^!(req|play)\s+/i, '').trim();

                if (query) {
                    console.log(`🎁 [GIFT REQUEST COMMAND] @${data.uniqueId || '(tanpa uniqueId)'}: ${query}`);
                    if (!isFollowRequestEnabled || ensureFollowerForSongRequest(data)) {
                        if (!isFollowRequestEnabled) console.log(`ℹ️ [FOLLOW CHECK] Syarat follow OFF; gift request @${data.uniqueId} dilanjutkan.`);
                        const accepted = await enqueueViewerSongRequest(query, data.uniqueId, data.profilePictureUrl, true);
                        if (accepted) {
                            aiQueue.push({
                                isLocal: true,
                                jawabanLokal: `Waduh mantap Sultan ${data.uniqueId} kirim gift! Lagu ${query} langsung meluncur ke urutan pertama!`,
                                mode: 'tanya'
                            });
                            processAiQueue();
                            giftRequestUsers.delete(data.uniqueId);
                            console.log(`✅ [GIFT REQUEST SUCCESS] @${data.uniqueId} request "${query}" diterima.`);
                        }
                    }
                }
            }

            // Battle Fasttrack: akumulasikan coin ronde satu lagu aktif.
            // Diletakkan setelah request gift diproses agar request lagu dari gift yang sama ikut memenuhi syarat.
            recordFasttrackGift(data, totalCoins);

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
        const displayType = String(data?.displayType || '').toLowerCase();
        console.log(`📡 [SOCIAL EVENT] displayType=${data?.displayType || '(kosong)'} username=${data?.uniqueId || '(kosong)'} userId=${data?.userId || '(kosong)'}`);
        if (displayType.includes('follow')) {
            type = 'FOLLOW';
            console.log(`📥 [FOLLOW EVENT RAW] displayType=${data.displayType || '(kosong)'} username=${data.uniqueId || '(kosong)'} userId=${data.userId || data.id || '(kosong)'}`);
            rememberTikTokFollower(data);

            if (data.uniqueId) totalFollowers.add(data.uniqueId);
            io.emit('update-follower-count', { total: totalFollowers.size });
            io.emit('new-follower', { user: data.uniqueId, nickname: data.nickname, profilePictureUrl: data.profilePictureUrl });
            console.log(`✨ [New Follow] ${data.nickname || data.uniqueId || 'Penonton'} baru follow dan dicatat.`);
        }

        if (data.displayType && data.displayType.includes('share')) {
            type = 'SHARE';
            io.emit('new-share', { user: data.uniqueId, nickname: data.nickname, profilePictureUrl: data.profilePictureUrl });
            console.log(`📢 ${data.nickname} membagikan Live!`);
        }

        io.emit('new-social-monitor', { user: data.uniqueId, nickname: data.nickname, type: type });
        io.emit('social', data);

        // Ucapan follow/share memakai TTS lokal, tidak memanggil Groq.
        const namaPendukung = String(data.nickname || data.uniqueId || 'Kak').trim();
        let variasiUcapan = [];
        let lastIndex = -1;
        if (type === 'FOLLOW') {
            variasiUcapan = [
                `Wih, ${namaPendukung} baru follow! Makasih, Kak—keluarga live kita nambah satu, traktir virtualnya kapan nih?`,
                `${namaPendukung} resmi gabung tim! Makasih sudah follow, semoga betah ya—kursi VIP imajinernya sudah disiapkan!`,
                `Breaking news: ${namaPendukung} pencet follow! Makasih banyak, Kak, satu follow bikin host tambah pede kayak artis!`
            ];
            lastIndex = lastFollowThankYouIndex;
        } else if (type === 'SHARE') {
            variasiUcapan = [
                `Waduh, ${namaPendukung} share live! Makasih, Kak—promosinya gratis, host jadi berasa punya tim marketing!`,
                `${namaPendukung} menyebarkan live ini ke penjuru dunia! Makasih ya, Kak—NASA sebentar lagi ikut nonton nih!`,
                `Makasih sudah share, ${namaPendukung}! Semoga yang datang bawa vibes seru, bukan cuma nanya Wi-Fi password!`
            ];
            lastIndex = lastShareThankYouIndex;
        }

        if (variasiUcapan.length > 0) {
            const pilihanTersedia = variasiUcapan
                .map((_, index) => index)
                .filter(index => index !== lastIndex);
            const indeksUcapan = pilihanTersedia[
                Math.floor(Math.random() * pilihanTersedia.length)
            ];
            if (type === 'FOLLOW') lastFollowThankYouIndex = indeksUcapan;
            if (type === 'SHARE') lastShareThankYouIndex = indeksUcapan;
            aiQueue.unshift({
                isLocal: true,
                jawabanLokal: variasiUcapan[indeksUcapan],
                mode: 'tanya'
            });
            processAiQueue();
        }
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
        totalLikeCount += tapSekarang;

        // Throttling 1.5 detik untuk efisiensi bandwidth Socket.io
        if (!pendingLikesEmit) {
            pendingLikesEmit = true;
            setTimeout(() => {
                io.emit('like-stats', { totalLikeCount });
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

    // AUTO COIN SCENE: kirim pending trigger
    // ke client yang baru terhubung.
    syncCoinScenePendingQueue(socket);

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



    // =================================================================
    // 🎁 GIFT ANIMATION REALTIME SYNC & TEST
    // =================================================================
    socket.on('gift-animation:request-all', () => {
        socket.emit('gift-animation:all-rules', giftAnimationMappings);
    });

    // Sinkronkan user yang sudah mengirim gift saat window monitoring baru dibuka.
    socket.on('gift-users:request-all', () => {
        socket.emit('gift-users:all', getGiftMonitoringUsers());
    });

    socket.on('gift-animation:save-settings', (mappings) => {
        giftAnimationMappings = Array.isArray(mappings) ? mappings : [];
        saveGiftAnimationMappings(giftAnimationMappings);
        io.emit('gift-animation:all-rules', giftAnimationMappings);
    });

    // PASANG LISTENER INI: Meneruskan sinyal test dari Control Panel ke Video & Info Overlay
    socket.on('gift-animation:test', (item) => {
        console.log('🧪 [SERVER] Menyebarkan sinyal test video ke overlay:', item.giftName);
        io.emit('gift-animation:test', item);
        io.emit('play-gift-video', item);
        io.emit('play-gift-info', item);
    });

    // Trigger dari window monitoring: teruskan data user ke overlay avatar.
    socket.on('gift-animation:user-trigger', (payload = {}) => {
        if (!payload || typeof payload !== 'object') return;
        console.log('👤 [USER MONITOR] Trigger avatar:', payload.triggeredBy?.username || payload.senderNickname || 'User');
        io.emit('gift-animation:user-trigger', payload);
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
            const fileData = payload?.fileData;
            const originalName = String(payload?.originalName || 'video');

            if (!Buffer.isBuffer(fileData)) {
                throw new Error('Isi file video tidak diterima server.');
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

            await fs.promises.writeFile(destinationPath, fileData);

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
    socket.emit('sync-duration-limit-enabled', isDurationLimitEnabled);

    socket.on('change-duration-limit-enabled', (enabled) => {
        isDurationLimitEnabled = enabled === true;

        console.log(
            `⏱️ [DURASI] Batas durasi ${isDurationLimitEnabled ? 'AKTIF' : 'NONAKTIF'
            }`
        );

        io.emit('sync-duration-limit-enabled', isDurationLimitEnabled);
    });


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

    socket.emit('sync-chat-reading', isChatReadingActive);
    socket.on('update-chat-reading', (data) => {
        isChatReadingActive = data?.aktif !== false;
        console.log(`🔊 [CHAT VOICE] Baca chat: ${isChatReadingActive ? 'AKTIF' : 'NONAKTIF'}`);
        io.emit('sync-chat-reading', isChatReadingActive);
    });

    socket.emit('sync-welcome-join', isWelcomeJoinActive);
    socket.on('update-welcome-join', (data) => {
        isWelcomeJoinActive = data?.aktif !== false;
        console.log(`👋 [WELCOME JOIN] Sambutan: ${isWelcomeJoinActive ? 'AKTIF' : 'NONAKTIF'}`);
        io.emit('sync-welcome-join', isWelcomeJoinActive);
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

    socket.emit('fasttrack:state', getFasttrackState());
    socket.emit('song-rating:state', getSongRatingState());

    socket.emit('sync-specific-gift-request-settings', getSpecificGiftRequestSettings());
    socket.on('change-specific-gift-request-settings', (settings) => {
        const normalizedSettings = applySpecificGiftRequestSettings(settings || {});
        io.emit('sync-specific-gift-request-settings', normalizedSettings);
    });

    socket.emit('sync-fasttrack-enabled', isFasttrackEnabled);
    socket.on('change-fasttrack-enabled', (enabled) => {
        isFasttrackEnabled = enabled === true;
        if (isFasttrackEnabled && currentSong) {
            startFasttrackRound(currentSong);
            console.log(`⚔️ [FASTTRACK] Diaktifkan di tengah lagu; ronde ${fasttrackRoundNumber} langsung dimulai.`);
        } else {
            fasttrackScores.clear();
            console.log(`⚔️ [FASTTRACK] Battle ${isFasttrackEnabled ? 'aktif; menunggu lagu dimulai' : 'dinonaktifkan'}. Skor dikosongkan.`);
            emitFasttrackState();
        }
        io.emit('sync-fasttrack-enabled', isFasttrackEnabled);
    });

    socket.emit('sync-follow-request-enabled', isFollowRequestEnabled);
    socket.on('change-follow-request-enabled', (enabled) => {
        isFollowRequestEnabled = enabled === true;
        console.log(`🔐 [FOLLOW GATE] Syarat follow ${isFollowRequestEnabled ? 'DIAKTIFKAN' : 'DINONAKTIFKAN'} dari dashboard.`);
        io.emit('sync-follow-request-enabled', isFollowRequestEnabled);
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
    socket.on('player-ended', (payload = {}) => {
        console.log("✅ [YOUTUBE] Video selesai diputar. Membuka voting rating dan melanjutkan ke lagu berikutnya...");
        advanceToNextSong(true, payload?.songId ?? null);
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
        stopFasttrackBattle('queue direset host');
        io.emit('update-queue', { currentSong, songQueue, songHistory, isPlaying: false });
    });

    socket.on('delete-song', (songId) => {
        console.log(`🗑️ Menghapus lagu ID: ${songId}`);
        songQueue = songQueue.filter(song => song.id !== songId);
        io.emit('update-queue', { currentSong, songQueue, songHistory });
    });

    socket.on("manual-add-song", async (song) => {
        const requestedTitle = String(song?.title || '').trim();
        const artist = String(song?.artist || '').trim();
        if (!requestedTitle) {
            socket.emit('error-notifikasi', 'Masukkan judul lagu terlebih dahulu.');
            return;
        }

        const query = `${requestedTitle} ${artist}`.trim();
        console.log(`🎼 [MANUAL REQUEST START] Mencari: "${query}"`);

        try {
            const topVideo = await searchManualYouTubeVideo(query);
            if (!topVideo) {
                console.warn(`⚠️ [MANUAL REQUEST NOT FOUND] Tidak ada hasil untuk "${query}".`);
                socket.emit('error-notifikasi', `Lagu "${query}" tidak ditemukan. Coba judul atau nama artis lain.`);
                return;
            }

            const youtubeId = String(topVideo.id || topVideo.videoId || '').trim();
            if (!youtubeId) {
                socket.emit('error-notifikasi', 'Hasil YouTube tidak memiliki ID video yang valid. Coba lagi.');
                return;
            }

            const videoTitle = String(topVideo.title || requestedTitle).trim();
            const sourceDuration = Number(topVideo.durationInSec) || parseYouTubeSearchDuration(topVideo.length) || 0;
            const durationResult = applyDurationLimit(sourceDuration);
            const durationApplied = durationResult.duration;
            const isDurationCut = durationResult.isCut;

            if (isDurationCut) {
                console.log(`⏱️ [MANUAL REQ] Lagu "${videoTitle}" dipotong ke ${durationApplied} detik.`);
            }

            const newSongRequest = {
                id: Date.now(),
                title: videoTitle,
                url: topVideo.url || `https://www.youtube.com/watch?v=${youtubeId}`,
                youtubeId,
                requestedBy: 'HOST',
                userAvatar: '',
                vvip: false,
                duration: durationApplied,
                isCut: isDurationCut,
                lyrics: []
            };

            let isMulaiDiputar = false;
            if (!currentSong) {
                currentSong = newSongRequest;
                isMulaiDiputar = true;
                console.log(`[PLAY OTOMATIS] Player kosong, langsung memutar: ${videoTitle}`);
                isMusicPlaying = true;
                startServerMusicTimer(true);
                setTimeout(() => io.emit('terima-kontrol', 'play'), 1000);
            } else {
                songQueue.push(newSongRequest);
                console.log(`✅ [MANUAL REQUEST QUEUED] "${videoTitle}" masuk antrean (#${songQueue.length}).`);
            }

            const ucapanKece = [
                'Gas, brow!',
                'Mantap, request masuk!',
                'Siap diputar!',
                'Keren, lagunya aman!',
                'Request diterima!',
                'Cus, musik jalan!'
            ];
            const randomUcapan = ucapanKece[Math.floor(Math.random() * ucapanKece.length)];
            aiQueue.push({
                isLocal: true,
                jawabanLokal: `${randomUcapan} Request dari HOST. Lagu "${videoTitle}" ${isMulaiDiputar ? 'langsung diputar!' : 'sudah masuk antrean!'}`,
                mode: 'tanya'
            });
            processAiQueue();
            io.emit('update-queue', { currentSong, songQueue, songHistory });
            io.emit('song-request', { user: 'HOST', nickname: 'HOST', query, source: 'manual' });
            loadSongLyricsInBackground(newSongRequest, videoTitle, artist, sourceDuration);
            console.log(`✅ [MANUAL REQUEST SUCCESS] "${videoTitle}" sudah dikirim ke player.`);
        } catch (error) {
            console.error(`❌ [MANUAL REQUEST ERROR] Gagal memproses "${query}":`, error);
            socket.emit('error-notifikasi', `Request lagu gagal diproses: ${error?.message || 'kesalahan YouTube'}`);
        }
    });

    socket.on('request-by-link', async (data = {}) => {
        let url = '';
        const requestedBy = String(data?.requestedBy || 'Admin / User Link');
        try {
            const rawUrl = String(data?.url || '').trim();
            console.log('Menerima link mentah:', rawUrl || '(kosong)');
            if (!rawUrl) {
                socket.emit('error-notifikasi', 'Tempel link video YouTube terlebih dahulu.');
                return;
            }

            let parsedUrl;
            try {
                parsedUrl = new URL(rawUrl);
            } catch {
                socket.emit('error-notifikasi', 'Format link tidak valid. Gunakan link video YouTube.');
                return;
            }

            const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
            let videoId = '';
            if (host === 'youtu.be') {
                videoId = parsedUrl.pathname.split('/').filter(Boolean)[0] || '';
            } else if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
                videoId = parsedUrl.searchParams.get('v') || '';
                if (!videoId) {
                    const pathMatch = parsedUrl.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/i);
                    videoId = pathMatch?.[1] || '';
                }
            }

            if (!videoId) {
                socket.emit('error-notifikasi', 'Link tidak berisi ID video YouTube yang dikenali.');
                return;
            }
            url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
            const ytValidate = play.yt_validate(url);
            if (ytValidate !== 'video') {
                socket.emit('error-notifikasi', 'Link harus mengarah ke video YouTube, bukan playlist atau halaman lain.');
                return;
            }

            console.log('Mengekstrak data dari link bersih:', url);
            let videoInfo;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    videoInfo = await play.video_basic_info(url);
                    break;
                } catch (error) {
                    const message = String(error?.message || error);
                    const retryable = /429|too many requests|timeout|timed out|ECONNRESET|EAI_AGAIN|network/i.test(message);
                    if (attempt === 0 && retryable) {
                        console.warn(`⚠️ [LINK REQUEST] Metadata sementara gagal; coba ulang 1 kali: ${message}`);
                        await new Promise(resolve => setTimeout(resolve, 1200));
                        continue;
                    }
                    throw error;
                }
            }

            const details = videoInfo?.video_details;
            if (!details) throw new Error('YouTube tidak mengembalikan metadata video.');
            const videoTitle = String(details.title || `Video YouTube ${videoId}`);
            const extractedId = String(details.id || videoId);
            const sourceDuration = Number(details.durationInSec) || 0;
            const durationResult = applyDurationLimit(sourceDuration);
            const durationApplied = durationResult.duration;
            const isDurationCut = durationResult.isCut;

            if (isDurationCut) {
                console.log(`⏱️ [DURATION CHECK] Lagu Link "${videoTitle}" dipotong ke ${durationApplied} detik.`);
            }

            const newSongRequest = {
                id: Date.now(),
                title: videoTitle,
                url,
                youtubeId: extractedId,
                requestedBy,
                userAvatar: '',
                duration: durationApplied,
                isCut: isDurationCut,
                lyrics: []
            };

            if (!currentSong) {
                currentSong = newSongRequest;
                isMusicPlaying = true;
                console.log(`[PLAY OTOMATIS] Player kosong, langsung memutar: ${videoTitle}`);
                startServerMusicTimer(true);
                setTimeout(() => io.emit('terima-kontrol', 'play'), 1000);
            } else {
                songQueue.push(newSongRequest);
                console.log(`✅ [LINK REQUEST QUEUED] "${videoTitle}" masuk antrean (#${songQueue.length}).`);
            }

            io.emit('update-queue', { currentSong, songQueue, songHistory });
            loadSongLyricsInBackground(newSongRequest, videoTitle, '', sourceDuration);
            console.log(`✅ [LINK REQUEST SUCCESS] ID=${extractedId} title="${videoTitle}" status=${currentSong?.id === newSongRequest.id ? 'playing' : 'queued'}.`);
        } catch (error) {
            console.error('Gagal memproses link YouTube:', error);
            socket.emit('error-notifikasi', `Link YouTube gagal diproses: ${error?.message || 'metadata tidak tersedia'}`);
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
        if (!data) return;

        const sourceUser =
            data.user && typeof data.user === 'object'
                ? data.user
                : {};

        const overlayData = {
            ...data,

            // Data rank jika tersedia
            rank:
                data.rank ??
                data.ranking ??
                data.userRank ??
                data.rankNumber ??
                sourceUser.rank ??
                null,

            // Data streak/combo jika tersedia
            streak:
                data.streak ??
                data.likeStreak ??
                data.combo ??
                data.streakCount ??
                sourceUser.streak ??
                sourceUser.combo ??
                null,

            // Berbagai kemungkinan nama field badge
            badges:
                data.badges ??
                data.userBadges ??
                data.tiktokBadges ??
                sourceUser.badges ??
                []
        };

        console.log('[OVERLAY DATA]', {
            user: overlayData.nickname || overlayData.uniqueId,
            rank: overlayData.rank,
            streak: overlayData.streak,
            badges: overlayData.badges
        });

        // Tetap tampilkan chat pada overlay
        io.emit('display-chat', overlayData);

        // TTS tetap memakai data yang sudah dinormalisasi
        if (isChatReadingActive && overlayData.message) {
            io.emit('play-chat-tts', {
                user: overlayData.nickname ||
                    overlayData.uniqueId ||
                    'Penonton',
                text: String(overlayData.message).slice(0, 160)
            });
        }
    });



    socket.on('reset-session', () => {
        isConnected = false;
        currentUsername = null;
        liveStartTime = null;
        setActiveFollowHost('');

        if (tiktokConnection) {
            tiktokConnection.disconnect();
            tiktokConnection = null;
        }

        aiQueue = [];
        isAiProcessing = false;
        topGifts = {};
        if (topGiftBroadcastTimer) {
            clearTimeout(topGiftBroadcastTimer);
            topGiftBroadcastTimer = null;
        }
        topLikes = {};
        totalLikeCount = 0;
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

        const simulatedRepeat = Math.max(1, Number(data?.count || data?.repeatCount || 1));
        const simulatedCoinPerGift = Math.max(0, Number(data?.coinPerGift || data?.diamondCount || 0));
        const simulatedTotalCoins = Number(data?.totalCoins || (simulatedCoinPerGift * simulatedRepeat));
        subathonEngine.handleGift({
            nickname: data?.nickname || 'Tester',
            uniqueId: data?.uniqueId || 'subathon-simulator',
            giftName: data?.giftName || 'Gift Simulasi',
            repeatCount: simulatedRepeat,
            coinPerGift: simulatedCoinPerGift,
            totalCoins: simulatedTotalCoins
        });

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
