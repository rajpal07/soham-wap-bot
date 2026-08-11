const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info');

// Logger (silent in production to keep console clean)
const logger = pino({ level: 'silent' });

// Suppress internal libsignal encryption session debug output
const origConsoleLog = console.log;
const origConsoleError = console.error;
const origStdoutWrite = process.stdout.write;

console.log = function(...args) {
  if (typeof args[0] === 'string' && (args[0].includes('Closing session') || args[0].includes('SessionEntry'))) return;
  origConsoleLog.apply(console, args);
};

console.error = function(...args) {
  if (typeof args[0] === 'string' && (args[0].includes('Closing session') || args[0].includes('SessionEntry'))) return;
  origConsoleError.apply(console, args);
};

process.stdout.write = function(chunk, encoding, callback) {
  if (typeof chunk === 'string' && (chunk.includes('Closing session') || chunk.includes('SessionEntry'))) {
    if (typeof callback === 'function') callback();
    return true;
  }
  return origStdoutWrite.apply(process.stdout, arguments);
};

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
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'), // Official Chrome on macOS signature (fixes "Can't link new devices" error)
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
      // Extract text or button/list response
      let text = msg.message?.conversation 
        || msg.message?.extendedTextMessage?.text 
        || msg.message?.buttonsResponseMessage?.selectedButtonId
        || msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId
        || msg.message?.templateButtonReplyMessage?.selectedId
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || '';
        
      // Extract native flow response if present
      if (!text && msg.message?.interactiveResponseMessage) {
        try {
          const params = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson || '{}');
          text = params.id || params.title || 'Selected Menu Option';
        } catch (e) {}
      }
      
      // Extract Poll Vote Updates (when user taps an option in WhatsApp Poll)
      if (!text && (msg.message?.pollUpdateMessage || msg.pollUpdates)) {
        console.log(`\n📊 Poll vote detected from ${sender}!`);
        text = '1'; // Default option trigger for poll selection
        
        // Try decoding poll update if possible
        try {
          const pollUpdate = msg.message?.pollUpdateMessage || (msg.pollUpdates && msg.pollUpdates[0]);
          if (pollUpdate?.vote?.selectedOptions?.length > 0) {
            text = '1';
          }
        } catch (e) {}
      }
      
      if (text && onMessageCallback) {
        const senderName = msg.pushName || 'Customer';
        console.log(`\n📩 Incoming message/selection from ${senderName} (${sender}): ${text}`);
        onMessageCallback(sender, text, senderName, msg);
      }
    }
  });
  
  // Listen for poll updates specifically emitted by Baileys
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      if (update.update?.pollUpdates && onMessageCallback) {
        const sender = update.key.remoteJid;
        if (sender && !update.key.fromMe && !sender.endsWith('@g.us')) {
          console.log(`\n📊 Native Poll Vote update received from ${sender}`);
          onMessageCallback(sender, '1', 'Customer', update);
        }
      }
    }
  });
  
  return sock;
}

/**
 * Send a text or interactive menu message to a WhatsApp number
 * Includes typing simulation for natural feel
 * @param {string} jid - WhatsApp JID (91XXXXXXXXXX@s.whatsapp.net)
 * @param {string|Object} content - Message text or interactive config object
 * @returns {Promise<boolean>} Success status
 */
async function sendMessage(jid, content) {
  if (!sock || connectionStatus !== 'connected') {
    console.log('❌ Cannot send message - not connected to WhatsApp');
    return false;
  }
  
  try {
    const textStr = typeof content === 'string' ? content : (content.text || '');
    const menuMode = process.env.MENU_MODE || 'poll';
    
    // Simulate typing (makes it look natural)
    await sock.presenceSubscribe(jid);
    await delay(500);
    await sock.sendPresenceUpdate('composing', jid);
    
    const typingDuration = Math.min(Math.max(textStr.length * 50, 1500), 4000);
    await delay(typingDuration);
    
    if (menuMode === 'poll' || menuMode === 'interactive_poll') {
      console.log('📊 Sending Native WhatsApp Interactive Poll Menu...');
      await sendNativePoll(jid, textStr);
    } else if (menuMode === 'list') {
      console.log('📋 Sending Native List Message...');
      await sendNativeList(jid, textStr);
    } else if (menuMode === 'buttons') {
      console.log('🔘 Sending Quick Reply Buttons Message...');
      await sendNativeButtons(jid, textStr);
    } else {
      await sock.sendMessage(jid, { text: textStr });
    }
    
    await sock.sendPresenceUpdate('paused', jid);
    console.log(`✅ Message sent to ${jid}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send message to ${jid}:`, error.message);
    try {
      await sock.sendMessage(jid, { text: typeof content === 'string' ? content : content.text });
      return true;
    } catch (e) {
      return false;
    }
  }
}

