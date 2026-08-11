// ============ index.js ============
// Cloudflare Worker — 整个应用唯一的服务端组件。它从不存储明文消息，从不存储好友关系图，也从不永久保留任何副本：这里的 KV 记录要么是公开的（昵称 + 公钥，需用户选择加入），
// 要么带有 expirationTtl 短期过期机制，以零维护成本自行清理。
//
// 路由：
//   GET  /signal?room=<id>&uid=<id>         WebSocket 升级 -> 转发到 SignalRoom Durable Object（聊天中继 + WebRTC 握手中继，同样的房间可用于单聊和群聊）
//   POST /login/qr/init                     电脑端发起扫码登录会话
//   POST /login/qr/confirm                  手机端确认授权扫码会话
//   GET  /login/qr/poll?sessionId=          电脑端轮询直到确认
//   GET  /search?query=                     查询公开的昵称/用户ID（两者均支持前缀匹配）
//   GET  /profile/:userId                   按 userID 精确查询单个公开资料（未发布则返回404）
//   POST /publish                           选择加入：发布我的昵称+头像+公钥，让别人能搜到我
//   POST /register/allocate-id              分配下一个顺序数字 UserID（101001, 101002, ...）
//   POST /offline/push                      为离线好友将加密信封排队缓存（带 TTL 自动过期）
//   GET  /offline/pull?userId=              拉取并删除我排队的信封
//   POST /turn/credentials                  签发短期 TURN 凭证（基于 Cloudflare Realtime）

import { KVAdapter } from './KVAdapter.js';   // 让 D1 数据库也能像 KV 一样使用 list() / get() / put() 接口

export { SignalRoom } from './signalRoom.js'; // Durable Object：一个实例 == 一个聊天房间（点对点单聊或临时群聊）

/* ---------- IdAllocator: 一个全局 Durable Object 实例，负责分配
   像 QQ 那样的顺序数字 UserID（101001, 101002, ...），并且强制执行
   每日新注册人数上限（参见下方的 DAILY_REGISTRATION_CAP）。 ----------
   单独靠 KV 无法安全实现这两个功能 — Workers KV 是最终
   一致性的，不支持原子递增，因此在两人同时注册时，单纯的“读取计数、+1、
   写回”竞态可能会分配相同的号码，或者在并发负载下突破每日上限。这里使用
   Durable Object 才是合适的工具：路由到同一个实例的所有请求
   （见下文的 handleAllocateId，始终是同一个 idFromName）会被
   串行逐个处理，因此下面的两个计数器无需额外加锁也是安全的。 */
const DAILY_REGISTRATION_CAP = 800; // 每天最多这么多新注册，超了当天一律拒绝，第二天（UTC）自动重置

export class IdAllocator {
  constructor(state, env){ this.state = state; }
  async fetch(){
    const today = new Date().toISOString().slice(0,10); // UTC 日期字符串，比如 "2026-08-10"，用来判断"是不是新的一天"
    let day = await this.state.storage.get('day');
    let countToday = await this.state.storage.get('countToday') || 0;
    if(day !== today){ day = today; countToday = 0; } // 跨天了，计数器清零重新开始
    if(countToday >= DAILY_REGISTRATION_CAP){
      return new Response(JSON.stringify({error:'daily_cap_reached', message:'今日新用户注册名额已用完，请明天再来注册'}), {status:429, headers:{'Content-Type':'application/json'}});
    }
    let next = await this.state.storage.get('next');
    if(next === undefined) next = 101001; // 6位数，根据“从101001开始”的决定，从10万+1001开始
    await this.state.storage.put({ next: next + 1, day, countToday: countToday + 1 });
    return new Response(JSON.stringify({userId: String(next)}), {headers:{'Content-Type':'application/json'}});
  }
}

const OFFLINE_TTL_SECONDS = 3 * 24 * 60 * 60;   // 3天，符合“缓存几天”的决定
const QR_SESSION_TTL_SECONDS = 5 * 60;          // 5分钟的扫码+确认窗口期

