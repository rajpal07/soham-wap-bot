require('dotenv').config();
const path = require('path');
const readline = require('readline');
const { connectWhatsApp, sendMessage, isConnected, getStatus } = require('./whatsapp');
const { parseCustomerData, getCustomerSummary } = require('./customers');
const { generateCampaignMessage, generateReply, detectLanguage, canSendMessage, getGuardrailStats } = require('./ai');
const { addToQueue, startProcessing, pauseQueue, resumeQueue, stopQueue, clearQueue, getStats } = require('./queue');

// ==========================================
// CONFIGURATION
// ==========================================
const EXCEL_PATH = path.resolve(process.env.EXCEL_FILE_PATH || 'Sale_Report_01-07-2025_to_31-07-2026.xls');

let customers = [];
let customersByPhone = new Map(); // Quick lookup by WhatsApp JID

// ==========================================
// MAIN APPLICATION
// ==========================================
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  🤖 SOHAM WHATSAPP BUSINESS BOT');
  console.log('  Personalized customer messaging with AI');
  console.log('='.repeat(60) + '\n');
  
  // Step 1: Load customer data
  console.log('📊 Loading customer data from Excel...');
  try {
    customers = parseCustomerData(EXCEL_PATH);
    
    // Build lookup map by WhatsApp JID
    customers.forEach(c => {
      customersByPhone.set(c.whatsappId, c);
    });
    
    console.log(`\n📋 Top 5 customers by spending:`);
    customers.slice(0, 5).forEach((c, i) => {
      console.log(`   ${i+1}. ${c.name} - ₹${c.totalSpent} (${c.purchases.length} purchases)`);
    });
    console.log('');
  } catch (error) {
    console.error('❌ Failed to load customer data:', error.message);
    console.log('💡 Make sure the Excel file exists at:', EXCEL_PATH);
    process.exit(1);
  }
  
  // Step 2: Connect to WhatsApp
  console.log('📱 Connecting to WhatsApp...');
  console.log('   (Scan QR code if this is the first time)\n');
  
  await connectWhatsApp(handleIncomingMessage);
  
  // Wait for connection
  await waitForConnection();
  
  // Step 3: Show menu
  showMenu();
}

/**
 * Wait until WhatsApp is connected
 */
async function waitForConnection() {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (isConnected()) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });
}

/**
 * Handle incoming WhatsApp messages
 */
async function handleIncomingMessage(sender, text, senderName, rawMsg) {
  console.log(`\n📩 Message from ${senderName}: "${text}"`);
  
  // Find customer in our database
  const customer = customersByPhone.get(sender);
  
  // Detect language
  const language = detectLanguage(text);
  console.log(`   🌐 Detected language: ${language}`);
  
  // Generate AI reply with random delay (5-15 seconds to look natural)
  const replyDelay = Math.floor(Math.random() * 10000) + 5000;
  console.log(`   ⏳ Will reply in ${(replyDelay/1000).toFixed(0)}s...`);
  
  setTimeout(async () => {
    try {
      const reply = await generateReply(
        customer?.name || senderName,
        text,
        customer || null
      );
      
      console.log(`   🤖 AI Reply: ${reply}`);
      await sendMessage(sender, reply);
    } catch (error) {
      console.error(`   ❌ Reply error: ${error.message}`);
    }
  }, replyDelay);
}

/**
 * Show interactive CLI menu
 */
function showMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  function displayOptions() {
    console.log('\n' + '-'.repeat(40));
    console.log('📋 MENU:');
    console.log('  1 → Start bulk campaign');
    console.log('  2 → Send test message (to yourself)');
    console.log('  3 → View queue status');
    console.log('  4 → Pause/Resume queue');
    console.log('  5 → Stop queue');
    console.log('  6 → View customer list');
    console.log('  7 → Check connection status');
    console.log('  0 → Exit');
    console.log('-'.repeat(40));
    rl.question('\nChoose option: ', handleOption);
  }
  
  async function handleOption(choice) {
    switch (choice.trim()) {
      case '1':
        await startCampaign(rl);
        break;
      
      case '2':
        await sendTestMessage(rl);
        break;
      
      case '3':
        const stats = getStats();
        const gStats = getGuardrailStats();
        console.log('\n📊 Queue Status:');
        console.log(`   Pending: ${stats.pending}`);
        console.log(`   Sent: ${stats.sent}`);
        console.log(`   Failed: ${stats.failed}`);
        console.log(`   Processing: ${stats.isProcessing ? 'Yes' : 'No'}`);
        console.log(`   Paused: ${stats.isPaused ? 'Yes' : 'No'}`);
        console.log('\n🛡️  Guardrails:');
        console.log(`   AI calls today: ${gStats.aiCallsToday}/${gStats.limits.maxCallsPerDay}`);
        console.log(`   AI calls this minute: ${gStats.aiCallsThisMinute}/${gStats.limits.maxCallsPerMinute}`);
        console.log(`   Messages today: ${gStats.messagesToday}/${gStats.limits.maxMessagesPerDay}`);
        break;
      
      case '4':
        const s = getStats();
        if (s.isPaused) {
          resumeQueue();
        } else {
          pauseQueue();
        }
        break;
      
      case '5':
        stopQueue();
        break;
      
      case '6':
        console.log(`\n👥 Customers (${customers.length} total):`);
        customers.forEach((c, i) => {
          console.log(`   ${i+1}. ${c.name} | ${c.phone} | ₹${c.totalSpent} | ${c.purchases.length} purchases${c.totalBalance > 0 ? ` | ⚠️ Balance: ₹${c.totalBalance}` : ''}`);
        });
        break;
      
      case '7':
        console.log(`\n📱 WhatsApp Status: ${getStatus()}`);
        break;
      
      case '0':
        console.log('\n👋 Bye! Bot will keep running in background.');
        rl.close();
        return;
      
      default:
        console.log('❌ Invalid option');
    }
    
    displayOptions();
  }
  
  displayOptions();
}

/**
 * Start a bulk campaign - generate and queue messages for all customers
 */
async function startCampaign(rl) {
  return new Promise((resolve) => {
    rl.question('\n📝 Campaign context (e.g., "monsoon sale", "festival offers", or press Enter for general follow-up): ', async (context) => {
      const campaignContext = context.trim();
      
      console.log(`\n🚀 Starting campaign for ${customers.length} customers...`);
      console.log('🧠 Generating AI messages (this may take a moment)...\n');
      
      let generated = 0;
      
      for (const customer of customers) {
        try {
          const message = await generateCampaignMessage(customer, campaignContext);
          addToQueue(customer.whatsappId, message, customer.name);
          generated++;
          
          // Small delay between AI calls to respect Groq rate limits
          if (generated % 10 === 0) {
            console.log(`   ⏳ Generated ${generated}/${customers.length} messages...`);
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (error) {
          console.error(`   ❌ Failed to generate for ${customer.name}: ${error.message}`);
        }
      }
      
      console.log(`\n✅ Generated ${generated} messages. Starting queue...\n`);
      
      // Start sending in background
      startProcessing(sendMessage);
      
      resolve();
    });
  });
}

/**
 * Send a test message to verify everything works
 */
async function sendTestMessage(rl) {
  return new Promise((resolve) => {
    const testPhone = process.env.TEST_PHONE;
    
    rl.question(`\n📞 Enter phone number to test (10 digits)${testPhone ? ` [${testPhone}]` : ''}: `, async (input) => {
      const phone = (input.trim() || testPhone || '').replace(/\D/g, '');
      
      if (!phone || phone.length < 10) {
        console.log('❌ Invalid phone number');
        resolve();
        return;
      }
      
      const jid = `91${phone.slice(-10)}@s.whatsapp.net`;
      
      // Find customer or create dummy
      const customer = customers.find(c => c.phone === phone.slice(-10)) || {
        name: 'Test User',
        phone: phone.slice(-10),
        purchases: [{ date: 'today', productName: 'Test Product', amount: 1000, balance: 0 }],
        totalSpent: 1000,
        totalBalance: 0
      };
      
      console.log(`\n🧠 Generating test message for ${customer.name}...`);
      const message = await generateCampaignMessage(customer, 'test message');
      
      console.log(`\n📤 Message preview:\n"${message}"\n`);
      
      rl.question('Send this message? (y/n): ', async (confirm) => {
        if (confirm.toLowerCase() === 'y') {
          await sendMessage(jid, message);
        } else {
          console.log('❌ Cancelled');
        }
        resolve();
      });
    });
  });
}

// ==========================================
// HEALTH CHECK SERVER (keeps Render free tier alive)
// ==========================================
const http = require('http');
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  const stats = getStats();
  const gStats = getGuardrailStats();
  
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      whatsapp: getStatus(),
      customers: customers.length,
      queue: stats,
      guardrails: gStats,
      uptime: Math.floor(process.uptime()) + 's',
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// Self-ping every 14 minutes to prevent Render free tier from sleeping
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  http.get(`${url}/health`, () => {}).on('error', () => {});
}, 14 * 60 * 1000);

// ==========================================
// START THE BOT
// ==========================================
main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down...');
  stopQueue();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('💥 Unhandled rejection:', error);
});
