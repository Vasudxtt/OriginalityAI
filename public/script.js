/**
 * Originality Checker AI — Frontend
 * Fixed: file input double-trigger, drag-and-drop, timer display
 */
'use strict';

// ── DOM refs ───────────────────────────────────────────────────────────────────
const dropZone        = document.getElementById('dropZone');
const fileInput       = document.getElementById('fileInput');
const filePreview     = document.getElementById('filePreview');
const fileNameEl      = document.getElementById('fileName');
const fileSizeEl      = document.getElementById('fileSize');
const fileExtEl       = document.getElementById('fileExt');
const fileRemove      = document.getElementById('fileRemove');
const analyzeBtn      = document.getElementById('analyzeBtn');
const loader          = document.getElementById('loader');
const loaderLabel     = document.getElementById('loaderLabel');
const loaderBar       = document.getElementById('loaderBar');
const results         = document.getElementById('results');
const uploadSection   = document.getElementById('uploadSection');
const themeBtn        = document.getElementById('themeBtn');
const historyList     = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistory');
const plagScore       = document.getElementById('plagScore');
const plagBar         = document.getElementById('plagBar');
const plagDesc        = document.getElementById('plagDesc');
const aiBadge         = document.getElementById('aiBadge');
const aiDesc          = document.getElementById('aiDesc');
const wordCount       = document.getElementById('wordCount');
const chunksCount     = document.getElementById('chunksCount');
const summaryText     = document.getElementById('summaryText');
const flagList        = document.getElementById('flagList');
const flagCount       = document.getElementById('flagCount');
const suggList        = document.getElementById('suggList');
const suggCount       = document.getElementById('suggCount');
const downloadBtn     = document.getElementById('downloadBtn');
const reuploadBtn     = document.getElementById('reuploadBtn');
const copyBtn         = document.getElementById('copyBtn');

// ── State ──────────────────────────────────────────────────────────────────────
var currentFile   = null;
var currentReport = null;
var pollTimer     = null;
var clockTimer    = null;
var startTime     = null;

// ── Theme ──────────────────────────────────────────────────────────────────────
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('.theme-icon').textContent = t === 'dark' ? '☀' : '☾';
  localStorage.setItem('oc_theme', t);
}
themeBtn.addEventListener('click', function() {
  var cur = document.documentElement.getAttribute('data-theme');
  setTheme(cur === 'dark' ? 'light' : 'dark');
});
setTheme(localStorage.getItem('oc_theme') || 'dark');

// ── File helpers ───────────────────────────────────────────────────────────────
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fmtTime(sec) {
  if (sec < 60) return sec + 's';
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  return s > 0 ? m + 'm ' + s + 's' : m + 'm';
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Handle selected file ───────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;

  var name = file.name || '';
  var ext  = name.lastIndexOf('.') !== -1
    ? name.slice(name.lastIndexOf('.')).toLowerCase()
    : '';

  var validExts  = ['.pdf', '.docx'];
  var validTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  if (!validExts.includes(ext) && !validTypes.includes(file.type)) {
    showToast('Only PDF and DOCX files are supported.', 'error');
    return;
  }

  if (file.size > 100 * 1024 * 1024) {
    showToast('File exceeds 100 MB limit.', 'error');
    return;
  }

  currentFile = file;
  fileNameEl.textContent = name;
  fileSizeEl.textContent = fmtSize(file.size);
  fileExtEl.textContent  = ext ? ext.replace('.', '').toUpperCase() : 'FILE';
  filePreview.classList.remove('hidden');
  analyzeBtn.disabled = false;
  showToast('File ready: ' + name, 'success');
}

function resetUpload() {
  currentFile = null;
  fileInput.value = '';
  filePreview.classList.add('hidden');
  analyzeBtn.disabled = true;
}

