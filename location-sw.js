/**
 * location-sw.js  —  Background Location Tracker Service Worker
 *
 * আপগ্রেড: Agent app বন্ধ / kill করলেও tracking চলবে।
 *
 * কাজ:
 *  1. START_TRACKING পেলে — token, agentId, apiBase কে IndexedDB তে সংরক্ষণ করে।
 *  2. Periodic Background Sync (periodicsync) দিয়ে OS-level scheduling করে।
 *  3. periodicsync না থাকলে — setInterval fallback ব্যবহার করে।
 *  4. Tab খোলা থাকলে: SW → page কে 'SW_REQUEST_LOCATION' পাঠায়, page GPS দেয়।
 *  5. কোনো tab না থাকলে: SW নিজেই fetch দিয়ে location পাঠায় (ব্যাকগ্রাউন্ড)।
 *     — এই ক্ষেত্রে GPS সরাসরি SW থেকে নেওয়া যায় না (browser limit),
 *       তাই একটা silent notification দিয়ে user কে জানানো হয়।
 *  6. STOP_TRACKING পেলে — IndexedDB থেকে সব data মুছে, tracking বন্ধ করে।
 *  7. Admin panel থেকে force-stop করার জন্য ADMIN_STOP_TRACKING সাপোর্ট।
 *
 * Limitation (OS hard limit):
 *  - Android Chrome: force stop / clear storage করলে SW বন্ধ হয়।
 *    কিন্তু app বন্ধ (swipe away), screen off, অন্য app — এ চলে।
 *  - iOS Safari: PWA হিসেবে add to home screen করলে ভালো কাজ করে।
 */

const SW_VERSION  = 'location-sw-v3';
const DB_NAME     = 'lt_store';
const DB_VERSION  = 1;
const STORE_NAME  = 'config';
const SYNC_TAG    = 'lt-periodic';
const INTERVAL_MS = 30 * 1000; // 30 seconds

/* ── Install & Activate ── */
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

/* ══════════════════════════════════════════════
   IndexedDB helpers — SW এর persistent storage
   ══════════════════════════════════════════════ */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = e => resolve(e.target.result ? e.target.result.value : null);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror    = e  => reject(e.target.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = e  => reject(e.target.error);
  });
}

/* ══════════════════════════════════════════════
   Tracking config helpers
   ══════════════════════════════════════════════ */
async function getConfig() {
  const [token, agentId, apiBase, active] = await Promise.all([
    dbGet('token'),
    dbGet('agentId'),
    dbGet('apiBase'),
    dbGet('active'),
  ]);
  return { token, agentId, apiBase, active: !!active };
}

async function saveConfig({ token, agentId, apiBase }) {
  await Promise.all([
    dbSet('token',   token),
    dbSet('agentId', agentId),
    dbSet('apiBase', apiBase),
    dbSet('active',  true),
  ]);
}

async function clearConfig() {
  await dbClear();
}

/* ══════════════════════════════════════════════
   In-memory fallback interval
   (যখন Periodic Background Sync নেই)
   ══════════════════════════════════════════════ */
let _intervalId = null;

function startInterval() {
  if (_intervalId) return;
  _intervalId = setInterval(doLocationCycle, INTERVAL_MS);
}

function stopInterval() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
}

/* ══════════════════════════════════════════════
   Core: location cycle — প্রতিবার চলে
   ══════════════════════════════════════════════ */
async function doLocationCycle() {
  const cfg = await getConfig();
  if (!cfg.active || !cfg.token || !cfg.apiBase) return;

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  if (clients.length > 0) {
    // Tab খোলা আছে — page কে GPS নিতে বলো
    clients[0].postMessage({ type: 'SW_REQUEST_LOCATION' });
  } else {
    // কোনো tab নেই — keep-alive notification দেখাও
    // (SW alive রাখার standard Android trick)
    keepAlive();
  }
}

/* ══════════════════════════════════════════════
   Keep-alive: কোনো tab না থাকলে SW কে জীবিত রাখার কৌশল
   ══════════════════════════════════════════════ */
