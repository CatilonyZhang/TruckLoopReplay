import { GameState, PlayerState } from './types'

export type ReplayFrame = {
  state: GameState
  label: string
}

export type ReplayAction = {
  tick: number
  agent_id: string
  ai_name: string
  steps: number
  direction: 'forward' | 'backward'
  message: string
  discussion_message: string
  action_message: string
  frameIndex: number
}

export type ReplayDiscussion = {
  tick: number
  agent_id: string
  ai_name: string
  message: string
  delivery: 'public' | 'private'
  targets: string[]
  frameIndex: number
}

export type ReplayTimeline = {
  frames: ReplayFrame[]
  actions: ReplayAction[]
  discussions: ReplayDiscussion[]
}

type LegacyEnvelope = {
  core_messages?: unknown
  agent_metadata?: unknown
}

type LegacyMessage = {
  turn?: number
  message_type?: string
  event?: string
  payload?: unknown
}

type MutablePlayer = {
  player_id: string
  name: string
  avatar: string
  position: number
  facing: number
  vote_reverse: boolean | null
  hp: number
  inventory: Record<string, number>
  message: string
}

const FALLBACK_TRACK = 48
const FALLBACK_HP = 3

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function compactTrackSize(payload: Record<string, unknown>): number | null {
  const request = asRecord(payload.request)
  const compactPs = asRecord(request.ps)
  const publicState = asRecord(request.public_state)
  const compactTs = asNumber(compactPs.ts, 0)
  if (compactTs > 0) return compactTs
  const fullTs = asNumber(publicState.track_size, 0)
  return fullTs > 0 ? fullTs : null
}

function compactPlayerPositions(payload: Record<string, unknown>): Record<string, number> {
  const request = asRecord(payload.request)
  const compactPs = asRecord(request.ps)
  const fullPublic = asRecord(request.public_state)
  const source = asRecord(compactPs.pp ?? fullPublic.player_positions)
  const out: Record<string, number> = {}
  for (const [id, value] of Object.entries(source)) {
    out[id] = asNumber(value, 0)
  }
  return out
}

function parseAgentMessage(raw: string): string {
  const sanitize = (input: string): string => {
    let text = input || ''
    text = text.replace(/```json[\s\S]*?```/gi, (block) => (/"tool_calls"\s*:/.test(block) ? '' : block))
    text = text.replace(/```[\s\S]*?```/g, '')
    text = text.replace(/\n?\s*```json[\s\S]*$/gi, (block) => (/"tool_calls"\s*:/.test(block) ? '' : block))
    text = text.replace(/\n?\s*\{[\s\S]*"tool_calls"\s*:[\s\S]*\}\s*$/i, '')
    text = text.replace(/```+/g, '')
    return text.trim()
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return sanitize(asString(parsed.message, raw))
  } catch {
    return sanitize(raw)
  }
}

function isCommentatorIdentity(agentId: string, aiName: string): boolean {
  const id = agentId.trim().toLowerCase()
  const name = aiName.trim().toLowerCase()
  return (
    id === 'commentator' ||
    id.startsWith('commentator') ||
    name.includes('解说') ||
    name.includes('commentator')
  )
}

function parseMoveDirection(raw: unknown): 'forward' | 'backward' {
  const value = asString(raw).trim().toLowerCase()
  if (value === 'backward' || value === 'counterclockwise' || value === 'counter_clockwise' || value === 'ccw') {
    return 'backward'
  }
  return 'forward'
}

function wrapTrack(position: number, trackLength: number): number {
  const track = Math.max(1, trackLength)
  return ((position % track) + track) % track
}

function circularDistance(from: number, to: number, trackLength: number): number {
  const track = Math.max(1, trackLength)
  const a = wrapTrack(from, track)
  const b = wrapTrack(to, track)
  const d = Math.abs(a - b)
  return Math.min(d, track - d)
}

function inferDirectionByPosition(
  fromPos: number,
  toPos: number,
  declared: 'forward' | 'backward',
  steps: number,
  trackLength: number
): 'forward' | 'backward' {
  const track = Math.max(1, trackLength)
  const from = wrapTrack(fromPos, track)
  const to = wrapTrack(toPos, track)
  const forward = (to - from + track) % track
  const backward = (from - to + track) % track
  if (forward === steps && backward !== steps) return 'forward'
  if (backward === steps && forward !== steps) return 'backward'
  const df = Math.abs(forward - steps)
  const db = Math.abs(backward - steps)
  if (df < db) return 'forward'
  if (db < df) return 'backward'
  return declared
}

