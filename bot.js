const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const http = require('http');
const https = require('https');

// Load configuration
const configPath = path.join(__dirname, 'config.json');
let config = {
    bot_phone_number: "8801611657757",
    social_links: {
        youtube: "https://youtube.com/@gomonhub",
        facebook: "https://www.facebook.com/gomonhub/",
        whatsapp_group: ""
    }
};

if (fs.existsSync(configPath)) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error('[CONFIG ERROR] Failed to parse config.json, using defaults.');
    }
}

let sock = null;
let currentQr = null;
let currentQrDataUrl = null;
let isConnected = false;
let currentPairingCode = null;

function getSessionKeyString() {
    try {
        const credsPath = path.join(__dirname, 'auth_session', 'creds.json');
        if (fs.existsSync(credsPath)) {
            const raw = fs.readFileSync(credsPath, 'utf8');
            return Buffer.from(raw).toString('base64');
        }
    } catch (_) {}
    return null;
}

function restoreSessionFromEnv() {
    const sessionDir = path.join(__dirname, 'auth_session');
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    const credsPath = path.join(sessionDir, 'creds.json');
    if (process.env.WHATSAPP_SESSION_DATA) {
        try {
            const rawJson = Buffer.from(process.env.WHATSAPP_SESSION_DATA.trim(), 'base64').toString('utf8');
            fs.writeFileSync(credsPath, rawJson, 'utf8');
            console.log('\n🔑 [PERMANENT SESSION RESTORED] Loaded credentials from WHATSAPP_SESSION_DATA env variable!\n');
        } catch (e) {
            console.error('[SESSION RESTORE ERROR] Could not decode WHATSAPP_SESSION_DATA:', e.message);
        }
    }
}

// Active chat conversation memory per sender
// senderPhone -> { lastActive: timestamp, greeted: boolean, history: [ { role: 'user' | 'model', parts: [{ text }] } ] }
const chatMemories = {};

function getChatMemory(senderPhone) {
    const now = Date.now();
    if (!chatMemories[senderPhone] || (now - chatMemories[senderPhone].lastActive > 30 * 60 * 1000)) {
        chatMemories[senderPhone] = {
            lastActive: now,
            greeted: false,
            history: []
        };
    }
    chatMemories[senderPhone].lastActive = now;
    return chatMemories[senderPhone];
}

