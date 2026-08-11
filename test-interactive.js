const { default: makeWASocket, useMultiFileAuthState, Browsers, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');

async function testAllInteractiveFormats() {
  const AUTH_DIR = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Desktop')
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection } = update;
    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!');
      const targetJid = '919137515363@s.whatsapp.net'; // Soham's test number

      console.log('\n--- TEST 1: Classic List Message ---');
      try {
        await sock.sendMessage(targetJid, {
          text: "Namaste! Select a service from the interactive menu below:",
          footer: "Diwan Electronics",
          title: "Diwan Electronics Services",
          buttonText: "View Options 📋",
          sections: [
            {
              title: "Our Services",
              rows: [
                { title: "Doorstep Repair / Service 🛠️", rowId: "1", description: "AC, Fridge, TV, Washing Machine, Oven" },
                { title: "Remotes & Cable Delivery 🔌", rowId: "2", description: "TV Remotes, HDMI, Ethernet & Wires" },
                { title: "Naye Offers & Help 🎁", rowId: "3", description: "Special discounts & advice" }
              ]
            }
          ]
        });
        console.log('✅ Sent Test 1 (Classic List Message)');
      } catch (e) {
        console.error('❌ Test 1 Error:', e.message);
      }

      await new Promise(r => setTimeout(r, 3000));

      console.log('\n--- TEST 2: Buttons Message ---');
      try {
        await sock.sendMessage(targetJid, {
          text: "Namaste! Choose an option below:",
          footer: "Diwan Electronics",
          buttons: [
            { buttonId: '1', buttonText: { displayText: 'Doorstep Repair 🛠️' }, type: 1 },
            { buttonId: '2', buttonText: { displayText: 'Cable & Remotes 🔌' }, type: 1 },
            { buttonId: '3', buttonText: { displayText: 'Naye Offers 🎁' }, type: 1 }
          ],
          headerType: 1
        });
        console.log('✅ Sent Test 2 (Buttons Message)');
      } catch (e) {
        console.error('❌ Test 2 Error:', e.message);
      }

      await new Promise(r => setTimeout(r, 3000));

      console.log('\n--- TEST 3: Modern Interactive Message with ContextInfo ---');
      try {
        const msg = generateWAMessageFromContent(targetJid, {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2
              },
              interactiveMessage: proto.Message.InteractiveMessage.create({
                body: proto.Message.InteractiveMessage.Body.create({
                  text: "Namaste! Please select your service:"
                }),
                footer: proto.Message.InteractiveMessage.Footer.create({
                  text: "Diwan Electronics"
                }),
                header: proto.Message.InteractiveMessage.Header.create({
                  title: "Diwan Electronics",
                  hasMediaAttachment: false
                }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                  buttons: [
                    {
                      name: "single_select",
                      buttonParamsJson: JSON.stringify({
                        title: "Select Service 📋",
                        sections: [
                          {
                            title: "Services",
                            rows: [
                              { id: "1", title: "Doorstep Repair / Service 🛠️", description: "AC, Fridge, TV, Washing Machine, Oven" },
                              { id: "2", title: "Remotes & Cable Delivery 🔌", description: "TV Remotes, HDMI, Ethernet & Wires" },
                              { id: "3", title: "Naye Offers & Help 🎁", description: "Special discounts & advice" }
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
        }, { userJid: targetJid });

        await sock.relayMessage(targetJid, msg.message, { messageId: msg.key.id });
        console.log('✅ Sent Test 3 (Modern Interactive Message)');
      } catch (e) {
        console.error('❌ Test 3 Error:', e.message);
      }

      setTimeout(() => process.exit(0), 5000);
    }
  });
}

testAllInteractiveFormats();
