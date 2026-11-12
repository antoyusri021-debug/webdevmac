const { parentPort } = require('worker_threads');
const { SMTCMonitor } = require('@coooookies/windows-smtc-monitor');

function thumbnailToDataUrl(thumbnail) {
    if (!thumbnail) return '';

    let buffer;

    if (Buffer.isBuffer(thumbnail)) {
        buffer = thumbnail;
    } else if (thumbnail instanceof Uint8Array) {
        buffer = Buffer.from(thumbnail);
    } else if (thumbnail.data && Array.isArray(thumbnail.data)) {
        buffer = Buffer.from(thumbnail.data);
    } else {
        return '';
    }

    if (!buffer.length) return '';

    let mime = 'image/jpeg';

    // Deteksi format gambar sederhana dari header file
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
        mime = 'image/png';
    } else if (buffer[0] === 0x47 && buffer[1] === 0x49) {
        mime = 'image/gif';
    } else if (buffer[0] === 0x52 && buffer[1] === 0x49) {
        mime = 'image/webp';
    }

    return `data:${mime};base64,${buffer.toString('base64')}`;
}


function kirimMediaSaatIni() {
    try {
        const session = SMTCMonitor.getCurrentMediaSession();

        if (!session) {
            parentPort.postMessage({
                active: false,
                isPlaying: false,
                title: '',
                artist: '',
                duration: 0,
                currentTime: 0
            });
            return;
        }

        const media = session.media || {};
        const playback = session.playback || {};
        const timeline = session.timeline || {};
        const artworkUrl = thumbnailToDataUrl(media.thumbnail);


        parentPort.postMessage({
            active: true,
            id: `windows:${session.sourceAppId || 'current'}`,
            sourceAppId: session.sourceAppId || '',
            title: media.title || '',
            artist: media.artist || '',
            album: media.albumTitle || '',
            artworkUrl,
            duration: Number(timeline.duration) || 0,
            currentTime: Number(timeline.position) || 0,
            isPlaying: playback.playbackStatus === 4
        });
    } catch (error) {
        parentPort.postMessage({
            active: false,
            error: error.message
        });
    }
}

const monitor = new SMTCMonitor();

// Perbarui saat judul, status, sesi, atau timeline berubah
monitor.on('session-media-changed', kirimMediaSaatIni);
monitor.on('session-playback-changed', kirimMediaSaatIni);
monitor.on('session-timeline-changed', kirimMediaSaatIni);
monitor.on('current-session-changed', kirimMediaSaatIni);
monitor.on('session-added', kirimMediaSaatIni);
monitor.on('session-removed', kirimMediaSaatIni);

// Polling ringan sebagai cadangan untuk posisi lagu
kirimMediaSaatIni();
setInterval(kirimMediaSaatIni, 1000);
