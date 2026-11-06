// Disposable proof bridge. Correctness state lives in the experimental engine.
const http=require('node:http'),net=require('node:net'),fs=require('node:fs');
const [endpointFile,origin,access,version,port='0',dropSequence='0']=process.argv.slice(2);
const endpoint=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
function requestEngine(body){return new Promise((resolve,reject)=>{
 const socket=net.connect(endpoint.port,'127.0.0.1');let data='';
 socket.setTimeout(2000,()=>socket.destroy(Error('engine timeout')));
 socket.on('connect',()=>socket.write(JSON.stringify({...body,capability:endpoint.capability})+'\n'));
 socket.on('data',chunk=>{data+=chunk;if(data.length>8*1024*1024)return socket.destroy(Error('oversized response'));if(data.includes('\n')){socket.end();try{resolve(JSON.parse(data))}catch(e){reject(e)}}});
 socket.on('error',reject);socket.on('end',()=>{if(!data.includes('\n'))reject(Error('engine ended without reply'))});
});}
function crash(message,code){if(process.send)process.send(message,()=>process.exit(code));else process.exit(code)}
const server=http.createServer(async(req,res)=>{
 if(req.headers.origin!==origin||req.url!=='/exchange'){res.writeHead(403);return res.end()}
 res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','authorization,content-type');res.setHeader('Access-Control-Allow-Methods','POST');res.writeHead(204);return res.end()}
 if(req.method!=='POST'||req.headers.authorization!==`Bearer ${access}`){res.writeHead(403);return res.end()}
 try{
  let body='';for await(const chunk of req){body+=chunk;if(body.length>96*1024)throw Error('oversized input')}
  const input=JSON.parse(body),reply=await requestEngine(input);
  // Inject the ambiguity we need to survive: engine accepted input, but the
  // browser never receives its acknowledgment. This bridge cannot retry it.
  if(input.operation==='resume'&&Number(dropSequence)===-1&&!reply.error){crash({fault:'lost-resume-reply',version},78);return}
  if(input.operation==='exchange'&&input.input?.sequence===Number(dropSequence)&&reply.input_ack===Number(dropSequence)){
   crash({fault:'accepted-before-ack',sequence:reply.input_ack,version},77);return;
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...reply,bridge_version:version,bridge_pid:process.pid}));
 }catch(e){res.writeHead(502);res.end(JSON.stringify({error:e.message}))}
});
server.listen(Number(port),'127.0.0.1',()=>process.send?.({port:server.address().port,version,pid:process.pid}));
