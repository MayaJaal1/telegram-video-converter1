const admin = require('firebase-admin');
require('dotenv').config();

// Firebase initialize karna (agar pehle se initialized nahi hai)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY 
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
        : undefined,
    }),
  });
}

const db = admin.firestore();

let cachedConfig = null;
let lastFetch = 0;

async function getCentralConfig(force = false) {
  if (!force && cachedConfig && Date.now() - lastFetch < 10000) {
    return cachedConfig;
  }

  try {
    // Firestore se config fetch karna
    // ⚠️ Dhyan rakhna: 'bot_config' collection aur 'main' document ka naam check kar lena.
    // Agar tumhare Firebase me structure alag hai, toh yahan change karo.
    const docRef = db.collection('bot_config').doc('main'); 
    const doc = await docRef.get();

    if (!doc.exists) {
      console.warn('[CONFIG] Firebase me bot_config/main document nahi mila!');
      return cachedConfig; // Purana cache hi return kar do
    }

    cachedConfig = doc.data();
    lastFetch = Date.now();
    return cachedConfig;

  } catch (e) {
    console.error('[CONFIG] Fetch failed:', e.message);
    return cachedConfig;
  }
}

module.exports = { getCentralConfig };
