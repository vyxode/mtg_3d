import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Euler, Quaternion, Vector3, type Group } from 'three';
import type { GameEvent, ObjectId, PlayerView } from '@mtg3d/engine';
import { cardImage } from '../net';
import { CARD_H, CARD_W, layoutTable, libraryPos, type Placement } from './layout';
import { BADGE_ASPECT, backTexture, badgeTexture, cardTexture, onTextureLoaded } from './textures';

const HIGHLIGHT_COLORS = { playable: '#c9a24a', attacking: '#d9534f', blocking: '#4a90d9' } as const;

const CAMERAS = {
  jugador: { pos: new Vector3(0, 19, 16.5), look: new Vector3(0, 0, 2.8) },
  cenital: { pos: new Vector3(0, 30, 0.01), look: new Vector3(0, 0, 0) },
} as const;
type CameraName = keyof typeof CAMERAS;

interface Props { view: PlayerView; events: GameEvent[]; usable: ReadonlySet<ObjectId> }

export function Table3D({ view, events, usable }: Props) {
  const placements = layoutTable(view, usable);
  const [hover, setHover] = useState<Placement | null>(null);
  const [pinned, setPinned] = useState<Placement | null>(null);
  const [camera, setCamera] = useState<CameraName>('jugador');
  const shown = hover ?? (pinned && placements.find((p) => p.key === pinned.key)) ?? null;

  // Last drawn position of every card, so a card that changes zone (and gets a new id, 400.7) flies from where it was.
  const positions = useRef(new Map<string, Vector3>());
  const movedFrom = new Map(events.flatMap((e) => (e.kind === 'zoneChange' ? [[e.to, e.from] as const] : [])));
  // Pruned after commit, not on unmount: the card replacing a moved one reads its old position during the same commit.
  useEffect(() => {
    const live = new Set(placements.map((p) => p.key));
    for (const k of positions.current.keys()) if (!live.has(k)) positions.current.delete(k);
  });
  const spawnOf = (p: Placement): Vector3 => {
    const from = movedFrom.get(p.key);
    const prev = from === undefined ? undefined : positions.current.get(from);
    if (prev) return prev.clone();
    const lib = libraryPos(p.owner, view.viewer);
    return new Vector3(lib.x, 0.3, lib.z);
  };

  return (
    <div className="table3d">
      <Canvas frameloop="demand" flat dpr={[1, 2]} camera={{ fov: 40, near: 0.5, far: 200, position: CAMERAS.jugador.pos.toArray() }}>
        <color attach="background" args={['#0f1113']} />
        <CameraRig name={camera} />
        <Redraw />
        <mesh rotation-x={-Math.PI / 2} position-y={-0.01}>
          <planeGeometry args={[34, 26]} />
          <meshBasicMaterial color="#1a2b22" />
        </mesh>
        {[1, -1].map((s) => (
          <mesh key={s} rotation-x={-Math.PI / 2} position={[0, -0.005, s * 4.8]}>
            <planeGeometry args={[24, 8]} />
            <meshBasicMaterial color={s === 1 ? '#203629' : '#22302a'} />
          </mesh>
        ))}
        {placements.map((p) => (
          <Card3D key={p.key} p={p} spawn={spawnOf} positions={positions.current}
            onHover={(on) => { setHover(on && p.card ? p : null); }}
            onPick={() => { if (p.card) setPinned(pinned?.key === p.key ? null : p); }} />
        ))}
      </Canvas>
      <div className="hud-cameras">
        {(Object.keys(CAMERAS) as CameraName[]).map((c) => (
          <button key={c} className={c === camera ? 'primary' : ''} onClick={() => { setCamera(c); }}>Vista {c}</button>
        ))}
      </div>
      {shown?.card && (
        <aside className="hud-preview" aria-live="polite">
          <img src={cardImage(shown.card)} alt={shown.card} />
          <p><b>{shown.card}</b>{shown.badges.length > 0 && <> · {shown.badges.join(' · ')}</>}</p>
        </aside>
      )}
    </div>
  );
}

/** Redraws once whenever a card image finishes loading (the scene only renders on demand). */
function Redraw() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => onTextureLoaded(() => { invalidate(); }), [invalidate]);
  return null;
}

function CameraRig({ name }: { name: CameraName }) {
  const look = useRef(CAMERAS.jugador.look.clone());
  useFrame(({ camera, invalidate }, dt) => {
    const target = CAMERAS[name];
    const k = 1 - Math.exp(-dt * 6);
    camera.position.lerp(target.pos, k);
    look.current.lerp(target.look, k);
    camera.lookAt(look.current);
    if (camera.position.distanceTo(target.pos) > 0.01) invalidate();
  });
  return null;
}

const tmpQ = new Quaternion();

function Card3D({ p, spawn, positions, onHover, onPick }: {
  p: Placement; spawn: (p: Placement) => Vector3; positions: Map<string, Vector3>;
  onHover: (on: boolean) => void; onPick: () => void;
}) {
  const ref = useRef<Group>(null);
  const target = useMemo(() => new Vector3(p.x, p.y, p.z), [p.x, p.y, p.z]);
  const targetQ = useMemo(() => new Quaternion().setFromEuler(new Euler(p.tilt, p.yaw, 0, 'YXZ')), [p.tilt, p.yaw]);
  const front = p.card ? cardTexture(p.card) : backTexture();

  useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return undefined;
    g.position.copy(spawn(p));
    g.quaternion.copy(targetQ);
    positions.set(p.key, g.position);
    return undefined;
  }, []); // placed once when the card appears; later moves animate in useFrame

  useFrame(({ invalidate }, dt) => {
    const g = ref.current;
    if (!g) return;
    const k = 1 - Math.exp(-dt * 10);
    g.position.lerp(target, k);
    g.quaternion.slerp(targetQ, k);
    if (g.position.distanceToSquared(target) > 1e-5 || tmpQ.copy(g.quaternion).angleTo(targetQ) > 1e-3) invalidate();
  });

  const color = p.highlight ? HIGHLIGHT_COLORS[p.highlight] : null;
  return (
    <group ref={ref}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); }}
      onPointerOut={() => { onHover(false); }}
      onClick={(e) => { e.stopPropagation(); onPick(); }}>
      {color && (
        <mesh rotation-x={-Math.PI / 2} position-y={-0.004}>
          <planeGeometry args={[CARD_W + 0.24, CARD_H + 0.24]} />
          <meshBasicMaterial color={color} />
        </mesh>
      )}
      {/* Unlit material: Scryfall images are shown as published, with no shading or color shift. */}
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshBasicMaterial map={front} toneMapped={false} />
      </mesh>
      <mesh rotation-x={Math.PI / 2}>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshBasicMaterial map={backTexture()} toneMapped={false} />
      </mesh>
      {/* Badges turn back against the card's yaw so they read upright from the viewer's seat. */}
      {p.badges.map((b, i) => (
        <mesh key={b} rotation={[-Math.PI / 2, 0, -p.yaw]} position={[CARD_W / 2 - 0.6, 0.004, CARD_H / 2 - 0.3 - i * 0.55]}>
          <planeGeometry args={[0.5 * BADGE_ASPECT, 0.5]} />
          <meshBasicMaterial map={badgeTexture(b)} transparent toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
