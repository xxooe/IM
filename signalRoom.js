// ============ signalRoom.js ============
// One Durable Object instance == one chat room (a 1:1 conversation or an
// ephemeral group room). It never sees plaintext — every message it relays is
// whatever ciphertext envelope the client already encrypted client-side.
//
// Uses the WebSocket Hibernation API (state.acceptWebSocket / getWebSockets)
// instead of holding sockets in a plain in-memory array. This lets Cloudflare
// evict the object from memory while the room is idle (nobody billed, nothing
// running) and instantly resume it the moment a message arrives — which is
// exactly what keeps a "spin up a temporary room, chat for 10 minutes, dissolve
// it" pattern free on the Workers Free plan.

export class SignalRoom {
  constructor(state, env){
    this.state = state;
    this.env = env;
  }

  async fetch(request){
    const upgradeHeader = request.headers.get('Upgrade');
    if(!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket'){
      return new Response('expected a websocket upgrade', {status:426});
    }

    const url = new URL(request.url);
    const uid = url.searchParams.get('uid') || crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag the socket with the user id so we can identify who sent what if needed later.
    this.state.acceptWebSocket(server, [uid]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // Fired for every message from any hibernating/live socket in this room.
  async webSocketMessage(ws, message){
    const sockets = this.state.getWebSockets();
    for(const peer of sockets){
      if(peer === ws) continue; // don't echo back to the sender
      try{ peer.send(message); }catch(e){ /* peer gone, ignore */ }
    }
  }

  async webSocketClose(ws, code, reason, wasClean){
    // Nothing to clean up manually — the Hibernation API drops closed sockets
    // from getWebSockets() automatically. Left here as an extension point
    // (e.g. broadcast a "peer left" system event) if you want presence later.
  }

  async webSocketError(ws, error){
    // Same as close — extension point for future presence/error handling.
  }
}
