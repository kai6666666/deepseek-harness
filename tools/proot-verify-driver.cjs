#!/usr/bin/env node
// proot-verify-driver.cjs —— 设备侧验收（0.2.2-rc.3-debug / PRoot 单运行时）
//
// ⚠️ 判据按“运行时分线”：
//   · PRoot 单运行时：guest 是 Ubuntu，process.platform=linux、/bin/bash 存在、
//     flock 走 linux 分支 —— bionic 时代那五项 Kotlin 补丁（flock/terminal-shell/
//     fail-loud×2/attachment-fsync）在这里**本来就不适用**，不能拿它们判失败。
//   · 真正必须绿的：引擎版本、IMG_TYPE 放宽（构建期补丁）、关键文件、flock 可加载。
//   · platform=android 时（bionic 旧包）才回落到五点补丁检查。
'use strict';
const fs=require('fs');
const D='/opt/dsh/node_modules/@deepseek-ai';
const R=f=>{try{return fs.readFileSync(f,'utf8')}catch(e){return ''}};
const out=[];
const log=(k,v)=>{out.push(k+'='+v);console.log(k+'='+v)};

log('platform',process.platform);
log('arch',process.arch);
let engine='ERR';
try{engine=require(D+'/dsh/package.json').version}catch(e){}
log('engine',engine);
const conv=R(D+'/dsh-client-ui-conversation/lib/client.js');
const relaxed=conv.includes('return value.startsWith(`image/`)');
log('img_type',relaxed?'relaxed':'orig');
const F=['/usr/bin/node','/usr/local/bin/dsh','/usr/local/bin/pnpm','/usr/bin/git','/usr/bin/python3','/usr/bin/curl','/etc/ssl/certs/ca-certificates.crt'];
const files=F.filter(f=>{try{return fs.statSync(f).size>0}catch(e){return false}}).length;
log('files',files+'/'+F.length);
log('office_kit',fs.existsSync(D+'/dsh-office-kit/package.json')?'present':'missing');
log('bash',fs.existsSync('/bin/bash')?'yes':'no');

(async()=>{
 let flock='ERR';
 try{await import('file://'+D+'/node-addon-system/lib/flock.js');flock='loadable'}catch(e){flock=(e&&e.code)?e.code:'ERR'}
 log('flock',flock);
 let ok;
 if(process.platform==='linux'){
  ok=(engine==='0.2.2-rc.3'&&relaxed&&files===F.length&&flock==='loadable');
  log('mode','proot-single-runtime');
 }else{
  const C=[[D+'/node-addon-system/lib/flock.js',["'android'"],[]],[D+'/dsh-app-boot/lib/index.js',['DSH-ANDROID-KEEP-ALIVE'],['proc.exit(1);']],[D+'/dsh-terminal-bash/lib/index.js',['DEFAULT_BASH_SHELL = process.env.PREFIX'],[]],[D+'/dsh-attachment-local/lib/index.js',['Android:祖先目录'],[]]];
  let m=0;
  for(const [f,h,l] of C){const t=R(f);if(t&&h.every(s=>t.includes(s))&&l.every(s=>!t.includes(s)))m++}
  log('patch-marks',m+'/4');
  log('mode','bionic');
  ok=(engine==='0.2.2-rc.3'&&relaxed&&files===F.length&&m===4);
 }
 log('RESULT',ok?'PASS':'FAIL');
 process.exit(ok?0:1);
})();
