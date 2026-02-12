const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dayunDesktop', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  loadLatestReplay: (directory) => ipcRenderer.invoke('replay:load-latest', directory)
})

