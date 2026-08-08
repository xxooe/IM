/* BubbleDB — IndexedDB persistence for accounts, friends, convos, messages, settings
   Multi-account safe: friends/convos/messages keyed by ownerId composite keys. */
const BubbleDB = (() => {
  const DB_NAME = 'bubbleim_v3';
  const DB_VER = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('accounts')) {
          db.createObjectStore('accounts', { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains('friends')) {
          const s = db.createObjectStore('friends', { keyPath: '_key' });
          s.createIndex('ownerId', 'ownerId', { unique: false });
        }
        if (!db.objectStoreNames.contains('convos')) {
          const s = db.createObjectStore('convos', { keyPath: '_key' });
          s.createIndex('ownerId', 'ownerId', { unique: false });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const s = db.createObjectStore('messages', { keyPath: 'msgId' });
          s.createIndex('convId', 'convId', { unique: false });
          s.createIndex('ownerConv', 'ownerConv', { unique: false });
          s.createIndex('expiresAt', 'expiresAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode = 'readonly') {
    return open().then(db => {
      const t = db.transaction(store, mode);
      return t.objectStore(store);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function friendKey(ownerId, userId) { return ownerId + '::' + userId; }
  function convoKey(ownerId, id) { return ownerId + '::' + id; }
  function ownerConvKey(ownerId, convId) { return ownerId + '::' + convId; }

  // ---- settings ----
  async function getSetting(key, def) {
    const store = await tx('settings');
    const v = await reqToPromise(store.get(key));
    return v ? v.value : def;
  }
  async function setSetting(key, value) {
    const store = await tx('settings', 'readwrite');
    await reqToPromise(store.put({ key, value }));
  }

  // ---- multi-account ----
  async function listAccounts() {
    const store = await tx('accounts');
    return reqToPromise(store.getAll());
  }
  async function getAccountById(userId) {
    const store = await tx('accounts');
    return reqToPromise(store.get(userId));
  }
  async function saveAccount(acc) {
    const store = await tx('accounts', 'readwrite');
    await reqToPromise(store.put(acc));
  }
  async function deleteAccount(userId) {
    const store = await tx('accounts', 'readwrite');
    await reqToPromise(store.delete(userId));
  }
  async function getActiveUserId() {
    return getSetting('activeUserId', null);
  }
  async function setActiveUserId(userId) {
    return setSetting('activeUserId', userId);
  }
  async function getAccount() {
    const uid = await getActiveUserId();
    if (!uid) return null;
    return getAccountById(uid);
  }

  // ---- friends (composite key ownerId::userId) ----
  async function listFriends() {
    const me = await getAccount();
    if (!me) return [];
    const store = await tx('friends');
    const idx = store.index('ownerId');
    return reqToPromise(idx.getAll(me.userId));
  }
  async function upsertFriend(f) {
    const me = await getAccount();
    if (!me) return;
    f.ownerId = me.userId;
    f._key = friendKey(me.userId, f.userId);
    const store = await tx('friends', 'readwrite');
    await reqToPromise(store.put(f));
  }
  async function deleteFriend(userId) {
    const me = await getAccount();
    if (!me) return;
    const store = await tx('friends', 'readwrite');
    await reqToPromise(store.delete(friendKey(me.userId, userId)));
  }

  // ---- convos (composite key ownerId::id) ----
  async function listConvos() {
    const me = await getAccount();
    if (!me) return [];
    const store = await tx('convos');
    const idx = store.index('ownerId');
    return reqToPromise(idx.getAll(me.userId));
  }
  async function upsertConvo(c) {
    const me = await getAccount();
    if (!me) return;
    c.ownerId = me.userId;
    c._key = convoKey(me.userId, c.id);
    const store = await tx('convos', 'readwrite');
    await reqToPromise(store.put(c));
  }
  async function deleteConvo(id) {
    const me = await getAccount();
    if (!me) return;
    const store = await tx('convos', 'readwrite');
    await reqToPromise(store.delete(convoKey(me.userId, id)));
    await deleteMessagesForConvo(id);
  }
  async function deleteMessagesForConvo(convId) {
    const me = await getAccount();
    if (!me) return;
    const store = await tx('messages', 'readwrite');
    const idx = store.index('ownerConv');
    const msgs = await reqToPromise(idx.getAll(ownerConvKey(me.userId, convId)));
    for (const m of msgs) {
      await reqToPromise(store.delete(m.msgId));
    }
  }

  // ---- messages (scoped by ownerConv = ownerId::convId) ----
  async function getMessage(msgId) {
    // Not owner-scoped like the others — msgId is already globally unique
    // (crypto.randomUUID()-based), and this is only used for de-duplicating
    // an offline-queue replay against a message we may have already received
    // live (see queueOfflineCopy/pullOfflineQueue in index.html).
    const store = await tx('messages');
    return reqToPromise(store.get(msgId));
  }
  async function listMessages(convId) {
    const me = await getAccount();
    if (!me) return [];
    const store = await tx('messages');
    const idx = store.index('ownerConv');
    const msgs = await reqToPromise(idx.getAll(ownerConvKey(me.userId, convId)));
    return msgs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }
  async function addMessage(msg) {
    const me = await getAccount();
    if (!me) return;
    msg.ownerId = me.userId;
    msg.ownerConv = ownerConvKey(me.userId, msg.convId);
    const store = await tx('messages', 'readwrite');
    await reqToPromise(store.put(msg));
  }

  // Purge expired messages AND auto-dissolve temporary groups whose ttl has passed (from createdAt)
  async function purgeExpiredMessages() {
    const msgStore = await tx('messages', 'readwrite');
    const allMsgs = await reqToPromise(msgStore.getAll());
    const now = Date.now();
    for (const m of allMsgs) {
      if (m.expiresAt && m.expiresAt < now) {
        await reqToPromise(msgStore.delete(m.msgId));
      }
    }
    const convStore = await tx('convos', 'readwrite');
    const convos = await reqToPromise(convStore.getAll());
    for (const c of convos) {
      if (c.ephemeral && c.ttlMs && c.createdAt && (c.createdAt + c.ttlMs) < now) {
        await reqToPromise(convStore.delete(c._key));
        // delete messages for this owner+convo
        const mStore = await tx('messages', 'readwrite');
        const idx = mStore.index('ownerConv');
        const oc = ownerConvKey(c.ownerId, c.id);
        const msgs = await reqToPromise(idx.getAll(oc));
        for (const m of msgs) {
          await reqToPromise(mStore.delete(m.msgId));
        }
      }
    }
  }

  async function deleteFriendAndChat(friendUserId) {
    await deleteFriend(friendUserId);
    await deleteConvo(friendUserId);
  }

  return {
    open,
    getSetting, setSetting,
    listAccounts, getAccountById, saveAccount, deleteAccount,
    getActiveUserId, setActiveUserId, getAccount,
    listFriends, upsertFriend, deleteFriend, deleteFriendAndChat,
    listConvos, upsertConvo, deleteConvo, deleteMessagesForConvo,
    listMessages, addMessage, getMessage,
    purgeExpiredMessages
  };
})();
