'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {installTerminal} = require('../agent-terminal');

test('terminal API enforces file quota per session without corrupting existing files', async () => {
  const sessions = new Map([
    ['alpha', {id:'alpha', page:{url:()=> 'about:blank'}}],
    ['beta', {id:'beta', page:{url:()=> 'about:blank'}}],
  ]);
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set('GET '+path, handler); },
    post(path, handler) { routes.set('POST '+path, handler); },
    delete(path, handler) { routes.set('DELETE '+path, handler); },
  };
  installTerminal(app, sessions);
  const handler = routes.get('POST /api/sessions/:id/terminal');
  assert.equal(typeof handler, 'function');
  async function command(id, input) {
    let status = 200, payload;
    const response = {
      status(value) { status = value; return this; },
      json(value) { payload = value; return this; },
    };
    await handler({params:{id}, body:{command:input}}, response);
    return {status, payload};
  }

  for (let i = 0; i < 128; i++) {
    const result = await command('alpha', 'write f'+i+' data');
    assert.equal(result.status, 200, 'file '+i);
  }
  const denied = await command('alpha', 'write extra blocked');
  assert.equal(denied.status, 400);
  assert.match(denied.payload.message, /Maximum virtual workspace files: 128/);
  assert.equal(sessions.get('alpha').terminalFiles.size, 128);

  const replacement = await command('alpha', 'write f0 retained');
  assert.equal(replacement.status, 200);
  assert.equal((await command('alpha', 'cat f0')).payload.output, 'retained');

  const other = await command('beta', 'write extra private');
  assert.equal(other.status, 200);
  assert.equal((await command('beta', 'cat extra')).payload.output, 'private');
  assert.equal((await command('alpha', 'cat extra')).status, 400);

  assert.equal((await command('alpha', 'rm f1')).status, 200);
  assert.equal((await command('alpha', 'write extra restored')).status, 200);
  assert.equal(sessions.get('alpha').terminalFiles.size, 128);
  assert.equal((await command('alpha', 'cat extra')).payload.output, 'restored');
});
