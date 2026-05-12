const msg = document.getElementById('msg');
const tone = document.getElementById('tone');
const goal = document.getElementById('goal');
const analyzeBtn = document.getElementById('analyzeBtn');
const cardBtn = document.getElementById('cardBtn');
const voiceBtn = document.getElementById('voiceBtn');
const liveTurnBtn = document.getElementById('liveTurnBtn');
const stopSpeakBtn = document.getElementById('stopSpeakBtn');
const realtimeStartBtn = document.getElementById('realtimeStartBtn');
const realtimeStopBtn = document.getElementById('realtimeStopBtn');
const realtimePanel = document.getElementById('realtimePanel');
const realtimeState = document.getElementById('realtimeState');
const realtimeTranscript = document.getElementById('realtimeTranscript');
const realtimeAudio = document.getElementById('realtimeAudio');
const autoSpeak = document.getElementById('autoSpeak');
const statusEl = document.getElementById('status');
const result = document.getElementById('result');
const imageSection = document.getElementById('imageSection');
const cardImage = document.getElementById('cardImage');
const copySafe = document.getElementById('copySafe');
const demoScenariosEl = document.getElementById('demoScenarios');
const benchmarkBtn = document.getElementById('benchmarkBtn');
const benchmarkTurns = document.getElementById('benchmarkTurns');
const benchmarkDetails = document.getElementById('benchmarkDetails');
const benchmarkRows = document.getElementById('benchmarkRows');

let latestAnalysis = null;
let demoScenarios = [];
let latencySamples = [];
let realtimeConnection = null;
let realtimeStream = null;
let realtimeChannel = null;
let realtimeAssistantText = '';

analyzeBtn.addEventListener('click', () => runAnalysis({ speakReply: autoSpeak.checked }));
cardBtn.addEventListener('click', generateCard);
copySafe.addEventListener('click', copySafeReply);
voiceBtn.addEventListener('click', runVoiceInput);
liveTurnBtn.addEventListener('click', runLiveVoiceTurn);
stopSpeakBtn.addEventListener('click', stopSpeaking);
realtimeStartBtn.addEventListener('click', startOpenAIRealtimeVoice);
realtimeStopBtn.addEventListener('click', stopOpenAIRealtimeVoice);
benchmarkBtn.addEventListener('click', runBenchmark);
window.addEventListener('beforeunload', () => { stopOpenAIRealtimeVoice({ quiet: true }); });
loadDemoScenarios();

