export type DailySchedule = { kind: 'none' } | { kind: 'invalid' } | { kind: 'valid'; time: string; timeZone: string };

export function parseDailySchedule(input: string, defaultTimeZone: string): DailySchedule {
  let text = input.normalize('NFKC').trim().replace(/[。！!]+$/, '');
  if (!/^(?:(?:请|帮我|麻烦)\s*)?(?:订阅|开启|设置|每天|每日)/.test(text) || !text.includes('日报')) return { kind: 'none' };
  if (/取消|停止|关闭|不要/.test(text)) return { kind: 'none' };
  const beijing = /北京时间|上海时间|中国时间|Asia\/Shanghai|UTC\s*\+\s*0?8(?::00)?/i;
  const timeZone = beijing.test(text) ? 'Asia/Shanghai' : defaultTimeZone;
  text = text.replace(new RegExp(beijing.source, 'gi'), '');
  text = text.replace(/(?:订阅|开启|设置|日报|每天|每日|发送|推送|给我|帮我|麻烦|请|在|于|发|到|的|\s)/g, '');
  const match = /^(上午|下午)?(\d{1,2})(?::(\d{2})|点(?:(半)|(\d{1,2})分?)?)$/.exec(text);
  if (!match) return { kind: 'invalid' };
  let hour = Number(match[2]);
  const minute = match[4] ? 30 : Number(match[3] ?? match[5] ?? 0);
  if (minute > 59 || hour > 23 || (match[1] && (hour < 1 || hour > 12))) return { kind: 'invalid' };
  if (match[1]) hour = hour % 12 + (match[1] === '下午' ? 12 : 0);
  return { kind: 'valid', time: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'), timeZone };
}