function cloneState(
  tick: number,
  trackLength: number,
  players: Map<string, MutablePlayer>,
  truck: { position: number; direction: number; speed: number; can_multi_hit: boolean },
  logs: Array<{ ts: number; tick: number; kind: string; payload: Record<string, unknown> }>
): GameState {
  const clonedPlayers: PlayerState[] = Array.from(players.values()).map((player) => ({
    player_id: player.player_id,
    name: player.name,
    avatar: player.avatar || null,
    position: player.position,
    facing: player.facing,
    vote_reverse: player.vote_reverse,
    hp: player.hp,
    inventory: { ...player.inventory },
    message: player.message
  }))
  return {
    tick,
    track_length: trackLength,
    players: clonedPlayers,
    truck: { ...truck },
    items: [],
    logs: [...logs]
  }
}

export function parseLegacyExport(input: unknown): ReplayTimeline {
  const envelope = asRecord(input) as LegacyEnvelope
  const coreMessages = Array.isArray(envelope.core_messages)
    ? (envelope.core_messages as LegacyMessage[])
    : []
  if (coreMessages.length === 0) return { frames: [], actions: [], discussions: [] }

  const players = new Map<string, MutablePlayer>()
  const aiNameById = new Map<string, string>()
  const aiIdByName = new Map<string, string>()
  const avatarById = new Map<string, string>()
  const logs: Array<{ ts: number; tick: number; kind: string; payload: Record<string, unknown> }> = []
  const frames: ReplayFrame[] = []
  const actions: ReplayAction[] = []
  const discussions: ReplayDiscussion[] = []
  const lastIntentByAgent = new Map<
    string,
    {
      message: string
      steps: number
      direction: 'forward' | 'backward'
      tick: number
      ai_name: string
    }
  >()
  const discussionByTurnAgent = new Map<string, string>()
  const actionByTurnAgent = new Map<string, string>()
  const knownPositionByAgent = new Set<string>()
  const inferredSpawnDone = new Set<string>()

  let tick = 0
  let trackLength = FALLBACK_TRACK
  let maxHpSeen = FALLBACK_HP
  let seq = 0
  const truck = { position: 0, direction: 1, speed: 1, can_multi_hit: false }

  const backfillFallbackHp = (nextMaxHp: number) => {
    if (!(nextMaxHp > maxHpSeen)) return
    maxHpSeen = nextMaxHp
    // Early replay frames may have placeholder HP (=FALLBACK_HP) before lives appear.
    // Upgrade only placeholder values to keep real damage history intact.
    for (const player of players.values()) {
      if (player.hp === FALLBACK_HP) player.hp = nextMaxHp
    }
    for (const frame of frames) {
      for (const player of frame.state.players) {
        if (player.hp === FALLBACK_HP) player.hp = nextMaxHp
      }
    }
  }

  const ensurePlayer = (agentId: string, aiName: string, avatar = '') => {
    if (!players.has(agentId)) {
      players.set(agentId, {
        player_id: agentId,
        name: aiName || agentId,
        avatar: avatar || '',
        position: 0,
        facing: 1,
        vote_reverse: null,
        hp: maxHpSeen,
        inventory: {},
        message: ''
      })
    } else if (aiName) {
      const current = players.get(agentId)
      if (current) current.name = aiName
    }
    if (avatar) {
      const current = players.get(agentId)
      if (current) current.avatar = avatar
      avatarById.set(agentId, avatar)
    }
    if (aiName) {
      aiNameById.set(agentId, aiName)
      aiIdByName.set(aiName, agentId)
    }
  }

  const ensureCommentatorExists = () => {
    for (const player of players.values()) {
      if (isCommentatorIdentity(player.player_id, player.name)) return
    }
    ensurePlayer('commentator', '解说员', '')
    const commentator = players.get('commentator')
    if (commentator) {
      commentator.position = 0
      commentator.facing = 1
      commentator.hp = Math.max(commentator.hp, maxHpSeen)
      commentator.message = commentator.message || '解说席待命中...'
    }
  }

  const metas = Array.isArray(envelope.agent_metadata) ? envelope.agent_metadata : []
  for (const item of metas) {
    const row = asRecord(item)
    const agentId = asString(row.agent_id)
    if (!agentId) continue
    ensurePlayer(agentId, asString(row.ai_name, agentId), asString(row.avatar))
  }
  ensureCommentatorExists()

  const pushLog = (kind: string, payload: Record<string, unknown>) => {
    logs.push({ ts: seq, tick, kind, payload })
    if (logs.length > 120) logs.splice(0, logs.length - 120)
    seq += 1
  }

  const pushFrame = (label: string) => {
    frames.push({
      state: cloneState(tick, trackLength, players, truck, logs),
      label
    })
  }

  for (const message of coreMessages) {
    const messageTurn = asNumber(message.turn, tick)
    tick = Math.max(tick, messageTurn)
    const event = asString(message.event)
    const payload = asRecord(message.payload)
    const messageType = asString(message.message_type)

    const maybeTrackSize = compactTrackSize(payload)
    if (maybeTrackSize && maybeTrackSize > 0) trackLength = maybeTrackSize

    if (event === 'game_started') {
      const ids = Array.isArray(payload.alive_agents) ? payload.alive_agents : []
      const names = Array.isArray(payload.alive_ai_names) ? payload.alive_ai_names : []
      ids.forEach((id, idx) => {
        const agentId = asString(id)
        ensurePlayer(agentId, asString(names[idx], agentId), avatarById.get(agentId) ?? '')
      })
      truck.position = asNumber(payload.truck_position, truck.position)
      truck.direction = asNumber(payload.truck_direction, truck.direction) >= 0 ? 1 : -1
      truck.speed = Math.max(1, asNumber(payload.truck_rage, truck.speed))
      pushFrame('game_started')
      continue
    }

    if (messageType === 'agent_interaction') {
      const agentId = asString(payload.agent_id)
      const aiName = asString(payload.ai_name)
      const avatar = asString(payload.avatar, avatarById.get(agentId) ?? '')
      if (agentId) ensurePlayer(agentId, aiName, avatar)
      // Avoid replay jitter/teleport caused by stale compact snapshots in agent messages.
      // Position authority comes from player_moved / player_hit / truck_moved events.
      const positionMap = compactPlayerPositions(payload)
      for (const pid of Object.keys(positionMap)) {
        ensurePlayer(pid, aiNameById.get(pid) ?? pid, avatarById.get(pid) ?? '')
      }

      if (event === 'discussion_response' || event === 'agent_response' || event === 'commentator_response') {
        if (agentId) {
          const player = players.get(agentId)
          const text = parseAgentMessage(asString(payload.message))
          if (player) {
            player.message = text
            if (event !== 'commentator_response') {
              pushLog(
                isCommentatorIdentity(agentId, aiName || agentId) ? 'commentary' : 'player_speak',
                { player_id: agentId, text, source: 'agent_interaction' }
              )
            }
          }
          if (event === 'discussion_response' && text) {
            discussionByTurnAgent.set(`${tick}:${agentId}`, text)
          }
          if (event === 'agent_response' && text) {
            actionByTurnAgent.set(`${tick}:${agentId}`, text)
          }
          lastIntentByAgent.set(agentId, {
            message: text,
            steps: asNumber(payload.steps, 0),
            direction: parseMoveDirection(payload.direction),
            tick,
            ai_name: aiName || agentId
          })
        }
        pushFrame(event)
        if (event === 'discussion_response' && agentId) {
          const delivery = asString(payload.delivery) === 'private' ? 'private' : 'public'
          const rawTargets = Array.isArray(payload.targets) ? payload.targets : []
          discussions.push({
            tick,
            agent_id: agentId,
            ai_name: aiName || agentId,
            message: parseAgentMessage(asString(payload.message)),
            delivery,
            targets: rawTargets.map((x) => asString(x)).filter((x) => x.length > 0),
            frameIndex: frames.length - 1
          })
        }
      }
      continue
    }

    if (event === 'player_moved') {
      const agentId = asString(payload.agent_id)
      const aiName = asString(payload.ai_name, agentId)
      ensurePlayer(agentId, aiName, asString(payload.avatar, avatarById.get(agentId) ?? ''))
      const player = players.get(agentId)
      if (player) {
        const declaredDirection: 'forward' | 'backward' = parseMoveDirection(payload.direction)
        const declaredSign = declaredDirection === 'backward' ? -1 : 1
        const intent = lastIntentByAgent.get(agentId)
        const steps = Math.max(1, asNumber(payload.steps, intent?.steps ?? 1))
        const hasPosition = typeof payload.position === 'number' && Number.isFinite(payload.position)
        const movedTo = hasPosition
          ? wrapTrack(asNumber(payload.position, player.position), trackLength)
          : wrapTrack(player.position + declaredSign * steps, trackLength)
        let basePos = player.position
        if (!knownPositionByAgent.has(agentId)) {
          // Backfill spawn-like position from the first observed movement.
          const inferredSpawn = wrapTrack(movedTo - declaredSign * steps, trackLength)
          player.position = inferredSpawn
          basePos = inferredSpawn
          if (!inferredSpawnDone.has(agentId)) {
            for (const frame of frames) {
              const fp = frame.state.players.find((p) => p.player_id === agentId)
              if (fp) {
                fp.position = inferredSpawn
                fp.facing = declaredSign
              }
            }
            inferredSpawnDone.add(agentId)
          }
          knownPositionByAgent.add(agentId)
        }
        const resolvedDirection = inferDirectionByPosition(
          basePos,
          movedTo,
          declaredDirection,
          steps,
          trackLength
        )
        player.position = movedTo
        player.facing = resolvedDirection === 'backward' ? -1 : 1
        player.vote_reverse = typeof payload.vote_reverse === 'boolean' ? payload.vote_reverse : null
        const lives = asNumber(payload.lives, player.hp)
        backfillFallbackHp(lives)
        player.hp = lives
      }
      pushFrame('player_moved')
      const frameIndex = frames.length - 1
      const intent = lastIntentByAgent.get(agentId)
      const discussionText = discussionByTurnAgent.get(`${tick}:${agentId}`) ?? ''
      const actionText = actionByTurnAgent.get(`${tick}:${agentId}`) ?? ''
      const prevState = frames.length > 1 ? frames[frames.length - 2]?.state : null
      const movedPlayer = frames[frameIndex]?.state.players.find((p) => p.player_id === agentId)
      const prevPlayer = prevState?.players.find((p) => p.player_id === agentId)
      const inferredDirection =
        movedPlayer && prevPlayer
          ? inferDirectionByPosition(
              prevPlayer.position,
              movedPlayer.position,
              parseMoveDirection(asString(payload.direction, intent?.direction ?? 'forward')),
              Math.max(1, asNumber(payload.steps, intent?.steps ?? 1)),
              frames[frameIndex]?.state.track_length ?? trackLength
            )
          : parseMoveDirection(asString(payload.direction, intent?.direction ?? 'forward'))
      actions.push({
        tick,
        agent_id: agentId,
        ai_name: aiName || intent?.ai_name || agentId,
        steps: Math.max(1, asNumber(payload.steps, intent?.steps ?? 1)),
        direction: inferredDirection,
        message: actionText || discussionText || intent?.message || players.get(agentId)?.message || '',
        discussion_message: discussionText,
        action_message: actionText || intent?.message || players.get(agentId)?.message || '',
        frameIndex
      })
      continue
    }

    if (event === 'player_hit') {
      const agentId = asString(payload.agent_id)
      const aiName = asString(payload.ai_name, agentId)
      ensurePlayer(agentId, aiName, asString(payload.avatar, avatarById.get(agentId) ?? ''))
      const player = players.get(agentId)
      if (player) {
        const lives = asNumber(payload.lives, player.hp)
        backfillFallbackHp(lives)
        player.hp = lives
        const respawn = payload.respawned_position
        if (typeof respawn === 'number') {
          player.position = wrapTrack(respawn, trackLength)
          knownPositionByAgent.add(agentId)
        }
      }
      pushFrame('player_hit')
      continue
    }

    if (event === 'truck_moved') {
      truck.position = wrapTrack(asNumber(payload.truck_position, truck.position), trackLength)
      truck.direction = asNumber(payload.truck_direction, truck.direction) >= 0 ? 1 : -1
      truck.speed = Math.max(1, asNumber(payload.truck_rage, truck.speed))
      pushFrame('truck_moved')
      continue
    }

    if (event === 'commentator_broadcast') {
      const agentId = asString(payload.agent_id, 'commentator')
      const aiName = asString(payload.ai_name, agentId || '解说员')
      const avatar = asString(payload.avatar, avatarById.get(agentId) ?? '')
      ensurePlayer(agentId || 'commentator', aiName, avatar)
      const message = parseAgentMessage(asString(payload.text))
      const player = players.get(agentId || 'commentator')
      if (player) player.message = message
      pushLog('commentary', {
        player_id: agentId || 'commentator',
        ai_name: aiName,
        text: message,
        source: 'structured'
      })
      pushFrame('commentator_broadcast')
      continue
    }

    if (event === 'public_broadcast') {
      const text = asString(payload.text)
      if (text.includes('[COMMENTATOR][')) {
        const matched = /(?:^\[[^\]]+\])*\[COMMENTATOR\]\[([^\]]+)\]\s*([\s\S]+)$/u.exec(text)
        if (matched) {
          const aiName = matched[1]
          const agentId = aiIdByName.get(aiName) ?? 'commentator'
          ensurePlayer(agentId, aiName, avatarById.get(agentId) ?? '')
          const message = parseAgentMessage(matched[2])
          const player = players.get(agentId)
          if (player) player.message = message
          pushLog('commentary', { player_id: agentId, text: message, source: 'broadcast' })
        } else {
          pushLog('discussion', { player_id: 'system', text })
        }
      } else if (text.includes('[DISCUSS][')) {
        const matched = /(?:^\[[^\]]+\])*\[DISCUSS\]\[([^\]]+)\]\s*(.+)$/u.exec(text)
        if (matched) {
          const aiName = matched[1]
          const agentId = aiIdByName.get(aiName) ?? aiName
          ensurePlayer(agentId, aiName, avatarById.get(agentId) ?? '')
          const message = parseAgentMessage(matched[2])
          const player = players.get(agentId)
          if (player) player.message = message
          pushLog('discussion', { player_id: agentId, text: message })
        } else {
          pushLog('discussion', { player_id: 'system', text })
        }
      } else {
        pushLog('discussion', { player_id: 'system', text })
      }
      pushFrame('public_broadcast')
      continue
    }

    if (event === 'turn_finished' || event === 'turn_started') {
      pushFrame(event)
    }
  }

  for (const player of players.values()) {
    player.hp = Math.max(0, Math.min(maxHpSeen, player.hp))
  }
  ensureCommentatorExists()

  // Trajectory plausibility repair:
  // - only player_hit may cause large jumps
  // - player_moved can infer missing/invalid positions from steps+direction
  const actionByFrame = new Map<number, ReplayAction>()
  for (const action of actions) actionByFrame.set(action.frameIndex, action)

  for (let i = 1; i < frames.length; i += 1) {
    const prev = frames[i - 1]
    const curr = frames[i]
    const prevById = new Map(prev.state.players.map((p) => [p.player_id, p]))
    const movedAction = actionByFrame.get(i)
    for (const player of curr.state.players) {
      const prevPlayer = prevById.get(player.player_id)
      if (!prevPlayer) continue

      const hpDropped = player.hp < prevPlayer.hp
      if (curr.label === 'player_hit' && hpDropped) continue

      if (movedAction && movedAction.agent_id === player.player_id) {
        const expected = wrapTrack(
          prevPlayer.position + (movedAction.direction === 'backward' ? -1 : 1) * Math.max(1, movedAction.steps),
          curr.state.track_length
        )
        const jump = circularDistance(prevPlayer.position, player.position, curr.state.track_length)
        if (jump === 0 || jump > Math.max(2, movedAction.steps + 2)) {
          player.position = expected
        }
        continue
      }

      const jump = circularDistance(prevPlayer.position, player.position, curr.state.track_length)
      if (jump > 2) {
        player.position = prevPlayer.position
      }
    }
  }

  return { frames, actions, discussions }
}
