import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Environment, Html, Lightformer, OrbitControls, QuadraticBezierLine } from '@react-three/drei';
import { AdditiveBlending, ExtrudeGeometry, MathUtils, Plane, Quaternion, Shape, SphereGeometry, Vector3, type Group, type Mesh, type MeshBasicMaterial } from 'three';
import type { GameEvent, ObjectId, PlayerId, PlayerView } from '@mtg3d/engine';
import { displayName } from '@mtg3d/cards';
import { cardImage } from '../net';
import { CardImage } from '../CardImage';
import type { CardMenu } from '../Game';
import { CARD_H, CARD_W, STACK_H, layoutTable, libraryPos, piles, type Placement } from './layout';
import { BADGE_ASPECT, MAT_D, MAT_W, backTexture, badgeTexture, cardTexture, matTexture, onTextureLoaded, roundedCorners, runeTexture, woodTexture } from './textures';

/** Each player's cards are in coloured sleeves, as at a real table. */
const SLEEVES = { me: '#7a2a2c', them: '#284a72' } as const;
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
  /** What clicking a card does ("Lanzar · o arrástrala a la mesa"), shown by the card you point at. */
  hints?: ReadonlyMap<ObjectId, string>;
  /** Several things a card can do, floating by it. */
  menu?: CardMenu | null;
  /** A card let go after dragging: over another card (`target`) or over the table at depth `z`. */
  onCardDrop?: (id: ObjectId, target: ObjectId | null, z: number) => void;
  /** While declaring attackers or blockers, your creatures can be dragged too. */
  combatDrag?: boolean;
}

