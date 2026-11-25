'use strict';
// BrowserBro's per-session browser terminal. These are REAL Playwright actions,
// not a host shell. Keep untrusted agents away from host OS commands.
const { lookup } = require('node:dns').promises;
const HELP = `BrowserBro Agent Terminal (sandboxed commands, no OS shell)

open https://example.org       Navigate in real Chromium
browse <url>                   Alias for open
read                           Read rendered page text
url | title                    Read current page URL / title
click <css>                    Click a selector
fill <css> <text>              Fill a field
press <css> <key>              Press a key, e.g. Enter
scroll <pixels>                Scroll the page
screenshot                     Capture screenshot (live browser panel)
status                         Browser and session status
pwd | ls | cat <file>          Agent-private virtual files
write <file> <text>            Write a virtual text file (max 32 KiB)
append <file> <text>           Append text
rm <file>                      Remove a file
help                           Show this help

No arbitrary Linux shell, pipes, subprocesses, sudo, or JS eval.`;

function parseCommand(input) {
  if (typeof input !== 'string' || input.length > 2048 || !input.trim()) throw new Error('Command must be 1–2048 characters');
  if (/[\r\n\0]/.test(input)) throw new Error('Multi-line commands are blocked');
  const parts = [];
  const regex = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"']+)/g;
  let m, consumed = '';
  while ((m = regex.exec(input)) !== null) {
    if (input.slice(consumed.length, m.index).trim()) throw new Error('Invalid command quoting');
    consumed = input.slice(0, regex.lastIndex);
    const part = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    parts.push(part.replace(/\\(["'\\])/g, '$1'));
  }
  if (input.slice(consumed.length).trim() || !parts.length) throw new Error('Invalid command quoting');
  return parts;
}

function safeFile(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(name) || name === '.' || name === '..') {
    throw new Error('Use a simple workspace filename (letters, numbers, dot, dash or underscore)');
  }
  return name;
}
function isLoopbackOrPrivateV4(addr) {
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const inRange = (base, bits) => (n >>> (32 - bits)) === (base >>> (32 - bits));
  return n === 0 // 0.0.0.0/32 unspecified
    || inRange(0x7f000000, 8) // 127.0.0.0/8 loopback
    || inRange(0x0a000000, 8) // 10.0.0.0/8 private
    || inRange(0xac100000, 12) // 172.16.0.0/12 private
    || inRange(0xc0a80000, 16) // 192.168.0.0/16 private
    || inRange(0xa9fe0000, 16); // 169.254.0.0/16 link-local
}
function isLoopbackOrPrivateV6(addr) {
  let a = addr.toLowerCase();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isLoopbackOrPrivateV4(mapped[1]); // IPv4-mapped IPv6
  if (a === '::1' || a === '::') return true; // loopback / unspecified
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // fe80::/10 link-local
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // fc00::/7 unique-local
  return false;
}
// String checks alone cannot catch hostnames that resolve to loopback via
// /etc/hosts aliases (ip6-localhost, ip6-loopback) or a local resolver, so
// resolve the name and check the real addresses too. A lookup failure is
// fail-closed: the browser would not resolve it either.
// Residual risk, stated honestly: DNS rebinding between this check and the
// browser's own lookup can still swap in a local address; fully closing
// that needs a pinning resolver or proxy, not a string check.
async function isSafeBrowseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Use a valid http:// or https:// URL'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Only public HTTP/HTTPS URLs without embedded credentials are allowed');
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) {
    throw new Error('Local and raw-IP targets are unavailable in agent terminal');
  }
  let addrs;
  try {
    addrs = await lookup(h, { all: true });
  } catch {
    throw new Error('Could not resolve hostname');
  }
  for (const a of addrs) {
    const blocked = a.family === 4 ? isLoopbackOrPrivateV4(a.address)
      : a.family === 6 ? isLoopbackOrPrivateV6(a.address) : false;
    if (blocked) throw new Error('Local and raw-IP targets are unavailable in agent terminal');
  }
  return u.href;
}
function publicText(raw) { return String(raw || '').slice(0, 11000); }
async function execTerminal(session, input) {
  const [rawCommand, ...args] = parseCommand(input);
  const cmd = rawCommand.toLowerCase();
  const page = session.page;
  if (!page) throw new Error('Session browser is not ready');
  if (cmd === 'help') return { output: HELP };
  if (cmd === 'status') return { output: `Session: ${session.id}\nBrowser: Chromium\nCurrent URL: ${page.url()}\nProfile: ${session.profile || '(ephemeral)'}` };
  if (cmd === 'url') return { output: page.url() };
  if (cmd === 'title') return { output: await page.title() };
  if (cmd === 'read') return { output: `URL: ${page.url()}\nTitle: ${await page.title()}\n\n${publicText(await page.locator('body').innerText({timeout:5000}))}` };
  if (cmd === 'open' || cmd === 'browse') {
    if (args.length !== 1) throw new Error('Usage: open https://example.org');
    const url = await isSafeBrowseUrl(args[0]);
    await page.goto(url, {waitUntil:'domcontentloaded', timeout:30000});
    return { output: `Loaded: ${page.url()}\nTitle: ${await page.title()}`, url:page.url(), browserChanged:true };
  }
  if (cmd === 'click') {
    if (args.length !== 1) throw new Error("Usage: click 'CSS selector'");
    await page.locator(args[0]).click({timeout:12000});
    return {output:`Clicked ${args[0]}\nURL: ${page.url()}`, url:page.url(), browserChanged:true};
  }
  if (cmd === 'fill' || cmd === 'press') {
    if (args.length < 2) throw new Error(`Usage: ${cmd} 'CSS selector' 'text or key'`);
    const selector=args[0], value=args.slice(1).join(' ');
    if (cmd==='fill') await page.locator(selector).fill(value, {timeout:12000});
    else await page.locator(selector).press(value, {timeout:12000});
    return {output:`${cmd==='fill'?'Filled':'Pressed key on'} ${selector}\nURL: ${page.url()}`, url:page.url(), browserChanged:true};
  }
  if (cmd==='scroll') {
    const y=Number(args[0]);
    if (args.length!==1 || !Number.isInteger(y) || Math.abs(y)>5000) throw new Error('Usage: scroll <integer pixels from -5000 to 5000>');
    await page.mouse.wheel(0, y);
    return {output:`Scrolled ${y} px`,url:page.url(),browserChanged:true};
  }
  if (cmd==='screenshot') {
    const png=await page.screenshot({type:'png',timeout:15000});
    return {output:`Captured real Chromium screenshot (${png.length} bytes).`,screenshotUrl:`/api/sessions/${encodeURIComponent(session.id)}/screenshot`,browserChanged:true};
  }
  // In-memory virtual workspace attached to this session: never host filesystem.
  if (!session.terminalFiles) session.terminalFiles = new Map();
  const files=session.terminalFiles;
  if (cmd==='pwd') return {output:`/agents/${session.id}/workspace (virtual)`};
  if (cmd==='ls') return {output:[...files.keys()].sort().join('\n') || '(empty workspace)'};
  if (cmd==='cat') { if(args.length!==1) throw new Error('Usage: cat filename');const name=safeFile(args[0]);if(!files.has(name)) throw new Error('File not found');return {output:files.get(name)}; }
  if (cmd==='rm') { if(args.length!==1) throw new Error('Usage: rm filename');files.delete(safeFile(args[0]));return {output:'File removed (if present)'}; }
  if (cmd==='write'||cmd==='append') {
    if (args.length<2) throw new Error(`Usage: ${cmd} filename 'text'`);
    const name=safeFile(args[0]), data=(cmd==='append'?files.get(name)||'':'')+args.slice(1).join(' ');
    if (Buffer.byteLength(data,'utf8')>32768) throw new Error('Maximum virtual file size: 32 KiB');
    files.set(name,data); return {output:`Saved ${Buffer.byteLength(data,'utf8')} bytes to ${name}`};
  }
  throw new Error(`Unsupported command: ${rawCommand}. Type help. This is not a host Linux shell.`);
}

function installTerminal(app, sessions) {
  app.get('/api/sessions/:id/terminal/history', (req,res) => {
    const session=sessions.get(req.params.id);
    if(!session) return res.status(404).json({ok:false,error:'session_not_found'});
    res.json({ok:true,entries:session.terminalHistory||[]});
  });
  app.delete('/api/sessions/:id/terminal/history', (req,res) => {
    const session=sessions.get(req.params.id);
    if(!session) return res.status(404).json({ok:false,error:'session_not_found'});
    session.terminalHistory=[]; res.json({ok:true});
  });
  app.post('/api/sessions/:id/terminal', async (req,res) => {
    const session=sessions.get(req.params.id);
    if(!session) return res.status(404).json({ok:false,error:'session_not_found'});
    const command=req.body && req.body.command;
    try {
      const output=await execTerminal(session,command);
      const row={command,output:publicText(output.output),createdAt:Date.now(),exitCode:0};
      session.terminalHistory=(session.terminalHistory||[]).concat([row]).slice(-80);
      res.json({ok:true,...output});
    } catch(err) {
      const message=String(err && err.message || err).slice(0,1000);
      const row={command:String(command||'').slice(0,2048),output:message,createdAt:Date.now(),exitCode:1};
      session.terminalHistory=(session.terminalHistory||[]).concat([row]).slice(-80);
      res.status(400).json({ok:false,error:'terminal_command_failed',message});
    }
  });
}
module.exports={HELP,parseCommand,safeFile,isSafeBrowseUrl,isLoopbackOrPrivateV4,isLoopbackOrPrivateV6,execTerminal,installTerminal};
