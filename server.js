const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = 'AIzaSyDOIArLbdnbUyEa6H4IuNIJztx4hjAqCVA';
const BOT_NAME = 'MyShopBot';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const KEYWORD_REPLIES = {
    'হ্যালো': 'আস্সালামুআলাইকুম! আমি ' + BOT_NAME + '। কীভাবে সাহায্য করতে পারি?',
    'hello': 'Hello! I am ' + BOT_NAME + '. How can I help you?',
    'hi': 'Hi there! How can I assist you today?',
    'price': 'দয়া করে পণ্যের ছবি পাঠান, আমি দাম জানিয়ে দেব।',
    'দাম': 'দয়া করে পণ্যের ছবি পাঠান, আমি দাম জানিয়ে দেব।',
    'link': 'দয়া করে product link পাঠান।',
};

async function getPriceFromLink(url) {
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const html = await response.text();
        const pricePatterns = [
            /৳\s*[\d,]+/g,
            /BDT\s*[\d,]+/gi,
            /\$\s*[\d,.]+/g,
            /"price":\s*"?([\d.]+)"?/gi,
            /price[^>]*>\s*([৳$]?\s*[\d,]+\.?\d*)/gi,
        ];
        for (const pattern of pricePatterns) {
            const matches = html.match(pattern);
            if (matches && matches.length > 0) {
                return `এই লিংকে মূল্য পাওয়া গেছে: ${matches[0]}`;
            }
        }
        const prompt = `এই HTML থেকে product এর নাম এবং দাম বের করো। শুধু product name এবং price বলো, বাংলায়। HTML: ${html.substring(0, 3000)}`;
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        return 'দুঃখিত, এই লিংক থেকে দাম বের করা সম্ভব হয়নি।';
    }
}

async function analyzeImage(imageBuffer, mimeType) {
    try {
        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: mimeType || 'image/jpeg',
            },
        };
        const prompt = `এই ছবিতে কী পণ্য দেখা যাচ্ছে? পণ্যটির:
1. নাম কী?
2. আনুমানিক বাজার মূল্য কত (বাংলাদেশে)?
3. মূল বৈশিষ্ট্য কী কী?

বাংলায় সংক্ষেপে উত্তর দাও।`;
        const result = await model.generateContent([prompt, imagePart]);
        return result.response.text();
    } catch (error) {
        console.error('Image analysis error:', error);
        return 'দুঃখিত, ছবিটি বিশ্লেষণ করা সম্ভব হয়নি। আবার চেষ্টা করুন।';
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
    const ms = Math.floor(Math.random() * 2000) + 2000;
    return delay(ms);
}

function extractURL(text) {
    const urlPattern = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlPattern);
    return matches ? matches[0] : null;
}

let botStartTime = null;
let botSocket = null;
let botEnabled = true;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    botSocket = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['MyShopBot', 'Chrome', '1.0.0'],
    });

    botSocket.ev.on('creds.update', saveCreds);

    botSocket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImage = await QRCode.toDataURL(qr);
            io.emit('qr', { qr: qrImage });
            console.log('QR code sent to dashboard');
        }

        if (connection === 'close') {
            const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
            io.emit('status', { connection: 'close', shouldReconnect: !isLoggedOut, loggedOut: isLoggedOut });
            const authExists = fs.existsSync(path.join(__dirname, 'auth_info'));
            if (!isLoggedOut && authExists) {
                setTimeout(() => startBot(), 3000);
            }
        } else if (connection === 'open') {
            botStartTime = new Date();
            io.emit('status', { connection: 'open' });
            console.log('\n✅ Bot চালু হয়েছে!');
        } else if (connection) {
            io.emit('status', { connection });
        }
    });

    const messagesHandler = async ({ messages, type }) => {
        if (type !== 'notify') return;
        if (!botEnabled) return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const jid = msg.key.remoteJid;
            const messageContent = msg.message;
            if (!messageContent) continue;

            try {
                if (messageContent.imageMessage) {
                    io.emit('message', { type: 'image', from: jid, status: 'processing' });
                    console.log(`📸 Image from: ${jid}`);

                    await botSocket.sendPresenceUpdate('composing', jid);
                    await randomDelay();

                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const mimeType = messageContent.imageMessage.mimetype || 'image/jpeg';
                    const reply = await analyzeImage(buffer, mimeType);

                    await botSocket.sendPresenceUpdate('paused', jid);
                    await botSocket.sendMessage(jid, { text: reply }, { quoted: msg });

                    io.emit('message', { type: 'image', from: jid, reply, status: 'done' });
                    console.log(`✅ Image reply sent`);
                }

                else if (messageContent.conversation || messageContent.extendedTextMessage) {
                    const text = messageContent.conversation ||
                        messageContent.extendedTextMessage?.text || '';
                    if (!text) continue;

                    console.log(`💬 Message: "${text}" from: ${jid}`);
                    io.emit('message', { type: 'text', from: jid, text, status: 'processing' });

                    await botSocket.sendPresenceUpdate('composing', jid);
                    await randomDelay();

                    let reply = null;
                    const url = extractURL(text);
                    if (url) {
                        reply = await getPriceFromLink(url);
                    }

                    if (!reply) {
                        const lowerText = text.toLowerCase();
                        for (const [keyword, response] of Object.entries(KEYWORD_REPLIES)) {
                            if (lowerText.includes(keyword.toLowerCase())) {
                                reply = response;
                                break;
                            }
                        }
                    }

                    if (!reply) {
                        reply = `আপনি লিখেছেন: "${text}"\n\nপণ্যের দাম জানতে:\n📸 ছবি পাঠান\n🔗 লিংক পাঠান`;
                    }

                    await botSocket.sendPresenceUpdate('paused', jid);
                    await botSocket.sendMessage(jid, { text: reply }, { quoted: msg });

                    io.emit('message', { type: 'text', from: jid, text, reply, status: 'done' });
                    console.log(`✅ Reply sent`);
                }
            } catch (err) {
                console.error('Message handle error:', err);
            }
        }
    };

    botSocket.ev.on('messages.upsert', messagesHandler);

    if (!io._listenersAttached) {
        io._listenersAttached = true;
        io.on('connection', (uiSocket) => {
            console.log('Dashboard connected:', uiSocket.id);
            uiSocket.emit('status', { connection: 'listening' });
            uiSocket.emit('bot-status', { enabled: botEnabled });
            if (botStartTime) {
                uiSocket.emit('status', { connection: 'open', startTime: botStartTime });
            }

            uiSocket.on('disconnect-bot', () => {
                botEnabled = false;
                console.log('Bot service disabled (WhatsApp session kept alive)');
                io.emit('bot-status', { enabled: false });
            });

            uiSocket.on('reconnect-bot', () => {
                botEnabled = true;
                console.log('Bot service enabled');
                io.emit('bot-status', { enabled: true });
            });

            uiSocket.on('disconnect-account', () => {
                console.log('Full account disconnect requested');
                const authPath = path.join(__dirname, 'auth_info');
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
                if (botSocket) {
                    botSocket.logout().catch(() => {});
                    botSocket = null;
                }
                botStartTime = null;
                botEnabled = true;
                io.emit('status', { connection: 'close', loggedOut: true, accountDisconnected: true });
                setTimeout(() => startBot(), 2000);
            });
        });
    }
}

const PORT = process.env.PORT || 3000;

startBot().catch(console.error);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`📱 Open this URL in your browser to control the bot\n`);
});