function cors(resp){
  resp.headers.set('Access-Control-Allow-Origin', '*'); // 生产环境建议收紧到你的 GitHub Pages 域名
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  resp.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return resp;
}
function json(data, status=200){
  return cors(new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}}));
}

export default {
  async fetch(request, env){
    if(request.method === 'OPTIONS') return cors(new Response(null, {status:204}));

    const url = new URL(request.url);

    // ========== 仅新增这一行，全局替换所有 env.KV_STORE ==========
    // const KV_STORE = new KVAdapter(env.DB_KV);  // 这里的 env.DB_KV 是 D1 数据库，KVAdapter 会把它包装成 KV_STORE 的接口

    // ========== 新增 切换开关，统一KV_STORE实例，全局复用==========
    const USE_D1 = true;
    const KV_STORE = USE_D1 ? new KVAdapter(env.DB_KV) : env.KV_STORE;  // 这里的 env.DB_KV 是 D1 数据库，KVAdapter 会把它包装成 KV_STORE 的接口，也可以使用原生的 env.KV_STORE
    // =======================================


    if(url.pathname === '/signal'){
      return handleSignal(request, env, url);
    }
    if(url.pathname === '/login/qr/init' && request.method === 'POST'){
      return handleQrInit(env);
    }
    if(url.pathname === '/login/qr/confirm' && request.method === 'POST'){
      return handleQrConfirm(request, env);
    }
    if(url.pathname === '/login/qr/poll' && request.method === 'GET'){
      return handleQrPoll(request, env, url);
    }
    if(url.pathname === '/search' && request.method === 'GET'){
      return handleSearch(env, url);
    }
    const profileMatch = url.pathname.match(/^\/profile\/([^/]+)$/);
    if(profileMatch && request.method === 'GET'){
      return handleGetProfile(decodeURIComponent(profileMatch[1]), env);
    }
    if(url.pathname === '/publish' && request.method === 'POST'){
      return handlePublish(request, env);
    }
    if(url.pathname === '/register/allocate-id' && request.method === 'POST'){
      return handleAllocateId(env);
    }
    if(url.pathname === '/offline/push' && request.method === 'POST'){
      return handleOfflinePush(request, env);
    }
    if(url.pathname === '/offline/pull' && request.method === 'GET'){
      return handleOfflinePull(request, env, url);
    }
    if(url.pathname === '/turn/credentials' && request.method === 'POST'){
      return handleTurnCredentials(request, env);
    }

    return cors(new Response('not found', {status:404}));
  }
};

/* ---------- 顺序数字 UserID 分配 ---------- */
async function handleAllocateId(env){
  // 始终相同的实例名 -> 同一个 Durable Object -> 请求被
  // 串行逐个处理 -> 无论两次注册挨得有多近，
  // 都不可能分到同一个号码。
  const id = env.ID_ALLOCATOR.idFromName('global');
  const stub = env.ID_ALLOCATOR.get(id);
  const resp = await stub.fetch('https://id-allocator/allocate');
  return json(await resp.json(), resp.status); // 把DO返回的状态码（比如429）原样带出去
}

/* ---------- 信令：将升级请求转发给房间的 Durable Object ---------- */
/* 每个用户每个5分钟窗口最多这么多次"新建WS连接"（不是消息条数，是握手次数）——
   和客户端那边"直连成功后缓存5分钟才会断开重连"的节奏是对上的：正常使用，
   一个用户5分钟内建立二十来次新握手已经很宽裕了（好几个好友+好几个群同时
   冷启动也够用），异常情况（比如客户端bug疯狂重连）就会被这里挡住，不会把
   Worker 每天的请求配额（约10万次）耗光。用 KV 实现是近似限流，不是精确
   计数——KV是最终一致性存储，高并发下可能有一点点超发，但这里只是控制
   成本，不是安全边界，够用。 */
