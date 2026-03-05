/**
 * VPS WORKER SERVER (Headless - 5 Bots)
 * Connects to central dashboard via WebSocket
 * Auto-AFKs on spawn, tracks usernames
 */

const { createClient } = require('bedrock-protocol');
const WebSocket = require('ws');
const path = require('path');
const axios = require('axios');

// === [ CONFIG ] ===
const CONFIG = {
    // This VPS's identity
    WORKER_ID: process.env.WORKER_ID || 'VPS-1',  // Change per VPS: VPS-1, VPS-2, etc.
    SLOT_OFFSET: parseInt(process.env.SLOT_OFFSET) || 0,  // 0, 5, 10, 15, etc.
    
    // Minecraft Server
    SERVER: {
        HOST: 'oce.donutsmp.net',
        PORT: 19132,
        VERSION: '1.21.111'
    },
    
    // Worker Settings
    WORKER: {
        BOTS_PER_WORKER: 5,
        LOGIN_DELAY: 20000,
        AUTO_AFK_ON_SPAWN: true,
        AUTO_RECONNECT: true,
        RECONNECT_CHECK_INTERVAL: 600000
    },
    
    // Central Dashboard Connection
    CENTRAL_WS_URL: process.env.CENTRAL_WS_URL || 'ws://CENTRAL_IP:4001',
    
    // Discord Webhook
    WEBHOOK_URL: 'https://discord.com/api/webhooks/1467481538949152873/S_sDq_Mj5IGxD9yf2xWI_kvRnZJPovGb_6JAOWQD4cSJHh3zcazG1BaGppfuC4W5jf1u',
    
    // Timing
    TIMING: {
        AFK_CLICK_DELAY: 1200,
        AFK_TIMEOUT: 20000,
        BUY_STEP_DELAY: 1200,
        BUY_TIMEOUT: 20000,
        COMMAND_STAGGER: 1500
    }
};

// === [ STATE ] ===
let activeBots = {};
let botData = {};  // Store: username, status, shards, etc.
let loginQueue = [];
let centralWS = null;
let shouldBeOnline = {};

// Initialize bot data
for (let i = 0; i < CONFIG.WORKER.BOTS_PER_WORKER; i++) {
    const globalSlot = CONFIG.SLOT_OFFSET + i + 1;  // 1-300 global slot
    const localSlot = i;  // 0-4 local slot
    
    botData[localSlot] = {
        globalSlot: globalSlot,
        username: null,
        status: 'Offline',
        shards: '0',
        lastSeen: null
    };
    
    shouldBeOnline[localSlot] = false;
}

// === [ WEBSOCKET TO CENTRAL ] ===

function connectToCentral() {
    console.log(`🔗 Connecting to Central Dashboard: ${CONFIG.CENTRAL_WS_URL}`);
    
    centralWS = new WebSocket(CONFIG.CENTRAL_WS_URL);
    
    centralWS.on('open', () => {
        console.log('✅ Connected to Central Dashboard');
        
        // Register this worker
        send Central({
            type: 'worker_register',
            workerId: CONFIG.WORKER_ID,
            slotOffset: CONFIG.SLOT_OFFSET,
            botsCount: CONFIG.WORKER.BOTS_PER_WORKER,
            slots: Object.keys(botData).map(k => botData[k].globalSlot)
        });
        
        // Send initial status
        sendBotStatusUpdate();
    });
    
    centralWS.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleCentralCommand(message);
        } catch (err) {
            console.error('❌ WS message error:', err.message);
        }
    });
    
    centralWS.on('close', () => {
        console.log('⚠️  Disconnected from Central. Reconnecting in 5s...');
        setTimeout(connectToCentral, 5000);
    });
    
    centralWS.on('error', (err) => {
        console.error('❌ WebSocket error:', err.message);
    });
}

function sendToCentral(data) {
    if (centralWS && centralWS.readyState === WebSocket.OPEN) {
        centralWS.send(JSON.stringify({ workerId: CONFIG.WORKER_ID, ...data }));
    }
}

function sendBotStatusUpdate() {
    const status = {};
    Object.keys(botData).forEach(localSlot => {
        const bot = botData[localSlot];
        status[bot.globalSlot] = {
            status: bot.status,
            username: bot.username,
            shards: bot.shards,
            workerId: CONFIG.WORKER_ID
        };
    });
    
    sendToCentral({
        type: 'status_update',
        bots: status
    });
}

