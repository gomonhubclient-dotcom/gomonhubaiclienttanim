const { default: makeWASocket, useMultiFileAuthState, initAuthCreds, BufferJSON, proto, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const NodeCache = require('node-cache');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// --- AUTO-HEALING CONSOLE ERROR SHIELD ---
// Intercepts and silences internal libsignal decryption noise (e.g. Bad MAC, missing session)
// so stale/duplicate packet warnings do not pollute the terminal with alarming red crash logs.
const originalConsoleError = console.error;
console.error = function (...args) {
    const errorStr = args.map(a => (typeof a === 'string' ? a : (a?.stack || a?.message || String(a)))).join(' ');
    if (
        errorStr.includes('Bad MAC') ||
        errorStr.includes('Failed to decrypt message with any known session') ||
        errorStr.includes('Session error:Error: Bad MAC')
    ) {
        // Extract phone number if present in error and auto-purge corrupt keys
        const phoneMatch = errorStr.match(/(\d{8,15})/);
        if (phoneMatch && phoneMatch[1]) {
            purgeSenderCorruptedSession(phoneMatch[1] + '@s.whatsapp.net');
        }
        console.log('⚡ [AUTO-REPAIR] Handled out-of-sync packet safely. Cleared corrupt key for fresh handshake.');
        return;
    }
    originalConsoleError.apply(console, args);
};

// Global protection against unhandled rejections from libsignal async queue
process.on('unhandledRejection', (reason) => {
    const rStr = String(reason?.stack || reason?.message || reason);
    if (rStr.includes('Bad MAC') || rStr.includes('Session error')) {
        return; // Handled gracefully
    }
    originalConsoleError('[UNHANDLED REJECTION]', reason);
});

// Load configuration
const configPath = path.join(__dirname, 'config.json');
let config = {
    bot_phone_number: "8801349966049",
    backend_webhook_url: "http://127.0.0.1:8000/api/auth/whatsapp/confirm",
    social_links: {
        youtube: "https://youtube.com/@gomonhub?si=eAtg7YmxaFhg18m1",
        facebook: "https://www.facebook.com/gomonhub/",
        whatsapp_group: ""
    },
    messages: {
        success_verified: "✅ *আপনার GOMONHUB অ্যাকাউন্ট সফলভাবে ভেরিফাই হয়েছে!* 🎉\n\nটুর্নামেন্টের রুম আইডি, পাসওয়ার্ড ও লাইভ ম্যাচ আপডেট পেতে আমাদের সাথে যুক্ত থাকুন:\n\n📺 *YouTube (Subscribe):* {YOUTUBE_URL}\n🌐 *Facebook Page (Follow):* {FACEBOOK_URL}\n\n💡 এই নম্বরটি আপনার ফোনে সেভ (Save) করে রাখুন যাতে কোনো আপডেট মিস না হয়। ধন্যবাদ! 🎮🔥"
    }
};

if (fs.existsSync(configPath)) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error('[CONFIG ERROR] Failed to parse config.json, using defaults.');
    }
}

// Session isolation helpers
function getSessionName() {
    if (process.env.SESSION_NAME && process.env.SESSION_NAME.trim()) {
        return process.env.SESSION_NAME.trim();
    }
    if (config.session_name && config.session_name.trim()) {
        return config.session_name.trim();
    }
    const cleanClient = (config.client_id || config.platform_name || config.owner_name || config.bot_phone_number || 'mex_tanim')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_');
    return `session_${cleanClient}`;
}

function getSessionDir() {
    return path.join(__dirname, getSessionName());
}

// In-memory verification sessions
// sessionToken -> { phone, code, verified: false, expiresAt, senderPhone }
const pendingSessions = {};

let sock = null;
let currentQr = null;
let currentQrDataUrl = null;
let isConnected = false;
let currentPairingCode = null;
let botConnectTimestamp = 0;

// MongoDB Connection & Cloud Auth State References
let mongoClient = null;
let mongoDb = null;
let mongoCollection = null;
let currentAuthState = null;

/**
 * Connects to MongoDB Atlas cluster with automatic reconnection & pooling
 */
async function getMongoDBAuthCollection() {
    const mongoUri = process.env.MONGO_URI || config.mongo_uri;
    if (!mongoUri) return null;

    if (!mongoClient) {
        try {
            const dbName = process.env.MONGO_DB_NAME || config.mongo_db_name || 'whatsapp_bot';
            const collectionName = getSessionName();
            console.log(`🔄 [MONGODB] Connecting to MongoDB Atlas cluster for Baileys auth state (${dbName}.${collectionName})...`);
            mongoClient = new MongoClient(mongoUri, {
                serverSelectionTimeoutMS: 10000,
                connectTimeoutMS: 10000
            });
            await mongoClient.connect();
            mongoDb = mongoClient.db(dbName);
            mongoCollection = mongoDb.collection(collectionName);
            console.log(`✅ [MONGODB CONNECTED] Successfully connected to MongoDB Atlas (${dbName}.${collectionName})!`);
        } catch (err) {
            console.error('❌ [MONGODB CONNECTION FAILED]:', err.message);
            console.warn(`⚠️ [MONGODB] Falling back to local MultiFileAuthState (${getSessionName()}).`);
            mongoClient = null;
            mongoDb = null;
            mongoCollection = null;
            return null;
        }
    }
    return mongoCollection;
}

/**
 * Automatically purges corrupted/desynchronized Signal keys for a specific sender.
 * When Bad MAC or decryption failure occurs, deleting that sender's key forces
 * WhatsApp to re-negotiate a brand new PreKey handshake on their very next message.
 */
async function purgeSenderCorruptedSession(senderJid) {
    if (!senderJid) return;
    const cleanId = String(senderJid).replace(/@.*$/, '').replace(/[^0-9]/g, '');
    if (!cleanId || cleanId.length < 5) return;

    try {
        if (mongoCollection) {
            const result = await mongoCollection.deleteMany({
                _id: { $regex: cleanId }
            });
            if (result && result.deletedCount > 0) {
                console.log(`🧹 [AUTO-HEAL] Purged ${result.deletedCount} desynced session keys for +${cleanId} in MongoDB. WhatsApp will perform fresh handshake.`);
            }
        }
        const sessionDir = getSessionDir();
        if (fs.existsSync(sessionDir)) {
            const files = fs.readdirSync(sessionDir);
            for (const f of files) {
                if (f.includes(cleanId)) {
                    try { fs.unlinkSync(path.join(sessionDir, f)); } catch (_) {}
                }
            }
        }
    } catch (_) {
        // Silent graceful recovery
    }
}

/**
 * Custom MongoDB Auth State Adapter for Baileys
 * Handles real-time synchronization of credentials, pre-keys, and user sessions.
 * Automatically cleans up consumed one-time pre-keys.
 */
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        try {
            return await collection.replaceOne(
                { _id: id },
                {
                    _id: id,
                    value: JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
                    updatedAt: new Date()
                },
                { upsert: true }
            );
        } catch (err) {
            console.error(`⚠️ [MONGO AUTH WRITE ERROR] id: ${id}:`, err.message);
        }
    };

    const readData = async (id) => {
        try {
            const doc = await collection.findOne({ _id: id });
            if (!doc || !doc.value) return null;
            return JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver);
        } catch (err) {
            console.error(`⚠️ [MONGO AUTH READ ERROR] id: ${id}:`, err.message);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (err) {
            console.error(`⚠️ [MONGO AUTH DELETE ERROR] id: ${id}:`, err.message);
        }
    };

    let creds = await readData('creds');
    if (!creds) {
        if (process.env.WHATSAPP_SESSION_DATA && !sessionInvalidated) {
            try {
                const input = process.env.WHATSAPP_SESSION_DATA.trim();
                let jsonString = input.startsWith('{') && input.endsWith('}')
                    ? input
                    : Buffer.from(input, 'base64').toString('utf8');
                creds = JSON.parse(jsonString, BufferJSON.reviver);
                await writeData(creds, 'creds');
                console.log('\n🔑 [MONGO PERMANENT SESSION SEEDED] Loaded credentials from WHATSAPP_SESSION_DATA env into MongoDB!\n');
            } catch (e) {
                console.error('[MONGO SESSION RESTORE ERROR] Could not decode WHATSAPP_SESSION_DATA:', e.message);
                creds = initAuthCreds();
            }
        } else {
            creds = initAuthCreds();
        }
    }



    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    if (!ids || ids.length === 0) return data;
                    try {
                        const mongoIds = ids.map(id => `${type}-${id}`);
                        const docs = await collection.find({ _id: { $in: mongoIds } }).toArray();
                        const docMap = new Map();
                        for (const doc of docs) {
                            if (doc && doc.value) {
                                let val = JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver);
                                if (type === 'app-state-sync-key' && val) {
                                    val = proto.Message.AppStateSyncKeyData.fromObject(val);
                                }
                                docMap.set(doc._id, val);
                            }
                        }
                        for (const id of ids) {
                            data[id] = docMap.get(`${type}-${id}`) || null;
                        }
                    } catch (err) {
                        console.error(`⚠️ [MONGO AUTH BATCH READ ERROR] type: ${type}:`, err.message);
                    }
                    return data;
                },
                set: async (data) => {
                    const writes = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                writes.push({
                                    replaceOne: {
                                        filter: { _id: key },
                                        replacement: {
                                            _id: key,
                                            value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
                                            updatedAt: new Date()
                                        },
                                        upsert: true
                                    }
                                });
                            } else {
                                writes.push({
                                    deleteOne: {
                                        filter: { _id: key }
                                    }
                                });
                            }
                        }
                    }
                    if (writes.length > 0) {
                        try {
                            await collection.bulkWrite(writes, { ordered: false });
                        } catch (err) {
                            console.error(`⚠️ [MONGO AUTH BULK WRITE ERROR]:`, err.message);
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds'),
        clearAuth: async () => {
            try {
                await collection.deleteMany({});
                console.log('🗑️ [MONGO AUTH] Successfully cleared all session documents in MongoDB.');
            } catch (e) {
                console.error('⚠️ [MONGO AUTH CLEAR ERROR]:', e.message);
            }
        }
    };
}

function getSessionKeyString() {
    try {
        if (currentAuthState && currentAuthState.state && currentAuthState.state.creds) {
            const raw = JSON.stringify(currentAuthState.state.creds, BufferJSON.replacer);
            return Buffer.from(raw).toString('base64');
        }
        const credsPath = path.join(getSessionDir(), 'creds.json');
        if (fs.existsSync(credsPath)) {
            const raw = fs.readFileSync(credsPath, 'utf8');
            return Buffer.from(raw).toString('base64');
        }
    } catch (_) {}
    return null;
}

let sessionInvalidated = false;

function restoreSessionFromEnv() {
    if (sessionInvalidated) {
        console.warn('⚠️ [SESSION RESTORE SKIPPED] Session was invalidated/logged out. Generating fresh QR code.');
        return;
    }
    const sessionDir = getSessionDir();
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    const credsPath = path.join(sessionDir, 'creds.json');
    if (process.env.WHATSAPP_SESSION_DATA) {
        try {
            const input = process.env.WHATSAPP_SESSION_DATA.trim();
            let jsonString = '';
            if (input.startsWith('{') && input.endsWith('}')) {
                jsonString = input;
            } else {
                jsonString = Buffer.from(input, 'base64').toString('utf8');
            }
            // Verify valid JSON
            JSON.parse(jsonString);
            fs.writeFileSync(credsPath, jsonString, 'utf8');
            console.log('\n🔑 [PERMANENT SESSION RESTORED] Loaded credentials from WHATSAPP_SESSION_DATA env variable!\n');
        } catch (e) {
            console.error('[SESSION RESTORE ERROR] Could not decode WHATSAPP_SESSION_DATA:', e.message);
        }
    }
}

