// Explicitly invoked only. Public asset downloads; all model execution stays in Chromium.
import {chromium} from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import {previewServer} from './capture_screenshots.mjs';
import {cleanComment, sharesTopic, echoesSpeech} from '../projects/ai-livestream/config.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {cpus, totalmem, platform} from 'node:os';
const root = new URL('../',import.meta.url).pathname;
const fixtures = JSON.parse(await readFile(root+'tests/fixtures/ai-livestream/topics.json','utf8'));
const server = await previewServer(root);
const variants = {
  mlc: { name:'Qwen3-1.7B-MLC', mlc:true },
  'mlc-small': { name:'Qwen3-0.6B-MLC', mlc:true, mlcSmall:true },
  baseline: { name: 'baseline-0.6B', baseline: true },
  revised: { name: 'revised-0.6B' },
  qwen3: { name: 'revised-1.7B', stronger: true },
  qwen25: { name: 'revised-Qwen2.5-1.5B', qwen25: true },
  qwen05: { name: 'revised-Qwen2.5-0.5B', qwen05: true },
  q8: { name: 'revised-0.6B-q8', q8: true },
  cpu: { name: 'revised-0.6B-q8-wasm', q8: true, cpu: true },
  q4: { name: 'revised-0.6B-q4', q4: true },
  modern: { name: 'revised-0.6B-runtime4.2', modern: true },
  'modern-stronger': { name: 'revised-1.7B-runtime4.2', modern: true, stronger: true },
};
const selected = Object.keys(variants).find(name => process.argv.includes(`--${name}`));
const modes = selected ? [variants[selected]] : [variants.baseline, variants['mlc-small'], variants.mlc];
const report = {date:new Date().toISOString(),host:{cpu:cpus()[0].model, memoryGiB:totalmem()/2**30, platform:platform(), browser:'headless Chromium', backend:process.platform==='darwin'?'Metal':'default WebGPU'}, windowSeconds:6, generationSeed:42, modes:[]};
try {
  for (const mode of modes) {
    const browser = await chromium.launch({args:['--enable-unsafe-webgpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]});
    const cdp = await browser.newBrowserCDPSession();
    let peakKiB=0, sampling=false;
    const timer=setInterval(async()=>{
      if(sampling)return; sampling=true;
      try {
        const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');
        const pids=processInfo.map(x=>x.id);
        const rows=execFileSync('ps',['-o','rss=','-p',pids.join(',')],{encoding:'utf8'});
        peakKiB=Math.max(peakKiB,rows.trim().split(/\s+/).reduce((a,b)=>a+Number(b),0));
      } catch {} finally {sampling=false;}
    },1000);
    try {
      const page=await browser.newPage();
      await page.goto(server.origin+'/sandbox/projects/ai-livestream/');
      const gpu=await page.evaluate(async()=>{
        const adapter=await navigator.gpu?.requestAdapter();
        return {f16:adapter?.features.has('shader-f16'),vendor:adapter?.info.vendor,architecture:adapter?.info.architecture};
      });
      if(!gpu.f16)throw Error('Host requires shader-f16');
      await page.evaluate(mode=>{
        window.evaluation={results:[]};
        evaluation.worker=new Worker('/sandbox/tests/fixtures/ai-livestream/compare-worker.mjs',{type:'module'});
        evaluation.worker.onmessage=({data})=>{
          if(data.type==='ready')evaluation.ready=data;
          if(data.type==='result')evaluation.results.push(data);
          if(data.type==='error'){evaluation.error=data.message; evaluation.failure=data;}
        };
        evaluation.worker.postMessage({type:'init',...mode});
      },mode);
      console.log(`Loading ${mode.name}`);
      await page.waitForFunction(()=>evaluation.ready||evaluation.error,null,{timeout:300000});
      if(await page.evaluate(()=>evaluation.error))throw Error(await page.evaluate(()=>evaluation.error));
      const record={...mode,gpu,browserVersion:browser.version(),assetByteMethod:mode.mlc ? 'ASR progress totals + pinned MLC manifest and asset metadata; excludes runtime JS and ONNX WASM' : 'Model download progress totals',...await page.evaluate(()=>evaluation.ready),fixtures:[]};
      for(const [index,fixture] of fixtures.entries()) {
        const bytes=await readFile(root+'tests/fixtures/ai-livestream/'+fixture.file);
        let pcm;
        for(let pos=12;pos+8<=bytes.length;) {
          const size=bytes.readUInt32LE(pos+4);
          if(bytes.toString('ascii',pos,pos+4)==='data'){pcm=bytes.subarray(pos+8,pos+8+size);break;}
          pos+=8+size+(size%2);
        }
        const audio=Array.from({length:Math.min(96000,pcm.length/2)},(_,i)=>pcm.readInt16LE(i*2)/32768);
        await page.evaluate(({audio,language,now})=>{
          const samples=new Float32Array(audio);
          evaluation.worker.postMessage({type:'audio',audio:samples,language,now},[samples.buffer]);
        },{audio,language:fixture.language,now:index*120000});
        await page.waitForFunction(n=>evaluation.results.length===n||evaluation.error,index+1,{timeout:90000});
        const error=await page.evaluate(()=>evaluation.error);if(error)throw Error(error);
        const result=await page.evaluate(i=>evaluation.results[i],index);
        const cleaned = cleanComment(result.raw || '', [], fixture.language);
        const finalComment = sharesTopic(cleaned, result.transcript || '', fixture.language) &&
          !echoesSpeech(cleaned, result.transcript || '', fixture.language) ? cleaned : '';
        record.fixtures.push({file:fixture.file,expected:fixture.text,...result,finalComment});
        console.log(mode.name, fixture.file, JSON.stringify(result));
      }
      record.peakBrowserRssMiB=peakKiB/1024;
      report.modes.push(record);
    } catch (error) {
      const pages = browser.contexts().flatMap(context => context.pages());
      const failure = await pages[0]?.evaluate(() => evaluation.failure).catch(() => null);
      report.modes.push({...mode,...failure,error: String(error),peakBrowserRssMiB:peakKiB/1024});
      console.log(mode.name, String(error));
    } finally {clearInterval(timer);await browser.close();}
  }
} finally {await server.close();await writeFile(root+'tests/fixtures/ai-livestream/comparison'+(selected ? '-'+selected : '')+'.json',JSON.stringify(report,null,2)+'\n');}
