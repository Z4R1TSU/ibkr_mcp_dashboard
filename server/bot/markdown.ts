// Prefer paragraph/line boundaries, and close/reopen fenced code across messages.
// 3,000 Unicode characters leave room for Feishu's JSON/post byte limit.
export function splitMarkdown(text: string): string[] {
  const points = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  let fence = '';
  let opening = '';
  while (offset < points.length) {
    const prefix = fence ? opening + '\n' : '';
    const capacity = 3000 - Array.from(prefix).length - 100;
    let length = Math.min(capacity, points.length - offset);
    if (offset + length < points.length) {
      const candidate = points.slice(offset, offset + length).join('');
      const paragraph = candidate.lastIndexOf('\n\n');
      const line = candidate.lastIndexOf('\n');
      const boundary = paragraph > candidate.length / 2 ? paragraph + 2 : line > candidate.length / 2 ? line + 1 : -1;
      if (boundary > 0) length = Array.from(candidate.slice(0, boundary)).length;
    }
    const part = points.slice(offset, offset + length).join('');
    const lines = part.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && offset > 0 && points[offset - 1] !== '\n') continue;
      const match = /^ {0,3}(`{3,80}|~{3,80})(.*)$/.exec(lines[i]);
      if (!match) continue;
      if (!fence) {
        fence = match[1];
        opening = match[0].slice(0, 80);
      } else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
        fence = ''; opening = '';
      }
    }
    chunks.push(prefix + part + (fence ? '\n' + fence : ''));
    offset += length;
  }
  return chunks;
}
