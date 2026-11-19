import {ABILITY_LABELS} from '../words'
import type {Ability} from './abilities'
import type {GestureName} from '../villager/pose'

/**
 * 村人Aの体でできること。手を振るのは VR なら自分の手を振ればそのまま映るので、ボタンは付けていない。
 * VR のボタンは B（右）と Y（左）。A は本体のジャンプ・座席から立つ、トリガーとグリップは掴む・使うに使われている。
 */
export const VILLAGER_ABILITIES:Ability[]=[
 {id:'wave',label:ABILITY_LABELS.wave,keys:['KeyZ']},
 {id:'bow',label:ABILITY_LABELS.bow,keys:['KeyX'],xr:{hand:'left',button:5,name:'Y'}},
 {id:'say',label:ABILITY_LABELS.say,keys:['KeyC'],xr:{hand:'right',button:5,name:'B'}},
 {id:'idle',label:ABILITY_LABELS.idle,keys:['KeyV']},
]
/** 「しぐさ」は押すたびに次のものになる */
export const IDLE_GESTURES:Exclude<GestureName,'talk'>[]=['hips','clasp','stretch','scratch','sky','neck']
/** what is sent to the room when the wearer starts one */
export interface ActPayload{a:'gesture'|'say';g?:Exclude<GestureName,'talk'>;side?:1|-1;line?:number}
