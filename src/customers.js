const XLSX = require('xlsx');
const path = require('path');

/**
 * Parse the sales Excel file and build customer profiles
 * @param {string} filePath - Path to the Excel file
 * @returns {Array} Array of customer objects
 */
function parseCustomerData(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  
  // Read all data as array of arrays
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  
  // Find the header row (contains 'Date', 'Party Name', etc.)
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(10, rawData.length); i++) {
    const row = rawData[i];
    if (row && row[0] === 'Date' && row[1] === 'Party Name') {
      headerRowIdx = i;
      break;
    }
  }
  
  if (headerRowIdx === -1) {
    throw new Error('Could not find header row in Excel file');
  }
  
  // Extract data rows (skip header and any blank rows after it)
  const dataRows = rawData.slice(headerRowIdx + 1).filter(row => {
    // Skip blank rows and total/summary rows
    if (!row || !row[0] || !row[1]) return false;
    if (String(row[5]).toLowerCase() === 'total') return false;
    if (String(row[0]).toLowerCase() === 'total') return false;
    // Only keep 'Sale' transactions
    if (String(row[5]) !== 'Sale') return false;
    return true;
  });
  
  // Build customer map (group by phone number)
  const customerMap = new Map();
  
  dataRows.forEach(row => {
    const date = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    let phone = String(row[2] || '').trim().replace(/\D/g, ''); // Remove non-digits
    const amount = parseFloat(String(row[6] || '0').replace(/,/g, '')) || 0;
    const paymentType = String(row[7] || '').trim();
    const received = parseFloat(String(row[8] || '0').replace(/,/g, '')) || 0;
    const balance = parseFloat(String(row[9] || '0').replace(/,/g, '')) || 0;
    const description = String(row[10] || '').trim();
    
    // Skip if no phone number
    if (!phone || phone.length < 10) return;
    
    // Ensure 10-digit number (remove country code if present)
    if (phone.length > 10) {
      phone = phone.slice(-10);
    }
    
    // Parse product name from description
    const productName = extractProductName(description);
    
    const purchase = {
      date,
      amount,
      paymentType,
      received,
      balance,
      description,
      productName
    };
    
    if (customerMap.has(phone)) {
      const existing = customerMap.get(phone);
      existing.purchases.push(purchase);
      existing.totalSpent += amount;
      existing.totalBalance += balance;
    } else {
      customerMap.set(phone, {
        name,
        phone,
        whatsappId: `91${phone}@s.whatsapp.net`,
        purchases: [purchase],
        totalSpent: amount,
        totalBalance: balance
      });
    }
  });
  
  // Convert map to array and sort by total spent (best customers first)
  const customers = Array.from(customerMap.values())
    .sort((a, b) => b.totalSpent - a.totalSpent);
  
  console.log(`✅ Loaded ${customers.length} customers from Excel`);
  console.log(`📊 Total sales records: ${dataRows.length}`);
  console.log(`💰 Customers with pending balance: ${customers.filter(c => c.totalBalance > 0).length}`);
  
  return customers;
}

/**
 * Extract a human-readable product name from the description field
 * Descriptions look like: 'mno.lg led 32LB653BPLA\nsno.VZ320126623'
 * We want: 'LG LED TV'
 */
function extractProductName(description) {
  if (!description) return 'product';
  
  const desc = description.toLowerCase();
  
  // Product keyword mapping
  const productKeywords = [
    { keywords: ['led', 'tv', 'oled', 'qled'], name: 'LED TV' },
    { keywords: ['ac', 'air conditioner', 'inverter', 'santis', 'split'], name: 'AC' },
    { keywords: ['washing', 'wm', 'washer'], name: 'Washing Machine' },
    { keywords: ['fridge', 'refrigerator', 'ref', 'double door'], name: 'Fridge' },
    { keywords: ['water purifier', 'ro', 'purifier', 'aqua'], name: 'Water Purifier' },
    { keywords: ['microwave', 'oven'], name: 'Microwave' },
    { keywords: ['iron', 'press', 'pressa'], name: 'Iron' },
    { keywords: ['mixer', 'grinder', 'juicer'], name: 'Mixer Grinder' },
    { keywords: ['fan', 'ceiling fan'], name: 'Fan' },
    { keywords: ['cooler', 'air cooler'], name: 'Air Cooler' },
    { keywords: ['geyser', 'water heater'], name: 'Geyser' },
    { keywords: ['chimney', 'hood'], name: 'Chimney' },
    { keywords: ['dishwasher'], name: 'Dishwasher' },
    { keywords: ['speaker', 'sound', 'audio', 'home theatre'], name: 'Speaker' },
    { keywords: ['stabilizer', 'voltage'], name: 'Stabilizer' },
    { keywords: ['induction', 'cooktop', 'stove'], name: 'Induction Cooktop' },
    { keywords: ['vacuum'], name: 'Vacuum Cleaner' },
    { keywords: ['wteon', 'wte'], name: 'Water Purifier' },
    { keywords: ['hrb', 'hrd'], name: 'AC' },
    { keywords: ['ftq', 'ftk'], name: 'LED TV' },
    { keywords: ['vzshd', 'vz32'], name: 'LED TV' },
    { keywords: ['victor', 'aura'], name: 'Water Purifier' },
  ];
  
  // Try to extract brand from 'mno.' prefix
  let brand = '';
  const mnoMatch = description.match(/mno\.([^\n\\]+)/i);
  if (mnoMatch) {
    const mnoText = mnoMatch[1].trim().toLowerCase();
    // Common brand detection
    const brands = ['lg', 'samsung', 'whirlpool', 'godrej', 'haier', 'voltas', 'daikin', 'hitachi', 'panasonic', 'sony', 'toshiba', 'lloyd', 'ifb', 'bosch', 'kent', 'eureka', 'havells', 'crompton', 'bajaj', 'philips', 'prestige', 'butterfly'];
    for (const b of brands) {
      if (mnoText.includes(b)) {
        brand = b.charAt(0).toUpperCase() + b.slice(1);
        break;
      }
    }
  }
  
  for (const product of productKeywords) {
    if (product.keywords.some(kw => desc.includes(kw))) {
      return brand ? `${brand} ${product.name}` : product.name;
    }
  }
  
  return brand || 'product';
}

/**
 * Get a summary string for a customer's purchase history
 * Used as context for AI message generation
 */
function getCustomerSummary(customer) {
  const purchases = customer.purchases.map(p => {
    return `- ${p.date}: ${p.productName} (₹${p.amount}) ${p.balance > 0 ? `[PENDING: ₹${p.balance}]` : '[PAID]'}`;
  }).join('\n');
  
  return `Customer: ${customer.name}
Phone: ${customer.phone}
Total purchases: ${customer.purchases.length}
Total spent: ₹${customer.totalSpent}
Pending balance: ₹${customer.totalBalance}
Purchase history:
${purchases}`;
}

module.exports = {
  parseCustomerData,
  extractProductName,
  getCustomerSummary
};
