/* ============ friend-profile-sync.js ============
   点击好友头像 → 查看资料 → 从"数据库"（Worker + D1，经 BubbleCF 暴露）
   拉取最新公开资料 → 落地写入本地 IndexedDB（BubbleDB）。

   设计要点：
   - 服务端字段（nickname/avatarEmoji/color/publicKeyB64/registeredAt）
     可以被覆盖；本地专属字段（remark/pinned/addedAt/status）永远不碰。
   - 不依赖任何全局变量：BubbleCF/BubbleDB 通过构造函数注入，方便测试
     和在别的项目里复用。
   - 网络失败不影响可用性：先返回本地已有的数据（如果有），网络请求
     完成后再通过 onUpdate 回调通知调用方"有更新了，重新渲染吧"。

   用法：
     const sync = new FriendProfileSync({ cf: BubbleCF, db: BubbleDB });
     sync.onUpdate((merged) => { ...重新渲染... });
     const cached = await sync.viewAndSync(uid); // 立即可用的（可能是旧的）数据
*/
class FriendProfileSync {
  /**
   * @param {object} deps
   * @param {object} deps.cf - 形如 BubbleCF 的对象，需要 getProfile(userId)
   * @param {object} deps.db - 形如 BubbleDB 的对象，需要 listFriends()/upsertFriend(f)
   */
  constructor({ cf, db }) {
    if (!cf || typeof cf.getProfile !== 'function') {
      throw new Error('FriendProfileSync: 需要传入带 getProfile(userId) 的 cf 依赖');
    }
    if (!db || typeof db.upsertFriend !== 'function') {
      throw new Error('FriendProfileSync: 需要传入带 upsertFriend(f) 的 db 依赖');
    }
    this.cf = cf;
    this.db = db;
    this._listeners = [];
  }

  /** 注册一个"服务端资料已同步完成"的回调，可以注册多个 */
  onUpdate(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(f => f !== fn); };
  }

  /** 只服务端字段是否有变化——决定要不要写库、要不要通知调用方刷新。
      isOnline/lastSeenAt 这两个字段特殊：它们几乎每次查询都可能不一样
      （在线状态随时变），但"在线状态"本身应该优先信实时的 BubblePresence
      事件（见 bubble-presence.js），这里查到的只是"打开资料页那一刻"的
      快照，仅用于展示，不应该覆盖 BubblePresence 维护的实时状态——所以
      这两个字段只在写入 IndexedDB 时带上，不计入"要不要通知刷新"的判断，
      避免在线状态的轻微延迟触发不必要的整页重渲染。 */
  _serverFieldsChanged(local, remote) {
    const keys = ['nickname', 'avatarEmoji', 'color', 'publicKeyB64', 'registeredAt'];
    return keys.some(k => remote[k] !== undefined && remote[k] !== local?.[k]);
  }

  /**
   * 查看某个好友并同步资料。
   * @param {string} uid
   * @param {object} [opts]
   * @param {Array<object>} [opts.localFriends] - 如果调用方已经有一份好友列表在内存里，
   *        传进来避免这里再查一次 IndexedDB；不传就自己去 db.listFriends() 找。
   * @returns {Promise<object|null>} 立即可用的本地数据（可能还没同步完），找不到本地记录时为 null
   */
  async viewAndSync(uid, opts = {}) {
    const friends = opts.localFriends || (await this._safeListFriends());
    const local = friends.find(f => f.userId === uid) || null;

    // 异步去同步，不阻塞调用方先拿到本地缓存渲染
    this._syncFromServer(uid, local).catch(err => {
      console.warn('[FriendProfileSync] 同步好友资料失败', uid, err);
    });

    return local;
  }

  async _safeListFriends() {
    try { return await this.db.listFriends(); }
    catch (e) { console.warn('[FriendProfileSync] 读取本地好友列表失败', e); return []; }
  }

  async _syncFromServer(uid, local) {
    const remote = await this.cf.getProfile(uid);
    if (!remote) return null; // 对方还没发布过公开资料，或者网络失败——什么都不用做

    if (!local) {
      // 不是好友关系（比如从搜索结果里点进来看资料），不写 friends 表——
      // 那张表专门用来存"我的好友"，陌生人资料只应该走临时的 profileCache，
      // 由调用方自己决定放哪里。这里直接把 remote 原样返回。
      this._listeners.forEach(fn => fn({ ...remote }));
      return remote;
    }

    if (!this._serverFieldsChanged(local, remote)) return local; // 没变化，不用写库、不用通知

    const merged = {
      ...local, // remark / pinned / addedAt / status 等本地专属字段原样保留
      nickname: remote.nickname ?? local.nickname,
      avatarEmoji: remote.avatarEmoji ?? local.avatarEmoji,
      color: remote.color ?? local.color,
      publicKeyB64: remote.publicKeyB64 ?? local.publicKeyB64,
      registeredAt: remote.registeredAt ?? local.registeredAt,
      // 在线状态只是展示用的快照，实时性靠 BubblePresence；这里写进本地库
      // 仅仅是为了"离线后最后一次看到的状态"这类展示需求（比如资料页上
      // 显示"最后上线于 xx 分钟前"）。
      lastSeenAt: remote.lastSeenAt ?? local.lastSeenAt,
    };

    await this.db.upsertFriend(merged);
    this._listeners.forEach(fn => fn(merged));
    return merged;
  }
}

// 双模导出：浏览器 <script> 标签下挂到 window，也支持 CommonJS/ESM 环境测试
if (typeof window !== 'undefined') window.FriendProfileSync = FriendProfileSync;
if (typeof module !== 'undefined' && module.exports) module.exports = FriendProfileSync;
