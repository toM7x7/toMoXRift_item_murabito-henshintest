import { lerpFrame, resolvedKeys } from '../pose-lib/authoring/clip.mjs'
import type { ActionClip, AuthoringRig, PoseFrame, PoseKey, Vec3 } from '../pose-lib/authoring/types.d.mts'
import { VISIT_ORDER, segmentAt } from './timeline'

// An original warm-up routine in the style of morning calisthenics (not a copy of any existing routine).
// Keys are written the way the pose lab's authored actions are: body metres for a 1.65 m reference figure
// (hips 0.95 m, shoulders about 1.36 m), degrees, +X left / +Y up / +Z forward. rot = [yaw, pitch, roll]:
// pitch + bends forward, roll + lowers the right shoulder. A hand target past the arm's reach simply gives a
// straight arm pointing at it, which is what most of these poses want.

type Hand = { position: Vec3; fingers: Vec3; palm: Vec3 }
const mirror = (h: Hand): Hand => ({ position: [-h.position[0], h.position[1], h.position[2]], fingers: [-h.fingers[0], h.fingers[1], h.fingers[2]], palm: [-h.palm[0], h.palm[1], h.palm[2]] })
/** both hands the same, mirrored (written for the left hand) */
const both = (left: Hand) => ({ left, right: mirror(left) })
const FEET = { left: { pos: [0.13, 0] as [number, number], toeOut: 10 }, right: { pos: [-0.13, 0] as [number, number], toeOut: 10 } }
const tiptoe = (heel: number) => ({ left: { ...FEET.left, heel, pivot: 0 }, right: { ...FEET.right, heel, pivot: 0 } })
const fingers = (curl: number) => ({ both: { all: { curl, spread: 3 }, thumb: { curl: curl * 0.5 } } })
const head = (pitch = 0, roll = 0, yaw = 0) => ({ mode: 'body' as const, rot: [yaw, pitch, roll] as Vec3, neck: 0.5 })

// left-hand shapes
const HANG: Hand = { position: [0.21, 0.8, 0.03], fingers: [0.05, -1, 0.15], palm: [-1, 0, 0] }
const ON_HIP: Hand = { position: [0.2, 1.0, 0.03], fingers: [-0.1, -0.45, 0.88], palm: [-1, 0, 0] }
const ELBOW_OUT = { left: [0.8, -0.2, -0.55] as Vec3, right: [-0.8, -0.2, -0.55] as Vec3, weight: 0.8 }

const keys: Record<string, PoseKey> = {
  rest: {
    pelvis: { offset: [0, -0.005, 0], rot: [0, 1, 0] }, torso: { rot: [0, 1, 0] }, head: head(), feet: FEET,
    hands: both(HANG), elbows: { left: [0.3, -0.6, -0.75], right: [-0.3, -0.6, -0.75], weight: 0.5 }, fingers: fingers(28),
  },
  front: {
    pelvis: { offset: [0, 0, 0], rot: [0, 0, 0] }, torso: { rot: [0, -1, 0] }, head: head(), feet: FEET, clavicles: { left: [8, 0], right: [8, 0] },
    hands: both({ position: [0.17, 1.36, 0.62], fingers: [0, 0, 1], palm: [0, -1, 0] }), fingers: fingers(6),
  },
  up: {
    pelvis: { offset: [0, 0.01, 0.01], rot: [0, -2, 0] }, torso: { rot: [0, -7, 0] }, head: head(-16), feet: tiptoe(22), clavicles: { left: [0, 14], right: [0, 14] },
    hands: both({ position: [0.2, 2.0, 0.04], fingers: [0.08, 1, 0], palm: [-1, 0.08, 0] }), fingers: fingers(4),
  },
  side: {
    pelvis: { offset: [0, 0, 0], rot: [0, 0, 0] }, torso: { rot: [0, -3, 0] }, head: head(-3), feet: FEET,
    hands: both({ position: [0.8, 1.36, 0], fingers: [1, 0, 0], palm: [0, -1, 0] }), fingers: fingers(4),
  },
  swingDown: {
    pelvis: { offset: [0, -0.13, -0.02], rot: [0, 6, 0] }, torso: { rot: [0, 9, 0] }, head: head(4), feet: FEET, knees: { out: 12 },
    hands: both({ position: [0.15, 0.7, 0.16], fingers: [-0.15, -0.95, 0.25], palm: [-0.95, 0.1, -0.2] }), fingers: fingers(22),
  },
  swingOut: {
    pelvis: { offset: [0, 0.01, 0], rot: [0, -1, 0] }, torso: { rot: [0, -5, 0] }, head: head(-8), feet: tiptoe(16), clavicles: { left: [0, 6], right: [0, 6] },
    hands: both({ position: [0.68, 1.62, 0], fingers: [0.88, 0.47, 0], palm: [0.47, -0.88, 0] }), fingers: fingers(5),
  },
  bendL: {
    pelvis: { offset: [-0.05, 0, 0], rot: [0, 0, -5] }, torso: { rot: [0, 0, -30] }, head: head(0, -22), feet: FEET, clavicles: { right: [0, 14] },
    hands: { left: ON_HIP, right: { position: [-0.02, 2.0, 0], fingers: [0.5, 0.86, 0], palm: [0.86, -0.5, 0] } }, elbows: ELBOW_OUT, fingers: fingers(8),
  },
  bendR: {
    pelvis: { offset: [0.05, 0, 0], rot: [0, 0, 5] }, torso: { rot: [0, 0, 30] }, head: head(0, 22), feet: FEET, clavicles: { left: [0, 14] },
    hands: { right: mirror(ON_HIP), left: { position: [0.02, 2.0, 0], fingers: [-0.5, 0.86, 0], palm: [-0.86, -0.5, 0] } }, elbows: ELBOW_OUT, fingers: fingers(8),
  },
  fold: {
    pelvis: { offset: [0, -0.02, -0.13], rot: [0, 32, 0] }, torso: { rot: [0, 82, 0] }, head: head(70), feet: FEET, legs: { maxExtension: 0.97 },
    hands: both({ position: [0.13, 0.36, 0.44], fingers: [0, -1, 0.05], palm: [0, 0.05, -1] }), fingers: fingers(10),
  },
  arch: {
    pelvis: { offset: [0, -0.01, 0.06], rot: [0, -8, 0] }, torso: { rot: [0, -27, 0] }, head: head(-30), feet: FEET,
    hands: both(ON_HIP), elbows: ELBOW_OUT, fingers: fingers(14),
  },
}

// Ordered the way the routine visits them: resolvedKeys solves the keys in this order, each arm seeded with the previous key's.
const CLIP = { id: 'taiso-stage', version: '0.1.0', keys: Object.fromEntries(VISIT_ORDER.map(k => [k, keys[k]])) } as unknown as ActionClip
export const KEY_NAMES = Object.keys(keys)

/** The routine at `seconds` for this body. Everyone asks with the same clock, so everyone moves together. */
export function sampleRoutine(info: AuthoringRig, seconds: number): PoseFrame {
  const k = resolvedKeys(CLIP, info), s = segmentAt(seconds)
  return lerpFrame(k[s.from], k[s.to], (1 - Math.cos(Math.PI * s.u)) / 2)
}
/** One key held still (dev captures). */
export function sampleKeyPose(info: AuthoringRig, name: string): PoseFrame {
  const k = resolvedKeys(CLIP, info)
  return lerpFrame(k[name] ?? k.rest, k[name] ?? k.rest, 0)
}
