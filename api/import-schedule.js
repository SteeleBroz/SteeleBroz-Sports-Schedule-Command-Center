// In-app schedule import.
// The browser sends a photo, a PDF, or pasted text plus the owner code.
// We check the owner code, ask the Perplexity Agent API to turn the schedule
// into the same CSV the app already parses, and send that CSV back.
// The API key lives only in the server environment (PERPLEXITY_API_KEY).

const SUPABASE_URL = 'https://mdelkultmvadmbkjlpkx.supabase.co';
// Public anon key, the same one the front end already ships in index.html.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWxrdWx0bXZhZG1ia2pscGt4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1NDY1MjYsImV4cCI6MjA5MDEyMjUyNn0.F9RcEGQA9mirNrgIAS5T655Um2043siSHLup1SVjx2A';

const AGENT_URL = 'https://api.perplexity.ai/v1/agent';
// Vision capable fallback chain. If the first model fails, the API tries the next.
const MODELS = ['openai/gpt-5.6-terra', 'anthropic/claude-sonnet-5-5', 'google/gemini-3.8-flash'];

const CSV_HEADER = 'child_name,sport,event_type,chaperone,event_date,event_time,location,day_of_week';
const MAX_IMAGES = 10;
const MAX_TEXT_CHARS = 60000;
const MAX_PROMPT_CHARS = 15000;

// Used only if the browser does not send the prompt (the app always does).
const FALLBACK_PROMPT = `EXTRACT ALL SPORTS EVENTS from this document. Include EVERYTHING - practices, games, tournaments, etc.

FORMAT: Return CSV with these exact headers:
${CSV_HEADER}

Read the actual date numbers on the calendar, include the year in event_date, fill in day_of_week with the full day name for that date, and check that the day name really matches the date. Format times as HH:MM AM or HH:MM PM. Never put a comma inside a field.`;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function todayInNewYork() {
  const now = new Date();
  const long = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(now);
  const year = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(now);
  return { long, year };
}

async function isOwnerCode(code) {
  const url = `${SUPABASE_URL}/rest/v1/schedules?owner_code=eq.${encodeURIComponent(code)}&select=owner_code`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!r.ok) throw new Error(`owner check failed with status ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.some(row => row && row.owner_code === code);
}

function isImageDataUri(s) {
  return typeof s === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s);
}

function isPdfDataUri(s) {
  return typeof s === 'string' && /^data:application\/pdf;base64,/i.test(s);
}

function extractOutputText(data) {
  if (data && typeof data.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of (data && data.output) || []) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.join('\n');
}

// Keep only real CSV rows so notes or code fences from the model never reach the parser.
// Output is the same 8 column CSV the app parses today, with one header line.
function cleanCsv(raw) {
  const rows = [];
  const seen = new Set();
  for (let line of String(raw || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('```')) continue;
    const lower = line.toLowerCase();
    if (lower.includes('child_name') || lower.includes('event_date')) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    if (!/\d/.test(parts[4] || '')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    rows.push(line);
  }
  return rows;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Please use POST.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'We could not read that upload. Please try again.' });
  }

  const ownerCode = String(body.owner_code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(ownerCode)) {
    return sendJson(res, 403, { error: 'Only the schedule owner can import. Please use your owner code.' });
  }

  try {
    if (!(await isOwnerCode(ownerCode))) {
      return sendJson(res, 403, { error: 'Only the schedule owner can import. Please use your owner code.' });
    }
  } catch (err) {
    console.error('[import-schedule] owner check error:', err.message);
    return sendJson(res, 502, { error: 'We could not check your schedule right now. Please try again in a minute.' });
  }

  const images = Array.isArray(body.images) ? body.images.filter(isImageDataUri) : [];
  const pdf = isPdfDataUri(body.pdf) ? body.pdf : null;
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT_CHARS) : '';

  if (images.length > MAX_IMAGES) {
    return sendJson(res, 400, { error: `Please add ${MAX_IMAGES} photos or fewer.` });
  }
  if (!images.length && !pdf && !text) {
    return sendJson(res, 400, { error: 'Please add a photo, a PDF, or some schedule text first.' });
  }

  if (!process.env.PERPLEXITY_API_KEY) {
    console.error('[import-schedule] PERPLEXITY_API_KEY is not set');
    return sendJson(res, 500, { error: 'Schedule reading is not set up yet. Please use Other ways to import for now.' });
  }

  const basePrompt = typeof body.prompt_context === 'string' && body.prompt_context.trim()
    ? body.prompt_context.trim().slice(0, MAX_PROMPT_CHARS)
    : FALLBACK_PROMPT;
  const today = todayInNewYork();
  const prompt = `${basePrompt}

TODAY: Today is ${today.long} (America/New_York). The current year is ${today.year}. Use this to work out the year when the schedule does not print one.

OUTPUT ONLY THE CSV. Start with the header line, then one line per event. Do not add notes, explanations, a list of left out events, or code fences.`;

  const content = [{ type: 'input_text', text: prompt }];
  for (const img of images) content.push({ type: 'input_image', image_url: img });
  if (pdf) content.push({ type: 'input_file', filename: 'schedule.pdf', file_data: pdf });
  if (text) content.push({ type: 'input_text', text: `SCHEDULE TEXT:\n${text}` });

  const kind = pdf ? 'pdf' : images.length ? `photo x${images.length}` : 'text';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  const started = Date.now();

  try {
    const r = await fetch(AGENT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        models: MODELS,
        input: [{ type: 'message', role: 'user', content }],
        max_output_tokens: 8000
      }),
      signal: controller.signal
    });
    const data = await r.json().catch(() => null);
    const cost = data && data.usage && data.usage.cost ? data.usage.cost.total_cost : null;
    console.log(`[import-schedule] owner=${ownerCode} kind=${kind} status=${r.status} model=${data && data.model} total_cost=${cost} ms=${Date.now() - started}`);

    if (!r.ok || !data) {
      const msg = data && data.error ? (data.error.message || JSON.stringify(data.error)) : `status ${r.status}`;
      console.error('[import-schedule] agent error:', String(msg).slice(0, 500));
      return sendJson(res, 502, { error: 'We could not read your schedule this time. Please try again.' });
    }

    const rows = cleanCsv(extractOutputText(data));
    if (!rows.length) {
      return sendJson(res, 200, { csv: '', rows: 0, cost, model: data.model || null,
        error: 'We could not find any events in that. Try a clearer photo, or make sure the whole schedule is in the picture.' });
    }
    return sendJson(res, 200, { csv: [CSV_HEADER, ...rows].join('\n'), rows: rows.length, cost, model: data.model || null });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    console.error(`[import-schedule] owner=${ownerCode} kind=${kind} failed:`, timedOut ? 'timeout' : err.message);
    return sendJson(res, timedOut ? 504 : 502, {
      error: timedOut
        ? 'That took too long. Please try again, or try fewer photos at a time.'
        : 'We could not read your schedule this time. Please try again.'
    });
  } finally {
    clearTimeout(timer);
  }
};
