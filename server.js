/**-------------------WEBDEV---------------------
 * CORE MODULE SETUP
 ------------------------------------------------*/
const play = require('play-dl');
const youTubeSearchApi = require('youtube-search-api');
const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');

// 🔥 PASTE KODE GEMINI LU DI SINI BROW 🔥
// Hapus baris GoogleGenerativeAI lama, ganti dengan ini:
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: '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' });

const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');
const googleTTS = require('google-tts-api'); // 👈 Tambahkan library ini di atas!

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
// Menampung status aktif/nonaktif sesi AI dari kontrol panel luar
let isTanyaJawabActive = true;
let isCurhatActive = true;
let blacklistKeywords = []; // Menampung kata kunci yang dikirim dari kontrol panel
let songQueue = [];              // Menampung antrean lagu
let songHistory = []; // Menampung maksimal 10 lagu yang sudah diputar
let currentSong = null;          // Lagu yang sedang berputar
let isKaraokeModeActive = false; // Status awal terkunci atau tidak
let maxRequestLimit = 1; //Menentukan batas limit request musik secara realtime
// Taruh di scope global (atas file)
let aiQueue = [];
let isAiProcessing = false;

// FUNGSI UTAMA MEMASUKKAN LAGU KE ANTREAN (SUDAH DI-GEMBOK KUOTA)
async function tambahKeQueue(judulLagu, uniqueId, avatarUrl, isVvip = false) {

    const username = uniqueId || 'GUEST';

    // =================================================================
    // 🔥 PENGAMAN 1: ANTI-TROLL BLACKLIST
    // =================================================================
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

    // =================================================================
    // 🔒 PENGAMAN 2: CEK KUOTA AKTIF USER (VVIP BEBAS KUOTA!)
    // =================================================================
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

    // Ambil YouTube ID terlebih dahulu agar penundaan async selesai sebelum pengecekan antrean final
    let ytVideoId = '';
    try {
        const searchResult = await youTubeSearchApi.GetListByKeyword(judulLagu, false, 1);
        if (searchResult && searchResult.items && searchResult.items.length > 0) {
            ytVideoId = searchResult.items[0].id;
        }
    } catch (error) {
        console.error("[YouTube Error] Gagal searching:", error);
    }

    // =================================================================
    // 🔒 PENGAMAN 3: CEK DUPLIKAT (Pindah ke sini setelah AWAIT untuk anti-race condition)
    // =================================================================
    const normalize = (str) => str.trim().toLowerCase().replace(/\s+/g, " ");
    const judulBaru = normalize(judulLagu);

    const sudahAdaDiQueue = songQueue.some(song => normalize(song.title) === judulBaru);
    const sedangDiputar = currentSong && normalize(currentSong.title) === judulBaru;

    if (sudahAdaDiQueue || sedangDiputar) {
        console.log(`⚠️ [DUPLIKAT DITOLAK] ${judulLagu}`);
        io.emit('overlay:request-denied', { user: username, message: "Lagu sudah ada di antrian!" });
        return;
    }

    // Buat objek data lagu dengan flag vvip
    const dataLagu = {
        id: Date.now(),
        title: judulLagu,
        requestedBy: username,
        userAvatar: avatarUrl,
        youtubeId: ytVideoId,
        vvip: isVvip
    };

    // =================================================================
    // LOGIKA MASUK PLAYER ATAU ANTRIAN PRIORITAS (SINKRON & AMAN)
    // =================================================================
    let statusPutarTts = "";

    // FIX: Cukup cek apakah ada lagu yang sedang berjalan di `currentSong`
    if (!currentSong) {
        currentSong = dataLagu;
        console.log(`[PLAY OTOMATIS] Player kosong, memutar VVIP/Normal: ${judulLagu}`);
        statusPutarTts = "langsung diputar ya!";
    } else {
        // Jika sedang ada lagu yang berputar, otomatis masuk antrean tanpa ganggu player aktif
        if (isVvip) {
            // 🔥 JALUR CEPAT VVIP: Selalu antre di urutan paling pertama (Index 0)
            songQueue.unshift(dataLagu);
            console.log(`🔥 [VVIP JALUR CEPAT] ${judulLagu} masuk antrean urutan #1.`);
            statusPutarTts = "berhasil menyalip ke urutan pertama antrean!";
        } else {
            // Request biasa masuk paling belakang
            songQueue.push(dataLagu);
            console.log(`[ANTRE NORMAL] ${judulLagu} masuk antrean belakang.`);
            statusPutarTts = "sudah masuk antrean ya!";
        }
    }

    // =================================================================
    // 📢 GO! ANTRIAN VOICE AI TTS
    // =================================================================
    const ucapanKece = [
        `Asik banget, thank you bro`,
        `Mantap nih, makasih ya kak`,
        `Gokil selera musiknya, thank you`,
        `Pilihan keren, makasih banyak`
    ];
    const randomUcapan = ucapanKece[Math.floor(Math.random() * ucapanKece.length)];

    aiQueue.push({
        isLocal: true,
        jawabanLokal: `${randomUcapan} @${dataLagu.requestedBy}. Lagu ${judulLagu} ${statusPutarTts}`,
        mode: 'tanya'
    });

    processAiQueue();

    // Kirim data terupdate ke OBS / Client / Dashboard
    io.emit('update-queue', { currentSong, songQueue });
}


