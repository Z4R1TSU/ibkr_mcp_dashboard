const canvas = document.querySelector('#screen'), state = document.querySelector('#state');
let csrf, pending = Promise.resolve(), stopped = false, requestError = '', lastStage = null;
document.querySelector('#credentials').onsubmit = async event => {
  event.preventDefault();
  const data = { username: document.querySelector('#username').value,
    password: document.querySelector('#password').value, trustDevice: document.querySelector('#trust').checked };
  document.querySelector('#password').value = '';
  document.querySelector('#submit').disabled = true;
  state.textContent = '正在连接嘉信…';
  try { await request('credentials', data); }
  catch (error) { state.textContent = error.message; }
  finally { data.password = ''; }
};
for (const button of document.querySelectorAll('[data-factor]')) button.onclick = () => {
  request('factor', { kind: button.dataset.factor }).catch(error => { state.textContent = error.message; });
};
document.querySelector('#otp').onsubmit = async event => {
  event.preventDefault();
  const data = { code: document.querySelector('#code').value };
  document.querySelector('#code').value = '';
  try { await request('code', data); }
  catch (error) { state.textContent = error.message; }
  finally { data.code = ''; }
};
async function request(route, value) {
  if (value !== undefined) { await sessionReady; requestError = ''; }
  const response = await fetch('/tos-login/' + route, value === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(value),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    requestError = body.error === 'busy' ? '登录请求正在处理，请等待当前步骤完成。'
      : body.error === 'login_window_not_ready' ? '原生登录窗口尚未就绪，请重新打开。'
      : response.status === 409 ? '请回到启动登录的同一浏览器窗口，或重新打开登录页。'
      : response.status === 401 || response.status === 403 ? '看板会话已失效，请刷新页面后再试。'
      : '登录入口暂不可用，请稍后重试。';
    throw new Error(requestError);
  }
  return response;
}
function input(value) {
  pending = pending.then(() => request('input', value)).catch(error => { state.textContent = error.message; });
}
canvas.addEventListener('click', event => {
  const box = canvas.getBoundingClientRect();
  canvas.focus();
  input({ type: 'click', x: (event.clientX - box.left) * canvas.width / box.width, y: (event.clientY - box.top) * canvas.height / box.height });
});
canvas.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
  event.preventDefault();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') input({ type: 'key', key: 'Control+a' });
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) input({ type: 'text', text: event.key });
  else if (['Tab', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key))
    input({ type: 'key', key: event.key === 'Tab' && event.shiftKey ? 'Shift+Tab' : event.key });
});
canvas.addEventListener('paste', event => {
  event.preventDefault();
  input({ type: 'text', text: event.clipboardData.getData('text').slice(0, 512) });
});
canvas.addEventListener('wheel', event => {
  event.preventDefault(); input({ type: 'scroll', delta: event.deltaY });
}, { passive: false });
document.querySelector('#start').onclick = () => request('start', { restart: true }).catch(error => { state.textContent = error.message; });
document.querySelector('#stop').onclick = () => request('stop', {}).catch(error => { state.textContent = error.message; });
document.querySelector('#fallback').addEventListener('toggle', () => {
  if (document.querySelector('#fallback').open) request('start', {}).catch(error => { state.textContent = error.message; });
});
const labels = { idle: '请输入嘉信登录信息。', starting: '正在连接嘉信…',
  login: '请输入嘉信登录信息。', authenticated: '登录成功，行情采集器正在连接。',
  submitting: '正在提交登录信息，请稍候…', verification: '正在等待嘉信验证页面…',
  factor: '请选择双重验证方式。', code: '请输入嘉信发来的短信验证码。',
  waiting_mobile: '请在手机上批准嘉信登录请求，完成后会自动继续。',
  manual_required: '出现了需要人工处理的页面，请展开下方原生页面。',
  login_failed: '嘉信未接受本次登录，请检查信息后重新尝试。',
  expired: '登录窗口已超时关闭，可重新打开。', browser_error: '浏览器启动失败，请检查服务。',
  login_page_rejected: '嘉信认证页面拒绝当前连接。尚未取得登录凭据。' };
async function refresh() {
  if (stopped) return;
  try {
    const value = await (await request('status')).json();
    const stage = value.stage || value.state;
    if (lastStage !== null && stage !== lastStage) requestError = '';
    lastStage = stage;
    state.textContent = requestError || labels[stage] || '等待登录';
    document.querySelector('#credentials').hidden = ['factor', 'code', 'waiting_mobile', 'verification', 'authenticated'].includes(stage);
    document.querySelector('#submit').disabled = ['starting', 'submitting'].includes(stage);
    document.querySelector('#factor').hidden = stage !== 'factor';
    for (const button of document.querySelectorAll('[data-factor]')) button.hidden = !(value.channels || []).includes(button.dataset.factor);
    document.querySelector('#otp').hidden = stage !== 'code';
    if (document.querySelector('#fallback').open && !['idle', 'starting', 'authenticated', 'expired'].includes(stage)) {
      const response = await request('frame');
      if (response.status === 200) {
        const bitmap = await createImageBitmap(await response.blob());
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
      }
    } else canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  } catch (error) { state.textContent = error.message; }
  setTimeout(refresh, document.querySelector('#fallback').open ? 1000 : 2000);
}
const sessionReady = fetch('/api/session').then(r => r.json()).then(s => { csrf = s.csrf; });
sessionReady.then(() => refresh()).catch(() => { state.textContent = '无法连接看板，请刷新页面。'; });
window.addEventListener('pagehide', () => { stopped = true; });
