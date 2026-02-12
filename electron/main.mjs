import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_REPLAY_DIR = '/Volumes/E/TRUNK_LOOP/dayun_spiral_exports'

ipcMain.handle('replay:load-latest', async (_event, preferredDir) => {
  const dir = typeof preferredDir === 'string' && preferredDir.trim().length > 0
    ? preferredDir.trim()
    : DEFAULT_REPLAY_DIR
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)

  if (jsonFiles.length === 0) {
    throw new Error(`No json replay files found in: ${dir}`)
  }

  const withStats = await Promise.all(
    jsonFiles.map(async (name) => {
      const fullPath = path.join(dir, name)
      const stat = await fs.stat(fullPath)
      return { fullPath, mtimeMs: stat.mtimeMs, name }
    })
  )

  withStats.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
    return b.name.localeCompare(a.name)
  })

  const latest = withStats[0]
  const content = await fs.readFile(latest.fullPath, 'utf8')
  return {
    path: latest.fullPath,
    directory: dir,
    content
  }
})

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: '#11071d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const showLoadError = async (title, detail) => {
    const html = `<!doctype html><html><body style="margin:0;background:#10091a;color:#ffe55e;font-family:monospace;padding:20px">
<h2 style="margin:0 0 12px 0">${title}</h2>
<pre style="white-space:pre-wrap;line-height:1.45;color:#c9f9ff">${detail}</pre>
</body></html>`
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }

  mainWindow.webContents.on('did-fail-load', async (_event, code, desc, url) => {
    const message = `code=${code}\ndesc=${desc}\nurl=${url}`
    console.error('[electron] did-fail-load:', message)
    await showLoadError('页面加载失败', message)
  })

  mainWindow.webContents.on('render-process-gone', async (_event, details) => {
    const message = JSON.stringify(details, null, 2)
    console.error('[electron] render-process-gone:', message)
    await showLoadError('渲染进程异常退出', message)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl).catch(async (err) => {
      const message = String(err)
      console.error('[electron] load dev url failed:', message)
      await showLoadError('开发地址加载失败', message)
    })
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    return
  }

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html')
  if (!fsSync.existsSync(indexPath)) {
    const message = `dist 文件不存在:\n${indexPath}\n\n请先执行:\ncd frontend\nnpm run build`
    console.error('[electron] dist missing:', message)
    showLoadError('找不到构建产物', message).catch(() => null)
    return
  }
  mainWindow.loadFile(indexPath).catch(async (err) => {
    const message = String(err)
    console.error('[electron] load file failed:', message)
    await showLoadError('本地页面加载失败', message)
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
