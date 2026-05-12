import 'dotenv/config';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import OpenAI from 'openai';

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.text({ type: ['application/sdp', 'text/plain'], limit: '1mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const PORT = Number(process.env.PORT || 8790);
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-5.5';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'marin';

const USE_OPENAI_API = Boolean(process.env.OPENAI_API_KEY);
const ENABLE_NEUTRINORTC = String(process.env.ENABLE_NEUTRINORTC ?? 'true') !== 'false';
const DEFAULT_ANALYZE_BACKEND = process.env.ANALYZE_BACKEND || (ENABLE_NEUTRINORTC ? 'neutrinortc' : (USE_OPENAI_API ? 'openai-api' : 'openclaw-agent'));

const NEUTRINORTC_URL = process.env.NEUTRINORTC_URL || 'http://127.0.0.1:8788/v1/brain/turn';
const NEUTRINORTC_HEALTH_URL = process.env.NEUTRINORTC_HEALTH_URL || 'http://127.0.0.1:8788/healthz';
const NEUTRINORTC_VOICE = process.env.NEUTRINORTC_VOICE || 'marin';

const openai = USE_OPENAI_API ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const turnBySession = new Map();

const DEMO_SCENARIOS = [
  {
    id: 'missed-deadline',
    title: 'Missed deadline escalation',
    tone: 'balanced',
    goal: 'Acknowledge the concern, reset expectations, and preserve trust.',
    message: 'This is the third time the deliverable slipped. I am tired of excuses. If this is not fixed today I am escalating to leadership and asking for a new owner.'
  },
  {
    id: 'customer-refund',
    title: 'Angry customer refund',
    tone: 'warm',
    goal: 'Validate the frustration, avoid blame, and move toward a clear next step.',
    message: 'Your team completely wasted my time. I paid for this and got nothing useful. Refund me now or I am posting screenshots everywhere.'
  },
  {
    id: 'boundary-setting',
    title: 'Boundary with teammate',
    tone: 'firm',
    goal: 'Set a respectful boundary while keeping collaboration possible.',
    message: 'You keep dumping last-minute work on me and then acting like I am the blocker. I am not cleaning this up again unless you own your part.'
  }
];


app.get('/healthz', async (_req, res) => {
  const rtcHealthy = ENABLE_NEUTRINORTC ? await checkRtcHealth() : false;
  res.json({
    ok: true,
    service: 'calm-command-center',
    defaultAnalyzeBackend: DEFAULT_ANALYZE_BACKEND,
    availableBackends: {
      neutrinoRtc: rtcHealthy,
      openaiApi: USE_OPENAI_API,
      openclawAgent: true
    },
    mode: USE_OPENAI_API ? 'openai-api-enabled' : 'codex-login-via-openclaw',
    model: USE_OPENAI_API ? TEXT_MODEL : 'openai-codex/* (gateway default)',
    imageModel: USE_OPENAI_API ? IMAGE_MODEL : 'tool-assisted/fallback',
    realtimeModel: USE_OPENAI_API ? REALTIME_MODEL : null,
    realtimeVoice: USE_OPENAI_API ? REALTIME_VOICE : null
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const {
      message,
      userGoal = 'Respond calmly and professionally.',
      tone = 'balanced',
      backend,
      voiceSessionId
    } = req.body ?? {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const selected = normalizeBackend(backend || DEFAULT_ANALYZE_BACKEND);
    const result = await runAnalyzeWithFallback({
      preferredBackend: selected,
      message,
      userGoal,
      tone,
      voiceSessionId
    });

    return res.json({
      ok: true,
      analysis: result.data,
      backend: result.backend,
      model: result.model,
      latencyMs: result.latencyMs,
      metrics: result.metrics || null,
      fallbackUsed: result.fallbackUsed || false
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Analysis failed.', detail: String(error?.message || error) });
  }
});

app.post('/api/realtime/session', async (req, res) => {
  try {
    if (!USE_OPENAI_API) {
      return res.status(400).json({ error: 'OPENAI_API_KEY is required for OpenAI live voice.' });
    }

    const sdp = String(req.body || '').trim();
    if (!sdp || !sdp.startsWith('v=')) {
      return res.status(400).json({ error: 'WebRTC SDP offer is required.' });
    }

    const sessionConfig = buildRealtimeSessionConfig(req.query || {});
    const fd = new FormData();
    fd.set('sdp', sdp);
    fd.set('session', JSON.stringify(sessionConfig));

    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: fd
    });

    const answerSdp = await response.text();
    if (!response.ok) {
      return res.status(response.status).type('text/plain').send(answerSdp || response.statusText);
    }

    return res.type('application/sdp').send(answerSdp);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Realtime session failed.', detail: String(error?.message || error) });
  }
});

app.get('/api/demo-scenarios', (_req, res) => {
  res.json({ ok: true, scenarios: DEMO_SCENARIOS });
});

app.post('/api/benchmark', async (req, res) => {
  const started = performance.now();
  try {
    const {
      turns = 20,
      backend,
      userGoal = 'Respond calmly and professionally while protecting the relationship.',
      tone = 'balanced',
      scenarios = DEMO_SCENARIOS
    } = req.body ?? {};

    const totalTurns = Math.min(30, Math.max(1, Number.parseInt(turns, 10) || 20));
    const sourceScenarios = normalizeBenchmarkScenarios(scenarios);
    const selected = normalizeBackend(backend || DEFAULT_ANALYZE_BACKEND);
    const rows = [];

    for (let i = 0; i < totalTurns; i++) {
      const scenario = sourceScenarios[i % sourceScenarios.length];
      const turnStarted = performance.now();
      try {
        const result = await runAnalyzeWithFallback({
          preferredBackend: selected,
          message: scenario.message,
          userGoal: scenario.goal || userGoal,
          tone: scenario.tone || tone,
          voiceSessionId: `benchmark-${Date.now()}-${i}`
        });
        rows.push({
          turn: i + 1,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          ok: true,
          backend: result.backend,
          model: result.model,
          latencyMs: result.latencyMs || Math.round(performance.now() - turnStarted),
          fallbackUsed: result.fallbackUsed || false,
          metrics: result.metrics || null
        });
      } catch (error) {
        rows.push({
          turn: i + 1,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          ok: false,
          backend: selected,
          latencyMs: Math.round(performance.now() - turnStarted),
          error: String(error?.message || error)
        });
      }
    }

    const successfulLatencies = rows.filter((row) => row.ok).map((row) => row.latencyMs);
    res.json({
      ok: true,
      requestedTurns: totalTurns,
      completedTurns: rows.length,
      totalElapsedMs: Math.round(performance.now() - started),
      stats: summarizeLatencies(successfulLatencies),
      rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Benchmark failed.', detail: String(error?.message || error) });
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

    const toolImage = await tryToolImageViaOpenClaw(analysis, brand);
    if (toolImage?.imageUrl || toolImage?.imageBase64) {
      return res.json({ ok: true, ...toolImage, mode: 'openclaw-agent-image-tool' });
    }

    const svg = generateSvgCard(analysis);
    const imageBase64 = Buffer.from(svg, 'utf8').toString('base64');
    return res.json({
      ok: true,
      imageBase64,
      mimeType: 'image/svg+xml',
      model: 'local-svg-fallback',
      mode: 'local-fallback'
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Image generation failed.', detail: String(error?.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Calm Command Center listening on http://localhost:${PORT}`);
  console.log(`Default analysis backend: ${DEFAULT_ANALYZE_BACKEND}`);
  console.log(`OpenAI API mode: ${USE_OPENAI_API ? 'enabled' : 'disabled'}`);
  console.log(`NeutrinoRTC mode: ${ENABLE_NEUTRINORTC ? 'enabled' : 'disabled'} (${NEUTRINORTC_URL})`);
});

function buildRealtimeSessionConfig({ tone = 'balanced', goal = 'Respond calmly while protecting trust.' } = {}) {
  return {
    type: 'realtime',
    model: REALTIME_MODEL,
    instructions: buildRealtimeInstructions({ tone, goal }),
    audio: {
      output: {
        voice: REALTIME_VOICE
      }
    }
  };
}

function buildRealtimeInstructions({ tone, goal }) {
  return [
    'You are Calm Command Center in OpenAI Realtime live voice mode.',
    'Have a natural speech-to-speech conversation, not a form-filling interview.',
    'Use the Human Layer: short natural empathy, context acknowledgment, relationship-aware wording, and small variation.',
    'Help the user de-escalate stressful messages in real time. Separate facts from assumptions before suggesting wording.',
    `User goal: ${String(goal || '').trim()}`,
    `Tone mode: ${String(tone || '').trim()}`,
    'When the user asks what to send, give one concise send-safe reply that sounds like a person.',
    'If the situation calls for a boundary, be firm without shaming or escalating.',
    'Do not claim to have taken actions outside the conversation.'
  ].join('\n');
}

async function runAnalyzeWithFallback({ preferredBackend, message, userGoal, tone, voiceSessionId }) {
  const ordered = backendOrder(preferredBackend);
  let lastError = null;

  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i];
    try {
      if (b === 'neutrinortc' && ENABLE_NEUTRINORTC) {
        const rtc = await analyzeWithNeutrinoRTC({ message, userGoal, tone, voiceSessionId });
        return withHumanLayer({ ...rtc, fallbackUsed: i > 0 }, { message, userGoal, tone });
      }

      if (b === 'openai-api' && USE_OPENAI_API) {
        const api = await analyzeWithOpenAI({ message, userGoal, tone });
        return withHumanLayer({ ...api, fallbackUsed: i > 0 }, { message, userGoal, tone });
      }

      if (b === 'openclaw-agent') {
        const agent = await analyzeWithOpenClawAgent({ message, userGoal, tone });
        return withHumanLayer({ ...agent, fallbackUsed: i > 0 }, { message, userGoal, tone });
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('No analysis backend available');
}


function normalizeBenchmarkScenarios(scenarios) {
  const list = Array.isArray(scenarios) && scenarios.length ? scenarios : DEMO_SCENARIOS;
  const normalized = list
    .map((item, index) => ({
      id: String(item?.id || `scenario-${index + 1}`),
      title: String(item?.title || `Scenario ${index + 1}`),
      tone: String(item?.tone || 'balanced'),
      goal: String(item?.goal || 'Respond calmly and professionally.'),
      message: String(item?.message || '').trim()
    }))
    .filter((item) => item.message)
    .slice(0, 10);

  return normalized.length ? normalized : DEMO_SCENARIOS;
}

function summarizeLatencies(latencies) {
  if (!latencies.length) {
    return { count: 0, p50: null, p95: null, max: null, min: null, avg: null };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    min: sorted[0],
    avg: Math.round(sum / sorted.length)
  };
}

function percentile(sortedLatencies, pct) {
  if (!sortedLatencies.length) return null;
  const index = Math.ceil((pct / 100) * sortedLatencies.length) - 1;
  return sortedLatencies[Math.min(sortedLatencies.length - 1, Math.max(0, index))];
}

function backendOrder(preferred) {
  const p = normalizeBackend(preferred);
  if (p === 'neutrinortc') return ['neutrinortc', 'openclaw-agent', 'openai-api'];
  if (p === 'openai-api') return ['openai-api', 'neutrinortc', 'openclaw-agent'];
  return ['openclaw-agent', 'neutrinortc', 'openai-api'];
}

function normalizeBackend(v) {
  const x = String(v || '').toLowerCase();
  if (x.includes('rtc') || x.includes('neutrino')) return 'neutrinortc';
  if (x.includes('openai')) return 'openai-api';
  return 'openclaw-agent';
}

async function analyzeWithNeutrinoRTC({ message, userGoal, tone, voiceSessionId }) {
  const started = performance.now();
  const sessionId = String(voiceSessionId || 'calm-command-center');
  const turn = (turnBySession.get(sessionId) || 0) + 1;
  turnBySession.set(sessionId, turn);

  const prompt = [
    'You are Calm Command Center in Blue View DNA mode.',
    'Return ONLY strict JSON and no markdown.',
    buildAnalysisPrompt({ message, userGoal, tone })
  ].join('\n\n');

  const payload = {
    voiceSessionId: sessionId,
    turnNumber: turn,
    transcript: prompt,
    voice: NEUTRINORTC_VOICE
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('neutrinortc timeout'), 60000);

  try {
    const resp = await fetch(NEUTRINORTC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const json = await resp.json();
    if (!resp.ok || json?.status !== 'ok') {
      throw new Error(`NeutrinoRTC error: ${json?.error || resp.statusText}`);
    }

    const raw = String(json?.answerText || '{}');
    const parsed = safeJsonParse(raw);
    const totalMs = json?.metrics?.totalMs || Math.round(performance.now() - started);

    return {
      backend: 'neutrinortc',
      model: 'neutrinortc/openclaw-cli',
      data: parsed,
      latencyMs: totalMs,
      metrics: json?.metrics || null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzeWithOpenAI({ message, userGoal, tone }) {
  const started = performance.now();
  const system = [
    'You are Neutrino Blueview for Calm Command Center.',
    'Mission: de-escalate, protect relationships, and produce safe clear responses.',
    'Return STRICT JSON only.',
    'No markdown. No extra text.',
    'If hostile content exists, lower heat and keep reply firm + respectful.',
    'Separate fact from assumption before advising.',
    'Keep suggestions practical and brief.',
    'Apply the Human Layer: natural empathy, context acknowledgment, relationship-aware wording, and non-corporate phrasing.'
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
  return {
    backend: 'openai-api',
    model: TEXT_MODEL,
    data: safeJsonParse(raw),
    latencyMs: Math.round(performance.now() - started),
    metrics: null
  };
}

async function analyzeWithOpenClawAgent({ message, userGoal, tone }) {
  const started = performance.now();
  const prompt = [
    'You are Calm Command Center in Blue View DNA mode.',
    'Respond ONLY with strict JSON. No markdown.',
    buildAnalysisPrompt({ message, userGoal, tone })
  ].join('\n\n');

  const run = await runOpenClawAgent(prompt, 'calm-command-center-analysis');
  const raw = run?.payloadText || '{}';
  return {
    backend: 'openclaw-agent',
    model: run?.model || 'openai-codex',
    data: safeJsonParse(raw),
    latencyMs: Math.round(performance.now() - started),
    metrics: null
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

async function checkRtcHealth() {
  try {
    const r = await fetch(NEUTRINORTC_HEALTH_URL, { method: 'GET' });
    return r.ok;
  } catch {
    return false;
  }
}

function buildAnalysisPrompt({ message, userGoal, tone }) {
  return [
    `INCOMING_MESSAGE: ${String(message).trim()}`,
    `USER_GOAL: ${String(userGoal).trim()}`,
    `PREFERRED_TONE: ${String(tone).trim()}`,
    '',
    'HUMAN_LAYER_RULES:',
    '- The final reply must sound like a person, not policy copy or a corporate template.',
    '- Open with one short, natural acknowledgment when appropriate; vary sentence shape across turns.',
    '- Acknowledge the context without over-apologizing or admitting facts not in evidence.',
    '- Choose wording based on the relationship goal: protect trust, set a boundary, or de-escalate.',
    '- Tone modes: warm = gentle and validating; direct = plain and concise; executive = crisp and composed; repair = accountable and trust-restoring; firm = respectful boundary.',
    '- Preserve safety, facts, and boundaries while removing stiff phrases like "per my previous message" or "we value your feedback".',
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
    '  "human_layer": {',
    '    "natural_opener": "string",',
    '    "relationship_cue": "protect_trust|set_boundary|de_escalate",',
    '    "tone_mode": "warm|direct|executive|repair|balanced|firm",',
    '    "rewrite_notes": ["string"]',
    '  },',
    '  "coach_note": "string"',
    '}'
  ].join('\n');
}

function withHumanLayer(result, context) {
  return {
    ...result,
    data: applyHumanLayer(result.data, context)
  };
}

function applyHumanLayer(data, { message, userGoal, tone }) {
  const safe = data && typeof data === 'object' ? data : fallback('');
  const toneMode = normalizeToneMode(tone);
  const relationshipCue = detectRelationshipCue(userGoal, message);
  const naturalOpener = pickNaturalOpener({ message, toneMode, relationshipCue });

  const replyOptions = safe.reply_options && typeof safe.reply_options === 'object'
    ? safe.reply_options
    : {};

  const rewrittenSafeReply = humanizeReply({
    text: safe.send_safe_reply || replyOptions.collaborative || replyOptions.calm_short || '',
    opener: safe.human_layer?.natural_opener || naturalOpener,
    toneMode,
    relationshipCue
  });

  return {
    ...safe,
    reply_options: {
      calm_short: humanizeReply({ text: replyOptions.calm_short, opener: naturalOpener, toneMode, relationshipCue, maxSentences: 2 }),
      collaborative: humanizeReply({ text: replyOptions.collaborative, opener: naturalOpener, toneMode: toneMode === 'firm' ? 'direct' : toneMode, relationshipCue }),
      firm_respectful: humanizeReply({ text: replyOptions.firm_respectful, opener: 'I want to be clear.', toneMode: 'firm', relationshipCue: 'set_boundary' })
    },
    send_safe_reply: rewrittenSafeReply,
    human_layer: {
      natural_opener: naturalOpener,
      relationship_cue: relationshipCue,
      tone_mode: toneMode,
      rewrite_notes: [
        'Added a natural acknowledgment before advice.',
        'Kept the boundary/facts intact while removing stiff corporate phrasing.',
        'Varied sentence shape so the reply reads like speech.'
      ]
    }
  };
}

function normalizeToneMode(tone) {
  const t = String(tone || '').toLowerCase();
  if (t.includes('repair')) return 'repair';
  if (t.includes('executive')) return 'executive';
  if (t.includes('direct')) return 'direct';
  if (t.includes('warm')) return 'warm';
  if (t.includes('firm')) return 'firm';
  return 'balanced';
}

function detectRelationshipCue(userGoal, message) {
  const text = `${userGoal || ''} ${message || ''}`.toLowerCase();
  if (/(boundary|firm|unacceptable|cannot|won't|will not|limit)/.test(text)) return 'set_boundary';
  if (/(trust|relationship|client|partner|repair|apolog|own|accountable)/.test(text)) return 'protect_trust';
  return 'de_escalate';
}

function pickNaturalOpener({ message, toneMode, relationshipCue }) {
  const bank = {
    warm: ['I hear you.', 'That sounds frustrating.', 'Thanks for saying it directly.'],
    direct: ['I hear you.', 'Understood.', 'Thanks for being direct.'],
    executive: ['Understood.', 'I see the concern.', 'Thanks for flagging this.'],
    repair: ['You’re right to raise this.', 'I hear you, and I’m sorry this landed that way.', 'Thanks for calling this out.'],
    firm: ['I hear the concern.', 'I want to be clear.', 'I understand this matters.'],
    balanced: ['I hear you.', 'Thanks for saying it directly.', 'I understand this is frustrating.']
  };
  const cueOpener = relationshipCue === 'set_boundary' ? 'I want to be clear.' : null;
  const choices = bank[toneMode] || bank.balanced;
  if (cueOpener && toneMode === 'firm') return cueOpener;
  return choices[stableIndex(`${message || ''}:${toneMode}:${relationshipCue}`, choices.length)];
}

function humanizeReply({ text, opener, toneMode, relationshipCue, maxSentences = 4 }) {
  const cleaned = stripCorporatePhrasing(String(text || '').trim());
  const base = cleaned || fallback('').send_safe_reply;
  const withOpener = startsWithAcknowledgment(base) ? base : `${opener} ${base}`;
  const softened = tuneForTone(withOpener, toneMode, relationshipCue);
  return limitSentences(softened.replace(/\s+/g, ' ').trim(), maxSentences);
}

function stripCorporatePhrasing(text) {
  return text
    .replace(/\bwe value your feedback[,.]?\s*/gi, '')
    .replace(/\bper my previous message[,.]?\s*/gi, '')
    .replace(/\bat your earliest convenience\b/gi, 'when you can')
    .replace(/\bplease be advised that\b/gi, '')
    .replace(/\bI apologize for any inconvenience this may have caused\b/gi, 'I’m sorry this created extra friction')
    .trim();
}

function startsWithAcknowledgment(text) {
  return /^(i hear|understood|thanks|thank you|you(?:'|’)re right|that sounds|i see|i understand|i want to be clear)/i.test(text.trim());
}

function tuneForTone(text, toneMode, relationshipCue) {
  if (toneMode === 'executive') {
    return text.replace(/I would like to/g, 'I’ll').replace(/we should/g, 'let’s');
  }
  if (toneMode === 'direct') {
    return text.replace(/I’d like to take a moment to /g, 'I’ll ');
  }
  if (toneMode === 'repair' || relationshipCue === 'protect_trust') {
    return text.includes('next step') ? text : `${text} My next step is to make this easier to move forward.`;
  }
  return text;
}

function limitSentences(text, maxSentences) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  return sentences.slice(0, maxSentences).join(' ').trim();
}

function stableIndex(input, size) {
  let hash = 0;
  for (const ch of String(input)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return size ? hash % size : 0;
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
    send_safe_reply: 'I hear you. I’m reviewing this now so I can respond with clear next steps instead of reacting too quickly.',
    human_layer: {
      natural_opener: 'I hear you.',
      relationship_cue: 'de_escalate',
      tone_mode: 'balanced',
      rewrite_notes: ['Fallback reply softened to sound less procedural.']
    },
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
