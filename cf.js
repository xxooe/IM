/* ============ cf.js ============
   BubbleCF — 用于已部署 Cloudflare Worker (index.js + signalRoom.js)
   的轻量 REST 客户端。与其路由完全匹配：

     POST /publish            {userId, nickname, avatarEmoji, color, publicKeyB64}
     GET  /profile/:userId    精确查找，若未发布则返回 404
     GET  /search?query=      基于用户 ID 或昵称的前缀匹配
     POST /register/allocate-id   分配顺序数字 UserID
     POST /turn/credentials       短期 TURN 凭证

   只有公开数据会通过 /publish 和 /search 处理：userId、nickname、
   avatarEmoji、color 以及 ECDH publicKeyB64（本就设计为公开 — 节点
   用它与你计算共享 AES 密钥）。绝不传递私钥，也绝不传递密码哈希。

   已去掉服务端离线消息队列（原 /offline/push、/offline/pull 两个接口，
   以及本文件里对应的 pushOffline/pullOffline）——服务端不再持久化任何
   消息副本。取而代之：发送方本地IndexedDB把还没被对方P2P确认收到的消息
   标记为"未送达"，等真正跟对方建立起P2P直连时自动补发，见 index.html 里
   的 resendUndeliveredTo 和 P2P.setChannelOpenHandler。这样一来正常聊天
   全程都不再触碰服务端存储，只有注册、资料发布/更新、搜索/查看资料这几个
   场景才会读写数据库。

   通过 plain <script src="cf.js"> 加载，向全局暴露 window.BubbleCF。
*/
const BubbleCF = (() => {

  // 与 comm.js 中信号中继相同的 Worker 地址，只是这里使用普通
  // HTTPS 源而不是 wss:// 信号路径。
  // const API_BASE = 'https://pipoim-signal.jatosi6060.workers.dev';
  const API_BASE = 'https://wss.xxooe.com';

  async function request(path, opts){
    const res = await fetch(API_BASE + path, {
      headers: {'Content-Type':'application/json'},
      ...opts
    });
    if(!res.ok){
      let detail = '';
      try{ detail = (await res.json()).error || ''; }catch(_){}
      const err = new Error(`CF ${opts?.method||'GET'} ${path} -> ${res.status} ${detail}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /* 将我当前的公开资料发布到目录。在注册、登录后
     以及任何昵称/头像发生变更时调用此函数。 */
  async function publishProfile(acc){
    if(!acc || !acc.userId) return null;
    return request('/publish', {
      method: 'POST',
      body: JSON.stringify({
        userId: acc.userId,
        nickname: acc.nickname,
        avatarEmoji: acc.avatarEmoji,
        color: acc.color,
        publicKeyB64: acc.publicKeyB64
      })
    });
  }

  /* 根据 userId 进行精确查找 — 用于解析群成员或手动输入/扫码获取但
     本地未缓存的 ID。若未找到则返回 null（不视为错误）。 */
  async function getProfile(userId){
    if(!userId) return null;
    try{
      return await request('/profile/' + encodeURIComponent(userId));
    }catch(err){
      if(err.status === 404) return null;
      throw err;
    }
  }

  /* 按 userId（前缀）或 nickname（前缀，不区分大小写）搜索。
     返回格式为 [{userId, nickname, avatarEmoji, color, publicKeyB64}] 的数组。 */
  async function searchUsers(query){
    if(!query) return [];
    const data = await request('/search?query=' + encodeURIComponent(query));
    return Array.isArray(data.results) ? data.results : [];
  }

  /* 顺序数字 UserID (101001, 101002, ...)，由服务端
     IdAllocator Durable Object 进行分配，因此两人在同一时刻
     注册绝不会发生冲突。与 publishProfile 不同，该操作不是尽力而为的 — 
     注册必须取得真实唯一的 ID 才能继续，因此
     调用方应该向用户展示明确的错误提示（并允许重试），而不是静默回退到本地生成的 ID。 */
  async function allocateUserId(){
    const data = await request('/register/allocate-id', {method:'POST'});
    return data.userId;
  }

  /* 短期 TURN 凭证——只有直连打不穿 NAT/防火墙的时候才用得上。没配置 TURN
     的话 Worker 会返回 501，这里当成"没有 TURN 可用"处理，不算错误，P2P
     模块会自动退化成只用免费的 Cloudflare STUN。 */
  async function getTurnCredentials(){
    try{
      const data = await request('/turn/credentials', {method:'POST'});
      if(!data || !data.iceServers) return null;
      // Cloudflare 这个接口返回的 iceServers 有时是单个对象，有时是数组，统一成数组
      return Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    }catch(err){
      console.warn('[CF] TURN 凭证不可用（可能没配置），仅使用 STUN', err);
      return null;
    }
  }

  return { publishProfile, getProfile, searchUsers, allocateUserId, getTurnCredentials };
})();