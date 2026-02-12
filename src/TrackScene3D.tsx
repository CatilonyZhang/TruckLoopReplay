import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { GameState } from './types'

type CuePhase = 'overview' | 'rollcall' | 'discussion' | 'move' | 'vote' | 'truck'

type Props = {
  state: GameState
  visionRange: number
  onFocusChange?: (payload: { name: string; message: string; phase: CuePhase; title: string } | null) => void
  scriptedFocus?: {
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
}

type PlayerNode = {
  body: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  vision: THREE.Line
  label: THREE.Sprite
  labelText: string
  avatarKey: string
}

type TruckLabelNode = {
  sprite: THREE.Sprite
  labelText: string
}

type Particle = {
  mesh: THREE.Mesh
  velocity: THREE.Vector3
  life: number
  maxLife: number
}

type TrackNumberNode = {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
  texture: THREE.Texture
}

type Director = {
  turn: number
  startedAt: number
  phase: CuePhase
  phaseStart: number
  focusStart: number
  phaseDurations: Record<CuePhase, number>
  focusIds: string[]
  focusIndex: number
}

const TAU = Math.PI * 2
const CAMERA_TIME_SCALE = 1.5
const CAMERA_LERP_SCALE = 1 / CAMERA_TIME_SCALE
const CAMERA_ORBIT_SPEED_SCALE = 1 / CAMERA_TIME_SCALE
const AUTO_FOCUS_HOLD_MS = 5000 * CAMERA_TIME_SCALE

function camEase(value: number): number {
  return Math.max(0.001, Math.min(1, value * CAMERA_LERP_SCALE))
}

function directionalDistance(from: number, to: number, direction: number, track: number): number {
  const safe = Math.max(1, track)
  const a = wrapPos(from, safe)
  const b = wrapPos(to, safe)
  return direction >= 0 ? (b - a + safe) % safe : (a - b + safe) % safe
}

function wrapPos(position: number, track: number): number {
  return ((position % track) + track) % track
}

function trackPoint(position: number, track: number, radius: number): THREE.Vector3 {
  const wrapped = wrapPos(position, track)
  const angle = (wrapped / track) * TAU - Math.PI / 2
  return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
}

function buildVision(
  position: number,
  facing: number,
  range: number,
  track: number,
  radius: number
): THREE.BufferGeometry {
  const steps = Math.max(6, Math.min(48, Math.floor(range * 6)))
  const points: THREE.Vector3[] = []
  const dir = facing >= 0 ? 1 : -1
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const p = position + dir * range * t
    points.push(trackPoint(p, track, radius))
  }
  return new THREE.BufferGeometry().setFromPoints(points)
}

function phaseTitle(phase: CuePhase): string {
  if (phase === 'overview') return '鸟瞰总览'
  if (phase === 'rollcall') return '选手报位'
  if (phase === 'discussion') return '讨论开始'
  if (phase === 'move') return '开始移动'
  if (phase === 'vote') return '投票展示'
  return '大运冲锋'
}

function phaseNext(phase: CuePhase): CuePhase {
  if (phase === 'overview') return 'rollcall'
  if (phase === 'rollcall') return 'discussion'
  if (phase === 'discussion') return 'move'
  if (phase === 'move') return 'vote'
  if (phase === 'vote') return 'truck'
  return 'truck'
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

function isCommentatorIdentity(playerId: string, name: string): boolean {
  const id = (playerId || '').trim().toLowerCase()
  const aiName = (name || '').trim().toLowerCase()
  return (
    id === 'commentator' ||
    id.startsWith('commentator') ||
    aiName.includes('解说') ||
    aiName.includes('commentator')
  )
}

function createNumberTexture(index: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 192
  canvas.height = 96
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.0)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // Contrast plate improves readability against dark/foggy background.
    ctx.fillStyle = 'rgba(12, 8, 24, 0.58)'
    ctx.fillRect(18, 18, canvas.width - 36, canvas.height - 36)
    ctx.strokeStyle = 'rgba(58, 255, 208, 0.55)'
    ctx.lineWidth = 3
    ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36)
    ctx.strokeStyle = '#0b0620'
    ctx.lineWidth = 9
    ctx.font = 'bold 56px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeText(String(index), canvas.width / 2, canvas.height / 2 + 2)
    ctx.fillStyle = '#ffe55e'
    ctx.fillText(String(index), canvas.width / 2, canvas.height / 2 + 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.needsUpdate = true
  return texture
}

function createNumberSprite(index: number): TrackNumberNode {
  const texture = createNumberTexture(index)
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(2.1, 1.05, 1)
  sprite.renderOrder = 18
  sprite.frustumCulled = false
  return {
    sprite,
    material,
    texture
  }
}

function createNameSprite(name: string, hp: number, position: number | string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 560
  canvas.height = 96
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.0)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(11, 4, 25, 0.92)'
    ctx.fillRect(12, 20, canvas.width - 24, 52)
    ctx.strokeStyle = '#3affd0'
    ctx.lineWidth = 4
    ctx.strokeRect(12, 20, canvas.width - 24, 52)
    const statW = 120
    const hpX = canvas.width - 12 - statW * 2 - 8
    const posX = canvas.width - 12 - statW
    ctx.fillStyle = 'rgba(255, 229, 94, 0.15)'
    ctx.fillRect(hpX, 20, statW, 52)
    ctx.fillRect(posX, 20, statW, 52)
    ctx.strokeStyle = '#ffe55e'
    ctx.strokeRect(hpX, 20, statW, 52)
    ctx.strokeRect(posX, 20, statW, 52)
    ctx.font = 'bold 28px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#c9f9ff'
    ctx.fillText(name, 26, 46)
    ctx.font = 'bold 24px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffe55e'
    ctx.fillText(`HP ${hp}`, hpX + statW / 2, 46)
    ctx.fillText(`POS ${String(position)}`, posX + statW / 2, 46)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(6.0, 1.45, 1)
  sprite.renderOrder = 120
  return sprite
}