// Bot Active / Paused State (Tanim Owner Master Switch)
const stateFilePath = path.join(__dirname, 'bot_state.json');
let isBotPaused = false;
try {
    if (fs.existsSync(stateFilePath)) {
        const saved = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
        isBotPaused = !!saved.isBotPaused;
    }
} catch (_) {}

function setBotPaused(paused) {
    isBotPaused = paused;
    try {
        fs.writeFileSync(stateFilePath, JSON.stringify({ isBotPaused: paused }, null, 2), 'utf8');
    } catch (_) {}
}

// In-Memory Live Chat Stream Buffer (Zero-disk, stores latest 60 interactions for web monitor)
const liveChatLogs = [];
function addLiveChatMessage(entry) {
    try {
        liveChatLogs.unshift({
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            timestamp: Date.now(),
            ...entry
        });
        if (liveChatLogs.length > 60) {
            liveChatLogs.pop();
        }
    } catch (_) {}
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
        return `স্ক্রিনশটটি পেয়েছি ভাই! আপনি যে নম্বর থেকে টাকা পাঠিয়েছেন তার লাস্ট ডিজিট কত একটু জানান, আমি চেক করে কনফার্ম গ্রুপের লিংক দিয়ে দিচ্ছি ভাই।`;
    }
    const mem = senderPhone ? getChatMemory(senderPhone) : null;
    const alreadyGreeted = mem ? mem.greeted : false;

    const raw = (userMessage || '').trim().toLowerCase();
    const isSalam = /(?:সালাম|assalamu|salam|slm|আসসালামু)/i.test(raw);
    const asksDeveloper = /(?:developer|kew banayse|ke banayse|ke toiri korse|maker|who made|koder|coder|owner of bot|bot car|bot kar|developer ke|developer er|banise ke|toiri kar|ডেভেলপার|gomon hub|gomonhub|গোমন হাব)/i.test(raw);
    const asksBazi = /(?:bazi.*(?:khela|khelar|mane|kivave|kemon|kemne|dhore)|বাজি.*(?:খেলা|মানে|কেমনে|কীভাবে|ধরে|কাস্টম)|kivave.*bazi|কেমনে.*বাজি|bazi.*mane|বাজি.*mane|bazi.*dhore)/i.test(raw);
    const asksGomonTournament = /(?:gomon.*(?:tournament|website|site|ওয়েবসাইট|টুর্নামেন্ট|সাইট)|(?:tournament|website|site|ওয়েবসাইট|টুর্নামেন্ট|সাইট).*gomon|gomon hub er kichu nai|gomon er kichu nai|tournament gomon)/i.test(raw);
    const asksGomonFb = /(?:gomon|গোমন).*(?:fb|facebook|ফেসবুক)/i.test(raw);
    const asksGomonYt = /(?:gomon|গোমন).*(?:yt|youtube|ইউটিউব)/i.test(raw);
    const asksGomonTiktok = /(?:gomon|গোমন).*(?:tiktok|টিকটক)/i.test(raw);
    const asksGomonInsta = /(?:gomon|গোমন).*(?:insta|instagram|ইন্সটা|ইনস্টাগ্রাম)/i.test(raw);
    const asksGomonAllSocial = /(?:gomon|গোমন).*(?:all|sob|shob|সব|সোশ্যাল|social|লিংক|link)/i.test(raw);

    const asksFb = /(?:facebook|fb page|fb|ফেসবুক)/i.test(raw);
    const asksYt = /(?:youtube|yt channel|yt|ইউটিউব|ইউটিউবের)/i.test(raw);
    const asksTiktok = /(?:tiktok|টিকটক)/i.test(raw);
    const asksTg = /(?:telegram|tg|টেলিগ্রাম)/i.test(raw);
    const asksDiscord = /(?:discord|ডিসকর্ড)/i.test(raw);
    const asksWaChannel = /(?:whatsapp channel|wa channel|চ্যানেল|channel)/i.test(raw);

    const platformMentionsCount = [asksFb, asksYt, asksTiktok, asksTg, asksDiscord, asksWaChannel].filter(Boolean).length;
    const asksAllSocial = /(?:sob|shob|সব|all).*(?:platform|link|লিংক|প্ল্যাটফর্ম|সোশ্যাল|social|media|গূলা|গুলা|গুলো)|(?:platform|link|লিংক|সোশ্যাল|social).*(?:sob|shob|সব|all)|(?:social|সোশ্যাল).*(?:link|লিংক)|(?:aksathe|একসাথে).*(?:link|লিংক|দিতে|দেও|দাও|problem)|(?:link|লিংক).*(?:aksathe|একসাথে)|(?:platform|প্ল্যাটফর্ম)/i.test(raw) || (platformMentionsCount >= 2);
    const isAngry = /(?:bainchod|mc|bc|madarchod|khankir|chutiya|বাইনচোদ|খানকির|চুদি|শালা|হারামি)/i.test(raw);
    const isScamAccusation = /(?:scam|scammer|স্ক্যাম|স্ক্যামার|fraud|প্রতারক|ভুয়া|ভুয়া|fake|চিটার|চোর|fack|baje org|org valo na|valo na|trust|bisshas|বিশ্বাস)/i.test(raw);

    const asksPayment = /(?:payment|taka pathabo|send money|bkash|nagad|rocket|বিকাশ|নগদ|রকেট|টাকা পাঠাব|টাকা কীভাবে|টাকা কেমনে|পেমেন্ট মেথড|payment method|slot booking|স্লট|slot|number|নম্বর|টাকা দেওয়ার|টাকা দিব)/i.test(raw);
    const asksRules = /(?:rules|নিয়ম|চিট|ব্যান নীতি|notice|নোটিশ)/i.test(raw);
    const isThanks = /(?:ধন্যবাদ|thanks|thx|tnx|shukriya|শুকরিয়া)/i.test(raw);
    const isHowAreYou = /(?:কেমন আছেন|kemon achen|bhalo achen|ভালো আছেন|kmn aso|kemon aso)/i.test(raw);
    const isDoing = /(?:ki koro|কী করো|কি করো|কি কর|ki korso)/i.test(raw);
    const isSure = /(?:sure|সিওর|শিওর)/i.test(raw);
    const asksWho = /(?:tmi k|tumi ke|apni ke|apni k|তুমি কে|আপনি কে|তমি ক|tmr porichoy|porichoy ki|পরিচয় কি|কে তুমি|ke tmi|ke tumi|কে আপনি|ke apni)/i.test(raw);
    const isHalaBanter = /(?:hur hla|hala|হালা|হালার|ভাগ|kire|কি রে)/i.test(raw);

    if (mem) mem.greeted = true;

    // GOMON HUB Bazi / Custom Match explanation
    if (asksBazi) {
        return `মানে একদম সিম্পল ভাই! আপনারা ফ্রেন্ডরা বা অপোনেন্টের সাথে নিজেদের ইচ্ছামতো টাকা ধরে ১v১ বা স্কোয়াড কাস্টম চ্যালেঞ্জ খেলতে পারবেন।\n\n` +
            `নরমালি কী হয়? বাজি খেলে জিতলে অনেক সময় অপোনেন্ট টাকা না দিয়ে ব্লক মেরে ভেগে যায়, তাই না? 😂 কিন্তু এই ওয়েবসাইটে সেই বাটপারি বা স্ক্যামের কোনো সুযোগই নাই!\n\n` +
            `আপনি কত টাকার ম্যাচ খেলবেন (যেমন ৫০৳ বা ১০০৳) সেটা সেট করে ম্যাচ বানিয়ে রাখবেন। অপোনেন্টও সেই টাকা ডিপোজিট করে আপনার ম্যাচে ঢুকবে। খেলা শেষে যে জিতবে, ওয়েবসাইটের সিস্টেম অটোমেটিক পুরো প্রাইজমানি তার অ্যাকাউন্টে পাঠিয়ে দেবে! কোনো চিটিং বা টাকা মারার ভয়ই নেই ভাই।\n\n` +
            `Chrome-এ ‘GOMON HUB TOURNAMENT’ লিখে বা লিংকে গিয়ে নিজেই দেখে আসতে পারেন: https://rb.gy/feuqry ❤️`;
    }

    // GOMON HUB Specific Social Media Queries
    if (asksGomonAllSocial) {
        return `এই যে ভাই GOMON HUB-এর অফিসিয়াল সব সোশ্যাল মিডিয়া ও প্ল্যাটফর্মের লিংক:\n\n` +
            `🎮 Tournament Site: https://rb.gy/feuqry (Chrome-এ ‘GOMON HUB TOURNAMENT’ লিখেও পাবেন)\n` +
            `📺 YouTube: https://www.youtube.com/@gomonhub\n` +
            `📺 2nd Channel: https://www.youtube.com/@mrgomonhub\n` +
            `🌐 Facebook: https://www.facebook.com/gomonhub\n` +
            `🎵 TikTok: https://www.tiktok.com/@gomon_hub\n` +
            `📸 Instagram: https://www.instagram.com/gomon_gamer\n` +
            `🧵 Threads: https://www.threads.net/@gomon_hub\n\n` +
            `যেকোনো প্রয়োজনে যুক্ত থাকতে পারেন ভাই ❤️`;
    }
    if (asksGomonYt) {
        return `এই যে ভাই GOMON HUB-এর অফিসিয়াল ইউটিউব চ্যানেল:\nMain Channel: https://www.youtube.com/@gomonhub\n2nd Channel: https://www.youtube.com/@mrgomonhub`;
    }
    if (asksGomonFb) {
        return `এই যে ভাই GOMON HUB-এর অফিসিয়াল ফেসবুক পেজ:\nhttps://www.facebook.com/gomonhub`;
    }
    if (asksGomonTiktok) {
        return `এই যে ভাই GOMON HUB-এর অফিসিয়াল টিকটক আইডি:\nhttps://www.tiktok.com/@gomon_hub`;
    }
    if (asksGomonInsta) {
        return `এই যে ভাই GOMON HUB-এর অফিসিয়াল ইন্সটাগ্রাম আইডি:\nhttps://www.instagram.com/gomon_gamer`;
    }

    // GOMON HUB Tournament Website direct inquiry
    if (asksGomonTournament) {
        return `আরে ভাই GOMON HUB-এর একটা অস্থির ফ্রি ফায়ার টুর্নামেন্ট ওয়েবসাইট আছে! Chrome-এ ‘GOMON HUB TOURNAMENT’ লিখে সার্চ দিলেই পেয়ে যাবেন (বা সরাসরি লিংক: https://rb.gy/feuqry) 🎮\n\n` +
            `সাইটটা একদম সেই লেভেলের ভাই! নিজেদের ইচ্ছামতো বাজি ধরে ১v১ বা স্কোয়াড কাস্টম ম্যাচ বানিয়ে ফ্রেন্ডদের সাথে খেলা যায়, ব্যালেন্স অ্যাড ও উইথড্র পুরো অটো। আর সবচেয়ে জোস বিষয় হলো রেফার করলে প্রতি ফ্রেন্ডে ৫ টাকা বোনাস পাওয়া যায়! হ্যাকার বা স্ক্যামের কোনো চান্সই নাই, ফুল সেফ ২-স্টেপ ভেরিফিকেশন দেওয়া। এমনকি সামনে সম্পূর্ণ ফ্রিতেও টুর্নামেন্ট আনবে ভাই! একবার ঢুকে দেখতে পারেন ❤️`;
    }

    // Developer inquiry mode (Friendly GOMON HUB pitch + Free Fire tournament website + WhatsApp bot policy)
    if (asksDeveloper) {
        return `এই বটটি ডেভেলপ করেছে GOMON HUB (Mr GOMON ভাই)! 🎮\n\n` +
            `উনাদের নিজস্ব দারুণ একটি ফ্রি ফায়ার টুর্নামেন্ট ওয়েবসাইটও রয়েছে: https://rb.gy/feuqry (Chrome-এ 'GOMON HUB TOURNAMENT' লিখেও পাবেন) 🔥 যেখানে নিজেদের ইচ্ছামতো বাজি ধরে ১v১ বা স্কোয়াড কাস্টম খেলা যায় এবং প্রতি রেফারে ৫ টাকা বোনাস পাওয়া যায়!\n\n` +
            `পাশাপাশি আপনিও কি আপনার নিজস্ব যেকোনো ধরণের বিজনেস, অনলাইন শপ, ফেসবুক পেজ কিংবা গেমিং কমিউনিটির জন্য এমন ২৪/৭ অটোমেটেড হোয়াটসঅ্যাপ AI বট কিংবা প্রফেশনাল ওয়েবসাইট বানিয়ে নিতে চান?\n\n` +
            `হোয়াটসঅ্যাপ বটের ক্ষেত্রে আমাদের নিয়ম একদম ক্লিয়ার ভাই—আগে কাজ, কাজ দেখে পছন্দ হলে পরে টাকা!\n\n` +
            `সরাসরি যোগাযোগ করতে পারেন:\n` +
            `📧 Email: gomonhub@gmail.com\n` +
            `💬 WhatsApp: 01349966049\n` +
            `⚠️ (দয়া করে হোয়াটসঅ্যাপে শুধু মেসেজ দিন, সরাসরি কল না দেওয়ার অনুরোধ রইল ভাই)`;
    }

    // Identity inquiry
    if (asksWho) {
        return `আমি GOMON HUB-এর তৈরি করা সাপোর্ট এজেন্ট... তানিম ভাইয়ের সাপোর্ট অ্যাডমিন ভাই! Mex Tanim Esports-এর স্লট বুকিং, পেমেন্ট বা যেকোনো প্রয়োজনে কীভাবে সাহায্য করতে পারি বলেন?`;
    }

    if (isHalaBanter) {
        return `আরে ভাই কি হইছে? হালা বলেন কেন 😂 কোনো স্লট বা পেমেন্ট নিয়ে সমস্যা হলে বলেন, সলভ করে দিচ্ছি!`;
    }

    if (isScamAccusation) {
        return `আরে না ভাই! Mex Tanim Esports হলো জনপ্রিয় গেমার ও ক্রিয়েটর Tanim (Mex Tanim) ভাইয়ের অফিসিয়াল প্ল্যাটফর্ম। আমাদের ইউটিউব ও ফেসবুক পেজ ঘুরে দেখতে পারেন, শত শত প্লেয়ার নিয়মিত অংশ নিচ্ছে। কোনো ফেক বা স্ক্যামের সুযোগ নেই ভাই ❤️`;
    }

    const asksTournament = /(?:tournament|slot|match|টুর্নামেন্ট|স্লট|ম্যাচ|খেলব|khelbo|khelte)/i.test(raw);
    if (asksTournament) {
        return `জি ভাই স্লট খালি আছে! আমাদের দুই টাইপের টুর্নামেন্ট চলতেছে:\n\n` +
            `১. *আজকের ডেইলি টুর্নামেন্ট* (৬০৳, ৮৫৳, ৯০৳ ও ড্রোন ভিউ ১৩৫৳)\n` +
            `২. *MTE International War S1* (১০,০০০৳ মেগা প্রাইজপুল - প্রো ও রাইজিং স্লট)\n\n` +
            `আপনি কোনটা খেলতে চাচ্ছেন ভাই?`;
    }

    if (asksPayment) {
        return `PAYMENT METHOD- SEND MONEY ONLY\n\nবিকাশ- 01611657757\nনগদ- 01611657757\nরকেট- 01611657757\n\nnotice\n\n> একবার স্লট কনফার্ম করলে, পরবর্তীতে সেই স্লট বাতিলযোগ্য না।\n\n> টাকা দেওয়ার পর প্রমান স্বরূপ Screenshot জমা দিবেন এবং নম্বরের লাস্ট ডিজিট বলবেন।\n\n> টাকা দেওয়ার পর নিজ দায়িত্বে কনর্ফাম গ্রুপের লিংক নিয়ে নিবেন, তা না হলে স্লট শেষ হয়ে গেলে আমরা দায়ী থাকবো না।\n\n> পেমেন্ট করতে দেরি হলে সেই সময়ের মধ্যে স্লট শেষ হয়ে গেলে পেমেন্ট ব্যাক দেওয়া হবে না, পরবর্তীতে যেকোনো সময়ে স্লট নিতে পারবেন।`;
    }

    if (asksAllSocial || (isAngry && asksAllSocial)) {
        return `এই যে ভাই Mex Tanim Esports-এর অফিসিয়াল সব প্ল্যাটফর্ম ও সোশ্যাল মিডিয়ার লিংক:\n\n` +
            `📺 YouTube: https://youtube.com/@mextanimesports\n` +
            `🌐 Facebook: https://www.facebook.com/share/19ZkLNuvcN/\n` +
            `💬 WhatsApp Channel: https://whatsapp.com/channel/0029Vb6F0j54Y9lssQHIcv0s\n` +
            `✈️ Telegram: https://t.me/mextanimesports\n` +
            `🎮 Discord: https://discord.gg/HCcsKvFh9d\n` +
            `🎵 TikTok: https://www.tiktok.com/@mextanimgaming?_r=1&_t=ZS-9AZT1zlT6FV`;
    }

    if (isAngry) {
        return `আরে ভাই রাগ করছেন কেন! বলেন কী সমস্যা বা কী দরকার, আমি এখনই সমাধান করে দিচ্ছি ভাই।`;
    }

    if (asksFb) {
        return `এই যে ভাই Mex Tanim Esports-এর অফিসিয়াল ফেসবুক পেজ:\nhttps://www.facebook.com/share/19ZkLNuvcN/`;
    }
    if (asksYt) {
        return `এই যে ভাই Mex Tanim Esports-এর অফিসিয়াল ইউটিউব চ্যানেল:\nhttps://youtube.com/@mextanimesports`;
    }
    if (asksTiktok) {
        return `এই যে ভাই Mex Tanim Esports-এর অফিসিয়াল টিকটক আইডি:\nhttps://www.tiktok.com/@mextanimgaming?_r=1&_t=ZS-9AZT1zlT6FV`;
    }
    if (asksTg) {
        return `এই যে ভাই Mex Tanim Esports-এর অফিসিয়াল টেলিগ্রাম চ্যানেল:\nhttps://t.me/mextanimesports`;
    }
    if (asksDiscord) {
        return `এই যে ভাই Mex Tanim Esports-এর অফিসিয়াল ডিসকর্ড সার্ভার:\nhttps://discord.gg/HCcsKvFh9d`;
    }
    if (asksWaChannel) {
        return `এই যে ভাই Mex Tanim Esports-এর অফিসিয়াল WhatsApp Channel:\nhttps://whatsapp.com/channel/0029Vb6F0j54Y9lssQHIcv0s`;
    }
    if (asksRules) {
        return `নোটিশ:\n> একবার স্লট কনফার্ম করলে, পরবর্তীতে সেই স্লট বাতিলযোগ্য না।\n> টাকা দেওয়ার পর প্রমান স্বরূপ Screenshot জমা দিবেন এবং নম্বরের লাস্ট ডিজিট বলবেন।\n> টাকা দেওয়ার পর নিজ দায়িত্বে কনর্ফাম গ্রুপের লিংক নিয়ে নিবেন।`;
    }
    if (isThanks) {
        return `ওয়েলকাম ভাই! যেকোনো প্রয়োজনে জানাবেন।`;
    }
    if (isDoing) {
        return `এই তো ভাই সাপোর্ট চ্যাটে আছি। বলেন কোনো হেল্প লাগবে?`;
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
        return `আরে ভাই সত্যি বলতে এটা নিয়ে আমার জানা নাই 😂 স্লট বুকিং, পেমেন্ট বা Mex Tanim Esports নিয়ে কিছু জানার থাকলে বলেন দেখছি!`;
    }
    if (alreadyGreeted) {
        const casualReplies = [
            `জি ভাই বলেন, Mex Tanim Esports-এর স্লট বুকিং, পেমেন্ট বা যেকোনো প্রয়োজনে কীভাবে সাহায্য করতে পারি?`,
            `আছি ভাই! টুর্নামেন্ট স্লট, পেমেন্ট নম্বর বা সোশ্যাল লিংক লাগলে বলেন, দিয়ে দিচ্ছি।`,
            `হ্যাঁ ভাই বলেন, শুনতে পাচ্ছি! Mex Tanim Esports নিয়ে কোনো তথ্য লাগবে ভাই?`
        ];
        let chosen = casualReplies[Math.floor(Math.random() * casualReplies.length)];
        if (mem && mem.lastFallback && casualReplies.length > 1) {
            const nonRepeated = casualReplies.filter(r => r !== mem.lastFallback);
            chosen = nonRepeated[Math.floor(Math.random() * nonRepeated.length)];
        }
        if (mem) mem.lastFallback = chosen;
        return chosen;
    }
    return `জি ভাই বলেন, Mex Tanim Esports-এর স্লট বা পেমেন্ট নিয়ে কোনো হেল্প লাগবে?`;
}

