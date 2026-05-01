/**
 * Originality Checker AI — Frontend v4
 * Full rewrite — polling + time remaining + percent + elapsed
 */
'use strict';
// ── DOM ────────────────────────────────────────────────────────────────────────
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const filePreview = document.getElementById('filePreview');
const fileNameEl = document.getElementById('fileName');
const fileSizeEl = document.getElementById('fileSize');
const fileExtEl = document.getElementById('fileExt');
const fileRemove = document.getElementById('fileRemove');
const analyzeBtn = document.getElementById('analyzeBtn');
const loader = document.getElementById('loader');
const loaderLabel = document.getElementById('loaderLabel');
const loaderBar = document.getElementById('loaderBar');
const results = document.getElementById('results');
const uploadSection = document.getElementById('uploadSection');
const themeBtn = document.getElementById('themeBtn');
const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistory');
const plagScore = document.getElementById('plagScore');
const plagBar = document.getElementById('plagBar');
const plagDesc = document.getElementById('plagDesc');
const aiBadge = document.getElementById('aiBadge');
const aiDesc = document.getElementById('aiDesc');
const wordCount = document.getElementById('wordCount');
const chunksCount = document.getElementById('chunksCount');
const summaryText = document.getElementById('summaryText');
const flagList = document.getElementById('flagList');
const flagCount = document.getElementById('flagCount');
const suggList = document.getElementById('suggList');
const suggCount = document.getElementById('suggCount');
const downloadBtn = document.getElementById('downloadBtn');
const reuploadBtn = document.getElementById('reuploadBtn');
const copyBtn = document.getElementById('copyBtn');
// ── State ──────────────────────────────────────────────────────────────────────
let currentFile = null;
let currentReport = null;
let pollTimer = null;
let clockTimer = null;
let startTime = null;
// ── Theme ──────────────────────────────────────────────────────────────────────
function setTheme(t) {
 document.documentElement.setAttribute('data-theme', t);
 document.querySelector('.theme-icon').textContent = t === 'dark' ? '☀' : '☾';
 localStorage.setItem('oc_theme', t);
}
themeBtn.addEventListener('click', () => {
 setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});
