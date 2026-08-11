require('dotenv').config();

const MIN_DELAY = parseInt(process.env.MIN_DELAY_SEC || '45') * 1000;
const MAX_DELAY = parseInt(process.env.MAX_DELAY_SEC || '120') * 1000;
const MAX_PER_SESSION = parseInt(process.env.MAX_MESSAGES_PER_SESSION || '30');
const SESSION_BREAK = parseInt(process.env.SESSION_BREAK_MIN || '20') * 60 * 1000;

let queue = [];
let isProcessing = false;
let messagesSentInSession = 0;
let totalMessagesSent = 0;
let totalFailed = 0;
let isPaused = false;
let onSendCallback = null;

/**
 * Generate a random delay between min and max
 * @returns {number} Delay in milliseconds
 */
function getRandomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
}

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Add a message to the queue
 * @param {string} jid - WhatsApp JID
 * @param {string} message - Message text
 * @param {string} customerName - Customer name for logging
 */
function addToQueue(jid, message, customerName) {
  queue.push({ jid, message, customerName, retries: 0 });
  console.log(`📋 Queued message for ${customerName} (${jid}) | Queue size: ${queue.length}`);
}

/**
 * Start processing the message queue
 * @param {Function} sendFn - Function to send a message (jid, text) => Promise<boolean>
 */
async function startProcessing(sendFn) {
  if (isProcessing) {
    console.log('⚠️  Queue is already being processed');
    return;
  }
  
  onSendCallback = sendFn;
  isProcessing = true;
  isPaused = false;
  messagesSentInSession = 0;
  
  console.log('\n' + '='.repeat(50));
  console.log(`🚀 Starting message queue processing`);
  console.log(`📋 Messages in queue: ${queue.length}`);
  console.log(`⏱️  Delay range: ${MIN_DELAY/1000}s - ${MAX_DELAY/1000}s`);
  console.log(`📊 Max per session: ${MAX_PER_SESSION}`);
  console.log('='.repeat(50) + '\n');
  
  while (queue.length > 0 && isProcessing) {
    // Check if we need a session break
    if (messagesSentInSession >= MAX_PER_SESSION) {
      console.log(`\n⏸️  Session limit reached (${MAX_PER_SESSION} messages). Taking a ${SESSION_BREAK/60000} minute break...`);
      await sleep(SESSION_BREAK);
      messagesSentInSession = 0;
      console.log('▶️  Resuming after break...\n');
    }
    
    // Check if paused
    if (isPaused) {
      console.log('⏸️  Queue is paused. Waiting...');
      await sleep(5000);
      continue;
    }
    
    const item = queue.shift();
    
    console.log(`\n📤 Sending to: ${item.customerName}`);
    console.log(`   Message: ${item.message.substring(0, 80)}...`);
    
    try {
      const success = await sendFn(item.jid, item.message);
      
      if (success) {
        messagesSentInSession++;
        totalMessagesSent++;
        console.log(`   ✅ Sent! (${totalMessagesSent} total | ${queue.length} remaining)`);
      } else {
        // Retry logic
        if (item.retries < 2) {
          item.retries++;
          queue.push(item); // Add back to end of queue
          console.log(`   ⚠️  Failed, will retry (attempt ${item.retries}/2)`);
        } else {
          totalFailed++;
          console.log(`   ❌ Failed after 2 retries. Skipping.`);
        }
      }
    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
      totalFailed++;
    }
    
    // Random delay before next message
    if (queue.length > 0) {
      const delayMs = getRandomDelay();
      console.log(`   ⏳ Waiting ${(delayMs/1000).toFixed(0)}s before next message...`);
      await sleep(delayMs);
    }
  }
  
  isProcessing = false;
  
  console.log('\n' + '='.repeat(50));
  console.log('🏁 Queue processing complete!');
  console.log(`   ✅ Sent: ${totalMessagesSent}`);
  console.log(`   ❌ Failed: ${totalFailed}`);
  console.log(`   📋 Remaining: ${queue.length}`);
  console.log('='.repeat(50) + '\n');
}

/**
 * Pause queue processing
 */
function pauseQueue() {
  isPaused = true;
  console.log('⏸️  Queue paused');
}

/**
 * Resume queue processing
 */
function resumeQueue() {
  isPaused = false;
  console.log('▶️  Queue resumed');
}

/**
 * Stop queue processing entirely
 */
function stopQueue() {
  isProcessing = false;
  isPaused = false;
  console.log('🛑 Queue stopped');
}

/**
 * Clear all pending messages from queue
 */
function clearQueue() {
  const count = queue.length;
  queue = [];
  console.log(`🗑️  Cleared ${count} messages from queue`);
}

/**
 * Get queue statistics
 * @returns {Object}
 */
function getStats() {
  return {
    pending: queue.length,
    sent: totalMessagesSent,
    failed: totalFailed,
    sessionSent: messagesSentInSession,
    isProcessing,
    isPaused
  };
}

module.exports = {
  addToQueue,
  startProcessing,
  pauseQueue,
  resumeQueue,
  stopQueue,
  clearQueue,
  getStats,
  getRandomDelay
};
