import { chromium } from '@playwright/test';
const BASE='https://my.development.legitscript.net';
const PAGES=['/assets/unsupported-browser.html','/assets/legal.html'];
const b=await chromium.launch({channel:'chrome'});
const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1000,height:760}});
for(const p of PAGES){
  const page=await c.newPage();
  const viol=[];
  page.on('console',m=>{const t=m.text(); if(/content security|refused to apply/i.test(t)&&/style/i.test(t)) viol.push(t.slice(0,150));});
  await page.goto(BASE+p,{waitUntil:'networkidle'}).catch(()=>{});
  await page.waitForTimeout(2500);
  await page.screenshot({path:'output/verify-'+p.split('/').pop()+'.png'});
  console.log(`${p}: style-src violations = ${viol.length}`);
  viol.slice(0,3).forEach(v=>console.log('   • '+v));
  await page.close();
}
await b.close();
