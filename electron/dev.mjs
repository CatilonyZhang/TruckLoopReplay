import { spawn } from 'node:child_process'
import process from 'node:process'

const PORT = 6677
const DEV_URL = `http://127.0.0.1:${PORT}`
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ELECTRON_BIN = process.platform === 'win32' ? 'electron.cmd' : 'electron'

function spawnProc(command, args, extraEnv = {}) {
  return spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
}

async function waitForServer(url, timeoutMs = 45000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return
    } catch {
      // keep waiting
    }
    await new Promise((r) => setTimeout(r, 350))
  }
  throw new Error(`Vite dev server not ready within ${timeoutMs}ms: ${url}`)
}

const vite = spawnProc(NPM_CMD, ['run', 'dev'])

let electron = null

const shutdown = (code = 0) => {
  if (electron && !electron.killed) electron.kill('SIGTERM')
  if (!vite.killed) vite.kill('SIGTERM')
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

vite.on('exit', (code) => {
  if (code !== 0) shutdown(code ?? 1)
})

try {
  await waitForServer(DEV_URL)
  electron = spawnProc(ELECTRON_BIN, ['./electron/main.mjs'], {
    ELECTRON_RENDERER_URL: DEV_URL
  })
  electron.on('exit', (code) => {
    if (!vite.killed) vite.kill('SIGTERM')
    process.exit(code ?? 0)
  })
} catch (err) {
  console.error(String(err))
  shutdown(1)
}

