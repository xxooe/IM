/* BubbleDB — 用于账号、好友、会话、消息、设置的 IndexedDB 持久化存储
   多账号安全：好友/会话/消息使用 ownerId 复合键进行隔离。 */
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

  // ---- 系统设置 ----
  async function getSetting(key, def) {
    const store = await tx('settings');
    const v = await reqToPromise(store.get(key));
    return v ? v.value : def;
  }
  async function setSetting(key, value) {
    const store = await tx('settings', 'readwrite');
    await reqToPromise(store.put({ key, value }));
  }

  // ---- 多账号管理 ----
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

  // ---- 好友列表 (复合主键 ownerId::userId) ----
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

  // ---- 会话列表 (复合主键 ownerId::id) ----
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

  // ---- 消息列表 (基于 ownerConv = ownerId::convId 作用域隔离) ----
  async function getMessage(msgId) {
    // 不像其他数据那样受所有者作用域限制 — msgId 本身已是全局唯一
    // （基于 crypto.randomUUID()），用于给"实时收到的消息"去重
    // （见 index.html 中 handleIncoming 里的 alreadyHave 判断）。
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

  // ---- 单条/多条消息删除（仅本机，不通知对方——见 index.html 里的
  //      confirmDeleteOneMessage / confirmDeleteSelectedMessages） ----
  async function deleteMessage(msgId) {
    const store = await tx('messages', 'readwrite');
    await reqToPromise(store.delete(msgId));
  }
  async function deleteMessages(msgIds) {
    const store = await tx('messages', 'readwrite');
    for (const id of msgIds) {
      await reqToPromise(store.delete(id));
    }
  }

  // ---- 消息送达状态（取代服务端离线队列）----
  // 发送时先乐观置为 delivered:false，真正拿到对方P2P的ACK确认后才置为
  // true；断线重连时 index.html 的 resendUndeliveredTo 会扫描所有
  // delivered:false 的、自己发出的消息，逐条重新尝试发送。
  async function markMessageDelivered(msgId, delivered = true) {
    const store = await tx('messages', 'readwrite');
    const msg = await reqToPromise(store.get(msgId));
    if (!msg) return;
    msg.delivered = delivered;
    await reqToPromise(store.put(msg));
  }
  async function listUndeliveredMessages() {
    const me = await getAccount();
    if (!me) return [];
    const store = await tx('messages');
    const all = await reqToPromise(store.getAll());
    return all.filter(m => m.ownerId === me.userId && m.from === me.userId && m.delivered === false);
  }

  // 清理过期消息，并自动解散 TTL 超时（从 createdAt 算起）的临时群组
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
        // 删除该所有者+会话对应的所有消息
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
    listMessages, addMessage, getMessage, deleteMessage, deleteMessages,
    markMessageDelivered, listUndeliveredMessages,
    purgeExpiredMessages
  };
})();