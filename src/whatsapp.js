const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info');

// Logger (silent in production to keep console clean)
const logger = pino({ level: 'silent' });

let sock = null;
let connectionStatus = 'disconnected';
let onMessageCallback = null;

/**
 * Initialize and connect to WhatsApp
 * Shows QR code on first connection, auto-reconnects after that
 * @param {Function} messageHandler - Callback for incoming messages
 * @returns {Promise<Object>} The WhatsApp socket instance
 */
async function connectWhatsApp(messageHandler) {
  onMessageCallback = messageHandler;
  
  // Ensure auth directory exists
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  
  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false, // We'll handle QR display ourselves
    browser: ['Soham Bot', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
  });
  
  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('\n' + '='.repeat(50));
      console.log('📱 SCAN THIS QR CODE WITH YOUR WHATSAPP:');
      console.log('   Go to WhatsApp > Linked Devices > Link a Device');
      console.log('='.repeat(50) + '\n');
      qrcode.generate(qr, { small: true });
      console.log('\n' + '='.repeat(50));
      console.log('⏳ Waiting for scan...');
      console.log('='.repeat(50) + '\n');
      connectionStatus = 'waiting_for_qr';
    }
    
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;
      
      console.log(`\n⚠️  Connection closed. Status code: ${statusCode}`);
      
      if (statusCode === reason.loggedOut) {
        console.log('🚪 Logged out! Deleting session and stopping...');
        // Delete auth info so next start will show QR
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        connectionStatus = 'logged_out';
        process.exit(1);
      } else {
        // Reconnect for all other disconnect reasons
        console.log('🔄 Reconnecting in 5 seconds...');
        connectionStatus = 'reconnecting';
        await delay(5000);
        await connectWhatsApp(messageHandler);
      }
    }
    
    if (connection === 'open') {
      console.log('\n' + '🎉'.repeat(20));
      console.log('\n✅ WHATSAPP CONNECTED SUCCESSFULLY!');
      console.log(`📞 Connected as: ${sock.user?.id || 'Unknown'}`);
      console.log(`👤 Name: ${sock.user?.name || 'Unknown'}`);
      console.log('\n' + '🎉'.repeat(20) + '\n');
      connectionStatus = 'connected';
    }
  });
  
  // Save credentials when updated
  sock.ev.on('creds.update', saveCreds);
  
  // Handle incoming messages
  sock.ev.on('messages.upsert', async (messageUpdate) => {
    if (messageUpdate.type !== 'notify') return;
    
    for (const msg of messageUpdate.messages) {
      // Skip messages from self
      if (msg.key.fromMe) continue;
      // Skip status updates
      if (msg.key.remoteJid === 'status@broadcast') continue;
      // Skip group messages
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      
      const sender = msg.key.remoteJid;
      const text = msg.message?.conversation 
        || msg.message?.extendedTextMessage?.text 
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || '';
      
      if (text && onMessageCallback) {
        const senderName = msg.pushName || 'Customer';
        console.log(`\n📩 Incoming message from ${senderName} (${sender}): ${text}`);
        onMessageCallback(sender, text, senderName, msg);
      }
    }
  });
  
  return sock;
}

/**
 * Send a text message to a WhatsApp number
 * Includes typing simulation for natural feel
 * @param {string} jid - WhatsApp JID (91XXXXXXXXXX@s.whatsapp.net)
 * @param {string} text - Message text to send
 * @returns {Promise<boolean>} Success status
 */
async function sendMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') {
    console.log('❌ Cannot send message - not connected to WhatsApp');
    return false;
  }
  
  try {
    // Simulate typing (makes it look natural)
    await sock.presenceSubscribe(jid);
    await delay(500);
    await sock.sendPresenceUpdate('composing', jid);
    
    // Typing duration based on message length (roughly 50ms per character)
    const typingDuration = Math.min(Math.max(text.length * 50, 2000), 8000);
    await delay(typingDuration);
    
    // Send the message
    await sock.sendMessage(jid, { text });
    
    // Stop typing indicator
    await sock.sendPresenceUpdate('paused', jid);
    
    console.log(`✅ Message sent to ${jid}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send message to ${jid}:`, error.message);
    return false;
  }
}

/**
 * Check if connected to WhatsApp
 * @returns {boolean}
 */
function isConnected() {
  return connectionStatus === 'connected';
}

/**
 * Get current connection status
 * @returns {string}
 */
function getStatus() {
  return connectionStatus;
}

/**
 * Get the socket instance
 * @returns {Object}
 */
function getSocket() {
  return sock;
}

/**
 * Disconnect from WhatsApp
 */
async function disconnect() {
  if (sock) {
    await sock.end();
    connectionStatus = 'disconnected';
    console.log('🔌 Disconnected from WhatsApp');
  }
}

module.exports = {
  connectWhatsApp,
  sendMessage,
  isConnected,
  getStatus,
  getSocket,
  disconnect
};
