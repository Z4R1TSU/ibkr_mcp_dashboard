import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
// @ts-ignore Standalone native login observer.
import { authenticationEndpoint, observeLogin, WS_URL } from '../integrations/thinkorswim/login-policy.mjs';

test('native login observes traffic without HTTP or WebSocket interception', () => {
  const page = new EventEmitter();
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    route: () => assert.fail('HTTP interception must not be installed'),
    routeWebSocket: () => assert.fail('WebSocket interception must not be installed'),
  });
  const status: any = {}, received: unknown[] = [];
  observeLogin(context, status, (raw: unknown) => received.push(raw));
  const socket = Object.assign(new EventEmitter(), { url: () => WS_URL });
  page.emit('websocket', socket);
  const payload = '{"payload":[{"header":{"service":"login"},"body":{}}]}';
  socket.emit('framesent', { payload });
  assert.deepEqual(received, []);
  socket.emit('framereceived', { payload });
  assert.deepEqual(received, [payload]);
  const request = { url: () => 'https://sws-gateway-nr.thinkorswim.com/api/v2/auth/login?uid=private', method: () => 'POST' };
  context.emit('request', request);
  context.emit('response', { request: () => request, status: () => 403 });
  assert.deepEqual(status.authRequests, [{ origin: 'https://sws-gateway-nr.thinkorswim.com', path: '/api/v2/auth/login', method: 'POST', status: 403 }]);
  assert.equal(JSON.stringify(status).includes('private'), false);
});
test('diagnostics omit query data and unrelated URLs', () => {
  assert.equal(authenticationEndpoint('https://evil.test/api/v2/auth/login'), null);
  assert.equal(authenticationEndpoint('https://sws-gateway-nr.thinkorswim.com/api/orders'), null);
  assert.deepEqual(authenticationEndpoint('https://sws-gateway-nr.thinkorswim.com/api/v2/user/data?uid=private'),
    {origin:'https://sws-gateway-nr.thinkorswim.com',path:'/api/v2/user/data'});
});