function handleCentralCommand(message) {
    const { type, slot, slots, command, message: chatMsg } = message;
    
    // Convert global slot to local slot
    const localSlot = slot ? slot - CONFIG.SLOT_OFFSET - 1 : null;
    
    switch (type) {
        case 'start_bot':
            if (localSlot !== null && localSlot >= 0 && localSlot < CONFIG.WORKER.BOTS_PER_WORKER) {
                startBot(localSlot);
            }
            break;
            
        case 'stop_bot':
            if (localSlot !== null) {
                stopBot(localSlot);
            }
            break;
            
        case 'send_chat':
            if (slots) {
                slots.forEach(globalSlot => {
                    const local = globalSlot - CONFIG.SLOT_OFFSET - 1;
                    if (local >= 0 && local < CONFIG.WORKER.BOTS_PER_WORKER && activeBots[local]) {
                        sendChat(local, chatMsg);
                    }
                });
            }
            break;
            
        case 'home':
            if (slots) {
                slots.forEach(globalSlot => {
                    const local = globalSlot - CONFIG.SLOT_OFFSET - 1;
                    if (local >= 0 && local < CONFIG.WORKER.BOTS_PER_WORKER && activeBots[local]) {
                        sendChat(local, '/home 1');
                    }
                });
            }
            break;
            
        case 'afk':
            if (slots) {
                slots.forEach(globalSlot => {
                    const local = globalSlot - CONFIG.SLOT_OFFSET - 1;
                    if (local >= 0 && local < CONFIG.WORKER.BOTS_PER_WORKER && activeBots[local]) {
                        autoAfkSnipe(local);
                    }
                });
            }
            break;
            
        case 'buy':
            if (slots) {
                slots.forEach(globalSlot => {
                    const local = globalSlot - CONFIG.SLOT_OFFSET - 1;
                    if (local >= 0 && local < CONFIG.WORKER.BOTS_PER_WORKER && activeBots[local]) {
                        autoBuy(local);
                    }
                });
            }
            break;
    }
}

// === [ BOT FUNCTIONS ] ===

function sendChat(localSlot, message) {
    const client = activeBots[localSlot];
    if (!client) return;
    
    try {
        client.write('text', {
            type: 'chat',
            needs_translation: false,
            source_name: client.username || 'bot',
            xuid: '',
            platform_chat_id: '',
            message: String(message),
            filtered_message: '',
            blob: ''
        });
    } catch (err) {
        console.error(`[Slot ${botData[localSlot].globalSlot}] Chat error:`, err.message);
    }
}

function autoAfkSnipe(localSlot) {
    const client = activeBots[localSlot];
    if (!client) return;
    
    sendChat(localSlot, '/afk');
    
    const afkListener = (packet) => {
        if (packet.data.name === 'inventory_content' && packet.data.params.window_id !== 0) {
            const pData = packet.data.params;
            
            if (pData.input && pData.input[49] && pData.input[49].stack_id) {
                const stackId = pData.input[49].stack_id;
                
                setTimeout(() => {
                    try {
                        client.write('item_stack_request', {
                            requests: [{
                                request_id: Math.floor(Math.random() * -2000),
                                actions: [{
                                    type_id: 'place',
                                    count: 1,
                                    source: { slot_type: 'container', slot: 49, stack_id: stackId },
                                    destination: { slot_type: 'container', slot: 50, stack_id: 0 }
                                }],
                                custom_names: [],
                                cause: -1
                            }]
                        });
                        
                        sendLog(localSlot, '✅ AFK clicked');
                    } catch (err) {
                        sendLog(localSlot, '❌ AFK click failed');
                    }
                    
                    client.removeListener('packet', afkListener);
                }, CONFIG.TIMING.AFK_CLICK_DELAY);
            }
        }
    };
    
    client.on('packet', afkListener);
    setTimeout(() => client.removeListener('packet', afkListener), CONFIG.TIMING.AFK_TIMEOUT);
}

