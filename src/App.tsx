import { useEffect, useMemo, useRef, useState } from 'react'
import { createObserverSocket } from './ws'
import { GameState, PlayerState } from './types'
import { ReplayAction, ReplayDiscussion, ReplayFrame, parseLegacyExport } from './legacyAdapter'
import TrackScene3D from './TrackScene3D'
import './styles.css'

const fallbackState: GameState = {
  tick: 0,
  track_length: 60,
  players: [],
  truck: { position: 0, direction: 1, speed: 1, can_multi_hit: false },
  items: [],
  logs: []
}

type BundledReplayAsset = {
  id: string
  label: string
  file: string
}

const BUNDLED_REPLAYS: BundledReplayAsset[] = [
  {
    id: '20260212_205531',
    label: '2026-02-12 20:55:31',
    file: '01_dayun_spiral_export_20260212_205531.json'
  },
  {
    id: '20260212_202037',
    label: '2026-02-12 20:20:37',
    file: '02_dayun_spiral_export_20260212_202037.json'
  },
  {
    id: '20260212_154129',
    label: '2026-02-12 15:41:29',
    file: '03_dayun_spiral_export_20260212_154129.json'
  },
  {
    id: '20260212_150859',
    label: '2026-02-12 15:08:59',
    file: '04_dayun_spiral_export_20260212_150859.json'
  },
  {
    id: '20260212_144312',
    label: '2026-02-12 14:43:12',
    file: '05_dayun_spiral_export_20260212_144312.json'
  }
]

type ConfigState = {
  track_length: number
  max_players: number
  initial_hp: number
  dice_min: number
  dice_max: number
  vision_range: number
  tick_ms: number
  spawn_item_chance: number
  no_damage_chance: number
}

type ScriptedFocusState = {
  enabled: boolean
  agentId: string | null
  phase: 'idle' | 'discussion' | 'sync' | 'move' | 'impact' | 'commentator'
  direction?: 'forward' | 'backward'
  steps?: number
  truckDirection?: number
  truckSteps?: number
  token?: string
  name?: string
  message?: string
}

function normalizeGameState(input: unknown): GameState {
  const raw = (input && typeof input === 'object' ? (input as Record<string, unknown>) : {}) as Record<string, unknown>
  const rawTruck = (raw.truck && typeof raw.truck === 'object' ? (raw.truck as Record<string, unknown>) : {}) as Record<string, unknown>
  const rawPlayers = Array.isArray(raw.players) ? raw.players : []
  const players: PlayerState[] = rawPlayers.map((p, idx) => {
    const rp = (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}) as Record<string, unknown>
    return {
      player_id: typeof rp.player_id === 'string' ? rp.player_id : `ghost-${idx}`,
      name: typeof rp.name === 'string' && rp.name.length > 0 ? rp.name : `P${idx + 1}`,
      avatar: typeof rp.avatar === 'string' && rp.avatar.trim().length > 0 ? rp.avatar.trim() : null,
      position: Number.isFinite(rp.position as number) ? Number(rp.position) : 0,
      facing: Number(rp.facing) >= 0 ? 1 : -1,
      vote_reverse: typeof rp.vote_reverse === 'boolean' ? rp.vote_reverse : null,
      hp: Number.isFinite(rp.hp as number) ? Number(rp.hp) : 0,
      inventory: rp.inventory && typeof rp.inventory === 'object' ? (rp.inventory as Record<string, number>) : {},
      message: typeof rp.message === 'string' ? rp.message : ''
    }
  })
  return {
    tick: Number.isFinite(raw.tick as number) ? Number(raw.tick) : 0,
    track_length: Number.isFinite(raw.track_length as number) ? Math.max(1, Number(raw.track_length)) : fallbackState.track_length,
    players,
    truck: {
      position: Number.isFinite(rawTruck.position as number) ? Number(rawTruck.position) : fallbackState.truck.position,
      direction: Number(rawTruck.direction) >= 0 ? 1 : -1,
      speed: Number.isFinite(rawTruck.speed as number) ? Math.max(1, Number(rawTruck.speed)) : fallbackState.truck.speed,
      can_multi_hit: Boolean(rawTruck.can_multi_hit)
    },
    items: Array.isArray(raw.items) ? (raw.items as GameState['items']) : [],
    logs: Array.isArray(raw.logs) ? (raw.logs as GameState['logs']) : []
  }
}

function wrapTrack(position: number, trackLength: number): number {
  const track = Math.max(1, trackLength)
  return ((position % track) + track) % track
}

function wrapCell(cell: number, trackLength: number): number {
  const track = Math.max(1, trackLength)
  return ((cell % track) + track) % track
}

function visibleCellsBidirectional(position: number, visionRange: number, trackLength: number): { cw: number[]; ccw: number[] } {
  const track = Math.max(1, trackLength)
  const count = Math.max(1, Math.floor(visionRange))
  const base = Math.round(wrapTrack(position, track))
  const cw: number[] = []
  const ccw: number[] = []
  for (let i = 1; i <= count; i += 1) {
    cw.push(wrapCell(base + i, track))
    ccw.push(wrapCell(base - i, track))
  }
  return { cw, ccw }
}

function canSeeTruckBidirectional(position: number, truckPosition: number, visionRange: number, trackLength: number): boolean {
  const track = Math.max(1, trackLength)
  const wrappedPos = wrapTrack(position, track)
  const wrappedTruck = wrapTrack(truckPosition, track)
  const cwDist = (wrappedTruck - wrappedPos + track) % track
  const ccwDist = (wrappedPos - wrappedTruck + track) % track
  return Math.min(cwDist, ccwDist) <= Math.max(1, Math.floor(visionRange))
}

function resolveAvatarSource(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value) return null
  const normalized = value.replace(/\\/g, '/')
  if (/^(https?:|data:|blob:)/i.test(normalized)) return normalized
  const base = import.meta.env.BASE_URL || '/'
  const safeBase = base.endsWith('/') ? base : `${base}/`
  const rel = normalized.startsWith('frontend/public/')
    ? normalized.slice('frontend/public/'.length)
    : normalized.replace(/^\/+/, '').replace(/^\.?\//, '')
  return `${safeBase}${rel}`
}

function isCommentatorPlayer(player: Pick<PlayerState, 'player_id' | 'name'> | null | undefined): boolean {
  if (!player) return false
  const id = (player.player_id || '').trim().toLowerCase()
  const name = (player.name || '').trim().toLowerCase()
  return (
    id === 'commentator' ||
    id.startsWith('commentator') ||
    name.includes('解说') ||
    name.includes('commentator')
  )
}

function sanitizeDisplayMessage(input: string | null | undefined): string {
  let text = (input || '').trim()
  if (!text) return ''
  text = text.replace(/```json[\s\S]*?```/gi, (block) => (/"tool_calls"\s*:/.test(block) ? '' : block))
  text = text.replace(/```[\s\S]*?```/g, '')
  text = text.replace(/\n?\s*```json[\s\S]*$/gi, (block) => (/"tool_calls"\s*:/.test(block) ? '' : block))
  text = text.replace(/\n?\s*\{[\s\S]*"tool_calls"\s*:[\s\S]*\}\s*$/i, '')
  text = text.replace(/```+/g, '')
  return text.trim()
}

function pickCommentatorMood(message: string): { face: string; label: string; tone: string } {
  const text = (message || '').toLowerCase()
  if (/(危险|扣血|死亡|淘汰|撞|翻车|危|hit|dead)/.test(text)) {
    return { face: 'ಠ益ಠ', label: '危险预警', tone: 'danger' }
  }
  if (/(撒谎|欺骗|骗|密谋|私聊|阴|诈|lie|bluff)/.test(text)) {
    return { face: '¬‿¬', label: '识破套路', tone: 'sly' }
  }
  if (/(哈哈|乐|离谱|逆天|爆冷|神|精彩|666|lol)/.test(text)) {
    return { face: '◉‿◉', label: '乐子拉满', tone: 'hype' }
  }
  if (/(预测|下一回合|猜|可能|大概|也许|估计|predict)/.test(text)) {
    return { face: '⊙△⊙', label: '大胆预测', tone: 'spec' }
  }
  return { face: '•ᴗ•', label: '在线解说', tone: 'neutral' }
}

function buildTruckResolveState(from: GameState, to: GameState, progress: number): GameState {
  const p = Math.max(0, Math.min(1, progress))
  const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
  const track = Math.max(1, to.track_length || from.track_length || 1)
  const dir = to.truck.direction >= 0 ? 1 : -1
  const fromPos = wrapTrack(from.truck.position, track)
  const toPos = wrapTrack(to.truck.position, track)
  const rawDelta = toPos - fromPos
  const forwardDelta = dir > 0 ? (rawDelta + track) % track : ((-rawDelta + track) % track) * -1
  const delta = Math.abs(forwardDelta) > track / 2 ? rawDelta : forwardDelta
  const truckPos = wrapTrack(fromPos + delta * eased, track)
  return {
    ...to,
    tick: p < 1 ? from.tick : to.tick,
    truck: {
      ...to.truck,
      position: truckPos
    },
    players: p < 1 ? from.players : to.players,
    items: p < 1 ? from.items : to.items,
    logs: p < 1 ? from.logs : to.logs
  }
}

