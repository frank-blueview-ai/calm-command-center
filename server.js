import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = Number(process.env.PORT || 8790);
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-5.5';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'calm-command-center', model: TEXT_MODEL, imageModel: IMAGE_MODEL });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { message, userGoal = 'Respond calmly and professionally.', tone = 'balanced' } = req.body ?? {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const system = [
      'You are Neutrino Blueview for Calm Command Center.',
      'Mission: de-escalate, protect relationships, and produce safe clear responses.',
      'Return STRICT JSON only.',
      'No markdown. No extra text.',
      'If hostile content exists, lower heat and keep reply firm + respectful.',
      'Separate fact from assumption before advising.',
      'Keep suggestions practical and brief.'
    ].join(' ');

    const user = [
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

    const completion = await client.chat.completions.create({
      model: TEXT_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';
    const parsed = safeJsonParse(raw);

    return res.json({
      ok: true,
      analysis: parsed,
      model: TEXT_MODEL
    });
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

    const prompt = buildCardPrompt(analysis, brand);

    const img = await client.images.generate({
      model: IMAGE_MODEL,
      prompt,
      size: '1024x1024'
    });

    const first = img?.data?.[0] || {};
    const imageUrl = first.url || null;
    const base64 = first.b64_json || null;

    return res.json({
      ok: true,
      imageUrl,
      imageBase64: base64,
      mimeType: 'image/png',
      model: IMAGE_MODEL,
      prompt
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Image generation failed.', detail: String(error?.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Calm Command Center listening on http://localhost:${PORT}`);
});

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
