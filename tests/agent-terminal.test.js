const test=require('node:test');
const assert=require('node:assert/strict');
const {parseCommand,safeFile,isSafeBrowseUrl,isLoopbackOrPrivateV4,isLoopbackOrPrivateV6,execTerminal,installTerminal}=require('../agent-terminal');

test('parser handles quotes and rejects shell multi-lines',()=>{
  assert.deepEqual(parseCommand('fill "input[name=q]" "two words"'),['fill','input[name=q]','two words']);
  assert.throws(()=>parseCommand('open x\nrm bad'));
  assert.throws(()=>parseCommand('open "unterminated'));
  assert.throws(()=>parseCommand(' '));
});

test('URL guard and workspace filenames reject unsafe values',async()=>{
  assert.equal(await isSafeBrowseUrl('https://example.org/path'),'https://example.org/path');
  for(const u of ['file:///etc/passwd','http://localhost:80','http://127.0.0.1','https://u:p@example.org','http://[::1]']) await assert.rejects(isSafeBrowseUrl(u),u);
  // Alternate IPv4 spellings canonicalize to dotted-quad via WHATWG URL
  // parsing and are caught by the same check.
  for(const u of ['http://2130706433/','http://0x7f000001/','http://0177.0.0.1/','http://127.1/','http://0/']) await assert.rejects(isSafeBrowseUrl(u),u);
  // /etc/hosts aliases that resolve to loopback must be caught by the DNS
  // check, not the string check (ip6-localhost/ip6-loopback -> ::1).
  for(const u of ['http://ip6-localhost/','http://ip6-loopback/']) await assert.rejects(isSafeBrowseUrl(u),/Local and raw-IP/,u);
  for(const f of ['../secret','/etc/passwd','a/b','.','..']) assert.throws(()=>safeFile(f),f);
});

test('loopback/private address classification',()=>{
  for(const a of ['127.0.0.1','127.53.1.2','10.0.0.5','172.16.0.1','172.31.255.255','192.168.1.1','169.254.169.254','0.0.0.0']) assert.equal(isLoopbackOrPrivateV4(a),true,a);
  for(const a of ['8.8.8.8','1.1.1.1','93.184.216.34','172.32.0.1','192.169.0.1']) assert.equal(isLoopbackOrPrivateV4(a),false,a);
  for(const a of ['::1','::','fe80::1','febf::1','fc00::1','fd12:3456::1','::ffff:127.0.0.1','::ffff:10.0.0.1']) assert.equal(isLoopbackOrPrivateV6(a),true,a);
  for(const a of ['2001:4860:4860::8888','2606:4700:4700::1111','::ffff:8.8.8.8','fec0::1']) assert.equal(isLoopbackOrPrivateV6(a),false,a);
});

function mockSession(){
  const state={url:'about:blank',title:'Untitled',text:'Initial',clicked:'',filled:''};
  const page={
    url(){return state.url;},
    async goto(url){state.url=url;state.title='Real example page';state.text='Fetched and rendered';},
    async title(){return state.title;},
    locator(sel){return {
      async innerText(){return state.text;},
      async click(){state.clicked=sel;},
      async fill(txt){state.filled=txt;},
      async press(key){state.pressed=key;},
    };},
    mouse:{async wheel(_x,y){state.scrolled=y;}},
    async screenshot(){return Buffer.from('\x89PNGsomebinary');}
  };
  return {session:{id:'agent-001',name:'Agent 001',profile:null,page},state};
}

test('real page commands dispatch to Playwright session methods',async()=>{
  const {session,state}=mockSession();
  assert.match((await execTerminal(session,'open https://example.org')).output,/Real example page/);
  assert.equal(state.url,'https://example.org/');
  assert.match((await execTerminal(session,'read')).output,/Fetched and rendered/);
  await execTerminal(session,'click "button#go"');assert.equal(state.clicked,'button#go');
  await execTerminal(session,'fill "input" "hello world"');assert.equal(state.filled,'hello world');
  await execTerminal(session,'press "input" Enter');assert.equal(state.pressed,'Enter');
  await execTerminal(session,'scroll 345');assert.equal(state.scrolled,345);
  const image=await execTerminal(session,'screenshot');assert.match(image.screenshotUrl,/agent-001/);
});

test('workspace is virtual and isolated by session',async()=>{
  const a=mockSession().session,b=mockSession().session;
  await execTerminal(a,'write notes.txt "my notes"');
  assert.equal((await execTerminal(a,'cat notes.txt')).output,'my notes');
  assert.equal((await execTerminal(b,'ls')).output,'(empty workspace)');
  await assert.rejects(()=>execTerminal(a,'sh -c pwd'),/Unsupported command/);
  await assert.rejects(()=>execTerminal(a,'cat ../.env'),/simple workspace filename/);
});

test('API attaches terminal operations to existing sessions',async()=>{
  const {session}=mockSession();
  const store=new Map([[session.id,session]]), handlers=new Map();
  const app={get(path,fn){handlers.set('GET'+path,fn)},post(path,fn){handlers.set('POST'+path,fn)},delete(path,fn){handlers.set('DELETE'+path,fn)}};
  installTerminal(app,store);
  const req={params:{id:'agent-001'},body:{command:'help'}};
  let json;
  const res={status(code){this.code=code;return this},json(obj){json=obj;return this}};
  await handlers.get('POST/api/sessions/:id/terminal')(req,res);
  assert.equal(json.ok,true);assert.equal(session.terminalHistory.length,1);
  handlers.get('GET/api/sessions/:id/terminal/history')(req,res);
  assert.equal(json.entries.length,1);
  handlers.get('DELETE/api/sessions/:id/terminal/history')(req,res);
  assert.equal(session.terminalHistory.length,0);
});
