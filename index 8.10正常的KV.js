// ============ index.js ============
// Cloudflare Worker — the ONLY server-side component of the whole app.
// It never stores plaintext messages, never stores a friend graph, and never
// holds a permanent copy of anything: KV entries here are either public
// (nickname + public key, opt-in) or short-lived with an expirationTtl so they
// clean themselves up at zero maintenance cost.
//
// Routes:
//   GET  /signal?room=<id>&uid=<id>        WebSocket upgrade -> forwarded to a
//                                           SignalRoom Durable Object (chat relay
//                                           + WebRTC handshake relay, same room
//                                           works for 1:1 and group)
//   POST /login/qr/init                    PC starts a QR login session
//   POST /login/qr/confirm                 Phone approves a scanned session
//   GET  /login/qr/poll?sessionId=         PC polls until approved
//   GET  /search?query=                    Look up a public nickname/UserID (prefix match on either)
//   GET  /profile/:userId                  Exact lookup of one public profile by userID (404 if not published)
//   POST /publish                          Opt-in: publish my nickname+avatar+pubkey so others can find me
//   POST /offline/push                     Queue an encrypted envelope for an offline friend (TTL'd)
//   GET  /offline/pull?userId=             Fetch + delete my queued envelopes
//   POST /turn/credentials                 Issue short-lived TURN credentials (Cloudflare Realtime)

export { SignalRoom } from './signalRoom.js';

const OFFLINE_TTL_SECONDS = 3 * 24 * 60 * 60;   // 3 days, matches the "cache a few days" decision
const QR_SESSION_TTL_SECONDS = 5 * 60;          // 5 minutes to scan + approve

function cors(resp){
  resp.headers.set('Access-Control-Allow-Origin', '*'); // tighten to your GitHub Pages domain in production
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

/* ---------- signaling: forward the upgrade to the room's Durable Object ---------- */
async function handleSignal(request, env, url){
  const room = url.searchParams.get('room');
  if(!room) return cors(new Response('missing room', {status:400}));
  const id = env.ROOMS.idFromName(room);
  const stub = env.ROOMS.get(id);
  return stub.fetch(request); // DO handles the actual WebSocket upgrade
}

/* ---------- QR login (phone holds the real account, PC gets a temp session) ---------- */
async function handleQrInit(env){
  const sessionId = crypto.randomUUID();
  await env.KV_STORE.put(`qrlogin:${sessionId}`, JSON.stringify({status:'pending'}), {expirationTtl: QR_SESSION_TTL_SECONDS});
  return json({sessionId, expiresInSeconds: QR_SESSION_TTL_SECONDS});
}

async function handleQrConfirm(request, env){
  const body = await request.json().catch(()=>null);
  if(!body || !body.sessionId || !body.userId) return json({error:'bad request'}, 400);
  const key = `qrlogin:${body.sessionId}`;
  const existing = await env.KV_STORE.get(key);
  if(!existing) return json({error:'session expired or not found'}, 404);
  const sessionToken = crypto.randomUUID();
  await env.KV_STORE.put(key, JSON.stringify({status:'confirmed', userId: body.userId, sessionToken}), {expirationTtl: QR_SESSION_TTL_SECONDS});
  return json({ok:true});
}

async function handleQrPoll(request, env, url){
  const sessionId = url.searchParams.get('sessionId');
  if(!sessionId) return json({error:'missing sessionId'}, 400);
  const key = `qrlogin:${sessionId}`;
  const raw = await env.KV_STORE.get(key);
  if(!raw) return json({status:'expired'});
  const data = JSON.parse(raw);
  if(data.status === 'confirmed'){
    await env.KV_STORE.delete(key); // one-time use
  }
  return json(data);
}

/* ---------- public user directory (opt-in only) ----------
   Two KV entries per user, kept in sync:
     user:<userId>                       canonical record — exact lookup (GET /profile/:id)
     pubuser:<nickname_lower>:<userId>   search index — prefix list() by nickname (GET /search)
   /search also prefix-lists user:<query> directly, so searching by userID
   works too, not just by nickname. */
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

  // If nickname changed since last publish, drop the old search-index entry
  // so /search doesn't keep surfacing this user under a stale name.
  const prevRaw = await env.KV_STORE.get(`user:${profile.userId}`);
  if(prevRaw){
    try{
      const prev = JSON.parse(prevRaw);
      if(prev.nickname && prev.nickname.toLowerCase() !== profile.nickname.toLowerCase()){
        await env.KV_STORE.delete(`pubuser:${prev.nickname.toLowerCase()}:${profile.userId}`);
      }
    }catch(_){}
  }

  await env.KV_STORE.put(`user:${profile.userId}`, JSON.stringify(profile));
  await env.KV_STORE.put(`pubuser:${profile.nickname.toLowerCase()}:${profile.userId}`, JSON.stringify(profile));
  return json({ok:true, profile});
}

async function handleGetProfile(userId, env){
  const raw = await env.KV_STORE.get(`user:${userId}`);
  if(!raw) return json({error:'not found'}, 404);
  return json(JSON.parse(raw));
}

async function handleSearch(env, url){
  const queryRaw = (url.searchParams.get('query') || '').trim();
  if(!queryRaw) return json({results:[]});
  const queryLower = queryRaw.toLowerCase();

  const [byId, byNick] = await Promise.all([
    env.KV_STORE.list({prefix: `user:${queryRaw}`, limit: 20}),          // matches userID prefix
    env.KV_STORE.list({prefix: `pubuser:${queryLower}`, limit: 20}),     // matches nickname prefix
  ]);

  const seen = new Map(); // userId -> profile, dedup between the two indexes
  for(const k of [...byId.keys, ...byNick.keys]){
    const raw = await env.KV_STORE.get(k.name);
    if(!raw) continue;
    const profile = JSON.parse(raw);
    seen.set(profile.userId, profile);
  }
  return json({results: Array.from(seen.values()).slice(0, 20)});
}

/* ---------- offline message queue (ciphertext only, auto-expires) ---------- */
async function handleOfflinePush(request, env){
  const body = await request.json().catch(()=>null);
  if(!body || !body.toUserId || !body.envelope) return json({error:'bad request'}, 400);
  const msgId = crypto.randomUUID();
  await env.KV_STORE.put(
    `offline:${body.toUserId}:${msgId}`,
    JSON.stringify({from: body.fromUserId, envelope: body.envelope, ts: Date.now()}),
    {expirationTtl: OFFLINE_TTL_SECONDS}
  );
  return json({ok:true, msgId});
}

async function handleOfflinePull(request, env, url){
  const userId = url.searchParams.get('userId');
  if(!userId) return json({error:'missing userId'}, 400);
  const list = await env.KV_STORE.list({prefix:`offline:${userId}:`});
  const items = [];
  for(const k of list.keys){
    const raw = await env.KV_STORE.get(k.name);
    if(raw){ items.push(JSON.parse(raw)); await env.KV_STORE.delete(k.name); } // deliver-once
  }
  return json({items});
}

/* ---------- short-lived TURN credentials (only needed when P2P can't punch through NAT) ---------- */
async function handleTurnCredentials(request, env){
  if(!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN){
    return json({error:'TURN not configured — set TURN_KEY_ID and TURN_KEY_API_TOKEN secrets'}, 501);
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
