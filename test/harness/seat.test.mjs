import test from 'node:test';
import assert from 'node:assert/strict';
import { RulithMcp } from '../../harness/rulith-mcp.mjs';

// A Gateway that answers initialize and records what the client declared.
function fakeGateway() {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const headers = new Headers({ 'content-type': 'application/json', 'mcp-session-id': 's-1' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', _meta: { 'rulith/v3': { agentId: 'agent-1' } } } }), { status: 200, headers });
  };
  return { seen, fetchImpl };
}

test('the main seat declares nothing, so an older Gateway accepts it as before', async () => {
  const gateway = fakeGateway();
  await new RulithMcp({ url: 'http://127.0.0.1:9/mcp', token: 't', fetchImpl: gateway.fetchImpl }).initialize();
  assert.deepEqual(gateway.seen[0].params.capabilities, {});
});

test('another seat is declared once, at initialize, in the rulith/v3 capabilities', async () => {
  const gateway = fakeGateway();
  await new RulithMcp({ url: 'http://127.0.0.1:9/mcp', token: 't', seat: 'reviewer', fetchImpl: gateway.fetchImpl }).initialize();
  assert.deepEqual(gateway.seen[0].params.capabilities, { experimental: { 'rulith/v3': { seat: 'reviewer' } } });
});

test('a malformed seat name is refused before anything is sent', () => {
  assert.throws(() => new RulithMcp({ url: 'http://127.0.0.1:9/mcp', token: 't', seat: 'Reviewer!' }), /seat refused/);
});
