const test=require('node:test');
const assert=require('node:assert/strict');
const {parseCommand,safeFile,isSafeBrowseUrl,execTerminal,installTerminal}=require('../agent-terminal');

test('parser handles quotes and rejects shell multi-lines',()=>{
  assert.deepEqual(parseCommand('fill "input[name=q]" "two words"'),['fill','input[name=q]','two words']);
  assert.throws(()=>parseCommand('open x\nrm bad'));
  assert.throws(()=>parseCommand('open "unterminated'));
  assert.throws(()=>parseCommand(' '));
});

test('URL guard and workspace filenames reject unsafe values',()=>{
  assert.equal(isSafeBrowseUrl('https://example.org/path'),'https://example.org/path');
  for(const u of ['file:///etc/passwd','http://localhost:80','http://127.0.0.1','https://u:p@example.org','http://[::1]']) assert.throws(()=>isSafeBrowseUrl(u),u);
  for(const f of ['../secret','/etc/passwd','a/b','.','..']) assert.throws(()=>safeFile(f),f);
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

test('virtual workspace caps file count but allows replacement and reuse',async()=>{
  const {session}=mockSession();
  for(let i=0;i<128;i++) await execTerminal(session,`write file${i}.txt data`);
  assert.equal(session.terminalFiles.size,128);
  await assert.rejects(()=>execTerminal(session,'write overflow.txt data'),/Maximum virtual workspace files: 128/);
  assert.equal(session.terminalFiles.has('overflow.txt'),false);
  await execTerminal(session,'write file0.txt replaced');
  assert.equal((await execTerminal(session,'cat file0.txt')).output,'replaced');
  await execTerminal(session,'rm file1.txt');
  await execTerminal(session,'write overflow.txt data');
  assert.equal(session.terminalFiles.size,128);
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

test('quota rejection is isolated between sessions and preserves existing content',async()=>{
  const a=mockSession().session,b=mockSession().session;
  await execTerminal(a,'write keep.txt original');
  for(let i=1;i<128;i++) await execTerminal(a,`write file${i}.txt data`);
  await assert.rejects(()=>execTerminal(a,'append new.txt rejected'),/Maximum virtual workspace files: 128/);
  assert.equal((await execTerminal(a,'cat keep.txt')).output,'original');
  assert.equal(a.terminalFiles.size,128);
  await execTerminal(b,'write new.txt private');
  assert.equal((await execTerminal(b,'cat new.txt')).output,'private');
  assert.equal(b.terminalFiles.size,1);
  await assert.rejects(()=>execTerminal(a,'cat new.txt'),/File not found/);
});
