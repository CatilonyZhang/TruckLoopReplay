export function createObserverSocket(onMessage: (data: any) => void) {
  const ws = new WebSocket('ws://localhost:8000/ws/observer')
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      onMessage(data)
    } catch {
      // ignore
    }
  }
  return ws
}