export function Table3D({ view, events, usable, selected, onCardClick, names, hints, menu, onCardDrop, combatDrag = false }: Props) {
  const [hover, setHover] = useState<Placement | null>(null);
  const placements = layoutTable(view, usable, selected, hover?.inHand ? hover.key : null);
  const [pinned, setPinned] = useState<Placement | null>(null);
  const controls = useRef<{ reset: () => void; enabled: boolean } | null>(null);
  const shown = hover ?? (pinned && placements.find((p) => p.key === pinned.key)) ?? null;
  const me = view.viewer;
  const opp: PlayerId = me === 'p1' ? 'p2' : 'p1';

  // Last drawn position of every card, so a card that changes zone (and gets a new id, 400.7) flies from where it was.
  // Never pruned here: the 3D scene commits after this component, so a pruned entry would be gone before the new card reads it.
  // shortcut: grows by one small vector per card that ever appeared (a few thousand in a long game); prune by age if that matters.
  const positions = useRef(new Map<string, Vector3>());
  const movedFrom = new Map(events.flatMap((e) => (e.kind === 'zoneChange' ? [[e.to, e.from] as const] : [])));
  const fromHand = new Set(events.flatMap((e) => (e.kind === 'zoneChange' && e.fromZone === 'hand' ? [e.to] : [])));
  /** Where a new card appears: where it was before its zone change, or (a drawn card) on top of its library, face down. */
  const spawnOf = (p: Placement): { at: Vector3; faceDown: boolean } => {
    const from = movedFrom.get(p.key);
    const prev = from === undefined ? undefined : positions.current.get(from);
    if (prev) return { at: prev.clone(), faceDown: false };
    // A card the opponent plays leaves their hand (the slot that just went away) face down, and turns over on its way.
    const slot = fromHand.has(p.key) ? positions.current.get(`hand-${p.owner}-${String(view.players[p.owner].handSize)}`) : undefined;
    if (slot) return { at: slot.clone(), faceDown: true };
    const lib = libraryPos(p.owner, me);
    return { at: new Vector3(lib.x, view.players[p.owner].librarySize * STACK_H + 0.05, lib.z), faceDown: true };
  };
  // Damage shakes the card that takes it.
  const hits = useMemo(() => {
    const t = now();
    return new Map(events.flatMap((e) => (e.kind === 'damage' && e.target.kind === 'object' ? [[e.target.id, t] as const] : [])));
  }, [events]);
  // A creature dealing combat damage lunges at the other side of the table.
  const lunges = useMemo(() => {
    const t = now();
    return new Map(events.flatMap((e) => (e.kind === 'damage' && e.combat ? [[e.source, t] as const] : [])));
  }, [events]);

  return (
    <div className="table3d">
      {/* Renders on demand: only while something moves, glows or loads, so a quiet table costs nothing. */}
      <Canvas frameloop="demand" shadows dpr={[1, 1.75]} camera={{ fov: 42, near: 0.5, far: 200, position: SEAT.toArray() }} gl={{ antialias: true }}>
        <color attach="background" args={['#070b0a']} />
        <fog attach="fog" args={['#070b0a', 40, 80]} />
        <FitSeat />
        <Redraw />
        <OrbitControls ref={controls as RefObject<never>} target={LOOK} enablePan={false} enableDamping dampingFactor={0.08}
          minDistance={11} maxDistance={62} minPolarAngle={0.25} maxPolarAngle={1.12} minAzimuthAngle={-0.7} maxAzimuthAngle={0.7} />
        <Room />
        <Mat side={1} name={names[me]} tint="#1f4a40" />
        <Mat side={-1} name={names[opp]} tint="#2a3f55" />
        {piles(view).map((pl) => <Pile key={pl.key} x={pl.x} z={pl.z} h={pl.h} sleeve={pl.owner === me ? SLEEVES.me : SLEEVES.them} />)}
        {placements.map((p) => (
          <Card3D key={p.key} p={p} sleeve={p.owner === me ? SLEEVES.me : SLEEVES.them} spawn={spawnOf} positions={positions.current} hitAt={hits.get(p.key)} lungeAt={lunges.get(p.key)}
            clickable={usable.has(p.key) || selected.has(p.key)}
            draggable={p.inHand === true || (combatDrag && p.owner === me && (usable.has(p.key) || selected.has(p.key)))}
            onDrop={(at) => {
              // The card it was let go over, if any: the nearest other card on the table within a card's reach.
              let target: string | null = null;
              let best = 1.6;
              for (const q of placements) {
                if (q.key === p.key || q.inHand || !q.card) continue;
                const d = Math.hypot(q.x - at.x, q.z - at.z);
                if (d < best) { best = d; target = q.key; }
              }
              onCardDrop?.(p.key, target, at.z);
            }}
            onDrag={(on) => { if (controls.current) controls.current.enabled = !on; }}
            onHover={(on) => { setHover(on && p.card ? p : null); }}
            onPick={() => {
              if (!p.card) return;
              // A card you can use (or have chosen) acts; any other card pins its preview.
              if (usable.has(p.key) || selected.has(p.key)) onCardClick(p.key); else setPinned(pinned?.key === p.key ? null : p);
            }} />
        ))}
        {hover && hints?.get(hover.key) && !menu && (
          <Html position={[hover.x, hover.inHand ? hover.y + 5.4 : hover.y + 0.4, hover.inHand ? hover.z + 1.2 : hover.z - Math.sign(hover.z || 1) * (CARD_H / 2 + 0.2)]}
            center zIndexRange={[20, 10]} className="card-hint" style={{ pointerEvents: 'none' }}>
            {hints.get(hover.key)}
          </Html>
        )}
        {menu && (() => {
          const at = placements.find((q) => q.key === menu.id);
          return at && (
            <Html position={[at.x, at.inHand ? at.y + 5.6 : at.y + 0.5, at.inHand ? at.z + 1.2 : at.z]} center zIndexRange={[30, 20]}>
              <div className="card-menu" role="menu" aria-label={`Qué hacer con ${displayName(at.card ?? '')}`}>
                {menu.items.map((it) => <button key={it.label} role="menuitem" onClick={it.run}>{it.label}</button>)}
                <button className="link" onClick={menu.onClose}>Cancelar</button>
              </div>
            </Html>
          );
        })()}
        {view.stack.length > 0 && <SpellCircle />}
        <Arrows view={view} positions={positions.current} />
      </Canvas>
      <div className="hud-cameras">
        <button onClick={() => { controls.current?.reset(); }} title="Volver a tu asiento">Recentrar</button>
      </div>
      {shown?.card && (
        <aside className="hud-preview" aria-live="polite" key={shown.card}>
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
      <hemisphereLight args={['#ffe9c4', '#1a110a', 0.32]} />
      {/* The lamp above the table: a warm pool of light that fades out towards the room. */}
      <spotLight position={[2, 30, 7]} angle={0.66} penumbra={0.9} intensity={3.4} decay={0} color="#ffeccc" castShadow
        shadow-mapSize={[2048, 2048]} shadow-bias={-0.0003} shadow-normalBias={0.02} shadow-camera-near={10} shadow-camera-far={50} />
      <pointLight position={[0, 7, 4]} intensity={28} distance={26} decay={1.6} color="#ffbe7a" />
      {/* Soft reflections on the sleeves and the varnish, from a lamp and a window; no image is downloaded. */}
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={2.2} color="#ffe2b0" position={[0, 14, 2]} rotation-x={Math.PI / 2} scale={[16, 10, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#a8c4ff" position={[-18, 8, -10]} rotation-y={Math.PI / 3} scale={[6, 10, 1]} />
      </Environment>
      <mesh position={[0, -0.55, 0]} receiveShadow>
        <boxGeometry args={[64, 1, 44]} />
        <meshStandardMaterial map={wood} map-repeat={[1.6, 1.1]} roughness={0.42} metalness={0.02} envMapIntensity={0.5} />
      </mesh>
    </>
  );
}

/** A felt playmat with its zones printed; the opponent's is turned to face them. */
function Mat({ side, name, tint }: { side: 1 | -1; name: string; tint: string }) {
  return (
    <group position={[0, 0, side * 4.8]}>
      {/* A rubber-backed mat a few millimetres thick. */}
      <mesh position-y={-0.02} receiveShadow castShadow>
        <boxGeometry args={[MAT_W + 0.06, 0.05, MAT_D + 0.06]} />
        <meshStandardMaterial color="#0d0f0e" roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, side === 1 ? 0 : Math.PI]} position-y={0.006} receiveShadow>
        <planeGeometry args={[MAT_W, MAT_D]} />
        <meshStandardMaterial map={matTexture(name, tint)} roughness={0.97} envMapIntensity={0.15} />
      </mesh>
    </group>
  );
}

/** While spells wait on the stack, a slow glowing circle turns on the felt beneath them, and lights the table. */
function SpellCircle() {
  const disc = useRef<Mesh>(null);
  const born = useRef(now());
  useFrame(({ invalidate }) => {
    const m = disc.current;
    if (!m) return;
    const age = now() - born.current;
    m.rotation.z = reducedMotion ? 0 : age * 0.35;
    const k = Math.min(1, age / 0.4); // grows in
    m.scale.setScalar(0.6 + 0.4 * k);
    (m.material as MeshBasicMaterial).opacity = k * (0.7 + 0.15 * Math.sin(age * 3));
    if (!reducedMotion) invalidate(); // turning: draws continuously, but only while the stack is not empty
  });
  return (
    <group position={[0, 0.03, 0.4]}>
      <mesh ref={disc} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[7, 7]} />
        <meshBasicMaterial map={runeTexture()} transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight position={[0, 0.7, 0]} intensity={7} distance={7} decay={1.4} color="#ffb85c" /> {/* low, so it lights the felt and not the face of the card */}
    </group>
  );
}

/** A deck or a graveyard: the sleeves of the cards under the top one, stacked. */
function Pile({ x, z, h, sleeve }: { x: number; z: number; h: number; sleeve: string }) {
  return (
    <mesh geometry={sleeveGeometry} position={[x, h / 2 - 0.004, z]} scale={[1, h / SLEEVE_T, 1]} castShadow receiveShadow>
      <meshStandardMaterial color={sleeve} roughness={0.5} envMapIntensity={0.7} />
    </mesh>
  );
}

const beadGeometry = new SphereGeometry(0.13, 16, 10).scale(1, 0.55, 1);

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

interface Tween { from: Vector3; to: Vector3; qFrom: Quaternion; qTo: Quaternion; t0: number; dur: number; arc: number; lands: boolean }

const SLEEVE_T = 0.026;
/** One shared sleeve: a rounded slab a little larger than the card, with the card's faces on both sides. */
const sleeveGeometry = (() => {
  const w = CARD_W + 0.06, h = CARD_H + 0.06, r = 0.13;
  const s = new Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return new ExtrudeGeometry(s, { depth: SLEEVE_T, bevelEnabled: false, curveSegments: 4 }).translate(0, 0, -SLEEVE_T / 2).rotateX(-Math.PI / 2);
})();
const LUNGE = 0.4; // seconds of a creature's lunge when it deals combat damage
const LAND_FX = 0.45; // seconds of the ring a card leaves when it is put down on the table

/** Cards are carried this high above the table, and played when let go over it (in front of the hand). */
const CARRY = new Plane(new Vector3(0, 1, 0), -1.4);
const DROP_Z = 10.2;

function Card3D({ p, sleeve, spawn, positions, hitAt, lungeAt, clickable, draggable, onDrop, onDrag, onHover, onPick }: {
  p: Placement; sleeve: string; spawn: (p: Placement) => { at: Vector3; faceDown: boolean }; positions: Map<string, Vector3>; hitAt: number | undefined; lungeAt: number | undefined;
  clickable: boolean; draggable: boolean; onDrop: (at: Vector3) => void; onDrag: (on: boolean) => void; onHover: (on: boolean) => void; onPick: () => void;
}) {
  const drag = useRef<{ at: Vector3; from: Vector3; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const ref = useRef<Group>(null);
  const hit = useRef<Group>(null); // where the pointer finds the card: stays put while the card lifts, so hovering cannot flicker
  const invalidate = useThree((s) => s.invalidate);
  const glow = useRef<MeshBasicMaterial>(null);
  const ring = useRef<Mesh>(null);
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
      lands: dist > 2.5 && place.tilt === 0 && !place.inHand, // put down on the table from somewhere else
    };
  }, [x, y, z, yaw, tilt, roll]); // only a change of place starts a new glide

  useFrame(({ invalidate }) => {
    const g = ref.current;
    const tw = tween.current;
    if (!g || !tw) return;
    const t = tw.dur === 0 ? 1 : MathUtils.clamp((now() - tw.t0) / tw.dur, 0, 1);
    const d = drag.current;
    if (d) { // carried in the fingers: follows the pointer, held almost flat
      g.position.lerp(d.at, reducedMotion ? 1 : 0.35);
      g.quaternion.slerp(orientation({ ...p, tilt: 0.45, roll: 0 }), 0.25);
      g.scale.setScalar(1.35);
      invalidate();
      return;
    }
    const e = easeInOut(t);
    base.current.lerpVectors(tw.from, tw.to, e);
    base.current.y += tw.arc * Math.sin(Math.PI * t);
    // Put down with a little weight: it comes in fast from above and leaves a ring in the felt.
    const sinceLand = now() - tw.t0 - tw.dur;
    const landing = tw.lands && tw.dur > 0 && sinceLand > -0.05 && sinceLand < LAND_FX;
    if (ring.current) {
      ring.current.visible = landing && sinceLand > 0;
      const k = MathUtils.clamp(sinceLand / LAND_FX, 0, 1);
      ring.current.scale.setScalar(1 + k * 0.45);
      (ring.current.material as MeshBasicMaterial).opacity = 0.55 * (1 - k) ** 2;
    }
    g.quaternion.slerpQuaternions(tw.qFrom, tw.qTo, e);
    g.position.copy(base.current);
    if (hit.current) {
      hit.current.position.copy(base.current);
      hit.current.quaternion.copy(g.quaternion);
      hit.current.scale.setScalar(p.inHand ? 1.3 : 1);
    }
    // Hover: a held card rises out of the fan towards you; a card on the table lifts a little.
    const k = reducedMotion ? 1 : 0.2;
    lift.current = MathUtils.lerp(lift.current, hovered && t === 1 ? 1 : 0, k);
    g.scale.setScalar(p.inHand ? 1.3 + lift.current * 0.35 : 1 + lift.current * 0.06); // held cards are nearer to you, so bigger
    g.position.y += lift.current * (p.inHand ? 1.5 : 0.25);
    if (p.inHand) g.position.z += lift.current * 1.1; // towards you, so it comes out in front of its neighbours
    // Damage: a short shake.
    if (hitAt !== undefined && !reducedMotion) {
      const age = now() - hitAt;
      if (age < 0.5) g.position.x += Math.sin(age * 60) * 0.12 * (1 - age / 0.5);
    }
    const lunging = lungeAt !== undefined && !reducedMotion && now() - lungeAt < LUNGE;
    if (lunging) {
      const k = Math.sin((Math.PI * (now() - lungeAt)) / LUNGE);
      g.position.z -= Math.sign(base.current.z || 1) * k * 1.4;
      g.position.y += k * 0.5;
    }
    if (glow.current) glow.current.opacity = 0.8;
    const shaking = hitAt !== undefined && now() - hitAt < 0.5;
    const settling = Math.abs(lift.current - (hovered ? 1 : 0)) > 0.002;
    if (t < 1 || settling || shaking || landing || lunging) invalidate(); // keep drawing while this card moves
  });

  const color = p.highlight ? HIGHLIGHT_COLORS[p.highlight] : null;
  return (<>
    <group ref={hit}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); onHover(true); if (clickable) document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHovered(false); onHover(false); document.body.style.cursor = ''; }}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => {
        if (!draggable) return; // any card in hand can be picked up; only a playable one is played when let go
        e.stopPropagation();
        (e.target as Element).setPointerCapture(e.pointerId);
        const from = ref.current?.position.clone() ?? new Vector3();
        drag.current = { at: from.clone(), from, moved: false };
        onDrag(true);
      }}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        const d = drag.current;
        if (!d || !e.ray.intersectPlane(CARRY, d.at)) return;
        d.moved ||= Math.hypot(d.at.x - d.from.x, d.at.z - d.from.z) > 0.8;
        invalidate();
      }}
      onPointerUp={(e: ThreeEvent<PointerEvent>) => {
        const d = drag.current;
        const g = ref.current;
        if (!d || !g) return;
        (e.target as Element).releasePointerCapture(e.pointerId);
        drag.current = null;
        onDrag(false);
        justDragged.current = d.moved;
        // Back towards the hand from where it was let go; if it was played, the server moves it to the table first.
        base.current.copy(g.position);
        tween.current = { from: g.position.clone(), to: new Vector3(x, y, z), qFrom: g.quaternion.clone(), qTo: orientation(p), t0: now(), dur: reducedMotion ? 0 : 0.3, arc: 0, lands: false };
        if (d.moved && p.inHand) { if (d.at.z < DROP_Z && clickable) onPick(); } else if (d.moved) onDrop(d.at);
        invalidate();
      }}
      onClick={(e) => { e.stopPropagation(); if (justDragged.current) { justDragged.current = false; return; } onPick(); }}>
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>
    </group>
    <group ref={ref}>
      {color && (
        <mesh rotation-x={-Math.PI / 2} position-y={-SLEEVE_T / 2 - 0.002}>
          <planeGeometry args={[CARD_W + 0.4, CARD_H + 0.4]} />
          <meshBasicMaterial ref={glow} color={color} alphaMap={alpha} transparent blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={-0.01} visible={false}>
        <ringGeometry args={[1.55, 1.95, 48]} />
        <meshBasicMaterial color="#ffe2b0" transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* The sleeve: glossy plastic in the owner's colour; it casts the card's shadow. */}
      <mesh geometry={sleeveGeometry} castShadow receiveShadow>
        <meshStandardMaterial color={sleeve} roughness={0.28} metalness={0.05} envMapIntensity={1.1} />
      </mesh>
      {/* Faces: mostly the image as published (emissive), with a touch of the lamp's light and its gloss on top. */}
      <mesh rotation-x={-Math.PI / 2} position-y={SLEEVE_T / 2 + 0.001}>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshStandardMaterial map={front} emissiveMap={front} emissive="#ffffff" emissiveIntensity={0.78} color="#6a6a6a"
          roughness={0.34} metalness={0} envMapIntensity={0.45} alphaMap={alpha} alphaTest={0.5} toneMapped={false} />
      </mesh>
      <mesh rotation-x={Math.PI / 2} position-y={-SLEEVE_T / 2 - 0.001}>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshStandardMaterial map={backTexture()} emissiveMap={backTexture()} emissive="#ffffff" emissiveIntensity={0.6} color="#7a7a7a"
          roughness={0.3} envMapIntensity={0.5} alphaMap={alpha} alphaTest={0.5} toneMapped={false} />
      </mesh>
      {/* +1/+1 counters: green glass beads along the card's lower edge. */}
      {Array.from({ length: p.beads ?? 0 }, (_, i) => (
        <mesh key={`bead-${String(i)}`} geometry={beadGeometry} castShadow position={[-CARD_W / 2 + 0.3 + (i % 5) * 0.32, SLEEVE_T / 2 + 0.06, CARD_H / 2 - 0.35 - Math.floor(i / 5) * 0.32]}>
          <meshStandardMaterial color="#5fd08a" roughness={0.08} metalness={0.1} envMapIntensity={1.6} transparent opacity={0.88} />
        </mesh>
      ))}
      {/* Badges turn back against the card's yaw so they read upright from the viewer's seat. */}
      {p.badges.map((b, i) => (
        <mesh key={b} rotation={[-Math.PI / 2, 0, -p.yaw]} position={[CARD_W / 2 - 0.6, SLEEVE_T / 2 + 0.004, CARD_H / 2 - 0.3 - i * 0.55]}>
          <planeGeometry args={[0.5 * BADGE_ASPECT, 0.5]} />
          <meshBasicMaterial map={badgeTexture(b)} transparent toneMapped={false} />
        </mesh>
      ))}
    </group>
  </>);
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
