require('dotenv').config();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Soham Electronics';

// ==========================================
// HARD GUARDRAILS - Rate Limiting & Safety
// ==========================================
const GUARDRAILS = {
  maxCallsPerDay: parseInt(process.env.MAX_AI_CALLS_PER_DAY || '500'),
  maxCallsPerMinute: parseInt(process.env.MAX_AI_CALLS_PER_MINUTE || '15'),
  maxMessagesPerDay: parseInt(process.env.MAX_MESSAGES_PER_DAY || '100'),
};

let rateLimiter = {
  dailyCalls: 0,
  minuteCalls: 0,
  dailyMessages: 0,
  lastMinuteReset: Date.now(),
  lastDayReset: Date.now(),
};

/**
 * Check and enforce rate limits before making an AI call
 * @throws {Error} if rate limit exceeded
 */
function checkRateLimit() {
  const now = Date.now();

  // Reset minute counter every 60s
  if (now - rateLimiter.lastMinuteReset > 60000) {
    rateLimiter.minuteCalls = 0;
    rateLimiter.lastMinuteReset = now;
  }

  // Reset daily counter every 24h
  if (now - rateLimiter.lastDayReset > 86400000) {
    rateLimiter.dailyCalls = 0;
    rateLimiter.dailyMessages = 0;
    rateLimiter.lastDayReset = now;
  }

  if (rateLimiter.dailyCalls >= GUARDRAILS.maxCallsPerDay) {
    throw new Error(`🛑 GUARDRAIL: Daily AI call limit reached (${GUARDRAILS.maxCallsPerDay}). Resets in ${Math.ceil((86400000 - (now - rateLimiter.lastDayReset)) / 3600000)}h`);
  }

  if (rateLimiter.minuteCalls >= GUARDRAILS.maxCallsPerMinute) {
    throw new Error(`🛑 GUARDRAIL: Per-minute AI call limit reached (${GUARDRAILS.maxCallsPerMinute}/min). Wait 60s.`);
  }

  rateLimiter.dailyCalls++;
  rateLimiter.minuteCalls++;
}

/**
 * Check daily message send limit
 * @returns {boolean} true if allowed to send
 */
function canSendMessage() {
  const now = Date.now();
  if (now - rateLimiter.lastDayReset > 86400000) {
    rateLimiter.dailyMessages = 0;
    rateLimiter.lastDayReset = now;
  }
  if (rateLimiter.dailyMessages >= GUARDRAILS.maxMessagesPerDay) {
    console.log(`🛑 GUARDRAIL: Daily message limit reached (${GUARDRAILS.maxMessagesPerDay}). No more messages today.`);
    return false;
  }
  rateLimiter.dailyMessages++;
  return true;
}

/**
 * Get current guardrail stats
 */
function getGuardrailStats() {
  return {
    aiCallsToday: rateLimiter.dailyCalls,
    aiCallsThisMinute: rateLimiter.minuteCalls,
    messagesToday: rateLimiter.dailyMessages,
    limits: GUARDRAILS,
  };
}

// ==========================================
// SYSTEM PROMPTS
// ==========================================

