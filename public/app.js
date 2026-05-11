const msg = document.getElementById('msg');
const tone = document.getElementById('tone');
const goal = document.getElementById('goal');
const analyzeBtn = document.getElementById('analyzeBtn');
const cardBtn = document.getElementById('cardBtn');
const voiceBtn = document.getElementById('voiceBtn');
const statusEl = document.getElementById('status');
const result = document.getElementById('result');
const imageSection = document.getElementById('imageSection');
const cardImage = document.getElementById('cardImage');
const copySafe = document.getElementById('copySafe');

let latestAnalysis = null;

analyzeBtn.addEventListener('click', runAnalysis);
cardBtn.addEventListener('click', generateCard);
copySafe.addEventListener('click', copySafeReply);
voiceBtn.addEventListener('click', runVoiceInput);

async function runAnalysis() {
  try {
    const text = msg.value.trim();
    if (!text) {
      setStatus('Please paste or speak a message first.');
      return;
    }

    setStatus('Analyzing with GPT-5.5…');
    analyzeBtn.disabled = true;

    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: text,
        tone: tone.value,
        userGoal: goal.value
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analyze failed');

    latestAnalysis = data.analysis;
    renderAnalysis(latestAnalysis);
    cardBtn.disabled = false;
    setStatus(`Done (${data.model}).`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    analyzeBtn.disabled = false;
  }
}

function renderAnalysis(a) {
  result.classList.remove('hidden');

  fillText('neutral', a.neutral_summary);
  fillText('heat', a.emotional_temperature);

  fillList('facts', a.facts);
  fillList('assumptions', a.assumptions);
  fillList('risks', a.risks);

  fillText('calm_short', a.reply_options?.calm_short);
  fillText('collaborative', a.reply_options?.collaborative);
  fillText('firm_respectful', a.reply_options?.firm_respectful);
  fillText('send_safe_reply', a.send_safe_reply);
}

async function generateCard() {
  try {
    if (!latestAnalysis) return;

    cardBtn.disabled = true;
    setStatus('Generating image brief card…');

    const res = await fetch('/api/card', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysis: latestAnalysis })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Image generation failed');

    if (data.imageBase64) {
      cardImage.src = `data:image/png;base64,${data.imageBase64}`;
    } else if (data.imageUrl) {
      cardImage.src = data.imageUrl;
    } else {
      throw new Error('No image returned');
    }

    imageSection.classList.remove('hidden');
    setStatus(`Card generated (${data.model}).`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    cardBtn.disabled = false;
  }
}

async function copySafeReply() {
  const text = document.getElementById('send_safe_reply').textContent?.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('Send-safe reply copied.');
}

function runVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus('Voice input not supported in this browser.');
    return;
  }

  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  setStatus('Listening… speak now.');
  rec.start();

  rec.onresult = (event) => {
    const text = event.results?.[0]?.[0]?.transcript || '';
    msg.value = text;
    setStatus('Voice captured.');
  };

  rec.onerror = (event) => {
    setStatus(`Voice error: ${event.error}`);
  };
}

function fillText(id, value) {
  const el = document.getElementById(id);
  el.textContent = value || '—';
}

function fillList(id, arr) {
  const ul = document.getElementById(id);
  ul.innerHTML = '';
  const items = Array.isArray(arr) && arr.length ? arr : ['—'];
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}
