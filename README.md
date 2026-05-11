# Calm Command Center (Blue View DNA)

Voice-first de-escalation copilot built for **#OpenAIDevDay2026**.

## What it does
Paste (or speak) a stressful message and get:
- Neutral summary
- Emotional temperature
- Facts vs assumptions
- Risks
- 3 reply styles (calm short, collaborative, firm respectful)
- One **send-safe** final reply

Then generate a shareable visual brief card with **Image Gen**.

## Why this is Blue View DNA
- Calm under pressure
- Human-first and relationship-protective
- Fact/assumption separation before action
- Ethical de-escalation over reactive escalation

## Tech
- Node + Express
- OpenAI Chat Completions with **GPT-5.5**
- OpenAI Images with **gpt-image-1**
- Web Speech API for quick voice capture in browser

## Quick start
```bash
cp .env.example .env
# fill OPENAI_API_KEY
npm install
npm run dev
```

Open: `http://localhost:8790`

## Env
```env
PORT=8790
OPENAI_API_KEY=...
OPENAI_TEXT_MODEL=gpt-5.5
OPENAI_IMAGE_MODEL=gpt-image-1
```

## API
### `POST /api/analyze`
Body:
```json
{
  "message": "text",
  "userGoal": "Respond calmly and professionally.",
  "tone": "balanced"
}
```

### `POST /api/card`
Body:
```json
{
  "analysis": { "...": "output from /api/analyze" }
}
```

## Demo script (60 seconds)
1. Paste a heated message.
2. Click **Analyze with GPT-5.5**.
3. Show facts vs assumptions + send-safe reply.
4. Click **Generate Image Card**.
5. Say: “This is NeutrinoRTC-style calm reasoning turned into immediate action.”

## Suggested submission post
```text
#OpenAIDevDay2026
Built Calm Command Center: a live de-escalation copilot that turns high-stress messages into safe, clear replies.
Powered by GPT-5.5 for structured calm-response coaching and Image Gen for instant visual incident/reply cards.
Playable link: <your link>
```