// System prompt for generating outbound campaign messages
const CAMPAIGN_SYSTEM_PROMPT = `Tu ek friendly dukandaar hai jo apne customers ko WhatsApp pe message karta hai. Tera kaam hai personalized, chhota aur warm message likhna.

RULES:
1. HINDI mein likh but ENGLISH letters use kar (Hinglish). Example: "Namaste bhai! Kaise ho?"
2. Message BAHUT CHHOTA rakh - max 2-3 lines. Jaise ek dost likhta hai.
3. Professional English BILKUL mat use kar. No "Dear Sir", no "We are pleased", no "Kind regards".
4. Customer ka naam use kar naturally. "bhai", "ji", "didi" laga sakta hai.
5. Unke purchase history dekh ke naturally mention kar - jaise "aapne jo TV liya tha" ya "AC kaisa chal raha hai"
6. Emoji use kar but zyada nahi - 1-2 max per message.
7. Har message UNIQUE hona chahiye - copy paste jaisa nahi lagna chahiye.
8. Agar balance pending hai toh bahut politely mention kar, pressure mat daal.
9. Message ka tone aisa ho jaise personally likh raha hai, bulk message nahi.
10. Business name: ${BUSINESS_NAME}

EXAMPLES of good messages:
- "Raman bhai! Kaise ho? LED TV kaisa chal raha hai? Koi problem ho toh batana 😊"
- "Namaste Pradeep ji! Water purifier ka filter change karwaya ki nahi? 6 mahine ho gaye 🙂"
- "Meeta didi aapka AC sahi chal raha hai na? Garmi mein dhyan rakhna service ka. Hum hain na!"

BAD examples (NEVER write like this):
- "Dear Customer, We hope you are doing well. We wanted to inform you about our latest offers."
- "Respected Sir/Madam, This is to remind you about your pending payment."
- "Greetings from Soham Electronics! We have exciting new deals for you!"`;

// System prompt for replying to incoming messages
const REPLY_SYSTEM_PROMPT = `Tu ek electronics dukan ka owner hai. Customer ne tujhe WhatsApp pe message kiya hai. Tu usse casual aur friendly reply kar.

RULES:
1. Customer jis language mein likhe ussi mein reply kar:
   - Agar Hindi/Hinglish mein likhe toh Hinglish mein reply kar
   - Agar Marathi mein likhe toh Marathi mein reply kar (Marathi in English letters, like "Dhanyavaad! Kahi problem asel tar nakki sanga")
   - Agar English mein likhe toh bhi Hinglish mein reply kar (Hindi tone in English letters)
2. Reply CHHOTA rakh - 1-3 lines max
3. Friendly aur helpful ban
4. Professional English BILKUL mat use kar
5. Agar customer kuch poochhe jiska answer tu nahi jaanta, toh bol "Main aapko call karke batata/batati hoon"
6. Agar customer naraz hai toh politely handle kar
7. Business name: ${BUSINESS_NAME}
8. 1-2 emoji use kar max`;

/**
 * Generate a personalized outbound campaign message for a customer
 * @param {Object} customer - Customer object with name, purchases, etc.
 * @param {string} campaignContext - Optional context like "festival offer", "follow up", etc.
 * @returns {Promise<string>} The generated message
 */
async function generateCampaignMessage(customer, campaignContext = '') {
  // GUARDRAIL: Check rate limits
  checkRateLimit();

  const purchaseInfo = customer.purchases.map(p => {
    return `${p.date}: ${p.productName} (₹${p.amount}) ${p.balance > 0 ? `- Balance pending: ₹${p.balance}` : '- Fully paid'}`;
  }).join('\n');

  const userPrompt = `Customer ka naam: ${customer.name}
Total purchases: ${customer.purchases.length}
Total spent: ₹${customer.totalSpent}
Pending balance: ₹${customer.totalBalance}

Purchase history:
${purchaseInfo}

${campaignContext ? `Campaign context: ${campaignContext}` : 'General follow-up / relationship building message bhej.'}

Is customer ke liye ek personalized WhatsApp message likh. Yaad rakh - chhota, friendly, Hinglish mein.`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: CAMPAIGN_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.85,
      max_tokens: 200,
      top_p: 0.9,
    });

    const message = completion.choices[0]?.message?.content;
    if (!message) throw new Error('Empty response from Groq');

    // Clean up - remove quotes if AI wraps the message in them
    return message.replace(/^"|"$/g, '').replace(/^'|'$/g, '').trim();
  } catch (error) {
    if (error.message.startsWith('🛑 GUARDRAIL')) throw error; // Re-throw guardrail errors
    console.error('❌ Groq campaign message error:', error.message);
    // Fallback message
    return `Namaste ${customer.name.split(' ')[0]} ji! Kaise hain aap? ${BUSINESS_NAME} se bol rahe hain. Koi help chahiye toh batana 🙂`;
  }
}

