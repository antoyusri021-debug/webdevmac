/**-------------------WEBDEV---------------------
 * CORE MODULE SETUP
 ------------------------------------------------*/
const play = require('play-dl');
const youTubeSearchApi = require('youtube-search-api');
const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs'); // (Tetap Dipakai)
const path = require('path'); // (Tetap Dipakai)

// (Ini baris barunya, brow!)
let saveDir = __dirname;
try {
    const { app } = require('electron');
    if (app) {
        saveDir = app.getPath('userData');
    }
} catch (e) { }

// Baris filePath yang lama diganti jadi pakai 'saveDir', bukan '__dirname' lagi
const filePath = path.join(saveDir, 'brand-data.json');
let brandTexts = ["WELCOME TO STREAM"];

// Load data pas server pertama kali nyala
if (fs.existsSync(filePath)) {
    try {
        const rawData = fs.readFileSync(filePath, 'utf8');
        brandTexts = JSON.parse(rawData);
    } catch (e) {
        console.log("Gagal load file json, pake default aja", e);
    }
}


app.use(express.static(__dirname));
app.use('/themes', express.static(path.join(__dirname, 'themes')));
app.use('/pages', express.static(path.join(__dirname, 'pages')));
app.use('/musik', express.static(path.join(__dirname, 'themes', 'musik')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/monitoring', (req, res) => res.sendFile(path.join(__dirname, 'monitoring.html')));

let tiktokConnection = null;
let currentUsername = null;
let isConnected = false;
let liveStartTime = null;
let topGifts = {};
let topLikes = {};
let sebaranUsers = new Set();
let totalFollowers = new Set();
let giftRequestUsers = new Map();

let socialState = {
    enabled: false,
    duration: 5000,
    instagram: "",
    tiktok: "",
    youtube: "",
    discord: ""
};

let currentRequestMode = 'free'; // Default awal: bebas via chat
let songQueue = [];              // Menampung antrean lagu
let currentSong = null;          // Lagu yang sedang berputar
let isKaraokeModeActive = false; // Status awal terkunci atau tidak


// FUNGSI UTAMA MEMASUKKAN LAGU KE ANTREAN
async function tambahKeQueue(judulLagu, uniqueId, avatarUrl) {

    const normalize = (str) =>
        str.trim().toLowerCase().replace(/\s+/g, " ");

    const judulBaru = normalize(judulLagu);

    // ==============================
    // CEK DUPLIKAT DI QUEUE + CURRENT
    // ==============================
    const sudahAdaDiQueue = songQueue.some(song =>
        normalize(song.title) === judulBaru
    );

    const sedangDiputar =
        currentSong && normalize(currentSong.title) === judulBaru;

    if (sudahAdaDiQueue || sedangDiputar) {
        console.log(`⚠️ [DUPLIKAT DITOLAK] ${judulLagu}`);

        io.emit('overlay:request-denied', {
            user: uniqueId,
            nickname: uniqueId,
            profilePictureUrl: avatarUrl,
            message: "Lagu sudah ada di antrian!"
        });

        return; // STOP di sini, jangan lanjut YouTube search
    }

    let ytVideoId = '';

    try {
        console.log(`[YouTube] Mencari lagu: ${judulLagu}...`);

        const searchResult = await youTubeSearchApi.GetListByKeyword(
            judulLagu,
            false,
            1
        );

        if (searchResult && searchResult.items && searchResult.items.length > 0) {
            ytVideoId = searchResult.items[0].id;
            console.log(
                `[YouTube] Ketemu! ID Video: ${ytVideoId} - Judul Asli: ${searchResult.items[0].title}`
            );
        } else {
            console.log(`[YouTube] Lagu "${judulLagu}" tidak ditemukan.`);
        }

    } catch (error) {
        console.error("[YouTube Error] Gagal melakukan searching:", error);
    }

    const dataLagu = {
        id: Date.now(),
        title: judulLagu,
        requestedBy: uniqueId,
        userAvatar: avatarUrl,
        youtubeId: ytVideoId
    };

    songQueue.push(dataLagu);

    if (!currentSong) {
        currentSong = songQueue.shift();
    }

    io.emit('update-queue', { currentSong, songQueue });
}

//---------------------SOKET INTERNET-----------------------------------
const si = require('systeminformation');
const WebSocket = require('ws');
const ping = require('ping');

const wss = new WebSocket.Server({ port: 9090 });

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

            const downloadMbps =
                ((network[0].rx_sec * 8) / 1000000).toFixed(2);

            const uploadMbps =
                ((network[0].tx_sec * 8) / 1000000).toFixed(2);

            broadcast({
                ping: result.time,
                download: downloadMbps,
                upload: uploadMbps
            });

        } catch (err) {
            console.log(err);
        }

    }, 2000);
}

