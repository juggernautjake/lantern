/* ===========================================================================
   server/src/ai/stream.js — the streaming half of the client.
   ---------------------------------------------------------------------------
   Waiting eight seconds for a paragraph feels broken even when it is not, and
   an assistant that searches the web can take considerably longer than eight
   seconds. So the same loop can run streamed, emitting text as it is written
   and saying what it is doing while it does it.

   The hard part is not the parsing, it is that the loop still needs the
   COMPLETE assistant message afterwards: web search results carry
   `encrypted_content` that the API requires back verbatim on the next turn,
   so a message rebuilt from its visible text would break the conversation on
   the following request. This file therefore does two things at once —
   reports deltas as they arrive, and reassembles the exact content-block array
   the non-streaming endpoint would have returned.

   Event shapes are the documented ones: message_start, content_block_start,
   content_block_delta (text_delta, input_json_delta, citations_delta),
   content_block_stop, message_delta, message_stop, ping, error.
   =========================================================================== */

/* Read when the call is made, not when the module loads: boot() reads .env
   after the imports have run, and a test that points at a stub must not find
   the address already frozen. */
const base = () => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const VERSION = '2023-06-01';

/* Run one streamed request.

     body     the same body the non-streaming call takes
     on       (event) => void, called with:
                { type: 'text',   text }        a fragment to show now
                { type: 'tool',   name, id }    the model started calling a tool
                { type: 'search', query }       a web search began
                { type: 'stop',   reason }
                { type: 'error',  message }

   Resolves with { content, stop_reason, usage } — the same shape as a
   non-streaming response. */
export async function streamMessages(body, on, opts) {
  const o = opts || {};
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error('The assistant is not configured on this server.'); e.status = 503; throw e; }

  const res = await fetch(base() + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': VERSION,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(Object.assign({}, body, { stream: true })),
    signal: o.signal || AbortSignal.timeout(Number(process.env.LANTERN_AI_TIMEOUT || 180000)),
  });

  if (!res.ok) {
    const text = await res.text();
    const e = new Error('Model API ' + res.status + ': ' + text.slice(0, 400));
    e.status = res.status;
    throw e;
  }

  const blocks = [];
  const partialJson = {};
  let stopReason = null;
  let usage = {};

  await readSSE(res.body, (event, data) => {
    switch (event) {
      case 'message_start':
        usage = Object.assign({}, (data.message && data.message.usage) || {});
        break;

      case 'content_block_start': {
        const b = JSON.parse(JSON.stringify(data.content_block || {}));
        blocks[data.index] = b;
        if (b.type === 'text' && b.text === undefined) b.text = '';
        if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          partialJson[data.index] = '';
          on({ type: 'tool', name: b.name, id: b.id });
        }
        // A web search result arrives complete, encrypted_content and all.
        if (b.type === 'web_search_tool_result') {
          const n = Array.isArray(b.content) ? b.content.length : 0;
          on({ type: 'results', count: n,
            error: (!Array.isArray(b.content) && b.content && b.content.error_code) || null });
        }
        break;
      }

      case 'content_block_delta': {
        const d = data.delta || {};
        const b = blocks[data.index] || (blocks[data.index] = { type: 'text', text: '' });
        if (d.type === 'text_delta') {
          b.text = (b.text || '') + d.text;
          on({ type: 'text', text: d.text });
        } else if (d.type === 'input_json_delta') {
          partialJson[data.index] = (partialJson[data.index] || '') + (d.partial_json || '');
          // The search query is the one tool input worth showing live.
          const q = /"query"\s*:\s*"([^"]{0,120})/.exec(partialJson[data.index]);
          if (q && !b.__announced) { b.__announced = true; on({ type: 'search', query: q[1] }); }
        } else if (d.type === 'citations_delta' && d.citation) {
          b.citations = (b.citations || []).concat([d.citation]);
        } else if (d.type === 'thinking_delta' || d.type === 'signature_delta') {
          // carried through untouched so the block replays exactly
          if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
          else b.signature = d.signature;
        }
        break;
      }

      case 'content_block_stop': {
        const b = blocks[data.index];
        if (b && partialJson[data.index] !== undefined) {
          try { b.input = partialJson[data.index] ? JSON.parse(partialJson[data.index]) : {}; }
          catch (e) { b.input = {}; }
          delete partialJson[data.index];
        }
        if (b) delete b.__announced;
        break;
      }

      case 'message_delta':
        if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
        if (data.usage) usage = Object.assign(usage, data.usage);
        break;

      case 'message_stop':
        break;

      case 'error':
        on({ type: 'error', message: (data.error && data.error.message) || 'the stream failed' });
        break;

      default: break;   // ping, and anything added later
    }
  });

  if (stopReason) on({ type: 'stop', reason: stopReason });
  return { content: blocks.filter(Boolean), stop_reason: stopReason, usage };
}

/* Server-sent events off a fetch body. Frames are separated by a blank line;
   a frame may carry several data: lines, which are joined with newlines. */
async function readSSE(stream, onFrame) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let split;
    while ((split = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, split);
      buf = buf.slice(split + 2);
      let event = 'message';
      const dataLines = [];
      frame.split('\n').forEach((line) => {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      });
      if (!dataLines.length) continue;
      let data;
      try { data = JSON.parse(dataLines.join('\n')); } catch (e) { continue; }
      onFrame(event, data);
    }
  }
}

/* ------------------------------------------------------------ downstream --- */

/* The other half: writing SSE to our own client. Kept here so the wire format
   the browser sees is defined in one place next to the one we consume. */
export function sseWriter(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',      // nginx would otherwise hold the whole thing
  });
  let open = true;
  res.on('close', () => { open = false; });
  return {
    send(type, payload) {
      if (!open) return false;
      res.write('event: ' + type + '\n');
      res.write('data: ' + JSON.stringify(payload === undefined ? {} : payload) + '\n\n');
      return true;
    },
    get open() { return open; },
    end() { if (open) { res.end(); open = false; } },
  };
}
