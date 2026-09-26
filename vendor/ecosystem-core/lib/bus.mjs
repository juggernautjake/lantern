// The live connection from an app's server to its own pages (Server-Sent Events), plus an in-process event hook.
// Standalone: nothing here knows about schedules, owners or courses, so any module can broadcast without importing
// the rest of the app.
//
//   const bus = createBus({ hello: () => ({ recent: [] }) });
//   bus.addClient(res)            GET /api/events → keeps the response open and sends every broadcast
//   bus.broadcast("refresh", {})  every open page gets  event: refresh / data: {...}
//   bus.clientCount()             how many pages are connected (0 = the screen is closed)
//   bus.on((type, data) => …)     the same events, inside the server
// A default bus is exported too, for apps that only need one.

export function createBus({ hello = null, pingMs = 25_000, keep = 50 } = {}) {
  const clients = new Set();
  const listeners = new Set();
  const recent = [];

  function addClient(res, { kind = "page" } = {}) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const first = typeof hello === "function" ? hello() : hello;
    res.write(`event: hello\ndata: ${JSON.stringify(first ?? { recent: recent.slice(-3) })}\n\n`);
    const c = { res, kind, at: Date.now() };
    clients.add(c);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, pingMs);
    ping.unref?.();
    res.on("close", () => { clearInterval(ping); clients.delete(c); });
    return () => { clearInterval(ping); clients.delete(c); try { res.end(); } catch { /* closed */ } };
  }
  // kind: count only pages of one kind ("display", "welcome"…); none = all
  const clientCount = (kind = null) => (kind ? [...clients].filter((c) => c.kind === kind).length : clients.size);
  function broadcast(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    recent.push({ type, data, at: Date.now() }); if (recent.length > keep) recent.shift();
    for (const c of clients) { try { c.res.write(msg); } catch { clients.delete(c); } }
    for (const fn of listeners) { try { fn(type, data); } catch { /* a listener's problem stays its own */ } }
  }
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const closeAll = () => { for (const c of clients) { try { c.res.end(); } catch { /* closed */ } } clients.clear(); };
  return { addClient, clientCount, broadcast, on, recent: () => recent.slice(-20), closeAll };
}

const main = createBus();
export const addClient = main.addClient, clientCount = main.clientCount, broadcast = main.broadcast, on = main.on, recent = main.recent;
export default main;
