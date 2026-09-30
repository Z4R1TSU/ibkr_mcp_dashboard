import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.env.DATA_DIR ?? './data', 'initial-password.txt');
if (!fs.existsSync(file)) throw new Error('初始密码尚未生成或已移除，请启动服务或使用已设置的密码');
console.log('初始看板访问密码：\n' + fs.readFileSync(file, 'utf8').trim());