function autoBuy(localSlot) {
    const client = activeBots[localSlot];
    if (!client) return;
    
    sendChat(localSlot, '/shardshop');
    
    let step = 1;
    let stackId = null;
    
    const buyListener = (packet) => {
        if (packet.data.name === 'inventory_content' && packet.data.params.window_id !== 0) {
            const pData = packet.data.params;
            
            if (step === 1 && pData.input && pData.input[13]) {
                stackId = pData.input[13].stack_id;
                
                setTimeout(() => {
                    try {
                        client.write('item_stack_request', {
                            requests: [{
                                request_id: Math.floor(Math.random() * -2000),
                                actions: [{
                                    type_id: 'place',
                                    count: 1,
                                    source: { slot_type: 'container', slot: 13, stack_id: stackId },
                                    destination: { slot_type: 'container', slot: 50, stack_id: 0 }
                                }],
                                custom_names: [],
                                cause: -1
                            }]
                        });
                        step = 2;
                    } catch (err) {
                        client.removeListener('packet', buyListener);
                    }
                }, CONFIG.TIMING.BUY_STEP_DELAY);
            }
            else if (step === 2 && pData.input && pData.input[15]) {
                stackId = pData.input[15].stack_id;
                
                setTimeout(() => {
                    try {
                        client.write('item_stack_request', {
                            requests: [{
                                request_id: Math.floor(Math.random() * -2000),
                                actions: [{
                                    type_id: 'place',
                                    count: 1,
                                    source: { slot_type: 'container', slot: 15, stack_id: stackId },
                                    destination: { slot_type: 'container', slot: 50, stack_id: 0 }
                                }],
                                custom_names: [],
                                cause: -1
                            }]
                        });
                        
                        sendLog(localSlot, '🛒 Buy complete');
                    } catch (err) {
                        sendLog(localSlot, '❌ Buy failed');
                    }
                    
                    client.removeListener('packet', buyListener);
                }, CONFIG.TIMING.BUY_STEP_DELAY);
            }
        }
    };
    
    client.on('packet', buyListener);
    setTimeout(() => client.removeListener('packet', buyListener), CONFIG.TIMING.BUY_TIMEOUT);
}

function sendLog(localSlot, message) {
    const globalSlot = botData[localSlot].globalSlot;
    const username = botData[localSlot].username || 'Unknown';
    
    console.log(`[Slot ${globalSlot}/${username}] ${message}`);
    
    sendToCentral({
        type: 'log',
        slot: globalSlot,
        message: `[Slot ${globalSlot}/${username}] ${message}`
    });
}

// === [ BOT ENGINE ] ===

async function startBot(localSlot) {
    if (activeBots[localSlot]) {
        console.log(`Bot ${localSlot} already running`);
        return;
    }
    
    const globalSlot = botData[localSlot].globalSlot;
    
    shouldBeOnline[localSlot] = true;
    botData[localSlot].status = 'Connecting';
    sendBotStatusUpdate();
    
    console.log(`🚀 Starting bot slot ${globalSlot} (local ${localSlot})`);
    
    const client = createClient({
        host: CONFIG.SERVER.HOST,
        port: CONFIG.SERVER.PORT,
        version: CONFIG.SERVER.VERSION,
        auth: 'microsoft',
        profilesFolder: path.resolve(__dirname, 'auth_cache', `slot_${globalSlot}`),
        onMsaCode: (m) => {
            console.log(`🔐 Slot ${globalSlot} MSA Code: ${m.user_code}`);
            sendToCentral({
                type: 'msa_code',
                slot: globalSlot,
                code: m.user_code,
                url: m.verification_uri
            });
        }
    });
    
    activeBots[localSlot] = client;
    
    // Track username on spawn
    client.on('spawn', () => {
        botData[localSlot].status = 'Online';
        botData[localSlot].lastSeen = Date.now();
        
        // Extract username from client
        if (client.username) {
            botData[localSlot].username = client.username;
        }
        
        sendBotStatusUpdate();
        sendLog(localSlot, `✅ Spawned (${client.username})`);
        
        // Auto-AFK on spawn
        if (CONFIG.WORKER.AUTO_AFK_ON_SPAWN) {
            setTimeout(() => {
                autoAfkSnipe(localSlot);
            }, 3000);
        }
    });
    
    // Listen for text messages
    client.on('packet', (packet) => {
        if (packet.data.name !== 'text') return;
        
        const pData = packet.data.params;
        const msg = (pData.message || '') + (pData.parameters ? ' ' + pData.parameters.join(' ') : '');
        const cleanMsg = msg.replace(/§[0-9a-fk-or]/g, '').trim();
        
        if (!cleanMsg) return;
        
        // Check for shards
        if (cleanMsg.toLowerCase().includes('shards')) {
            const match = cleanMsg.match(/(\d+(\.\d+)?K?)/i);
            if (match) {
                botData[localSlot].shards = match[0];
                sendBotStatusUpdate();
            }
        }
        
        // Check for ban/kick
        if (cleanMsg.toLowerCase().includes('banned') || 
            cleanMsg.toLowerCase().includes('kicked') ||
            cleanMsg.toLowerCase().includes('you have been removed')) {
            
            sendDiscordAlert(globalSlot, botData[localSlot].username, 'BAN/KICK', cleanMsg);
        }
        
        sendLog(localSlot, cleanMsg);
    });
    
    client.on('error', (err) => {
        console.error(`[Slot ${globalSlot}] Error:`, err.message);
        cleanup(localSlot);
    });
    
    client.on('close', () => {
        console.log(`[Slot ${globalSlot}] Disconnected`);
        
        // Check if expected disconnect or crash
        if (shouldBeOnline[localSlot]) {
            sendDiscordAlert(globalSlot, botData[localSlot].username, 'OFFLINE', 'Unexpected disconnect');
        }
        
        cleanup(localSlot);
    });
}

