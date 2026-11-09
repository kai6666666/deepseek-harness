const net=require("net");
const p0=Number(process.env.P0||0);
const tryOne=(p)=>new Promise((r)=>{const s=net.createServer();
  s.once("error",()=>r(false));
  s.listen(p,"127.0.0.1",()=>s.close(()=>r(true)));});
(async()=>{for(let p=p0;p<p0+20;p++){if(await tryOne(p)){console.log(p);process.exit(0)}}
  process.exit(1)})();