// ── Drag and drop ──────────────────────────────────────────────────────────────
dropZone.addEventListener('dragenter', function(e) {
  e.preventDefault(); e.stopPropagation();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragover', function(e) {
  e.preventDefault(); e.stopPropagation();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', function(e) {
  e.preventDefault(); e.stopPropagation();
  dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', function(e) {
  e.preventDefault(); e.stopPropagation();
  dropZone.classList.remove('drag-over');
  var files = e.dataTransfer && e.dataTransfer.files;
  if (files && files[0]) handleFile(files[0]);
});

// ── FIX: click handler ─────────────────────────────────────────────────────────
// The <label for="fileInput"> in HTML natively opens the file picker.
// We must NOT call fileInput.click() when the label itself is clicked —
// that causes a double-trigger which browsers silently cancel (nothing opens).
// Only trigger manually for clicks on the drop zone background/icon/text.
dropZone.addEventListener('click', function(e) {
  if (e.target.closest('label') || e.target.tagName === 'INPUT') return;
  fileInput.click();
});

// File input change
fileInput.addEventListener('change', function() {
  if (fileInput.files && fileInput.files[0]) {
    handleFile(fileInput.files[0]);
  }
  fileInput.value = ''; // reset so same file can be re-selected
});

// Remove file
fileRemove.addEventListener('click', resetUpload);

// ── Loader helpers ─────────────────────────────────────────────────────────────
function setLoaderMsg(msg) {
  if (loaderLabel) loaderLabel.textContent = msg;
}

function setLoaderProgress(percent, current, total) {
  // Stop indeterminate animation, switch to real progress
  loaderBar.style.animation  = 'none';
  loaderBar.style.marginLeft = '0';
  loaderBar.style.width      = Math.max(percent, 2) + '%';
  loaderBar.style.transition = 'width 0.8s ease';

  var pctEl = document.getElementById('loaderPercent');
  if (pctEl) pctEl.textContent = percent + '%';

  var timeEl = document.getElementById('loaderTime');
  if (timeEl && startTime && current >= 1 && total >= 1) {
    var elapsed   = (Date.now() - startTime) / 1000;
    var rate      = elapsed / current;
    var remaining = Math.round(rate * (total - current));
    if (current >= total) {
      timeEl.textContent = 'Almost done...';
    } else if (remaining > 0) {
      timeEl.textContent = '~' + fmtTime(remaining) + ' remaining';
    } else {
      timeEl.textContent = 'Calculating...';
    }
  }
}

function startClock() {
  stopClock();
  startTime = Date.now();
  clockTimer = setInterval(function() {
    var elEl = document.getElementById('loaderElapsed');
    if (elEl && startTime) {
      var elapsed = Math.round((Date.now() - startTime) / 1000);
      elEl.textContent = 'Elapsed: ' + fmtTime(elapsed);
    }
  }, 1000);
}

function stopClock() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function resetLoader() {
  loaderBar.style.animation  = '';
  loaderBar.style.marginLeft = '';
  loaderBar.style.width      = '0%';
  loaderBar.style.transition = '';
  setLoaderMsg('Extracting text...');
  var pctEl  = document.getElementById('loaderPercent');
  var timeEl = document.getElementById('loaderTime');
  var elEl   = document.getElementById('loaderElapsed');
  if (pctEl)  pctEl.textContent  = '';
  if (timeEl) timeEl.textContent = '';
  if (elEl)   elEl.textContent   = '';
}

// ── Analyze button ─────────────────────────────────────────────────────────────
analyzeBtn.addEventListener('click', async function() {
  if (!currentFile) {
    showToast('Please select a file first.', 'error');
    return;
  }

  uploadSection.classList.add('hidden');
  results.classList.add('hidden');
  loader.classList.remove('hidden');
  resetLoader();
  setLoaderMsg('Uploading document...');

  try {
    var fd = new FormData();
    fd.append('file', currentFile);

    var uploadRes  = await fetch('/analyze', { method: 'POST', body: fd });
    var uploadData = await uploadRes.json();

    if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
    if (!uploadData.jobId) throw new Error('Server did not return a job ID');

    setLoaderMsg('Analysis started...');
    startClock();
    await pollForResult(uploadData.jobId);

  } catch(err) {
    stopClock();
    stopPolling();
    loader.classList.add('hidden');
    uploadSection.classList.remove('hidden');
    showToast(err.message || 'Something went wrong. Please try again.', 'error');
  }
});

