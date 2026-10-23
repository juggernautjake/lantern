/* ===========================================================================
   server/src/assistant/teach/stream.js — Claude's Messages API, streamed.
   ---------------------------------------------------------------------------
   messagesStream(L, fetchFn, key, body, { onText, timeoutMs }) → the same
   message object L.messages() returns ({ content, stop_reason, usage }), but
   text reaches onText(chunk) as the model writes it, so the learner reads and
   the cues fire while the rest is still coming. The vendored client
   (vendor/ecosystem-core) is fetch-only and has no streaming; this is the one
   streaming call, and it falls back to a whole JSON message when the server
   answers with one (a test double, a proxy).
   =========================================================================== */

export async function messagesStream(L, fetchFn, key, body, opts) {
  const o = opts || {};
  const res = await fetchFn(`${L.baseUrl('anthropic')}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' },
    body: JSON.stringify({ model: L.modelName(), ...body, stream: true }),
    signal: AbortSignal.timeout(o.timeoutMs || 60000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error('Anthropic ' + res.status + (t ? ': ' + t.slice(0, 200) : ''));
    e.status = res.status;
    throw e;
  }
  const type = String(res.headers.get('content-type') || '');
  if (!/event-stream/i.test(type) || !res.body) {
    const m = await res.json();
    for (const b of m.content || []) if (b.type === 'text' && b.text && o.onText) o.onText(b.text);
    return m;
  }
  const msg = { content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } };
  const blocks = [];
  const dec = new TextDecoder();
  let buf = '';
  const apply = (ev) => {
    switch (ev.type) {
      case 'message_start': Object.assign(msg.usage, (ev.message && ev.message.usage) || {}); break;
      case 'content_block_start': {
        const b = Object.assign({}, ev.content_block);
        if (b.type === 'text') b.text = b.text || '';
        if (b.type === 'tool_use' || b.type === 'server_tool_use') { b._json = ''; b.input = b.input || {}; }
        blocks[ev.index] = b;
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index], d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta') { b.text += d.text; if (o.onText) o.onText(d.text); }
        else if (d.type === 'input_json_delta') b._json += d.partial_json || '';
        else if (d.type === 'citations_delta') (b.citations = b.citations || []).push(d.citation);
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b && b._json !== undefined) { try { b.input = b._json ? JSON.parse(b._json) : {}; } catch (e) { b.input = {}; } delete b._json; }
        break;
      }
      case 'message_delta':
        if (ev.delta && ev.delta.stop_reason) msg.stop_reason = ev.delta.stop_reason;
        if (ev.usage) Object.assign(msg.usage, ev.usage);
        break;
      case 'error': throw new Error((ev.error && ev.error.message) || 'The AI stream failed.');
      default: break;
    }
  };
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { apply(JSON.parse(line.slice(5).trim())); } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e; }
    }
  }
  msg.content = blocks.filter(Boolean);
  return msg;
}