function stopNetworkMonitor() {

    if (!monitorInterval) return;

    console.log("Network Monitor STOP");

    clearInterval(monitorInterval);
    monitorInterval = null;
}
app.get('/network/start', (req, res) => {

    startNetworkMonitor();

    res.json({
        success: true
    });

});

app.get('/network/stop', (req, res) => {

    stopNetworkMonitor();

    res.json({
        success: true
    });

});
//--------------------SOKET INTERNET------------------------------


/**-------------------WEBDEV---------------------
 * FUNGSI UTAMA KONEKSI TIKTOK
 ------------------------------------------------*/
function setupTikTokEvents(username, socket) {
    if (tiktokConnection) {
        tiktokConnection.removeAllListeners();
        tiktokConnection.disconnect();
    }

    tiktokConnection = new WebcastPushConnection(username, {
        processInitialData: true,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestOptions: {
            timeout: 10000,
        },
        clientParams: {
            "app_language": "id-ID",
            "device_platform": "web"
        }
    });


    tiktokConnection.connect().then(state => {

        isConnected = true;
        currentUsername = username;
        liveStartTime = Date.now();

        console.log(`✅ Terhubung ke: ${username} (Room ID: ${state.roomId})`);
        io.emit('tiktok-connected', { startTime: liveStartTime });
        socket.emit('status', `Tersambung: ${username}`);
    }).catch(err => {
        console.error('❌ Gagal Konek:', err);
        socket.emit('status', `Gagal: ${err.message || 'Username tidak ditemukan / Sedang Offline'}`);
    });

    // EVENT VIEWER COUNT
    tiktokConnection.on('viewerCount', (data) => {
        let count = (data && typeof data === 'object') ? (data.viewerCount || 0) : (data || 0);
        io.emit('update-viewer-count', { count: count });
    });

    tiktokConnection.on('roomUser', (data) => {
        if (data && data.viewerCount) {
            io.emit('update-viewer-count', { count: data.viewerCount });
        }
    });

    // EVENT CHAT
    tiktokConnection.removeAllListeners('chat');

    // EVENT CHAT TIKTOK
    tiktokConnection.on('chat', (data) => {

        // 🔒 GERBANG PENGAMAN KARAOKE
        if (isKaraokeModeActive) {
            console.log(`🚫 [BLOCKED] Request dari ${data.uniqueId} ditolak (Mode Karaoke ON)`);
            return; // Langsung stop, gak akan lanjut ke logika request di bawah
        }

        io.emit('new-chat-monitor', {
            user: data.uniqueId,
            nickname: data.nickname,
            message: data.comment,
            profilePictureUrl: data.profilePictureUrl
        });

        io.emit('chat', data);

        // =====================================================================
        // LOGIKA SONG REQUEST - MODE FREE (CHAT) AND GIFT SERTA FORMAT REQUEST
        // =====================================================================
        if (currentRequestMode === 'free') {

            const pesan = (data.comment || "").trim();

            // hanya terima format: !req
            if (!pesan.toLowerCase().startsWith('!req ')) return;

            // LANGSUNG AMBIL UTUH: Semua teks setelah "!req "
            const query = pesan.slice(5).trim();

            // Pengaman: jika cuma ngetik "!req " doang tanpa judul, abaikan
            if (!query) return;

            tambahKeQueue(query, data.uniqueId, data.profilePictureUrl);

            console.log(`🎵 [FREE REQUEST VALID] ${query}`);
        }

        if (currentRequestMode === 'gift') {

            const pesan = (data.comment || "").trim();

            if (!pesan.toLowerCase().startsWith('!req '))
                return;

            const giftData = giftRequestUsers.get(data.uniqueId);

            if (!giftData || giftData.expire < Date.now()) {

                io.emit('song-request-denied', {
                    user: data.uniqueId,
                    nickname: data.nickname,
                    profilePictureUrl: data.profilePictureUrl,
                    message: "Kirim gift terlebih dahulu untuk request lagu 🎁"
                });

                return;
            }

            // LANGSUNG AMBIL UTUH: Semua teks setelah "!req "
            const query = pesan.slice(5).trim();

            // Pengaman Gift: Jika judul kosong, kasih notifikasi error ke viewer
            if (!query) {
                io.emit('song-request-denied', {
                    user: data.uniqueId,
                    nickname: data.nickname,
                    profilePictureUrl: data.profilePictureUrl,
                    message: "Format salah! Ketik: !req [judul lagu & penyanyi]"
                });
                return;
            }

            tambahKeQueue(
                query,
                data.uniqueId,
                data.profilePictureUrl
            );

            // habiskan hak request
            giftRequestUsers.delete(data.uniqueId);

            console.log(
                `🎁 [GIFT REQUEST VALID] ${query}`
            );
        }

    });

    // EVENT GIFT (LOGIKA GIFT ALERT & TOP GIFT)
    tiktokConnection.on('gift', (data) => {

        if (currentRequestMode === 'gift') {

            giftRequestUsers.set(data.uniqueId, {
                expire: Date.now() + (5 * 60 * 1000) // berlaku 5 menit
            });

            console.log(
                `🎁 ${data.uniqueId} mendapatkan 1 hak request lagu`
            );
        }

        if (!data || typeof data !== "object") return;

        let giftIcon = null;

        if (data.giftPictureUrl) {
            giftIcon = data.giftPictureUrl;
        } else if (data.extendedGiftInfo?.icon?.urls?.length > 0) {
            giftIcon = data.extendedGiftInfo.icon.urls[0];
        } else if (data.extendedGiftInfo?.icon?.urlList?.length > 0) {
            giftIcon = data.extendedGiftInfo.icon.urlList[0];
        }

        // ALWAYS EMIT GIFT
        io.emit("new-gift", {
            user: data.uniqueId,
            nickname: data.nickname,
            profilePictureUrl: data.profilePictureUrl,
            giftName: data.giftName,
            count: data.repeatCount,
            giftIcon

        });

        io.emit('gift', data);

        // TOP GIFT
        if (!topGifts[data.uniqueId]) {
            topGifts[data.uniqueId] = {
                user: data.uniqueId,
                nickname: data.nickname,
                profilePic: data.profilePictureUrl,
                total: 0
            };
        }

        topGifts[data.uniqueId].total += data.repeatCount;

        io.emit('update-top-gift', Object.values(topGifts));

        // ==========================================================
        // DI SINI TEMPATNYA, BROW! (Tepat setelah update top gift)
        // ==========================================================
        if (isKaraokeModeActive) {
            console.log(`🚫 [BLOCKED] Request via GIFT dari ${data.uniqueId} ditolak (Mode Karaoke ON)`);
            return;
        }

        // 3. BARU KEMUDIAN CEK KODE !REQ DI BAWAHNYA
        // (Pastikan variabel 'text' di sini merujuk ke data.comment atau data.message)
        const text = data.comment || ""; // Pastikan variabel text ini terdefinisi

        if (!text.toLowerCase().startsWith('!req ')) return;


        // ==========================================
        // SONG REQUEST (GIFT MODE SAFE + STRICT)
        // ==========================================

        // HARUS format !req
        if (!text.toLowerCase().startsWith('!req ')) return;

        const raw = text.slice(5).trim();

        // wajib ada "-"
        if (!raw.includes('-')) {
            io.emit('song-request-denied', {
                user: data.uniqueId,
                nickname: data.nickname,
                profilePictureUrl: data.profilePictureUrl,
                message: "Format salah! Gunakan: !req judul - penyanyi"
            });
            return;
        }

        const [judul, penyanyi] = raw.split('-').map(v => v.trim());

        if (!judul) return;

        const query = `${judul} ${penyanyi || ''}`;

        tambahKeQueue(query, data.uniqueId, data.profilePictureUrl);

        console.log(`🎁 [GIFT REQUEST VALID] ${query}`);
    });


    // EVENT SOCIAL (FOLLOW, SHARE)
    tiktokConnection.on('social', (data) => {
        let type = 'SOCIAL';

        // LOGIKA FOLLOW
        if (data.displayType && data.displayType.includes('follow')) {
            type = 'FOLLOW';
            totalFollowers.add(data.uniqueId);
            io.emit('update-follower-count', { total: totalFollowers.size });
            io.emit('new-follower', {
                user: data.uniqueId,
                nickname: data.nickname,
                profilePictureUrl: data.profilePictureUrl
            });
        }

        // LOGIKA FOLLOWER BARU
        if (data.displayType && data.displayType.includes('follow')) {
            io.emit('new-follower', {
                user: data.uniqueId,
                nickname: data.nickname,
                profilePictureUrl: data.profilePictureUrl
            });
            console.log(`✨ [New Follow] ${data.nickname} baru saja follow!`);
        }

        // LOGIKA SHARE
        if (data.displayType && data.displayType.includes('share')) {
            type = 'SHARE';
            io.emit('new-share', {
                user: data.uniqueId,
                nickname: data.nickname,
                profilePictureUrl: data.profilePictureUrl
            });
            console.log(`📢 ${data.nickname} membagikan Live!`);
        }

        io.emit('new-social-monitor', {
            user: data.uniqueId,
            nickname: data.nickname,
            type: type
        });

        io.emit('social', data);
    });

    // EVENT LIKE
    tiktokConnection.on('like', (data) => {
        const uid = data.uniqueId;

        if (!topLikes[uid]) {
            topLikes[uid] = {
                nickname: data.nickname || uid,
                profilePictureUrl: data.profilePictureUrl,
                count: 0
            };
        }

        const tapSekarang = parseInt(data.likeCount) || 1;
        topLikes[uid].count += tapSekarang;

        const totalSemuaLike = Object.values(topLikes).reduce((sum, u) => sum + u.count, 0);

        io.emit('like-stats', { totalLikeCount: totalSemuaLike });
        io.emit('new-like', { allLikes: topLikes });

        console.log(`❤️ ${data.nickname} Tap +${tapSekarang} | Total: ${topLikes[uid].count}`);
    });

    // EVENT JOIN
    tiktokConnection.on('member', (data) => {

        if (data.uniqueId) {
            sebaranUsers.add(data.uniqueId);
            io.emit('update-sebaran', { total: sebaranUsers.size });
        }
        io.emit('new-join-monitor', {
            user: data.uniqueId,
            nickname: data.nickname
        });

        // Kita ambil URL foto profil, kalau kosong pakai placeholder
        const profilePic = data.profilePictureUrl || (data.userDetails ? data.userDetails.profilePictureUrl : null);

        io.emit('new-join', {
            user: data.nickname || data.uniqueId,
            profilePictureUrl: profilePic // Mengirim URL avatar penonton bosku
        });

        io.emit('member', data);
    });

    // STATUS KONEKSI
    tiktokConnection.on('disconnected', () => {
        // status jadi false, tapi JANGAN hapus currentUsername dulu
        isConnected = false;

        console.log('🔌 Koneksi TikTok Terputus');

        // Beri tahu dashboard kalau kita sedang mencoba menyambung kembali
        io.emit('status', 'Terputus... Mencoba menyambung kembali otomatis');
        io.emit('tiktok-disconnected');
        io.emit('update-viewer-count', { count: 0 });

        // LOGIKA AUTO-RECONNECT
        setTimeout(() => {
            if (!isConnected && currentUsername) {
                console.log(`🔄 [Auto-Reconnect] Menghubungkan kembali ke: ${currentUsername}`);
                setupTikTokEvents(currentUsername, socket);
            }
        }, 5000);
    });

    tiktokConnection.on('viewerCountUpdate', (data) => {
        io.emit('update-stats', {
            viewerCount: data.viewerCount,
            liveStatus: "LIVE"
        });
    });
}


