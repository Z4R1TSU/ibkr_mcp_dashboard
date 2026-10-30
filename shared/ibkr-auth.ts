export function ibkrConnectionNotice(outcome: string | null): string {
  if (!outcome) return '';
  const messages: Record<string, string> = {
    success: 'IB 只读授权已完成，已返回看板，正在采集账户数据。',
    'session-expired': '已返回看板，但授权期间看板登录会话失效。请重新登录看板，再点击“连接 IB”完成授权。',
    'invalid-state': '已返回看板，但本次授权链接无效、已使用或已被替换。请重新点击“连接 IB”，并在同一浏览器完成授权。',
    'access-denied': '已返回看板，IB 授权已取消。需要读取账户时，请重新点击“连接 IB”。',
    'missing-code': '已返回看板，但 IB 没有返回授权码。请重新点击“连接 IB”完成官方授权。',
    'token-exchange-failed': '已返回看板，但未能取得 IB 访问令牌。请重新点击“连接 IB”；若持续失败，请检查服务器授权日志。',
    'ib-error': '已返回看板，IB 未完成本次授权。请根据 IB 页面提示处理后重新连接。',
    busy: '已返回看板，另一项授权请求正在处理。请稍后从看板重新连接 IB。',
  };
  return Object.hasOwn(messages, outcome) ? messages[outcome] : 'IB 授权未完成。请从看板重新点击“连接 IB”。';
}
