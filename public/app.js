const msg = document.getElementById('msg');
const tone = document.getElementById('tone');
const goal = document.getElementById('goal');
const analyzeBtn = document.getElementById('analyzeBtn');
const cardBtn = document.getElementById('cardBtn');
const voiceBtn = document.getElementById('voiceBtn');
const liveTurnBtn = document.getElementById('liveTurnBtn');
const stopSpeakBtn = document.getElementById('stopSpeakBtn');
const autoSpeak = document.getElementById('autoSpeak');
const statusEl = document.getElementById('status');
const result = document.getElementById('result');
const imageSection = document.getElementById('imageSection');
const cardImage = document.getElementById('cardImage');
const copySafe = document.getElementById('copySafe');

let latestAnalysis = null;

analyzeBtn.addEventListener('click', () => runAnalysis({ speakReply: autoSpeak.checked }));
cardBtn.addEventListener('click', generateCard);
copySafe.addEventListener('click', copySafeReply);
voiceBtn.addEventListener('click', runVoiceInput);
liveTurnBtn.addEventListener('click', runLiveVoiceTurn);
stopSpeakBtn.addEventListener('click', stopSpeaking);

async function runAnalysis({ speakReply = false } = {}) {
  try {
    const text = msg.value.trim();
    if (!text) {
      setStatus('Please paste or speak a message first.');
      return;
    }

    setStatus('Analyzing…');
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
    const backend = data.backend || data.mode || 'default';
    const latency = data.latencyMs ? `, ${data.latencyMs}ms` : '';
    setStatus(`Done (${backend}${latency}, ${data.model || 'model-unknown'}).`);

    if (speakReply) {
      speakText(latestAnalysis?.send_safe_reply || 'I have a safe response option ready.');
    }
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
      const mime = data.mimeType || 'image/png';
      cardImage.src = `data:${mime};base64,${data.imageBase64}`;
    } else if (data.imageUrl) {
      cardImage.src = data.imageUrl;
    } else {
      throw new Error('No image returned');
    }

    imageSection.classList.remove('hidden');
    setStatus(`Card generated (${data.model}, ${data.mode || 'default'}).`);
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
  captureOneUtterance('Listening… speak now.')
    .then((text) => {
      msg.value = text;
      setStatus('Voice captured.');
    })
    .catch((err) => setStatus(err.message));
}

async function runLiveVoiceTurn() {
  try {
    // Barge-in behavior: if assistant is speaking, user interrupts instantly.
    if (speechSynthesis.speaking) {
      speechSynthesis.cancel();
      setStatus('Barge-in: assistant stopped. Listening for your update…');
    }

    liveTurnBtn.disabled = true;
    const text = await captureOneUtterance('Live turn listening…');
    msg.value = text;
    setStatus('Live turn captured. Running analysis…');
    await runAnalysis({ speakReply: true });
  } catch (err) {
    setStatus(err.message || 'Live turn failed.');
  } finally {
    liveTurnBtn.disabled = false;
  }
}

function captureOneUtterance(listeningStatus = 'Listening…') {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      reject(new Error('Voice input not supported in this browser.'));
      return;
    }

    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    setStatus(listeningStatus);
    rec.start();

    rec.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript || '';
      if (!text.trim()) {
        reject(new Error('No speech recognized. Try again.'));
        return;
      }
      resolve(text.trim());
    };

    rec.onerror = (event) => {
      reject(new Error(`Voice error: ${event.error}`));
    };
  });
}

function stopSpeaking() {
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    setStatus('Assistant voice stopped.');
  } else {
    setStatus('Assistant is not speaking.');
  }
}

function speakText(text) {
  const clean = String(text || '').trim();
  if (!clean) return;

  if (!('speechSynthesis' in window)) {
    setStatus('Speech output not supported in this browser.');
    return;
  }

  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.onstart = () => setStatus('Assistant speaking… (you can barge in)');
  utterance.onend = () => setStatus('Assistant done speaking.');
  utterance.onerror = () => setStatus('Speech output error.');
  speechSynthesis.speak(utterance);
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
