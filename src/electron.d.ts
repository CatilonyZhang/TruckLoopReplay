type LatestReplayPayload = {
  path: string
  directory: string
  content: string
}

type DayunDesktopBridge = {
  platform: string
  versions: {
    node: string
    chrome: string
    electron: string
  }
  loadLatestReplay?: (directory?: string) => Promise<LatestReplayPayload>
}

declare global {
  interface Window {
    dayunDesktop?: DayunDesktopBridge
  }
}

export {}

