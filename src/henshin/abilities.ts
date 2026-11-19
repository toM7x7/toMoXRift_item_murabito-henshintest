/**
 * What the body you have turned into can do: its abilities, and the keys / VR buttons that start them.
 *
 * This is the part to swap when the same 変身 mechanism is given another body (another character, a body with its
 * own gimmicks): wear.ts only follows the avatar and draws the body; an ability list says what the wearer can make
 * that body do. An ability is started by the wearer, sent to the room (useInstanceEvent, Item.tsx) and run on every
 * screen from the same shared time, so everyone sees it at once.
 *
 * Input: keys (PC) and VR controller buttons. The wearer cannot aim at their own body, so Interactable is no use.
 * The official DevEnvironment keeps plain keys to itself, so Ctrl+Alt+the same key also works (as in 頭上リアクション).
 * Mobile has no keys: abilities are PC and VR only for now.
 */
export interface Ability{
 id:string
 /** what it is called in the wearer's key strip */
 label:string
 /** KeyboardEvent.code */
 keys:string[]
 /** an xr-standard controller button: hand, index into gamepad.buttons, and its name on Quest controllers */
 xr?:{hand:'left'|'right';button:number;name:string}
}

const EDITABLE='input,textarea,select,[contenteditable="true"],[role="textbox"],[role="dialog"]'
const editing=(target:EventTarget|null)=>{const el=target as HTMLElement|null;return !!(el?.isContentEditable||el?.closest?.(EDITABLE))}

export interface AbilityInput{
 /** every frame while worn: read the VR controllers (edges only) */
 pollXR(session:XRSession|null|undefined):void
 dispose():void
}

/** Listen for the abilities' keys and buttons; fire(id) once per press. */
export function createAbilityInput(abilities:Ability[],fire:(id:string)=>void):AbilityInput{
 const byCode=new Map<string,string>()
 for(const a of abilities)for(const k of a.keys)byCode.set(k,a.id)
 const onKey=(e:KeyboardEvent)=>{
  if(e.defaultPrevented||e.repeat||e.isComposing||e.metaKey||e.shiftKey||editing(e.target))return
  const plain=!e.ctrlKey&&!e.altKey,fallback=e.ctrlKey&&e.altKey
  if(!plain&&!fallback)return
  const id=byCode.get(e.code)
  if(!id)return
  e.preventDefault()
  fire(id)
 }
 window.addEventListener('keydown',onKey,{capture:true})
 const down=new Map<string,boolean>()
 return {
  pollXR(session){
   if(!session){down.clear();return}
   for(const a of abilities){
    if(!a.xr)continue
    let pressed=false
    for(const src of Array.from(session.inputSources??[])){
     if(src.handedness!==a.xr.hand||src.hand||src.gamepad?.mapping!=='xr-standard')continue
     if(src.gamepad.buttons[a.xr.button]?.pressed)pressed=true
    }
    if(pressed&&!down.get(a.id))fire(a.id)
    down.set(a.id,pressed)
   }
  },
  dispose(){window.removeEventListener('keydown',onKey,{capture:true});down.clear()},
 }
}
