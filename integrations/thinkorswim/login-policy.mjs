export const WS_URL = 'wss://thinkorswim-services.schwab.com/Services/WsJson';
const authGateways = new Set(['https://sws-gateway.thinkorswim.com', 'https://sws-gateway-nr.thinkorswim.com',
  'https://sws-gateway.schwab.com', 'https://sws-gateway-nr.schwab.com']);
export function authenticationEndpoint(url) {
  const u = new URL(url);
  return authGateways.has(u.origin) && (/^\/api\/v2\/auth\/[a-z_]+(?:\/[a-z_]+)*$/.test(u.pathname)
    || u.pathname === '/api/v2/user/data') ? { origin: u.origin, path: u.pathname } : null;
}

// Observe native browser traffic without routing, filtering or rewriting requests.
export function observeLogin(context, status, capture) {
  const requests = new WeakMap();
  status.authRequests = [];
  const track = request => {
    const endpoint = authenticationEndpoint(request.url());
    if (!endpoint) return null;
    if (!requests.has(request)) {
      const item = { ...endpoint, method: request.method(), status: 'pending' };
      requests.set(request, item);
      status.authRequests.push(item);
      status.authRequests = status.authRequests.slice(-20);
    }
    return requests.get(request);
  };
  context.on('request', track);
  context.on('requestfailed', request => {
    const item = track(request);
    if (item) item.status = 'network_error';
  });
  context.on('response', response => {
    const item = track(response.request());
    if (item) item.status = response.status();
  });
  const watch = page => page.on('websocket', socket => {
    if (socket.url() === WS_URL) socket.on('framereceived', event => capture(event.payload));
  });
  context.on('page', watch);
  for (const page of context.pages()) watch(page);
}
