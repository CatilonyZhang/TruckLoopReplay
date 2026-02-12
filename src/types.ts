export type PlayerState = {
  player_id: string
  name: string
  avatar?: string | null
  position: number
  facing: number
  vote_reverse?: boolean | null
  hp: number
  inventory: Record<string, number>
  message: string
}

export type ItemState = {
  item_id: string
  kind: string
  position: number
  ttl: number
  planted: boolean
}

export type TruckState = {
  position: number
  direction: number
  speed: number
  can_multi_hit: boolean
}

export type GameState = {
  tick: number
  track_length: number
  players: PlayerState[]
  truck: TruckState
  items: ItemState[]
  logs: Array<{ ts: number; tick: number; kind: string; payload: Record<string, unknown> }>
}
