import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, QuadraticBezierLine } from '@react-three/drei';
import { AdditiveBlending, MathUtils, Quaternion, Vector3, type Group, type MeshBasicMaterial } from 'three';
import type { GameEvent, ObjectId, PlayerId, PlayerView } from '@mtg3d/engine';
import { displayName } from '@mtg3d/cards';
import { cardImage } from '../net';
import { CardImage } from '../CardImage';
import { CARD_H, CARD_W, layoutTable, libraryPos, type Placement } from './layout';
import { BADGE_ASPECT, MAT_D, MAT_W, backTexture, badgeTexture, cardTexture, matTexture, onTextureLoaded, roundedCorners, woodTexture } from './textures';

const HIGHLIGHT_COLORS = { playable: '#f0c060', selected: '#7fe08f', attacking: '#ff6a45', blocking: '#5fb0f0' } as const; // styles.css tokens, brightened to glow

/** Your seat: a little above and behind your side of the table, looking at the middle. */
const SEAT = new Vector3(0, 15.5, 19.5);
const LOOK = new Vector3(0, 0, 1.6);

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const now = () => performance.now() / 1000;

interface Props {
  view: PlayerView;
  events: GameEvent[];
  usable: ReadonlySet<ObjectId>;
  selected: ReadonlySet<ObjectId>;
  onCardClick: (id: ObjectId) => void;
  names: Record<PlayerId, string>;
}

export function Table3D({ view, events, usable, selected, onCardClick, names }: Props) {
  const placements = layoutTable(view, usable, selected);
  const [hover, setHover] = useState<Placement | null>(null);
  const [pinned, setPinned] = useState<Placement | null>(null);
  const controls = useRef<{ reset: () => void } | null>(null);
  const shown = hover ?? (pinned && placements.find((p) => p.key === pinned.key)) ?? null;
  const me = view.viewer;
  const opp: PlayerId = me === 'p1' ? 'p2' : 'p1';

  // Last drawn position of every card, so a card that changes zone (and gets a new id, 400.7) flies from where it was.
  const positions = useRef(new Map<string, Vector3>());
  const movedFrom = new Map(events.flatMap((e) => (e.kind === 'zoneChange' ? [[e.to, e.from] as const] : [])));
  useLayoutEffect(() => { // pruned after the cards that replaced moved ones have read their old positions
    const live = new Set(placements.map((p) => p.key));
    for (const k of positions.current.keys()) if (!live.has(k)) positions.current.delete(k);
  });
  /** Where a new card appears: where it was before its zone change, or (a drawn card) on top of its library, face down. */
  const spawnOf = (p: Placement): { at: Vector3; faceDown: boolean } => {
    const from = movedFrom.get(p.key);
    const prev = from === undefined ? undefined : positions.current.get(from);
    if (prev) return { at: prev.clone(), faceDown: false };
    const lib = libraryPos(p.owner, me);
    return { at: new Vector3(lib.x, 0.6, lib.z), faceDown: true };
  };
  // Damage shakes the card that takes it.
  const hits = useMemo(() => {
    const t = now();
    return new Map(events.flatMap((e) => (e.kind === 'damage' && e.target.kind === 'object' ? [[e.target.id, t] as const] : [])));
  }, [events]);

  return (
    <div className="table3d">
      {/* Renders on demand: only while something moves, glows or loads, so a quiet table costs nothing. */}
      <Canvas frameloop="demand" shadows dpr={[1, 1.75]} camera={{ fov: 42, near: 0.5, far: 200, position: SEAT.toArray() }} gl={{ antialias: true }}>
        <color attach="background" args={['#0b1512']} />
        <fog attach="fog" args={['#0b1512', 46, 95]} />
        <FitSeat />
        <Redraw />
        <OrbitControls ref={controls as RefObject<never>} target={LOOK} enablePan={false} enableDamping dampingFactor={0.08}
          minDistance={11} maxDistance={62} minPolarAngle={0.25} maxPolarAngle={1.12} minAzimuthAngle={-0.7} maxAzimuthAngle={0.7} />
        <Room />
        <Mat side={1} name={names[me]} tint="#1f4a40" />
        <Mat side={-1} name={names[opp]} tint="#2a3f55" />
        {placements.map((p) => (
          <Card3D key={p.key} p={p} spawn={spawnOf} positions={positions.current} hitAt={hits.get(p.key)}
            clickable={usable.has(p.key) || selected.has(p.key)}
            onHover={(on) => { setHover(on && p.card ? p : null); }}
            onPick={() => {
              if (!p.card) return;
              // A card you can use (or have chosen) acts; any other card pins its preview.
              if (usable.has(p.key) || selected.has(p.key)) onCardClick(p.key); else setPinned(pinned?.key === p.key ? null : p);
            }} />
        ))}
        <Arrows view={view} positions={positions.current} />
      </Canvas>
      <div className="hud-cameras">
        <button onClick={() => { controls.current?.reset(); }} title="Volver a tu asiento">Recentrar</button>
      </div>
      {shown?.card && (
        <aside className="hud-preview" aria-live="polite">
          <CardImage name={displayName(shown.card)} src={cardImage(shown.card)} key={shown.card} />
          <p><b>{displayName(shown.card)}</b>{shown.badges.length > 0 && <> · {shown.badges.join(' · ')}</>}</p>
        </aside>
      )}
    </div>
  );
}