const HANDSHAKE_WINDOW_MS = 5 * 60 * 1000;
const HANDSHAKE_LIMIT_PER_WINDOW = 20;

async function checkHandshakeRateLimit(env, uid){
  const windowKey = `hslimit:${uid}:${Math.floor(Date.now()/HANDSHAKE_WINDOW_MS)}`;
  const raw = await KV_STORE.get(windowKey);
  const count = raw ? parseInt(raw,10) : 0;
  if(count >= HANDSHAKE_LIMIT_PER_WINDOW) return false;
  await KV_STORE.put(windowKey, String(count+1), {expirationTtl: Math.ceil(HANDSHAKE_WINDOW_MS/1000) + 60});
  return true;
}

async function handleSignal(request, env, url){
  const room = url.searchParams.get('room');
  const uid = url.searchParams.get('uid');
  if(!room) return cors(new Response('missing room', {status:400}));
  if(uid && !(await checkHandshakeRateLimit(env, uid))){
    return cors(new Response('rate limited: too many new connections, please retry shortly', {status:429}));
  }
  const id = env.ROOMS.idFromName(room);
  const stub = env.ROOMS.get(id);
  return stub.fetch(request); // DO 处理实际的 WebSocket 升级
}

/* ---------- 扫码登录 (手机端持有真正账号，PC端获取临时会话) ---------- */
async function handleQrInit(env){
  const sessionId = crypto.randomUUID();
  await KV_STORE.put(`qrlogin:${sessionId}`, JSON.stringify({status:'pending'}), {expirationTtl: QR_SESSION_TTL_SECONDS});
  return json({sessionId, expiresInSeconds: QR_SESSION_TTL_SECONDS});
}

async function handleQrConfirm(request, env){
  const body = await request.json().catch(()=>null);
  if(!body || !body.sessionId || !body.userId) return json({error:'bad request'}, 400);
  const key = `qrlogin:${body.sessionId}`;
  const existing = await KV_STORE.get(key);
  if(!existing) return json({error:'session expired or not found'}, 404);
  const sessionToken = crypto.randomUUID();
  await KV_STORE.put(key, JSON.stringify({status:'confirmed', userId: body.userId, sessionToken}), {expirationTtl: QR_SESSION_TTL_SECONDS});
  return json({ok:true});
}

async function handleQrPoll(request, env, url){
  const sessionId = url.searchParams.get('sessionId');
  if(!sessionId) return json({error:'missing sessionId'}, 400);
  const key = `qrlogin:${sessionId}`;
  const raw = await KV_STORE.get(key);
  if(!raw) return json({status:'expired'});
  const data = JSON.parse(raw);
  if(data.status === 'confirmed'){
    await KV_STORE.delete(key); // 仅可使用一次
  }
  return json(data);
}

/* ---------- 公开用户目录 (仅限选择加入) ----------
   每个用户对应两条 KV 记录，保持同步：
     user:<userId>                     权威记录 — 精确查找 (GET /profile/:id)
     pubuser:<nickname_lower>:<userId> 搜索索引 — 按昵称前缀列表 (GET /search)
   /search 也会直接前缀匹配 user:<query>，所以不仅能搜昵称，
   通过用户 ID 搜索也是可以的。 */
