/* Sarvam AI — Hindi/Sanskrit voice, typing, and translation.
   The API key lives in a Cloudflare Worker secret, never in this file. */
(function (global) {
  const BASE = 'https://sanskrit-yatra-sarvam.fluff-aluminum.workers.dev';
  const audioCache = new Map();
  const textCache = new Map();
  let gen = 0;
  let recStream = null;
  let rec = null;

  function hasKey() { return !!BASE; }
  function abort() { gen++; }
  function pace(rate) {
    const r = Number(rate);
    if (!(r > 0)) return 1;
    if (r < 0.8) return 0.85;
    return 1;
  }

  /* Hindi TTS drops Sanskrit’s inherent “a” (मम → mum). A full letter
     without a halant is still “ma / ra / na” — like mama, rama, karna. */
  const SAY = {
    'आर्षेणा': 'आरशेना',
    'गृह्णाति': 'ग्रिहनाति',
    'क्रीडामि': 'करीडामि',
    'सिंहस्य': 'सिम्हस्य',
    'सिंह': 'सिम्ह',
    'सिंहाः': 'सिम्हा',
    'न हि': 'नहि',
    'सिध्यन्ति': 'सिद्धयन्ति',
    'सिद्ध्यन्ति': 'सिद्धयन्ति',
    'पुनर्मिलामः': 'पुनर्मिलाम',
    'कक्षायां': 'कक्षायाम',
    'एकविंशतिः': 'एकविंशति'
  };

  function isSaCons(ch) {
    if (!ch) return false;
    const c = ch.charCodeAt(0);
    return (c >= 0x0915 && c <= 0x0939) || (c >= 0x0958 && c <= 0x095F);
  }
  function isSaComb(ch) {
    if (!ch) return false;
    const c = ch.charCodeAt(0);
    return (c >= 0x0900 && c <= 0x0903) || c === 0x093A || c === 0x093B ||
      (c >= 0x093C && c <= 0x094F) || c === 0x0962 || c === 0x0963;
  }
  function keepOpenA(s) {
    const chars = Array.from(s);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const next = chars[i + 1] || '';
      if (isSaCons(ch) && !isSaComb(next)) out += ch + '्अ';
      else out += ch;
    }
    return out;
  }

  function speakable(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return t;
    t = t.replace(/(^|[\s।॥])न हि(?=[\s।॥]|$)/g, '$1नहि');
    t = t.split(/(\s+)/).map(function (part) {
      const cut = part.match(/[।॥,.!?;:“”"‘’—\-]+$/);
      const core = cut ? part.slice(0, -cut[0].length) : part;
      return (SAY[core] || core) + (cut ? cut[0] : '');
    }).join('');
    t = t.replace(/ः/g, '');
    t = t.replace(/ऋ/g, 'रि');
    t = t.replace(/ॠ/g, 'री');
    t = t.replace(/ज्ञ/g, 'ग्य');
    t = t.replace(/[।॥]/g, '। ');
    t = keepOpenA(t);
    return t.replace(/\s+/g, ' ').trim();
  }

  async function postJson(path, body) {
    const my = gen;
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const t = speakable(text);
    if (!t) return '';
    const p = pace(rate);
    const cacheKey = p + '\n' + t;
    if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);
    const body = {
      text: t.slice(0, 2400),
      language_code: 'hi-IN',
      model: 'bulbul:v3',
      speaker: 'priya',
      pace: p,
      temperature: 0.3,
      output_audio_codec: 'mp3',
      speech_sample_rate: 24000
    };
    const data = await postJson('/text-to-speech', body);
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
        help: 'Sarvam इस बगीचे में पहले से चालू है।',
        on: 'Sarvam आवाज़ चालू',
        off: 'ब्राउज़र आवाज़'
      };
    }
    return {
      btn: 'Sarvam',
      title: 'Sarvam AI — clearer Sanskrit speech',
      help: 'Sarvam is already on in this garden.',
      on: 'Sarvam voice on',
      off: 'Browser voice'
    };
  }

  function mountBar(speedEl, lang, onChange) {
    const t = copy(lang);
    const wrap = document.createElement('div');
    wrap.className = 'sarvam-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = '✦ ' + t.btn;
    btn.title = t.on;
    wrap.appendChild(btn);
    speedEl.appendChild(wrap);
    return { sync: function () {} };
  }

  function guessSource(text) {
    const t = String(text || '');
    if (/[\u0900-\u097F]/.test(t)) return 'hi-IN';
    return 'en-IN';
  }

  function mountDesk(parent, lang, speakFn) {
    const hi = lang === 'hi';
    const box = document.createElement('div');
    box.className = 'sarvam-desk';
    const h = document.createElement('h3');
    h.textContent = hi ? '✦ Sarvam — लिखो, अनुवाद, सुनो' : '✦ Sarvam — type, translate, hear';
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = hi
      ? 'अंग्रेज़ी या हिन्दी लिखो। Sarvam उसे संस्कृत बनाएगा और साफ़ आवाज़ में पढ़ेगा।'
      : 'Type English or Hindi. Sarvam turns it into Sanskrit and reads it clearly.';
    const status = document.createElement('div');
    status.className = 'sarvam-status ok';
    status.textContent = hi ? 'Sarvam चालू है।' : 'Sarvam is on.';
    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.placeholder = hi ? 'उदा. मैं बगीचे में खेलता हूँ / I play in the garden' : 'e.g. I play in the garden / मैं बगीचे में खेलता हूँ';
    const hint = document.createElement('div');
    hint.className = 'sa-hint';
    let timer = null;
    ta.addEventListener('input', function () {
      clearTimeout(timer);
      const v = ta.value.trim();
      if (!hasKey() || !v || /[\u0900-\u097F]/.test(v) || !/[A-Za-z]/.test(v)) {
        hint.textContent = '';
        return;
      }
      timer = setTimeout(function () {
        transliterate(v).then(function (dev) {
          hint.textContent = (dev && dev !== v) ? ('देवनागरी: ' + dev) : '';
        }).catch(function () { hint.textContent = ''; });
      }, 450);
    });
    const out = document.createElement('div');
    out.className = 'sarvam-tr';
    out.hidden = true;
    const row = document.createElement('div');
    row.className = 'btnrow';
    const toSa = document.createElement('button');
    toSa.type = 'button';
    toSa.className = 'btn';
    toSa.textContent = hi ? 'संस्कृत में अनुवाद' : 'Translate to Sanskrit';
    const toHelp = document.createElement('button');
    toHelp.type = 'button';
    toHelp.className = 'btn ghost';
    toHelp.textContent = hi ? 'हिन्दी अर्थ' : 'English meaning';
    const hear = document.createElement('button');
    hear.type = 'button';
    hear.className = 'btn ghost';
    hear.textContent = hi ? '🔊 सुनो' : '🔊 Hear';
    let lastSa = '';
    function needKey() { return true; }
    toSa.onclick = async function () {
      if (!needKey()) return;
      const v = ta.value.trim();
      if (!v) return;
      toSa.disabled = true;
      out.hidden = false;
      out.textContent = hi ? 'अनुवाद आ रहा है…' : 'Translating…';
      try {
        const src = guessSource(v);
        lastSa = await translate(v, src, 'sa-IN');
        out.textContent = lastSa || (hi ? 'अनुवाद नहीं मिला।' : 'No translation came back.');
      } catch (e) {
        out.textContent = hi ? 'अनुवाद नहीं हो पाया।' : 'Translation did not work.';
      }
      toSa.disabled = false;
    };
    toHelp.onclick = async function () {
      if (!needKey()) return;
      const v = (lastSa || ta.value).trim();
      if (!v) return;
      toHelp.disabled = true;
      out.hidden = false;
      out.textContent = hi ? 'अर्थ आ रहा है…' : 'Translating…';
      try {
        const t = await translate(v, 'sa-IN', hi ? 'hi-IN' : 'en-IN');
        out.textContent = t || (hi ? 'अनुवाद नहीं मिला।' : 'No translation came back.');
      } catch (e) {
        out.textContent = hi ? 'अनुवाद नहीं हो पाया।' : 'Translation did not work.';
      }
      toHelp.disabled = false;
    };
    hear.onclick = function () {
      const v = lastSa || ta.value.trim();
      if (!v) return;
      if (typeof speakFn === 'function') speakFn(v);
    };
    row.appendChild(toSa);
    row.appendChild(toHelp);
    row.appendChild(hear);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(status);
    box.appendChild(ta);
    box.appendChild(hint);
    box.appendChild(row);
    box.appendChild(out);
    parent.appendChild(box);
  }

  global.Sarvam = {
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
    mountBar: mountBar,
    mountDesk: mountDesk
  };
})(window);
