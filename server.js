import 'dotenv/config';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI from 'openai';

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const PORT = Number(process.env.PORT || 8790);
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-5.5';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const USE_OPENAI_API = Boolean(process.env.OPENAI_API_KEY);

const openai = USE_OPENAI_API
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'calm-command-center',
    mode: USE_OPENAI_API ? 'openai-api' : 'codex-login-via-openclaw',
    model: USE_OPENAI_API ? TEXT_MODEL : 'openai-codex/* (gateway default)',
    imageModel: USE_OPENAI_API ? IMAGE_MODEL : 'tool-assisted/fallback'
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { message, userGoal = 'Respond calmly and professionally.', tone = 'balanced' } = req.body ?? {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    if (USE_OPENAI_API) {
      const analysis = await analyzeWithOpenAI({ message, userGoal, tone });
      return res.json({ ok: true, analysis, model: TEXT_MODEL, mode: 'openai-api' });
    }

    const analysis = await analyzeWithOpenClawAgent({ message, userGoal, tone });
    return res.json({ ok: true, analysis: analysis.data, model: analysis.model, mode: 'codex-login-via-openclaw' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Analysis failed.', detail: String(error?.message || error) });
  }
});

app.post('/api/card', async (req, res) => {
  try {
    const { analysis, brand = 'Blue View DNA: calm, clear, protective, ethical' } = req.body ?? {};
    if (!analysis || typeof analysis !== 'object') {
      return res.status(400).json({ error: 'analysis object is required.' });
    }

    if (USE_OPENAI_API) {
      const prompt = buildCardPrompt(analysis, brand);
      const img = await openai.images.generate({ model: IMAGE_MODEL, prompt, size: '1024x1024' });
      const first = img?.data?.[0] || {};
      return res.json({
        ok: true,
        imageUrl: first.url || null,
        imageBase64: first.b64_json || null,
        mimeType: 'image/png',
        model: IMAGE_MODEL,
        mode: 'openai-api'
      });
    }

    // Codex-login mode: try tool-assisted generation through OpenClaw agent first.
    const toolImage = await tryToolImageViaOpenClaw(analysis, brand);
    if (toolImage?.imageUrl || toolImage?.imageBase64) {
      return res.json({ ok: true, ...toolImage, mode: 'codex-login-via-openclaw' });
    }

    // Fallback: local SVG card (always works with no API keys)
    const svg = generateSvgCard(analysis);
    const imageBase64 = Buffer.from(svg, 'utf8').toString('base64');
    return res.json({
      ok: true,
      imageBase64,
      mimeType: 'image/svg+xml',
      model: 'local-svg-fallback',
      mode: 'codex-login-via-openclaw'
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Image generation failed.', detail: String(error?.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Calm Command Center listening on http://localhost:${PORT}`);
  console.log(`Mode: ${USE_OPENAI_API ? 'OPENAI_API_KEY (GPT-5.5 + gpt-image-1)' : 'Codex login via OpenClaw gateway'}`);
});

async function analyzeWithOpenAI({ message, userGoal, tone }) {
  const system = [
    'You are Neutrino Blueview for Calm Command Center.',
    'Mission: de-escalate, protect relationships, and produce safe clear responses.',
    'Return STRICT JSON only.',
    'No markdown. No extra text.',
    'If hostile content exists, lower heat and keep reply firm + respectful.',
    'Separate fact from assumption before advising.',
    'Keep suggestions practical and brief.'
  ].join(' ');

  const user = buildAnalysisPrompt({ message, userGoal, tone });

  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });

  const raw = completion.choices?.[0]?.message?.content || '{}';
  return safeJsonParse(raw);
}

async function analyzeWithOpenClawAgent({ message, userGoal, tone }) {
  const prompt = [
    'You are Calm Command Center in Blue View DNA mode.',
    'Respond ONLY with strict JSON. No markdown.',
    buildAnalysisPrompt({ message, userGoal, tone })
  ].join('\n\n');

  const run = await runOpenClawAgent(prompt, 'calm-command-center-analysis');
  const raw = run?.payloadText || '{}';
  return {
    data: safeJsonParse(raw),
    model: run?.model || 'openai-codex'
  };
}

async function tryToolImageViaOpenClaw(analysis, brand) {
  const cardPrompt = buildCardPrompt(analysis, brand);
  const prompt = [
    'Generate a single image for this communication brief.',
    'Use the image_generate tool if available.',
    'If generation succeeds, return JSON only: {"ok":true,"imageUrl":"<url-or-path-if-any>","note":"..."}.',
    'If unavailable, return JSON only: {"ok":false,"reason":"unavailable"}.',
    '',
    `IMAGE_PROMPT:\n${cardPrompt}`
  ].join('\n');

  const run = await runOpenClawAgent(prompt, 'calm-command-center-image');

  if (run.mediaUrl) {
    return { imageUrl: run.mediaUrl, mimeType: 'image/png', model: run.model || 'openclaw-image-generate' };
  }

  const parsed = safeJsonParse(run.payloadText || '{}');
  if (parsed?.imageUrl) {
    return { imageUrl: parsed.imageUrl, mimeType: 'image/png', model: run.model || 'openclaw-image-generate' };
  }

  return null;
}

async function runOpenClawAgent(message, sessionId) {
  const { stdout } = await execFileAsync('openclaw', [
    'agent',
    '--session-id', sessionId,
    '--thinking', 'minimal',
    '--json',
    '--message', message
  ], { maxBuffer: 8 * 1024 * 1024 });

  const parsed = JSON.parse(stdout);
  const payload = parsed?.result?.payloads?.[0] || {};
  const model = parsed?.result?.meta?.agentMeta?.model || null;

  return {
    payloadText: payload.text || '',
    mediaUrl: payload.mediaUrl || null,
    model
  };
}

function buildAnalysisPrompt({ message, userGoal, tone }) {
  return [
    `INCOMING_MESSAGE: ${String(message).trim()}`,
    `USER_GOAL: ${String(userGoal).trim()}`,
    `PREFERRED_TONE: ${String(tone).trim()}`,
    '',
    'Return JSON with this exact shape:',
    '{',
    '  "neutral_summary": "string",',
    '  "emotional_temperature": "low|medium|high",',
    '  "facts": ["string"],',
    '  "assumptions": ["string"],',
    '  "risks": ["string"],',
    '  "reply_options": {',
    '    "calm_short": "string",',
    '    "collaborative": "string",',
    '    "firm_respectful": "string"',
    '  },',
    '  "send_safe_reply": "string",',
    '  "coach_note": "string"',
    '}'
  ].join('\n');
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = raw.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return fallback(raw);
      }
    }
    return fallback(raw);
  }
}