/**--------------------------WEBDEV---------------------------------
 * SOCKET.IO HANDLER
 ------------------------------------------------------------------*/
io.on('connection', (socket) => {
    // HANDLER KHUSUS SONG REQUEST INDEPENDEN (Taruh di awal io.on connection)
    socket.emit('update-queue', { currentSong, songQueue });
    socket.emit('sync-request-mode', currentRequestMode);

    // Di sini fungsi socket.on('get-brand-texts') lu yang kemarin aman ngebaca brandTexts global
    socket.emit('brand-texts-changed', brandTexts);

    // B. Nangkep data array utuh dari dashboard pas user klik ADD atau HAPUS
    socket.on('update-brand-texts', (newData) => {
        brandTexts = newData; // Ganti data di server dengan data terbaru dari UI

        // LANGSUNG LOCK KE FILE FISIK BROW! Biar permanen anti-hilang
        fs.writeFileSync(filePath, JSON.stringify(brandTexts, null, 2), 'utf8');

        // Sebar data terupdate ke OBS / Overlay biar langsung sinkron live
        io.emit('brand-texts-changed', brandTexts);
    });

    // Terima perubahan opsi (Free/Gift) dari dashboard
    socket.on('change-request-mode', (mode) => {
        currentRequestMode = mode;
        console.log(`⚙️ Mode Request Diubah ke: ${currentRequestMode.toUpperCase()}`);
        io.emit('sync-request-mode', currentRequestMode);
    });

    // Dengarkan perubahan saklar dari admin dashboard untuk fitur karoke
    socket.on("set-karaoke-mode", (status) => {
        isKaraokeModeActive = status;
        console.log(`🔒 [SYSTEM] Mode Karaoke diubah menjadi: ${isKaraokeModeActive ? "AKTIF (Request Viewer Ditutup)" : "NONAKTIF"}`);
    });

    //MUSIK PAS REQUEST PLAY mUSIK PILIHAN
    socket.on('play-request-song', (songId) => {

        console.log("▶ PLAY REQUEST MANUAL ID:", songId);

        const index = songQueue.findIndex(s => s.id === songId);

        if (index === -1) return;

        // ambil lagu dari queue
        const selectedSong = songQueue[index];

        // hapus dari queue
        songQueue.splice(index, 1);

        // langsung jadi current song
        currentSong = selectedSong;

        console.log("🎵 Now Playing:", currentSong.title);

        // update semua client
        io.emit('update-queue', {
            currentSong,
            songQueue
        });
    });

    // Di-trigger oleh Player OBS ketika lagu selesai diputar
    socket.on('next-song', () => {

        console.log("QUEUE SEBELUM:", songQueue.map(x => x.title));

        currentSong = songQueue.length > 0
            ? songQueue.shift()
            : null;

        console.log("CURRENT:", currentSong?.title);
        console.log("QUEUE SESUDAH:", songQueue.map(x => x.title));

        io.emit('update-queue', { currentSong, songQueue });
    });

    //Soket untuk next manual lagu
    socket.on('next-song-manual', () => {
        console.log("⏭️ Next song manual triggered");
        if (songQueue.length > 0) {
            currentSong = songQueue.shift();
        } else {
            currentSong = null;
        }
        io.emit('update-queue', { currentSong, songQueue });
    });

    //soket untuk reset daftar lagu semua yg ada didaftar lagu
    socket.on('reset-queue', () => {

        console.log("🧹 Queue direset dari dashboard");

        songQueue = [];
        currentSong = null;

        io.emit('update-queue', { currentSong, songQueue });
    });

    // Hapus lagu tertentu dari queue
    socket.on('delete-song', (songId) => {

        console.log(`🗑️ Menghapus lagu ID: ${songId}`);

        songQueue = songQueue.filter(song => song.id !== songId);

        io.emit('update-queue', {
            currentSong,
            songQueue
        });

    });

    //SOKET UNTUK REQUEST MANUAL INPUT
    socket.on("manual-add-song", async (song) => {
        console.log("🔥 MANUAL MASUK (PENGGANTI VIA PLAY-DL):", song);

        if (!song || !song.title) return;

        try {
            const query = `${song.title} ${song.artist || ''}`.trim();
            console.log(`[YouTube] Mencari lagu via play-dl: ${query}...`);

            // 1. Cari video di YouTube (ambil hasil teratas)
            const searchResults = await play.search(query, { limit: 1 });

            if (!searchResults || searchResults.length === 0) {
                console.log("Lagu tidak ditemukan di YouTube, brow!");
                return;
            }

            const topVideo = searchResults[0];

            // 2. Bungkus data sesuai dengan format yang diminta oleh overlay (glassmorphic-anime.html)
            const newSongRequest = {
                id: Date.now(),
                title: topVideo.title,
                url: topVideo.url,
                youtubeId: topVideo.id, // ID murni untuk pemicu video jalan di overlay
                requestedBy: "HOST",
                userAvatar: "" // Kosongkan agar overlay lu generate inisial nama otomatis
            };

            // 3. LOGIKA CEK PLAYER: Langsung play kalau kosong, masuk antrean kalau ada lagu jalan
            if (!currentSong) {
                currentSong = newSongRequest;
                console.log(`[PLAY OTOMATIS] Player kosong, langsung memutar: ${topVideo.title}`);
            } else {
                songQueue.push(newSongRequest);
                console.log(`[ANTRE] Ada lagu sedang berputar, ${topVideo.title} masuk antrean.`);
            }

            // 4. Kirim data terbaru ke Admin Dashboard & Overlay biar sinkron seketika
            io.emit("update-queue", { currentSong, songQueue });

            // 5. Emit opsional bawaan lu (tetap dipertahankan kalau dibutuhkan komponen lain)
            io.emit("song-request", {
                user: "HOST",
                nickname: "HOST",
                query,
                source: "manual"
            });

        } catch (error) {
            console.error("[YouTube Error] Gagal memproses manual add song:", error);
        }
    });

    // SOKET UNTUK REQUEST LAGU MENGGUNAKAN LINK
    socket.on('request-by-link', async (data) => {
        try {
            let { url, requestedBy } = data;

            console.log("Menerima link mentah:", url);

            // 1. Bersihkan link dari parameter playlist/mix radio
            if (url.includes('youtube.com/watch')) {
                const urlObj = new URL(url);
                const videoId = urlObj.searchParams.get('v');
                if (videoId) {
                    url = `https://www.youtube.com/watch?v=${videoId}`;
                }
            }

            // 2. Validasi tipe link murni menggunakan play-dl
            const ytValidate = play.yt_validate(url);
            if (!ytValidate || (ytValidate !== 'video' && !url.includes('youtu.be') && !url.includes('v='))) {
                console.log("Link yang dimasukkan bukan link video YouTube valid.");
                return;
            }

            console.log("Mengekstrak data dari link bersih:", url);

            // 3. Ambil informasi detail video dari YouTube
            const videoInfo = await play.video_basic_info(url);
            const videoTitle = videoInfo.video_details.title;

            // AMBIL ID VIDEO LANGSUNG DARI HASIL SCRAPING PLAY-DL (SANGAT AMAN)
            const extractedId = videoInfo.video_details.id;

            console.log("Berhasil mendapatkan YouTube ID:", extractedId);

            // 4. Buat struktur objek lagu baru (SINKRON TOTAL DENGAN OVERLAY LU)
            const newSongRequest = {
                id: Date.now(),
                title: videoTitle,
                url: url,
                youtubeId: extractedId, // Ini yang dicari oleh song.youtubeId di overlay lu, brow!
                requestedBy: requestedBy || "Admin / User Link",
                userAvatar: "" // Sengaja dikosongin agar overlay lu auto nge-generate gambar inisial nama
            };

            // 5. Cek apakah pemutar sedang kosong/idle
            if (!currentSong) {
                currentSong = newSongRequest;
                console.log(`[PLAY OTOMATIS] Pemutar kosong, langsung memutar: ${videoTitle}`);
            } else {
                songQueue.push(newSongRequest);
                console.log(`[ANTRE] Ada lagu sedang berputar, ${videoTitle} masuk list.`);
            }

            // 6. Broadcast update status terbaru ke dashboard admin & overlay
            io.emit('update-queue', { currentSong, songQueue });

        } catch (error) {
            console.error("Gagal memproses link YouTube:", error);
        }
    });

    // SOKET UNTUK DRAG AND DROP LAGU YG DI DAFATAR LAGU ANTRIAN
    socket.on('reorder-queue', (newQueue) => {
        // 1. Timpa songQueue di server dengan urutan baru yang dikirim client
        songQueue = newQueue;

        // 2. Broadcast ulang urutan baru ini ke SEMUA client & overlay biar sinkron total!
        io.emit('update-queue', { currentSong, songQueue });
    });


    // KRIRIM SINYAL TEST JOIN
    socket.on('test-join', () => {
        console.log('🧪 TEST JOIN');
        io.emit('new-join', {
            user: 'WebDev Tester',
            nickname: 'WebDev Tester',
            profilePictureUrl: 'https://www.w3schools.com/howto/img_avatar.png'
        });
    });
    // KRIRIM SINYAL TEST GIFT ALERT
    socket.on('test-gift', () => {
        io.emit('new-gift', {
            nickname: 'WebDev Tester',
            giftName: 'Rose',
            count: 1,
            giftIcon: 'https://p16-va-default.akamaized.net/obj/v-us/7074251703138307077'
        });
    });

    //TEST GIFT DATA ANIMASI BERGERAK DARI KANAN KEKIRI
    // Tangkap event kosong dari aplikasi
    socket.on("test-gift-trigger", () => {
        console.log("Server menerima request TEST. Membuat data tiruan...");

        // Server yang buatin datanya di sini
        const mockGiftData = {
            nickname: "Sultan_Preview",
            giftName: "Rose",
            count: 1,
            profilePictureUrl: "https://i.imgur.com/7k12EPD.png"
        };

        // Sebarkan data tiruan ini ke semua overlay (termasuk preview)
        io.emit("new-gift", mockGiftData);
    });

    // [TAMBAHAN] Kirim status koneksi saat diminta oleh dashboard
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


    // SOCIAL ROTATOR
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

    // [FIX] Kirim data awal hanya jika data tersebut sudah ada isinya
    if (Object.keys(topGifts).length > 0) {
        let sortedSultans = Object.values(topGifts).sort((a, b) => b.total - a.total).slice(0, 5);
        socket.emit('update-top-gift', sortedSultans);
    }

    if (Object.keys(topLikes).length > 0) {
        socket.emit('new-like', { allLikes: topLikes });
    }

    // [FIX] Hapus double "set-target", cukup pakai satu saja:
    socket.on('set-target', (username) => {
        if (!username) return socket.emit('status', 'Username kosong!');
        setupTikTokEvents(username, socket);
    });

    socket.on('send-to-overlay', (data) => {
        io.emit('display-chat', data);
    });

    socket.on('reset-session', () => {
        // RESET STATUS KONEKSI
        isConnected = false;
        currentUsername = null;
        liveStartTime = null;

        if (tiktokConnection) {
            tiktokConnection.disconnect();
            tiktokConnection = null;
        }
        topGifts = {};
        topLikes = {};
        sebaranUsers = new Set(); // [BARU] Bersihkan daftar sebaran
        io.emit('status', 'Terputus (Reset)');
        io.emit('update-sebaran', { total: 0 }); // [BARU] Beritahu monitoring
        io.emit('update-top-gift', []);
        io.emit('new-like', { allLikes: {} });
        io.emit('update-viewer-count', { count: 0 });
        totalFollowers = new Set(); // Reset data follower
        io.emit('update-follower-count', { total: 0 });
        io.emit('tiktok-disconnected');
        console.log('🧹 Sesi direset oleh user');
    });

    //BAGIAN BRAND ROTATOR DI SERVER --

    // 1. Kirim data yang ada ke overlay pas baru dibuka
    socket.on('get-brand-texts', () => {
        socket.emit('brand-texts-changed', brandTexts);
    });

    // 2. Terima update dari dashboard dan sebar ke semua overlay
    socket.on('update-brand-texts', (newList) => {
        brandTexts = newList; // Simpan di memori server
        io.emit('brand-texts-changed', brandTexts); // Broadcast ke semua
    });

    // SIMULASI TEST FOLLOWER
    socket.on('test-follower-milestone', () => {
        if (typeof global.testFollowCount === 'undefined') global.testFollowCount = 0;

        global.testFollowCount += 1;

        io.emit('update-follower-count', {
            total: global.testFollowCount
        });

        console.log("Test Follower: " + global.testFollowCount);
    });

    // SIMULASI TEST FOLLOWER
    socket.on('test-follow', () => {
        io.emit('new-follower', {
            user: 'tester_squad',
            nickname: 'Follower Baru',
            profilePictureUrl: 'https://www.w3schools.com/howto/img_avatar.png'
        });
        console.log("🧪 Simulasi Follower dikirim ke overlay.");
    });

    // RESET GAMES
    socket.on('reset-battle', () => {
        io.emit('reset-battle'); // Teruskan ke overlay game buat reset HP
    });

    // GAME TEBAK KATA
    socket.on('start-tebak', (data) => {
        console.log("Menerima perintah tebak kata:", data); // Cek di terminal muncul gak?
        io.emit('start-tebak', data); // Ini yang bertugas lempar sinyal ke overlay
    });

    // Jembatan untuk Monster
    socket.on('start-monster', (data) => {
        io.emit('start-monster', data);
    });


});


/*SERVER STARTUP*/
const PORT = process.env.PORT || 3000;

// Cukup panggil satu kali ini aja, brow!
http.listen(PORT, () => {
    console.log(`\n🚀 Server Berjalan di port ${PORT}\n🔗 Dashboard: http://localhost:${PORT}\n`);
});