function cleanup(localSlot) {
    if (activeBots[localSlot]) {
        try {
            activeBots[localSlot].disconnect();
        } catch (e) {}
        delete activeBots[localSlot];
    }
    
    botData[localSlot].status = 'Offline';
    sendBotStatusUpdate();
}

function stopBot(localSlot) {
    shouldBeOnline[localSlot] = false;
    cleanup(localSlot);
}

// === [ DISCORD WEBHOOK ] ===

async function sendDiscordAlert(globalSlot, username, type, reason) {
    if (!CONFIG.WEBHOOK_URL || CONFIG.WEBHOOK_URL.includes('YOUR_WEBHOOK')) return;
    
    const color = type === 'BAN/KICK' ? 0xFF0000 : 0xFFA500;
    
    try {
        await axios.post(CONFIG.WEBHOOK_URL, {
            embeds: [{
                title: `⚠️ BOT ALERT - ${type}`,
                description: `**Slot:** ${globalSlot}\n**Username:** ${username || 'Unknown'}\n**Worker:** ${CONFIG.WORKER_ID}\n**Reason:** ${reason}`,
                color: color,
                timestamp: new Date()
            }]
        });
    } catch (err) {
        console.error('Webhook error:', err.message);
    }
}

async function sendStatusReport() {
    if (!CONFIG.WEBHOOK_URL || CONFIG.WEBHOOK_URL.includes('YOUR_WEBHOOK')) return;
    
    let onlineCount = 0;
    let description = `**Worker:** ${CONFIG.WORKER_ID}\n**Slots:** ${CONFIG.SLOT_OFFSET + 1}-${CONFIG.SLOT_OFFSET + CONFIG.WORKER.BOTS_PER_WORKER}\n\n`;
    
    Object.keys(botData).forEach(localSlot => {
        const bot = botData[localSlot];
        if (bot.status === 'Online') onlineCount++;
        
        const statusEmoji = bot.status === 'Online' ? '✅' : '❌';
        description += `${statusEmoji} **Slot ${bot.globalSlot}** (${bot.username || 'Unknown'}): ${bot.shards} shards\n`;
    });
    
    description += `\n**Online:** ${onlineCount}/${CONFIG.WORKER.BOTS_PER_WORKER}`;
    
    try {
        await axios.post(CONFIG.WEBHOOK_URL, {
            embeds: [{
                title: `📊 Status Report - ${CONFIG.WORKER_ID}`,
                description,
                color: 0x3498db,
                timestamp: new Date()
            }]
        });
    } catch (err) {
        console.error('Webhook error:', err.message);
    }
}

// === [ AUTO RECONNECT ] ===

function checkReconnect() {
    Object.keys(botData).forEach(localSlot => {
        if (shouldBeOnline[localSlot] && botData[localSlot].status === 'Offline' && !activeBots[localSlot]) {
            console.log(`🔄 Auto-reconnecting slot ${botData[localSlot].globalSlot}`);
            startBot(parseInt(localSlot));
        }
    });
}

if (CONFIG.WORKER.AUTO_RECONNECT) {
    setInterval(checkReconnect, CONFIG.WORKER.RECONNECT_CHECK_INTERVAL);
}

// === [ STARTUP ] ===

console.log('╔═══════════════════════════════════════╗');
console.log('║   🤖 VPS WORKER (Headless - 5 Bots) ║');
console.log('╚═══════════════════════════════════════╝');
console.log(`Worker ID: ${CONFIG.WORKER_ID}`);
console.log(`Slot Offset: ${CONFIG.SLOT_OFFSET}`);
console.log(`Global Slots: ${CONFIG.SLOT_OFFSET + 1}-${CONFIG.SLOT_OFFSET + CONFIG.WORKER.BOTS_PER_WORKER}`);
console.log(`Auto-AFK: ${CONFIG.WORKER.AUTO_AFK_ON_SPAWN ? 'Enabled' : 'Disabled'}`);
console.log('');

// Connect to central dashboard
connectToCentral();

// Status report every 30 min
setInterval(sendStatusReport, 1800000);