function buildContinuousReplayState(
  from: GameState,
  to: GameState,
  progress: number,
  action: ReplayAction
): GameState {
  const p = Math.max(0, Math.min(1, progress))
  const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
  const track = Math.max(1, to.track_length || from.track_length || 1)
  const sign = action.direction === 'backward' ? -1 : 1
  const fromById = new Map(from.players.map((player) => [player.player_id, player]))

  const players = to.players.map((target) => {
    const source = fromById.get(target.player_id)
    if (!source) return target

    if (target.player_id === action.agent_id) {
      const fromPos = wrapTrack(source.position, track)
      const toPos = wrapTrack(target.position, track)
      const delta =
        sign >= 0
          ? (toPos - fromPos + track) % track
          : -((fromPos - toPos + track) % track)
      const position = wrapTrack(fromPos + delta * eased, track)
      return {
        ...target,
        position,
        facing: sign,
        hp: p < 1 ? source.hp : target.hp,
        message: p < 0.2 ? source.message : (action.message || target.message)
      }
    }

    return {
      ...target,
      position: p < 1 ? source.position : target.position,
      facing: source.facing,
      hp: p < 1 ? source.hp : target.hp,
      message: p < 1 ? source.message : target.message
    }
  })

  return {
    ...to,
    tick: p < 1 ? from.tick : to.tick,
    track_length: track,
    players,
    truck: p < 1 ? from.truck : to.truck,
    items: p < 1 ? from.items : to.items,
    logs: p < 1 ? from.logs : to.logs
  }
}