function getSmartFallbackReply(userMessage, hasImage = false, senderPhone = null) {
    if (hasImage && !userMessage) {
        return `স্ক্রিনশটটি পেয়েছি ভাই! এটি নিয়ে কী সমস্যা বা কী জানতে চান একটু লিখে জানান, দেখছি।`;
    }
    const mem = senderPhone ? getChatMemory(senderPhone) : null;
    const alreadyGreeted = mem ? mem.greeted : false;

    const raw = (userMessage || '').trim().toLowerCase();
    const isSalam = /(?:সালাম|assalamu|salam|slm|আসসালামু)/i.test(raw);
    const asksFb = /(?:facebook|fb page|fb|ফেসবুক)/i.test(raw);
    const asksYt = /(?:youtube|yt channel|yt|ইউটিউব|ইউটিউবের)/i.test(raw);
    const asksTiktok = /(?:tiktok|টিকটক)/i.test(raw);
    const asksIg = /(?:instagram|insta|ig|ইনস্টা|ইন্সটা)/i.test(raw);
    const asksThreads = /(?:threads|থ্রেডস)/i.test(raw);

    const platformMentionsCount = [asksFb, asksYt, asksTiktok, asksIg, asksThreads].filter(Boolean).length;
    const asksAllSocial = /(?:sob|shob|সব|all).*(?:platform|link|লিংক|প্ল্যাটফর্ম|সোশ্যাল|social|media|গূলা|গুলা|গুলো)|(?:social|সোশ্যাল).*(?:link|লিংক)|(?:aksathe|একসাথে).*(?:link|লিংক|দিতে|দেও|দাও|problem)|(?:link|লিংক).*(?:aksathe|একসাথে)|(?:platform|প্ল্যাটফর্ম)/i.test(raw) || (platformMentionsCount >= 2);
    const isAngry = /(?:bainchod|mc|bc|madarchod|khankir|chutiya|বাইনচোদ|খানকির|চুদি|শালা|হারামি)/i.test(raw);
    const isScamAccusation = /(?:scam|scammer|স্ক্যাম|স্ক্যামার|fraud|প্রতারক|ভুয়া|ভুয়া|fake|চিটার|চোর|fack|baje org|org valo na|valo na|trust|bisshas|বিশ্বাস)/i.test(raw);

    const asksAccount = /(?:account|একাউন্ট|অ্যাকাউন্ট|খুলব কীভাবে|আইডি খুলব|register|সাইন আপ)/i.test(raw);
    const asksDeposit = /(?:deposit|ডিপোজিট|টাকা অ্যাড|ব্যালেন্স অ্যাড|টাকা ভরব|add money)/i.test(raw);
    const asksApp = /(?:app|অ্যাপ|apk|ইনস্টল|ইন্সটল)/i.test(raw);
    const asksLink = /(?:website|ওয়েবসাইট|ওয়েবসাইট|web link|সাইট লিংক|সাইট কোথায়|সাইট খুঁজে|কোথায় পাব)/i.test(raw) || (raw.includes('link') && !asksAllSocial && !asksFb && !asksYt && !asksTiktok && !asksIg && !asksThreads);
    const asksJoin = /(?:kivabe khelbo|কীভাবে খেলব|খেলব কীভাবে|খেলব কেমনে|join|কাস্টম|ম্যাচ কীভাবে|নিবন্ধন)/i.test(raw);
    const asksRoomId = /(?:room id|রুম আইডি|পাসওয়ার্ড|password|id pass|কখন পাব|ম্যাচ কখন|শুরু কখন)/i.test(raw);
    const asksFee = /(?:কত টাকা|ফি কত|এন্ট্রি ফি|entry fee|match fee|কতো টাকার ম্যাচ|টাকা লাগবে)/i.test(raw);
    const asksWithdraw = /(?:withdraw|উইথড্র|টাকা তুলব|ক্যাশআউট|উইথড্র কীভাবে|bkash|nagad|বিকাশ|নগদ)/i.test(raw);
    const asksRules = /(?:rules|নিয়ম|চিট|ব্যান নীতি)/i.test(raw);
    const isThanks = /(?:ধন্যবাদ|thanks|thx|tnx|shukriya|শুকরিয়া)/i.test(raw);
    const isHowAreYou = /(?:কেমন আছেন|kemon achen|bhalo achen|ভালো আছেন|kmn aso|kemon aso)/i.test(raw);
    const isDoing = /(?:ki koro|কী করো|কি করো|কি কর|ki korso)/i.test(raw);
    const isSure = /(?:sure|সিওর|শিওর)/i.test(raw);
    const asksWho = /(?:tmi k|tumi ke|apni ke|apni k|তুমি কে|আপনি কে|তমি ক|tmr porichoy|porichoy ki|পরিচয় কি|কে তুমি|ke tmi|ke tumi|কে আপনি|ke apni)/i.test(raw);
    const isHalaBanter = /(?:hur hla|hala|হালা|হালার|ভাগ|kire|কি রে)/i.test(raw);

    if (mem) mem.greeted = true;

    if (asksWho) {
        return `আমি GOMON HUB-এর অফিসিয়াল সাপোর্ট অ্যাডমিন ভাই! টুর্নামেন্ট, ম্যাচ বা ওয়েবসাইট নিয়ে যেকোনো হেল্প লাগলে বলেন, বুঝিয়ে দিচ্ছি।`;
    }

    if (isHalaBanter) {
        return `আরে ভাই কি হইছে? হালা বলেন কেন 😂 কোনো টুর্নামেন্ট বা ওয়েবসাইট নিয়ে সমস্যা হলে বলেন, সলভ করে দিচ্ছি!`;
    }

    if (isScamAccusation) {
        return `আরে না ভাই! GOMON HUB হলো ইউটিউবার Mr GOMON (@gomonhub)-এর অফিসিয়াল ও ১০০% বিশ্বস্ত গেমিং প্ল্যাটফর্ম। আমাদের ইউটিউব ও ফেসবুক পেজ ঘুরে দেখতে পারেন, শত শত প্লেয়ার নিয়মিত টুর্নামেন্ট খেলে সাথে সাথে উইথড্র পাচ্ছে। কোনো ফেক বা স্ক্যামের সুযোগ নেই ভাই ❤️`;
    }

    if (isAngry && asksAllSocial) {
        return `আরে ভাই রাগ করছেন কেন! এই যে আমাদের অফিসিয়াল সব প্ল্যাটফর্মের লিংক একসাথে:\n\n` +
            `🌐 Website: https://rb.gy/feuqry\n` +
            `📺 YouTube: https://www.youtube.com/@gomonhub\n` +
            `📺 2nd Channel: https://www.youtube.com/@mrgomonhub\n` +
            `🌐 Facebook: https://www.facebook.com/gomonhub\n` +
            `🎵 TikTok: https://www.tiktok.com/@gomon_hub\n` +
            `📸 Instagram: https://www.instagram.com/gomon_gamer\n` +
            `🧵 Threads: https://www.threads.net/@gomon_hub`;
    }

    if (asksAllSocial) {
        return `এই যে ভাই আমাদের অফিসিয়াল সব প্ল্যাটফর্ম ও সোশ্যাল মিডিয়ার লিংক একসাথে:\n\n` +
            `🌐 Website: https://rb.gy/feuqry\n` +
            `📺 YouTube: https://www.youtube.com/@gomonhub\n` +
            `📺 2nd Channel: https://www.youtube.com/@mrgomonhub\n` +
            `🌐 Facebook: https://www.facebook.com/gomonhub\n` +
            `🎵 TikTok: https://www.tiktok.com/@gomon_hub\n` +
            `📸 Instagram: https://www.instagram.com/gomon_gamer\n` +
            `🧵 Threads: https://www.threads.net/@gomon_hub`;
    }

    if (isAngry) {
        return `আরে ভাই রাগ করছেন কেন! বলেন কী সমস্যা বা কী দরকার, আমি এখনই সমাধান করে দিচ্ছি ভাই।`;
    }

    if (asksFb) {
        return `এই যে ভাই আমাদের অফিসিয়াল ফেসবুক পেজ:\nhttps://www.facebook.com/gomonhub`;
    }
    if (asksYt) {
        return `এই যে ভাই আমাদের অফিসিয়াল ইউটিউব চ্যানেল:\nhttps://www.youtube.com/@gomonhub`;
    }
    if (asksTiktok) {
        return `এই যে ভাই আমাদের অফিসিয়াল টিকটক অ্যাকাউন্ট:\nhttps://www.tiktok.com/@gomon_hub`;
    }
    if (asksIg) {
        return `এই যে ভাই আমাদের অফিসিয়াল ইনস্টাগ্রাম আইডি:\nhttps://www.instagram.com/gomon_gamer`;
    }
    if (asksThreads) {
        return `এই যে ভাই আমাদের থ্রেডস প্রোফাইল:\nhttps://www.threads.net/@gomon_hub`;
    }
    if (asksAccount) {
        return `আমাদের ওয়েবসাইটে (https://rb.gy/feuqry) ঢুকে 'Register' অপশনে গিয়ে নাম, মোবাইল নম্বর ও পাসওয়ার্ড দিলেই ১ মিনিটে অ্যাকাউন্ট তৈরি হয়ে যাবে ভাই।`;
    }
    if (asksDeposit) {
        return `সাইটের Wallet অপশনে গিয়ে 'Add Money'-তে ক্লিক করে বিকাশ বা নগদ নম্বরে সেন্ড মানি করে TrxID সাবমিট করলেই ব্যালেন্স যোগ হয়ে যাবে ভাই।`;
    }
    if (asksApp) {
        return `আমাদের ওয়েবসাইটটি ফোনে ক্রোম ব্রাউজার দিয়ে ওপেন করে মেনু থেকে 'Add to Home screen' বা 'Install App' করলেই অ্যাপের মতো ব্যবহার করতে পারবেন ভাই।`;
    }
    if (asksLink) {
        return `অবশ্যই ভাই! আমাদের অফিসিয়াল ওয়েবসাইট লিংক:\nOur tournament website 🖇️ https://rb.gy/feuqry`;
    }
    if (asksJoin) {
        return `আমাদের ওয়েবসাইটে গিয়ে একাউন্ট খুলে ওয়ালেটে টাকা অ্যাড করে 'Join' বাটনে ক্লিক করে ইন-গেম নাম ও ইউআইডি দিয়ে স্লট বুক করে ফেলুন ভাই।\nOur tournament website 🖇️ https://rb.gy/feuqry`;
    }
    if (asksRoomId) {
        return `ম্যাচ শুরু হওয়ার ৫ থেকে ১০ মিনিট আগে ওয়েবসাইটের ওই ম্যাচের পেজে সরাসরি কাস্টম রুম আইডি ও পাসওয়ার্ড দেখা যাবে ভাই।`;
    }
    if (asksFee) {
        return `আমাদের এখানে ফ্রি ম্যাচ ছাড়াও ১০, ২০, ৩০ ও ৫০ টাকার ম্যাচ থাকে ভাই। প্রতিটি ম্যাচের রিওয়ার্ড সাইটের ম্যাচ কার্ডে স্পষ্ট দেওয়া থাকে।`;
    }
    if (asksWithdraw) {
        return `ম্যাচ শেষ হলে উইনিং ব্যালেন্স সরাসরি বিকাশ বা নগদে উইথড্র দেওয়া যায় ভাই। ওয়ালেট সেকশন থেকে রিকোয়েস্ট দিলেই টাকা চলে যাবে।`;
    }
    if (asksRules) {
        return `আমাদের এখানে কোনো হ্যাক বা আনফেয়ার গেমপ্লে এলাউড না ভাই। ফেয়ার প্লে নিশ্চিত রাখতে আমরা সতর্ক থাকি।`;
    }
    if (isThanks) {
        return `ওয়েলকাম ভাই! যেকোনো প্রয়োজনে জানাবেন।`;
    }
    if (isDoing) {
        return `এই তো ভাই সাপোর্ট চ্যাটে আছি। বলেন কোনো সমস্যা বা হেল্প লাগবে?`;
    }
    if (isSure) {
        return `হ্যাঁ ভাই একদম সিওর! বলেন কী বিষয়?`;
    }
    if (isHowAreYou) {
        return isSalam ? `ওয়ালাইকুম আসসালাম ভাই! আলহামদুলিল্লাহ ভালো আছি। আপনার কী অবস্থা?` : `আলহামদুলিল্লাহ ভাই ভালো আছি। আপনি কেমন আছেন?`;
    }
    if (isSalam) {
        return `ওয়ালাইকুম আসসালাম ভাই! কোনো বিষয়ে হেল্প লাগলে বলেন।`;
    }
    const isInsisting = /(?:bolo|বলো|বল|please|প্লিজ|বলেন|bolte|kivave|কীভাবে|কিভাবে)/i.test(raw);
    if (isInsisting) {
        return `আরে ভাই সত্যি বলতে এটা নিয়ে আমার জানা নাই 😂 টুর্নামেন্ট, ম্যাচ বা ওয়েবসাইট নিয়ে কিছু জানার থাকলে বলেন দেখছি!`;
    }
    if (alreadyGreeted) {
        const casualReplies = [
            `জি ভাই বলেন, কী খবর?`,
            `আছি ভাই, বলেন কোনো হেল্প লাগবে?`,
            `হ্যাঁ ভাই বলেন, শুনতে পাচ্ছি।`,
            `বলেন ভাই, কীভাবে সাহায্য করতে পারি?`,
            `জি ভাই, কী বিষয় বলুন?`
        ];
        let chosen = casualReplies[Math.floor(Math.random() * casualReplies.length)];
        if (mem && mem.lastFallback && casualReplies.length > 1) {
            const nonRepeated = casualReplies.filter(r => r !== mem.lastFallback);
            chosen = nonRepeated[Math.floor(Math.random() * nonRepeated.length)];
        }
        if (mem) mem.lastFallback = chosen;
        return chosen;
    }
    return `জি ভাই বলেন, কী অবস্থা?`;
}

