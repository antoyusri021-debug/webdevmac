const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

const app = express();
app.use((req, res, next) => {
    res.header(
        'Access-Control-Allow-Origin',
        '*'
    );
    res.header(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,DELETE,OPTIONS'
    );
    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept'
    );
    next();
});
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*'
    }
});

const PORT = process.env.YOUTUBE_PORT || 5001;

// ============================================================
// PATH
// ============================================================

const DATA_DIR = __dirname;

const TOKEN_FILE = path.join(
    DATA_DIR,
    'youtube-token.json'
);

// ============================================================
// STATE
// ============================================================

let oauth2Client = null;
let youtube = null;

let youtubeConnected = false;
let youtubeChatRunning = false;

let currentVideoId = null;
let currentLiveChatId = null;

let chatLoopRunning = false;
let nextPageToken = null;
// ============================================================
// BROWSER CAPTURE YOUTUBE
// ============================================================

let youtubeBrowserWindow = null;
let browserCaptureRunning = false;
let browserCaptureTimer = null;

let browserLastMessages = new Set();

// ============================================================
// EXPRESS
// ============================================================

app.use(express.json());

// ============================================================
// LOAD TOKEN
// ============================================================

function loadToken() {

    if (!fs.existsSync(TOKEN_FILE)) {
        console.log(
            'ℹ️ Token YouTube belum tersedia.'
        );

        return false;
    }

    try {

        const token = JSON.parse(
            fs.readFileSync(TOKEN_FILE, 'utf8')
        );

        oauth2Client.setCredentials(token);

        youtube = google.youtube({
            version: 'v3',
            auth: oauth2Client
        });

        youtubeConnected = true;

        console.log(
            '✅ Token YouTube berhasil dimuat.'
        );

        return true;

    } catch (error) {

        console.error(
            '❌ Gagal membaca token:',
            error.message
        );

        return false;
    }
}

// ============================================================
// SAVE TOKEN
// ============================================================

function saveToken(token) {

    fs.writeFileSync(
        TOKEN_FILE,
        JSON.stringify(token, null, 2),
        'utf8'
    );

    console.log(
        '💾 Token YouTube berhasil disimpan.'
    );
}

// ============================================================
// OAUTH LOGIN
// ============================================================

app.get('/auth/youtube', (req, res) => {

    if (!oauth2Client) {

        return res.status(500).send(
            'Google OAuth belum dikonfigurasi.'
        );
    }

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',

        scope: [
            'https://www.googleapis.com/auth/youtube.readonly'
        ]
    });

    res.redirect(authUrl);
});

// ============================================================
// OAUTH CALLBACK
// ============================================================

app.get('/oauth2callback', async (req, res) => {

    const code = req.query.code;

    if (!code) {
        return res.status(400).send(
            'Kode OAuth tidak ditemukan.'
        );
    }

    try {

        const { tokens } =
            await oauth2Client.getToken(code);

        oauth2Client.setCredentials(tokens);

        saveToken(tokens);

        youtube = google.youtube({
            version: 'v3',
            auth: oauth2Client
        });

        youtubeConnected = true;

        io.emit('youtube-status', {
            connected: true,
            chatRunning: false
        });

        res.send(`
            <html>
                <head>
                    <meta charset="UTF-8">
                    <title>YouTube Connected</title>
                </head>

                <body style="
                    background:#111;
                    color:white;
                    font-family:Arial;
                    text-align:center;
                    padding-top:100px;
                ">

                    <h1>✅ YouTube Berhasil Terhubung</h1>

                    <p>
                        Akun YouTube sudah berhasil
                        dihubungkan ke WebDev Overlay.
                    </p>

                    <p>
                        Kamu bisa menutup halaman ini.
                    </p>

                </body>
            </html>
        `);

    } catch (error) {

        console.error(
            '❌ OAuth YouTube gagal:',
            error.message
        );

        res.status(500).send(
            'OAuth YouTube gagal: ' +
            error.message
        );
    }
});

// ============================================================
// STATUS
// ============================================================

app.get('/api/youtube/status', (req, res) => {

    res.json({
        connected: youtubeConnected,
        chatRunning: youtubeChatRunning,
        browserCapture: browserCaptureRunning,
        videoId: currentVideoId,
        liveChatId: currentLiveChatId
    });

});