const BIZ_NAME = process.env.BUSINESS_NAME || 'Diwan Electronics';

/**
 * 0. Native WhatsApp Interactive Poll Menu (Works 100% natively on all WhatsApp clients)
 */
async function sendNativePoll(jid, bodyText) {
  const crypto = require('crypto');
  const cleanBody = bodyText.replace(/Reply 1, 2 ya 3 karo[\s\S]*/gi, '').trim();
  
  // Check if target is self (messaging your own logged-in number)
  const selfNumber = sock?.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
  const targetNumber = jid.replace(/\D/g, '');
  const isSelf = selfNumber && targetNumber.includes(selfNumber);

  if (isSelf) {
    // Self-chat: send formatted text menu
    const fullText = cleanBody + `\n\nReply 1, 2 ya 3 karo:\n1️⃣ Doorstep Repair / Service 🛠️\n2️⃣ Remotes & Cables Delivery 🔌\n3️⃣ Naye Offers & Help 🎁`;
    await sock.sendMessage(jid, { text: fullText });
  } else {
    // 1. Send personalized text greeting first
    await sock.sendMessage(jid, { text: cleanBody });
    
    await delay(1500);
    
    // 2. Send Native WhatsApp Interactive Poll with explicit crypto messageSecret
    await sock.sendMessage(
      jid,
      {
        poll: {
          name: 'Aapko kis service ki jankari chahiye? (Tap an option below 👇)',
          values: [
            '1️⃣ Doorstep Repair / Service 🛠️',
            '2️⃣ Remotes & Cables Delivery 🔌',
            '3️⃣ Naye Offers & Help 🎁'
          ],
          selectableCount: 1
        }
      },
      { messageSecret: crypto.randomBytes(32) }
    );
  }
}

/**
 * 1. Native WhatsApp List Message (Clickable slide-up menu drawer)
 */
async function sendNativeList(jid, bodyText) {
  const cleanBody = bodyText.replace(/Reply 1, 2 ya 3 karo[\s\S]*/gi, '').trim();
  await sock.sendMessage(jid, {
    text: cleanBody,
    footer: BIZ_NAME,
    title: BIZ_NAME,
    buttonText: 'View Options 📋',
    sections: [
      {
        title: 'Our Services & Support',
        rows: [
          { title: 'Doorstep Repair & Service 🛠️', rowId: '1', description: 'AC, Fridge, TV, Washing Machine, Oven' },
          { title: 'Remotes & Cables Delivery 🔌', rowId: '2', description: 'TV Remotes, HDMI, Ethernet & Wires' },
          { title: 'Naye Offers & Help 🎁', rowId: '3', description: 'Special discounts & product advice' }
        ]
      }
    ]
  });
}

/**
 * 2. Native Quick Reply Buttons (1-3 quick action buttons below message)
 */
async function sendNativeButtons(jid, bodyText) {
  const cleanBody = bodyText.replace(/Reply 1, 2 ya 3 karo[\s\S]*/gi, '').trim();
  await sock.sendMessage(jid, {
    text: cleanBody,
    footer: BIZ_NAME,
    buttons: [
      { buttonId: '1', buttonText: { displayText: 'Doorstep Repair 🛠️' }, type: 1 },
      { buttonId: '2', buttonText: { displayText: 'Cable & Remotes 🔌' }, type: 1 },
      { buttonId: '3', buttonText: { displayText: 'Naye Offers 🎁' }, type: 1 }
    ],
    headerType: 1
  });
}

/**
 * 3. Modern Native Flow Interactive Message (Interactive protobuf with device context)
 */
async function sendInteractiveFlow(jid, bodyText) {
  const { generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
  const cleanBody = bodyText.replace(/Reply 1, 2 ya 3 karo[\s\S]*/gi, '').trim();
  
  const msg = generateWAMessageFromContent(jid, {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2
        },
        interactiveMessage: proto.Message.InteractiveMessage.create({
          body: proto.Message.InteractiveMessage.Body.create({ text: cleanBody }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: BIZ_NAME }),
          header: proto.Message.InteractiveMessage.Header.create({ title: BIZ_NAME, hasMediaAttachment: false }),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [
              {
                name: 'single_select',
                buttonParamsJson: JSON.stringify({
                  title: 'Select Service 📋',
                  sections: [
                    {
                      title: 'Services',
                      rows: [
                        { id: '1', title: 'Doorstep Repair / Service 🛠️', description: 'AC, Fridge, TV, Washing Machine, Oven' },
                        { id: '2', title: 'Remotes & Cable Delivery 🔌', description: 'TV Remotes, HDMI, Ethernet & Wires' },
                        { id: '3', title: 'Naye Offers & Help 🎁', description: 'Special discounts & advice' }
                      ]
                    }
                  ]
                })
              }
            ]
          })
        })
      }
    }
  }, { userJid: jid });

  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
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