function requestGeminiApi(modelName, data, apiKey, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const cleanModel = (modelName || 'gemini-3.0-flash').replace(/^models\//, '');
        const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`,
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const json = JSON.parse(body);
                        const reply = json.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (reply) return resolve(reply.trim());
                    } catch (_) {}
                    return reject(new Error('Invalid JSON from Gemini'));
                } else {
                    console.warn(`⚠️ [GEMINI API ERROR HTTP ${res.statusCode} (${modelName})] ${body.slice(0, 180)}`);
                    const apiErr = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 140)}`);
                    apiErr.statusCode = res.statusCode;
                    return reject(apiErr);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            const timeoutErr = new Error(`Timeout after ${timeoutMs}ms`);
            timeoutErr.statusCode = 408;
            reject(timeoutErr);
        });
        req.on('error', err => reject(err));
        req.write(data);
        req.end();
    });
}

// Sanitizes and validates multi-turn conversation contents for Google Gemini API
// Ensures strict alternation (user -> model -> user) and valid start/end roles
function formatGeminiContents(history = [], currentParts = []) {
    const raw = [];
    if (Array.isArray(history)) {
        for (const item of history) {
            if (!item || !item.role || !Array.isArray(item.parts) || item.parts.length === 0) continue;
            const validParts = item.parts.filter(p => p && (p.text || p.inlineData));
            if (validParts.length > 0) {
                raw.push({ role: item.role === 'model' ? 'model' : 'user', parts: validParts });
            }
        }
    }

    const validCurrent = (currentParts || []).filter(p => p && (p.text || p.inlineData));
    if (validCurrent.length > 0) {
        raw.push({ role: 'user', parts: validCurrent });
    }

    // Must start with 'user'
    while (raw.length > 0 && raw[0].role !== 'user') {
        raw.shift();
    }

    // Strictly alternate roles; merge consecutive same-role turns
    const clean = [];
    for (const turn of raw) {
        if (clean.length === 0) {
            clean.push(turn);
        } else {
            const last = clean[clean.length - 1];
            if (last.role === turn.role) {
                last.parts = last.parts.concat(turn.parts);
            } else {
                clean.push(turn);
            }
        }
    }

    // Must end with 'user'
    while (clean.length > 0 && clean[clean.length - 1].role !== 'user') {
        clean.pop();
    }

    if (clean.length === 0) {
        clean.push({ role: 'user', parts: validCurrent.length > 0 ? validCurrent : [{ text: 'Hello' }] });
    }

    return clean;
}