/**
 * Generate a reply to an incoming customer message
 * @param {string} customerName - Name of the customer
 * @param {string} incomingMessage - The message customer sent
 * @param {Object} customerData - Customer purchase data (optional)
 * @returns {Promise<string>} The reply message
 */
async function generateReply(customerName, incomingMessage, customerData = null) {
  // GUARDRAIL: Check rate limits
  checkRateLimit();

  let context = '';
  if (customerData) {
    const lastPurchase = customerData.purchases[0];
    context = `\nCustomer info: ${customerName}, last purchase: ${lastPurchase.productName} on ${lastPurchase.date} (₹${lastPurchase.amount})`;
  }

  const userPrompt = `Customer: ${customerName}${context}\n\nCustomer ka message: "${incomingMessage}"\n\nIska reply likh. Chhota aur friendly.`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: REPLY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.8,
      max_tokens: 150,
      top_p: 0.9,
    });

    const reply = completion.choices[0]?.message?.content;
    if (!reply) throw new Error('Empty response from Groq');

    return reply.replace(/^"|"$/g, '').replace(/^'|'$/g, '').trim();
  } catch (error) {
    if (error.message.startsWith('🛑 GUARDRAIL')) throw error;
    console.error('❌ Groq reply error:', error.message);
    return `Dhanyavaad ${customerName.split(' ')[0]} ji! Main aapko thodi der mein reply karta hoon 🙏`;
  }
}

/**
 * Detect the language of a message (basic detection)
 * @param {string} text - The message text
 * @returns {string} 'hindi' | 'marathi' | 'english' | 'hinglish'
 */
function detectLanguage(text) {
  if (!text) return 'hinglish';
  
  const lower = text.toLowerCase();
  
  // Marathi indicators (romanized)
  const marathiWords = ['aahe', 'mala', 'tumhi', 'kasa', 'kashi', 'nahi', 'hoy', 'bara', 'sangaa', 'dya', 'ghya', 'paise', 'dhanyavaad', 'namaskar', 'kashe', 'aahat', 'mhanun', 'tumcha', 'amhi', 'tyacha', 'kaay', 'asel', 'zala', 'kela', 'gela', 'aala', 'saang', 'mhanje'];
  
  // Hindi/Hinglish indicators
  const hindiWords = ['kaise', 'kya', 'hai', 'hain', 'nahi', 'acha', 'theek', 'bhai', 'bhaiya', 'didi', 'aap', 'hum', 'mujhe', 'kab', 'kahan', 'kitna', 'bahut', 'abhi', 'shukriya', 'dhanyavaad', 'namaste', 'batao', 'batana', 'chahiye'];
  
  const words = lower.split(/\s+/);
  
  let marathiScore = 0;
  let hindiScore = 0;
  
  words.forEach(word => {
    if (marathiWords.includes(word)) marathiScore++;
    if (hindiWords.includes(word)) hindiScore++;
  });
  
  if (marathiScore > hindiScore && marathiScore >= 2) return 'marathi';
  if (hindiScore >= 1) return 'hinglish';
  
  // Check if it's plain English
  const englishWords = ['hello', 'hi', 'please', 'thank', 'thanks', 'yes', 'no', 'okay', 'ok', 'good', 'fine', 'how', 'what', 'when', 'where', 'the', 'is', 'are'];
  const englishScore = words.filter(w => englishWords.includes(w)).length;
  
  if (englishScore > 2) return 'english';
  
  return 'hinglish'; // Default
}

module.exports = {
  generateCampaignMessage,
  generateReply,
  detectLanguage,
  canSendMessage,
  getGuardrailStats,
  CAMPAIGN_SYSTEM_PROMPT,
  REPLY_SYSTEM_PROMPT
};