// ========================================================
// 🚀 INTEGRASI WEBSOCKET UNTUK AUTO CAPTION (FIX BENTROK)
// ========================================================
const { WebSocketServer } = require('ws');

// Tetap di port 8080 sesuai setingan awal file kamu brow
const captionWss = new WebSocketServer({ port: 8080, host: '0.0.0.0' });

captionWss.on('connection', (ws) => {
    console.log('🔗 [WS Caption] Koneksi baru terhubung (App/OBS)');
    ws.isAlive = true; // 🌟 Tambahan: Tandai koneksi baru sebagai aktif

    // 🌟 Tambahan: Handle respon balik (pong) dari browser/OBS
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (rawData) => {
        try {
            // Langsung lempar data mentah (rawData) ke semua client selain si pengirim
            captionWss.clients.forEach((client) => {
                if (client !== ws && client.readyState === 1) { // 1 = OPEN
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

// 🌟 Tambahan: Jalankan interval ping setiap 30 detik agar koneksi tidak idle/mati sendiri
setInterval(() => {
    captionWss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate(); // Putus paksa koneksi yang mati/beku

        ws.isAlive = false; // Set sementara ke false, nunggu direspon 'pong' oleh client
        ws.ping(); // Kirim sinyal detak jantung
    });
}, 30000);

console.log('⚡ WebSocket Caption Server berjalan di ws://localhost:8080');

//=====================================================
// SOKET INTERNET
//=====================================================
const si = require('systeminformation');
const WebSocket = require('ws');
const ping = require('ping');

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

// Bersih tanpa ada tulisan 'const path = ...' lagi di sini
app.get('/ai-control', (req, res) => {
    res.sendFile(path.join(__dirname, 'tools', 'ai-control.html'));
});
//=================================================
// --- KODE TESTER VVIP REQUEST ---
// Jalankan ini saat server baru nyala
//setTimeout(() => {
//  const testUsername = "yusripika"; // Ganti dengan username TikTok kamu
// giftRequestUsers.set(testUsername, { expire: Date.now() + (60 * 60 * 1000) }); // Tiket 1 jam
//console.log(` [DEBUG] User ${testUsername} sudah diset sebagai VVIP untuk testing.`);
//},// 5000);
// ------------------------


//===================================
// FUNGSI ALUR BACA AI (KEMBALI KE DEFAULT BROWSER)
//===================================
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

        // Kirim teks murni ke overlay.html
        io.emit('play-ai-tts', {
            text: responseText,
            mode: currentJob.mode
        });

        // Jeda antrean berdasarkan panjang kalimat biar gak tabrakan
        const estimatedDelay = Math.max(4000, responseText.length * 90);
        await new Promise(resolve => setTimeout(resolve, estimatedDelay));

    } catch (error) {
        console.error("❌ Error di Queue AI:", error);
    } finally {
        isAiProcessing = false;
        processAiQueue();
    }
}


/**-------------------WEBDEV---------------------
 * FUNGSI UTAMA KONEKSI TIKTOK
 ------------------------------------------------*/
function setupTikTokEvents(username, socket) {
    if (tiktokConnection) {
        tiktokConnection.removeAllListeners();
        tiktokConnection.disconnect();
    }

    tiktokConnection = new WebcastPushConnection(username, {
        processInitialData: false,
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

    // EVENT CHAT TIKTOK (SUDAH DIOPTIMASI)
    tiktokConnection.on('chat', async (data) => { // 🔥 Pastikan ada kata 'async' di sini brow!
        // Monitoring tetap jalan
        io.emit('new-chat-monitor', { user: data.uniqueId, nickname: data.nickname, message: data.comment, profilePictureUrl: data.profilePictureUrl });
        io.emit('chat', data);

        const pesan = (data.comment || "").trim();

        // =================================================================
        // 🧠 JALUR 1: FILTER SESI AI VOICE ASSISTANT (TTS) - HARUS DI ATAS!
        // =================================================================

        const cekKataGglobal = pesan.toLowerCase();

        // 🌟 JALUR LOKAL MANDIRI (Bisa langsung dipicu tanpa ketik 'webdev ')
        const keywordKreator = [
            'webdev siapa',
            'siapa webdev',
            'siapa yusrianto',
            'siapa lana',
            'siapa pencipta',
            'siapa pembuat',
            'siapa owner',
            'siapa developer',
            'siapa yang buat',
            'siapa yang bikin',
            'kreatornya siapa',
            'ownernya siapa',
            'aplikasi buatan siapa'
        ];

        const isNanyainKreator = keywordKreator.some(keyword => cekKataGglobal.includes(keyword));

        if (isNanyainKreator) {
            console.log(`🤖 [MODE TANYA LOKAL] Dari @${data.uniqueId}: ${pesan}`);

            io.emit('ai-log-monitor', {
                time: new Date().toLocaleTimeString('id-ID'),
                user: data.uniqueId,
                pesan: pesan,
                mode: 'tanya'
            });

            const jawabanLokal = "Aplikasi overlay stream WebDev ini diciptakan oleh Kak Yusrianto Lana. Jika Anda ingin menggunakan aplikasi ini, silakan kunjungi profil TikTok beliau. Kak Yusrianto sudah menyediakan aplikasi versi gratis sebelum Anda memutuskan untuk menggunakan versi pro.";
            console.log(`🤖 [JAWABAN LOKAL] -> ${jawabanLokal}`);

            aiQueue.push({
                isLocal: true,
                jawabanLokal: jawabanLokal,
                mode: 'tanya'
            });
            processAiQueue();
            return; // 🛑 Berhenti di sini
        }

        // A. CEK MODE TANYA JAWAB VIA GROQ API
        if (isTanyaJawabActive && cekKataGglobal.startsWith('#')) { // <--- Ganti 'webdev ' menjadi '#'
            const pertanyaan = pesan.slice(1).trim(); // <--- Potong 1 karakter saja (menghapus #)
            if (pertanyaan) {
                console.log(`🤖 [MODE TANYA GROQ] Dari @${data.uniqueId}: ${pertanyaan}`);

                io.emit('ai-log-monitor', {
                    time: new Date().toLocaleTimeString('id-ID'),
                    user: data.uniqueId,
                    pesan: pesan,
                    mode: 'tanya'
                });

                aiQueue.push({
                    isLocal: false,
                    // Tambahkan perintah batasan kalimat di akhir instruksi prompt
                    prompt: `Anda adalah asisten Live Streaming Web Developer yang cerdas, ahli coding, dan profesional. Jawablah dengan gaya yang sopan, ramah, jelas, padat, dan langsung ke intinya menggunakan bahasa Indonesia yang baik dan benar (gunakan kata 'Saya' dan 'Anda' atau 'Kak'). MAKSIMAL HANYA 2 KALIMAT SAJA DAN JANGAN BERTELE-TELE! Pertanyaan: ${pertanyaan}`,
                    mode: 'tanya'
                });
                processAiQueue();
            }
            return; // 🛑 STOP!
        }

        // B. CEK MODE SAHABAT CURHAT (Tetap pake awalan '* ')
        else if (isCurhatActive && pesan.startsWith('* ')) {
            const curhatan = pesan.slice(2).trim();
            if (curhatan) {
                console.log(`🎭 [MODE CURHAT] Dari @${data.uniqueId}: ${curhatan}`);

                io.emit('ai-log-monitor', {
                    time: new Date().toLocaleTimeString('id-ID'),
                    user: data.uniqueId,
                    pesan: pesan,
                    mode: 'curhat' // Diubah ke curhat biar sinkron dengan css warna di UI panel
                });

                aiQueue.push({
                    isLocal: false,
                    // FIX: Mengganti ${pertanyaan} menjadi ${curhatan} dan mode menjadi 'curhat'
                    prompt: `Anda adalah asisten Live Streaming yang empati, ramah, dan bersahabat. Dengarkan curhatan penonton berikut dan berikan tanggapan singkat, bijak, dan menenangkan dalam bahasa Indonesia. MAKSIMAL HANYA 2 KALIMAT SAJA DAN JANGAN BERTELE-TELE! Curhatan: ${curhatan}`,
                    mode: 'curhat'
                });
                processAiQueue();
            }
            return;
        }


        // =================================================================
        // 🎵 JALUR 2: LOGIKA ASLI REQUEST MUSIK LU (FIXED - ANTI DOUBLE)
        // =================================================================
        if (!pesan.toLowerCase().startsWith('!req ')) return;
        const query = pesan.slice(5).trim();
        if (!query) return;

        // 1. CEK STATUS VVIP (Privilege Global)
        const giftData = giftRequestUsers.get(data.uniqueId);
        const isVipUser = (giftData && giftData.expire > Date.now());

        if (isVipUser) {
            // JIKA VVIP: Cukup panggil fungsi ini saja! 
            // Urusan lagu masuk antrean depan dan suara AI khusus VVIP sudah dihandle otomatis di dalamnya.
            await tambahKeQueue(query, data.uniqueId, data.profilePictureUrl, true);
            giftRequestUsers.delete(data.uniqueId); // Tiket terpakai

            console.log(`👑 [VVIP PRIORITAS] "${query}" dari @${data.uniqueId} berhasil diproses.`);
            return; // 🛑 Berhenti di sini biar gak turun ke bawah
        }

        // 2. JIKA PENONTON BIASA (Mode Free)
        if (currentRequestMode === 'free') {
            // Cek kuota penonton
            let activeSongsCount = songQueue.filter(song => song.requestedBy === data.uniqueId).length;
            if (currentSong && currentSong.requestedBy === data.uniqueId) {
                activeSongsCount += 1;
            }

            // Jika kuota aman, lempar ke fungsi utama. Jangan buat aiQueue.push manual lagi di sini!
            if (activeSongsCount < maxRequestLimit) {
                await tambahKeQueue(query, data.uniqueId, data.profilePictureUrl, false);
                console.log(`🎵 [FREE REQUEST] "${query}" dari @${data.uniqueId} sukses dimasukkan.`);
            } else {
                console.log(`🚫 [KUOTA PENUH] @${data.uniqueId} ditolak.`);
            }
        }
        else if (currentRequestMode === 'gift') {
            io.emit('song-request-denied', {
                user: data.uniqueId,
                nickname: data.nickname,
                profilePictureUrl: data.profilePictureUrl,
                message: "Kirim gift terlebih dahulu untuk request lagu 🎁"
            });
            console.log(`🚫 [REQUEST DITOLAK] @${data.uniqueId} belum gift.`);
        }
    });

    // =================================================================
    // EVENT GIFT (SUDAH TERINTEGRASI JALUR CEPAT VVIP)
    // =================================================================
    tiktokConnection.on('gift', async (data) => { // Ditambahkan 'async' agar proses 'await tambahKeQueue' aman

        if (currentRequestMode === 'gift') {
            giftRequestUsers.set(data.uniqueId, {
                expire: Date.now() + (5 * 60 * 1000) // berlaku 5 menit
            });
            console.log(`🎁 ${data.uniqueId} mendapatkan 1 hak request lagu`);
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

        // 1. Emit untuk pemicu pindah scene otomatis
        io.emit("tiktok-gift-alert", {
            giftName: data.giftName,
            count: data.repeatCount
        });

        // 2. EMIT SINGLE: Kirim data gift ke overlay alert (Cukup jalankan 1 kali saja!)
        io.emit("new-gift", {
            user: data.uniqueId,
            nickname: data.nickname,
            profilePictureUrl: data.profilePictureUrl,
            giftName: data.giftName,
            count: data.repeatCount,
            giftIcon
        });

        // 3. Update data Top Gift global
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

        // 4. Cek Proteksi Karaoke
        if (isKaraokeModeActive) {
            console.log(`🔒 [BLOCKED] Request via GIFT dari ${data.uniqueId} ditolak (Mode Karaoke ON)`);
            return;
        }

        // 🔥 SETIAP ADA GIFT MASUK (BEBAS GIFT APA SAJA), BERIKAN TIKET VVIP AKTIF 5 MENIT
        giftRequestUsers.set(data.uniqueId, {
            expire: Date.now() + (5 * 60 * 1000) // Berlaku 5 menit untuk ngetik !req di chat biasa
        });
        console.log(`🎁 @${data.uniqueId} dapat 1 tiket VVIP! Silakan ketik di chat: !req judul lagu nama artis`);

        // 5. Jalur Antisipasi jika mereka mengetik langsung di kolom pesan gift TikTok
        const text = data.comment || "";
        if (text.toLowerCase().startsWith('!req ')) {
            const query = text.slice(5).trim(); // Murni ambil full teks tanpa ribet tanda strip (-)

            if (query) {
                console.log(`🎁 [GIFT DIRECT DETECTED] Memproses request langsung dari pesan gift: "${query}"`);

                // 🚀 Jalankan fungsi antrean cepat VVIP (Parameter ke-4 = true)
                await tambahKeQueue(query, data.uniqueId, data.profilePictureUrl, true);
                // Tambahkan ini di bawahnya untuk triggerr suara  AI:
                aiQueue.push({
                    isLocal: true,
                    jawabanLokal: `Waduh mantap Sultan ${data.uniqueId} kirim gift! Lagu ${query} langsung meluncur ke urutan pertama!`,
                    mode: 'tanya'
                });
                processAiQueue();

                // 🔥 Broadcast ke OBS biar langsung update urutan paling depan
                io.emit('update-queue', { currentSong, songQueue, songHistory });

                giftRequestUsers.delete(data.uniqueId); // Hapus tiket karena sudah sukses terpakai langsung

                console.log(`🔥 [GIFT VVIP DIRECT SUCCESS] "${query}" dari @${data.uniqueId} langsung menyalip ke urutan #1!`);
            } else {
                console.log(`❌ [GIFT REQ REJECTED] Pesan gift diawali !req tapi judul lagu kosong.`);
            }
        }
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
    // Listener untuk menerima update blacklist dari kontrol panel
    socket.on('change-blacklist-keywords', (keywords) => {
        blacklistKeywords = keywords;
        console.log("🛡️ Blacklist ter-update di server:", blacklistKeywords);

        // Opsional: Kirim balik ke semua kontrol panel yang aktif biar sinkron
        io.emit('sync-blacklist-keywords', blacklistKeywords);
    });

    // Saat ada kontrol panel baru yang connect, otomatis kirim data blacklist yang sudah ada
    socket.emit('sync-blacklist-keywords', blacklistKeywords);

    // HANDLER KHUSUS SONG REQUEST INDEPENDEN (Taruh di awal io.on connection)
    // 🔥 SINKRONKAN JUGA RIWAYAT SEJAK AWAL KONEK
    socket.emit('update-queue', { currentSong, songQueue, songHistory });
    socket.emit('sync-request-mode', currentRequestMode);

    // Di sini fungsi socket.on('get-brand-texts') lu yang kemarin aman ngebaca brandTexts global
    socket.emit('brand-texts-changed', brandTexts);

    // B. Nangkep data array utuh dari dashboard pas user klik ADD atau HAPUS
    socket.on('update-brand-texts', (newData) => {
        brandTexts = newData;

        // Gunakan writeFile (async) alih-alih writeFileSync
        fs.writeFile(filePath, JSON.stringify(brandTexts, null, 2), 'utf8', (err) => {
            if (err) {
                console.log("Gagal save brand text:", err);
            } else {
                console.log("Data brand text berhasil di-save di background");
            }
        });

        io.emit('brand-texts-changed', brandTexts);
    });


    // 1. Pas kontrol panel dibuka, langsung kirim status sakelar saat ini ke browser
    socket.emit('sync-ai-modes', { tanya: isTanyaJawabActive, curhat: isCurhatActive });

    // 2. Dengarkan perubahan sakelar yang diklik oleh user di browser luar
    socket.on('update-ai-modes', (data) => {
        isTanyaJawabActive = data.tanya;
        isCurhatActive = data.curhat;
        console.log(`🤖 [AI MODE UPDATE] Tanya: ${isTanyaJawabActive} | Curhat: ${isCurhatActive}`);

        // Broadcast balik ke semua halaman kontrol yang terbuka biar sinkron
        io.emit('sync-ai-modes', { tanya: isTanyaJawabActive, curhat: isCurhatActive });
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

    // Kirim angka kuota saat ini ke client yang baru connect agar UI-nya langsung sinkron
    socket.emit('sync-max-quota', maxRequestLimit);
    // LISTENER BARU: Menerima perubahan kuota dari tombol "Set" Dashboard Host
    socket.on('change-max-quota', (newLimit) => {
        maxRequestLimit = parseInt(newLimit);
        console.log(`[INFO] Batas kuota request per user diubah menjadi: ${maxRequestLimit}`);
        // Broadcast ke seluruh client (termasuk overlay) agar tahu batas kuota yang baru
        io.emit('sync-max-quota', maxRequestLimit);
    });

    //MUSIK PAS REQUEST PLAY mUSIK PILIHAN
    // 🔥 OPTIMASI: Fungsi internal untuk mencatat riwayat lagu ke array
    function catatKeRiwayat(lagu) {
        if (lagu) {
            songHistory.unshift(lagu); // Masukkan ke daftar paling atas riwayat
            if (songHistory.length > 10) {
                songHistory.pop(); // Batasi maksimal 10 lagu saja agar ram hemat
            }
        }
    }

    // MUSIK PAS REQUEST PLAY MUSIK PILIHAN MANUAL DARI ANTRIAN
    socket.on('play-request-song', (songId) => {
        console.log("▶ PLAY REQUEST MANUAL ID:", songId);
        const index = songQueue.findIndex(s => s.id === songId);
        if (index === -1) return;

        // Catat lagu lama ke riwayat sebelum diganti
        catatKeRiwayat(currentSong);

        const selectedSong = songQueue[index];
        songQueue.splice(index, 1);
        currentSong = selectedSong;

        console.log("🎵 Now Playing:", currentSong.title);
        // Kirim antrean lengkap dengan riwayat terbaru
        io.emit('update-queue', { currentSong, songQueue, songHistory });
    });

    // Trigger perintah play dan pause musik
    // Di server.js lu, pastikan ada baris io.emit ini
    socket.on('kontrol-musik', (aksi) => {
        console.log("Menerima perintah kontrol:", aksi);

        // INI YANG PENTING:
        // Kirim perintah ke semua client (termasuk overlay di OBS)
        io.emit('terima-kontrol', aksi);
    });

    // Di-trigger oleh Player OBS ketika lagu selesai diputar
    socket.on('next-song', () => {
        console.log("QUEUE SEBELUM:", songQueue.map(x => x.title));

        // Catat lagu lama ke riwayat sebelum dilempar ke lagu berikutnya
        if (currentSong) {
            catatKeRiwayat(currentSong);
        }

        currentSong = songQueue.length > 0 ? songQueue.shift() : null;

        console.log("CURRENT:", currentSong?.title);
        console.log("QUEUE SESUDAH:", songQueue.map(x => x.title));

        // FIX: Menyertakan songHistory agar dashboard/overlay tahu status player saat ini bersih
        io.emit('update-queue', { currentSong, songQueue, songHistory });
    });

    // Soket untuk next manual lagu dari dashboard
    socket.on('next-song-manual', () => {
        console.log("⏭️ Next song manual triggered");

        if (currentSong) {
            catatKeRiwayat(currentSong);
        }

        if (songQueue.length > 0) {
            currentSong = songQueue.shift();
        } else {
            currentSong = null;
        }
        io.emit('update-queue', { currentSong, songQueue, songHistory });
    });

    // soket untuk reset daftar lagu semua yg ada didaftar lagu
    socket.on('reset-queue', () => {
        console.log("🧹 Queue & History direset dari dashboard");
        songQueue = [];
        songHistory = []; // 🔥 Ikut bersihkan riwayatnya di sini, brow!
        currentSong = null;

        io.emit('update-queue', { currentSong, songQueue, songHistory });
    });

    // Hapus lagu tertentu dari queue
    socket.on('delete-song', (songId) => {
        console.log(`🗑️ Menghapus lagu ID: ${songId}`);
        songQueue = songQueue.filter(song => song.id !== songId);

        // 🔥 Tambahkan songHistory di emit ini
        io.emit('update-queue', { currentSong, songQueue, songHistory });
    });

    //SOKET UNTUK REQUEST MANUAL INPUT
    //SOKET UNTUK REQUEST MANUAL INPUT (FIXED BROW)
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

            // 2. Bungkus data sesuai dengan format yang diminta oleh overlay
            const newSongRequest = {
                id: Date.now(),
                title: topVideo.title,
                url: topVideo.url,
                youtubeId: topVideo.id,
                requestedBy: "HOST",
                userAvatar: "",
                vvip: false
            };

            // 3. LOGIKA MASUK PLAYER ATAU ANTRIAN PRIORITAS (FIXED - Menggunakan newSongRequest)
            let isMulaiDiputar = false;
            if (!currentSong) {
                currentSong = newSongRequest;
                isMulaiDiputar = true;
                console.log(`[PLAY OTOMATIS] Player kosong, memutar: ${topVideo.title}`);
            } else {
                songQueue.push(newSongRequest);
                console.log(`[ANTRE NORMAL] ${topVideo.title} masuk antrean belakang.`);
            }

            // 4. 📢 GO! MASUKKAN KE QUEUE AI TTS (FIXED - Menggunakan topVideo.title & requestedBy)
            const ucapanKece = [
                `Asik banget, thank you bro`,
                `Mantap nih, makasih ya kak`,
                `Gokil selera musiknya, thank you`,
                `Pilihan keren, makasih banyak`
            ];
            const randomUcapan = ucapanKece[Math.floor(Math.random() * ucapanKece.length)];

            // Masukkan ke antrean AI agar dibacakan berurutan
            aiQueue.push({
                isLocal: true, // Server langsung memakai teks buatan kita
                jawabanLokal: `${randomUcapan} ${newSongRequest.requestedBy}. Lagu ${topVideo.title} ${isMulaiDiputar ? 'langsung diputar ya!' : 'sudah masuk antrean ya!'}`,
                mode: 'tanya'
            });

            // Picu jalannya antrean AI
            processAiQueue();

            // Pastikan overlay selalu dapet data terbaru
            io.emit('update-queue', { currentSong, songQueue, songHistory });

            // 5. Emit opsional bawaan lu
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

    //================================================
    // SOKET SIMULASI JOIN
    //=================================================
    // Taruh di dalam blok io.on('connection', (socket) => { ... }) ya brow
    socket.on('simulateJoin', (data) => {
        console.log(`[SIMULASI JOIN] ${data.nickname} memicu overlay!`);

        // Ini kode kuncinya buat mancing join6.html jalan
        io.emit('new-join', data);
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
    // =============================================================
    // JALUR RELE REMOTE HIDDEN / SHOW OVERLAY
    // =============================================================
    socket.on('toggle-chat-visibility', (isVisible) => {
        // io.emit artinya server membroadcast ke SELURUH client, termasuk overlay!
        io.emit('toggle-chat-visibility', isVisible);
        console.log(`[REMOTE CONTROL] Status visibility dirubah ke: ${isVisible ? 'TAMPIL' : 'SEMBUNYI'}`);
    });

    socket.on('toggle-visibility', (isVisible) => {
        io.emit('toggle-chat-visibility', isVisible);
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

        // 🌟 UNTUK (Membersihkan antrean AI)
        aiQueue = [];
        isAiProcessing = false;

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

    // SINKRONKAN TOMBOL SIMULASI DENGAN OVERLAY
    socket.on('simulateGift', (data) => {
        console.log("🔥 Menyebarkan data simulasi gift dari dashboard ke overlay...");

        // 1. Tetap kirim ke overlay untuk animasi (yang sudah berhasil)
        io.emit('new-gift', data);

        // 2. 🔥 TAMBAHAN: Kirim juga sebagai teks chat agar masuk ke Dock Monitoring
        const mockChatGift = {
            uniqueId: data.uniqueId || 'tester_ganteng',
            nickname: data.nickname || 'Tester Ganteng',
            // Teks yang akan muncul di log dock chat kamu
            comment: `🎁 Mengirim Gift ${data.giftName} x${data.count || data.repeatCount || 1}`,
            profilePictureUrl: data.profilePictureUrl || 'https://www.w3schools.com/howto/img_avatar.png'
        };

        // Lempar ke event display-chat agar dock monitoring membacanya sebagai baris baru
        io.emit('display-chat', mockChatGift);
    });

});


/*SERVER STARTUP*/
const PORT = process.env.PORT || 3000;

// Mengunci ke 0.0.0.0 agar terhindar dari delay IPv6 4-detik di Electron
http.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server Berjalan di port ${PORT}\n🔗 Dashboard: http://127.0.0.1:${PORT}\n`);
});