async function handlePublish(request, env){
  const body = await request.json().catch(()=>null);
  if(!body || !body.userId || !body.nickname || !body.publicKeyB64) return json({error:'bad request'}, 400);
  const profile = {
    userId: body.userId,
    nickname: String(body.nickname).slice(0, 60),
    avatarEmoji: String(body.avatarEmoji || '🙂').slice(0, 8),
    color: /^#[0-9a-fA-F]{3,8}$/.test(body.color) ? body.color : '#37C9B9',
    publicKeyB64: body.publicKeyB64,
    updatedAt: Date.now()
  };

  // 如果距离上次发布修改了昵称，则删掉旧的搜索索引条目，
  // 免得 /search 接口继续用旧名字把这个用户搜出来。
  const prevRaw = await KV_STORE.get(`user:${profile.userId}`);
  if(prevRaw){
    try{
      const prev = JSON.parse(prevRaw);
      if(prev.nickname && prev.nickname.toLowerCase() !== profile.nickname.toLowerCase()){
        await KV_STORE.delete(`pubuser:${prev.nickname.toLowerCase()}:${profile.userId}`);
      }
    }catch(_){}
  }

  // 90天 TTL，客户端每次重新发布（每次登录 —
  // 详见 index.html 中的 publishProfileWithRetry）都会刷新该过期时间。一个废弃的身份
  // （浏览器数据清空，不再回归）会自行老化消失 —
  // 不需要任何手动清理任务。
  const PROFILE_TTL_SECONDS = 90 * 24 * 60 * 60;
  await KV_STORE.put(`user:${profile.userId}`, JSON.stringify(profile), {expirationTtl: PROFILE_TTL_SECONDS});
  await KV_STORE.put(`pubuser:${profile.nickname.toLowerCase()}:${profile.userId}`, JSON.stringify(profile), {expirationTtl: PROFILE_TTL_SECONDS});
  return json({ok:true, profile});
}

async function handleGetProfile(userId, env){
  const raw = await KV_STORE.get(`user:${userId}`);
  if(!raw) return json({error:'not found'}, 404);
  return json(JSON.parse(raw));
}

async function handleSearch(env, url){
  const queryRaw = (url.searchParams.get('query') || '').trim();
  if(!queryRaw) return json({results:[]});
  const queryLower = queryRaw.toLowerCase();

  const [byId, byNick] = await Promise.all([
    KV_STORE.list({prefix: `user:${queryRaw}`, limit: 20}),          // 匹配 userID 前缀
    KV_STORE.list({prefix: `pubuser:${queryLower}`, limit: 20}),     // 匹配昵称前缀
  ]);

  const seen = new Map(); // userId -> profile，在两个索引的结果间去重
  for(const k of [...byId.keys, ...byNick.keys]){
    const raw = await KV_STORE.get(k.name);
    if(!raw) continue;
    const profile = JSON.parse(raw);
    seen.set(profile.userId, profile);
  }
  return json({results: Array.from(seen.values()).slice(0, 20)});
}

/* ---------- 离线消息队列（纯密文，自动过期） ---------- */
async function handleOfflinePush(request, env){
  const body = await request.json().catch(()=>null);
  if(!body || !body.toUserId || !body.envelope) return json({error:'bad request'}, 400);
  const msgId = crypto.randomUUID();
  await KV_STORE.put(
    `offline:${body.toUserId}:${msgId}`,
    JSON.stringify({from: body.fromUserId, envelope: body.envelope, ts: Date.now()}),
    {expirationTtl: OFFLINE_TTL_SECONDS}
  );
  return json({ok:true, msgId});
}

async function handleOfflinePull(request, env, url){
  const userId = url.searchParams.get('userId');
  if(!userId) return json({error:'missing userId'}, 400);
  const list = await KV_STORE.list({prefix:`offline:${userId}:`});
  const items = [];
  for(const k of list.keys){
    const raw = await KV_STORE.get(k.name);
    if(raw){ items.push(JSON.parse(raw)); await KV_STORE.delete(k.name); } // 只投递一次
  }
  return json({items});
}

/* ---------- 短期 TURN 凭证（仅在 P2P 无法打穿 NAT 时才需要） ---------- */
async function handleTurnCredentials(request, env){
  if(!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN){
    return json({error:'TURN 未配置 — 请设置 TURN_KEY_ID 和 TURN_KEY_API_TOKEN 机密变量'}, 501);
  }
  const resp = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method:'POST',
    headers:{
      'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`,
      'Content-Type':'application/json',
    },
    body: JSON.stringify({ ttl: 86400 }),
  });
  const data = await resp.json();
  return json(data, resp.status);
}