// Local static frontend and synthetic route fixtures only; no real provider.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
const { chromium } = await import('../.local/browser-tools/node_modules/playwright/index.mjs')
const root=resolve('dist');const output='output/playwright/ordinary-auth-20261101'
await mkdir(output,{recursive:true})
const server=createServer(async (req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname
  const path=resolve(root,'.'+pathname)
  if (!path.startsWith(root+'/') && path!==root) {res.writeHead(403).end();return}
  try {const actual=extname(pathname)?path:root+'/index.html';const data=await readFile(actual);res.writeHead(200,{'Content-Type':actual.endsWith('.js')?'text/javascript':actual.endsWith('.css')?'text/css':actual.endsWith('.html')?'text/html':'application/octet-stream','Referrer-Policy':'no-referrer'});res.end(data)} catch {res.writeHead(404).end()}
})
await new Promise((resolve,reject)=>server.once('error',reject).listen(4336,'127.0.0.1',resolve))
const base='http://127.0.0.1:4336';const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const report={synthetic_only:true,real_email:false,flows:[],errors:[]}
try {
  for (const [label,viewport] of [['desktop',{width:1050,height:896}],['mobile',{width:390,height:844}]]) {
    const context=await browser.newContext({viewport,reducedMotion:'reduce'});const page=await context.newPage();let complete=0
    page.on('pageerror',e=>report.errors.push(e.message))
    await page.route('**/*',async route=>{
      const u=new URL(route.request().url());if(u.origin!==base)return route.abort()
      if(!u.pathname.startsWith('/api/'))return route.continue()
      let result={}
      if(u.pathname==='/api/capabilities')result={synthetic_only:false,email_actions:true,recovery:true,signup_invite_required:false}
      else if(u.pathname==='/api/me')return route.fulfill({status:401,json:{error:'Sign in'}})
      else if(u.pathname==='/api/auth/action/check')result={valid:true,submitted_before:false,workspace_details_required:true}
      else if(u.pathname==='/api/auth/action/complete'){
        const body=route.request().postDataJSON();assert.equal(body.name,'Mailbox owner');assert.equal(body.organization,'My team');assert.equal(body.password,'fictional-password-123');complete++;result={changed:true,signed_out:true,verification_required:true}
      } else return route.fulfill({status:404,json:{error:'Not found'}})
      return route.fulfill({status:200,json:result})
    })
    await page.goto(base+'/?mode=resetPassword&oobCode=fixture-code')
    await page.getByRole('heading',{name:'Reset your password.'}).waitFor()
    await page.waitForFunction(()=>location.search==='')
    await page.getByLabel('New password').fill('fictional-password-123')
    await page.getByRole('button',{name:'Reset password'}).click()
    await page.getByLabel('Your name').fill('Mailbox owner')
    await page.getByLabel('Workspace name').fill('My team')
    await page.getByRole('button',{name:'Reset password'}).click()
    await page.getByRole('status').filter({hasText:'Check your inbox for a verification link'}).waitFor()
    assert.equal(complete,1);assert.equal(await page.locator('input[type=password]').count(),0)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await page.screenshot({path:`${output}/${label}-reclaim-complete.png`})
    report.flows.push(label+' mailbox reclaim prompts for owner-selected details and completes once')
    await context.close()
  }
  const page=await browser.newPage();await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();if(u.pathname==='/api/capabilities')return route.fulfill({json:{synthetic_only:false,email_actions:true,recovery:true,signup_invite_required:false}});if(u.pathname==='/api/me')return route.fulfill({status:401,json:{}});return route.continue()})
  await page.goto(base);await page.getByRole('button',{name:'Start your workspace'}).click();await page.getByRole('heading',{name:'Let’s build a better week.'}).waitFor()
  assert.equal(await page.getByLabel('Acceptance access code').count(),0)
  await page.getByText('After verification, choose a fresh password').waitFor();report.flows.push('ordinary signup requests no acceptance access code')
  await page.close()
  const acceptance=await browser.newPage();let guardedCalls=0;const access='a'.repeat(64)
  await acceptance.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue()
    if(u.pathname==='/api/capabilities')return route.fulfill({json:{synthetic_only:false,email_actions:true,recovery:true,signup_invite_required:true}})
    if(u.pathname==='/api/auth/action/check'||u.pathname==='/api/auth/action/complete'){
      assert.equal(route.request().headers()['x-relay-acceptance'],access);guardedCalls++
      return route.fulfill({json:u.pathname.endsWith('/check')?{valid:true,submitted_before:false}:{verified:true}})
    }
    return route.fulfill({status:401,json:{}})
  })
  await acceptance.goto(base+'/?mode=verifyEmail&oobCode=fixture-verify')
  await acceptance.getByRole('heading',{name:'Verify your email.'}).waitFor()
  await acceptance.getByLabel('Acceptance access code').fill(access)
  await acceptance.getByRole('button',{name:'Verify email'}).click()
  await acceptance.getByRole('status').filter({hasText:'Email verified.'}).waitFor()
  assert.equal(guardedCalls,2);assert.equal(await acceptance.evaluate(()=>localStorage.length+sessionStorage.length),0)
  report.flows.push('acceptance action requests carry a memory-only access code')
  await acceptance.close()
  const lifecycle=await browser.newPage();let afterHideHeader='not-checked'
  await lifecycle.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue()
    if(u.pathname==='/api/capabilities')return route.fulfill({json:{synthetic_only:false,email_actions:true,recovery:true,signup_invite_required:true}})
    if(u.pathname==='/api/auth/action/check')return route.fulfill({status:500,json:{error:'fixture failure'}})
    if(u.pathname==='/api/lifecycle-probe'){afterHideHeader=route.request().headers()['x-relay-acceptance'] || '';return route.fulfill({json:{}})}
    return route.fulfill({status:401,json:{}})
  })
  await lifecycle.goto(base+'/?mode=verifyEmail&oobCode=fixture-verify');await lifecycle.getByLabel('Acceptance access code').fill(access)
  await lifecycle.getByRole('button',{name:'Verify email'}).click();await lifecycle.getByText('The link could not be checked.',{exact:false}).waitFor()
  await lifecycle.evaluate(async()=>{window.dispatchEvent(new PageTransitionEvent('pagehide'));await fetch('/api/lifecycle-probe')})
  assert.equal(afterHideHeader,'');report.flows.push('acceptance code cleared on page hide after an unsuccessful action');await lifecycle.close()
  for (const role of ['owner','employee']) {
    const lapsed=await browser.newPage();await lapsed.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();if(u.pathname==='/api/capabilities')return route.fulfill({json:{synthetic_only:true}});if(u.pathname==='/api/me')return route.fulfill({json:{user:{id:'u',name:'Fixture',org:'o',role,csrf:'fixture'},billing_required:true}});if(u.pathname==='/api/billing')return route.fulfill({json:{status:'none',checkout_available:true,portal_available:false,plans:[{id:'fixture',name:'Fixture',amount_minor:1234,currency:'USD',interval:'month'}]}});if(u.pathname==='/api/billing/checkout'){assert.equal(route.request().postDataJSON().plan,'fixture');return route.fulfill({json:{url:'https://untrusted.example/checkout'}})}return route.continue()})
    await lapsed.goto(base);await lapsed.getByRole('heading',{name:'Review your subscription.'}).waitFor()
    if(role==='owner'){await lapsed.getByRole('button',{name:'Check access again'}).waitFor();await lapsed.getByRole('button',{name:'Choose Fixture'}).click();await lapsed.getByRole('alert').filter({hasText:'Billing link is unavailable'}).waitFor()}
    else assert.equal(await lapsed.getByRole('button',{name:'Check access again'}).count(),0)
    report.flows.push(role+' sees a safe billing recovery screen');await lapsed.close()
  }
  assert.deepEqual(report.errors,[]);report.passed=true
} catch(e){report.passed=false;report.failure=e.message;throw e}
finally{await writeFile('docs/validation/ordinary-auth-browser-20261101.json',JSON.stringify(report,null,2)+'\n');await browser.close();await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(report))}
