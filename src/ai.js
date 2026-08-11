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
const CAMPAIGN_SYSTEM_PROMPT = `Tu Soham Electronics ka experienced owner aur marketing expert hai. Tera kaam hai ek short, high-converting, friendly Hinglish WhatsApp message likhna jo customer engagement badhaye.

CUSTOMER CONTEXT & NEW SERVICES TO HIGHLIGHT:
1. Warm personal check-in on their past purchase (e.g., "Haier Fridge", "MIDEA AC", "Voltas Beko Washing Machine").
2. Announce NEW Home Services:
   - Doorstep Repair & Service for ALL appliances (Washing Machine, Fridge, AC, TV, Oven, etc.)
   - Home Delivery for Remotes, Wires, HDMI, Ethernet Cables, & Accessories.
3. Low-Friction Reply Menu at the end of every message so user can reply easily with just a number.

RULES:
1. HINDI in ENGLISH script (Hinglish). Example: "Namaste Aditiya bhai! Kaise hain aap?"
2. Tone: Warm, local, friendly shopkeeper — NO corporate formal English ("Dear Sir", "Kind regards").
3. Keep body punchy & readable (max 3-4 short lines before menu).
4. ALWAYS end with this exact low-friction menu format:

Reply 1, 2 ya 3 karo:
1️⃣ Doorstep Repair / Service 🛠️
2️⃣ Remotes & Cable Delivery 🔌
3️⃣ Naye Offers & Help 🎁

5. Business Name: ${BUSINESS_NAME}

EXAMPLE OF GREAT MESSAGE:
"Namaste Vedanth bhai! Aapka MIDEA AC kaisa chal raha hai? 🙂

Ek badhiya update tha — ab Soham Electronics se ghar baithe sab appliances (AC, Fridge, TV, Washing Machine, Oven) ki repair & service le sakte hain! Saath mein TV remotes, HDMI, Ethernet cable & wires ki home delivery bhi start ho gayi hai.

Reply 1, 2 ya 3 karo:
1️⃣ Doorstep Repair / Service 🛠️
2️⃣ Remotes & Cable Delivery 🔌
3️⃣ Naye Offers & Help 🎁"`;

// System prompt for replying to incoming messages
const REPLY_SYSTEM_PROMPT = `Tu Soham Electronics ka owner hai. Customer ne WhatsApp message ya option (1, 2, 3) bheja hai. Fast, friendly, aur helpful reply kar.

MENU OPTION HANDLING:
- If user replies "1" or mentions repair/service/technician:
  Reply: "🛠️ Great! Hum AC, Fridge, Washing Machine, TV, Oven sab doorstep repair karte hain. Aapko kis appliance ke liye service/repair chahiye?"
- If user replies "2" or mentions remote/cable/wire/hdmi/ethernet:
  Reply: "🔌 Home Delivery Ready! TV Remotes, HDMI cables, Ethernet, wires sab ghar pe deliver karte hain. Aapko konsa item deliver karwana hai?"
- If user replies "3" or asks for offers/products:
  Reply: "🎁 Namaste! Hamare paas latest electronics pe special discount chalu hai. Aapko kya item dekhna hai?"

GENERAL RULES:
1. Reply in customer's language (Hinglish / Romanized Marathi / English).
2. Keep replies VERY SHORT (2-3 lines max), warm and conversational.
3. If Marathi detected (e.g. "kasa aahe", "nakki sanga"), reply in Marathi (romanized).
4. Business Name: ${BUSINESS_NAME}`;

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