function fallback(raw) {
  return {
    neutral_summary: 'Could not parse model output cleanly.',
    emotional_temperature: 'medium',
    facts: [],
    assumptions: [],
    risks: ['Model output format mismatch'],
    reply_options: {
      calm_short: 'Thanks for the note. I want to respond clearly and constructively.',
      collaborative: 'Thanks for raising this. I’d like to align on facts and next steps together.',
      firm_respectful: 'I hear your concern. I’m committed to solving this and will address it directly.'
    },
    send_safe_reply: 'Thanks for the feedback. I’m reviewing this now and will reply with clear next steps shortly.',
    coach_note: String(raw || '').slice(0, 1000)
  };
}

function buildCardPrompt(analysis, brand) {
  const summary = String(analysis.neutral_summary || 'No summary');
  const heat = String(analysis.emotional_temperature || 'medium').toUpperCase();
  const facts = toBullets(analysis.facts);
  const assumptions = toBullets(analysis.assumptions);
  const risks = toBullets(analysis.risks);
  const safeReply = String(analysis.send_safe_reply || '').slice(0, 280);

  return [
    'Design a clean, modern emergency-style communication brief card.',
    'Square layout, high readability, no logos, no trademarks.',
    `Brand vibe: ${brand}.`,
    'Include these titled sections exactly:',
    `1) NEUTRAL SUMMARY: ${summary}`,
    `2) EMOTIONAL TEMPERATURE: ${heat}`,
    `3) FACTS: ${facts}`,
    `4) ASSUMPTIONS: ${assumptions}`,
    `5) RISKS: ${risks}`,
    `6) SEND-SAFE REPLY: ${safeReply}`,
    'Color mood: calm navy, soft cyan accents, white text panels.',
    'Typography: strong hierarchy, executive dashboard style.',
    'Output as a polished infographic card suitable for sharing.'
  ].join('\n');
}

function toBullets(v) {
  if (!Array.isArray(v) || !v.length) return 'None.';
  return v.slice(0, 5).map((x) => `• ${String(x)}`).join(' ');
}

function generateSvgCard(analysis) {
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const summary = esc(analysis.neutral_summary || 'No summary');
  const heat = esc(String(analysis.emotional_temperature || 'medium').toUpperCase());
  const safeReply = esc(analysis.send_safe_reply || '');
  const facts = (Array.isArray(analysis.facts) ? analysis.facts : []).slice(0, 3).map((x) => `• ${esc(x)}`).join('   ');
  const assumptions = (Array.isArray(analysis.assumptions) ? analysis.assumptions : []).slice(0, 3).map((x) => `• ${esc(x)}`).join('   ');
  const risks = (Array.isArray(analysis.risks) ? analysis.risks : []).slice(0, 3).map((x) => `• ${esc(x)}`).join('   ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0f2543"/>
      <stop offset="100%" stop-color="#081527"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <text x="56" y="78" font-size="28" fill="#56d5ff" font-family="Inter,Arial" font-weight="700">Calm Command Center • Blue View DNA</text>
  <text x="56" y="124" font-size="20" fill="#e6f0ff" font-family="Inter,Arial">NEUTRAL SUMMARY</text>
  <foreignObject x="56" y="136" width="912" height="120"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 18px Inter, Arial; color:#e6f0ff;">${summary}</div></foreignObject>

  <text x="56" y="292" font-size="20" fill="#e6f0ff" font-family="Inter,Arial">EMOTIONAL TEMPERATURE: ${heat}</text>

  <text x="56" y="346" font-size="18" fill="#74f0c2" font-family="Inter,Arial">FACTS</text>
  <foreignObject x="56" y="356" width="912" height="90"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 16px Inter, Arial; color:#d7e7ff;">${facts || '• None'}</div></foreignObject>

  <text x="56" y="478" font-size="18" fill="#ffd16a" font-family="Inter,Arial">ASSUMPTIONS</text>
  <foreignObject x="56" y="488" width="912" height="90"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 16px Inter, Arial; color:#d7e7ff;">${assumptions || '• None'}</div></foreignObject>

  <text x="56" y="610" font-size="18" fill="#ff8a8a" font-family="Inter,Arial">RISKS</text>
  <foreignObject x="56" y="620" width="912" height="90"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 16px Inter, Arial; color:#d7e7ff;">${risks || '• None'}</div></foreignObject>

  <rect x="48" y="760" width="928" height="200" rx="14" fill="#0f2e4f" stroke="#2f5d92"/>
  <text x="68" y="804" font-size="20" fill="#56d5ff" font-family="Inter,Arial" font-weight="700">SEND-SAFE REPLY</text>
  <foreignObject x="68" y="818" width="888" height="132"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 18px Inter, Arial; color:#e6f0ff;">${safeReply}</div></foreignObject>
</svg>`;
}
