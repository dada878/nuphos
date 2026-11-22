import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { startStack } from './stack-subtasks-local.ts'
import { startDesktop } from './desktop.ts'
import { stopAll, artifacts } from './processes.ts'
import { rest } from './leave-helpers.ts'
import { newTask, send } from './ui.ts'
import { signInScenarios } from './sign-in-scenarios.ts'
let desktop:any
try {
 const stack=await startStack(); console.log('STACK_READY')
 desktop=await startDesktop(stack.apiUrl); const page=desktop.page
 await page.evaluate(()=>localStorage.setItem('nuphos.locale','en')); await page.reload()
 await signInScenarios[1].run(page,stack); console.log('SIGNED_IN')
 const api=rest(stack,stack.token)
 async function seed(title:string,parent?:string) {
  const id=randomUUID()
  await api('PUT',`/agent/conversations/${id}/transcript`,{teamId:stack.teamId,title,agentRuntime:'claude-code',import:true,messages:[{id:randomUUID(),role:'user',parts:[{type:'text',text:title}]}]})
  if(parent) await api('PUT',`/agent/conversations/${id}/parent`,{teamId:stack.teamId,parentSessionId:parent})
  return id
 }
 const parent=await seed('Subtask scrolling review')
 for(let i=1;i<=16;i++) await seed(`Review task ${String(i).padStart(2,'0')}: verify a long fictional release checklist title and visible task status`,parent)
 await newTask(page); await send(page,'Ask me E2E_ASK E2E_DELIVERY:subtask-waiting')
 await page.getByRole('heading',{name:'Which marker should the fixture use?'}).waitFor({timeout:60000})
 const listed:any=await api('GET',`/agent/conversations?teamId=${stack.teamId}&pendingDecision=true`)
 const waiting=listed.conversations.find((c:any)=>c.inputRequests?.length)
 if(!waiting) throw Error('no real pending question')
 await api('PUT',`/agent/conversations/${waiting.sessionId}/parent`,{teamId:stack.teamId,parentSessionId:parent})
 await page.reload(); await page.getByRole('tab',{name:'Tasks',exact:true}).click()
 await page.getByText('Subtask scrolling review',{exact:true}).first().click()
 if(!(await page.getByLabel('Task summary',{exact:true}).isVisible())) await page.getByRole('button',{name:'Toggle task summary'}).click()
 await page.getByRole('radio',{name:'All, 17',exact:true}).click()
 await page.getByRole('button',{name:'Expand all',exact:true}).waitFor({timeout:30000})
 await page.evaluate(()=>document.documentElement.classList.replace('dark','light'))
 const button=page.getByRole('button',{name:'Expand all',exact:true})
 const id=await button.getAttribute('aria-controls'); const viewport=page.locator(`[id="${id}"]`)
 const metrics=()=>viewport.evaluate((el:any)=>({scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,scrollTop:el.scrollTop}))
 const before=await metrics(); if(before.scrollHeight<=before.clientHeight||before.scrollWidth>before.clientWidth) throw Error(JSON.stringify(before))
 await page.screenshot({path:`${artifacts}/collapsed.png`})
 await viewport.hover(); await page.mouse.wheel(0,500); await page.waitForTimeout(400)
 const scrolled=await metrics(); if(!scrolled.scrollTop) throw Error('wheel did not scroll')
 await button.click(); await page.getByRole('button',{name:'Show less',exact:true}).waitFor(); const expanded=await metrics()
 if(expanded.clientHeight<expanded.scrollHeight) throw Error('not expanded')
 await page.getByRole('button',{name:'Show less',exact:true}).scrollIntoViewIfNeeded()
 await page.screenshot({path:`${artifacts}/expanded.png`})
 await page.getByRole('button',{name:'Show less',exact:true}).click(); if((await metrics()).clientHeight>320) throw Error('not collapsed')
 await page.getByRole('button',{name:'Expand all',exact:true}).click()
 await page.getByRole('radio',{name:'Active, 1',exact:true}).click()
 await page.screenshot({path:`${artifacts}/active-filter.png`})
 if(await page.getByRole('button',{name:'Show less',exact:true}).count()) throw Error('expansion not reset')
 await page.getByRole('radio',{name:'All, 17',exact:true}).click()
 const reset=page.getByRole('button',{name:'Expand all',exact:true}); await reset.waitFor()
 if(await reset.getAttribute('aria-expanded')!=='false') throw Error('filter reset failed')
 const resetId=await reset.getAttribute('aria-controls')
 const resetMetrics=await page.locator(`[id="${resetId}"]`).evaluate((el:any)=>({clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollTop:el.scrollTop}))
 if(resetMetrics.clientHeight!==320||resetMetrics.scrollHeight<=320||resetMetrics.scrollTop!==0||resetMetrics.scrollWidth!==resetMetrics.clientWidth) throw Error('bad reset dimensions')
 await page.screenshot({path:`${artifacts}/filter-reset.png`})
 writeFileSync(`${artifacts}/metrics.json`,JSON.stringify({head:'7c682d7c74e6b048217b4ada96bbc6c4a6449882',before,scrolled,expanded,resetMetrics},null,2))
 console.log('PASS real Desktop/backend: scroll expand collapse filter reset')
} catch(e) { console.error(e); if(desktop) { console.log(await desktop.page.locator('body').innerText()); await desktop.page.screenshot({path:`${artifacts}/failure.png`}) } process.exitCode=1 }
finally { if(desktop) await desktop.close(Boolean(process.exitCode)); await stopAll() }