function createTruckSprite(position: number, rage: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 520
  canvas.height = 96
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.0)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(25, 6, 20, 0.92)'
    ctx.fillRect(12, 20, canvas.width - 24, 52)
    ctx.strokeStyle = '#ff7f5a'
    ctx.lineWidth = 4
    ctx.strokeRect(12, 20, canvas.width - 24, 52)
    const statW = 132
    const rageX = canvas.width - 12 - statW * 2 - 8
    const posX = canvas.width - 12 - statW
    ctx.fillStyle = 'rgba(255, 127, 90, 0.17)'
    ctx.fillRect(rageX, 20, statW, 52)
    ctx.fillRect(posX, 20, statW, 52)
    ctx.strokeStyle = '#ff7f5a'
    ctx.strokeRect(rageX, 20, statW, 52)
    ctx.strokeRect(posX, 20, statW, 52)
    ctx.font = 'bold 28px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#ffd1bf'
    ctx.fillText('DAYUN', 26, 46)
    ctx.font = 'bold 24px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffe55e'
    ctx.fillText(`RAGE ${rage}`, rageX + statW / 2, 46)
    ctx.fillText(`POS ${position}`, posX + statW / 2, 46)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(5.5, 1.38, 1)
  sprite.renderOrder = 121
  return sprite
}

