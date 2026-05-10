/**-------------------WEBDEV---------------------
 * CORE MODULE SETUP
 ------------------------------------------------*/
const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const path = require('path');


app.use(express.static(__dirname));
app.use('/themes', express.static(path.join(__dirname, 'themes')));
app.use('/pages', express.static(path.join(__dirname, 'pages')));

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

    tiktokConnection.on('chat', (data) => {

        io.emit('new-chat-monitor', {
            user: data.uniqueId,
            nickname: data.nickname,
            message: data.comment,
            profilePictureUrl: data.profilePictureUrl
        });

        io.emit('chat', data);

    });

    // EVENT GIFT (LOGIKA GIFT ALERT & TOP GIFT)
    tiktokConnection.on('gift', (data) => {

        let giftIcon = null;

        // kemungkinan 1
        if (data.giftPictureUrl) {
            giftIcon = data.giftPictureUrl;
        }

        // kemungkinan 2
        else if (
            data.extendedGiftInfo &&
            data.extendedGiftInfo.icon &&
            data.extendedGiftInfo.icon.urls &&
            data.extendedGiftInfo.icon.urls.length > 0
        ) {
            giftIcon = data.extendedGiftInfo.icon.urls[0];
        }

        // kemungkinan 3
        else if (
            data.extendedGiftInfo &&
            data.extendedGiftInfo.icon &&
            data.extendedGiftInfo.icon.urlList &&
            data.extendedGiftInfo.icon.urlList.length > 0
        ) {
            giftIcon = data.extendedGiftInfo.icon.urlList[0];
        }

        // 1. Kirim ke Gift Alert (Monitor & Overlay)
        io.emit('new-gift', {
            user: data.uniqueId,
            nickname: data.nickname,
            giftName: data.giftName,
            count: data.repeatCount,
            giftIcon: giftIcon
        });

        if (!topGifts[data.uniqueId]) {
            topGifts[data.uniqueId] = {
                user: data.uniqueId,
                nickname: data.nickname,
                profilePic: data.profilePictureUrl,
                total: 0
            };
        }

        topGifts[data.uniqueId].total += data.repeatCount;

        let sortedSultans = Object.values(topGifts)
            .sort((a, b) => b.total - a.total)
            .slice(0, 5);

        io.emit('update-top-gift', sortedSultans);
        io.emit('gift', data);

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

    socket.on('test-all-milestones', () => {
        console.log("🧪 Menjalankan simulasi semua level milestone...");

        // Kirim sinyal reset ke client agar lastProcessedMilestone kembali ke awal
        io.emit('reset-milestone-client');

        const targets = [100, 500, 1000, 2500, 10000];

        targets.forEach((val, index) => {
            setTimeout(() => {
                console.log(`Simulasi Like: ${val}`);
                io.emit('like-stats', { totalLikeCount: val });
            }, index * 6000); // Jeda 6 detik agar animasi sebelumnya selesai
        });
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


/**
 * SERVER STARTUP
 */
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`\n🚀 Server Berjalan di port ${PORT}\n🔗 Dashboard: http://localhost:${PORT}\n`);
});
