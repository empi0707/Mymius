// Chẩn đoán: server có gửi MOTD (thông báo trạng thái khi đăng nhập) cho thư viện ssh2 mà Mymius dùng không?
// Chạy: node scripts/ssh-motd-check.mjs user@host [port]      (khóa riêng: SSH_KEY=~/.ssh/id_ed25519, hoặc mật khẩu: SSH_PASSWORD=...)
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const { Client } = require('ssh2')

const [target, port = '22'] = process.argv.slice(2)
if (!target?.includes('@')) { console.error('Dùng: node scripts/ssh-motd-check.mjs user@host [port]'); process.exit(2) }
const [username, host] = target.split('@')
const key = process.env.SSH_KEY
const conn = new Client()
conn.on('banner', (m) => console.log('--- BANNER trước khi đăng nhập ---\n' + m))
// Mở 2 shell liên tiếp trên CÙNG một kết nối (như Mymius khi mở nhiều tab/pane vào một host) rồi so sánh.
const grab = (label) => new Promise((resolve, reject) => {
  conn.shell({ term: 'xterm-256color', cols: 120, rows: 40, height: 0, width: 0 }, (err, stream) => {
    if (err) return reject(err)
    let got = ''
    stream.on('data', (d) => { got += d })
    setTimeout(() => {
      stream.end('exit\n')
      console.log(`--- ${label}: ${got.length} byte; có "System information": ${got.includes('System information')}; có "Last login": ${got.includes('Last login')} ---`)
      console.log(JSON.stringify(got.slice(0, 400)) + (got.length > 400 ? ' …' : ''))
      resolve()
    }, 3000)
  })
})
conn.on('ready', async () => {
  await grab('Shell #1 (kết nối mới)')
  await grab('Shell #2 (cùng kết nối)')
  conn.end()
})
conn.on('error', (e) => { console.error('Lỗi:', e.message); process.exit(1) })
conn.connect({
  host, port: Number(port), username,
  ...(key ? { privateKey: readFileSync(key.replace(/^~/, homedir())) } : {}),
  ...(process.env.SSH_PASSWORD ? { password: process.env.SSH_PASSWORD } : {}),
  ...(process.env.SSH_AUTH_SOCK ? { agent: process.env.SSH_AUTH_SOCK } : {})
})
