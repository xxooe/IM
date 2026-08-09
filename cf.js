/* ============ cf.js ============
   BubbleCF — thin REST client for the deployed Cloudflare Worker
   (index.js + signalRoom.js). Matches ITS routes exactly:

     POST /publish            {userId, nickname, avatarEmoji, color, publicKeyB64}
     GET  /profile/:userId    exact lookup, 404 if not published
     GET  /search?query=      prefix match on userID OR nickname
     POST /offline/push       {toUserId, fromUserId, envelope}
     GET  /offline/pull?userId=   fetch+delete queued items for me

   Only PUBLIC data goes through /publish and /search: userId, nickname,
   avatarEmoji, color, and the ECDH publicKeyB64 (meant to be public — it's
   how peers derive a shared AES key with you). Never the private key, never
   the password hash.

   NOTE on /offline/push: this Worker's SignalRoom is a pure live relay with
   no message history (see signalRoom.js) — if the recipient isn't connected
   to that room at the exact moment you send, the message is gone unless you
   also durably queue it here. That's what pushOffline/pullOffline are for.
   The "envelope" is NOT end-to-end encrypted yet — same trust level as the
   live chat relay today (see the note in index.html). Wiring the existing
   ECDH/AES-GCM primitives in crypto.js through both paths is a good next
   step, just kept out of this pass to avoid changing two systems at once.

   Loaded as a plain <script src="cf.js">, exposes window.BubbleCF.
*/
const BubbleCF = (() => {

  // Same Worker as the signal relay in comm.js, just the plain HTTPS origin
  // instead of the wss:// signal path.
  const API_BASE = 'https://pipoim-signal.jatosi6060.workers.dev';

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

  /* Push my current public profile to the directory. Call this after
     register, after login, and any time nickname/avatar changes. */
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

  /* Exact lookup by userId — used to resolve a group member or a scanned/typed
     ID you don't have cached locally. Returns null if not found (not an error). */
  async function getProfile(userId){
    if(!userId) return null;
    try{
      return await request('/profile/' + encodeURIComponent(userId));
    }catch(err){
      if(err.status === 404) return null;
      throw err;
    }
  }

  /* Search by userId (prefix) or nickname (prefix, case-insensitive).
     Returns an array of {userId, nickname, avatarEmoji, color, publicKeyB64}. */
  async function searchUsers(query){
    if(!query) return [];
    const data = await request('/search?query=' + encodeURIComponent(query));
    return Array.isArray(data.results) ? data.results : [];
  }

  /* Durable fallback delivery for when the recipient isn't connected to the
     relevant signal room right now (group invite, or a chat message to an
     offline friend). Auto-expires after a few days server-side. */
  async function pushOffline(toUserId, fromUserId, envelope){
    if(!toUserId) return null;
    return request('/offline/push', {
      method: 'POST',
      body: JSON.stringify({ toUserId, fromUserId, envelope })
    });
  }

  /* Call once on login/enterApp: fetches (and deletes, deliver-once) anything
     queued for me while I was offline. Returns [{from, envelope, ts}]. */
  async function pullOffline(userId){
    if(!userId) return [];
    const data = await request('/offline/pull?userId=' + encodeURIComponent(userId));
    return Array.isArray(data.items) ? data.items : [];
  }

  /* Sequential numeric UserID (101001, 101002, ...), allocated server-side
     by the IdAllocator Durable Object so two people registering at the same
     instant can never collide. Unlike publishProfile, this is NOT
     best-effort — registration can't proceed without a real, unique ID, so
     callers should surface a clear error (and let the person retry) rather
     than silently falling back to a locally-generated one. */
  async function allocateUserId(){
    const data = await request('/register/allocate-id', {method:'POST'});
    return data.userId;
  }

  return { publishProfile, getProfile, searchUsers, pushOffline, pullOffline, allocateUserId };
})();
