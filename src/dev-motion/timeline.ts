// The routine as a looping list of key poses. Pure (no three.js), so node --test can read it.
// One loop is 32 beats in four 8-beat exercises; every exercise starts and ends on `rest`.

export const BEAT_S = 0.55
export interface Step { to: string; beats: number }

export const START_KEY = 'rest'
export const STEPS: Step[] = [
  // 1. stretch: arms forward, overhead on tiptoe, open to the sides, down
  { to: 'front', beats: 1 }, { to: 'up', beats: 1 }, { to: 'up', beats: 2 }, { to: 'side', beats: 2 }, { to: 'rest', beats: 2 },
  // 2. swing: knees bend with the arms low, legs stretch with the arms flung out
  { to: 'swingDown', beats: 1 }, { to: 'swingOut', beats: 1 }, { to: 'swingDown', beats: 1 }, { to: 'swingOut', beats: 1 },
  { to: 'swingDown', beats: 1 }, { to: 'swingOut', beats: 1 }, { to: 'rest', beats: 2 },
  // 3. side bends: one hand on the hip, the other arm over the head
  { to: 'bendL', beats: 2 }, { to: 'rest', beats: 2 }, { to: 'bendR', beats: 2 }, { to: 'rest', beats: 2 },
  // 4. forward fold, then lean back with the hands on the hips
  { to: 'fold', beats: 2 }, { to: 'fold', beats: 1 }, { to: 'rest', beats: 1 }, { to: 'arch', beats: 2 }, { to: 'arch', beats: 1 }, { to: 'rest', beats: 1 },
]
export const LOOP_BEATS = STEPS.reduce((n, s) => n + s.beats, 0)
export const LOOP_S = LOOP_BEATS * BEAT_S

/** Keys in the order the routine first reaches them (the arm solver carries each solution to the next key). */
export const VISIT_ORDER = [START_KEY, ...STEPS.map(s => s.to)].filter((k, i, a) => a.indexOf(k) === i)

/** Where the routine is at `seconds` (any real number; it loops): the two keys and how far between them (0..1). */
export function segmentAt(seconds: number): { from: string; to: string; u: number; beat: number } {
  const beat = ((seconds / BEAT_S) % LOOP_BEATS + LOOP_BEATS) % LOOP_BEATS
  let start = 0, from = START_KEY
  for (const step of STEPS) {
    if (beat < start + step.beats) return { from, to: step.to, u: (beat - start) / step.beats, beat }
    start += step.beats; from = step.to
  }
  return { from, to: START_KEY, u: 1, beat }
}