async function startOpenAIRealtimeVoice() {
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    setStatus('OpenAI live voice needs WebRTC and microphone support in this browser.');
    return;
  }

  try {
    stopSpeaking();
    await stopOpenAIRealtimeVoice({ quiet: true });

    realtimePanel.classList.remove('hidden');
    setRealtimeState('Checking OpenAI API mode…');
    setStatus('Starting OpenAI live voice…');
    realtimeStartBtn.disabled = true;

    const health = await fetch('/healthz').then((r) => r.json());
    if (!health.availableBackends?.openaiApi) {
      throw new Error('Set OPENAI_API_KEY in .env, restart the server, then try OpenAI Live Voice again.');
    }

    setRealtimeState('Requesting microphone…');

    const pc = new RTCPeerConnection();
    realtimeConnection = pc;

    pc.ontrack = (event) => {
      realtimeAudio.srcObject = event.streams[0];
    };

    pc.onconnectionstatechange = () => {
      setRealtimeState(`Connection: ${pc.connectionState}`);
      if (['closed', 'failed', 'disconnected'].includes(pc.connectionState)) {
        realtimeStopBtn.disabled = true;
        realtimeStartBtn.disabled = false;
      }
    };

    realtimeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    realtimeStream.getAudioTracks().forEach((track) => pc.addTrack(track, realtimeStream));

    realtimeChannel = pc.createDataChannel('oai-events');
    realtimeChannel.addEventListener('open', () => {
      setRealtimeState('Connected — speak naturally.');
      realtimeStopBtn.disabled = false;
      setStatus('OpenAI live voice connected. You can talk now.');
    });
    realtimeChannel.addEventListener('message', handleRealtimeEvent);
    realtimeChannel.addEventListener('close', () => setRealtimeState('Disconnected'));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const params = new URLSearchParams({ tone: tone.value, goal: goal.value });
    const response = await fetch(`/api/realtime/session?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: offer.sdp
    });

    const answerSdp = await response.text();
    if (!response.ok) throw new Error(answerSdp || 'OpenAI live voice session failed');

    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch (error) {
    await stopOpenAIRealtimeVoice({ quiet: true });
    setStatus(`OpenAI live voice error: ${error.message}`);
    setRealtimeState('Disconnected');
  } finally {
    realtimeStartBtn.disabled = false;
  }
}

async function stopOpenAIRealtimeVoice({ quiet = false } = {}) {
  if (realtimeChannel) {
    realtimeChannel.close();
    realtimeChannel = null;
  }

  if (realtimeConnection) {
    realtimeConnection.getSenders().forEach((sender) => sender.track?.stop());
    realtimeConnection.close();
    realtimeConnection = null;
  }

  if (realtimeStream) {
    realtimeStream.getTracks().forEach((track) => track.stop());
    realtimeStream = null;
  }

  realtimeAudio.srcObject = null;
  realtimeStopBtn.disabled = true;
  realtimeStartBtn.disabled = false;
  setRealtimeState('Disconnected');
  if (!quiet) setStatus('OpenAI live voice stopped.');
}

function handleRealtimeEvent(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  if (data.type === 'response.audio_transcript.delta') {
    realtimeAssistantText += data.delta || '';
    realtimeTranscript.textContent = realtimeAssistantText;
  }

  if (data.type === 'response.audio_transcript.done') {
    realtimeAssistantText = data.transcript || realtimeAssistantText;
    realtimeTranscript.textContent = realtimeAssistantText || 'Assistant responded in audio.';
  }

  if (data.type === 'input_audio_buffer.speech_started') {
    realtimeAssistantText = '';
    realtimeTranscript.textContent = 'Listening…';
  }

  if (data.type === 'error') {
    const message = data.error?.message || 'Realtime API event error.';
    setStatus(`OpenAI live voice error: ${message}`);
  }
}

function setRealtimeState(text) {
  realtimeState.textContent = text;
}

async function loadDemoScenarios() {
  try {
    const res = await fetch('/api/demo-scenarios');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load scenarios');
    demoScenarios = data.scenarios || [];
    renderDemoScenarios();
  } catch (error) {
    demoScenariosEl.textContent = `Demo scenarios unavailable: ${error.message}`;
  }
}

function renderDemoScenarios() {
  demoScenariosEl.innerHTML = '';
  for (const scenario of demoScenarios) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scenario-btn';
    button.textContent = scenario.title;
    button.addEventListener('click', () => loadScenario(scenario));
    demoScenariosEl.appendChild(button);
  }
}

function loadScenario(scenario) {
  msg.value = scenario.message || '';
  tone.value = scenario.tone || 'balanced';
  goal.value = scenario.goal || 'Respond calmly and professionally while protecting the relationship.';
  setStatus(`Loaded demo: ${scenario.title}.`);
}

async function runBenchmark() {
  try {
    benchmarkBtn.disabled = true;
    benchmarkRows.innerHTML = '';
    benchmarkDetails.classList.add('hidden');
    setStatus(`Running ${benchmarkTurns.value}-turn benchmark…`);

    const res = await fetch('/api/benchmark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turns: Number(benchmarkTurns.value), scenarios: demoScenarios })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Benchmark failed');

    latencySamples = (data.rows || []).filter((row) => row.ok).map((row) => row.latencyMs);
    updateLatencyMetrics(data.stats || summarizeLatencies(latencySamples));
    renderBenchmarkRows(data.rows || []);
    benchmarkDetails.classList.remove('hidden');
    const p50 = formatMs(data.stats?.p50);
    const p95 = formatMs(data.stats?.p95);
    setStatus(`Benchmark complete: p50 ${p50}, p95 ${p95}, ${data.stats?.count || 0}/${data.completedTurns} successful turns.`);
  } catch (error) {
    setStatus(`Benchmark error: ${error.message}`);
  } finally {
    benchmarkBtn.disabled = false;
  }
}

function renderBenchmarkRows(rows) {
  benchmarkRows.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.turn}</td>
      <td>${escapeHtml(row.scenarioTitle || row.scenarioId || 'Scenario')}</td>
      <td>${escapeHtml(row.backend || '—')}${row.fallbackUsed ? ' ↪ fallback' : ''}</td>
      <td>${formatMs(row.latencyMs)}</td>
      <td class="${row.ok ? 'ok' : 'fail'}">${row.ok ? 'ok' : escapeHtml(row.error || 'failed')}</td>
    `;
    benchmarkRows.appendChild(tr);
  }
}

function updateLatencyMetrics(stats) {
  fillText('metricCount', stats?.count ?? 0);
  fillText('metricP50', formatMs(stats?.p50));
  fillText('metricP95', formatMs(stats?.p95));
  fillText('metricMax', formatMs(stats?.max));
}

function summarizeLatencies(samples) {
  if (!samples.length) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]
  };
}

function percentile(sorted, pct) {
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : '—';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
    if (data.latencyMs) {
      latencySamples.push(data.latencyMs);
      updateLatencyMetrics(summarizeLatencies(latencySamples));
    }
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
  fillHumanLayer(a.human_layer);
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

function fillHumanLayer(layer = {}) {
  fillText('human_opener', layer.natural_opener ? `Opener: ${layer.natural_opener}` : 'Opener: —');
  fillText('relationship_cue', layer.relationship_cue ? `Cue: ${layer.relationship_cue.replaceAll('_', ' ')}` : 'Cue: —');
  fillText('tone_mode', layer.tone_mode ? `Tone: ${layer.tone_mode}` : 'Tone: —');
  fillList('rewrite_notes', layer.rewrite_notes);
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
