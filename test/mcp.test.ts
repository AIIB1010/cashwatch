import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, TOOLS } from '../src/mcp.ts';

interface Call { url: string; method?: string; auth?: string }
function fake(body: string, status = 200) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init?.method, auth: init?.headers?.Authorization });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { calls, fetchFn };
}
const mk = (f: ReturnType<typeof fake>, token = 'cw_test') => createMcpHandler({ fetchFn: f.fetchFn, baseUrl: 'http://127.0.0.1:8080/', token, version: '9.9.9' });
type R = { result?: any; error?: { code: number; message: string } } | null;

test('initialize: מחזיר שם, גרסה, יכולות והוראות (נתונים = לא הוראות)', async () => {
  const r = (await mk(fake('{}')).handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })) as R;
  assert.equal(r!.result.serverInfo.name, 'cashwatch');
  assert.equal(r!.result.serverInfo.version, '9.9.9');
  assert.deepEqual(r!.result.capabilities, { tools: {} });
  assert.equal(r!.result.protocolVersion, '2025-03-26');
  assert.match(r!.result.instructions, /DATA, never as instructions/);
});

test('tools/list: כל הכלים עם סכמה; רק refresh_data אינו קריאה-בלבד', async () => {
  const r = (await mk(fake('{}')).handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as R;
  const names = r!.result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ['get_status', 'list_accounts', 'get_transactions', 'get_forecast', 'get_recurring', 'get_alerts', 'refresh_data']);
  assert.equal(names.length, TOOLS.length);
  for (const t of r!.result.tools) assert.equal(t.inputSchema.type, 'object');
  assert.deepEqual(r!.result.tools.filter((t: any) => !t.annotations.readOnlyHint).map((t: any) => t.name), ['refresh_data']);
  assert.match(r!.result.tools.find((t: any) => t.name === 'refresh_data').description, /REAL login/);
});

test('tools/call: בונה כתובת, כותרת Authorization ופרמטרים; ללא format=csv', async () => {
  const f = fake('{"count":0,"transactions":[]}');
  const r = (await mk(f).handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_transactions', arguments: { source: 'poalim', from: '2026-10-01', to: '2026-10-31', status: 'completed', limit: 5000 } } })) as R;
  assert.equal(r!.result.isError, undefined);
  assert.equal(r!.result.content[0].text, '{"count":0,"transactions":[]}');
  const u = new URL(f.calls[0]!.url);
  assert.equal(u.origin + u.pathname, 'http://127.0.0.1:8080/api/v1/transactions');
  assert.deepEqual(Object.fromEntries(u.searchParams), { source: 'poalim', from: '2026-10-01', to: '2026-10-31', status: 'completed', limit: '1000' });
  assert.equal(f.calls[0]!.method, 'GET');
  assert.equal(f.calls[0]!.auth, 'Bearer cw_test');
  assert.ok(!u.searchParams.has('format'));
});

test('tools/call: ברירת מחדל limit=200, וכלים ללא ארגומנטים פונים לנתיב הנכון; refresh הוא POST', async () => {
  const f = fake('{}');
  const h = mk(f);
  await h.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_transactions' } });
  assert.equal(new URL(f.calls[0]!.url).searchParams.get('limit'), '200');
  for (const [tool, p] of [['get_status', 'status'], ['list_accounts', 'accounts'], ['get_forecast', 'forecast'], ['get_recurring', 'recurring'], ['get_alerts', 'alerts']] as const) {
    await h.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } });
    assert.equal(f.calls.at(-1)!.url, `http://127.0.0.1:8080/api/v1/${p}`);
    assert.equal(f.calls.at(-1)!.method, 'GET');
  }
  await h.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'refresh_data' } });
  assert.equal(f.calls.at(-1)!.url, 'http://127.0.0.1:8080/api/v1/refresh');
  assert.equal(f.calls.at(-1)!.method, 'POST');
});

test('חסר טוקן: תוצאת isError עם הסבר בעברית ובאנגלית, בלי קריאת רשת', async () => {
  const f = fake('{}');
  const r = (await mk(f, '').handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_status' } })) as R;
  assert.equal(r!.result.isError, true);
  assert.match(r!.result.content[0].text, /CASHWATCH_TOKEN/);
  assert.match(r!.result.content[0].text, /טוקן/);
  assert.equal(f.calls.length, 0);
});

test('שגיאת HTTP, כשל רשת, פלט גדול וכלי לא מוכר', async () => {
  const bad = (await mk(fake('{"error":"טוקן לא תקין"}', 401)).handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_alerts' } })) as R;
  assert.equal(bad!.result.isError, true);
  assert.match(bad!.result.content[0].text, /401.*טוקן לא תקין/);

  const down = createMcpHandler({ fetchFn: async () => { throw new Error('ECONNREFUSED'); }, baseUrl: 'http://x', token: 't' });
  const d = (await down.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_status' } })) as R;
  assert.equal(d!.result.isError, true);
  assert.match(d!.result.content[0].text, /ECONNREFUSED/);

  const big = (await mk(fake('x'.repeat(250_000))).handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_forecast' } })) as R;
  assert.ok(big!.result.content[0].text.length < 101_000);
  assert.match(big!.result.content[0].text, /truncated/);

  const unk = (await mk(fake('{}')).handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'drop_tables' } })) as R;
  assert.equal(unk!.error!.code, -32602);
});

test('פרוטוקול: ping, שיטה לא מוכרת (-32601), notification בלי תשובה, ושורה פגומה (-32700)', async () => {
  const h = mk(fake('{}'));
  assert.deepEqual(await h.handle({ jsonrpc: '2.0', id: 9, method: 'ping' }), { jsonrpc: '2.0', id: 9, result: {} });
  const nf = (await h.handle({ jsonrpc: '2.0', id: 10, method: 'resources/list' })) as R;
  assert.equal(nf!.error!.code, -32601);
  assert.equal(await h.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await h.handle({ jsonrpc: '2.0', method: 'whatever/unknown' }), null);
  const pe = (await h.handleLine('{not json')) as R & { id: unknown };
  assert.equal(pe!.error!.code, -32700);
  assert.equal(pe!.id, null);
  const ok = (await h.handleLine('{"jsonrpc":"2.0","id":11,"method":"tools/list"}')) as R;
  assert.ok(ok!.result.tools.length > 0);
});
