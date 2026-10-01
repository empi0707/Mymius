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
conn.on('ready', () => {
  conn.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, stream) => {
    if (err) throw err
    let got = ''
    stream.on('data', (d) => { got += d })
    setTimeout(() => {
      console.log('--- Dữ liệu shell nhận được trong 3 giây (JSON để thấy mã điều khiển) ---')
      console.log(JSON.stringify(got))
      stream.end('exit\n')
      conn.exec('ls -l /run/motd.dynamic /etc/motd /etc/update-motd.d 2>&1; echo ---; grep -iE "PrintMotd|PrintLastLog|UsePAM|Banner" /etc/ssh/sshd_config 2>&1', (e, s) => {
        let out = ''
        s.on('data', (d) => { out += d })
        s.on('close', () => { console.log('--- Cấu hình server ---\n' + out); conn.end() })
      })
    }, 3000)
  })
})
conn.on('error', (e) => { console.error('Lỗi:', e.message); process.exit(1) })
conn.connect({
  host, port: Number(port), username,
  ...(key ? { privateKey: readFileSync(key.replace(/^~/, homedir())) } : {}),
  ...(process.env.SSH_PASSWORD ? { password: process.env.SSH_PASSWORD } : {}),
  ...(process.env.SSH_AUTH_SOCK ? { agent: process.env.SSH_AUTH_SOCK } : {})
})
