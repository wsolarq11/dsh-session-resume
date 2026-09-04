import { createRequire } from 'node:module'
const url = 'http://127.0.0.1:3080'
async function rpc(method, args) {
  const r = await fetch(url+'/api/sessionResume/'+method, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ type:'client-request', rpcId:'auto', method:'sessionResume/'+method, payload:{args} })
  })
  const j = await r.json()
  if (!j.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(j.result)}`)
  return j.result.value
}
let fail=0, pass=0
const s=session=>{pass++; console.log(' PASS',session)}
const f=(e)=>{fail++; console.log(' FAIL', String(e&&e.message||e).slice(0,200))}
try{
  // 1. config roundtrip
  await rpc('setConfig',{config:{snapshotRetention:9,resumeInstruction:'闭环-自动'}}); s('setConfig')
  const cfg=await rpc('getConfig',{}); if(cfg.snapshotRetention!==9){throw new Error('config retention !=9')} s('getConfig roundtrip')
  // 2. real session resolve + log path
  const sid='session-334c2edd-8922-40e6-9d19-eb8b62931fa8'
  const rs=await rpc('resolveSession',{sessionId:sid}); if(!rs.ok)throw new Error('resolveSession !ok'); s('resolveSession real')
  const lp=await rpc('resolveLogPath',{sessionId:sid}); if(!lp.ok||!lp.path)throw new Error('resolveLogPath !ok'); s('resolveLogPath materialized: '+String(lp.path).split('\\').pop())
  // 3. plan + batch
  const p=await rpc('resolvePlan',{sessionId:sid,attemptId:'auto-plan-1',snapshotId:''}); if(!p.ok)throw new Error('plan !ok'); s('resolvePlan real')
  const bp=await rpc('resolveBatchPlan',{sessionIds:[sid],attemptId:'auto-batch-1',snapshotIds:{}}); if(!bp.ok)throw new Error('batch !ok'); s('resolveBatchPlan real')
  // 4. terminal + idempotent + invariance
  const c=await rpc('completeResume',{attemptId:'auto-plan-1',status:'accepted',targetSessionId:sid,error:''}); if(!c.ok||c.status!=='accepted')throw new Error('complete !accepted'); s('completeResume accepted')
  const c2=await rpc('completeResume',{attemptId:'auto-plan-1',status:'failed',targetSessionId:'',error:'x'});
  if(!(c2.ok===false && c2.error.includes('已处于')))throw new Error('terminal not enforced: '+JSON.stringify(c2)); s('terminal invariance (409-like)')
  // 5. resolveFromText no-link degraded
  const ft=await rpc('resolveFromText',{text:'无链接'}); if(ft.ok!==false)throw new Error('resolveFromText should degrade'); s('resolveFromText degraded')
  console.log(`\nGATE-FINAL: pass=${pass} fail=${fail}`)
}catch(e){ console.log('\nGATE-FINAL: pass=%d fail=1 reason=%s', pass, e.stack||e.message); process.exitCode=1 }