let _kaShown = false;
async function keepAlive() {
  if (_kaShown) return;
  if (!('Notification' in self) || Notification.permission !== 'granted') return;
  _kaShown = true;

  try {
    await self.registration.showNotification('Location চলছে (Background)', {
      body:             'Admin আপনার live location দেখতে পারছেন। App খুলুন বন্ধ করতে।',
      icon:             '/icon-192.png',
      badge:            '/icon-192.png',
      tag:              'lt-keepalive',
      silent:           true,
      requireInteraction: false,
    });
    setTimeout(async () => {
      const notifs = await self.registration.getNotifications({ tag: 'lt-keepalive' });
      notifs.forEach(n => n.close());
      _kaShown = false;
    }, 3000);
  } catch (e) { _kaShown = false; }
}

/* ══════════════════════════════════════════════
   Periodic Background Sync — OS level scheduling
   ══════════════════════════════════════════════ */
self.addEventListener('periodicsync', e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(doLocationCycle());
  }
});

/* ══════════════════════════════════════════════
   Message handler (Agent.html → SW)
   ══════════════════════════════════════════════ */
self.addEventListener('message', async e => {
  const { type, token, agentId, base, latitude, longitude, accuracy } = e.data || {};

  /* --- START_TRACKING --- */
  if (type === 'START_TRACKING') {
    await saveConfig({ token, agentId, apiBase: (base || '').replace(/\/$/, '') });
    startInterval();

    // Periodic Background Sync register করার চেষ্টা
    try {
      await self.registration.periodicSync.register(SYNC_TAG, { minInterval: INTERVAL_MS });
    } catch (_) { /* not supported — interval fallback already started */ }

    doLocationCycle(); // immediate first ping
    replyStatus(e, true, agentId);
    return;
  }

  /* --- STOP_TRACKING (agent নিজে logout করলে) --- */
  if (type === 'STOP_TRACKING') {
    await clearConfig();
    stopInterval();
    try { await self.registration.periodicSync.unregister(SYNC_TAG); } catch (_) {}
    replyStatus(e, false, null);
    return;
  }

  /* --- ADMIN_STOP_TRACKING (admin force করলে — future use) --- */
  if (type === 'ADMIN_STOP_TRACKING') {
    await clearConfig();
    stopInterval();
    try { await self.registration.periodicSync.unregister(SYNC_TAG); } catch (_) {}
    replyStatus(e, false, null);
    return;
  }

  /* --- GET_STATUS --- */
  if (type === 'GET_STATUS') {
    const cfg = await getConfig();
    replyStatus(e, cfg.active, cfg.agentId);
    return;
  }

  /* --- LOCATION_RESPONSE (page GPS দিয়েছে) --- */
  if (type === 'LOCATION_RESPONSE') {
    const cfg = await getConfig();
    const useToken = token || cfg.token;
    if (!useToken || !cfg.apiBase) return;

    fetch(`${cfg.apiBase}/location.php`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${useToken}`,
      },
      body: JSON.stringify({ latitude, longitude, accuracy }),
    }).then(async res => {
      // 401 = admin tracking বন্ধ করেছে / token revoke হয়েছে
      // → IndexedDB clear করে tracking নিজেই বন্ধ করো
      if (res.status === 401 || res.status === 403) {
        await clearConfig();
        stopInterval();
        try { await self.registration.periodicSync.unregister(SYNC_TAG); } catch (_) {}

        // Open tab থাকলে জানিয়ে দাও
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        clients.forEach(c => c.postMessage({ type: 'SW_STATUS', tracking: false, agentId: null, reason: 'revoked' }));
      }
    }).catch(() => { /* offline — retry next cycle */ });
  }
});

/* ══════════════════════════════════════════════
   SW boot: যদি আগের session থেকে tracking active থাকে
   তাহলে interval আবার শুরু করো
   ══════════════════════════════════════════════ */
(async () => {
  const cfg = await getConfig();
  if (cfg.active && cfg.token) {
    startInterval();
  }
})();

/* ══════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════ */
function replyStatus(e, tracking, agentId) {
  if (e.source) {
    e.source.postMessage({ type: 'SW_STATUS', tracking: !!tracking, agentId: agentId || null });
  }
}

/* ── Notification click: app খোলো ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