// ── Polling ────────────────────────────────────────────────────────────────────
function pollForResult(jobId) {
  return new Promise(function(resolve, reject) {
    var errors = 0;

    pollTimer = setInterval(async function() {
      try {
        var res  = await fetch('/status/' + jobId);
        var data = await res.json();
        errors = 0;

        if (data.status === 'processing') {
          var current = data.progress || 0;
          var total   = data.total    || 0;
          var percent = data.percent  || 0;

          if (current === 0) {
            setLoaderMsg(total > 0
              ? 'Warming up — chunk 1 of ' + total + '...'
              : 'Starting analysis...');
          } else {
            setLoaderMsg('Analyzing chunk ' + current + ' of ' + total + '...');
            setLoaderProgress(percent, current, total);
          }

        } else if (data.status === 'done') {
          stopPolling();
          stopClock();
          setLoaderMsg('Complete!');
          setLoaderProgress(100, 1, 1);
          currentReport = Object.assign({}, data, { fileName: currentFile.name });
          setTimeout(function() {
            renderResults(data);
            saveHistory(data, currentFile.name);
          }, 400);
          resolve();

        } else if (data.status === 'error') {
          stopPolling();
          stopClock();
          reject(new Error(data.error || 'Analysis failed on server'));
        }

      } catch(err) {
        errors++;
        if (errors >= 5) {
          stopPolling();
          stopClock();
          reject(new Error('Lost connection to server. Please try again.'));
        }
      }
    }, 4000);
  });
}

