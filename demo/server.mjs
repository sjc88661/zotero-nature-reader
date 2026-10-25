import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {makeState,figureSVG} from './fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),Core=require('../bridge/addon/content/core.js');
export function sampleNote(){
  const s=makeState();
  return Core.mergeNote(null,s.paper,s.chat,[{createdAt:1792886460000,content:'## 演示整理\n\n先记录观察，再列出解释；每个重要判断保留来源。把自己的研究想法写入个人整理区。'}],[{key:'DEMOHL01',attachmentKey:'DEMO0002',attachmentTitle:'演示 PDF',type:'highlight',text:'A larger signal alone does not establish a biological mechanism.',comment:'先核对实验设计，再讨论机制。',pageLabel:'1',pageIndex:0,color:'#a28ae5',tags:['阅读重点']}],true,[s.reading]);
}
export async function startDemoServer({port=0}={}){
  const server=http.createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(req.method!=='GET'){res.writeHead(405).end();return;}
      let body,type='text/html; charset=utf-8';
      if(pathname==='/demo/state.json'){body=JSON.stringify(makeState());type='application/json; charset=utf-8';}
      else if(pathname==='/demo/assets/figure.svg'){body=figureSVG;type='image/svg+xml';}
      else if(pathname==='/demo/sample-note.md'){body=sampleNote();type='text/markdown; charset=utf-8';}
      else {
        const file=pathname==='/'?'demo/index.html':pathname==='/note'?'demo/note.html':pathname==='/cover'?'demo/cover.html':
          /^\/content\/[a-z-]+\.(xhtml|js|css)$/.test(pathname)?'addon'+pathname:
          /^\/demo\/(demo|host|note)\.(js|css)$/.test(pathname)?pathname.slice(1):null;
        if(!file){res.writeHead(404).end('Not found');return;}
        body=await readFile(path.join(root,file),'utf8');
        type=file.endsWith('.xhtml')?'application/xhtml+xml; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':type;
        body=body.replaceAll('chrome://zotero-nature/content/','/content/');
      }
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);
    }catch{res.writeHead(500).end('Demo resource unavailable');}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}`};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {url}=await startDemoServer();console.log(`Nature Reader demo: ${url}\nFictional material and prewritten responses only. Press Ctrl+C to stop.`);
}
