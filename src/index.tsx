export {Item,Item as default} from './Item'
export type {ItemProps} from './Item'

// 何人置いてもよい（置いた場所ごとに、しぐさと歩く先が変わる）。
// singlePlace は本体が読まない値だが、意図として書いておく
export const config={defaultScale:1,alignToSurface:false,singlePlace:false}