export default function TrackScene3D({ state, visionRange, onFocusChange, scriptedFocus }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const liveStateRef = useRef<GameState>(state)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const truckRef = useRef<THREE.Mesh | null>(null)
  const truckLabelRef = useRef<TruckLabelNode | null>(null)
  const playerNodesRef = useRef<Map<string, PlayerNode>>(new Map())
  const animationRef = useRef<number | null>(null)
  const trackCellsRef = useRef<THREE.Group | null>(null)
  const trackNumberNodesRef = useRef<TrackNumberNode[]>([])
  const prevTrackRef = useRef<number>(0)
  const prevPlayerPosRef = useRef<Map<string, number>>(new Map())
  const particlesRef = useRef<Particle[]>([])
  const truckTrailAtRef = useRef(0)
  const lastCueRef = useRef('')
  const scriptedFocusRef = useRef<Props['scriptedFocus']>(scriptedFocus)
  const plannedPathLineRef = useRef<THREE.Line | null>(null)
  const plannedPathHeadRef = useRef<THREE.Mesh | null>(null)
  const scriptedCamRef = useRef<{
    key: string
    lookAt: THREE.Vector3
    basePos: THREE.Vector3
    pulledIn: boolean
  } | null>(null)
  const actorPathAnchorRef = useRef<{ key: string; startPos: number } | null>(null)
  const truckPathAnchorRef = useRef<{ key: string; startPos: number } | null>(null)
  const plannedPathMarkersRef = useRef<THREE.Group | null>(null)
  const ringRadius = useMemo(() => 18, [])
  const directorRef = useRef<Director>({
    turn: -1,
    startedAt: 0,
    phase: 'overview',
    phaseStart: 0,
    focusStart: 0,
    phaseDurations: {
      overview: 10000,
      rollcall: 10000,
      discussion: 10000,
      move: 10000,
      vote: 10000,
      truck: 10000
    },
    focusIds: [],
    focusIndex: 0
  })

  useEffect(() => {
    liveStateRef.current = state
  }, [state])

  useEffect(() => {
    scriptedFocusRef.current = scriptedFocus
  }, [scriptedFocus])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x140a28)
    scene.fog = new THREE.Fog(0x140a28, 26, 80)

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      premultipliedAlpha: false
    })
    renderer.setPixelRatio(1)
    renderer.setSize(host.clientWidth, host.clientHeight)
    renderer.domElement.style.imageRendering = 'pixelated'
    host.appendChild(renderer.domElement)

    const camera = new THREE.PerspectiveCamera(
      48,
      Math.max(1, host.clientWidth / Math.max(1, host.clientHeight)),
      0.1,
      220
    )
    camera.position.set(0, 30, 34)
    camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    scene.add(new THREE.AmbientLight(0xb28dff, 0.34))

    const keyLight = new THREE.DirectionalLight(0x72ffd9, 0.82)
    keyLight.position.set(14, 26, 12)
    scene.add(keyLight)

    const rimLight = new THREE.PointLight(0xff6bb2, 0.75, 130, 2)
    rimLight.position.set(-24, 10, -10)
    scene.add(rimLight)

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(42, 36),
      new THREE.MeshPhongMaterial({
        color: 0x140a2a,
        shininess: 12,
        transparent: true,
        opacity: 0.86,
        depthWrite: false
      })
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.36
    scene.add(floor)

    const skylineGroup = new THREE.Group()
    scene.add(skylineGroup)
    const skylineRings = [29, 36, 44]
    skylineRings.forEach((radius, ringIdx) => {
      const count = 26 + ringIdx * 10
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * TAU + ringIdx * 0.09
        const wobble = Math.sin(i * 1.31 + ringIdx * 0.8) * 0.9
        const x = Math.cos(angle) * (radius + wobble)
        const z = Math.sin(angle) * (radius + wobble)
        const h = 1.1 + ringIdx * 0.75 + ((i * 17 + ringIdx * 7) % 11) * 0.17
        const w = 0.55 + ((i * 13 + ringIdx * 3) % 5) * 0.11
        const d = 0.55 + ((i * 9 + ringIdx * 5) % 5) * 0.11
        const color = new THREE.Color().setHSL(0.55 + ringIdx * 0.06, 0.5, 0.15 + ringIdx * 0.03)
        const emissive = new THREE.Color().setHSL(0.5 + ringIdx * 0.04, 0.65, 0.11)
        const tower = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          new THREE.MeshStandardMaterial({
            color,
            emissive,
            emissiveIntensity: 0.2,
            roughness: 0.78,
            metalness: 0.1,
            transparent: true,
            opacity: 0.78,
            depthWrite: false
          })
        )
        tower.position.set(x, h * 0.5 - 0.28, z)
        tower.rotation.y = angle + Math.sin(i * 0.7) * 0.15
        tower.renderOrder = 2
        skylineGroup.add(tower)
      }
    })

    // Voxel-style track: use block segments as the primary ring.

    const cellGroup = new THREE.Group()
    scene.add(cellGroup)
    trackCellsRef.current = cellGroup

    const truckMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd36a,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      depthTest: false,
      alphaTest: 0.04,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide
    })
    const truckTextureUrl = `${import.meta.env.BASE_URL}img/truck.png`
    const truckTexture = new THREE.TextureLoader().load(
      truckTextureUrl,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
        tex.generateMipmaps = false
        tex.minFilter = THREE.NearestFilter
        tex.magFilter = THREE.NearestFilter
        truckMaterial.map = tex
        truckMaterial.color.set(0xffffff)
        truckMaterial.needsUpdate = true
      },
      undefined,
      (err) => {
        console.error('[TrackScene3D] truck texture load failed:', truckTextureUrl, err)
      }
    )

    const truck = new THREE.Mesh(
      new THREE.PlaneGeometry(5.5, 3.6),
      truckMaterial
    )
    truck.renderOrder = 40
    truck.frustumCulled = false
    truck.position.set(0, 1.9, ringRadius)
    scene.add(truck)
    truckRef.current = truck
    const initialTruckPos = Math.round(wrapPos(state.truck.position, Math.max(1, state.track_length)))
    const initialTruckRage = Math.max(1, Math.round(state.truck.speed))
    const truckLabel = createTruckSprite(initialTruckPos, initialTruckRage)
    truckLabel.position.set(0, 3.95, ringRadius)
    scene.add(truckLabel)
    truckLabelRef.current = { sprite: truckLabel, labelText: `${initialTruckPos}|${initialTruckRage}` }

    const plannedPathLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0xffe55e,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        depthTest: false
      })
    )
    plannedPathLine.visible = false
    plannedPathLine.renderOrder = 98
    scene.add(plannedPathLine)
    plannedPathLineRef.current = plannedPathLine

    const plannedMarkers = new THREE.Group()
    plannedMarkers.visible = false
    scene.add(plannedMarkers)
    plannedPathMarkersRef.current = plannedMarkers

    const plannedPathHead = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 0.9, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffe55e,
        transparent: true,
        opacity: 0.94,
        depthWrite: false,
        depthTest: false
      })
    )
    plannedPathHead.visible = false
    plannedPathHead.renderOrder = 99
    scene.add(plannedPathHead)
    plannedPathHeadRef.current = plannedPathHead

    const avatarTextureLoader = new THREE.TextureLoader()
    const avatarTextureCache = new Map<string, THREE.Texture>()

    const configureSpriteTexture = (texture: THREE.Texture) => {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
      texture.generateMipmaps = false
      texture.minFilter = THREE.NearestFilter
      texture.magFilter = THREE.NearestFilter
      texture.needsUpdate = true
    }

    const getFallbackAvatarTexture = (name: string) => {
      const initials = (name || '--').slice(0, 2).toUpperCase()
      const key = `fallback:${initials}`
      const cached = avatarTextureCache.get(key)
      if (cached) return cached

      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#2a143f'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#ffe55e'
        ctx.fillRect(12, 12, canvas.width - 24, canvas.height - 24)
        ctx.fillStyle = '#140a28'
        ctx.font = 'bold 110px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(initials, canvas.width / 2, canvas.height / 2 + 8)
      }
      const texture = new THREE.CanvasTexture(canvas)
      configureSpriteTexture(texture)
      avatarTextureCache.set(key, texture)
      return texture
    }

    const getAvatarTexture = (avatar: string | null | undefined, name: string): { texture: THREE.Texture; key: string } => {
      const src = resolveAvatarSource(avatar)
      if (!src) {
        const fallback = getFallbackAvatarTexture(name)
        return { texture: fallback, key: `fallback:${(name || '--').slice(0, 2).toUpperCase()}` }
      }
      const cached = avatarTextureCache.get(src)
      if (cached) {
        const image = (cached as THREE.Texture).image as { width?: number } | undefined
        const ready = !!image && typeof image.width === 'number' && image.width > 0
        if (ready) return { texture: cached, key: src }
        const fallback = getFallbackAvatarTexture(name)
        return { texture: fallback, key: `fallback:${(name || '--').slice(0, 2).toUpperCase()}` }
      }
      const texture = avatarTextureLoader.load(
        src,
        (tex) => {
          configureSpriteTexture(tex)
        },
        undefined,
        (err) => {
          console.error('[TrackScene3D] player avatar texture load failed:', src, err)
        }
      )
      configureSpriteTexture(texture)
      avatarTextureCache.set(src, texture)
      const fallback = getFallbackAvatarTexture(name)
      return { texture: fallback, key: `fallback:${(name || '--').slice(0, 2).toUpperCase()}` }
    }

    const resizeObserver = new ResizeObserver(() => {
      const w = host.clientWidth
      const h = Math.max(1, host.clientHeight)
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    resizeObserver.observe(host)

    const clearTrackCells = () => {
      if (!trackCellsRef.current) return
      for (const child of trackCellsRef.current.children) {
        const obj = child as THREE.Object3D
        if ('geometry' in obj && obj.geometry) obj.geometry.dispose()
        if ('material' in obj && obj.material) {
          const material = obj.material as THREE.Material | THREE.Material[]
          if (Array.isArray(material)) material.forEach((m) => m.dispose())
          else material.dispose()
        }
      }
      trackCellsRef.current.clear()
    }

    const clearTrackNumberNodes = () => {
      for (const node of trackNumberNodesRef.current) {
        node.texture.dispose()
      }
      trackNumberNodesRef.current = []
    }

    const rebuildTrackCells = (track: number) => {
      if (!trackCellsRef.current) return
      clearTrackNumberNodes()
      clearTrackCells()

      for (let i = 0; i < track; i += 1) {
        const major = i % 4 === 0
        const hue = (i / track) * 360
        const color = new THREE.Color(`hsl(${hue}, 78%, ${major ? 66 : 55}%)`)

        const p = trackPoint(i, track, ringRadius)
        const next = trackPoint(i + 1, track, ringRadius)
        const angle = Math.atan2(next.z - p.z, next.x - p.x)
        const tangent = next.clone().sub(p).normalize()
        const phase = (i / track) * TAU
        const radial = new THREE.Vector3(p.x, 0, p.z).normalize()
        const spiralLift = Math.sin(phase * 2.3) * 0.34
        const spiralRadial = Math.cos(phase * 2.3) * 0.42
        const nodePos = p.clone().add(radial.multiplyScalar(spiralRadial))

        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(1.16, major ? 0.78 : 0.52, major ? 1.02 : 0.86),
          new THREE.MeshStandardMaterial({
            color,
            emissive: color.clone().multiplyScalar(0.46),
            emissiveIntensity: major ? 0.34 : 0.2,
            metalness: 0.2,
            roughness: 0.6
          })
        )
        tile.position.set(nodePos.x, (major ? 0.96 : 0.74) + spiralLift, nodePos.z)
        tile.rotation.y = -angle
        tile.rotation.x = Math.sin(phase * 1.8) * 0.08
        tile.rotation.z = Math.cos(phase * 1.6) * 0.07
        const arcTwist = Math.sin(phase * 3.1) * 0.12
        tile.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(tangent, arcTwist))
        trackCellsRef.current.add(tile)

        const label = createNumberSprite(i)
        label.sprite.position.set(nodePos.x, 1.9 + spiralLift, nodePos.z)
        trackCellsRef.current.add(label.sprite)
        trackNumberNodesRef.current.push(label)
      }
    }

    const spawnBurst = (origin: THREE.Vector3, color: number, count: number, spread: number) => {
      for (let i = 0; i < count; i += 1) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.16 + Math.random() * 0.08, 0.16 + Math.random() * 0.08, 0.16 + Math.random() * 0.08),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
        )
        mesh.position.copy(origin)
        scene.add(mesh)
        const velocity = new THREE.Vector3(
          (Math.random() - 0.5) * spread,
          0.02 + Math.random() * 0.11,
          (Math.random() - 0.5) * spread
        )
        particlesRef.current.push({
          mesh,
          velocity,
          life: 0.5 + Math.random() * 0.55,
          maxLife: 0.5 + Math.random() * 0.55
        })
      }
    }

    const announce = (payload: { name: string; message: string; phase: CuePhase; title: string }) => {
      const key = `${payload.phase}-${payload.name}-${payload.message}-${liveStateRef.current.tick}-${directorRef.current.focusIndex}`
      if (lastCueRef.current === key) return
      lastCueRef.current = key
      onFocusChange?.(payload)
    }

    const animate = (t: number) => {
      const now = t
      const live = liveStateRef.current
      const activeScriptedFocus = scriptedFocusRef.current
      const liveTrack = Math.max(8, live.track_length || 48)
      const shouldSnapToGrid =
        !activeScriptedFocus?.enabled &&
        (directorRef.current.phase === 'overview' || directorRef.current.phase === 'vote')

      if (prevTrackRef.current !== liveTrack) {
        prevTrackRef.current = liveTrack
        rebuildTrackCells(liveTrack)
      }

      const director = directorRef.current
      if (director.turn !== live.tick) {
        director.turn = live.tick
        director.phase = 'overview'
        director.startedAt = now
        director.phaseStart = now
        director.focusStart = now
        director.focusIds = live.players
          .filter((p) => p.hp > 0 && !isCommentatorIdentity(p.player_id, p.name))
          .map((p) => p.player_id)
        director.focusIndex = 0
        if (!activeScriptedFocus?.enabled) {
          announce({
            name: '全局鸟瞰',
            message: `回合 ${live.tick}：地图总览与位置确认`,
            phase: 'overview',
            title: phaseTitle('overview')
          })
        }
      }

      if (director.phase !== 'truck' && now - director.phaseStart >= director.phaseDurations[director.phase]) {
        director.phase = phaseNext(director.phase)
        director.phaseStart = now
        director.focusStart = now
        if (director.phase === 'rollcall' || director.phase === 'discussion' || director.phase === 'move') {
          director.focusIndex = 0
        }
      }

      const plannedLine = plannedPathLineRef.current
      const plannedHead = plannedPathHeadRef.current
      const plannedMarkers = plannedPathMarkersRef.current
      if (plannedLine && plannedHead && plannedMarkers) {
        const showActorPlannedPath =
          !!activeScriptedFocus?.enabled &&
          !!activeScriptedFocus.agentId &&
          (activeScriptedFocus.phase === 'sync' || activeScriptedFocus.phase === 'idle' || activeScriptedFocus.phase === 'move') &&
          !!activeScriptedFocus.direction &&
          Number(activeScriptedFocus.steps) > 0
        const showTruckPlannedPath =
          !!activeScriptedFocus?.enabled &&
          activeScriptedFocus.phase === 'impact' &&
          Number(activeScriptedFocus.truckSteps) > 0

        if (showActorPlannedPath || showTruckPlannedPath) {
          const sign =
            showTruckPlannedPath
              ? ((Number(activeScriptedFocus?.truckDirection) || 0) >= 0 ? 1 : -1)
              : (activeScriptedFocus?.direction === 'backward' ? -1 : 1)
          const totalSteps = Math.max(
            1,
            showTruckPlannedPath
              ? (Number(activeScriptedFocus?.truckSteps) || 1)
              : (Number(activeScriptedFocus?.steps) || 1)
          )

          let originPos: number | undefined
          let remainingSteps = totalSteps

          if (showTruckPlannedPath) {
            const key = `truck-${activeScriptedFocus?.token ?? 'truck'}`
            if (!truckPathAnchorRef.current || truckPathAnchorRef.current.key !== key) {
              truckPathAnchorRef.current = { key, startPos: live.truck.position }
            }
            const traveled = directionalDistance(
              truckPathAnchorRef.current.startPos,
              live.truck.position,
              sign,
              liveTrack
            )
            remainingSteps = Math.max(0, totalSteps - traveled)
            originPos = live.truck.position
          } else {
            const actor = live.players.find((p) => p.player_id === activeScriptedFocus?.agentId)
            if (actor) {
              const key = `actor-${activeScriptedFocus?.token ?? actor.player_id}`
              if (!actorPathAnchorRef.current || actorPathAnchorRef.current.key !== key) {
                actorPathAnchorRef.current = { key, startPos: actor.position }
              }
              const inMove = activeScriptedFocus?.phase === 'move'
              if (inMove) {
                const traveled = directionalDistance(
                  actorPathAnchorRef.current.startPos,
                  actor.position,
                  sign,
                  liveTrack
                )
                remainingSteps = Math.max(0, totalSteps - traveled)
              } else {
                remainingSteps = totalSteps
              }
              originPos = actor.position
            }
          }

          if (typeof originPos === 'number' && Number.isFinite(originPos) && remainingSteps > 0.03) {
            const points: THREE.Vector3[] = []
            const segmentCount = Math.max(8, Math.round(remainingSteps * 8))
            for (let i = 0; i <= segmentCount; i += 1) {
              const tNorm = i / segmentCount
              const p = trackPoint(originPos + sign * remainingSteps * tNorm, liveTrack, ringRadius + 0.04)
              p.y = 2.55 + Math.sin(tNorm * Math.PI) * 0.72
              points.push(p)
            }
            const lineGeo = plannedLine.geometry as THREE.BufferGeometry
            lineGeo.setFromPoints(points)
            plannedLine.visible = true
            plannedMarkers.visible = true

            for (const child of plannedMarkers.children) {
              const marker = child as THREE.Mesh
              marker.geometry.dispose()
              ;(marker.material as THREE.Material).dispose()
            }
            plannedMarkers.clear()
            const markerCount = Math.max(1, Math.ceil(remainingSteps))
            for (let step = 1; step <= markerCount; step += 1) {
              const stepT = markerCount <= 1 ? 1 : step / markerCount
              const pos = trackPoint(originPos + sign * remainingSteps * stepT, liveTrack, ringRadius + 0.06)
              const box = new THREE.Mesh(
                new THREE.BoxGeometry(0.52, 0.42, 0.52),
                new THREE.MeshBasicMaterial({
                  color: step === markerCount ? 0xff7f5a : 0xffe55e,
                  transparent: true,
                  opacity: step === markerCount ? 0.95 : 0.82,
                  depthWrite: false,
                  depthTest: false
                })
              )
              box.position.set(pos.x, 2.45 + step * 0.04, pos.z)
              box.renderOrder = 97
              plannedMarkers.add(box)
            }

            const tail = points[Math.max(0, points.length - 2)]
            const tip = points[points.length - 1]
            plannedHead.visible = true
            plannedHead.position.copy(tip)
            plannedHead.position.y += 0.34
            const dir = tip.clone().sub(tail).normalize()
            plannedHead.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
          } else {
            plannedLine.visible = false
            plannedHead.visible = false
            plannedMarkers.visible = false
          }
        } else {
          actorPathAnchorRef.current = null
          truckPathAnchorRef.current = null
          plannedLine.visible = false
          plannedHead.visible = false
          plannedMarkers.visible = false
        }
      }

      const playerMap = playerNodesRef.current
      const existing = new Set(playerMap.keys())

      for (const player of live.players) {
        existing.delete(player.player_id)
        const isCommentator = isCommentatorIdentity(player.player_id, player.name)
        let node = playerMap.get(player.player_id)
        if (!node) {
          const avatar = getAvatarTexture(player.avatar ?? null, player.name)
          const body = new THREE.Mesh(
            new THREE.PlaneGeometry(2.28, 2.28),
            new THREE.MeshBasicMaterial({
              map: avatar.texture,
              color: 0xffffff,
              transparent: true,
              opacity: 0.98,
              depthWrite: false,
              depthTest: false,
              alphaTest: 0.04,
              side: THREE.DoubleSide,
              fog: false,
              toneMapped: false
            })
          )
          body.renderOrder = 24
          body.frustumCulled = false
          const vLine = new THREE.Line(
            buildVision(0, 1, visionRange, liveTrack, ringRadius + 0.4),
            new THREE.LineBasicMaterial({ color: 0x3affd0, transparent: true, opacity: 0.4 })
          )
          const initialPos: number | string = isCommentator ? 'CENTER' : Math.round(wrapPos(player.position, liveTrack))
          const label = createNameSprite(player.name, player.hp, initialPos)
          scene.add(body)
          scene.add(vLine)
          scene.add(label)
          node = {
            body,
            vision: vLine,
            label,
            labelText: `${player.name}|${player.hp}|${initialPos}`,
            avatarKey: avatar.key
          }
          playerMap.set(player.player_id, node)
        }

        const wrappedRaw = wrapPos(player.position, liveTrack)
        const wrappedPos = shouldSnapToGrid ? Math.round(wrappedRaw) : wrappedRaw
        const displayPos = Math.round(wrapPos(wrappedPos, liveTrack))
        const p = isCommentator ? new THREE.Vector3(0, 0, 0) : trackPoint(wrappedPos, liveTrack, ringRadius)
        const frac = isCommentator || shouldSnapToGrid ? 0 : wrappedPos - Math.floor(wrappedPos)
        const hop = (!isCommentator && frac > 0.02 && frac < 0.98) ? Math.sin(frac * Math.PI) * 0.62 : 0
        if (isCommentator) {
          node.body.position.set(0, 2.25, 0)
          node.label.position.set(0, 4.25, 0)
          node.body.scale.set(1.12, 1.12, 1)
        } else {
          node.body.position.set(p.x, 2.06 + hop, p.z)
          node.label.position.set(p.x, 3.6 + hop * 0.35, p.z)
          node.body.scale.set(1, 1, 1)
        }
        const nextAvatar = getAvatarTexture(player.avatar ?? null, player.name)
        const nextAvatarKey = nextAvatar.key
        if (node.avatarKey !== nextAvatarKey) {
          node.body.material.map = nextAvatar.texture
          node.body.material.needsUpdate = true
          node.avatarKey = nextAvatarKey
        }
        if (player.hp > 0) {
          node.body.material.color.set(0xffffff)
          node.body.material.opacity = 0.98
        } else {
          node.body.material.color.set(0x7e879a)
          node.body.material.opacity = 0.62
        }

        const displayPosLabel = isCommentator ? 'CENTER' : String(displayPos)
        const mergedLabel = `${player.name}|${player.hp}|${displayPosLabel}`
        if (node.labelText !== mergedLabel) {
          scene.remove(node.label)
          const oldMaterial = node.label.material as THREE.SpriteMaterial
          oldMaterial.map?.dispose()
          oldMaterial.dispose()
          node.label = createNameSprite(player.name, player.hp, displayPosLabel)
          node.labelText = mergedLabel
          if (isCommentator) {
            node.label.position.set(0, 4.25, 0)
          } else {
            node.label.position.set(p.x, 3.6 + hop * 0.35, p.z)
          }
          scene.add(node.label)
        }

        if (!isCommentator) {
          const previous = prevPlayerPosRef.current.get(player.player_id)
          if (typeof previous === 'number') {
            const previousCell = Math.floor(wrapPos(previous, liveTrack))
            const currentCell = Math.floor(wrappedPos)
            if (previousCell !== currentCell) {
              const from = trackPoint(previousCell, liveTrack, ringRadius)
              const to = trackPoint(currentCell, liveTrack, ringRadius)
              const mid = from.clone().lerp(to, 0.5)
              mid.y = 1
              spawnBurst(mid, 0x7fe8ff, 1, 0.14)
            }
          }
          prevPlayerPosRef.current.set(player.player_id, wrappedPos)
        } else {
          prevPlayerPosRef.current.delete(player.player_id)
        }

        if (!isCommentator) {
          const visionGeo = buildVision(wrappedPos, player.facing, visionRange, liveTrack, ringRadius + 0.35)
          node.vision.geometry.dispose()
          node.vision.geometry = visionGeo
          node.vision.position.y = 0.96
          node.vision.visible = player.hp > 0
        } else {
          node.vision.visible = false
        }
      }

      for (const removed of existing) {
        const node = playerMap.get(removed)
        if (!node) continue
        scene.remove(node.body)
        scene.remove(node.vision)
        scene.remove(node.label)
        node.body.geometry.dispose()
        node.body.material.dispose()
        node.vision.geometry.dispose()
        const labelMaterial = node.label.material as THREE.SpriteMaterial
        labelMaterial.map?.dispose()
        labelMaterial.dispose()
        playerMap.delete(removed)
        prevPlayerPosRef.current.delete(removed)
      }

      const truck = truckRef.current
      const truckLabelNode = truckLabelRef.current
      if (truck) {
        const tp = trackPoint(live.truck.position, liveTrack, ringRadius)
        truck.position.set(tp.x, 1.85, tp.z)
        truck.scale.setScalar(0.94 + Math.min(0.54, live.truck.speed * 0.05))
        if (truckLabelNode) {
          const displayTruckPos = Math.round(wrapPos(live.truck.position, liveTrack))
          const displayRage = Math.max(1, Math.round(live.truck.speed))
          const labelText = `${displayTruckPos}|${displayRage}`
          if (truckLabelNode.labelText !== labelText) {
            scene.remove(truckLabelNode.sprite)
            const oldMaterial = truckLabelNode.sprite.material as THREE.SpriteMaterial
            oldMaterial.map?.dispose()
            oldMaterial.dispose()
            const next = createTruckSprite(displayTruckPos, displayRage)
            next.position.set(tp.x, 3.95, tp.z)
            scene.add(next)
            truckLabelRef.current = { sprite: next, labelText }
          } else {
            truckLabelNode.sprite.position.set(tp.x, 3.95, tp.z)
          }
        }
        if (now - truckTrailAtRef.current > 260) {
          truckTrailAtRef.current = now
          const back = trackPoint(live.truck.position - live.truck.direction * 0.7, liveTrack, ringRadius)
          back.y = 1.4
          spawnBurst(back, 0xff5ca8, 1, 0.16)
        }
      }

      for (let i = particlesRef.current.length - 1; i >= 0; i -= 1) {
        const particle = particlesRef.current[i]
        particle.life -= 0.016
        particle.mesh.position.add(particle.velocity)
        particle.velocity.y -= 0.002
        particle.mesh.scale.multiplyScalar(0.985)

        const material = particle.mesh.material as THREE.MeshBasicMaterial
        material.opacity = Math.max(0, particle.life / particle.maxLife)

        if (particle.life <= 0) {
          scene.remove(particle.mesh)
          particle.mesh.geometry.dispose()
          material.dispose()
          particlesRef.current.splice(i, 1)
        }
      }

      const camera = cameraRef.current
      if (camera) {
        if (activeScriptedFocus?.enabled) {
          if (activeScriptedFocus.phase === 'commentator') {
            const centerLook = new THREE.Vector3(0, 2.0, 0)
            const centerCam = new THREE.Vector3(
              Math.sin(now * 0.00055 * CAMERA_ORBIT_SPEED_SCALE) * 0.9,
              9.2 + Math.sin(now * 0.0008 * CAMERA_ORBIT_SPEED_SCALE) * 0.25,
              13.8
            )
            camera.position.lerp(centerCam, camEase(0.03))
            camera.lookAt(centerLook.x, centerLook.y, centerLook.z)
          } else if (activeScriptedFocus.phase === 'impact') {
            const truckPos = trackPoint(live.truck.position, liveTrack, ringRadius)
            const truckForward = trackPoint(live.truck.position + live.truck.direction * 1.2, liveTrack, ringRadius)
              .sub(truckPos)
              .normalize()
            const side = new THREE.Vector3(-truckForward.z, 0, truckForward.x)
            const camTarget = truckPos
              .clone()
              .add(truckForward.clone().multiplyScalar(-11.8))
              .add(side.multiplyScalar(2.6))
              .add(new THREE.Vector3(0, 6.2, 0))
            const impactKey = `${activeScriptedFocus.token ?? activeScriptedFocus.agentId}-impact`
            if (!scriptedCamRef.current || scriptedCamRef.current.key !== impactKey) {
              scriptedCamRef.current = {
                key: impactKey,
                lookAt: new THREE.Vector3(
                  truckPos.x + truckForward.x * 2.2,
                  truckPos.y + 1.1,
                  truckPos.z + truckForward.z * 2.2
                ),
                basePos: camTarget.clone(),
                pulledIn: false
              }
            }
            const lock = scriptedCamRef.current
            const desiredLookAt = new THREE.Vector3(
              truckPos.x + truckForward.x * 2.2,
              truckPos.y + 1.1,
              truckPos.z + truckForward.z * 2.2
            )
            const desiredBase = camTarget.clone()
            if (!lock.pulledIn) {
              // Pull-in once on impact entry, then switch to idle camera to avoid repeated jerky pushes.
              lock.lookAt.lerp(desiredLookAt, camEase(0.075))
              lock.basePos.lerp(desiredBase, camEase(0.07))
              const toTarget = lock.basePos.clone().sub(camera.position).length()
              camera.position.lerp(lock.basePos, camEase(0.04))
              camera.lookAt(lock.lookAt.x, lock.lookAt.y, lock.lookAt.z)
              if (toTarget < 0.3) {
                lock.pulledIn = true
              }
            } else {
              lock.lookAt.lerp(desiredLookAt, camEase(0.02))
              lock.basePos.lerp(desiredBase, camEase(0.018))
              const idleBob = new THREE.Vector3(
                Math.sin(now * 0.00085 * CAMERA_ORBIT_SPEED_SCALE) * 0.016,
                Math.sin(now * 0.0011 * CAMERA_ORBIT_SPEED_SCALE) * 0.011,
                Math.cos(now * 0.00085 * CAMERA_ORBIT_SPEED_SCALE) * 0.01
              )
              const target = lock.basePos.clone().add(idleBob)
              camera.position.lerp(target, camEase(0.006))
              camera.lookAt(lock.lookAt.x, lock.lookAt.y, lock.lookAt.z)
            }
          } else if (activeScriptedFocus.agentId) {
            const focusPlayer = live.players.find((p) => p.player_id === activeScriptedFocus.agentId)
            if (focusPlayer) {
            const pos = trackPoint(focusPlayer.position, liveTrack, ringRadius)
            const ahead = trackPoint(
              focusPlayer.position + (focusPlayer.facing >= 0 ? 1 : -1) * 1.2,
              liveTrack,
              ringRadius
            )
            const tangent = ahead.clone().sub(pos).normalize()
            const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize()
            const camTarget = pos
              .clone()
              .add(tangent.clone().multiplyScalar(-9.2))
              .add(side.clone().multiplyScalar(2.1))
              .add(new THREE.Vector3(0, 5.4, 0))
            const key = activeScriptedFocus.token ?? activeScriptedFocus.agentId
            if (!scriptedCamRef.current || scriptedCamRef.current.key !== key) {
              scriptedCamRef.current = {
                key,
                lookAt: new THREE.Vector3(pos.x + side.x * 0.35, 1.15, pos.z + side.z * 0.35),
                basePos: camTarget.clone(),
                pulledIn: false
              }
            }
            const lock = scriptedCamRef.current
            const desiredLookAt = new THREE.Vector3(pos.x + side.x * 0.35, 1.15, pos.z + side.z * 0.35)
            const desiredBase = camTarget.clone()
            if (!lock.pulledIn) {
              // One pull-in per action token, then remain in idle tracking.
              lock.lookAt.lerp(desiredLookAt, camEase(0.07))
              lock.basePos.lerp(desiredBase, camEase(0.07))
              const toTarget = lock.basePos.clone().sub(camera.position).length()
              camera.position.lerp(lock.basePos, camEase(0.04))
              camera.lookAt(lock.lookAt.x, lock.lookAt.y, lock.lookAt.z)
              if (toTarget < 0.25) {
                lock.pulledIn = true
              }
            } else {
              lock.lookAt.lerp(desiredLookAt, camEase(0.035))
              lock.basePos.lerp(desiredBase, camEase(0.03))
              const idleBob = new THREE.Vector3(
                Math.sin(now * 0.0010 * CAMERA_ORBIT_SPEED_SCALE) * 0.012,
                Math.sin(now * 0.0014 * CAMERA_ORBIT_SPEED_SCALE) * 0.008,
                Math.cos(now * 0.0010 * CAMERA_ORBIT_SPEED_SCALE) * 0.008
              )
              const target = lock.basePos.clone().add(idleBob)
              camera.position.lerp(target, camEase(0.006))
              camera.lookAt(lock.lookAt.x, lock.lookAt.y, lock.lookAt.z)
            }
            }
          } else {
            const fallback = new THREE.Vector3(0, 24, 28)
            camera.position.lerp(fallback, camEase(0.02))
            camera.lookAt(0, 1.1, 0)
          }
        } else {
        scriptedCamRef.current = null
        const focusPlayerId = director.focusIds.length > 0 ? director.focusIds[director.focusIndex % director.focusIds.length] : null
        const focusPlayer = focusPlayerId ? live.players.find((p) => p.player_id === focusPlayerId) : null

        if (director.phase === 'overview' || director.phase === 'vote') {
          const orbit = now * 0.00012 * CAMERA_ORBIT_SPEED_SCALE + (wrapPos(live.truck.position, liveTrack) / liveTrack) * TAU * 0.18
          const radius = 42 + Math.sin(now * 0.0008 * CAMERA_ORBIT_SPEED_SCALE) * 2
          const target = new THREE.Vector3(Math.cos(orbit) * radius, 33, Math.sin(orbit) * radius)
          camera.position.lerp(target, camEase(0.018))
          camera.lookAt(0, 0.9, 0)

          const title = phaseTitle(director.phase)
          const msg = director.phase === 'vote' ? '在鸟瞰图中展示所有人投票与站位' : `地图规模巨大，先总览局势`
          announce({ name: '全局鸟瞰', message: msg, phase: director.phase, title })
        } else if (director.phase === 'truck' && truck) {
          const truckPos = truck.position.clone()
          const truckForward = trackPoint(live.truck.position + live.truck.direction * 1.2, liveTrack, ringRadius)
            .sub(trackPoint(live.truck.position, liveTrack, ringRadius))
            .normalize()
          const camTarget = truckPos.clone().add(truckForward.clone().multiplyScalar(-7.2)).add(new THREE.Vector3(0, 4.8, 0))
          camera.position.lerp(camTarget, camEase(0.02))
          camera.lookAt(truckPos.x, truckPos.y + 0.6, truckPos.z)
          announce({ name: '大运重卡', message: '横冲直撞中...', phase: 'truck', title: phaseTitle('truck') })
        } else if (focusPlayer) {
          if (now - director.focusStart > AUTO_FOCUS_HOLD_MS) {
            director.focusIndex += 1
            director.focusStart = now
          }
          const pos = trackPoint(focusPlayer.position, liveTrack, ringRadius)
          const ahead = trackPoint(
            focusPlayer.position + (focusPlayer.facing >= 0 ? 1 : -1) * 1.3,
            liveTrack,
            ringRadius
          )
          const tangent = ahead.clone().sub(pos).normalize()
          const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize()
          const camTarget = pos
            .clone()
            .add(tangent.clone().multiplyScalar(-8.1))
            .add(side.clone().multiplyScalar(1.8))
            .add(new THREE.Vector3(0, 5.0, 0))
          camera.position.lerp(camTarget, camEase(0.02))
          camera.lookAt(pos.x + side.x * 0.3, 1.2, pos.z + side.z * 0.3)

          if (director.phase === 'rollcall') {
            announce({
              name: focusPlayer.name,
              message: `编号 ${focusPlayer.player_id}，当前位置 ${wrapPos(focusPlayer.position, liveTrack)} 号格`,
              phase: 'rollcall',
              title: phaseTitle('rollcall')
            })
          } else if (director.phase === 'discussion') {
            announce({
              name: focusPlayer.name,
              message: focusPlayer.message || '正在观察局势...',
              phase: 'discussion',
              title: phaseTitle('discussion')
            })
          } else {
            announce({
              name: focusPlayer.name,
              message: '一步一个脚印移动中',
              phase: 'move',
              title: phaseTitle('move')
            })
          }
        }
        }
      }

      if (truck && camera) {
        for (const node of playerNodesRef.current.values()) {
          node.body.quaternion.copy(camera.quaternion)
        }
        // Billboard: keep truck sprite always perpendicular to screen.
        truck.quaternion.copy(camera.quaternion)
        const truckLabelNode = truckLabelRef.current
        if (truckLabelNode) {
          truckLabelNode.sprite.quaternion.copy(camera.quaternion)
        }
      }

      renderer.render(scene, camera)
      animationRef.current = requestAnimationFrame(animate)
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      resizeObserver.disconnect()
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)

      for (const node of playerNodesRef.current.values()) {
        node.body.geometry.dispose()
        node.body.material.dispose()
        node.vision.geometry.dispose()
        const labelMaterial = node.label.material as THREE.SpriteMaterial
        labelMaterial.map?.dispose()
        labelMaterial.dispose()
      }
      playerNodesRef.current.clear()

      clearTrackCells()
      clearTrackNumberNodes()
      prevTrackRef.current = 0
      prevPlayerPosRef.current.clear()

      for (const particle of particlesRef.current) {
        scene.remove(particle.mesh)
        particle.mesh.geometry.dispose()
        ;(particle.mesh.material as THREE.MeshBasicMaterial).dispose()
      }
      particlesRef.current = []

      if (truckRef.current) {
        truckRef.current.geometry.dispose()
        const material = truckRef.current.material
        if (Array.isArray(material)) material.forEach((m) => m.dispose())
        else material.dispose()
      }
      if (truckLabelRef.current) {
        scene.remove(truckLabelRef.current.sprite)
        const material = truckLabelRef.current.sprite.material as THREE.SpriteMaterial
        material.map?.dispose()
        material.dispose()
        truckLabelRef.current = null
      }
      if (plannedPathLineRef.current) {
        scene.remove(plannedPathLineRef.current)
        plannedPathLineRef.current.geometry.dispose()
        ;(plannedPathLineRef.current.material as THREE.Material).dispose()
        plannedPathLineRef.current = null
      }
      if (plannedPathMarkersRef.current) {
        for (const child of plannedPathMarkersRef.current.children) {
          const marker = child as THREE.Mesh
          marker.geometry.dispose()
          ;(marker.material as THREE.Material).dispose()
        }
        scene.remove(plannedPathMarkersRef.current)
        plannedPathMarkersRef.current.clear()
        plannedPathMarkersRef.current = null
      }
      if (plannedPathHeadRef.current) {
        scene.remove(plannedPathHeadRef.current)
        plannedPathHeadRef.current.geometry.dispose()
        ;(plannedPathHeadRef.current.material as THREE.Material).dispose()
        plannedPathHeadRef.current = null
      }
      truckTexture.dispose()
      for (const texture of avatarTextureCache.values()) {
        texture.dispose()
      }
      avatarTextureCache.clear()

      renderer.dispose()
      host.removeChild(renderer.domElement)
      scene.clear()
      onFocusChange?.(null)
    }
  }, [onFocusChange, ringRadius, visionRange])

  return <div ref={hostRef} className="track-3d" />
}