setTheme(localStorage.getItem('oc_theme') || 'dark');
// ── Drag & Drop ────────────────────────────────────────────────────────────────
// Drag over styling
dropZone.addEventListener('dragenter', ev => { ev.preventDefault(); ev.stopPropagation(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragover', ev => { ev.preventDefault(); ev.stopPropagation(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ev => { ev.preventDefault(); ev.stopPropagation(); dropZone.classList.remove('drag-over'); });
// Drop — pick up file from drag
dropZone.addEventListener('drop', ev => {
 ev.preventDefault();
 ev.stopPropagation();
 dropZone.classList.remove('drag-over');
 const file = ev.dataTransfer.files[0];
 if (file) handleFile(file);
});
// Click on drop zone → open file picker (but NOT if clicking the Browse button itself)
dropZone.addEventListener('click', ev => {
 if (ev.target.tagName === 'LABEL' || ev.target.tagName === 'INPUT') return;
 fileInput.click();
});
// Browse button label click → open file picker
document.querySelector('.drop-btn')?.addEventListener('click', ev => {
 ev.stopPropagation();
 fileInput.click();
});
// File selected via picker
fileInput.addEventListener('change', () => {
 if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
});
// ── File Handling ──────────────────────────────────────────────────────────────
function handleFile(file) {
 if (!file) return;
 const name = file.name || '';
 const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
 const validExts = ['.pdf', '.docx'];
 const validTypes = [
 'application/pdf',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
 ];
 // Accept if extension OR mimetype matches (some browsers report mimetype differently)
 const validExt = validExts.includes(ext);
 const validMime = validTypes.includes(file.type) || file.type === '';
 if (!validExt && !validMime) {
 showToast(' Only PDF and DOCX files are supported.', 'error');
 return;
 }
 if (file.size > 100 * 1024 * 1024) {
 showToast(' File exceeds 100 MB limit.', 'error');
 return;
 }
 currentFile = file;
 fileNameEl.textContent = name;
 fileSizeEl.textContent = fmtSize(file.size);
 fileExtEl.textContent = ext ? ext.replace('.', '').toUpperCase() : 'FILE';
 filePreview.classList.remove('hidden');
 analyzeBtn.disabled = false;
 showToast(' File ready: ' + name, 'success');
}
fileRemove.addEventListener('click', resetUpload);
function resetUpload() {
 currentFile = null;
 fileInput.value = '';
 filePreview.classList.add('hidden');
 analyzeBtn.disabled = true;
}
function fmtSize(b) {
 if (b < 1024) return b + ' B';
 if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
 return (b / 1048576).toFixed(1) + ' MB';
}
// ── Loader UI Helpers ──────────────────────────────────────────────────────────
function getEl(id) { return document.getElementById(id); }
function setProgress(percent, current, total) {
 // Progress bar fill
 loaderBar.style.animation = 'none';
 loaderBar.style.marginLeft = '0';
 loaderBar.style.width = Math.max(percent, 2) + '%';
 loaderBar.style.transition = 'width 0.8s ease';
 // Percent text
 const pctEl = getEl('loaderPercent');
 if (pctEl) pctEl.textContent = percent + '%';
 // Time remaining
 const timeEl = getEl('loaderTime');
 if (timeEl && startTime && current >= 1 && total >= 1) {
 const elapsedSec = (Date.now() - startTime) / 1000;
 const secPerChunk = elapsedSec / current;
 const remainingSec = Math.round(secPerChunk * (total - current));
 if (current >= total) {
 timeEl.textContent = '✓ Almost done…';
 } else if (remainingSec > 0) {
 timeEl.textContent = ' ~' + fmtTime(remainingSec) + ' remaining';
 } else {
 timeEl.textContent = ' Calculating…';
 }
 }
}
function startClock() {
 stopClock();
 startTime = Date.now();
 // Tick elapsed time every second
 clockTimer = setInterval(() => {
 const el = getEl('loaderElapsed');
 if (el && startTime) {
 el.textContent = 'Elapsed: ' + fmtTime(Math.round((Date.now() - startTime) / 1000));
 }
 }, 1000);
}
function stopClock() {
 if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
}
function resetLoaderUI() {
 loaderBar.style.animation = '';
 loaderBar.style.marginLeft = '';
 loaderBar.style.width = '0%';
 loaderBar.style.transition = '';
 const pctEl = getEl('loaderPercent');
 const timeEl = getEl('loaderTime');
 const elEl = getEl('loaderElapsed');
 if (pctEl) pctEl.textContent = '';
 if (timeEl) timeEl.textContent = '';
 if (elEl) elEl.textContent = '';
 if (loaderLabel) loaderLabel.textContent = 'Extracting text…';
}
function fmtTime(sec) {
 if (sec < 60) return sec + 's';
 const m = Math.floor(sec / 60);
 const s = sec % 60;
 return s > 0 ? m + 'm ' + s + 's' : m + 'm';
}
// ── Analyze ────────────────────────────────────────────────────────────────────
analyzeBtn.addEventListener('click', async () => {
 if (!currentFile) return;
 // Show loader
 uploadSection.classList.add('hidden');
 results.classList.add('hidden');
 loader.classList.remove('hidden');
 resetLoaderUI();
 loaderLabel.textContent = 'Uploading document…';
 try {
 // Step 1 — Upload file, get jobId back instantly
 const fd = new FormData();
 fd.append('file', currentFile);
 const uploadRes = await fetch('/analyze', { method: 'POST', body: fd });
 const uploadData = await uploadRes.json();
 if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
 if (!uploadData.jobId) throw new Error('Server did not return a job ID');
 loaderLabel.textContent = 'Analysis started…';
 startClock();
 // Step 2 — Poll until done
 await pollForResult(uploadData.jobId);
 } catch (err) {
 stopClock();
 stopPolling();
 loader.classList.add('hidden');
 uploadSection.classList.remove('hidden');
 showToast(' ' + (err.message || 'Unexpected error. Please try again.'), 'error');
 }
});
// ── Polling ────────────────────────────────────────────────────────────────────
function stopPolling() {
 if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function pollForResult(jobId) {
 return new Promise((resolve, reject) => {
 let errors = 0;
 pollTimer = setInterval(async () => {
 try {
 const res = await fetch('/status/' + jobId);
 const data = await res.json();
 errors = 0;
 if (data.status === 'processing') {
 const pct = data.percent || 0;
 const current = data.progress || 0;
 const total = data.total || 0;
 loaderLabel.textContent = total > 0
 ? 'Analyzing chunk ' + current + ' of ' + total + '…'
 : 'Starting analysis…';
 if (total > 0 && pct > 0) setProgress(pct, current, total);
 } else if (data.status === 'done') {
 stopPolling();
 stopClock();
 loaderLabel.textContent = 'Complete!';
 setProgress(100, 1, 1);
 currentReport = { ...data, fileName: currentFile.name };
 setTimeout(() => {
 renderResults(data);
 saveHistory(data, currentFile.name);
 }, 400);
 resolve();
 } else if (data.status === 'error') {
 stopPolling();
 stopClock();
 reject(new Error(data.error || 'Analysis failed on server'));
 }
 } catch (err) {
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
// ── Render Results ─────────────────────────────────────────────────────────────
function renderResults(data) {
 loader.classList.add('hidden');
 const score = Math.min(100, Math.max(0, data.plagiarism_score || 0));
 plagScore.textContent = score;
 plagBar.style.width = '0%';
 setTimeout(() => { plagBar.style.width = score + '%'; }, 100);
 plagDesc.textContent = scoreDesc(score);
 const likelihood = (data.ai_likelihood || 'Medium').trim();
 aiBadge.textContent = likelihood;
 aiBadge.className = 'ai-badge ' + likelihood.toLowerCase();
 aiDesc.textContent = aiDescText(likelihood);
 wordCount.textContent = (data.word_count || 0).toLocaleString();
 chunksCount.textContent = data.chunks_analyzed || 1;
 summaryText.textContent = data.summary || 'No summary available.';
 // Flagged sections
 const flags = data.flagged_sections || [];
 flagCount.textContent = flags.length;
 flagList.innerHTML = '';
 if (!flags.length) {
 flagList.innerHTML = '<p style="font-size:14px;color:var(--text3);padding:8px 0">No phrases flagged — looks good!</p>';
 } else {
 flags.forEach(f => flagList.appendChild(buildFlagItem(f)));
 }
 // Suggestions
 const suggs = data.improvement_suggestions || [];
 suggCount.textContent = suggs.length;
 suggList.innerHTML = '';
 if (!suggs.length) {
 suggList.innerHTML = '<p style="font-size:14px;color:var(--text3);padding:8px 0">No specific suggestions — well written!</p>';
 } else {
 suggs.forEach((s, i) => suggList.appendChild(buildSuggItem(s, i + 1)));
 }
 results.classList.remove('hidden');
 results.classList.add('fade-in');
 results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// ── Flag Item ──────────────────────────────────────────────────────────────────
function buildFlagItem(f) {
 const div = document.createElement('div');
 div.className = 'flag-item';
 const replacement = f.replacement || 'Consider rewriting this phrase in your own authentic voice.';
 div.innerHTML = `
 <div class="flag-original">
 <div class="flag-original-left">
 <span class="flag-label">⚠ Flagged Phrase</span>
 <span class="flag-text">"${esc(f.text || '')}"</span>
 <span class="flag-reason">${esc(f.reason || '')}</span>
 </div>
 </div>
 <div class="flag-replacement">
 <div class="flag-replacement-left">
 <span class="replacement-label">✦ Suggested Replacement</span>
 <span class="replacement-text">"${esc(replacement)}"</span>
 </div>
 <button class="copy-btn" title="Copy replacement text">⎘ Copy</button>
 </div>`;
 div.querySelector('.copy-btn').addEventListener('click', function () {
 navigator.clipboard.writeText(replacement).then(() => {
 this.textContent = '✓ Copied';
 this.classList.add('copied');
 setTimeout(() => { this.textContent = '⎘ Copy'; this.classList.remove('copied'); }, 2000);
 });
 });
 return div;
}
// ── Suggestion Item ────────────────────────────────────────────────────────────
function buildSuggItem(s, num) {
 const div = document.createElement('div');
 div.className = 'sugg-item';
 if (typeof s === 'string') {
 div.innerHTML = `
 <div class="sugg-header">
 <div class="sugg-num">${num}</div>
 <div class="sugg-issue">${esc(s)}</div>
 </div>`;
 } else {
 div.innerHTML = `
 <div class="sugg-header">
 <div class="sugg-num">${num}</div>
 <div class="sugg-issue">${esc(s.issue || s.suggestion || '')}</div>
 </div>
 ${s.suggestion ? `<p class="sugg-advice">${esc(s.suggestion)}</p>` : ''}
 ${s.example_before || s.example_after ? `
 <div class="sugg-examples">
 <div class="ex-box before">
 <div class="ex-label">Before</div>
 <div class="ex-text">${esc(s.example_before || '—')}</div>
 </div>
 <div class="ex-box after">
 <div class="ex-label">After</div>
 <div class="ex-text">${esc(s.example_after || '—')}</div>
 </div>
 </div>` : ''}`;
 }
 return div;
}
// ── Actions ────────────────────────────────────────────────────────────────────
reuploadBtn.addEventListener('click', () => {
 stopPolling();
 stopClock();
 results.classList.add('hidden');
 uploadSection.classList.remove('hidden');
 resetLoaderUI();
 resetUpload();
 uploadSection.scrollIntoView({ behavior: 'smooth' });
});
copyBtn.addEventListener('click', () => {
 if (!currentReport) return;
 navigator.clipboard.writeText(buildReportText(currentReport))
 .then(() => showToast(' Report summary copied!', 'success'));
});
downloadBtn.addEventListener('click', () => {
 if (!currentReport) return;
 const blob = new Blob([buildReportText(currentReport)], { type: 'text/plain' });
 const url = URL.createObjectURL(blob);
 const a = Object.assign(document.createElement('a'), {
 href: url, download: 'originality-report.txt'
 });
 a.click();
 URL.revokeObjectURL(url);
 showToast(' Report downloaded!', 'success');
});
function buildReportText(data) {
 const sep = '═'.repeat(52);
 const sub = '─'.repeat(52);
 const lines = [
 sep, ' ORIGINALITY CHECKER AI — FULL REPORT', sep,
 `File : ${data.fileName || 'Unknown'}`,
 `Date : ${new Date().toLocaleString()}`,
 '',
 `Plagiarism Risk Score : ${data.plagiarism_score}/100 (${scoreDesc(data.plagiarism_score)})`,
 `AI-Generated Likelihood : ${data.ai_likelihood} (${aiDescText(data.ai_likelihood)})`,
 `Word Count : ${(data.word_count || 0).toLocaleString()}`,
 `Chunks Analyzed : ${data.chunks_analyzed || 1}`,
 '', sub, 'SUMMARY', sub,
 data.summary || '—', '',
 sub, 'FLAGGED PHRASES + REPLACEMENTS', sub,
 ...(data.flagged_sections || []).flatMap((f, i) => [
 `${i + 1}. FLAGGED : "${f.text}"`,
 ` REASON : ${f.reason}`,
 ` REPLACE WITH : "${f.replacement || 'Rewrite in your own voice'}"`,
 ''
 ]),
 sub, 'IMPROVEMENT SUGGESTIONS', sub,
 ...(data.improvement_suggestions || []).flatMap((s, i) => {
 if (typeof s === 'string') return [`${i + 1}. ${s}`, ''];
 return [
 `${i + 1}. ISSUE : ${s.issue || ''}`,
 ` ADVICE : ${s.suggestion || ''}`,
 ` BEFORE : ${s.example_before || ''}`,
 ` AFTER : ${s.example_after || ''}`,
 ''
 ];
 }),
 sep,
 'Results are indicative. Not a legal guarantee.',
 ];
 return lines.join('\n');
}
// ── History ────────────────────────────────────────────────────────────────────
function saveHistory(data, fileName) {
 const hist = getHistory();
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
 try { return JSON.parse(localStorage.getItem('oc_history') || '[]'); } catch { return []; }
}
function renderHistory() {
 const hist = getHistory();
 historyList.innerHTML = '';
 if (!hist.length) {
 historyList.innerHTML = '<li class="history-empty">No analyses yet — upload a document to begin.</li>';
 return;
 }
 hist.forEach(item => {
 const sc = item.plagiarism_score || 0;
 const color = sc <= 30 ? '#4eff9a' : sc <= 60 ? '#ffc84e' : '#ff5e5e';
 const ext = (item.fileName || '').split('.').pop().toUpperCase().slice(0, 4);
 const li = document.createElement('li');
 li.className = 'history-item';
 li.innerHTML = `
 <div class="hist-icon" style="background:${color}">${esc(ext)}</div>
 <span class="hist-name">${esc(item.fileName || '—')}</span>
 <span class="hist-badge" style="background:${color}18;color:${color};border:1px solid ${color}">${sc}/100</span>
 <span class="hist-ai">${esc(item.ai_likelihood || '')}</span>
 <span class="hist-date">${esc(item.date || '')}</span>`;
 historyList.appendChild(li);
 });
}
clearHistoryBtn.addEventListener('click', () => {
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
 if (l === 'Low') return 'Clearly human-authored writing';
 if (l === 'Medium') return 'Possible AI-assistance detected';
 return 'Strong AI-generation patterns — humanise significantly';
}
function esc(str) {
 return String(str || '')
 .replace(/&/g, '&amp;').replace(/</g, '&lt;')
 .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function showToast(msg, type = 'info') {
 document.querySelector('.oc-toast')?.remove();
 const t = document.createElement('div');
 t.className = 'oc-toast';
 t.textContent = msg;
 Object.assign(t.style, {
 position: 'fixed', bottom: '28px', right: '28px', zIndex: '9999',
 padding: '13px 22px', borderRadius: '12px',
 fontSize: '13px', fontWeight: '600',
 background: type === 'error' ? 'rgba(255,94,94,0.15)' : 'rgba(78,255,154,0.15)',
 border: `1px solid ${type === 'error' ? '#ff5e5e' : '#4eff9a'}`,
 color: type === 'error' ? '#ff5e5e' : '#4eff9a',
 backdropFilter: 'blur(16px)',
 animation: 'fadeUp 0.3s ease',
 maxWidth: '340px',
 boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
 });
 document.body.appendChild(t);
 setTimeout(() => t.remove(), 3500);
}
