// 杀掉占用 3099 的 node 进程（重新创建 kill 脚本）
const { execSync } = require('child_process')
const out = execSync('netstat -ano | findstr ":3099" | findstr "LISTENING"', { encoding: 'utf8', shell: 'cmd.exe' })
console.log(out)
const pids = [...new Set(out.split(/\r?\n/).filter(l => l.trim()).map(l => l.trim().split(/\s+/).pop()).filter(p => p && p !== '0'))]
for (const pid of pids) {
  try {
    execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', shell: 'cmd.exe' })
    console.log(`killed ${pid}`)
  } catch (e) { console.log(`kill ${pid} failed`) }
}