export default function App() {
  const replayCompactMode = true
  const [state, setState] = useState<GameState>(fallbackState)
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [windowState, setWindowState] = useState({
    replay: true,
    controls: false,
    logs: true
  })
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [mode, setMode] = useState<'live' | 'replay'>('live')
  const [replayFrames, setReplayFrames] = useState<ReplayFrame[]>([])
  const [replayActions, setReplayActions] = useState<ReplayAction[]>([])
  const [replayDiscussions, setReplayDiscussions] = useState<ReplayDiscussion[]>([])
  const [replayIndex, setReplayIndex] = useState(0)
  const [actionIndex, setActionIndex] = useState(0)
  const [actionPhase, setActionPhase] = useState<'idle' | 'discussion' | 'sight' | 'dice' | 'sync' | 'move' | 'impact'>('idle')
  const [activeAction, setActiveAction] = useState<ReplayAction | null>(null)
  const [activeDiscussion, setActiveDiscussion] = useState<ReplayDiscussion | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackMs, setPlaybackMs] = useState(450)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [speedInput, setSpeedInput] = useState('1')
  const [dicePulse, setDicePulse] = useState(0)
  const [votePulse, setVotePulse] = useState(0)
  const [phaseBanner, setPhaseBanner] = useState<{ id: number; text: string } | null>(null)
  const [roundBanner, setRoundBanner] = useState<{ id: number; round: number } | null>(null)
  const [voteDirectionPreview, setVoteDirectionPreview] = useState<number | null>(null)
  const [truckStepCue, setTruckStepCue] = useState<{ id: number; steps: number } | null>(null)
  const [truckArrowPlan, setTruckArrowPlan] = useState<{ steps: number; direction: number } | null>(null)
  const [moveFlashes, setMoveFlashes] = useState<Array<{ id: number; name: string }>>([])
  const [landFlashes, setLandFlashes] = useState<Array<{ id: number; name: string }>>([])
  const [hitFlashes, setHitFlashes] = useState<Array<{ id: number; name: string }>>([])
  const [flyOuts, setFlyOuts] = useState<Array<{ id: number; name: string }>>([])
  const [truckImpactPulse, setTruckImpactPulse] = useState(0)
  const [focusOverlay, setFocusOverlay] = useState<{
    name: string
    message: string
    phase: 'overview' | 'rollcall' | 'discussion' | 'move' | 'vote' | 'truck'
    title: string
  } | null>(null)
  const [introScriptedFocus, setIntroScriptedFocus] = useState<ScriptedFocusState | null>(null)
  const [onAirBanner, setOnAirBanner] = useState<{ id: number; text: string } | null>(null)
  const [latestReplayMeta, setLatestReplayMeta] = useState<string>('内置素材待播放')
  const [selectedBundledReplayId, setSelectedBundledReplayId] = useState<string>(BUNDLED_REPLAYS[0]?.id ?? '')
  const socketRef = useRef<WebSocket | null>(null)
  const compactReplayFileInputRef = useRef<HTMLInputElement | null>(null)
  const stateRef = useRef<GameState>(fallbackState)
  const prevStateRef = useRef<GameState>(fallbackState)
  const moveAnimRef = useRef<number | null>(null)
  const resolveTimersRef = useRef<number[]>([])
  const pipelineRunRef = useRef(0)
  const introPlayedRef = useRef(false)
  const DICE_ANIM_MS = 1100
  const SYNC_MS = 3600
  const MOVE_MS = 1700
  const SIGHT_PREVIEW_MS = 15000
  const VOTE_MS = 15000
  const IMPACT_MS = 2600
  const PHASE_GAP_MS = 1500
  const PHASE_BANNER_MS = 1800
  const ROUND_BANNER_MS = 2200
  const DIALOGUE_TIME_SCALE = 1.25
  const SPEECH_TIME_COMPENSATION = 0.8
  const COMMENTATOR_SPEECH_MULTIPLIER = 3
  const clampPlaybackSpeed = (value: number) => Math.max(0.25, Math.min(100, value))
  const scaledMs = (ms: number) => Math.max(16, ms / playbackSpeed)
  const speechDurationMs = (message: string, multiplier = 1) =>
    Math.max(
      2200,
      Math.min(9000, 1400 + message.length * 36)
    ) *
    DIALOGUE_TIME_SCALE *
    SPEECH_TIME_COMPENSATION *
    Math.max(1, multiplier)

  const pushOnAir = (text: string) => {
    setOnAirBanner({ id: Date.now() + Math.floor(Math.random() * 9999), text })
  }

  const clearOnAir = () => {
    setOnAirBanner(null)
  }

  const triggerHitCinematics = (entries: Array<{ name: string; fly: boolean }>) => {
    if (entries.length === 0) return
    setTruckImpactPulse((n) => n + 1)
    entries.forEach((entry, idx) => {
      const name = entry.name
      const id = Date.now() + Math.floor(Math.random() * 9999) + idx * 31
      setHitFlashes((list) => [...list.slice(-2), { id, name }])
      window.setTimeout(() => {
        setHitFlashes((list) => list.filter((item) => item.id !== id))
      }, scaledMs(2400))
      if (entry.fly) {
        const flyId = id + 100000
        setFlyOuts((list) => [...list.slice(-2), { id: flyId, name }])
        window.setTimeout(() => {
          setFlyOuts((list) => list.filter((item) => item.id !== flyId))
        }, scaledMs(2500))
      }
    })
  }

  const clearResolveTimers = () => {
    if (resolveTimersRef.current.length === 0) return
    resolveTimersRef.current.forEach((id) => window.clearTimeout(id))
    resolveTimersRef.current = []
  }

  const stopPipeline = () => {
    pipelineRunRef.current += 1
    clearResolveTimers()
    setVoteDirectionPreview(null)
    setPhaseBanner(null)
    setRoundBanner(null)
    setTruckStepCue(null)
    setTruckArrowPlan(null)
    setActiveDiscussion(null)
    setIntroScriptedFocus(null)
    clearOnAir()
    if (moveAnimRef.current) {
      window.cancelAnimationFrame(moveAnimRef.current)
      moveAnimRef.current = null
    }
  }

  const sleepForRun = (ms: number, runId: number) =>
    new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(pipelineRunRef.current === runId), ms)
      resolveTimersRef.current.push(timer)
    })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    fetch('http://localhost:8000/config')
      .then((res) => res.json())
      .then((data) => {
        setConfig({
          track_length: data.app.track_length,
          max_players: data.app.max_players,
          initial_hp: data.app.initial_hp,
          dice_min: data.app.dice_min,
          dice_max: data.app.dice_max,
          vision_range: data.app.vision_range,
          tick_ms: data.app.tick_ms,
          spawn_item_chance: data.probabilities.spawn_item_chance,
          no_damage_chance: data.probabilities.no_damage_chance
        })
      })
      .catch(() => null)

    socketRef.current = createObserverSocket((data) => {
      if (mode !== 'live') return
      if (data.type === 'state') {
        setState(normalizeGameState(data.payload))
      }
    })

    return () => {
      socketRef.current?.close()
    }
  }, [mode])

  useEffect(() => {
    if (mode !== 'replay') return
    if (replayFrames.length === 0) return
    if (isPlaying) return
    const frame = replayFrames[Math.min(replayIndex, replayFrames.length - 1)]
    setState(normalizeGameState(frame.state))
  }, [mode, replayFrames, replayIndex, isPlaying])

  useEffect(() => {
    if (mode !== 'replay' || !isPlaying) {
      stopPipeline()
      setActionPhase('idle')
      setActiveAction(null)
      setActiveDiscussion(null)
      return
    }
    if (replayActions.length === 0) return
    if (actionIndex >= replayActions.length) {
      setIsPlaying(false)
      setActionPhase('idle')
      setActiveAction(null)
      setActiveDiscussion(null)
      return
    }

    stopPipeline()
    const runId = pipelineRunRef.current + 1
    pipelineRunRef.current = runId
    const action = replayActions[actionIndex]
    const prevAction = actionIndex > 0 ? replayActions[actionIndex - 1] : null
    const firstActionInTick = !prevAction || prevAction.tick !== action.tick

    const animateMoveForRun = (
      fromState: GameState,
      toState: GameState,
      currentAction: ReplayAction
    ) =>
      new Promise<boolean>((resolve) => {
        const startedAt = performance.now()
        const tick = (now: number) => {
          if (pipelineRunRef.current !== runId) {
            moveAnimRef.current = null
            resolve(false)
            return
          }
          const elapsed = now - startedAt
          const progress = Math.max(0, Math.min(1, elapsed / scaledMs(MOVE_MS)))
          setState(normalizeGameState(buildContinuousReplayState(fromState, toState, progress, currentAction)))
          if (progress < 1) {
            moveAnimRef.current = window.requestAnimationFrame(tick)
            return
          }
          moveAnimRef.current = null
          resolve(true)
        }
        moveAnimRef.current = window.requestAnimationFrame(tick)
      })

    const animateTruckForRun = (fromState: GameState, toState: GameState, ms: number) =>
      new Promise<boolean>((resolve) => {
        const startedAt = performance.now()
        const tick = (now: number) => {
          if (pipelineRunRef.current !== runId) {
            moveAnimRef.current = null
            resolve(false)
            return
          }
          const elapsed = now - startedAt
          const progress = Math.max(0, Math.min(1, elapsed / ms))
          setState(normalizeGameState(buildTruckResolveState(fromState, toState, progress)))
          if (progress < 1) {
            moveAnimRef.current = window.requestAnimationFrame(tick)
            return
          }
          moveAnimRef.current = null
          resolve(true)
        }
        moveAnimRef.current = window.requestAnimationFrame(tick)
      })

    const run = async () => {
      setActiveAction(null)
      setActiveDiscussion(null)
      if (firstActionInTick && actionIndex === 0 && !introPlayedRef.current) {
        const snapshot = stateRef.current
        const core = snapshot.players.filter((player) => !isCommentatorPlayer(player) && player.hp > 0)
        const fallbackAgentId = core[0]?.player_id ?? null
        const randomPlayer = core.length > 0 ? core[Math.floor(Math.random() * core.length)] : null
        const commentator = snapshot.players.find((player) => isCommentatorPlayer(player)) ?? null
        const commentatorId = commentator?.player_id ?? fallbackAgentId
        const commentatorName = commentator?.name || '解说员'
        const truckFocusAgentId = commentatorId ?? fallbackAgentId

        const introShots: Array<{
          token: string
          focus: ScriptedFocusState
          message: string
        }> = [
          {
            token: 'intro-1',
            focus: {
              enabled: true,
              agentId: truckFocusAgentId,
              phase: 'impact',
              truckDirection: stateRef.current.truck.direction,
              truckSteps: Math.max(1, Math.round(stateRef.current.truck.speed || 1)),
              token: 'intro-truck-1'
            },
            message: '你们几个 AI 被困在了环形轨道上，轨道里有一辆大运重卡正在前进，你们需要想尽一切办法躲避他'
          },
          {
            token: 'intro-2',
            focus: {
              enabled: true,
              agentId: randomPlayer?.player_id ?? fallbackAgentId,
              phase: 'sync',
              token: `intro-player-${randomPlayer?.player_id ?? 'fallback'}`
            },
            message: '幸运的是，你们可以逃跑，每一回合你们都会掷骰子决定行走距离，但顺时针还是逆时针，由你自己拍板。'
          },
          {
            token: 'intro-3',
            focus: {
              enabled: true,
              agentId: commentatorId,
              phase: commentatorId ? 'discussion' : 'commentator',
              token: 'intro-commentator'
            },
            message:
              '你们视野有限，不知道大运的实时位置；看见的人可以共享情报，当然也可以报假位置骗对手。'
          },
          {
            token: 'intro-4',
            focus: {
              enabled: true,
              agentId: truckFocusAgentId,
              phase: 'impact',
              truckDirection: stateRef.current.truck.direction,
              truckSteps: Math.max(1, Math.round(stateRef.current.truck.speed || 1)),
              token: 'intro-truck-damage'
            },
            message: '如果某人被卡车撞击，那个人就会损失一个电量，如果一个人的电量耗尽，就意味着他 gameover 就此被淘汰。'
          },
          {
            token: 'intro-5',
            focus: {
              enabled: true,
              agentId: truckFocusAgentId,
              phase: 'impact',
              truckDirection: stateRef.current.truck.direction,
              truckSteps: Math.max(1, Math.round(stateRef.current.truck.speed || 1)),
              token: 'intro-truck-2'
            },
            message:
              '你们每回合还能投票决定大运方向，决定大运下一回合是顺时针还是逆时针，这也许可以让大运朝你们相反地方开，但注意：大运越久撞不到人，怒气就越高，冲撞会越来越凶。并且只要场上剩余两人及以下，游戏就判定胜利。'
          },
          {
            token: 'intro-6',
            focus: {
              enabled: true,
              agentId: commentatorId,
              phase: commentatorId ? 'discussion' : 'commentator',
              token: 'intro-commentator-final'
            },
            message: '是携手共进，还是自相残杀？我很看好你们，让游戏开始吧！'
          }
        ]

        setPhaseBanner({ id: Date.now() + Math.floor(Math.random() * 9999), text: '解说开场' })
        if (!(await sleepForRun(scaledMs(1200), runId))) return
        setPhaseBanner(null)

        for (const shot of introShots) {
          if (pipelineRunRef.current !== runId) return
          setIntroScriptedFocus(shot.focus)
          setActionPhase('discussion')
          setActiveDiscussion({
            tick: action.tick,
            agent_id: commentatorId ?? 'commentator',
            ai_name: commentatorName,
            message: shot.message,
            delivery: 'public',
            targets: [],
            frameIndex: Math.max(0, action.frameIndex)
          })
          pushOnAir('COMMENTATOR ON AIR')
          const speakMs = speechDurationMs(shot.message, COMMENTATOR_SPEECH_MULTIPLIER)
          if (!(await sleepForRun(scaledMs(speakMs), runId))) return
          clearOnAir()
          if (!(await sleepForRun(scaledMs(380), runId))) return
        }

        setActiveDiscussion(null)
        setActionPhase('idle')
        setIntroScriptedFocus(null)
        introPlayedRef.current = true
      }
      if (firstActionInTick) {
        setRoundBanner({ id: Date.now() + Math.floor(Math.random() * 9999), round: action.tick })
        if (!(await sleepForRun(scaledMs(ROUND_BANNER_MS), runId))) return
        setRoundBanner(null)
        if (!(await sleepForRun(scaledMs(500), runId))) return
        const discussionList = replayDiscussions.filter((d) => d.tick === action.tick)
        if (discussionList.length > 0) {
          setPhaseBanner({ id: Date.now() + Math.floor(Math.random() * 9999), text: '讨论开始' })
          if (!(await sleepForRun(scaledMs(PHASE_BANNER_MS), runId))) return
          setPhaseBanner(null)

          for (const entry of discussionList) {
            if (pipelineRunRef.current !== runId) return
            setActionPhase('discussion')
            setActiveDiscussion(entry)
            const speakMs = speechDurationMs(entry.message)
            if (!(await sleepForRun(scaledMs(speakMs), runId))) return
            if (!(await sleepForRun(scaledMs(700), runId))) return
          }
          setActiveDiscussion(null)
        }
      }
      if (!(await sleepForRun(scaledMs(PHASE_GAP_MS), runId))) return
      if (firstActionInTick) {
        setPhaseBanner({ id: Date.now() + Math.floor(Math.random() * 9999), text: '开始移动' })
        if (!(await sleepForRun(scaledMs(PHASE_BANNER_MS), runId))) return
        setPhaseBanner(null)
      }
      setActionPhase('dice')
      setActiveAction(action)
      setDicePulse((n) => n + 1)
      if (!(await sleepForRun(scaledMs(DICE_ANIM_MS), runId))) return

      if (!(await sleepForRun(scaledMs(PHASE_GAP_MS), runId))) return
      setActionPhase('sight')
      setActiveAction(action)
      if (!(await sleepForRun(scaledMs(SIGHT_PREVIEW_MS), runId))) return
      if (!(await sleepForRun(scaledMs(320), runId))) return

      if (!(await sleepForRun(scaledMs(PHASE_GAP_MS), runId))) return
      setActionPhase('sync')
      if (!(await sleepForRun(scaledMs(SYNC_MS * DIALOGUE_TIME_SCALE), runId))) return

      if (!(await sleepForRun(scaledMs(PHASE_GAP_MS), runId))) return
      setActionPhase('move')
      const moveId = Date.now() + Math.floor(Math.random() * 9999)
      setMoveFlashes((list) => [...list.slice(-1), { id: moveId, name: action.ai_name }])
      const moveClearTimer = window.setTimeout(() => {
        setMoveFlashes((list) => list.filter((item) => item.id !== moveId))
      }, scaledMs(MOVE_MS + 320))
      resolveTimersRef.current.push(moveClearTimer)

      const targetIndex = Math.min(action.frameIndex, replayFrames.length - 1)
      const toState = replayFrames[targetIndex]?.state
      const fromState = stateRef.current
      if (!toState) {
        setActionIndex((idx) => idx + 1)
        setActionPhase('idle')
        setActiveAction(null)
        return
      }

      if (!(await animateMoveForRun(fromState, toState, action))) return
      if (pipelineRunRef.current !== runId) return

      const fromById = new Map(fromState.players.map((player) => [player.player_id, player]))
      const victimsAtLanding = toState.players
        .filter((player) => {
          const before = fromById.get(player.player_id)
          return !!before && player.hp < before.hp
        })
        .map((player) => ({ name: player.name, fly: true }))
      triggerHitCinematics(victimsAtLanding)
      setState(normalizeGameState(toState))
      setReplayIndex(targetIndex)

      const landId = Date.now() + Math.floor(Math.random() * 9999)
      setLandFlashes((list) => [...list.slice(-1), { id: landId, name: action.ai_name }])
      const landClearTimer = window.setTimeout(() => {
        setLandFlashes((list) => list.filter((item) => item.id !== landId))
      }, scaledMs(IMPACT_MS + 300))
      resolveTimersRef.current.push(landClearTimer)

      if (!(await sleepForRun(scaledMs(PHASE_GAP_MS), runId))) return
      setActionPhase('impact')
      const nextBoundary = replayActions[actionIndex + 1]?.frameIndex ?? replayFrames.length
      const resolveEnd = Math.max(targetIndex + 1, Math.min(nextBoundary, replayFrames.length))
      const resolveList = replayFrames
        .slice(targetIndex + 1, resolveEnd)
        .filter(
          (frame) =>
            frame.label === 'truck_moved' ||
            frame.label === 'player_hit' ||
            frame.label === 'commentator_broadcast'
        )

      const firstTruckFrame = resolveList.find((frame) => frame.label === 'truck_moved')
      if (firstTruckFrame) {
        const truckStepCount = resolveList.filter((frame) => frame.label === 'truck_moved').length
        const truckDir = firstTruckFrame.state.truck.direction >= 0 ? 1 : -1
        setVoteDirectionPreview(truckDir)
        setTruckArrowPlan({ steps: truckStepCount, direction: truckDir })
        setVotePulse((n) => n + 1)
        if (!(await sleepForRun(scaledMs(VOTE_MS), runId))) return
        if (truckStepCount > 0) {
          const cueId = Date.now() + Math.floor(Math.random() * 9999)
          setTruckStepCue({ id: cueId, steps: truckStepCount })
          const clearCueTimer = window.setTimeout(() => {
            setTruckStepCue((prev) => (prev?.id === cueId ? null : prev))
          }, 2200)
          resolveTimersRef.current.push(clearCueTimer)
          if (!(await sleepForRun(scaledMs(1200), runId))) return
        }
      }
      if (!firstTruckFrame) {
        setTruckArrowPlan(null)
      }

      let prevResolveState = toState
      for (let idx = 0; idx < resolveList.length; idx += 1) {
        if (pipelineRunRef.current !== runId) return
        const frame = resolveList[idx]
        const frameIndexAbs = targetIndex + 1 + idx
        if (frame.label === 'truck_moved') {
          let end = idx
          while (end + 1 < resolveList.length && resolveList[end + 1]?.label === 'truck_moved') {
            end += 1
          }
          const finalTruckFrame = resolveList[end]
          const finalAbs = targetIndex + 1 + end
          const duration = scaledMs(Math.max(220, (end - idx + 1) * 170))
          setReplayIndex(finalAbs)
          if (!(await animateTruckForRun(prevResolveState, finalTruckFrame.state, duration))) return
          setState(normalizeGameState(finalTruckFrame.state))
          prevResolveState = finalTruckFrame.state
          idx = end
          if (!(await sleepForRun(scaledMs(30), runId))) return
        } else {
          setReplayIndex(frameIndexAbs)
          setState(normalizeGameState(frame.state))
          if (frame.label === 'commentator_broadcast') {
            const commentator = frame.state.players.find((player) => isCommentatorPlayer(player)) ?? null
            if (commentator && commentator.message.trim().length > 0) {
              setActionPhase('discussion')
              setActiveDiscussion({
                tick: frame.state.tick,
                agent_id: commentator.player_id,
                ai_name: commentator.name || '解说员',
                message: commentator.message,
                delivery: 'public',
                targets: [],
                frameIndex: frameIndexAbs
              })
              pushOnAir('COMMENTATOR ON AIR')
              const speakMs = speechDurationMs(commentator.message, COMMENTATOR_SPEECH_MULTIPLIER)
              if (!(await sleepForRun(scaledMs(speakMs), runId))) return
              clearOnAir()
              setActiveDiscussion(null)
              setActionPhase('impact')
              if (!(await sleepForRun(scaledMs(420), runId))) return
            } else {
              if (!(await sleepForRun(scaledMs(320), runId))) return
            }
          } else {
            const prevById = new Map(prevResolveState.players.map((player) => [player.player_id, player]))
            const victims = frame.state.players
              .filter((player) => {
                const before = prevById.get(player.player_id)
                return !!before && player.hp < before.hp
              })
              .map((player) => ({ name: player.name, fly: true }))
            triggerHitCinematics(victims)
            const delay = scaledMs(frame.label === 'player_hit' ? 620 : 240)
            if (!(await sleepForRun(delay, runId))) return
          }
          prevResolveState = frame.state
        }
      }

      if (resolveEnd > targetIndex + 1) {
        setReplayIndex(resolveEnd - 1)
      }

      if (!(await sleepForRun(scaledMs(IMPACT_MS), runId))) return
      if (pipelineRunRef.current !== runId) return

      setVoteDirectionPreview(null)
      setTruckArrowPlan(null)
      if (!(await sleepForRun(scaledMs(PHASE_GAP_MS), runId))) return
      setActionIndex((idx) => idx + 1)
      setActionPhase('idle')
      setActiveAction(null)
      setActiveDiscussion(null)
    }

    run().catch(() => {
      setIsPlaying(false)
      setActionPhase('idle')
      setActiveAction(null)
      setActiveDiscussion(null)
    })
    return () => {
      stopPipeline()
    }
  }, [mode, isPlaying, actionIndex, replayActions, replayFrames, replayDiscussions, DICE_ANIM_MS, SYNC_MS, MOVE_MS, SIGHT_PREVIEW_MS, VOTE_MS, IMPACT_MS, PHASE_GAP_MS, PHASE_BANNER_MS, ROUND_BANNER_MS, DIALOGUE_TIME_SCALE, playbackSpeed])

  useEffect(() => {
    if (mode === 'replay' && isPlaying) {
      prevStateRef.current = state
      return
    }
    const prev = prevStateRef.current
    if (!prev) {
      prevStateRef.current = state
      return
    }

    if (state.tick !== prev.tick) {
      setDicePulse((n) => n + 1)
    }

    if (state.truck.direction !== prev.truck.direction) {
      setVotePulse((n) => n + 1)
    }

    const prevById = new Map(prev.players.map((player) => [player.player_id, player]))
    for (const player of state.players) {
      const old = prevById.get(player.player_id)
      if (!old) continue
      if (player.position !== old.position) {
        const id = Date.now() + Math.floor(Math.random() * 9999)
        setMoveFlashes((list) => [...list.slice(-1), { id, name: player.name }])
        window.setTimeout(() => {
          setMoveFlashes((list) => list.filter((item) => item.id !== id))
        }, 5000)
      }
      if (player.hp < old.hp) {
        triggerHitCinematics([{ name: player.name, fly: true }])
      }
    }

    prevStateRef.current = state
  }, [state])

  const visionRange = config?.vision_range ?? 6
  const replayMaxHp = useMemo(() => {
    if (replayFrames.length === 0) return 0
    let maxHp = 0
    for (const frame of replayFrames) {
      for (const player of frame.state.players) {
        maxHp = Math.max(maxHp, Number.isFinite(player.hp) ? player.hp : 0)
      }
    }
    return maxHp
  }, [replayFrames])
  const displayMaxHp = Math.max(
    config?.initial_hp ?? 0,
    ...state.players.map((player) => player.hp),
    mode === 'replay' ? replayMaxHp : 0,
    3
  )

  const corePlayers = useMemo(() => state.players.filter((player) => !isCommentatorPlayer(player)), [state.players])

  const playersByCorner = useMemo(() => {
    const list = [...corePlayers]
    while (list.length < 5) {
      list.push({
        player_id: `ghost-${list.length}`,
        name: '待命中',
        avatar: null,
        position: 0,
        facing: 1,
        hp: 0,
        inventory: {},
        message: ''
      })
    }
    return list.slice(0, 5)
  }, [corePlayers])

  const currentFrameLabel = replayFrames[replayIndex]?.label ?? 'n/a'
  const truckPosText = Number.isFinite(state.truck.position) ? state.truck.position.toFixed(2) : '0.00'

  const voteEntries = useMemo(
    () =>
      playersByCorner.map((player) => {
        const alive = player.hp > 0
        const vote = typeof player.vote_reverse === 'boolean' ? player.vote_reverse : null
        const mark = !alive ? '阵亡' : vote === null ? '未投' : vote ? '逆时针' : '顺时针'
        const markClass = !alive ? 'is-dead' : vote === null ? 'is-unknown' : vote ? 'is-ccw' : 'is-cw'
        return {
          id: player.player_id,
          name: player.name,
          avatar: player.avatar ?? null,
          alive,
          mark,
          markClass
        }
      }),
    [playersByCorner]
  )
  const alivePlayers = corePlayers.filter((player) => player.hp > 0)
  const winnerList = [...alivePlayers].sort((a, b) => {
    if (b.hp !== a.hp) return b.hp - a.hp
    return a.name.localeCompare(b.name)
  })
  const winnerName = winnerList.length === 1 ? winnerList[0]?.name ?? null : null
  const noSurvivor = alivePlayers.length === 0
  const replayFinished =
    mode === 'replay' &&
    replayFrames.length > 0 &&
    !isPlaying &&
    actionIndex >= replayActions.length
  const endBannerTitle =
    winnerList.length > 1 ? 'WINNERS' : (winnerName ? 'WINNER' : (noSurvivor ? 'GAME OVER' : null))
  const showWinnerBanner = (winnerList.length > 0 || noSurvivor) && (mode === 'live' || replayFinished)

  const sendConfig = () => {
    if (!config || !socketRef.current) return
    socketRef.current.send(
      JSON.stringify({
        type: 'config_update',
        payload: {
          app: {
            track_length: config.track_length,
            max_players: config.max_players,
            initial_hp: config.initial_hp,
            dice_min: config.dice_min,
            dice_max: config.dice_max,
            vision_range: config.vision_range,
            tick_ms: config.tick_ms
          },
          probabilities: {
            spawn_item_chance: config.spawn_item_chance,
            no_damage_chance: config.no_damage_chance
          }
        }
      })
    )
  }

  const startDialogue = () => {
    fetch('http://localhost:8000/dialogue/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns: 2 })
    }).catch(() => null)
  }

  const onUploadReplay = async (file: File | null) => {
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown
      const timeline = parseLegacyExport(parsed)
      const frames = timeline.frames
      if (frames.length === 0) return
      setReplayFrames(frames)
      setReplayActions(timeline.actions)
      setReplayDiscussions(timeline.discussions)
      setReplayIndex(0)
      setActionIndex(0)
      introPlayedRef.current = false
      setActionPhase('idle')
      setActiveAction(null)
      setActiveDiscussion(null)
      setMode('replay')
      setIsPlaying(false)
      setState(normalizeGameState(frames[0].state))
    } catch {
      // ignore invalid replay files
    }
  }

  const applyReplayTimeline = (timelineRaw: unknown, autoPlay: boolean) => {
    const timeline = parseLegacyExport(timelineRaw)
    const frames = timeline.frames
    if (frames.length === 0) return false
    setReplayFrames(frames)
    setReplayActions(timeline.actions)
    setReplayDiscussions(timeline.discussions)
    setReplayIndex(0)
    setActionIndex(0)
    introPlayedRef.current = false
    setActionPhase('idle')
    setActiveAction(null)
    setActiveDiscussion(null)
    setMode('replay')
    setState(normalizeGameState(frames[0].state))
    setIsPlaying(autoPlay)
    return true
  }

  const onPlayLatestReplay = async () => {
    const selectedReplay = BUNDLED_REPLAYS.find((entry) => entry.id === selectedBundledReplayId) ?? BUNDLED_REPLAYS[0]
    if (!selectedReplay) {
      setLatestReplayMeta('无可用内置素材')
      setPhaseBanner({ id: Date.now() + Math.floor(Math.random() * 9999), text: '无可播放素材' })
      return
    }
    try {
      const base = import.meta.env.BASE_URL || '/'
      const safeBase = base.endsWith('/') ? base : `${base}/`
      const response = await fetch(`${safeBase}standalone_replays/${selectedReplay.file}`, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const parsed = (await response.json()) as unknown
      const ok = applyReplayTimeline(parsed, true)
      setLatestReplayMeta(ok ? `已加载内置素材: ${selectedReplay.label}` : `素材无有效回放帧: ${selectedReplay.label}`)
    } catch (err) {
      const message = String(err)
      console.error('[Replay] load bundled failed:', err)
      setLatestReplayMeta(`内置素材加载失败: ${message}`)
      setPhaseBanner({ id: Date.now() + Math.floor(Math.random() * 9999), text: '内置素材加载失败' })
    }
  }

  const toggleWindow = (key: 'replay' | 'controls' | 'logs') => {
    setWindowState((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const activeSpeaker =
    actionPhase === 'discussion' && activeDiscussion
      ? corePlayers.find((player) => player.player_id === activeDiscussion.agent_id) ?? null
      : activeAction
        ? corePlayers.find((player) => player.player_id === activeAction.agent_id) ?? null
        : null
  const commentatorSpeaking =
    actionPhase === 'discussion' &&
    !!activeDiscussion &&
    isCommentatorPlayer({ player_id: activeDiscussion.agent_id, name: activeDiscussion.ai_name })
  const commentatorMood = pickCommentatorMood(
    sanitizeDisplayMessage(
      actionPhase === 'discussion'
        ? activeDiscussion?.message
        : (activeAction?.action_message || activeAction?.message)
    )
  )
  const activeBattery = activeSpeaker && displayMaxHp > 0
    ? Math.max(0, Math.min(1, activeSpeaker.hp / displayMaxHp))
    : 0
  const activeBatteryPct = Math.round(activeBattery * 100)

  const captionSpeaker = !activeAction && focusOverlay
    ? corePlayers.find((player) => player.name === focusOverlay.name) ?? null
    : null
  const captionBattery = captionSpeaker && displayMaxHp > 0
    ? Math.max(0, Math.min(1, captionSpeaker.hp / displayMaxHp))
    : 0
  const captionBatteryPct = Math.round(captionBattery * 100)
  const safeTrack = Math.max(1, state.track_length)
  const wrappedTruck = ((state.truck.position % safeTrack) + safeTrack) % safeTrack
  const playerOrderLabelById = useMemo(() => {
    const map = new Map<string, string>()
    corePlayers.forEach((player, idx) => {
      map.set(player.player_id, String(idx + 1))
    })
    return map
  }, [corePlayers])
  const buildSightMeta = (player: PlayerState | null) => {
    if (!player) return '位置 -- · 视野 -- · 大运可见 --'
    const wrappedPos = ((player.position % safeTrack) + safeTrack) % safeTrack
    const cells = visibleCellsBidirectional(player.position, visionRange, safeTrack)
    const cellsText = `CW[${cells.cw.join(', ')}] CCW[${cells.ccw.join(', ')}]`
    const canSeeTruck = player.hp > 0 && canSeeTruckBidirectional(player.position, wrappedTruck, visionRange, safeTrack)
    const seeText = player.hp <= 0 ? '阵亡' : canSeeTruck ? '是' : '否'
    return `位置 ${wrappedPos.toFixed(2)} · 视野格 ${cellsText} · 大运可见 ${seeText}`
  }
  const buildPositionHighlight = (player: PlayerState | null) => {
    if (!player) return '-- / --'
    const wrappedPos = ((player.position % safeTrack) + safeTrack) % safeTrack
    return `${wrappedPos.toFixed(2)} / ${safeTrack}`
  }
  const sightPlayer =
    actionPhase === 'sight' && activeAction
      ? corePlayers.find((player) => player.player_id === activeAction.agent_id) ?? null
      : null
  const sightCells = sightPlayer ? visibleCellsBidirectional(sightPlayer.position, visionRange, safeTrack) : null
  const sightVisibleSet = useMemo(() => {
    if (!sightPlayer || !sightCells) return new Set<number>()
    const base = wrapCell(Math.round(sightPlayer.position), safeTrack)
    return new Set<number>([base, ...sightCells.cw, ...sightCells.ccw].map((cell) => wrapCell(cell, safeTrack)))
  }, [sightPlayer, sightCells, safeTrack])
  const sightTruckVisible =
    !!sightPlayer && canSeeTruckBidirectional(sightPlayer.position, wrappedTruck, visionRange, safeTrack)
  const sightRingCenter = 340
  const sightRingRadius = 250
  const sightCellRadius = 16
  const sightSteps =
    actionPhase === 'sight' && activeAction
      ? Math.max(1, Number(activeAction.steps) || 1)
      : null
  const sightSelfIdx = sightPlayer ? wrapCell(Math.round(sightPlayer.position), safeTrack) : null
  const sightReachCwIdx =
    sightSelfIdx !== null && sightSteps !== null ? wrapCell(sightSelfIdx + sightSteps, safeTrack) : null
  const sightReachCcwIdx =
    sightSelfIdx !== null && sightSteps !== null ? wrapCell(sightSelfIdx - sightSteps, safeTrack) : null
  const sightPointFor = (index: number, radius = sightRingRadius) => {
    const angle = (index / safeTrack) * Math.PI * 2 - Math.PI / 2
    return {
      x: sightRingCenter + Math.cos(angle) * radius,
      y: sightRingCenter + Math.sin(angle) * radius
    }
  }
  const sightBuildArcPath = (from: number, to: number, dir: 1 | -1): string => {
    const total = Math.max(1, safeTrack)
    const distance =
      dir > 0
        ? (to - from + total) % total
        : (from - to + total) % total
    if (distance <= 0) return ''
    const start = sightPointFor(from, sightRingRadius + (dir > 0 ? 4 : -4))
    const end = sightPointFor(to, sightRingRadius + (dir > 0 ? 4 : -4))
    const largeArc = distance > total / 2 ? 1 : 0
    const sweep = dir > 0 ? 1 : 0
    return `M ${start.x} ${start.y} A ${sightRingRadius} ${sightRingRadius} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`
  }
  const replayScriptedFocus: ScriptedFocusState = {
    enabled:
      mode === 'replay' &&
      isPlaying &&
      !!(activeAction || activeDiscussion) &&
      actionPhase !== 'idle',
    agentId: actionPhase === 'discussion' ? (activeDiscussion?.agent_id ?? null) : (activeAction?.agent_id ?? null),
    phase: actionPhase === 'dice' ? 'idle' : (actionPhase === 'sight' ? 'sync' : actionPhase),
    direction: actionPhase === 'discussion' ? undefined : activeAction?.direction,
    steps: actionPhase === 'discussion' ? undefined : activeAction?.steps,
    truckDirection:
      actionPhase === 'impact'
        ? (truckArrowPlan?.direction ?? (voteDirectionPreview ?? state.truck.direction))
        : undefined,
    truckSteps:
      actionPhase === 'impact'
        ? (truckArrowPlan?.steps ?? 0)
        : undefined,
    token:
      actionPhase === 'discussion'
        ? (activeDiscussion ? `d-${actionIndex}-${activeDiscussion.frameIndex}-${activeDiscussion.agent_id}` : undefined)
        : (activeAction ? `a-${actionIndex}-${activeAction.frameIndex}-${activeAction.agent_id}` : undefined),
    name: actionPhase === 'discussion' ? activeDiscussion?.ai_name : activeAction?.ai_name,
    message: actionPhase === 'discussion'
      ? (activeDiscussion?.message || '')
      : (activeAction?.action_message || activeAction?.message)
  }

  return (
    <div className="app">
      <div className="screen-fisheye" aria-hidden="true" />
      <div className="boot-banner">
        <div className="boot-title">DAYUN SPIRAL TERMINAL</div>
        <div className="boot-strip">
          <span>SYSTEM ONLINE</span>
          <span>ROUND {state.tick}</span>
          <span>{mode === 'live' ? 'LIVE LINK' : 'REPLAY MODE'}</span>
          <span>{latestReplayMeta}</span>
        </div>
      </div>

      <div className="stage-area">
        <div className="stage">
          <TrackScene3D
            state={state}
            visionRange={visionRange}
            onFocusChange={(payload) => setFocusOverlay(payload)}
            scriptedFocus={introScriptedFocus ?? replayScriptedFocus}
          />
          <MiniMap
            players={corePlayers}
            trackLength={state.track_length}
            truckPosition={state.truck.position}
            truckRage={state.truck.speed}
            visionRange={visionRange}
          />
          <div className="fx-layer">
            {dicePulse > 0 && (
              <div
                key={`dice-${dicePulse}`}
                className="dice-fx"
                style={{ animationDuration: `${scaledMs(DICE_ANIM_MS)}ms` }}
              >
                <div className="dice-cube">
                  {activeAction ? `${activeAction.ai_name} D${activeAction.steps}` : 'D6'}
                </div>
              </div>
            )}
            {truckStepCue && (
              <div key={`truck-step-${truckStepCue.id}`} className="truck-step-fx">
                <div className="truck-step-box">大运前进 {truckStepCue.steps} 步</div>
              </div>
            )}
            {phaseBanner && (
              <div key={`phase-banner-${phaseBanner.id}`} className="phase-banner-fx">
                <div className="phase-banner-box">{phaseBanner.text}</div>
              </div>
            )}
            {roundBanner && (
              <div key={`round-banner-${roundBanner.id}`} className="round-banner-fx">
                <div className="round-banner-text">ROUND {roundBanner.round}</div>
              </div>
            )}
            {onAirBanner && (
              <div key={`on-air-${onAirBanner.id}`} className="on-air-banner-fx">
                <div className="on-air-banner-box">{onAirBanner.text}</div>
              </div>
            )}
            {actionPhase === 'sight' && sightPlayer && (
              <div className="sight-overlay">
                <div className="sight-window">
                <div className="sight-window-title">行动前视野预览 · {sightPlayer.name}</div>
                  {sightSteps !== null && (
                    <div className="sight-roll-badge">
                      本回合点数：{sightSteps}（尚未决定方向）
                    </div>
                  )}
                  <div className="sight-direction-legend" aria-label="direction legend">
                    <span className="legend-item cw">顺时针 Clockwise</span>
                    <span className="legend-item ccw">逆时针 Counterclockwise</span>
                  </div>
                  <svg className="sight-ring-map" viewBox="0 0 680 680" role="img" aria-label="sight ring map">
                    <circle
                      cx={sightRingCenter}
                      cy={sightRingCenter}
                      r={sightRingRadius + 28}
                      className="sight-ring-bg"
                    />
                    <circle
                      cx={sightRingCenter}
                      cy={sightRingCenter}
                      r={sightRingRadius}
                      className="sight-ring-main"
                    />
                    {sightSelfIdx !== null && sightReachCwIdx !== null && sightReachCcwIdx !== null && (
                      <>
                        <path
                          d={sightBuildArcPath(sightSelfIdx, sightReachCwIdx, 1)}
                          className="sight-reach-path cw"
                        />
                        <path
                          d={sightBuildArcPath(sightSelfIdx, sightReachCcwIdx, -1)}
                          className="sight-reach-path ccw"
                        />
                      </>
                    )}
                    {Array.from({ length: safeTrack }).map((_, idx) => {
                      const angle = (idx / safeTrack) * Math.PI * 2 - Math.PI / 2
                      const x = sightRingCenter + Math.cos(angle) * sightRingRadius
                      const y = sightRingCenter + Math.sin(angle) * sightRingRadius
                      const ux = Math.cos(angle)
                      const uy = Math.sin(angle)
                      const selfLabelRadius = sightRingRadius + 34
                      const reachLabelRadius = sightRingRadius + 52
                      const truckLabelRadius = sightRingRadius + 72
                      const inSight = sightVisibleSet.has(idx)
                      const isSelf = wrapCell(Math.round(sightPlayer.position), safeTrack) === idx
                      const isReachCw = sightReachCwIdx !== null && idx === sightReachCwIdx
                      const isReachCcw = sightReachCcwIdx !== null && idx === sightReachCcwIdx
                      const onTruck = sightTruckVisible && wrapCell(Math.round(wrappedTruck), safeTrack) === idx
                      const occupants = corePlayers.filter(
                        (player) => wrapCell(Math.round(player.position), safeTrack) === idx
                      )
                      return (
                        <g key={`sight-cell-${idx}`}>
                          <circle
                            cx={x}
                            cy={y}
                            r={sightCellRadius}
                            className={`sight-node ${inSight ? 'in-sight' : 'out-sight'} ${isSelf ? 'self' : ''} ${isReachCw ? 'reach-cw' : ''} ${isReachCcw ? 'reach-ccw' : ''} ${onTruck ? 'truck-node' : ''}`}
                          />
                          <text x={x} y={y - 18} textAnchor="middle" className="sight-node-index">
                            {idx}
                          </text>
                          {isSelf && (
                            <>
                              <text
                                x={sightRingCenter + ux * selfLabelRadius}
                                y={sightRingCenter + uy * selfLabelRadius}
                                textAnchor="middle"
                                className="sight-node-self-label-outline"
                              >
                                我在这
                              </text>
                              <text
                                x={sightRingCenter + ux * selfLabelRadius}
                                y={sightRingCenter + uy * selfLabelRadius}
                                textAnchor="middle"
                                className="sight-node-self-label"
                              >
                                我在这
                              </text>
                            </>
                          )}
                          {occupants.length > 0 && (
                            <text x={x} y={y + 4} textAnchor="middle" className="sight-node-players">
                              {occupants.map((player) => playerOrderLabelById.get(player.player_id) ?? '?').join('/')}
                            </text>
                          )}
                          {onTruck && (
                            <text
                              x={sightRingCenter + ux * truckLabelRadius}
                              y={sightRingCenter + uy * truckLabelRadius}
                              textAnchor="middle"
                              className="sight-node-truck"
                            >
                              TRUCK
                            </text>
                          )}
                          {isReachCw && (
                            <>
                              <text
                                x={sightRingCenter + ux * reachLabelRadius}
                                y={sightRingCenter + uy * reachLabelRadius}
                                textAnchor="middle"
                                className="sight-node-reach-outline"
                              >
                                顺时针
                              </text>
                              <text
                                x={sightRingCenter + ux * reachLabelRadius}
                                y={sightRingCenter + uy * reachLabelRadius}
                                textAnchor="middle"
                                className="sight-node-reach cw"
                              >
                                顺时针
                              </text>
                            </>
                          )}
                          {isReachCcw && (
                            <>
                              <text
                                x={sightRingCenter + ux * reachLabelRadius}
                                y={sightRingCenter + uy * reachLabelRadius}
                                textAnchor="middle"
                                className="sight-node-reach-outline"
                              >
                                逆时针
                              </text>
                              <text
                                x={sightRingCenter + ux * reachLabelRadius}
                                y={sightRingCenter + uy * reachLabelRadius}
                                textAnchor="middle"
                                className="sight-node-reach ccw"
                              >
                                逆时针
                              </text>
                            </>
                          )}
                        </g>
                      )
                    })}
                    <circle cx={sightRingCenter} cy={sightRingCenter} r={68} className="sight-center-core" />
                    <text x={sightRingCenter} y={sightRingCenter + 4} textAnchor="middle" className="sight-center-text">
                      视野核心
                    </text>
                  </svg>
                  <div className="sight-meta">
                    环形图中高亮为你可见范围，黑色为不可见区域。其他玩家位置会标出；大运仅在你视野内显示。
                  </div>
                </div>
              </div>
            )}
            {votePulse > 0 && (
              <div
                key={`vote-${votePulse}`}
                className="vote-fx"
                style={{ animationDuration: `${scaledMs(15200)}ms` }}
              >
                VOTE FLIP
              </div>
            )}
            {votePulse > 0 && (
              <div
                key={`vote-window-${votePulse}`}
                className="vote-window"
                style={{ animationDuration: `${scaledMs(15200)}ms` }}
              >
                <div className="vote-window-title">VOTING</div>
                <div className="vote-window-direction">
                  大运下一步方向：
                  {` ${((voteDirectionPreview ?? state.truck.direction) >= 0) ? '顺时针' : '逆时针'}`}
                </div>
                <div className="vote-window-grid">
                  {voteEntries.map((entry) => {
                    const avatarSrc = resolveAvatarSource(entry.avatar)
                    return (
                      <div key={entry.id} className="vote-window-player">
                        <div className={`vote-window-avatar ${entry.alive ? '' : 'is-dead'}`}>
                          {avatarSrc ? (
                            <img className="vote-window-avatar-img" src={avatarSrc} alt={entry.name || 'avatar'} />
                          ) : (
                            (entry.name || '--').slice(0, 2)
                          )}
                        </div>
                        <div className="vote-window-name">{entry.name}</div>
                        <div className={`vote-window-mark ${entry.markClass}`}>
                          {entry.mark}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {truckImpactPulse > 0 && (
              <div key={`truck-impact-${truckImpactPulse}`} className="truck-impact-fx">
                DAYUN IMPACT
              </div>
            )}
            {showWinnerBanner && endBannerTitle && (
              <div className="winner-overlay">
                <div className="winner-title">{endBannerTitle}</div>
                {winnerList.length > 0 ? (
                  <div className="winner-list">
                    {winnerList.map((winner) => (
                      <div key={winner.player_id} className="winner-name">
                        {winner.name}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="winner-name">无人生还</div>
                )}
              </div>
            )}
            <div className="move-stack">
              {moveFlashes.map((item) => (
                <div key={item.id} className="move-fx">
                  {item.name} MOVE
                </div>
              ))}
            </div>
            {landFlashes.map((item) => (
              <div key={item.id} className="land-fx">
                {item.name} STOP!
              </div>
            ))}
            {hitFlashes.map((item, idx) => (
              <div
                key={item.id}
                className={`hit-fx hit-path-${(idx % 3) + 1}`}
              >
                {item.name} HIT!
              </div>
            ))}
            {flyOuts.map((item, idx) => (
              <div key={item.id} className={`flyout-fx flyout-path-${(idx % 3) + 1}`}>
                <div className="flyout-avatar">{(item.name || '--').slice(0, 2)}</div>
                <div className="flyout-name">{item.name}</div>
              </div>
            ))}
            {(actionPhase === 'discussion' ? !!activeDiscussion : !!activeAction) && (actionPhase === 'discussion' || actionPhase === 'sync' || actionPhase === 'sight') && (
              <div className={`actor-bubble ${commentatorSpeaking ? 'is-commentator' : ''} ${actionPhase === 'sight' ? 'is-sight' : ''}`}>
                <div className={`subtitle-shell ${commentatorSpeaking ? 'is-commentator' : ''}`}>
                  <div className="subtitle-main">
                    <div className="actor-bubble-name">
                      {actionPhase === 'discussion' ? activeDiscussion?.ai_name : activeAction?.ai_name}
                    </div>
                    <div className="actor-bubble-status-row">
                      {!commentatorSpeaking && (
                        <span className="phase-tag">
                          {actionPhase === 'discussion' ? '讨论阶段' : '行动阶段'}
                        </span>
                      )}
                      {!commentatorSpeaking && actionPhase === 'discussion' && activeDiscussion && (
                        <span className={`msg-type-badge ${activeDiscussion.delivery}`}>
                          {activeDiscussion.delivery === 'private'
                            ? `私聊 ${activeDiscussion.targets.length > 0 ? `→ ${activeDiscussion.targets.map((target) => state.players.find((player) => player.player_id === target)?.name ?? target).join('、')}` : ''}`
                            : '公开发言'}
                        </span>
                      )}
                      <span className="position-highlight">当前位置 {buildPositionHighlight(activeSpeaker)}</span>
                    </div>
                    <div className="actor-bubble-meta">{buildSightMeta(activeSpeaker)}</div>
                    <div className="actor-bubble-text">
                      {actionPhase === 'discussion'
                        ? (sanitizeDisplayMessage(activeDiscussion?.message) || '...')
                        : (sanitizeDisplayMessage(activeAction?.action_message || activeAction?.message) || '正在观察路线并评估双向可达范围...')}
                    </div>
                  </div>
                  <div className="subtitle-side">
                    {commentatorSpeaking ? (
                      <>
                        <div className="subtitle-side-title">解说表情</div>
                        <div className={`pixel-face tone-${commentatorMood.tone}`} aria-label={commentatorMood.label}>
                          {commentatorMood.face}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="subtitle-side-title">当前电量</div>
                        <div className="subtitle-battery">
                          <div className="subtitle-battery-fill" style={{ width: `${activeBatteryPct}%` }} />
                        </div>
                        <div className="subtitle-side-value">{activeBatteryPct}%</div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          {!activeAction && !activeDiscussion && focusOverlay && !(mode === 'replay' && isPlaying) && (
            <div className={`cinematic-caption ${focusOverlay.phase}`}>
              <div className="subtitle-shell">
                <div className="subtitle-main">
                  <div className="cinematic-phase">{focusOverlay.title}</div>
                  <div className="cinematic-name">{focusOverlay.name}</div>
                  <div className="position-highlight">当前位置 {buildPositionHighlight(captionSpeaker)}</div>
                  <div className="actor-bubble-meta">{buildSightMeta(captionSpeaker)}</div>
                  <div className="cinematic-text">{focusOverlay.message || '...'}</div>
                </div>
                <div className="subtitle-side">
                  <div className="subtitle-side-title">当前电量</div>
                  <div className="subtitle-battery">
                    <div className="subtitle-battery-fill" style={{ width: `${captionBatteryPct}%` }} />
                  </div>
                  <div className="subtitle-side-value">{captionBatteryPct}%</div>
                </div>
              </div>
            </div>
          )}
          <div className="hud">
            <div className="hud-row">回合 #{state.tick}</div>
            <div className="hud-row">
              大运位置 {truckPosText} · 方向 {state.truck.direction >= 0 ? '顺时针' : '逆时针'}
            </div>
            <div className="hud-row">大运 Rage {state.truck.speed}</div>
            <div className="hud-row">模式 {mode === 'live' ? '实时' : '回放'}</div>
          </div>
          {!replayCompactMode && (
            <div className="window-buttons">
              <button className="control-toggle" onClick={() => toggleWindow('replay')}>
                回放窗
              </button>
              <button className="control-toggle" onClick={() => toggleWindow('controls')}>
                控制窗
              </button>
              <button className="control-toggle" onClick={() => toggleWindow('logs')}>
                日志窗
              </button>
              <button className={`control-toggle ${debugEnabled ? 'debug-on' : ''}`} onClick={() => setDebugEnabled((v) => !v)}>
                Debug
              </button>
            </div>
          )}
        </div>

        {replayCompactMode && (
          <div className="stage-control-bar">
            <select
              className="speed-input bundled-replay-select"
              value={selectedBundledReplayId}
              onChange={(e) => setSelectedBundledReplayId(e.target.value)}
            >
              {BUNDLED_REPLAYS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <button className="control-toggle replay-only-btn" onClick={() => onPlayLatestReplay().catch(() => null)}>
              START
            </button>
            <div className="speed-control">
              <span className="speed-label">x{playbackSpeed.toFixed(2)}</span>
              <input
                className="speed-input"
                type="number"
                min={0.25}
                max={100}
                step={0.25}
                value={speedInput}
                onChange={(e) => setSpeedInput(e.target.value)}
              />
              <button
                className="control-toggle speed-apply-btn"
                onClick={() => {
                  const next = clampPlaybackSpeed(Number(speedInput) || 1)
                  setPlaybackSpeed(next)
                  setSpeedInput(String(next))
                }}
              >
                加速
              </button>
            </div>
            <input
              ref={compactReplayFileInputRef}
              style={{ display: 'none' }}
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                onUploadReplay(e.target.files?.[0] ?? null).then(() => {
                  setMode('replay')
                  setIsPlaying(true)
                  setLatestReplayMeta('已加载手动选择文件')
                }).catch(() => null)
                e.currentTarget.value = ''
              }}
            />
          </div>
        )}

        {!replayCompactMode && windowState.replay && <div className="replay-panel floating-window">
          <div className="window-head">
            <div className="panel-title">Legacy 适配回放</div>
            <button className="window-close" onClick={() => toggleWindow('replay')}>关闭</button>
          </div>
          <div className="replay-grid">
            <label>
              导入导出 JSON
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  onUploadReplay(e.target.files?.[0] ?? null).catch(() => null)
                  e.currentTarget.value = ''
                }}
              />
            </label>
            <label>
              帧间隔(ms)
              <input
                type="number"
                min={80}
                step={20}
                value={playbackMs}
                onChange={(e) => setPlaybackMs(Math.max(80, Number(e.target.value) || 80))}
              />
            </label>
            <label className="debug-toggle-row">
              <input
                type="checkbox"
                checked={debugEnabled}
                onChange={(e) => setDebugEnabled(e.target.checked)}
              />
              显示调试面板
            </label>
            <div className="replay-actions">
              <button
                className="apply ghost"
                onClick={() => {
                  setMode('live')
                  introPlayedRef.current = false
                }}
              >
                实时
              </button>
              <button
                className="apply ghost"
                onClick={() => {
                  if (replayFrames.length === 0) return
                  setMode('replay')
                  setReplayIndex(0)
                  setActionIndex(0)
                  introPlayedRef.current = false
                  setActionPhase('idle')
                  setActiveAction(null)
                  setIsPlaying(false)
                }}
              >
                重置
              </button>
              <button
                className="apply"
                onClick={() => {
                  if (replayFrames.length === 0) return
                  setMode('replay')
                  if (!isPlaying) {
                    setActionPhase('idle')
                  }
                  setIsPlaying((v) => !v)
                }}
              >
                {isPlaying ? '暂停' : '播放'}
              </button>
              <button
                className="apply ghost"
                onClick={() => {
                  if (replayFrames.length === 0) return
                  setMode('replay')
                  setIsPlaying(false)
                  setReplayIndex((prev) => Math.max(prev - 1, 0))
                  setActionPhase('idle')
                  setActiveAction(null)
                }}
              >
                上一帧
              </button>
              <button
                className="apply ghost"
                onClick={() => {
                  if (replayFrames.length === 0) return
                  setMode('replay')
                  setIsPlaying(false)
                  setReplayIndex((prev) => Math.min(prev + 1, replayFrames.length - 1))
                  setActionPhase('idle')
                  setActiveAction(null)
                }}
              >
                下一帧
              </button>
            </div>
            <div className="replay-meta">
              {replayFrames.length > 0
                ? `frame ${replayIndex + 1}/${replayFrames.length} · action ${Math.min(actionIndex + 1, Math.max(1, replayActions.length))}/${Math.max(1, replayActions.length)} · ${replayFrames[replayIndex]?.label ?? ''}`
                : '未加载回放文件'}
            </div>
          </div>
        </div>}

        {!replayCompactMode && windowState.controls && (
          <div className="controls floating-window">
          <div className="window-head">
            <div className="panel-title">控制台</div>
            <button className="window-close" onClick={() => toggleWindow('controls')}>关闭</button>
          </div>
          {config ? (
            <div className="control-grid">
              <label>
                轨道长度
                <input
                  type="number"
                  value={config.track_length}
                  onChange={(e) => setConfig({ ...config, track_length: Number(e.target.value) })}
                />
              </label>
              <label>
                玩家数量
                <input
                  type="number"
                  value={config.max_players}
                  onChange={(e) => setConfig({ ...config, max_players: Number(e.target.value) })}
                />
              </label>
              <label>
                初始血量
                <input
                  type="number"
                  value={config.initial_hp}
                  onChange={(e) => setConfig({ ...config, initial_hp: Number(e.target.value) })}
                />
              </label>
              <label>
                掷骰最小
                <input
                  type="number"
                  value={config.dice_min}
                  onChange={(e) => setConfig({ ...config, dice_min: Number(e.target.value) })}
                />
              </label>
              <label>
                掷骰最大
                <input
                  type="number"
                  value={config.dice_max}
                  onChange={(e) => setConfig({ ...config, dice_max: Number(e.target.value) })}
                />
              </label>
              <label>
                视野范围
                <input
                  type="number"
                  value={config.vision_range}
                  onChange={(e) => setConfig({ ...config, vision_range: Number(e.target.value) })}
                />
              </label>
              <label>
                回合间隔(ms)
                <input
                  type="number"
                  value={config.tick_ms}
                  onChange={(e) => setConfig({ ...config, tick_ms: Number(e.target.value) })}
                />
              </label>
              <label>
                道具刷新概率
                <input
                  type="number"
                  step="0.05"
                  value={config.spawn_item_chance}
                  onChange={(e) =>
                    setConfig({ ...config, spawn_item_chance: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                不扣血概率
                <input
                  type="number"
                  step="0.05"
                  value={config.no_damage_chance}
                  onChange={(e) =>
                    setConfig({ ...config, no_damage_chance: Number(e.target.value) })
                  }
                />
              </label>
              <button className="apply" onClick={sendConfig}>
                应用配置
              </button>
              <button className="apply ghost" onClick={startDialogue}>
                开始对句
              </button>
            </div>
          ) : (
            <div className="loading">正在读取配置...</div>
          )}
          </div>
        )}

        {!replayCompactMode && windowState.logs && <div className="log-panel floating-window">
          <div className="window-head">
            <div className="panel-title">对话动态</div>
            <button className="window-close" onClick={() => toggleWindow('logs')}>关闭</button>
          </div>
          <div className="logs">
            {state.logs
              .filter((log) => log.kind === 'player_speak' || log.kind === 'discussion')
              .slice(-12)
              .map((log, index) => (
                <div key={`${log.ts}-${index}`} className="log-item">
                  <span>{log.payload?.player_id ?? 'system'}</span>
                  <span>{(log.payload as any)?.text ?? log.kind}</span>
                </div>
              ))}
          </div>
        </div>}
        {debugEnabled && (
          <div className="debug-panel floating-window">
            <div className="window-head">
              <div className="panel-title">调试状态</div>
              <button className="window-close" onClick={() => setDebugEnabled(false)}>关闭</button>
            </div>
            <div className="debug-grid">
              <div>mode: {mode}</div>
              <div>playing: {String(isPlaying)}</div>
              <div>phase: {actionPhase}</div>
              <div>actionIndex: {actionIndex}/{Math.max(1, replayActions.length)}</div>
              <div>replayIndex: {replayIndex}/{Math.max(1, replayFrames.length)}</div>
              <div>frameLabel: {currentFrameLabel}</div>
              <div>pipelineRun: {pipelineRunRef.current}</div>
              <div>truck: pos={state.truck.position} dir={state.truck.direction} rage={state.truck.speed}</div>
            </div>
            <div className="debug-players">
              {state.players.map((p) => (
                <div key={`dbg-${p.player_id}`} className="debug-player-row">
                  <span>{p.name}</span>
                  <span>id={p.player_id}</span>
                  <span>pos={p.position.toFixed(2)}</span>
                  <span>hp={p.hp}</span>
                  <span>facing={p.facing}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="sidebar">
        {playersByCorner.map((player) => (
          <PlayerCard
            key={player.player_id}
            player={player}
            maxHp={displayMaxHp}
            corner="right"
          />
        ))}
      </div>
    </div>
  )
}


function PlayerCard({
  player,
  corner,
  maxHp
}: {
  player: PlayerState
  corner: string
  maxHp: number
}) {
  const ratio = maxHp > 0 ? Math.max(0, Math.min(1, player.hp / maxHp)) : 0
  const isLow = player.hp > 0 && maxHp > 0 && player.hp <= 1
  const sideClass = corner === 'left' ? 'battery-right' : 'battery-left'
  const isDead = player.hp <= 0
  const avatarSrc = resolveAvatarSource(player.avatar ?? null)
  return (
    <div className={`corner ${corner}`}>
      <div className={`battery-rail ${sideClass}`}>
        <div className="battery">
          <div className="battery-fill" style={{ height: `${ratio * 100}%` }} />
        </div>
        <div className="battery-label">
          {player.hp}/{maxHp}
        </div>
      </div>
      <div className={`profile-card ${isDead ? 'is-dead' : ''}`}>
        {isDead && <div className="dead-x-overlay">X</div>}
        <div className="profile-top">
          <div className="profile-main">
            <div className={`avatar ${isLow ? 'avatar-low' : ''}`}>
              {avatarSrc ? (
                <img className="avatar-image" src={avatarSrc} alt={player.name || 'avatar'} />
              ) : (
                (player.name || '--').slice(0, 2)
              )}
            </div>
          </div>
        </div>
        <div className="player-name-compact">{player.name}</div>
      </div>
    </div>
  )
}

function MiniMap({
  players,
  trackLength,
  truckPosition,
  truckRage,
  visionRange
}: {
  players: PlayerState[]
  trackLength: number
  truckPosition: number
  truckRage: number
  visionRange: number
}) {
  const safeTrack = Math.max(1, trackLength)
  const wrappedTruck = ((truckPosition % safeTrack) + safeTrack) % safeTrack
  const center = 100
  const radius = 76
  const palette = ['#3affd0', '#ffe55e', '#ff7f5a', '#7cfbe0', '#ff5ca8', '#8fa2ff']
  const shortName = (name: string) => {
    const clean = (name || '--').trim()
    if (!clean) return '--'
    return clean.slice(0, 2).toUpperCase()
  }

  const toPoint = (position: number) => {
    const wrapped = ((position % safeTrack) + safeTrack) % safeTrack
    const angle = (wrapped / safeTrack) * Math.PI * 2 - Math.PI / 2
    return {
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius
    }
  }

  const truckPoint = toPoint(wrappedTruck)
  const truckSeenByPlayers = new Set<string>()
  for (const player of players) {
    if (player.hp <= 0) continue
    if (canSeeTruckBidirectional(player.position, wrappedTruck, visionRange, safeTrack)) {
      truckSeenByPlayers.add(player.player_id)
    }
  }

  return (
    <div className="mini-map">
      <div className="mini-map-title">MINI MAP</div>
      <svg className="mini-map-svg" viewBox="0 0 200 200" aria-label="mini map">
        <circle className="mini-map-ring-bg" cx={center} cy={center} r={radius + 7} />
        <circle className="mini-map-ring-main" cx={center} cy={center} r={radius} />
        <circle className="mini-map-center" cx={center} cy={center} r={2.6} />
        <polygon
          className="mini-map-truck"
          points={`${truckPoint.x},${truckPoint.y - 6} ${truckPoint.x + 6},${truckPoint.y} ${truckPoint.x},${truckPoint.y + 6} ${truckPoint.x - 6},${truckPoint.y}`}
        />
        {players.map((player, idx) => {
          const point = toPoint(player.position)
          const alive = player.hp > 0
          const canSeeTruck = alive && truckSeenByPlayers.has(player.player_id)
          const markerColor = !alive ? '#7b8598' : canSeeTruck ? '#ff5ca8' : palette[idx % palette.length]
          const dx = point.x - center
          const dy = point.y - center
          const dist = Math.hypot(dx, dy) || 1
          const labelOffset = 11
          const labelX = point.x + (dx / dist) * labelOffset
          const labelY = point.y + (dy / dist) * labelOffset
          const alertOffset = 8
          const alertX = point.x - (dx / dist) * alertOffset
          const alertY = point.y - (dy / dist) * alertOffset
          return (
            <g key={`mini-${player.player_id}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={alive ? 4.6 : 3.8}
                fill={markerColor}
                stroke={alive ? '#0d081b' : '#3f4655'}
                strokeWidth={1.6}
              />
              <text
                x={labelX}
                y={labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                className="mini-map-dot-label"
              >
                {idx + 1}
              </text>
              {truckSeenByPlayers.has(player.player_id) && (
                <text
                  x={alertX}
                  y={alertY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="mini-map-alert"
                >
                  !
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="mini-map-legend">
        {players.map((player, idx) => {
          const alive = player.hp > 0
          const markerColor = alive ? palette[idx % palette.length] : '#7b8598'
          const wrappedPos = ((player.position % safeTrack) + safeTrack) % safeTrack
          return (
            <div key={`mini-leg-${player.player_id}`} className="mini-map-legend-row">
              <span className="mini-map-legend-chip" style={{ backgroundColor: markerColor }}>
                {idx + 1}
              </span>
              <span className="mini-map-legend-name">
                {shortName(player.name)} · POS {wrappedPos.toFixed(1)} · HP {player.hp}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mini-map-meta">TRUCK POS {wrappedTruck.toFixed(1)} / {safeTrack} · RAGE {truckRage.toFixed(1)}</div>
      <div className="mini-map-meta mini-map-meta-note">大运行走距离 = RAGE × 随机点数</div>
    </div>
  )
}
