#!/usr/bin/env node
/**
 * mock-openai-toolcall.mjs —— 离线验证「插件工具能不能注册/执行」的最小 OpenAI 兼容服务。
 *
 * 为什么需要：真机 headless 要跑一轮 tool-call 得有可用模型凭据；凭据失效时
 * 整条链路就停在 MISSING_CREDENTIAL，看不到 tools.register 是否兼容。
 * 这个 mock 让引擎以为模型回了 tool_calls，从而把工具真正执行一遍：
 *   第 1 次请求（无 tools 字段，标题/预热）→ 回纯文本 ok
 *   第 2 次请求（带 tools、无 tool 结果）→ 回 tool_calls，调用 MOCK_TOOL
 *   第 3 次请求（带 tool 结果）        → 把工具输出回显成最终文本
 *
 * 用法（与 headless 同机）：
 *   node tools/mock-openai-toolcall.mjs &
 *   MOCK_TOOL=shell MOCK_ARGS='{"command":"id"}' \
 *     node .../bin.js --profile headless --patch mock.patch.yml --json "用 shell 执行 id"
 *
 * patch 里 provider 的 baseURL 填 http://127.0.0.1:3099/v1，apiKeyEnv 任意（MOCK_KEY=dummy）。
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 3099);
const TOOL = process.env.MOCK_TOOL || 'shell';
const ARGS = process.env.MOCK_ARGS || JSON.stringify({ command: 'id' });
const LOG = process.env.MOCK_LOG || '';
const log = (m) => { if (LOG) { try { fs.appendFileSync(LOG, m + '\n'); } catch {} } };

const srv = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end('no'); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const msgs = j.messages || [];
    const toolResults = msgs.filter((m) => m.role === 'tool');
    const tools = j.tools || [];
    log(`REQ msgs=${msgs.length} tools=${tools.length} results=${toolResults.length} names=${tools.map((t) => t.function && t.function.name).join(',')}`);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const base = (delta, finish) => ({
      id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    });
    const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

    if (tools.length === 0) {
      send(base({ role: 'assistant', content: '' }));
      send(base({ content: 'ok' }));
      send(base({}, 'stop'));
      log('SENT plain ok (request has no tools)');
      return done();
    }
    if (toolResults.length === 0) {
      send(base({ role: 'assistant', content: '' }));
      send(base({ tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: TOOL, arguments: ARGS } }] }));
      send(base({}, 'tool_calls'));
      log(`SENT tool_call ${TOOL} ${ARGS}`);
      return done();
    }
    const last = toolResults[toolResults.length - 1];
    const text = 'TOOL_RESULT_BEGIN\n' + String(last.content || '').slice(0, 1200) + '\nTOOL_RESULT_END';
    send(base({ role: 'assistant', content: '' }));
    send(base({ content: text }));
    send(base({}, 'stop'));
    log('SENT final len=' + text.length);
    done();
  });
});
srv.listen(PORT, '127.0.0.1', () => log('listening ' + PORT));