function requestGeminiApi(modelName, data, apiKey, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        const cleanKey = (apiKey || '').trim();
        const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${modelName}:generateContent`,
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'X-goog-api-key': cleanKey,
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
                    console.warn(`⚠️ [GEMINI API ERROR HTTP ${res.statusCode} (${modelName})] ${body.slice(0, 300)}`);
                    const apiErr = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
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
        rawKeys = raw.split(/[\r\n,;]+/);
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

// Helper: Formats Current Bangladesh Real Time (Asia/Dhaka UTC+6)
function getBangladeshTimeInfo() {
    const now = new Date();
    try {
        const timeFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Dhaka',
            hour12: true,
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'long',
            month: 'short',
            day: 'numeric'
        });
        const hour24 = parseInt(new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Dhaka',
            hour: 'numeric',
            hour12: false
        }).format(now), 10);
        return {
            formatted: timeFormatter.format(now),
            hour24
        };
    } catch (_) {
        return {
            formatted: now.toLocaleString(),
            hour24: now.getHours()
        };
    }
}

// Helper: Sends Automated Booking & Admin Support Alerts to Tanim's 'Message yourself' (8801611657757)
async function notifyAdminSelf(alertText) {
    if (!sock) return;
    try {
        const cleanBotPhone = (config.bot_phone_number || '8801611657757').replace(/\D/g, '');
        let selfJid = `${cleanBotPhone}@s.whatsapp.net`;
        if (sock.user && sock.user.id) {
            selfJid = sock.user.id.replace(/:\d+@/, '@');
        }
        await sock.sendMessage(selfJid, { text: alertText });
        console.log(`🔔 [ADMIN SELF-ALERT SENT] Successfully notified Admin (Tanim) in 'Message yourself'.`);
    } catch (err) {
        console.error(`⚠️ [ADMIN ALERT ERROR]: ${err.message}`);
    }
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
    const primaryModel = process.env.GEMINI_MODEL || currentConfig.ai_model || config.ai_model || 'gemini-3.5-flash-lite';
    const secondaryModel = (primaryModel === 'gemini-3.5-flash-lite') ? 'gemini-3.5-flash' : 'gemini-3.5-flash-lite';

    const mem = getChatMemory(senderPhone);
    const bdTime = getBangladeshTimeInfo();

    if (candidateKeys.length === 0) {
        console.warn(`⚠️ [GEMINI] No API keys configured in GEMINI_API_KEYS or config.json. Using fallback.`);
        const fallback = getSmartFallbackReply(userMessage, !!imageBase64, senderPhone);
        mem.history.push({ role: 'user', parts: [{ text: userMessage || '[ছবি]' }] });
        mem.history.push({ role: 'model', parts: [{ text: fallback }] });
        mem.greeted = true;
        return fallback;
    }

    const systemPrompt = `You are a real human customer support admin for "Mex Tanim Esports" on WhatsApp in Bangladesh. You are an actual Bangladeshi gamer guy chatting naturally with fellow gamers.

PLATFORM IDENTITY & OWNER:
- Platform: Mex Tanim Esports
- Business / Person: Mex Tanim Esports
- Owner: Tanim (Mex Tanim)
- About: Mex Tanim Esports হলো জনপ্রিয় গেমার ও ক্রিয়েটর Tanim (Mex Tanim)-এর অফিসিয়াল গেমিং ও ই-স্পোর্টস প্ল্যাটফর্ম। এখানে রেগুলার গেমিং আপডেট, ডেইলি কাস্টম টুর্নামেন্ট ও মেগা টুর্নামেন্ট অনুষ্ঠিত হয়।

CURRENT LIVE BANGLADESH REAL-TIME CLOCK:
- Current Live BD Time: ${bdTime.formatted} (24-Hour Hour: ${bdTime.hour24})
- TIME-AWARE RECOMMENDATION RULE: Use this current time to determine WHICH matches are UPCOMING for today/tonight! NEVER suggest or offer match times that have ALREADY PASSED earlier today!
  • If before 3:00 PM: 3:00 PM Champion Rush (60৳), 4:00 PM Mini Blust (60৳), 5:00 PM Live (90৳), etc. are available.
  • If afternoon (3:00 PM to 6:59 PM): Suggest upcoming matches: 7:00 PM Champion Rush (60৳), 8:00 PM Mini Blust (60৳), 9:00 PM Live (90৳) / Drone View (135৳), 10:00 PM & 11:00 PM.
  • If evening (7:00 PM to 9:59 PM): Suggest upcoming: 8:00 PM Mini Blust (60৳), 9:00 PM Live (90৳) / Drone View (135৳), 10:00 PM Mini Blust (60৳), 11:00 PM Champion Rush (60৳) / Live (90৳), and 12 AM / 1 AM Special Blust (85৳).
  • If night (10:00 PM onwards): Suggest 10:00 PM, 11:00 PM, and midnight 12:00 AM & 1:00 AM Special Blust (85৳ | PP 800৳).

NATURAL HUMAN TOURNAMENT SUPPORT FLOW:
1. When user asks for tournament/slot ("slot ache?", "match khelbo", "tournament lagbe", "khelte chai", "ajke match ase?"):
   - Greet warmly and offer the choice like a helpful gamer brother:
     "জি ভাই স্লট খালি আছে! আমাদের দুই টাইপের টুর্নামেন্ট চলতেছে:
     ১. *আজকের ডেইলি টুর্নামেন্ট* (৬০৳, ৮৫৳, ৯০৳ ও ড্রোন ভিউ ১৩৫৳)
     ২. *MTE International War S1* (১০,০০০৳ মেগা প্রাইজপুল - প্রো ও রাইজিং স্লট)
     আপনি কোনটা খেলতে চাচ্ছেন ভাই?"
2. If user chooses Daily Tournament ("daily match", "regular match", "ajker match", etc.):
   - Ask for their view preference:
     "ডেইলি ম্যাচে ড্রোন ভিউ (Drone View) খেলবেন নাকি নরমাল টুর্নামেন্ট ভাই?
     আমাদের রাত ৯টা ও ১০টায় সিঙ্গাপুর সার্ভারে ১৩৫ টাকার Drone View ম্যাচ আছে (ফি ১৩৫৳ | প্রাইজ ৯০০৳, সিঙ্গাপুর সার্ভার, লাইভ ডেমো: https://www.youtube.com/live/kp520WEicJI)।
     নাকি নরমাল ৬০/৮৫/৯০ টাকার টুর্নামেন্ট খেলবেন?"
3. If user chooses Drone View:
   - Provide Singapore server details, demo link, and ask whether they prefer the 9:00 PM or 10:00 PM slot.
4. If user chooses Normal View:
   - Based on Current Live BD Time, list the upcoming matches for today with Fee, Prize & Map count!
   - Ask which match/time they wish to book.
5. If user chooses MTE International War S1:
   - Provide the complete mega event details clearly:
     • Total Prizepool: ১০,০০০ টাকা
     • Pro Slot (২৪ টিম): ২৮০ টাকা (Times: 3PM, 7PM, 9PM, 10PM)
     • Rising Slot (৯৬ টিম): ১২০ টাকা (Times: 3PM, 7PM, 9PM, 10PM)
     • Invited Teams: BDTOP1, MTS, NOVA KNIGHTS, NRS, PIRATE, RRR, TEAM 2XD, Team electro, TEAM INFINITY, THE JAWBREAKERS, VXC, X2 GLOBAL
     • Note: এক টিম চাইলে একাধিক স্লট নিতে পারবে।
   - Ask: "প্রো স্লট (২৮০৳) নাকি রাইজিং স্লট (১২০৳)—কোনটাতে স্লট বুক করবেন ভাই?"
6. Once user selects a slot/match time:
   - Immediately provide the exact Send Money details and notice:
PAYMENT METHOD- SEND MONEY ONLY

বিকাশ- 01611657757
নগদ- 01611657757
রকেট- 01611657757

notice

> একবার স্লট কনফার্ম করলে, পরবর্তীতে সেই স্লট বাতিলযোগ্য না।
> টাকা দেওয়ার পর প্রমান স্বরূপ Screenshot জমা দিবেন এবং নম্বরের লাস্ট ডিজিট বলবেন।
> টাকা দেওয়ার পর নিজ দায়িত্বে কনর্ফাম গ্রুপের লিংক নিয়ে নিবেন, তা না হলে স্লট শেষ হয়ে গেলে আমরা দায়ী থাকবো না।
> পেমেন্ট করতে দেরি হলে সেই সময়ের মধ্যে স্লট শেষ হয়ে গেলে পেমেন্ট ব্যাক দেওয়া হবে না, পরবর্তীতে যেকোনো সময়ে স্লট নিতে পারবেন।

7. SCREENSHOT & PAYMENT VERIFICATION BY VISION (VERY IMPORTANT):
   - When user sends an image/screenshot (bKash/Nagad/Rocket payment receipt):
     Examine the receipt using your vision:
     • Check Receiver Number: Did they send money to 01611657757?
     • Check Amount: Does the amount match the tournament slot fee (e.g. 60৳, 85৳, 90৳, 120৳, 135৳, 280৳)?
     • Check Transaction Status: Is it a successful Send Money?
     - IF IT MATCHES:
       Confirm warmly and reassure them:
       "স্ক্রিনশটটি পেয়েছি ভাই! আপনার পেমেন্ট কনফার্ম দেখা যাচ্ছে। স্লটটি প্রসেসিংয়ে নেওয়া হয়েছে... আমাদের অ্যাডমিন তানিম ভাই কিছুক্ষণের মধ্যেই বিকাশ স্টেটমেন্ট চেক করে আপনাকে কনফার্ম গ্রুপের লিংক ইনবক্সে দিয়ে দিচ্ছেন ভাই! একটু অপেক্ষা করুন ❤️"
     - IF IT DOES NOT MATCH (wrong number, incorrect amount, blurred, or suspicious):
       Politely inform: "ভাই স্ক্রিনশটে নম্বর বা টাকার পরিমাণ ম্যাচ করছে না, দয়া করে Mex Tanim Esports-এর নম্বরে (01611657757) সঠিক ফি পাঠিয়ে ফ্রেশ স্ক্রিনশট দিন ভাই।"

8. DIRECT ADMIN COMMUNICATION REQUEST:
   - If user asks to talk directly to Admin (Tanim) or wants to make payment directly to Admin:
     Respond politely: "জি ভাই অবশ্যই! আমাদের প্রধান অ্যাডমিন তানিম ভাইকে আমি এখনই আপনার চ্যাটটি ফরোয়ার্ড করে নোটিফাই করে দিচ্ছি। উনি দ্রুতই আপনাকে সরাসরি মেসেজ দিচ্ছেন ভাই ❤️"

DEVELOPER / CREATOR MODE & GOMON HUB RULES:
- Developer / Bot Creator: GOMON HUB (Mr GOMON / @gomonhub).
- CRITICAL TRUTH RULE: GOMON HUB-এর নিজস্ব অফিসিয়াল ফ্রি ফায়ার টুর্নামেন্ট ওয়েবসাইট রয়েছে! NEVER say "GOMON HUB-এর কোনো টুর্নামেন্ট নেই"!
- Free Fire Tournament Website: https://rb.gy/feuqry (Chrome-এ ‘GOMON HUB TOURNAMENT’ লিখে সার্চ করলেও সরাসরি পাওয়া যায়)।
- WEBSITE FEATURES & HIGHLIGHTS:
  • ফ্রেন্ড বা অপোনেন্টের সাথে ইচ্ছামতো বাজি ধরে ১v১ বা স্কোয়াড কাস্টম ম্যাচ বানিয়ে খেলা যায় (টাকা মেরে ব্লক দিয়ে ভেগে যাওয়ার কোনো সুযোগ নেই, জয়ীর অ্যাকাউন্টে প্রাইজ অটো যুক্ত হয়)।
  • প্রতি রেফারে ৫ টাকা ইনস্ট্যান্ট বোনাস এবং প্রতিটি প্লেয়ারের আলাদা ইউনিক প্রমোকোড (যত খুশি রেফার করা যায়)।
  • ২-স্টেপ ভেরিফিকেশন, হ্যাকার প্রিভেন্ট রিভিউ, কারো আইডি হ্যাক বা জোরপূর্বক উইথড্র নেওয়ার কোনো সুযোগ নেই।
  • সম্পূর্ণ অটো ব্যালেন্স ও উইথড্র ভেরিফিকেশন সিস্টেম।
  • নিজস্ব ২৪/৭ এআই ও সরাসরি হোয়াটসঅ্যাপ সাপোর্ট (নো টেলিগ্রাম ঝামেলা)।
  • খুব শীঘ্রই সম্পূর্ণ ফ্রি টুর্নামেন্ট সুবিধাও চালু হচ্ছে!
- BAZI MATCH EXPLANATION (IF ASKED "bazi khela jay mane?", "kemne bazi khela jay?"):
  Answer in natural, casual gamer terms without herbal advertising:
  "মানে একদম সিম্পল ভাই! আপনারা ফ্রেন্ডরা বা অপোনেন্টের সাথে নিজেদের ইচ্ছামতো টাকা ধরে ১v১ বা স্কোয়াড কাস্টম চ্যালেঞ্জ খেলতে পারবেন।
  নরমালি কী হয়? বাজি খেলে জিতলে অনেক সময় অপোনেন্ট টাকা না দিয়ে ব্লক মেরে ভেগে যায়, তাই না? 😂 কিন্তু এই ওয়েবসাইটে সেই বাটপারি বা স্ক্যামের কোনো সুযোগই নাই!
  আপনি কত টাকার ম্যাচ খেলবেন (যেমন ৫০৳ বা ১০০৳) সেটা সেট করে ম্যাচ বানিয়ে রাখবেন। অপোনেন্টও সেই টাকা ডিপোজিট করে আপনার ম্যাচে ঢুকবে। খেলা শেষে যে জিতবে, ওয়েবসাইটের সিস্টেম অটোমেটিক পুরো প্রাইজমানি তার অ্যাকাউন্টে পাঠিয়ে দেবে! কোনো চিটিং বা টাকা মারার ভয়ই নেই ভাই।
  Chrome-এ ‘GOMON HUB TOURNAMENT’ লিখে বা লিংকে গিয়ে নিজেই দেখে আসতে পারেন: https://rb.gy/feuqry ❤️"
- WHATSAPP BOT SYSTEM DEVELOPMENT OFFER:
  If anyone asks about who made this bot, developer ke, maker, or asks to build an AI bot:
  "এই বটটি ডেভেলপ করেছে GOMON HUB (Mr GOMON ভাই)! 🎮
  উনাদের নিজস্ব দারুণ একটি ফ্রি ফায়ার টুর্নামেন্ট ওয়েবসাইটও রয়েছে: https://rb.gy/feuqry (Chrome-এ 'GOMON HUB TOURNAMENT' লিখেও পাবেন) 🔥 যেখানে নিজেদের ইচ্ছামতো বাজি ধরে ১v১ বা স্কোয়াড কাস্টম খেলা যায় এবং প্রতি রেফারে ৫ টাকা বোনাস পাওয়া যায়!
  পাশাপাশি আপনিও কি আপনার নিজস্ব যেকোনো ধরণের বিজনেস, অনলাইন শপ, ফেসবুক পেজ কিংবা গেমিং কমিউনিটির জন্য এমন ২৪/৭ অটোমেটেড হোয়াটসঅ্যাপ AI বট কিংবা প্রফেশনাল ওয়েবসাইট বানিয়ে নিতে চান?
  হোয়াটসঅ্যাপ বটের ক্ষেত্রে আমাদের নিয়ম একদম ক্লিয়ার ভাই—আগে কাজ, কাজ দেখে পছন্দ হলে পরে টাকা!
  সরাসরি যোগাযোগ করতে পারেন: 💬 WhatsApp: 01349966049"
- GOMON HUB SOCIAL MEDIA HANDLING:
  • If asked for GOMON HUB YouTube: Share https://www.youtube.com/@gomonhub (2nd channel: https://www.youtube.com/@mrgomonhub)
  • If asked for GOMON HUB Facebook: Share https://www.facebook.com/gomonhub
  • If asked for GOMON HUB TikTok: Share https://www.tiktok.com/@gomon_hub
  • If asked for GOMON HUB Instagram: Share https://www.instagram.com/gomon_gamer
  • If asked for ALL GOMON HUB links: List Tournament Site (https://rb.gy/feuqry), YouTube, Facebook, TikTok, Instagram, Threads cleanly.

NUMBERS & PHONE NUMBER HANDLING RULES:
- If user asks about or sends "01611657757": State that this is Mex Tanim Esports's official Send Money number for bKash, Nagad, and Rocket to book slots.
- If user asks about or sends "01349966049": State that this is GOMON HUB (Mr GOMON ভাই)'s official WhatsApp contact for bot/website development (message only, no calls).
- If user sends their personal phone number (e.g. 017..., 019..., 018...): Ask if this is the number they sent payment from, ask for screenshot + last digit to confirm their slot and give group link.
- If user sends an in-game UID (8-10 digits): Ask if it's their Free Fire UID and which match/slot they wish to book.
- If user sends random numbers: Politely ask what the number is for (payment, slot, or general inquiry) like a helpful gamer brother.

IDENTITY RULE (WHEN ASKED "tmi k?", "tumi ke?", "কে তুমি?", "tmr porichoy ki?"):
- Answer EXACTLY in natural, clean Bengali: "আমি GOMON HUB-এর তৈরি করা সাপোর্ট এজেন্ট... তানিম ভাইয়ের সাপোর্ট অ্যাডমিন ভাই! Mex Tanim Esports-এর স্লট বুকিং, পেমেন্ট বা যেকোনো প্রয়োজনে কীভাবে সাহায্য করতে পারি বলেন?"

MEX TANIM ESPORTS OFFICIAL LINKS:
- YouTube: https://youtube.com/@mextanimesports
- Facebook: https://www.facebook.com/share/19ZkLNuvcN/
- WhatsApp Channel: https://whatsapp.com/channel/0029Vb6F0j54Y9lssQHIcv0s
- Telegram: https://t.me/mextanimesports
- Discord: https://discord.gg/HCcsKvFh9d
- TikTok: https://www.tiktok.com/@mextanimgaming?_r=1&_t=ZS-9AZT1zlT6FV
- When asked for ALL links ("sob link", "social links", "aksathe", etc.), list all 6 Mex Tanim Esports links cleanly.

ABSOLUTE HUMAN RULES (NEVER BREAK THESE):
1. NEVER speak like an AI, a chatbot, or a corporate robot!
2. NEVER say "Mex Tanim Esports সাপোর্ট টিমে আপনাকে স্বাগতম", "কীভাবে সাহায্য করতে পারি?", "আমাদের সাপোর্ট টিমে নক করুন" (YOU ARE THE SUPPORT ADMIN!).
3. NEVER repeat Salam in an active ongoing chat! If you already exchanged Salam or if it's mid-conversation, DO NOT say Salam again! Only say "ওয়ালাইকুম আসসালাম" if the user explicitly says Salam in this current message.
4. Keep replies short, natural, friendly, and straight to the point (1 to 2 lines maximum) just like a real person typing on WhatsApp. Always finish your sentence completely and naturally; never cut off mid-sentence.
5. Answer casual remarks naturally:
   - "kmn aso" -> "আলহামদুলিল্লাহ ভাই ভালো, আপনার কী অবস্থা?"
   - "ki koro" -> "এই তো ভাই সাপোর্ট চ্যাটে আছি। কোনো হেল্প লাগবে?"
   - "sure to?" -> "হ্যাঁ ভাই একদম সিওর! বলেন কী বিষয়?"
   - Accusations & Doubts ("scammer", "fake", "trust", "scam"):
     Answer calm, friendly & reassuring: "আরে না ভাই! Mex Tanim Esports হলো জনপ্রিয় গেমার ও ক্রিয়েটর Tanim (Mex Tanim) ভাইয়ের অফিসিয়াল প্ল্যাটফর্ম। আমাদের ইউটিউব ও ফেসবুক পেজ ঘুরে দেখতে পারেন, শত শত প্লেয়ার নিয়মিত টুর্নামেন্ট খেলছে। কোনো সন্দেহ বা ফেকের সুযোগ নেই ভাই ❤️"

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
        generationConfig: {
            maxOutputTokens: 1000,
            temperature: 0.7
        }
    });

    let cleanReply = null;

    // Pass 1: Try Primary Model (gemini-3.5-flash-lite) across all candidate keys (4.5s fast timeout)
    for (let i = 0; i < candidateKeys.length; i++) {
        const activeKey = candidateKeys[i];
        const maskedKey = activeKey.length > 8 ? `${activeKey.slice(0, 4)}...${activeKey.slice(-4)}` : 'KEY';

        try {
            cleanReply = await requestGeminiApi(primaryModel, data, activeKey, 4500);
            if (cleanReply) break;
        } catch (err) {
            console.warn(`⚠️ [GEMINI PRIMARY ERROR (${primaryModel}) Key ${maskedKey}] ${err.message}. Instant failover to next key in pool...`);
            if (err.statusCode === 429 || err.statusCode === 503 || err.statusCode === 408) {
                keyCooldowns[activeKey] = Date.now() + 60000;
            }
        }
    }

    // Pass 2: Secondary Model (gemini-3.5-flash) across key pool if primary pass had issues
    if (!cleanReply) {
        console.warn(`⚠️ [GEMINI PASS 1 COMPLETE] Trying secondary model (${secondaryModel}) across key pool...`);
        for (let i = 0; i < candidateKeys.length; i++) {
            const activeKey = candidateKeys[i];
            const maskedKey = activeKey.length > 8 ? `${activeKey.slice(0, 4)}...${activeKey.slice(-4)}` : 'KEY';

            try {
                cleanReply = await requestGeminiApi(secondaryModel, data, activeKey, 4500);
                if (cleanReply) break;
            } catch (err) {
                console.warn(`⚠️ [GEMINI SECONDARY ERROR (${secondaryModel}) Key ${maskedKey}] ${err.message}.`);
                if (err.statusCode === 429 || err.statusCode === 503 || err.statusCode === 408) {
                    keyCooldowns[activeKey] = Date.now() + 60000;
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
    const withTimeout = () => Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Handler timed out after 25s')), 25000))
    ]);
    const nextPromise = senderQueues[senderPhone]
        .then(() => withTimeout())
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

let reconnectTimeout = null;

async function startWhatsAppBot() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    // Eradicate ghost sockets and Bad MAC by cleaning up previous active socket
    if (sock) {
        console.log('🧹 [SOCKET CLEANUP] Gracefully closing existing WhatsApp socket to prevent ghost sessions & Bad MAC...');
        try {
            sock.ev.removeAllListeners();
            sock.end(undefined);
        } catch (_) { }
        sock = null;
    }

    const sessionDir = getSessionDir();
    const sessionName = getSessionName();
    const mongoCol = await getMongoDBAuthCollection();

    let state, saveCreds;
    if (mongoCol) {
        console.log(`📦 [AUTH ENGINE] Using MongoDB Persistent Cloud Auth State (${sessionName}).`);
        currentAuthState = await useMongoDBAuthState(mongoCol);
        state = currentAuthState.state;
        saveCreds = currentAuthState.saveCreds;

    } else {
        console.log(`📦 [AUTH ENGINE] Using Local MultiFileAuthState (${sessionName}).`);
        restoreSessionFromEnv();
        currentAuthState = await useMultiFileAuthState(sessionDir);
        state = currentAuthState.state;
        saveCreds = currentAuthState.saveCreds;
    }

    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`\n======================================================`);
    console.log(`🤖 GOMONHUB WhatsApp OTP & Auto-Reply Bot starting...`);
    console.log(`📦 Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);
    console.log(`🌐 Live Player Simulation Web Portal: http://localhost:${PORT}`);
    console.log(`======================================================\n`);

    const pinoLogger = pino({ level: 'silent' });
    // Ultra-optimized lightweight cache for Render 512MB RAM (Prevents OOM Crashes under 2 msgs/sec load)
    const msgRetryCounterCache = new NodeCache({ stdTTL: 60, maxKeys: 400 });
    const msgCache = new NodeCache({ stdTTL: 60, maxKeys: 400 });

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pinoLogger)
        },
        logger: pinoLogger,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        msgRetryCounterCache,
        getMessage: async (key) => {
            if (key?.id) {
                const cached = msgCache.get(key.id);
                if (cached) return cached;
            }
            return proto.Message.fromObject({});
        },
        shouldIgnoreJid: (jid) => (jid || '').endsWith('@g.us') || (jid || '').endsWith('@broadcast'),
        browser: Browsers.ubuntu('Chrome')
    });

    // Auto-cache all outgoing messages so WhatsApp retry requests succeed seamlessly
    const rawSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (...args) => {
        const result = await rawSendMessage(...args);
        if (result?.key?.id && result?.message) {
            msgCache.set(result.key.id, result.message);
        }
        return result;
    };

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
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = (statusCode === DisconnectReason.loggedOut);
            console.log(`\n⚠️ Connection closed: ${lastDisconnect?.error?.message || 'Unknown'}. Logged out: ${isLoggedOut}`);

            // Ensure previous socket is closed cleanly to stop Bad MAC
            if (sock) {
                try {
                    sock.ev.removeAllListeners();
                    sock.end(undefined);
                } catch (_) { }
                sock = null;
            }

            if (isLoggedOut) {
                console.log(`🗑️ [LOGGED OUT] Session was logged out. Clearing ${getSessionName()} and restarting for fresh QR code...`);
                sessionInvalidated = true;
                if (currentAuthState && currentAuthState.clearAuth) {
                    await currentAuthState.clearAuth();
                }
                const sessionDir = getSessionDir();
                if (fs.existsSync(sessionDir)) {
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                }
                currentQr = null;
                currentQrDataUrl = null;
                currentPairingCode = null;
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(startWhatsAppBot, 2000);
            } else {
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(startWhatsAppBot, 3500);
            }
        } else if (connection === 'open') {
            isConnected = true;
            botConnectTimestamp = Math.floor(Date.now() / 1000);
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
            }
            currentQr = null;
            currentQrDataUrl = null;
            currentPairingCode = null;

            // Auto-detect connected bot phone number and update config
            try {
                if (sock?.user?.id) {
                    const detectedPhone = sock.user.id.split(':')[0].replace(/@.*$/, '');
                    if (detectedPhone && detectedPhone !== config.bot_phone_number) {
                        console.log(`📱 [BOT NUMBER DETECTED] Connected number: ${detectedPhone} (Updated from ${config.bot_phone_number})`);
                        config.bot_phone_number = detectedPhone;
                        if (fs.existsSync(configPath)) {
                            const curConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                            curConfig.bot_phone_number = detectedPhone;
                            fs.writeFileSync(configPath, JSON.stringify(curConfig, null, 2), 'utf8');
                        }
                    }
                }
            } catch (numErr) {
                console.error('[AUTO-NUMBER DETECT ERROR]', numErr.message);
            }

            const sk = getSessionKeyString();
            const initialKeys = getGeminiApiKeyPool();
            console.log('\n✅ [WHATSAPP CONNECTED] Bot is active & listening 24/7!\n');
            console.log(`🔑 [GEMINI KEY POOL] ${initialKeys.length} active key(s) detected and ready for load balancing.`);
            if (sk) {
                console.log(`🔑 [PERMANENT SESSION KEY]: ${sk}\n`);
            }
        }
    });

    async function processSingleMessage(msg, customText = null) {
        if (!msg || !msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;
        // Strictly ignore all group messages (@g.us) to prevent session corruption and spam
        if ((msg.key.remoteJid || '').endsWith('@g.us')) return;

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

        const text = (customText !== null) ? customText : (
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

        // Master Kill Switch Check: If Tanim (Owner) paused the bot, silently ignore customer messages
        if (isBotPaused) {
            console.log(`⏸️ [BOT PAUSED] Message from ${senderPhone} ignored because bot is switched OFF by Admin.`);
            addLiveChatMessage({
                customer: phoneDisplay,
                customerName: customerDisplay,
                message: text || (imageBase64 ? '[ছবি / পেমেন্ট স্ক্রিনশট পাঠানো হয়েছে]' : ''),
                hasImage: !!imageBase64,
                reply: '⏸️ বট বন্ধ (OFF) থাকায় কাস্টমারকে কোনো অটো-রিপ্লাই দেওয়া হয়নি।',
                status: 'paused',
                time: new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true })
            });
            return;
        }

        // Check if message requires Admin Alert (Payment Proof / Screenshot or Direct Admin Request)
        const cleanCustomerPhone = senderPhone.replace(/\D/g, '');
        const isLid = (senderJid || '').endsWith('@lid') || (cleanCustomerPhone.length >= 14 && !cleanCustomerPhone.startsWith('880'));
        const customerDisplay = (msg.pushName || '').trim() || 'কাস্টমার';
        const phoneDisplay = isLid ? 'গোপন রাখা (Hidden)' : `+${cleanCustomerPhone}`;
        const chatLink = `https://wa.me/${cleanCustomerPhone}`;

        const paymentActionGuide = isLid
            ? `👉 *কাস্টমার নম্বর গোপন রেখেছে। চ্যাটটি পেতে WhatsApp সার্চবারে লিখুন:*\n🔍 *"${customerDisplay}"*`
            : `👉 *কাস্টমারকে কনফার্ম গ্রুপের লিংক দিতে চ্যাটে ঢুকুন:*\n🔗 ${chatLink}`;

        const adminActionGuide = isLid
            ? `👉 *কাস্টমার নম্বর গোপন রেখেছে। সরাসরি কথা বলতে WhatsApp সার্চবারে লিখুন:*\n🔍 *"${customerDisplay}"*`
            : `👉 *সরাসরি কাস্টমারের সাথে কথা বলতে চ্যাটে ঢুকুন:*\n🔗 ${chatLink}`;

        // 1. Payment Screenshot / Transaction Proof Alert to Tanim's 'Message yourself'
        const isPaymentProof = !!imageBase64 || /(?:last\s*digit|লাস্ট\s*ডিজিট|trxid|trx\s*id|ট্রানজ্যাকশন|বিকাশ|নগদ|রকেট|টাকা\s*(?:পাঠাইছি|দিছি|পাঠাইসি|দিলাম|দিচি|পাঠাব|পাঠানো|পাঠাইলাম)|পেমেন্ট\s*(?:করছি|দিছি|পাঠাইছি|done|ডান|হইছে)|payment\s*(?:done|sent|success)|sent\s*money|সেন্ড\s*মানি)/i.test(text);
        if (isPaymentProof) {
            const alertMsg = `🚨 *[নতুন পেমেন্ট / স্লট বুকিং অ্যালার্ট!]* 💰\n` +
                `━━━━━━━━━━━━━━━━━━━\n` +
                `👤 *কাস্টমার:* ${customerDisplay}\n` +
                `📱 *ফোন নম্বর:* ${phoneDisplay}\n` +
                `💬 *মেসেজ:* ${text || '[পেমেন্ট স্ক্রিনশট পাঠানো হয়েছে]'}\n` +
                `📸 *স্ক্রিনশট আছে:* ${imageBase64 ? 'হ্যাঁ (Yes)' : 'না'}\n` +
                `━━━━━━━━━━━━━━━━━━━\n` +
                paymentActionGuide;
            notifyAdminSelf(alertMsg).catch(() => {});
        }

        // 2. Direct Admin Contact / Payment Request Alert to Tanim's 'Message yourself'
        const isDirectAdminReq = /(?:admin.*(?:kotha|call|number|direct|হ্যান্ডেল|কথা|নম্বর)|direct.*(?:admin|payment|kotha|টাকা|কথা|অ্যাডমিন)|তানিম.*(?:কথা|নম্বর|বলো|সাথে|direct))/i.test(text);
        if (isDirectAdminReq && !isPaymentProof) {
            const adminAlertMsg = `🔔 *[ডিরেক্ট অ্যাডমিন সাপোর্ট রিকোয়েস্ট!]* 👤\n` +
                `━━━━━━━━━━━━━━━━━━━\n` +
                `👤 *কাস্টমার:* ${customerDisplay}\n` +
                `📱 *ফোন নম্বর:* ${phoneDisplay}\n` +
                `💬 *মেসেজ:* "${text}"\n` +
                `━━━━━━━━━━━━━━━━━━━\n` +
                adminActionGuide;
            notifyAdminSelf(adminAlertMsg).catch(() => {});
        }

        // All incoming WhatsApp messages go directly to AI Support Agent
        console.log(`💬 [MESSAGE RECEIVED] From: ${senderPhone} | Text: "${text}" | HasImage: ${!!imageBase64}`);
        try {
            // Instantly notify user with typing presence so they know bot is online & responding
            sock.sendPresenceUpdate('composing', senderJid).catch(() => {});
            const aiReply = await generateAiSupportReply(text, senderPhone, imageBase64, imageMime);
            await sock.sendMessage(senderJid, { text: aiReply });
            console.log(`🤖 [AI SUPPORT REPLIED] To: ${senderPhone}`);
            addLiveChatMessage({
                customer: phoneDisplay,
                customerName: customerDisplay,
                message: text || (imageBase64 ? '[ছবি / পেমেন্ট স্ক্রিনশট পাঠানো হয়েছে]' : ''),
                hasImage: !!imageBase64,
                reply: aiReply,
                isPaymentProof: !!isPaymentProof,
                status: 'replied',
                time: new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true })
            });
        } catch (aiErr) {
            console.error(`❌ [AI SUPPORT ERROR] ${aiErr.message}`);
            const fallbackReply = `স্বাগতম Mex Tanim Esports-এ!\nস্লট বুকিং, পেমেন্ট বা টুর্নামেন্ট নিয়ে যেকোনো হেল্প লাগলে জানান ভাই।\n\nYouTube: https://youtube.com/@mextanimesports`;
            await sock.sendMessage(senderJid, {
                text: fallbackReply
            });
            addLiveChatMessage({
                customer: phoneDisplay,
                customerName: customerDisplay,
                message: text || (imageBase64 ? '[ছবি / পেমেন্ট স্ক্রিনশট পাঠানো হয়েছে]' : ''),
                hasImage: !!imageBase64,
                reply: fallbackReply,
                isPaymentProof: !!isPaymentProof,
                status: 'fallback',
                time: new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true })
            });
        } finally {
            sock.sendPresenceUpdate('paused', senderJid).catch(() => {});
        }
    }

    // Handles Owner / Admin Master Switch Commands (#bot off / #bot on / #bot status)
    async function handleAdminBotToggle(commandText, targetJid) {
        const raw = (commandText || '').trim().toLowerCase();

        const isOffCmd = /^(?:[#!]?bot\s+off|[#!]off|bot\s*off|বট\s*অফ)$/i.test(raw);
        const isOnCmd = /^(?:[#!]?bot\s+on|[#!]on|bot\s*on|বট\s*অন)$/i.test(raw);
        const isStatusCmd = /^(?:[#!]?bot\s+status|[#!]status|bot\s*status|বট\s*স্ট্যাটাস)$/i.test(raw);

        if (!isOffCmd && !isOnCmd && !isStatusCmd) return false;

        if (isOffCmd) {
            setBotPaused(true);
            console.log(`\n🛑 [ADMIN MASTER SWITCH] Mex Tanim Esports AI Bot turned OFF by Admin.\n`);
            const reply = `🔴 *Mex Tanim Esports AI বট বন্ধ (OFF) করা হয়েছে!*\n\n` +
                `এখন থেকে এআই কোনো মেসেজের স্বয়ংক্রিয় উত্তর দেবে না। আপনি নিজে ম্যানুয়ালি কাস্টমারদের সাথে চ্যাট করতে পারবেন।\n\n` +
                `▶️ পুনরায় চালু করতে লিখুন: *#bot on*`;
            try {
                await sock.sendMessage(targetJid, { text: reply });
            } catch (e) {
                console.error(`[ADMIN SWITCH ERROR]`, e.message);
            }
            return true;
        }

        if (isOnCmd) {
            setBotPaused(false);
            console.log(`\n🟢 [ADMIN MASTER SWITCH] Mex Tanim Esports AI Bot turned ON by Admin.\n`);
            const reply = `🟢 *Mex Tanim Esports AI বট চালু (ON) করা হয়েছে!*\n\n` +
                `এখন থেকে এআই ২৪/৭ স্বয়ংক্রিয়ভাবে সব কাস্টমারদের মেসেজের রিপ্লাই দেবে।\n\n` +
                `⏸️ সাময়িকভাবে বন্ধ করতে লিখুন: *#bot off*`;
            try {
                await sock.sendMessage(targetJid, { text: reply });
            } catch (e) {
                console.error(`[ADMIN SWITCH ERROR]`, e.message);
            }
            return true;
        }

        if (isStatusCmd) {
            console.log(`\nℹ️ [ADMIN MASTER SWITCH] Bot status queried by Admin.\n`);
            const reply = `🤖 *Mex Tanim Esports AI বট স্ট্যাটাস:*\n\n` +
                `বর্তমান অবস্থা: ${isBotPaused ? '🔴 বন্ধ (PAUSED / OFF)' : '🟢 চালু (ACTIVE / ON)'}\n\n` +
                `• বন্ধ করতে লিখুন: *#bot off*\n` +
                `• চালু করতে লিখুন: *#bot on*`;
            try {
                await sock.sendMessage(targetJid, { text: reply });
            } catch (e) {
                console.error(`[ADMIN SWITCH ERROR]`, e.message);
            }
            return true;
        }

        return false;
    }

    // Inbound Burst Debounce Buffer (Handles 2+ msgs/sec gracefully without memory crash)
    const senderBurstBuffers = {};

    function handleIncomingBurstMessage(senderPhone, msg) {
        if (!senderBurstBuffers[senderPhone]) {
            senderBurstBuffers[senderPhone] = {
                timer: null,
                texts: [],
                lastMsg: msg,
                hasImage: false
            };
        }

        const buf = senderBurstBuffers[senderPhone];
        buf.lastMsg = msg;

        const imgMessage = msg.message.imageMessage ||
            msg.message.viewOnceMessage?.message?.imageMessage ||
            msg.message.viewOnceMessageV2?.message?.imageMessage ||
            msg.message.ephemeralMessage?.message?.imageMessage ||
            (msg.message.documentMessage?.mimetype?.startsWith('image/') ? msg.message.documentMessage : null);

        if (imgMessage) {
            buf.hasImage = true;
            buf.lastMsg = msg;
        }

        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            imgMessage?.caption ||
            ''
        ).trim();

        if (text) buf.texts.push(text);

        // Rapid burst debounce delay: 1.2s for image, 2.5s for rapid text bursts
        const debounceDelay = buf.hasImage ? 1200 : 2500;

        if (buf.timer) clearTimeout(buf.timer);
        buf.timer = setTimeout(() => {
            const aggregatedText = buf.texts.join(' \n ');
            const finalMsg = buf.lastMsg;
            delete senderBurstBuffers[senderPhone];

            queueMessageForSender(senderPhone, () => processSingleMessage(finalMsg, aggregatedText || null));
        }, debounceDelay);
    }

    // Listen to incoming messages (handles multiple users simultaneously and queues bursts per user)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;
        for (const msg of messages) {
            if (!msg || msg.key?.remoteJid === 'status@broadcast') continue;

            // Self-Healing Hook: If an incoming message could not be decrypted by libsignal (e.g. ciphertext stub or Bad MAC)
            if (!msg.message) {
                const corruptSender = msg.key?.remoteJid;
                if (corruptSender && !corruptSender.endsWith('@g.us')) {
                    purgeSenderCorruptedSession(corruptSender);
                }
                continue;
            }

            // Stale Backlog / Offline Message Guard:
            // Safely skip stale messages queued on WhatsApp servers while bot was offline/restarting (prevents Bad MAC replay storms)
            const msgTime = Number(msg.messageTimestamp || 0);
            if (botConnectTimestamp > 0 && msgTime > 0 && msgTime < (botConnectTimestamp - 3)) {
                continue;
            }

            // Cache received message in memory for retry requests
            if (msg.key?.id && msg.message) {
                msgCache.set(msg.key.id, msg.message);
            }
            // Ignore group messages at the root so they never hit session ciphers
            if ((msg.key.remoteJid || '').endsWith('@g.us')) continue;

            const senderJid = msg.key.remoteJid;
            const senderPhone = (senderJid || '').replace(/@.*$/, '');
            const isFromMe = !!msg.key.fromMe;

            const text = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                ''
            ).trim();

            // Check if sender is Authorized Admin (Tanim using bot's own WhatsApp or GOMON developer)
            const cleanBotPhone = (config.bot_phone_number || '').replace(/\D/g, '');
            const cleanDevPhone = (config.developer_info?.whatsapp || '').replace(/\D/g, '');
            const isAdmin = isFromMe || senderPhone.includes(cleanBotPhone) || (cleanDevPhone && senderPhone.includes(cleanDevPhone));

            if (isAdmin && text) {
                const handled = await handleAdminBotToggle(text, senderJid);
                if (handled) continue;
            }

            // Normal customer messages ignore fromMe (bot never replies to its own sent messages)
            if (isFromMe) continue;

            // Process through burst debounce buffer
            handleIncomingBurstMessage(senderPhone, msg);
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

    // API: Live Chat Monitor Stream Endpoint
    if (parsedUrl.pathname === '/api/live-messages' && req.method === 'GET') {
        const sessionKey = getSessionKeyString();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            success: true,
            connected: isConnected,
            isBotPaused: isBotPaused,
            botPhone: config.bot_phone_number,
            platformName: config.platform_name || 'Mex Tanim Esports',
            totalLogs: liveChatLogs.length,
            messages: liveChatLogs
        }));
        return;
    }

    // API: Bot Connection Status & Live QR
    if (parsedUrl.pathname === '/api/bot-status' && req.method === 'GET') {
        const sessionKey = getSessionKeyString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            connected: isConnected,
            isBotPaused: isBotPaused,
            hasQr: !!currentQrDataUrl,
            qrImage: currentQrDataUrl || null,
            pairingCode: currentPairingCode,
            sessionKey: isConnected ? sessionKey : null,
            botPhone: config.bot_phone_number
        }));
        return;
    }

    // API: Live Gemini Diagnostic Endpoint
    if (parsedUrl.pathname === '/api/test-gemini' && req.method === 'GET') {
        const pool = getGeminiApiKeyPool();
        const testPayload = JSON.stringify({
            contents: [{ parts: [{ text: 'Hello, respond with: GEMINI_IS_WORKING' }] }]
        });
        const results = {
            totalKeysConfigured: pool.length,
            tests: []
        };

        const testModels = ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];
        for (let i = 0; i < pool.length; i++) {
            const k = pool[i];
            const mask = k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : 'KEY';
            const keyReport = { key: mask, models: {} };
            for (const m of testModels) {
                try {
                    const reply = await requestGeminiApi(m, testPayload, k, 6000);
                    keyReport.models[m] = { success: true, reply };
                } catch (e) {
                    keyReport.models[m] = { success: false, error: e.message };
                }
            }
            results.tests.push(keyReport);
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(results, null, 2));
        return;
    }

    // API: Logout / Reset Session (Change Number)
    if (parsedUrl.pathname === '/api/bot-logout' && req.method === 'POST') {
        try {
            sessionInvalidated = true;
            console.log('🔄 [LOGOUT REQUESTED] Clearing WhatsApp session for new number link...');
            if (sock) {
                try { await sock.logout(); } catch (_) { try { sock.end(); } catch (__) {} }
            }
            isConnected = false;
            currentQr = null;
            currentQrDataUrl = null;
            currentPairingCode = null;

            if (currentAuthState && currentAuthState.clearAuth) {
                await currentAuthState.clearAuth();
            }

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

    // Unified Mex Tanim Esports Dashboard & Live Monitor (Routes: /, /qr, /index.html)
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/qr' || parsedUrl.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mex Tanim Esports - AI WhatsApp Support Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 0%, #0c1527 0%, #030712 100%);
      font-family: 'Outfit', sans-serif;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px 16px;
    }
    .card {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(16px);
      width: 100%;
      max-width: 860px;
      border-radius: 24px;
      padding: 28px 24px;
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
    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin: 18px 0;
      text-align: left;
    }
    .stat-card {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 14px 18px;
    }
    .stat-label {
      font-size: 0.72rem;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .stat-value {
      font-size: 1.15rem;
      font-weight: 800;
      color: #fff;
    }
    .monitor-panel {
      background: #020617;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 18px;
      text-align: left;
    }
    .monitor-header {
      background: rgba(15, 23, 42, 0.9);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding: 12px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
    .monitor-title {
      font-size: 0.95rem;
      font-weight: 800;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .live-badge {
      font-size: 0.7rem;
      font-weight: 800;
      color: #4ade80;
      background: rgba(34, 197, 94, 0.12);
      border: 1px solid rgba(34, 197, 94, 0.3);
      padding: 3px 8px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .dot-live {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      animation: pulse 1.5s infinite;
    }
    .chat-feed {
      height: 480px;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .chat-feed::-webkit-scrollbar { width: 6px; }
    .chat-feed::-webkit-scrollbar-track { background: #020617; }
    .chat-feed::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
    .chat-item {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 12px 14px;
    }
    .chat-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
      font-size: 0.78rem;
    }
    .customer-id {
      font-weight: 800;
      color: #38bdf8;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .chat-time {
      color: #64748b;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.74rem;
    }
    .bubble-user {
      background: #0f172a;
      border-left: 3px solid #38bdf8;
      border-radius: 8px;
      padding: 8px 12px;
      margin-bottom: 6px;
      font-size: 0.9rem;
      color: #f1f5f9;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble-ai {
      background: rgba(16, 185, 129, 0.08);
      border-left: 3px solid #10b981;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 0.9rem;
      color: #d1fae5;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble-tag {
      font-size: 0.7rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 3px;
    }
    .empty-chat {
      margin: auto;
      text-align: center;
      color: #64748b;
      padding: 60px 20px;
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
      <h1 style="color: #f8fafc; font-size: 1.45rem; font-weight: 900; margin-bottom: 4px;">🎮 Mex Tanim Esports</h1>
      <p class="sub" style="margin-bottom: 14px;">২৪/৭ স্বয়ংক্রিয় WhatsApp গ্রাহক সেবা ও এআই সাপোর্ট ড্যাশবোর্ড</p>

      <!-- STATS OVERVIEW ROW -->
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-label">🤖 এআই বট অবস্থা</div>
          <div id="metricBotState" class="stat-value" style="color: #4ade80;">🟢 সক্রিয় (ACTIVE)</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">⏰ বাংলাদেশ সময়</div>
          <div id="metricTime" class="stat-value" style="font-family: 'JetBrains Mono', monospace; color: #38bdf8;">--:--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">💬 মোট ক্যাপচার্ড চ্যাট</div>
          <div id="metricChatCount" class="stat-value" style="color: #facc15;">০ টি</div>
        </div>
      </div>

      <!-- LIVE CHAT & AI MONITOR PANEL -->
      <div class="monitor-panel">
        <div class="monitor-header">
          <div class="monitor-title">
            <span>💬</span> লাইভ WhatsApp চ্যাট ও এআই রিপ্লাই ফিড
          </div>
          <div class="live-badge">
            <span class="dot-live"></span> রিয়েল-টাইমে আপডেট হচ্ছে
          </div>
        </div>
        <div id="chatFeedWindow" class="chat-feed">
          <div class="empty-chat">
            <div style="font-size: 2.4rem; margin-bottom: 8px;">📡</div>
            <div style="font-size: 0.95rem; font-weight: 700; color: #94a3b8; margin-bottom: 4px;">বট কাস্টমার মেসেজ শোনার জন্য প্রস্তুত</div>
            <div style="font-size: 0.82rem;">যেকোনো কাস্টমার হোয়াটসঅ্যাপে মেসেজ দিলে সাথে সাথে এখানে কাস্টমারের মেসেজ এবং এআই বটের স্বয়ংক্রিয় রিপ্লাই দেখা যাবে।</div>
          </div>
        </div>
      </div>

      <!-- PERMANENT AUTO-LOGIN KEY BOX -->
      <div style="background: rgba(34, 197, 94, 0.06); border: 1.5px dashed rgba(34, 197, 94, 0.3); border-radius: 14px; padding: 14px; text-align: left; margin-bottom: 14px;">
        <div style="font-size: 0.82rem; color: #4ade80; font-weight: 800; display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <span>🔑 পার্মানেন্ট সেশন কি (Render সেশন ব্যাকআপ)</span>
          <button onclick="copySessionKey()" id="btnCopyKey" style="background: #22c55e; color: #052e16; font-weight: 800; font-size: 0.78rem; border: none; padding: 5px 12px; border-radius: 6px; cursor: pointer;">কপি 📋</button>
        </div>
        <input type="text" id="sessionKeyBox" readonly style="width: 100%; box-sizing: border-box; background: #020617; border: 1px solid #334155; color: #38bdf8; font-family: monospace; font-size: 0.78rem; padding: 8px 10px; border-radius: 6px; outline: none;">
        <div id="copyAlert" style="display: none; color: #4ade80; font-size: 0.75rem; font-weight: 700; margin-top: 4px;">✓ Session Key কপি করা হয়েছে!</div>
      </div>

      <!-- CHANGE NUMBER / LOGOUT BUTTON -->
      <button onclick="changeNumberLogout()" id="btnLogout" style="width: 100%; padding: 11px; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; border-radius: 10px; font-size: 0.88rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
        <span>🔄</span> নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)
      </button>
    </div>

    <!-- NOT CONNECTED SCREEN -->
    <div id="viewScan">
      <h1>WhatsApp কানেক্ট করুন</h1>
      <p class="sub">যেকোনো WhatsApp নম্বর থেকে নিচের QR কোডটি স্ক্যান করুন অথবা নম্বর দিয়ে পেয়ার করুন:</p>

      <div class="qr-container" style="position: relative; min-height: 260px; display: flex; align-items: center; justify-content: center; background: #0b1120; border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); padding: 12px;">
        <div id="qrLoading" style="color: #94a3b8; font-size: 0.9rem; text-align: center; padding: 20px;">
          <div style="font-size: 2rem; margin-bottom: 8px;">⏳</div>
          <b>QR কোড তৈরি হচ্ছে...</b><br>
          <span style="font-size: 0.8rem; color: #64748b;">কয়েক সেকেন্ড অপেক্ষা করুন</span>
        </div>
        <img id="qrImage" src="" alt="WhatsApp QR Code" style="display: none; width: 100%; max-width: 260px; height: auto; border-radius: 12px; margin: auto;">
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
        <div style="font-size: 0.85rem; color: #94a3b8; font-weight: 600; margin-bottom: 8px;">অথবা ক্যামেরা স্ক্যান ছাড়া নম্বর দিয়ে লিংক করুন:</div>
        <input type="text" id="pairingPhoneInput" placeholder="আপনার ফোন নম্বর (যেমন: 88017XXXXXXXX)" value="${config.bot_phone_number || ''}" style="width: 100%; box-sizing: border-box; background: #020617; border: 1px solid #334155; color: #38bdf8; font-family: monospace; font-size: 0.95rem; padding: 10px 14px; border-radius: 8px; margin-bottom: 10px; text-align: center; outline: none;">
        <button class="btn-action" onclick="getPairingCode()" id="btnPair">Pairing Code তৈরি করুন 🔑</button>
        <div id="pairingCodeDisplay" class="pairing-code" style="display: none;">------</div>
        <div id="pairingHelp" style="display: none; font-size: 0.78rem; color: #94a3b8; margin-top: 6px;">
          ফোনে WhatsApp > Linked Devices > "Link with phone number instead" সিলেক্ট করে এই কোডটি লিখুন।
        </div>
      </div>
    </div>
  </div>

  <script>
    let lastMsgCount = -1;

    function updateLiveClock() {
      try {
        const str = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Dhaka',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
          hour12: true
        }).format(new Date());
        const el = document.getElementById('metricTime');
        if (el) el.innerText = str;
      } catch (_) {}
    }
    setInterval(updateLiveClock, 1000);
    updateLiveClock();

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    async function checkStatus() {
      try {
        const res = await fetch('/api/live-messages');
        const data = await res.json();

        const badge = document.getElementById('statusBadge');
        const viewConnected = document.getElementById('viewConnected');
        const viewScan = document.getElementById('viewScan');

        if (data.connected) {
          viewScan.style.display = 'none';
          viewConnected.style.display = 'block';

          if (data.isBotPaused) {
            badge.className = 'badge';
            badge.style.background = 'rgba(239, 68, 68, 0.15)';
            badge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
            badge.style.color = '#f87171';
            badge.innerHTML = '<span>⏸️</span> বট সাময়িকভাবে বন্ধ (PAUSED / OFF)';
            document.getElementById('metricBotState').innerText = '⏸️ বন্ধ (PAUSED)';
            document.getElementById('metricBotState').style.color = '#f87171';
          } else {
            badge.className = 'badge connected';
            badge.style.background = '';
            badge.style.borderColor = '';
            badge.style.color = '';
            badge.innerHTML = '<span>●</span> WhatsApp বট কানেক্টেড (Active 24/7)';
            document.getElementById('metricBotState').innerText = '🟢 সক্রিয় (ACTIVE)';
            document.getElementById('metricBotState').style.color = '#4ade80';
          }

          document.getElementById('metricChatCount').innerText = (data.totalLogs || 0) + ' টি';
          renderChatFeed(data.messages || []);

          // Also pull session key if empty
          const sb = document.getElementById('sessionKeyBox');
          if (sb && !sb.value) {
            fetch('/api/bot-status').then(r => r.json()).then(bs => {
              if (bs && bs.sessionKey) sb.value = bs.sessionKey;
            }).catch(() => {});
          }
        } else {
          viewScan.style.display = 'block';
          viewConnected.style.display = 'none';
          badge.className = 'badge waiting';
          badge.innerHTML = '<span>●</span> অপেক্ষমাণ: ডিভাইস লিংক করুন';

          // Fetch QR / Pairing data
          try {
            const bRes = await fetch('/api/bot-status');
            const bData = await bRes.json();
            if (bData.qrImage) {
              const qrImg = document.getElementById('qrImage');
              qrImg.src = bData.qrImage;
              qrImg.style.display = 'block';
              const qrLdr = document.getElementById('qrLoading');
              if (qrLdr) qrLdr.style.display = 'none';
            }
            if (bData.pairingCode) {
              document.getElementById('pairingCodeDisplay').innerText = bData.pairingCode;
              document.getElementById('pairingCodeDisplay').style.display = 'block';
              document.getElementById('pairingHelp').style.display = 'block';
            }
          } catch (_) {}
        }
      } catch (e) {
        console.error(e);
      }
    }

    function renderChatFeed(messages) {
      if (!Array.isArray(messages)) return;
      if (messages.length === lastMsgCount && messages.length > 0) return;
      lastMsgCount = messages.length;

      const feed = document.getElementById('chatFeedWindow');
      if (messages.length === 0) {
        feed.innerHTML = \`
          <div class="empty-chat">
            <div style="font-size: 2.4rem; margin-bottom: 8px;">📡</div>
            <div style="font-size: 0.95rem; font-weight: 700; color: #94a3b8; margin-bottom: 4px;">বট কাস্টমার মেসেজ শোনার জন্য প্রস্তুত</div>
            <div style="font-size: 0.82rem;">যেকোনো কাস্টমার হোয়াটসঅ্যাপে মেসেজ দিলে সাথে সাথে এখানে কাস্টমারের মেসেজ এবং এআই বটের স্বয়ংক্রিয় রিপ্লাই দেখা যাবে।</div>
          </div>\`;
        return;
      }

      let html = '';
      for (const m of messages) {
        const isPaused = m.status === 'paused';
        const hasPayment = Boolean(m.isPaymentProof);

        html += \`
          <div class="chat-item">
            <div class="chat-meta">
              <div class="customer-id">
                <span>👤</span>
                <span>\${escapeHtml(m.customer || 'কাস্টমার')}</span>
                \${m.customerName ? \`<span style="color:#64748b; font-size:0.75rem; font-weight:normal;">(\${escapeHtml(m.customerName)})</span>\` : ''}
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                \${hasPayment ? '<span class="badge" style="background:rgba(234,179,8,0.15); border:1px solid rgba(234,179,8,0.4); color:#facc15; padding:2px 8px; font-size:0.7rem; margin:0;">💰 পেমেন্ট / স্ক্রিনশট</span>' : ''}
                \${isPaused ? '<span class="badge" style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#f87171; padding:2px 8px; font-size:0.7rem; margin:0;">⏸️ বট অফ ছিল</span>' : ''}
                <span class="chat-time">⏰ \${escapeHtml(m.time || '')}</span>
              </div>
            </div>

            <div class="bubble-user">
              <div class="bubble-tag" style="color: #38bdf8;">💬 কাস্টমার মেসেজ:</div>
              <div>\${escapeHtml(m.message || '[মেসেজ ফাঁকা]')}</div>
            </div>

            <div class="bubble-ai">
              <div class="bubble-tag" style="color: #34d399;">🤖 Mex Tanim AI রিপ্লাই:</div>
              <div>\${escapeHtml(m.reply || '')}</div>
            </div>
          </div>\`;
      }
      feed.innerHTML = html;
    }

    function copySessionKey() {
      const box = document.getElementById('sessionKeyBox');
      if (!box || !box.value) {
        alert('কোনো সেশন কি পাওয়া যায়নি। বট কানেক্ট হলে এটি পাওয়া যাবে।');
        return;
      }
      box.select();
      navigator.clipboard.writeText(box.value).then(() => {
        const al = document.getElementById('copyAlert');
        if (al) {
          al.style.display = 'block';
          setTimeout(() => { al.style.display = 'none'; }, 3000);
        }
      });
    }

    async function changeNumberLogout() {
      if (!confirm('আপনি কি নিশ্চিত যে বর্তমান WhatsApp সেশনটি Logout করতে চান?\\n\\nLogout করার পর নতুন QR কোড দিয়ে আবার লিংক করতে হবে।')) return;
      const btn = document.getElementById('btnLogout');
      btn.innerText = 'লগআউট হচ্ছে...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/bot-logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('সফলভাবে লগআউট হয়েছে! নতুন QR কোডের জন্য অপেক্ষা করুন...');
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
      const input = document.getElementById('pairingPhoneInput');
      const customPhone = (input ? input.value : '').trim();
      btn.innerText = 'কোড তৈরি হচ্ছে...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/request-pairing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: customPhone || '${config.bot_phone_number}' })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('pairingCodeDisplay').innerText = data.pairingCode;
          document.getElementById('pairingCodeDisplay').style.display = 'block';
          document.getElementById('pairingHelp').style.display = 'block';
          btn.innerText = 'নতুন কোড পান 🔄';
          btn.disabled = false;
        } else {
          alert(data.message || 'Error');
          btn.innerText = 'Pairing Code তৈরি করুন 🔑';
          btn.disabled = false;
        }
      } catch (err) {
        alert('এরর: ' + err.message);
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


});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [AI BOT DASHBOARD & LIVE FEED READY] Open in browser: http://localhost:${PORT}`);
    console.log(`🔗 [DASHBOARD & QR LINK]: http://localhost:${PORT}`);

    // Render 24/7 Keep-Alive Auto-Ping (Prevents sleep on free tier)
    const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
    if (keepAliveUrl) {
        const pingTarget = keepAliveUrl.startsWith('http') ? keepAliveUrl : `https://${keepAliveUrl}`;
        setInterval(() => {
            try {
                const client = pingTarget.startsWith('https') ? https : http;
                client.get(pingTarget, () => {}).on('error', () => {});
            } catch (_) {}
        }, 10 * 60 * 1000); // Ping every 10 minutes
        console.log(`⏱️ [RENDER 24/7 KEEP-ALIVE] Auto-pinging ${pingTarget} every 10 mins.`);
    }
});

startWhatsAppBot();

// Graceful shutdown handler for Render deployments & process restarts
// Prevents overlapping instances and eliminates Bad MAC errors during deploy
async function handleGracefulShutdown(signal) {
    console.log(`\n🛑 [SHUTDOWN] Received ${signal}. Gracefully disconnecting WhatsApp and closing resources...`);
    try {
        if (sock) {
            try {
                sock.end();
                console.log('🔌 [WHATSAPP DISCONNECTED] Closed Baileys socket connection cleanly.');
            } catch (_) {}
        }
        if (mongoClient) {
            try {
                await mongoClient.close();
                console.log('📦 [MONGODB CLOSED] Closed MongoDB client connection cleanly.');
            } catch (_) {}
        }
    } finally {
        process.exit(0);
    }
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error('⚠️ [SAFE UNCAUGHT EXCEPTION]:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ [SAFE UNHANDLED REJECTION]:', reason?.message || reason);
});