// ============================================================
// YOUTUBE LIVE DARI INPUT - BROWSER CAPTURE
// ============================================================

app.post('/api/youtube/live-from-input', async (req, res) => {

    try {

        const input =
            String(req.body?.input || '').trim();

        if (!input) {

            return res.status(400).json({

                success: false,

                message:
                    'Masukkan URL Live, Video ID, atau @Channel YouTube.'

            });
        }

        console.log(
            '🔎 Input YouTube Browser Capture:',
            input
        );

        // ====================================================
        // AMBIL VIDEO ID
        // ====================================================

        let videoId = null;

        // --------------------------------------------
        // Input langsung Video ID
        // --------------------------------------------

        if (
            /^[a-zA-Z0-9_-]{11}$/.test(input)
        ) {

            videoId = input;

        }

        // --------------------------------------------
        // Input URL YouTube
        // --------------------------------------------

        else {

            try {

                const url =
                    new URL(input);

                // youtu.be/VIDEO_ID
                if (
                    url.hostname.includes('youtu.be')
                ) {

                    videoId =
                        url.pathname
                            .replace('/', '')
                            .trim();

                }

                // youtube.com/watch?v=VIDEO_ID
                else if (
                    url.hostname.includes('youtube.com')
                ) {

                    videoId =
                        url.searchParams.get('v');

                }

            } catch (error) {

                // Bukan URL
            }

        }

        // ====================================================
        // VIDEO ID DITEMUKAN
        // ====================================================

        if (videoId) {

            console.log(
                '🎬 Video ID:',
                videoId
            );

            // --------------------------------------------
            // Mulai Browser Capture
            // --------------------------------------------

            startYouTubeBrowserCapture(
                videoId
            );

            youtubeConnected = true;

            currentVideoId =
                videoId;

            currentLiveChatId = null;

            youtubeChatRunning = true;

            io.emit(
                'youtube-status',
                {

                    connected: true,

                    chatRunning: true,

                    browserCapture: true,

                    videoId,

                    liveChatId: null

                }
            );

            return res.json({

                success: true,

                live: true,

                browserCapture: true,

                videoId,

                liveChatId: null,

                title:
                    'YouTube Live Browser Capture'

            });

        }



        // ====================================================
        // TIDAK DIKENALI
        // ====================================================

        return res.status(400).json({

            success: false,

            message:
                'Input YouTube tidak dikenali. Gunakan Video ID atau URL Live.'

        });

    } catch (error) {

        console.error(
            '❌ Browser Capture YouTube gagal:',
            error.message
        );

        return res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

});


// ============================================================
// YOUTUBE BROWSER CAPTURE
// ============================================================

function startYouTubeBrowserCapture(videoId) {

    if (!videoId) {

        throw new Error(
            'Video ID YouTube tidak ditemukan.'
        );
    }

    console.log('');
    console.log('🌐 MEMULAI YOUTUBE BROWSER CAPTURE');
    console.log('🎬 Video ID:', videoId);

    // Kalau browser sudah ada
    if (
        youtubeBrowserWindow &&
        !youtubeBrowserWindow.isDestroyed()
    ) {

        console.log(
            '♻️ Browser Capture sudah ada, memuat ulang...'
        );

        youtubeBrowserWindow.loadURL(
            `https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`
        );

        return;
    }

    browserCaptureRunning = true;

    browserLastMessages.clear();

    youtubeBrowserWindow = new BrowserWindow({

        width: 420,

        height: 700,

        show: false,

        title: 'WebDev YouTube Live Chat',

        webPreferences: {

            nodeIntegration: false,

            contextIsolation: true,

            sandbox: true

        }

    });

    youtubeBrowserWindow.loadURL(
        `https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`
    );

    youtubeBrowserWindow.webContents.on(
        'did-finish-load',
        () => {

            console.log(
                '🌐 YouTube Live Chat berhasil dimuat.'
            );

            startBrowserChatScanner();

        }
    );

    youtubeBrowserWindow.on(
        'closed',
        () => {

            console.log(
                '⏹️ YouTube Browser Capture ditutup.'
            );

            browserCaptureRunning = false;

            if (browserCaptureTimer) {

                clearInterval(
                    browserCaptureTimer
                );

                browserCaptureTimer = null;
            }

            youtubeBrowserWindow = null;

        }
    );
}


// ============================================================
// SCAN YOUTUBE LIVE CHAT
// ============================================================

function startBrowserChatScanner() {

    if (browserCaptureTimer) {

        clearInterval(
            browserCaptureTimer
        );
    }

    browserCaptureTimer = setInterval(
        async () => {

            if (
                !browserCaptureRunning ||
                !youtubeBrowserWindow ||
                youtubeBrowserWindow.isDestroyed()
            ) {

                return;
            }

            try {

                const messages =
                    await youtubeBrowserWindow.webContents
                        .executeJavaScript(`

                            (() => {

                                const result = [];

                                // ==========================
                                // CHAT NORMAL
                                // ==========================

                                document
                                    .querySelectorAll(
                                        'yt-live-chat-text-message-renderer'
                                    )
                                    .forEach(el => {

                                        const author =
                                            el.querySelector(
                                                '#author-name'
                                            )?.textContent?.trim() || '';

                                        const message =
                                            el.querySelector(
                                                '#message'
                                            )?.textContent?.trim() || '';

                                        const avatar =
                                            el.querySelector(
                                                '#img'
                                            )?.src || '';

                                        const id =
                                            el.getAttribute(
                                                'id'
                                            ) || '';

                                        if (
                                            author &&
                                            message
                                        ) {

                                            result.push({

                                                eventType: 'chat',

                                                id,

                                                username:
                                                    author,

                                                nickname:
                                                    author,

                                                message,

                                                profilePictureUrl:
                                                    avatar
                                            });
                                        }

                                    });


                                // ==========================
                                // SUPER CHAT
                                // ==========================

                                document
                                    .querySelectorAll(
                                        'yt-live-chat-paid-message-renderer'
                                    )
                                    .forEach(el => {

                                        const author =
                                            el.querySelector(
                                                '#author-name'
                                            )?.textContent?.trim() || '';

                                        const message =
                                            el.querySelector(
                                                '#message'
                                            )?.textContent?.trim() || '';

                                        const amount =
                                            el.querySelector(
                                                '#purchase-amount'
                                            )?.textContent?.trim() || '';

                                        const avatar =
                                            el.querySelector(
                                                '#img'
                                            )?.src || '';

                                        const id =
                                            el.getAttribute(
                                                'id'
                                            ) || '';

                                        if (author) {

                                            result.push({

                                                eventType:
                                                    'superchat',

                                                id,

                                                username:
                                                    author,

                                                nickname:
                                                    author,

                                                message,

                                                displayAmount:
                                                    amount,

                                                profilePictureUrl:
                                                    avatar
                                            });
                                        }

                                    });


                                // ==========================
                                // MEMBER
                                // ==========================

                                document
                                    .querySelectorAll(
                                        'yt-live-chat-membership-item-renderer'
                                    )
                                    .forEach(el => {

                                        const author =
                                            el.querySelector(
                                                '#author-name'
                                            )?.textContent?.trim() || '';

                                        const message =
                                            el.querySelector(
                                                '#message'
                                            )?.textContent?.trim() || '';

                                        const level =
                                            el.querySelector(
                                                '#header-subtext'
                                            )?.textContent?.trim() || '';

                                        const avatar =
                                            el.querySelector(
                                                '#img'
                                            )?.src || '';

                                        const id =
                                            el.getAttribute(
                                                'id'
                                            ) || '';

                                        if (author) {

                                            result.push({

                                                eventType:
                                                    'member',

                                                id,

                                                username:
                                                    author,

                                                nickname:
                                                    author,

                                                message,

                                                memberLevel:
                                                    level,

                                                profilePictureUrl:
                                                    avatar
                                            });
                                        }

                                    });


                                return result;

                            })();

                        `);

                if (!Array.isArray(messages)) {
                    return;
                }

                for (const item of messages) {

                    processBrowserYouTubeEvent(
                        item
                    );
                }

            } catch (error) {

                console.error(
                    '❌ Browser Capture Error:',
                    error.message
                );

            }

        },
        1000
    );
}


// ============================================================
// PROCESS BROWSER EVENT
// ============================================================

function processBrowserYouTubeEvent(item) {

    if (!item) {
        return;
    }

    const uniqueKey =
        [
            item.eventType,
            item.id,
            item.username,
            item.message,
            item.displayAmount,
            item.memberLevel
        ].join('|');

    // Jangan proses event yang sama
    if (
        browserLastMessages.has(uniqueKey)
    ) {

        return;
    }

    browserLastMessages.add(
        uniqueKey
    );

    // Batasi memory
    if (
        browserLastMessages.size > 1000
    ) {

        const first =
            browserLastMessages.values().next().value;

        browserLastMessages.delete(
            first
        );
    }

    const timestamp =
        Date.now();

    const messageId =
        'BROWSER-YT-' +
        timestamp +
        '-' +
        Math.random()
            .toString(36)
            .substring(2, 8);

    // ========================================================
    // CHAT
    // ========================================================

    if (
        item.eventType === 'chat'
    ) {

        const data = {

            platform: 'youtube',

            type: 'chat',

            username:
                item.username,

            nickname:
                item.nickname,

            message:
                item.message,

            profilePictureUrl:
                item.profilePictureUrl || '',

            timestamp,

            messageId
        };

        console.log(
            `💬 [YT BROWSER] ${item.username}: ${item.message}`
        );

        io.emit(
            'youtube-chat',
            data
        );

        io.emit(
            'youtube-event',
            data
        );

        return;
    }

    // ========================================================
    // SUPER CHAT
    // ========================================================

    if (
        item.eventType === 'superchat'
    ) {

        const data = {

            platform: 'youtube',

            type: 'superchat',

            username:
                item.username,

            nickname:
                item.nickname,

            message:
                item.message || '',

            amount: 0,

            amountMicros: 0,

            currency: '',

            displayAmount:
                item.displayAmount || '',

            profilePictureUrl:
                item.profilePictureUrl || '',

            timestamp,

            messageId
        };

        console.log(
            `💰 [YT BROWSER SUPERCHAT] ${item.username}: ${item.displayAmount}`
        );

        io.emit(
            'youtube-superchat',
            data
        );

        io.emit(
            'youtube-event',
            data
        );

        return;
    }

    // ========================================================
    // MEMBER
    // ========================================================

    if (
        item.eventType === 'member'
    ) {

        const data = {

            platform: 'youtube',

            type: 'member',

            username:
                item.username,

            nickname:
                item.nickname,

            message:
                item.message || '',

            memberLevel:
                item.memberLevel || '',

            profilePictureUrl:
                item.profilePictureUrl || '',

            timestamp,

            messageId
        };

        console.log(
            `⭐ [YT BROWSER MEMBER] ${item.username}`
        );

        io.emit(
            'youtube-member',
            data
        );

        io.emit(
            'youtube-event',
            data
        );

    }
}


// ============================================================
// STOP BROWSER CAPTURE
// ============================================================

function stopYouTubeBrowserCapture() {

    browserCaptureRunning = false;

    if (browserCaptureTimer) {

        clearInterval(
            browserCaptureTimer
        );

        browserCaptureTimer = null;
    }

    browserLastMessages.clear();

    if (
        youtubeBrowserWindow &&
        !youtubeBrowserWindow.isDestroyed()
    ) {

        youtubeBrowserWindow.close();
    }

    youtubeBrowserWindow = null;

    console.log(
        '⏹️ YouTube Browser Capture dihentikan.'
    );
}

// ============================================================
// START YOUTUBE CHAT
// ============================================================
async function startYouTubeChat() {

    // Jika Browser Capture sudah berjalan,
    // jangan jalankan API YouTube lagi.
    if (browserCaptureRunning) {

        console.log(
            '🌐 YouTube Browser Capture sudah berjalan.'
        );

        return;
    }

    if (!currentVideoId) {

        throw new Error(
            'Video ID YouTube belum dipilih.'
        );
    }

    console.log(
        '🌐 Memulai YouTube Chat melalui Browser Capture...'
    );

    startYouTubeBrowserCapture(
        currentVideoId
    );

    youtubeChatRunning = true;

    io.emit('youtube-status', {

        connected: true,

        chatRunning: true,

        browserCapture: true,

        videoId: currentVideoId

    });

    console.log(
        '✅ YouTube Chat menggunakan Browser Capture.'
    );
}

// ============================================================
// CHAT LOOP
// ============================================================

async function runChatLoop() {

    while (chatLoopRunning) {

        try {

            const response =
                await youtube.liveChatMessages.list({

                    liveChatId:
                        currentLiveChatId,

                    part: [
                        'snippet',
                        'authorDetails'
                    ],

                    maxResults: 200,

                    pageToken:
                        nextPageToken || undefined
                });

            const messages =
                response.data.items || [];

            nextPageToken =
                response.data.nextPageToken || null;

            for (const item of messages) {

                processYouTubeMessage(item);
            }

            const pollingInterval =
                response.data.pollingIntervalMillis || 5000;

            await sleep(
                pollingInterval
            );

        } catch (error) {

            console.error(
                '❌ YouTube Chat Error:',
                error.message
            );

            // Kalau live sudah selesai
            if (
                error.message.includes('liveChatEnded') ||
                error.message.includes('notFound')
            ) {

                console.log(
                    '🔴 YouTube Live sudah berakhir.'
                );

                stopYouTubeChat();

                break;
            }

            await sleep(5000);
        }
    }
}

// ============================================================
// PROCESS MESSAGE
// ============================================================

function processYouTubeMessage(item) {

    const snippet =
        item.snippet || {};

    const author =
        item.authorDetails || {};

    const username =
        author.displayName || 'YouTube User';

    const profilePictureUrl =
        author.profileImageUrl || '';

    const type =
        snippet.type;

    // ========================================================
    // CHAT
    // ========================================================

    if (
        type === 'textMessageEvent'
    ) {

        const message =
            snippet.textMessageDetails?.messageText ||
            '';

        const data = {

            platform: 'youtube',

            type: 'chat',

            username,

            nickname: username,

            message,

            profilePictureUrl,

            timestamp: Date.now(),

            messageId: item.id
        };

        console.log(
            `💬 [YT] ${username}: ${message}`
        );

        io.emit(
            'youtube-chat',
            data
        );

        io.emit(
            'youtube-event',
            data
        );
    }

    // ========================================================
    // SUPER CHAT
    // ========================================================

    else if (
        type === 'superChatEvent'
    ) {

        const details =
            snippet.superChatDetails || {};

        const amountMicros =
            Number(
                details.amountMicros || 0
            );

        const amount =
            amountMicros / 1000000;

        const currency =
            details.currency || '';

        const message =
            details.userComment || '';

        const data = {

            platform: 'youtube',

            type: 'superchat',

            username,

            nickname: username,

            message,

            amount,

            amountMicros,

            currency,

            displayAmount:
                details.amountDisplayString || '',

            profilePictureUrl,

            timestamp: Date.now(),

            messageId: item.id
        };

        console.log(
            `💰 [YT SUPERCHAT] ${username}: ${details.amountDisplayString || amount + ' ' + currency}`
        );

        io.emit(
            'youtube-superchat',
            data
        );

        io.emit(
            'youtube-event',
            data
        );
    }

    // ========================================================
    // MEMBER BARU
    // ========================================================

    else if (
        type === 'newSponsorEvent'
    ) {

        const details =
            snippet.newSponsorDetails || {};

        const data = {

            platform: 'youtube',

            type: 'member',

            username,

            nickname: username,

            message: '',

            memberLevel:
                details.memberLevelName || '',

            profilePictureUrl,

            timestamp: Date.now(),

            messageId: item.id
        };

        console.log(
            `⭐ [YT MEMBER] ${username}`
        );

        io.emit(
            'youtube-member',
            data
        );

        io.emit(
            'youtube-event',
            data
        );
    }

    // ========================================================
    // EVENT LAIN
    // ========================================================

    else {

        const data = {

            platform: 'youtube',

            type,

            username,

            nickname: username,

            message: '',

            profilePictureUrl,

            timestamp: Date.now(),

            messageId: item.id
        };

        io.emit(
            'youtube-event',
            data
        );
    }
}

// ============================================================
// STOP CHAT
// ============================================================

function stopYouTubeChat() {

    chatLoopRunning = false;

    youtubeChatRunning = false;

    currentVideoId = null;

    currentLiveChatId = null;

    nextPageToken = null;

    io.emit('youtube-status', {

        connected: youtubeConnected,

        chatRunning: false,

        videoId: null,

        liveChatId: null
    });

    console.log(
        '⏹️ YouTube Chat dihentikan.'
    );
}

// ============================================================
// DISCONNECT
// ============================================================

function disconnectYouTube() {

    stopYouTubeBrowserCapture();

    stopYouTubeChat();

    youtubeConnected = false;

    youtube = null;

    io.emit(
        'youtube-status',
        {
            connected: false,
            chatRunning: false
        }
    );

    console.log(
        '🔌 YouTube disconnected.'
    );
}

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', (socket) => {

    // ================== TEST SUPER CHAT ==================

    socket.on('test-youtube-superchat', (data) => {

        console.log(
            '🧪 [TEST YOUTUBE SUPER CHAT]',
            data
        );

        io.emit(
            'youtube-superchat',
            data
        );

    });

    // ================== TEST YOUTUBE MEMBER ==================

    socket.on('test-youtube-member', (data) => {

        console.log(
            '🧪 [TEST YOUTUBE MEMBER]',
            data
        );

        io.emit(
            'youtube-member',
            data
        );

    });

    console.log(
        '🔌 Client terhubung ke YouTube Server:',
        socket.id
    );

    socket.emit(
        'youtube-status',
        {
            connected:
                youtubeConnected,

            chatRunning:
                youtubeChatRunning,

            browserCapture:
                browserCaptureRunning,

            videoId:
                currentVideoId,

            liveChatId:
                currentLiveChatId
        }
    );

    // --------------------------------------------------------
    // CONNECT
    // --------------------------------------------------------

    socket.on(
        'youtube-connect',
        async () => {

            try {

                // Browser Capture tidak membutuhkan
                // youtube-client-secret.json atau OAuth Google.

                socket.emit(
                    'youtube-status',
                    {
                        connected: youtubeConnected,
                        chatRunning: youtubeChatRunning,
                        browserCapture: browserCaptureRunning,
                        videoId: currentVideoId,
                        liveChatId: currentLiveChatId
                    }
                );

            } catch (error) {

                socket.emit(
                    'youtube-error',
                    {
                        message: error.message
                    }
                );

            }
        }
    );

    // --------------------------------------------------------
    // START CHAT
    // --------------------------------------------------------

    socket.on(
        'youtube-start-chat',
        async () => {

            try {

                await startYouTubeChat();

            } catch (error) {

                console.error(
                    '❌ Start YouTube Chat:',
                    error.message
                );

                socket.emit(
                    'youtube-error',
                    {
                        message:
                            error.message
                    }
                );
            }
        }
    );

    // --------------------------------------------------------
    // STOP CHAT
    // --------------------------------------------------------

    socket.on(
        'youtube-stop-chat',
        () => {

            stopYouTubeChat();

            stopYouTubeBrowserCapture();
        }
    );

    // --------------------------------------------------------
    // DISCONNECT YOUTUBE
    // --------------------------------------------------------

    socket.on(
        'youtube-disconnect',
        () => {

            disconnectYouTube();
        }
    );

    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    socket.on(
        'youtube-refresh-status',
        () => {

            socket.emit(
                'youtube-status',
                {
                    connected:
                        youtubeConnected,

                    chatRunning:
                        youtubeChatRunning,

                    browserCapture:
                        browserCaptureRunning,

                    videoId:
                        currentVideoId,

                    liveChatId:
                        currentLiveChatId
                }
            );

        }
    );

    socket.on(
        'disconnect',
        () => {

            console.log(
                '❌ Client YouTube disconnect:',
                socket.id
            );
        }
    );
});

// ============================================================
// UTIL
// ============================================================

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(resolve, ms)
    );
}

// ============================================================
// INITIALIZE
// ============================================================

console.log('');
console.log('========================================');
console.log('      WEBDEV YOUTUBE BACKEND');
console.log('========================================');

if (fs.existsSync(TOKEN_FILE)) {
    loadToken();
}

// ============================================================
// START SERVER
// ============================================================

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log('');
        console.log(
            `🚀 YouTube Server berjalan di port ${PORT}`
        );

        console.log(
            `🔗 Status: http://127.0.0.1:${PORT}/api/youtube/status`
        );

        console.log(
            `🔐 Login: http://127.0.0.1:${PORT}/auth/youtube`
        );

        console.log('');
        console.log(
            '⚠️ TikTok server tetap menggunakan serve.js'
        );

        console.log(
            '========================================'
        );
    }
);