// ── Render results ─────────────────────────────────────────────────────────────
function renderResults(data) {
  loader.classList.add('hidden');

  var score = Math.min(100, Math.max(0, data.plagiarism_score || 0));
  plagScore.textContent = score;
  plagBar.style.width = '0%';
  setTimeout(function() { plagBar.style.width = score + '%'; }, 100);
  plagDesc.textContent = scoreDesc(score);

  var likelihood = (data.ai_likelihood || 'Medium').trim();
  aiBadge.textContent = likelihood;
  aiBadge.className   = 'ai-badge ' + likelihood.toLowerCase();
  aiDesc.textContent  = aiDescText(likelihood);

  wordCount.textContent   = (data.word_count || 0).toLocaleString();
  chunksCount.textContent = data.chunks_analyzed || 1;
  summaryText.textContent = data.summary || 'No summary available.';

  var flags = data.flagged_sections || [];
  flagCount.textContent = flags.length;
  flagList.innerHTML = '';
  if (!flags.length) {
    flagList.innerHTML = '<p style="font-size:14px;color:var(--text3);padding:8px 0">No phrases flagged — looks good!</p>';
  } else {
    flags.forEach(function(f) { flagList.appendChild(buildFlagItem(f)); });
  }

  var suggs = data.improvement_suggestions || [];
  suggCount.textContent = suggs.length;
  suggList.innerHTML = '';
  if (!suggs.length) {
    suggList.innerHTML = '<p style="font-size:14px;color:var(--text3);padding:8px 0">No suggestions — well written!</p>';
  } else {
    suggs.forEach(function(s, i) { suggList.appendChild(buildSuggItem(s, i + 1)); });
  }

  results.classList.remove('hidden');
  results.classList.add('fade-in');
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Flag item ──────────────────────────────────────────────────────────────────
function buildFlagItem(f) {
  var div = document.createElement('div');
  div.className = 'flag-item';
  var replacement = f.replacement || 'Consider rewriting this phrase in your own voice.';
  div.innerHTML =
    '<div class="flag-original">' +
      '<div class="flag-original-left">' +
        '<span class="flag-label">Flagged Phrase</span>' +
        '<span class="flag-text">"' + esc(f.text || '') + '"</span>' +
        '<span class="flag-reason">' + esc(f.reason || '') + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="flag-replacement">' +
      '<div class="flag-replacement-left">' +
        '<span class="replacement-label">Suggested Replacement</span>' +
        '<span class="replacement-text">"' + esc(replacement) + '"</span>' +
      '</div>' +
      '<button class="copy-btn">Copy</button>' +
    '</div>';
  div.querySelector('.copy-btn').addEventListener('click', function() {
    var btn = this;
    navigator.clipboard.writeText(replacement).then(function() {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });
  return div;
}

// ── Suggestion item ────────────────────────────────────────────────────────────
function buildSuggItem(s, num) {
  var div = document.createElement('div');
  div.className = 'sugg-item';
  if (typeof s === 'string') {
    div.innerHTML =
      '<div class="sugg-header">' +
        '<div class="sugg-num">' + num + '</div>' +
        '<div class="sugg-issue">' + esc(s) + '</div>' +
      '</div>';
  } else {
    div.innerHTML =
      '<div class="sugg-header">' +
        '<div class="sugg-num">' + num + '</div>' +
        '<div class="sugg-issue">' + esc(s.issue || s.suggestion || '') + '</div>' +
      '</div>' +
      (s.suggestion ? '<p class="sugg-advice">' + esc(s.suggestion) + '</p>' : '') +
      (s.example_before || s.example_after
        ? '<div class="sugg-examples">' +
            '<div class="ex-box before"><div class="ex-label">Before</div><div class="ex-text">' + esc(s.example_before || '—') + '</div></div>' +
            '<div class="ex-box after"><div class="ex-label">After</div><div class="ex-text">' + esc(s.example_after || '—') + '</div></div>' +
          '</div>'
        : '');
  }
  return div;
}

// ── Action buttons ─────────────────────────────────────────────────────────────
reuploadBtn.addEventListener('click', function() {
  stopPolling(); stopClock();
  results.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  resetLoader(); resetUpload();
  startTime = null;
  uploadSection.scrollIntoView({ behavior: 'smooth' });
});

copyBtn.addEventListener('click', function() {
  if (!currentReport) return;
  navigator.clipboard.writeText(buildReportText(currentReport))
    .then(function() { showToast('Report copied!', 'success'); });
});

downloadBtn.addEventListener('click', function() {
  if (!currentReport) return;
  var blob = new Blob([buildReportText(currentReport)], { type: 'text/plain' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = 'originality-report.txt'; a.click();
  URL.revokeObjectURL(url);
  showToast('Report downloaded!', 'success');
});

function buildReportText(data) {
  var sep = '================================================================';
  var sub = '----------------------------------------------------------------';
  var lines = [
    sep, '  ORIGINALITY CHECKER AI — FULL REPORT', sep,
    'File    : ' + (data.fileName || 'Unknown'),
    'Date    : ' + new Date().toLocaleString(),
    '',
    'Plagiarism Risk Score   : ' + data.plagiarism_score + '/100',
    'AI-Generated Likelihood : ' + data.ai_likelihood,
    'Word Count              : ' + (data.word_count || 0).toLocaleString(),
    'Chunks Analyzed         : ' + (data.chunks_analyzed || 1),
    '', sub, 'SUMMARY', sub,
    data.summary || '—', ''
  ];
  lines.push(sub, 'FLAGGED PHRASES + REPLACEMENTS', sub);
  (data.flagged_sections || []).forEach(function(f, i) {
    lines.push(
      (i+1) + '. FLAGGED      : "' + f.text + '"',
      '   REASON       : ' + f.reason,
      '   REPLACE WITH : "' + (f.replacement || 'Rewrite in your own voice') + '"', ''
    );
  });
  lines.push(sub, 'IMPROVEMENT SUGGESTIONS', sub);
  (data.improvement_suggestions || []).forEach(function(s, i) {
    if (typeof s === 'string') {
      lines.push((i+1) + '. ' + s, '');
    } else {
      lines.push(
        (i+1) + '. ISSUE  : ' + (s.issue || ''),
        '   ADVICE : ' + (s.suggestion || ''),
        '   BEFORE : ' + (s.example_before || ''),
        '   AFTER  : ' + (s.example_after || ''), ''
      );
    }
  });
  lines.push(sep, 'Results are indicative. Not a legal guarantee.');
  return lines.join('\n');
}

// ── History ────────────────────────────────────────────────────────────────────
function saveHistory(data, fileName) {
  var hist = getHistory();
  hist.unshift({
    id: Date.now(), fileName,
    plagiarism_score: data.plagiarism_score,
    ai_likelihood: data.ai_likelihood,
    date: new Date().toLocaleDateString()
  });
  localStorage.setItem('oc_history', JSON.stringify(hist.slice(0, 10)));
  renderHistory();
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem('oc_history') || '[]'); } catch(e) { return []; }
}

function renderHistory() {
  var hist = getHistory();
  historyList.innerHTML = '';
  if (!hist.length) {
    historyList.innerHTML = '<li class="history-empty">No analyses yet — upload a document to begin.</li>';
    return;
  }
  hist.forEach(function(item) {
    var sc    = item.plagiarism_score || 0;
    var color = sc <= 30 ? '#4eff9a' : sc <= 60 ? '#ffc84e' : '#ff5e5e';
    var ext   = (item.fileName || '').split('.').pop().toUpperCase().slice(0, 4);
    var li    = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML =
      '<div class="hist-icon" style="background:' + color + '">' + esc(ext) + '</div>' +
      '<span class="hist-name">' + esc(item.fileName || '—') + '</span>' +
      '<span class="hist-badge" style="background:' + color + '18;color:' + color + ';border:1px solid ' + color + '">' + sc + '/100</span>' +
      '<span class="hist-ai">' + esc(item.ai_likelihood || '') + '</span>' +
      '<span class="hist-date">' + esc(item.date || '') + '</span>';
    historyList.appendChild(li);
  });
}

clearHistoryBtn.addEventListener('click', function() {
  localStorage.removeItem('oc_history');
  renderHistory();
});
renderHistory();

// ── Helpers ────────────────────────────────────────────────────────────────────
function scoreDesc(s) {
  if (s <= 20) return 'Highly original — very low risk';
  if (s <= 40) return 'Mostly original — minor patterns detected';
  if (s <= 60) return 'Moderate risk — several generic sections';
  if (s <= 80) return 'High risk — significant unoriginal content';
  return 'Very high risk — largely non-original';
}

function aiDescText(l) {
  if (l === 'Low')    return 'Clearly human-authored writing';
  if (l === 'Medium') return 'Possible AI-assistance detected';
  return 'Strong AI-generation patterns — humanise significantly';
}

function showToast(msg, type) {
  var old = document.querySelector('.oc-toast');
  if (old) old.remove();
  var t = document.createElement('div');
  t.className   = 'oc-toast';
  t.textContent = msg;
  var isErr = type === 'error';
  t.style.cssText =
    'position:fixed;bottom:28px;right:28px;z-index:9999;' +
    'padding:13px 22px;border-radius:12px;font-size:13px;font-weight:600;' +
    'background:' + (isErr ? 'rgba(255,94,94,0.15)' : 'rgba(78,255,154,0.15)') + ';' +
    'border:1px solid ' + (isErr ? '#ff5e5e' : '#4eff9a') + ';' +
    'color:' + (isErr ? '#ff5e5e' : '#4eff9a') + ';' +
    'backdrop-filter:blur(16px);max-width:340px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.3);';
  document.body.appendChild(t);
  setTimeout(function() { t.remove(); }, 3500);
}