/** Redraws once whenever a card image finishes loading. */
function Redraw() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => onTextureLoaded(() => { invalidate(); }), [invalidate]);
  return null;
}

/** Places the seat for the canvas shape, so the whole table fits on any screen. */
function FitSeat() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useLayoutEffect(() => {
    // On wide screens the right-hand panel covers part of the canvas: center the table in what stays visible.
    const pad = typeof matchMedia === 'function' && matchMedia('(min-width: 1000px)').matches ? 392 : 0;
    const aspect = (size.width - pad) / Math.max(1, size.height);
    // Back the seat off until the whole width of the table fits (the vertical field of view is fixed).
    camera.position.copy(SEAT).sub(LOOK).multiplyScalar(MathUtils.clamp(1.85 / aspect, 1, 1.8)).add(LOOK);
    if ('setViewOffset' in camera) {
      if (pad > 0) camera.setViewOffset(size.width + pad, size.height, pad, 0, size.width, size.height); else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    }
  }, [camera, size.width, size.height]);
  return null;
}

/** The table, the lamp above it, and the dark room around. */
function Room() {
  const wood = woodTexture();
  return (
    <>
      <hemisphereLight args={['#ffe9c4', '#20140c', 0.55]} />
      <directionalLight position={[7, 22, 10]} intensity={2.1} color="#fff1d6" castShadow
        shadow-mapSize={[1536, 1536]} shadow-bias={-0.0004} shadow-normalBias={0.02}
        shadow-camera-left={-20} shadow-camera-right={20} shadow-camera-top={16} shadow-camera-bottom={-16} shadow-camera-near={1} shadow-camera-far={60} />
      <pointLight position={[0, 9, 2]} intensity={60} distance={30} decay={1.6} color="#ffc98a" />
      <mesh position={[0, -0.55, 0]} receiveShadow>
        <boxGeometry args={[42, 1, 32]} />
        <meshStandardMaterial map={wood} roughness={0.62} metalness={0.05} />
      </mesh>
    </>
  );
}

/** A felt playmat with its zones printed; the opponent's is turned to face them. */
function Mat({ side, name, tint }: { side: 1 | -1; name: string; tint: string }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, side === 1 ? 0 : Math.PI]} position={[0, 0.004, side * 4.8]} receiveShadow>
      <planeGeometry args={[MAT_W, MAT_D]} />
      <meshStandardMaterial map={matTexture(name, tint)} roughness={0.95} />
    </mesh>
  );
}

