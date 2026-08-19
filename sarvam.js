/* Sarvam AI — Hindi/Sanskrit voice, typing, and translation.
   API key lives in localStorage only. Never commit it. */
(function (global) {
  const KEY = 'sanskritayatra-sarvam-key';
  const BASE = 'https://api.sarvam.ai';
  const audioCache = new Map();
  const textCache = new Map();
  let gen = 0;
  let recStream = null;
  let rec = null;

  function getKey() {
    try { return (localStorage.getItem(KEY) || '').trim(); } catch (e) { return ''; }
  }
  function setKey(v) {
    const s = String(v || '').trim();
    try {
      if (s) localStorage.setItem(KEY, s);
      else localStorage.removeItem(KEY);
    } catch (e) {}
    audioCache.clear();
  }
  function hasKey() { return !!getKey(); }
  function abort() { gen++; }
  function pace(rate) {
    const r = Number(rate);
    if (!(r > 0)) return 1;
    if (r < 0.8) return 0.85;
    return 1;
  }

  async function postJson(path, body) {
    const my = gen;
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'api-subscription-key': getKey(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (my !== gen) throw new Error('aborted');
    if (!res.ok) {
      const msg = data.error && (data.error.message || data.error) || data.message || ('Sarvam ' + res.status);
      throw new Error(typeof msg === 'string' ? msg : 'Sarvam request failed');
    }
    return data;
  }

  async function tts(text, rate) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const p = pace(rate);
    const cacheKey = p + '\n' + t;
    if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);
    const data = await postJson('/text-to-speech', {
      text: t.slice(0, 2400),
      language_code: 'hi-IN',
      model: 'bulbul:v3',
      speaker: 'priya',
      pace: p,
      output_audio_codec: 'mp3',
      speech_sample_rate: 24000
    });
    const b64 = (data.audios || []).join('');
    if (!b64) throw new Error('No audio');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    audioCache.set(cacheKey, url);
    return url;
  }

  async function translate(input, source, target) {
    const t = String(input || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const src = source || 'sa-IN';
    const tgt = target || 'en-IN';
    const cacheKey = 'tr|' + src + '|' + tgt + '|' + t;
    if (textCache.has(cacheKey)) return textCache.get(cacheKey);
    const data = await postJson('/translate', {
      input: t.slice(0, 1900),
      source_language_code: src,
      target_language_code: tgt,
      model: 'sarvam-translate:v1',
      speaker_gender: 'Female'
    });
    const out = (data.translated_text || '').trim();
    if (out) textCache.set(cacheKey, out);
    return out;
  }

  async function transliterate(input) {
    const t = String(input || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (/[\u0900-\u097F]/.test(t) && !/[A-Za-z]/.test(t)) return t;
    const cacheKey = 'tl|' + t;
    if (textCache.has(cacheKey)) return textCache.get(cacheKey);
    const data = await postJson('/transliterate', {
      input: t.slice(0, 900),
      source_language_code: 'en-IN',
      target_language_code: 'hi-IN'
    });
    const out = (data.transliterated_text || data.output || '').trim();
    if (out) textCache.set(cacheKey, out);
    return out;
  }

  async function transcribe(blob) {
    const fd = new FormData();
    const name = (blob && blob.type && blob.type.indexOf('wav') >= 0) ? 'clip.wav' : 'clip.webm';
    fd.append('file', blob, name);
    fd.append('model', 'saaras:v3');
    fd.append('mode', 'transcribe');
    fd.append('language_code', 'hi-IN');
    const my = gen;
    const res = await fetch(BASE + '/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': getKey() },
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (my !== gen) throw new Error('aborted');
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Could not hear that');
    return (data.transcript || data.text || '').trim();
  }

  function stopRec() {
    try { if (rec && rec.state === 'recording') rec.stop(); } catch (e) {}
    rec = null;
    if (recStream) {
      recStream.getTracks().forEach(function (tr) { try { tr.stop(); } catch (e) {} });
      recStream = null;
    }
  }

  async function listenOnce(maxMs) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('microphone');
    }
    stopRec();
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    rec = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream);
    const chunks = [];
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.start();
    await new Promise(function (resolve) { setTimeout(resolve, maxMs || 4500); });
    if (!rec) return '';
    const done = new Promise(function (resolve) { rec.onstop = resolve; });
    try { rec.stop(); } catch (e) {}
    await done;
    const type = rec.mimeType || 'audio/webm';
    stopRec();
    const blob = new Blob(chunks, { type: type });
    if (!blob.size) return '';
    return transcribe(blob);
  }

  function wireInput(input, onDev) {
    if (!input) return;
    let hint = input.nextElementSibling;
    if (!hint || !hint.classList || !hint.classList.contains('sa-hint')) {
      hint = document.createElement('div');
      hint.className = 'sa-hint';
      input.insertAdjacentElement('afterend', hint);
    }
    let timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      const v = input.value.trim();
      if (!hasKey() || !v || /[\u0900-\u097F]/.test(v) || !/[A-Za-z]/.test(v)) {
        hint.textContent = '';
        return;
      }
      timer = setTimeout(function () {
        transliterate(v).then(function (dev) {
          if (!dev || dev === v) { hint.textContent = ''; return; }
          hint.textContent = 'देवनागरी: ' + dev;
          if (onDev) onDev(dev);
        }).catch(function () { hint.textContent = ''; });
      }, 480);
    });
  }

  function copy(lang) {
    if (lang === 'hi') {
      return {
        btn: 'Sarvam',
        title: 'Sarvam AI — साफ़ उच्चारण और अनुवाद',
        help: 'कुंजी केवल इस ब्राउज़र में रहती है। मुफ़्त कुंजी: dashboard.sarvam.ai',
        ph: 'Sarvam API कुंजी चिपकाओ',
        save: 'सहेजो',
        clear: 'हटाओ',
        on: 'Sarvam आवाज़ चालू',
        off: 'ब्राउज़र आवाज़ — साफ़ संस्कृत के लिए कुंजी जोड़ो',
        bad: 'कुंजी काम नहीं आई। दोबारा चिपकाओ।'
      };
    }
    return {
      btn: 'Sarvam',
      title: 'Sarvam AI — clearer Sanskrit speech',
      help: 'The key stays in this browser only. Free key: dashboard.sarvam.ai',
      ph: 'Paste Sarvam API key',
      save: 'Save',
      clear: 'Remove',
      on: 'Sarvam voice on',
      off: 'Browser voice — add a key for clearer Sanskrit',
      bad: 'That key did not work. Paste it again.'
    };
  }

  function mountBar(speedEl, lang, onChange) {
    const t = copy(lang);
    const wrap = document.createElement('div');
    wrap.className = 'sarvam-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost';
    btn.textContent = hasKey() ? '✦ ' + t.btn : t.btn;
    btn.title = t.title;
    const panel = document.createElement('div');
    panel.className = 'sarvam-panel';
    panel.hidden = true;
    const status = document.createElement('div');
    status.className = 'sarvam-status';
    function sync() {
      const on = hasKey();
      btn.textContent = on ? '✦ ' + t.btn : t.btn;
      btn.className = 'btn' + (on ? '' : ' ghost');
      status.textContent = on ? t.on : t.off;
      status.className = 'sarvam-status' + (on ? ' ok' : '');
    }
    sync();
    const lab = document.createElement('div');
    lab.className = 'sarvam-title';
    lab.textContent = t.title;
    const help = document.createElement('p');
    help.className = 'note';
    help.innerHTML = t.help.replace('dashboard.sarvam.ai', '<a href="https://dashboard.sarvam.ai/" target="_blank" rel="noopener">dashboard.sarvam.ai</a>');
    const field = document.createElement('input');
    field.type = 'password';
    field.autocomplete = 'off';
    field.placeholder = t.ph;
    if (hasKey()) field.value = '••••••••';
    const row = document.createElement('div');
    row.className = 'btnrow';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn';
    save.textContent = t.save;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn ghost';
    clear.textContent = t.clear;
    save.onclick = async function () {
      const typed = field.value.trim();
      if (!typed || typed.indexOf('•') === 0) { panel.hidden = true; return; }
      setKey(typed);
      try {
        await tts('नमस्ते', 0.88);
        field.value = '••••••••';
        sync();
        panel.hidden = true;
        if (onChange) onChange(true);
      } catch (e) {
        setKey('');
        status.textContent = t.bad;
        status.className = 'sarvam-status bad';
        field.value = '';
      }
    };
    clear.onclick = function () {
      setKey('');
      field.value = '';
      sync();
      if (onChange) onChange(false);
    };
    row.appendChild(save);
    row.appendChild(clear);
    panel.appendChild(lab);
    panel.appendChild(help);
    panel.appendChild(field);
    panel.appendChild(row);
    panel.appendChild(status);
    btn.onclick = function () { panel.hidden = !panel.hidden; };
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    speedEl.appendChild(wrap);
    return { sync: sync };
  }

  global.Sarvam = {
    getKey: getKey,
    setKey: setKey,
    hasKey: hasKey,
    abort: abort,
    pace: pace,
    tts: tts,
    translate: translate,
    transliterate: transliterate,
    transcribe: transcribe,
    listenOnce: listenOnce,
    stopRec: stopRec,
    wireInput: wireInput,
    mountBar: mountBar
  };
})(window);