// -------------------------------------------------------------
// Dynamic Multi-Key Pool & Round-Robin Load Balancer for Gemini
// -------------------------------------------------------------
let keyPoolIndex = 0;
const keyCooldowns = {}; // apiKey -> cooldownUntilTimestamp

function getGeminiApiKeyPool() {
    let currentConfig = config;
    try {
        if (fs.existsSync(configPath)) {
            currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (_) {}

    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || currentConfig.gemini_api_keys || currentConfig.gemini_api_key || config.gemini_api_keys || config.gemini_api_key || '';

    let rawKeys = [];
    if (Array.isArray(raw)) {
        rawKeys = raw;
    } else if (typeof raw === 'string') {
        rawKeys = raw.split(',');
    }

    return Array.from(new Set(rawKeys.map(k => (typeof k === 'string' ? k.trim() : '')).filter(Boolean)));
}

function getOrderedCandidateKeys() {
    const pool = getGeminiApiKeyPool();
    if (pool.length === 0) return [];

    const now = Date.now();
    const startIdx = keyPoolIndex % pool.length;
    keyPoolIndex = (keyPoolIndex + 1) % pool.length;

    const ordered = [];
    for (let i = 0; i < pool.length; i++) {
        ordered.push(pool[(startIdx + i) % pool.length]);
    }

    const available = ordered.filter(k => !keyCooldowns[k] || keyCooldowns[k] <= now);
    const coolingDown = ordered.filter(k => keyCooldowns[k] && keyCooldowns[k] > now);

    return available.length > 0 ? available.concat(coolingDown) : coolingDown;
}

// AI Customer Support Assistant Helper
async function generateAiSupportReply(userMessage, senderPhone, imageBase64 = null, mimeType = 'image/jpeg') {
    let knowledge = {};
    try {
        const kPath = path.join(__dirname, 'ai_knowledge.json');
        if (fs.existsSync(kPath)) {
            knowledge = JSON.parse(fs.readFileSync(kPath, 'utf8'));
        }
    } catch (_) {}

    let currentConfig = config;
    try {
        if (fs.existsSync(configPath)) {
            currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (_) {}

    const candidateKeys = getOrderedCandidateKeys();
    const primaryModel = process.env.GEMINI_MODEL || currentConfig.ai_model || config.ai_model || 'gemini-3-flash-preview';
    const secondaryModel = (primaryModel === 'gemini-3-flash-preview') ? 'gemini-3-pro-preview' : 'gemini-3-flash-preview';
    const tertiaryModel = 'gemini-2.5-pro';

    const mem = getChatMemory(senderPhone);

    if (candidateKeys.length === 0) {
        console.warn(`⚠️ [GEMINI] No API keys configured in GEMINI_API_KEYS or config.json. Using fallback.`);
        const fallback = getSmartFallbackReply(userMessage, !!imageBase64, senderPhone);
        mem.history.push({ role: 'user', parts: [{ text: userMessage || '[ছবি]' }] });
        mem.history.push({ role: 'model', parts: [{ text: fallback }] });
        mem.greeted = true;
        return fallback;
    }

    const systemPrompt = `You are a real human customer support admin for GOMON HUB Tournament on WhatsApp in Bangladesh. You are an actual Bangladeshi gamer guy chatting naturally with fellow gamers.

ABSOLUTE HUMAN RULES (NEVER BREAK THESE):
1. NEVER speak like an AI, a chatbot, or a corporate robot!
2. NEVER say "GOMON HUB সাপোর্ট টিমে আপনাকে স্বাগতম", "কীভাবে সাহায্য করতে পারি?", "আমাদের সাপোর্ট টিমে নক করুন" (YOU ARE THE SUPPORT ADMIN!).
3. NEVER repeat Salam in an active ongoing chat! If you already exchanged Salam or if it's mid-conversation, DO NOT say Salam again! Only say "ওয়ালাইকুম আসসালাম" if the user explicitly says Salam in this current message.
4. Keep replies short, natural, friendly, and straight to the point (1 to 2 lines maximum) just like a real person typing on WhatsApp.
5. Answer casual remarks & identity naturally:
   - "kmn aso" -> "আলহামদুলিল্লাহ ভাই ভালো, আপনার কী খবর?"
   - "ki koro" -> "এই তো ভাই সাপোর্ট চ্যাটে আছি। কোনো হেল্প লাগবে?"
   - "sure to?" -> "হ্যাঁ ভাই একদম সিওর! বলেন কী লাগবে?"
   - Identity ("tmi k?", "tumi ke?", "tmr porichoy ki?", "কে আপনি?"):
     Directly answer: "আমি GOMON HUB টুর্নামেন্টের অফিসিয়াল সাপোর্ট অ্যাডমিন ভাই! টুর্নামেন্ট, ম্যাচ বা ওয়েবসাইট নিয়ে যেকোনো হেল্প লাগলে বলেন।"
   - Gamer banter & slang ("Hur hla", "hala", "kire", "bhai"):
     Answer chill & friendly: "আরে ভাই কি হইছে? হালা বলেন কেন 😂 কোনো সমস্যা নাকি?"
   - Accusations & Doubts ("scammer", "fake", "tmr org valo na", "trust korina", "try korbo na", "fack"):
     Answer calm, friendly & reassuring: "আরে না ভাই! GOMON HUB হলো ইউটিউবার Mr GOMON (@gomonhub)-এর অফিসিয়াল ও ট্রাস্টেড প্ল্যাটফর্ম। আমাদের ইউটিউব/ফেসবুক দেখেন, শত শত প্লেয়ার রেগুলার ম্যাচ খেলে ইনস্ট্যান্ট উইথড্র পাচ্ছে। কোনো সন্দেহ থাকলে সাইট ঘুরে দেখতে পারেন ভাই ❤️"
6. Exact links & Guides (provide immediately whenever asked):
   - ALL PLATFORMS / ALL SOCIAL LINKS (when asked for "sob platform", "all links", "social links", "aksathe", or multiple platforms like fb, yt, tiktok, ig):
     Provide ALL official links together in one clean list:
     • Website: https://rb.gy/feuqry
     • YouTube: https://www.youtube.com/@gomonhub
     • 2nd Channel: https://www.youtube.com/@mrgomonhub
     • Facebook: https://www.facebook.com/gomonhub
     • TikTok: https://www.tiktok.com/@gomon_hub
     • Instagram: https://www.instagram.com/gomon_gamer
     • Threads: https://www.threads.net/@gomon_hub
   - Facebook page: https://www.facebook.com/gomonhub
   - YouTube channel: https://www.youtube.com/@gomonhub (Mr GOMON / GOMON GAMER)
   - 2nd YouTube: https://www.youtube.com/@mrgomonhub
   - TikTok: https://www.tiktok.com/@gomon_hub
   - Instagram (IG): https://www.instagram.com/gomon_gamer
   - Threads: https://www.threads.net/@gomon_hub
   - Tournament website / site link: Our tournament website 🖇️ https://rb.gy/feuqry
   - Account opening: Guide them to visit https://rb.gy/feuqry and click 'Register' with name, phone, password.
   - Deposit / Add Money: Guide them with 4 easy steps (1. Wallet > Add Money, 2. Send money to bKash/Nagad minimum 10 Tk, 3. Copy TrxID from SMS, 4. Submit TrxID on site to instantly add balance).
   - App install: Open site in Chrome mobile browser and click 'Install' or 'Add to Home Screen'.
   - Never spam the website link in general chit-chat unless relevant.
7. Screenshots & Images:
   - If user sends a screenshot of the website, bKash/Nagad receipt, or game screen, inspect what screen they are on or what error they face.
   - Tell them the exact next step directly like a helpful gamer brother so they can easily complete it.

Platform Knowledge Base:
${JSON.stringify(knowledge, null, 2)}`;

    const currentParts = [];
    if (imageBase64) {
        currentParts.push({
            inlineData: {
                mimeType: mimeType || 'image/jpeg',
                data: imageBase64
            }
        });
    }
    currentParts.push({
        text: userMessage || 'এই স্ক্রিনশট বা ছবিটি দেখে আমাকে সাহায্য করুন ভাই।'
    });

    // Sanitized multi-turn conversation contents
    const historySlice = mem.history.slice(-8);
    const contents = formatGeminiContents(historySlice, currentParts);

    const data = JSON.stringify({
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        contents,
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
    });

    let cleanReply = null;

    // Failover loop across candidate API keys
    for (let i = 0; i < candidateKeys.length; i++) {
        const activeKey = candidateKeys[i];
        const maskedKey = activeKey.length > 8 ? `${activeKey.slice(0, 4)}...${activeKey.slice(-4)}` : 'KEY';

        try {
            // 1. Try Primary Model (10s realistic timeout)
            cleanReply = await requestGeminiApi(primaryModel, data, activeKey, 10000);
            if (cleanReply) break;
        } catch (primaryErr) {
            if (primaryErr.statusCode === 429) {
                console.warn(`⚠️ [GEMINI 429 RATE LIMIT on Key ${maskedKey}] Putting key on 60s cooldown. Auto-failing over to next key in pool...`);
                keyCooldowns[activeKey] = Date.now() + 60000;
                continue;
            }

            console.warn(`⚠️ [GEMINI PRIMARY ERROR (${primaryModel}) Key ${maskedKey}] ${primaryErr.message}. Trying secondary model...`);
            try {
                // 2. Try Secondary Model (8s timeout)
                cleanReply = await requestGeminiApi(secondaryModel, data, activeKey, 8000);
                if (cleanReply) break;
            } catch (secErr) {
                if (secErr.statusCode === 429) {
                    console.warn(`⚠️ [GEMINI 429 RATE LIMIT (Sec) on Key ${maskedKey}] Putting key on 60s cooldown. Auto-failing over to next key...`);
                    keyCooldowns[activeKey] = Date.now() + 60000;
                    continue;
                }

                console.warn(`⚠️ [GEMINI SECONDARY ERROR (${secondaryModel}) Key ${maskedKey}] ${secErr.message}. Trying tertiary model...`);
                try {
                    // 3. Try Tertiary Model (6s timeout)
                    cleanReply = await requestGeminiApi(tertiaryModel, data, activeKey, 6000);
                    if (cleanReply) break;
                } catch (tertErr) {
                    if (tertErr.statusCode === 429) {
                        keyCooldowns[activeKey] = Date.now() + 60000;
                    }
                    console.warn(`⚠️ [GEMINI TERTIARY ERROR (${tertiaryModel}) Key ${maskedKey}] ${tertErr.message}.`);
                }
            }
        }
    }

    if (cleanReply) {
        mem.history.push({ role: 'user', parts: [{ text: userMessage || '[ছবি]' }] });
        mem.history.push({ role: 'model', parts: [{ text: cleanReply }] });
        mem.greeted = true;
        if (mem.history.length > 12) {
            mem.history = mem.history.slice(-10);
        }
        return cleanReply;
    }

    const fallback = getSmartFallbackReply(userMessage, !!imageBase64, senderPhone);
    mem.history.push({ role: 'user', parts: [{ text: userMessage || '[ছবি]' }] });
    mem.history.push({ role: 'model', parts: [{ text: fallback }] });
    mem.greeted = true;
    return fallback;
}

// Per-sender promise queue to strictly serialize rapid burst messages from the same user
// Prevents concurrent requests colliding on Gemini free tier quota (HTTP 429) and race conditions in chat memory.
const senderQueues = {};

function queueMessageForSender(senderPhone, fn) {
    if (!senderQueues[senderPhone]) {
        senderQueues[senderPhone] = Promise.resolve();
    }
    const nextPromise = senderQueues[senderPhone]
        .then(() => fn())
        .catch(err => {
            console.error(`❌ [QUEUE ERROR for ${senderPhone}]:`, err.message);
        });
    senderQueues[senderPhone] = nextPromise;
    nextPromise.finally(() => {
        if (senderQueues[senderPhone] === nextPromise) {
            delete senderQueues[senderPhone];
        }
    });
    return nextPromise;
}

const sentMessagesStore = new Map();
function storeSentMessage(id, message) {
    if (sentMessagesStore.size > 500) {
        const firstKey = sentMessagesStore.keys().next().value;
        sentMessagesStore.delete(firstKey);
    }
    sentMessagesStore.set(id, message);
}

async function startWhatsAppBot() {
    const sessionDir = path.join(__dirname, 'auth_session');
    restoreSessionFromEnv();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`\n======================================================`);
    console.log(`🤖 GOMONHUB WhatsApp AI Auto-Reply Bot starting...`);
    console.log(`📦 Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);
    console.log(`🌐 Web Dashboard & QR Link: http://localhost:3000`);
    console.log(`======================================================\n`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        getMessage: async (key) => {
            if (key && key.id && sentMessagesStore.has(key.id)) {
                return sentMessagesStore.get(key.id);
            }
            return { conversation: '' };
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQr = qr;
            isConnected = false;
            try {
                currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
            } catch (err) {
                console.error('[QR ERROR]', err.message);
            }
            console.log('\n📱 [QR CODE GENERATED] Please scan with WhatsApp or open web portal /qr:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log(`\n⚠️ Connection closed: ${lastDisconnect?.error?.message || 'Unknown'}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startWhatsAppBot, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQr = null;
            currentQrDataUrl = null;
            currentPairingCode = null;
            const sk = getSessionKeyString();
            const initialKeys = getGeminiApiKeyPool();
            console.log('\n✅ [WHATSAPP CONNECTED] Bot is active & listening 24/7!\n');
            console.log(`🔑 [GEMINI KEY POOL] ${initialKeys.length} active key(s) detected and ready for load balancing.`);
            if (sk) {
                console.log(`🔑 [PERMANENT SESSION KEY]: ${sk}\n`);
            }
        }
    });

    async function processSingleMessage(msg) {
        if (!msg || !msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

        const senderJid = msg.key.remoteJid;
        const senderPhone = senderJid.replace(/@.*$/, '');

        const imgMessage = msg.message.imageMessage ||
            msg.message.viewOnceMessage?.message?.imageMessage ||
            msg.message.viewOnceMessageV2?.message?.imageMessage ||
            msg.message.ephemeralMessage?.message?.imageMessage;

        const docImageMessage = (msg.message.documentMessage?.mimetype?.startsWith('image/'))
            ? msg.message.documentMessage
            : null;

        const effectiveImg = imgMessage || docImageMessage;

        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            effectiveImg?.caption ||
            ''
        ).trim();

        let imageBase64 = null;
        let imageMime = effectiveImg?.mimetype || 'image/jpeg';

        if (effectiveImg) {
            try {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );
                if (buffer && buffer.length > 0) {
                    imageBase64 = buffer.toString('base64');
                    console.log(`📸 [IMAGE RECEIVED & DOWNLOADED] From: ${senderPhone} | Size: ${(buffer.length / 1024).toFixed(1)} KB`);
                }
            } catch (mediaErr) {
                console.error(`⚠️ [MEDIA DOWNLOAD ERROR] ${mediaErr.message}`);
            }
        }

        if (!text && !imageBase64) return;

        // General conversation, greetings & queries handled by AI Support Agent
        console.log(`💬 [MESSAGE RECEIVED] From: ${senderPhone} | Text: "${text}" | HasImage: ${!!imageBase64}`);
        try {
            // Instantly notify user with typing presence so they know bot is online & responding
            sock.sendPresenceUpdate('composing', senderJid).catch(() => {});
            const aiReply = await generateAiSupportReply(text, senderPhone, imageBase64, imageMime);
            const sent = await sock.sendMessage(senderJid, { text: aiReply }, { quoted: msg });
            if (sent?.key?.id && sent?.message) {
                storeSentMessage(sent.key.id, sent.message);
            }
            console.log(`🤖 [AI SUPPORT REPLIED] To: ${senderPhone}`);
        } catch (aiErr) {
            console.error(`❌ [AI SUPPORT ERROR] ${aiErr.message}`);
            try {
                const fallbackText = `স্বাগতম GOMON HUB-এ।\nআপনার স্কিলই আপনার পরিচয়। সেরাদের সাথে লড়াই করে তৈরি করুন নিজের অবস্থান。\n\nOur tournament website 🖇️ https://rb.gy/feuqry`;
                const sentErr = await sock.sendMessage(senderJid, { text: fallbackText }, { quoted: msg });
                if (sentErr?.key?.id && sentErr?.message) {
                    storeSentMessage(sentErr.key.id, sentErr.message);
                }
            } catch (sendErr) {
                console.error(`❌ [SEND ERROR] ${sendErr.message}`);
            }
        } finally {
            sock.sendPresenceUpdate('paused', senderJid).catch(() => {});
        }
    }

    // Listen to incoming messages (handles multiple users simultaneously and queues bursts per user)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;
        for (const msg of messages) {
            if (!msg || !msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;
            const senderPhone = (msg.key.remoteJid || '').replace(/@.*$/, '');
            queueMessageForSender(senderPhone, () => processSingleMessage(msg));
        }
    });
}

// -------------------------------------------------------------
// Built-in Live Simulation Web Server (Port 3000)
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    // API: Bot Connection Status & Live QR
    if (parsedUrl.pathname === '/api/bot-status' && req.method === 'GET') {
        const sessionKey = getSessionKeyString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            connected: isConnected,
            hasQr: !!currentQrDataUrl,
            qrImage: currentQrDataUrl || null,
            pairingCode: currentPairingCode,
            sessionKey: isConnected ? sessionKey : null,
            botPhone: config.bot_phone_number
        }));
        return;
    }

    // API: Logout / Reset Session (Change Number)
    if (parsedUrl.pathname === '/api/bot-logout' && req.method === 'POST') {
        try {
            console.log('🔄 [LOGOUT REQUESTED] Clearing WhatsApp session for new number link...');
            if (sock) {
                try { await sock.logout(); } catch (_) { try { sock.end(); } catch (__) {} }
            }
            isConnected = false;
            currentQr = null;
            currentQrDataUrl = null;
            currentPairingCode = null;

            const sessionDir = path.join(__dirname, 'auth_session');
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Logged out. New QR code generating...' }));

            setTimeout(() => {
                startWhatsAppBot();
            }, 1500);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
    }

    // API: Request Pairing Code (Alternative to camera QR scan)
    if (parsedUrl.pathname === '/api/request-pairing' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body || '{}');
                let phone = (data.phone || config.bot_phone_number || '').replace(/\D/g, '');
                if (!phone.startsWith('88') && phone.startsWith('01')) {
                    phone = '88' + phone;
                }
                if (sock && !isConnected) {
                    const code = await sock.requestPairingCode(phone);
                    currentPairingCode = code;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, pairingCode: code }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        message: isConnected ? 'WhatsApp is already connected!' : 'Bot socket not ready yet. Please wait a few seconds.'
                    }));
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: err.message }));
            }
        });
        return;
    }

    // Dedicated QR Code & Pairing Web Interface
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/qr' || parsedUrl.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GOMON HUB - WhatsApp Bot Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 0%, #0f172a 0%, #020617 100%);
      font-family: 'Outfit', sans-serif;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .card {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(16px);
      width: 100%;
      max-width: 480px;
      border-radius: 24px;
      padding: 32px 24px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      text-align: center;
    }
    h1 { font-size: 1.5rem; font-weight: 800; margin-bottom: 8px; }
    p.sub { color: #94a3b8; font-size: 0.9rem; margin-bottom: 20px; line-height: 1.4; }
    .qr-container {
      background: #ffffff;
      padding: 16px;
      border-radius: 16px;
      display: inline-block;
      margin: 10px 0 16px 0;
      box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    }
    .qr-container img {
      width: 240px;
      height: 240px;
      display: block;
    }
    .instructions {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 14px;
      text-align: left;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-top: 14px;
      line-height: 1.6;
    }
    .instructions ol { padding-left: 20px; }
    .instructions li { margin-bottom: 4px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 700;
      margin-bottom: 14px;
    }
    .badge.waiting { background: rgba(234, 179, 8, 0.15); border: 1px solid rgba(234, 179, 8, 0.4); color: #facc15; }
    .badge.connected { background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.4); color: #4ade80; }
    .btn-action {
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      margin-top: 12px;
      transition: opacity 0.15s;
    }
    .btn-action:hover { opacity: 0.9; }
    .pairing-box {
      background: rgba(37, 99, 235, 0.1);
      border: 1px dashed #3b82f6;
      border-radius: 12px;
      padding: 14px;
      margin-top: 14px;
    }
    .pairing-code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.8rem;
      font-weight: 900;
      letter-spacing: 4px;
      color: #60a5fa;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="statusBadge" class="badge waiting">
      <span>●</span> অপেক্ষমাণ: ডিভাইস লিংক করুন
    </div>

    <!-- CONNECTED SCREEN -->
    <div id="viewConnected" style="display: none;">
      <div style="font-size: 3rem; margin-bottom: 10px;">✅</div>
      <h1 style="color: #4ade80;">WhatsApp বট সংযুক্ত!</h1>
      <p class="sub">বট এখন ২৪/৭ চালু আছে এবং AI কাস্টমার সাপোর্ট মেসেজ হ্যান্ডেল করতে প্রস্তুত।</p>
      <div class="instructions" style="text-align: center; margin-bottom: 16px;">
        📱 <b>বট নম্বর:</b> <span style="color: #38bdf8; font-weight: 800;">${config.bot_phone_number}</span><br>
        🚀 <b>সার্ভার স্ট্যাটাস:</b> ONLINE & 24/7 ACTIVE
      </div>

      <!-- PERMANENT AUTO-LOGIN KEY BOX -->
      <div style="background: rgba(34, 197, 94, 0.08); border: 1.5px dashed #22c55e; border-radius: 14px; padding: 16px; text-align: left; margin-bottom: 16px;">
        <div style="font-size: 0.85rem; color: #4ade80; font-weight: 800; display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
          <span>🔑</span> পার্মানেন্ট অটো-লগইন কি (Permanent Session Key)
        </div>
        <div style="font-size: 0.78rem; color: #94a3b8; line-height: 1.45; margin-bottom: 10px;">
          সার্ভার রিস্টার্ট হলেও যেন আর কখনো স্ক্যান না করতে হয়, তার জন্য নিচের কি-টি কপি করে Render-এর Environment-এ <b>WHATSAPP_SESSION_DATA</b> নামে বসিয়ে দিন।
        </div>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="sessionKeyBox" readonly style="flex: 1; background: #020617; border: 1px solid #334155; color: #38bdf8; font-family: monospace; font-size: 0.82rem; padding: 10px 12px; border-radius: 8px; outline: none;">
          <button onclick="copySessionKey()" id="btnCopyKey" style="background: #22c55e; color: #052e16; font-weight: 800; font-size: 0.85rem; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer;">কপি 📋</button>
        </div>
        <div id="copyAlert" style="display: none; color: #4ade80; font-size: 0.8rem; font-weight: 700; margin-top: 6px;">✓ Session Key কপি করা হয়েছে!</div>
      </div>

      <!-- CHANGE NUMBER / LOGOUT BUTTON -->
      <button onclick="changeNumberLogout()" id="btnLogout" style="width: 100%; padding: 12px; background: rgba(239, 68, 68, 0.12); border: 1.5px solid rgba(239, 68, 68, 0.4); color: #f87171; border-radius: 12px; font-size: 0.9rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
        <span>🔄</span> নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)
      </button>
    </div>

    <!-- NOT CONNECTED SCREEN -->
    <div id="viewScan">
      <h1>WhatsApp কানেক্ট করুন</h1>
      <p class="sub">আপনার <b>${config.bot_phone_number}</b> নম্বরের ফোন দিয়ে নিচের QR কোডটি স্ক্যান করুন:</p>

      <div class="qr-container">
        <div id="qrLoading" style="width: 240px; height: 240px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #475569; font-size: 0.85rem; font-weight: 600; text-align: center; padding: 16px;">
          <div style="width: 28px; height: 28px; border: 3px solid #cbd5e1; border-top-color: #2563eb; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px;"></div>
          QR কোড তৈরি হচ্ছে...<br><span style="font-size: 0.75rem; color: #64748b; margin-top: 4px;">কয়েক সেকেন্ড অপেক্ষা করুন</span>
        </div>
        <img id="qrImage" src="" alt="WhatsApp QR Code" style="display: none; width: 240px; height: 240px;">
      </div>

      <div class="instructions">
        <ol>
          <li>আপনার ফোনে WhatsApp ওপেন করুন।</li>
          <li>উপরের ৩টি ডট বা <b>Settings</b>-এ যান।</li>
          <li><b>Linked Devices</b> (লিংক করা ডিভাইস)-এ চাপ দিন।</li>
          <li><b>Link a Device</b> চাপ দিয়ে উপরের QR কোডটি স্ক্যান করুন।</li>
        </ol>
      </div>

      <div class="pairing-box">
        <div style="font-size: 0.85rem; color: #94a3b8; font-weight: 600;">অথবা ক্যামেরা স্ক্যান ছাড়া কোড দিয়ে লিংক করুন:</div>
        <button class="btn-action" onclick="getPairingCode()" id="btnPair">Pairing Code তৈরি করুন 🔑</button>
        <div id="pairingCodeDisplay" class="pairing-code" style="display: none;">------</div>
        <div id="pairingHelp" style="display: none; font-size: 0.78rem; color: #94a3b8; margin-top: 6px;">
          ফোনে "Link with phone number instead" সিলেক্ট করে এই কোডটি লিখুন।
        </div>
      </div>
    </div>
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/api/bot-status');
        const data = await res.json();
        if (data.connected) {
          document.getElementById('viewScan').style.display = 'none';
          document.getElementById('viewConnected').style.display = 'block';
          const b = document.getElementById('statusBadge');
          b.className = 'badge connected';
          b.innerHTML = '● WhatsApp কানেক্টেড';
          if (data.sessionKey) {
            document.getElementById('sessionKeyBox').value = data.sessionKey;
          }
        } else {
          document.getElementById('viewScan').style.display = 'block';
          document.getElementById('viewConnected').style.display = 'none';
          if (data.hasQr && data.qrImage) {
            const qrImg = document.getElementById('qrImage');
            qrImg.src = data.qrImage;
            qrImg.style.display = 'block';
            document.getElementById('qrLoading').style.display = 'none';
          } else {
            document.getElementById('qrImage').style.display = 'none';
            document.getElementById('qrLoading').style.display = 'flex';
          }
          if (data.pairingCode) {
            document.getElementById('pairingCodeDisplay').innerText = data.pairingCode;
            document.getElementById('pairingCodeDisplay').style.display = 'block';
            document.getElementById('pairingHelp').style.display = 'block';
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    function copySessionKey() {
      const box = document.getElementById('sessionKeyBox');
      box.select();
      navigator.clipboard.writeText(box.value).then(() => {
        document.getElementById('copyAlert').style.display = 'block';
        setTimeout(() => { document.getElementById('copyAlert').style.display = 'none'; }, 3000);
      });
    }

    async function changeNumberLogout() {
      if (!confirm('আপনি কি নিশ্চিত যে বর্তমান WhatsApp নম্বরটি ডিসকানেক্ট করে নতুন নম্বর দিয়ে স্ক্যান করতে চান?')) return;
      const btn = document.getElementById('btnLogout');
      btn.innerText = 'লগআউট হচ্ছে...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/bot-logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('সেশন ক্লিয়ার হয়েছে! এখন নতুন নম্বর দিয়ে স্ক্যান করতে পারবেন।');
          location.reload();
        } else {
          alert('এরর: ' + data.message);
          btn.innerText = '🔄 নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)';
          btn.disabled = false;
        }
      } catch (e) {
        alert('সার্ভার এরর: ' + e.message);
        btn.innerText = '🔄 নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)';
        btn.disabled = false;
      }
    }

    async function getPairingCode() {
      const btn = document.getElementById('btnPair');
      btn.innerText = 'কোড তৈরি হচ্ছে...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/request-pairing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: '${config.bot_phone_number}' })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('pairingCodeDisplay').innerText = data.pairingCode;
          document.getElementById('pairingCodeDisplay').style.display = 'block';
          document.getElementById('pairingHelp').style.display = 'block';
          btn.innerText = 'নতুন কোড পান 🔄';
          btn.disabled = false;
        } else {
          alert('বট সার্ভার সংযোগ তৈরি করছে। অনুগ্রহ করে ৫-১০ সেকেন্ড পর আবার চাপ দিন। (' + (data.message || 'Connecting') + ')');
          btn.innerText = 'Pairing Code তৈরি করুন 🔑';
          btn.disabled = false;
        }
      } catch (err) {
        alert('সার্ভার রিকানেক্ট হচ্ছে, দয়া করে একটু অপেক্ষা করে আবার চেষ্টা করুন।');
        btn.innerText = 'Pairing Code তৈরি করুন 🔑';
        btn.disabled = false;
      }
    }

    checkStatus();
    setInterval(checkStatus, 2500);
  </script>
</body>
</html>`);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [WEB DASHBOARD READY] Open in browser: http://localhost:${PORT}`);
    console.log(`🔗 [QR LINK & PAIRING PAGE]: http://localhost:${PORT}/qr`);
});

startWhatsAppBot();