const yAxis = new Vector3(0, 1, 0);
const xAxis = new Vector3(1, 0, 0);
const zAxis = new Vector3(0, 0, 1);
/** yaw about the table normal, then tilt towards the viewer, then roll in the card's own plane (a fanned hand). */
function orientation(p: Placement, faceDown = false): Quaternion {
  const q = new Quaternion().setFromAxisAngle(yAxis, p.yaw)
    .multiply(new Quaternion().setFromAxisAngle(xAxis, p.tilt))
    .multiply(new Quaternion().setFromAxisAngle(yAxis, p.roll ?? 0));
  if (faceDown) q.multiply(new Quaternion().setFromAxisAngle(zAxis, Math.PI));
  return q;
}

interface Tween { from: Vector3; to: Vector3; qFrom: Quaternion; qTo: Quaternion; t0: number; dur: number; arc: number }

function Card3D({ p, spawn, positions, hitAt, clickable, onHover, onPick }: {
  p: Placement; spawn: (p: Placement) => { at: Vector3; faceDown: boolean }; positions: Map<string, Vector3>; hitAt: number | undefined;
  clickable: boolean; onHover: (on: boolean) => void; onPick: () => void;
}) {
  const ref = useRef<Group>(null);
  const glow = useRef<MeshBasicMaterial>(null);
  const [hovered, setHovered] = useState(false);
  const tween = useRef<Tween | null>(null);
  const base = useRef(new Vector3()); // where the tween puts it, before hover lift and shake
  const lift = useRef(0);
  const front = p.card ? cardTexture(p.card) : backTexture();
  const alpha = roundedCorners();
  const { x, y, z, yaw, tilt, roll } = p;

  // A new target: glide there along an arc (higher for longer trips), turning on the way.
  useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return;
    const place = p; // this render's placement: the effect runs only when its position or turn changed
    const to = new Vector3(x, y, z);
    if (!tween.current) { // first appearance
      const s = spawn(place);
      base.current.copy(s.at);
      g.position.copy(s.at);
      g.quaternion.copy(orientation(place, s.faceDown));
      positions.set(p.key, g.position);
    }
    const dist = base.current.distanceTo(to);
    tween.current = {
      from: base.current.clone(), to, qFrom: g.quaternion.clone(), qTo: orientation(place), t0: now(),
      dur: reducedMotion ? 0 : MathUtils.clamp(0.28 + dist * 0.035, 0.3, 0.85), arc: Math.min(2.2, dist * 0.18),
    };
  }, [x, y, z, yaw, tilt, roll]); // only a change of place starts a new glide

  useFrame(({ invalidate }) => {
    const g = ref.current;
    const tw = tween.current;
    if (!g || !tw) return;
    const t = tw.dur === 0 ? 1 : MathUtils.clamp((now() - tw.t0) / tw.dur, 0, 1);
    const e = easeInOut(t);
    base.current.lerpVectors(tw.from, tw.to, e);
    base.current.y += tw.arc * Math.sin(Math.PI * t);
    g.quaternion.slerpQuaternions(tw.qFrom, tw.qTo, e);
    g.position.copy(base.current);
    // Hover: a held card rises out of the fan towards you; a card on the table lifts a little.
    const k = reducedMotion ? 1 : 0.2;
    lift.current = MathUtils.lerp(lift.current, hovered && t === 1 ? 1 : 0, k);
    g.scale.setScalar(p.inHand ? 1.3 + lift.current * 0.35 : 1 + lift.current * 0.06); // held cards are nearer to you, so bigger
    g.position.y += lift.current * (p.inHand ? 1.6 : 0.25);
    if (p.inHand) g.position.z -= lift.current * 1.4;
    // Damage: a short shake.
    if (hitAt !== undefined && !reducedMotion) {
      const age = now() - hitAt;
      if (age < 0.5) g.position.x += Math.sin(age * 60) * 0.12 * (1 - age / 0.5);
    }
    if (glow.current) glow.current.opacity = 0.8;
    const shaking = hitAt !== undefined && now() - hitAt < 0.5;
    const settling = Math.abs(lift.current - (hovered ? 1 : 0)) > 0.002;
    if (t < 1 || settling || shaking) invalidate(); // keep drawing while this card moves
  });

  const color = p.highlight ? HIGHLIGHT_COLORS[p.highlight] : null;
  return (
    <group ref={ref}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); onHover(true); if (clickable) document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHovered(false); onHover(false); document.body.style.cursor = ''; }}
      onClick={(e) => { e.stopPropagation(); onPick(); }}>
      {color && (
        <mesh rotation-x={-Math.PI / 2} position-y={-0.002}>
          <planeGeometry args={[CARD_W + 0.34, CARD_H + 0.34]} />
          <meshBasicMaterial ref={glow} color={color} alphaMap={alpha} transparent blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      {/* The card's body: a thin slab that casts the shadow; faces sit on both sides of it. */}
      <mesh castShadow>
        <boxGeometry args={[CARD_W - 0.08, 0.018, CARD_H - 0.08]} />
        <meshStandardMaterial color="#14110e" roughness={0.6} />
      </mesh>
      {/* Unlit material: Scryfall images are shown as published, with no shading or color shift. */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.0095}>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshBasicMaterial map={front} alphaMap={alpha} alphaTest={0.5} toneMapped={false} />
      </mesh>
      <mesh rotation-x={Math.PI / 2} position-y={-0.0095}>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshBasicMaterial map={backTexture()} alphaMap={alpha} alphaTest={0.5} toneMapped={false} />
      </mesh>
      {/* Badges turn back against the card's yaw so they read upright from the viewer's seat. */}
      {p.badges.map((b, i) => (
        <mesh key={b} rotation={[-Math.PI / 2, 0, -p.yaw]} position={[CARD_W / 2 - 0.6, 0.014, CARD_H / 2 - 0.3 - i * 0.55]}>
          <planeGeometry args={[0.5 * BADGE_ASPECT, 0.5]} />
          <meshBasicMaterial map={badgeTexture(b)} transparent toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Arrows from each spell or ability on the stack to its targets, and from each blocker to the attacker it blocks. */
function Arrows({ view, positions }: { view: PlayerView; positions: Map<string, Vector3> }) {
  const seat = (p: PlayerId) => new Vector3(0, 0.6, p === view.viewer ? 11 : -11);
  const arrows: { key: string; from: () => Vector3 | undefined; to: () => Vector3 | undefined; color: string }[] = [];
  for (const e of view.stack) {
    e.targets.forEach((t, i) => {
      arrows.push({
        key: `${e.id}-${String(i)}`, from: () => positions.get(e.id), to: () => (t.kind === 'player' ? seat(t.player) : positions.get(t.id)),
        color: e.controller === view.viewer ? HIGHLIGHT_COLORS.playable : HIGHLIGHT_COLORS.attacking,
      });
    });
  }
  for (const b of view.combat?.blocks ?? []) arrows.push({ key: `block-${b.blocker}`, from: () => positions.get(b.blocker), to: () => positions.get(b.attacker), color: HIGHLIGHT_COLORS.blocking });
  return <>{arrows.map((a) => <Arrow key={a.key} from={a.from} to={a.to} color={a.color} />)}</>;
}

const mid = new Vector3();
function Arrow({ from, to, color }: { from: () => Vector3 | undefined; to: () => Vector3 | undefined; color: string }) {
  const line = useRef<{ setPoints: (a: Vector3, b: Vector3, m: Vector3) => void } | null>(null);
  useFrame(() => {
    const a = from();
    const b = to();
    if (!a || !b || !line.current) return;
    mid.addVectors(a, b).multiplyScalar(0.5);
    mid.y += 2 + a.distanceTo(b) * 0.15;
    line.current.setPoints(a, b, mid);
  });
  return <QuadraticBezierLine ref={line as RefObject<never>} start={[0, 0, 0]} end={[0, 0, 0]} color={color} lineWidth={4} dashed dashScale={3} transparent opacity={0.9} />;
}
