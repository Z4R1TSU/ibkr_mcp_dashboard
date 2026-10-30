// Read only the sanitized login state, never browser fields or authentication payloads.
import fs from 'node:fs';
const { key } = JSON.parse(fs.readFileSync('data/thinkorswim/login-key.json', 'utf8'));
const response = await fetch('http://127.0.0.1:8052/status', {
  headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000),
});
const d = await response.json();
console.log(JSON.stringify({ httpStatus: response.status, state: d.state, stage: d.stage,
  authRequests: d.authRequests, verificationHttpStatus: d.verificationHttpStatus }));
