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
 const head=process.env.E2E_HEAD??'unknown'
 await page.getByRole('radio',{name:'All, 17',exact:true}).click()
 await page.evaluate(()=>{document.documentElement.classList.replace('dark','light')})
 const away=async()=>{ await page.getByRole('heading',{name:'Sub-tasks',exact:true}).hover(); await page.waitForTimeout(800) }
 const more=page.getByRole('button',{name:'Show 7 more',exact:true}); await more.waitFor({timeout:30000})
 const control=page.getByRole('button',{name:/^Show (less|\d+ more)$/})
 const measure=async()=>{ const id=await control.getAttribute('aria-controls'); return page.locator(`[id="${id}"]`).evaluate((el:any,btnId:string)=>{
  const btn=[...document.querySelectorAll(`[aria-controls="${btnId}"]`)][0] as any
  const icon=el.querySelector('button > span')?.getBoundingClientRect()
  const b=btn?.getBoundingClientRect(); const pad=btn?parseFloat(getComputedStyle(btn).paddingLeft):0
  let s:any=el.parentElement; while(s&&!(/(auto|scroll)/.test(getComputedStyle(s).overflowY)&&s.scrollHeight>s.clientHeight)) s=s.parentElement
  return {rows:el.querySelectorAll(':scope > button').length,listOverflowY:getComputedStyle(el).overflowY,listScrollHeight:el.scrollHeight,listClientHeight:el.clientHeight,
   button:btn?.textContent,ariaExpanded:btn?.getAttribute('aria-expanded'),iconLeft:icon?.left,buttonTextLeft:b?b.left+pad:null,
   sidebarScrollTop:s?.scrollTop??null,sidebarScrollable:Boolean(s)}
 },id) }
 const check=(m:any,rows:number,label:string,expanded:string)=>{
  if(m.rows!==rows||m.button!==label||m.ariaExpanded!==expanded) throw Error('state '+JSON.stringify(m))
  if(m.listOverflowY!=='visible'||m.listScrollHeight>m.listClientHeight) throw Error('inner scroll '+JSON.stringify(m))
  if(Math.abs(m.iconLeft-m.buttonTextLeft)>0.5) throw Error('alignment '+JSON.stringify(m))
 }
 await away(); const collapsed=await measure(); check(collapsed,10,'Show 7 more','false')
 await page.screenshot({path:`${artifacts}/collapsed.png`})
 await more.click(); const less=page.getByRole('button',{name:'Show less',exact:true}); await less.waitFor()
 await less.scrollIntoViewIfNeeded(); await away(); const expanded=await measure(); check(expanded,17,'Show less','true')
 if(!expanded.sidebarScrollable||!expanded.sidebarScrollTop) throw Error('sidebar did not scroll '+JSON.stringify(expanded))
 await page.screenshot({path:`${artifacts}/expanded.png`})
 await less.click(); await away(); const collapsedAgain=await measure(); check(collapsedAgain,10,'Show 7 more','false')
 await more.click(); await less.waitFor()
 await page.getByRole('radio',{name:'Active, 1',exact:true}).click(); await away()
 const activeRows=await page.getByLabel('Sub-tasks',{exact:true}).getByRole('button',{name:/Waiting for you/}).count()
 if(await page.getByRole('button',{name:/^Show (less|\d+ more)$/}).count()||activeRows!==1) throw Error('active filter state')
 await page.screenshot({path:`${artifacts}/active-filter.png`})
 await page.getByRole('radio',{name:'All, 17',exact:true}).click()
 await more.waitFor(); await away(); const reset=await measure(); check(reset,10,'Show 7 more','false')
 await page.screenshot({path:`${artifacts}/filter-reset.png`})
 writeFileSync(`${artifacts}/metrics.json`,JSON.stringify({head,collapsed,expanded,collapsedAgain,activeRows,reset},null,2))
 console.log('PASS real Desktop/backend: preview 10, Show 7 more, Show less, sidebar scroll, filter reset, alignment')
} catch(e) { console.error(e); if(desktop) { console.log(await desktop.page.locator('body').innerText()); await desktop.page.screenshot({path:`${artifacts}/failure.png`}) } process.exitCode=1 }
finally { if(desktop) await desktop.close(Boolean(process.exitCode)); await stopAll() }
