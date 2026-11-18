// 声は合成音（外部ファイルなし）。昔のゲームの「ぽぽぽ」という話し声。
// AudioContext はページで1つを共有し、失敗しても（非対応・自動再生の制限）動きには影響させない。

type WindowWithWebkitAudio=Window&{webkitAudioContext?:typeof AudioContext}
let shared:AudioContext|null=null

function context(){
 if(shared)return shared
 try{
  const Ctor=window.AudioContext||(window as WindowWithWebkitAudio).webkitAudioContext
  shared=Ctor?new Ctor():null
 }catch{shared=null}
 return shared
}

/**
 * 話し声の1音。
 * @param index 何音目か（音ごとに高さを少し変える）
 * @param total 全部で何音か（終わりは下がる）
 * @param distance 聞く人からの距離（m）
 */
export function playBlip(index:number,total:number,distance:number){
 const ctx=context()
 if(!ctx)return
 if(ctx.state==='suspended'){ctx.resume().catch(()=>{});if(ctx.state==='suspended')return}
 const level=0.07/(1+(distance/4)**2)
 if(level<0.003)return
 const t=ctx.currentTime+0.005
 const steps=[0,2,-1,3,0,-2,2,1,-3,0,4,-1]
 const fall=index>=total-2?-2*(index-total+3):0
 const base=196*2**((steps[index%steps.length]+fall)/12)
 const dur=0.075
 const out=ctx.createGain()
 out.gain.setValueAtTime(0.0001,t)
 out.gain.exponentialRampToValueAtTime(level,t+0.008)
 out.gain.exponentialRampToValueAtTime(0.0001,t+dur)
 const lp=ctx.createBiquadFilter()
 lp.type='lowpass';lp.frequency.value=1500;lp.Q.value=0.7
 lp.connect(out).connect(ctx.destination)
 for(const [mul,gain,type] of [[1,1,'triangle'],[2,0.22,'sine']] as const){
  const osc=ctx.createOscillator(),g=ctx.createGain()
  osc.type=type
  osc.frequency.setValueAtTime(base*mul*1.04,t)
  osc.frequency.exponentialRampToValueAtTime(base*mul*0.97,t+dur)
  g.gain.value=gain
  osc.connect(g).connect(lp)
  osc.start(t)
  osc.stop(t+dur+0.02)
 }
}
