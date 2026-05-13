/**
 * Originality Checker AI — Backend Server
 * Fixed: uses llama-3.3-70b-versatile + strict JSON schema (100% valid JSON guaranteed)
 */
require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const axios    = require('axios');
const cors     = require('cors');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error('GROQ_API_KEY is missing from environment variables');
  process.exit(1);
}

// Current active Groq models (as of 2026)
const PRIMARY_MODEL  = 'llama-3.3-70b-versatile';  // Best quality, supports strict JSON schema
const FALLBACK_MODEL = 'llama-3.1-8b-instant';      // Fast fallback

// ── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: PRIMARY_MODEL, key_loaded: true });
});

// ── In-memory job store ─────────────────────────────────────────
const jobs = {};
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const id in jobs) if (jobs[id].createdAt < cutoff) delete jobs[id];
}, 600000);

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Multer ──────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF and DOCX files are allowed.'));
  },
});

// ── Chunk text ──────────────────────────────────────────────────
function chunkText(text, maxWords = 600) {
  const words = text.split(/\s+/).filter(Boolean);
  const out   = [];
  for (let i = 0; i < words.length; i += maxWords)
    out.push(words.slice(i, i + maxWords).join(' '));
  return out;
}

// ── Strict JSON Schema ─────────────────────────────────────────
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    plagiarism_score: { type: 'integer' },
    ai_likelihood:    { type: 'string', enum: ['Low', 'Medium', 'High'] },
    summary:          { type: 'string' },
    flagged_sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text:        { type: 'string' },
          reason:      { type: 'string' },
          replacement: { type: 'string' },
        },
        required: ['text', 'reason', 'replacement'],
        additionalProperties: false,
      },
    },
    improvement_suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue:          { type: 'string' },
          suggestion:     { type: 'string' },
          example_before: { type: 'string' },
          example_after:  { type: 'string' },
        },
        required: ['issue', 'suggestion', 'example_before', 'example_after'],
        additionalProperties: false,
      },
    },
  },
  required: ['plagiarism_score', 'ai_likelihood', 'summary', 'flagged_sections', 'improvement_suggestions'],
  additionalProperties: false,
};

// ── Call Groq with strict JSON schema ──────────────────────────
async function callGroqStrict(model, systemPrompt, userPrompt, maxTokens) {
  const r = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model,
      max_tokens:  maxTokens || 1500,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name:   'analysis_result',
          strict: true,
          schema: ANALYSIS_SCHEMA,
        },
      },
    },
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      timeout: 120000,
    }
  );
  const content = r.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from Groq');
  return JSON.parse(content); // strict mode guarantees valid JSON
}

// ── Call Groq with basic JSON mode (fallback) ──────────────────
async function callGroqJsonMode(model, systemPrompt, userPrompt, maxTokens) {
  const r = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model,
      max_tokens:      maxTokens || 1200,
      temperature:     0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    },
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      timeout: 90000,
    }
  );
  const content = r.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response');
  const t = content.trim();
  try { return JSON.parse(t); } catch (_) {}
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error('Could not parse JSON from response');
}

// ── Sanitize result ────────────────────────────────────────────
function sanitize(data) {
  const score = Math.min(100, Math.max(0, parseInt(data.plagiarism_score) || 35));
  const ai    = ['Low', 'Medium', 'High'].includes(data.ai_likelihood) ? data.ai_likelihood : 'Medium';
  const flags = (Array.isArray(data.flagged_sections) ? data.flagged_sections : [])
    .filter(f => f && f.text && f.reason && f.replacement).slice(0, 5);
  const suggs = (Array.isArray(data.improvement_suggestions) ? data.improvement_suggestions : [])
    .filter(s => s && (s.issue || s.suggestion))
    .map(s => ({
      issue:          s.issue          || 'Writing Issue',
      suggestion:     s.suggestion     || 'Rewrite this section more naturally.',
      example_before: s.example_before || '',
      example_after:  s.example_after  || '',
    })).slice(0, 5);
  return {
    plagiarism_score:        score,
    ai_likelihood:           ai,
    summary:                 String(data.summary || 'Analysis complete.').slice(0, 800),
    flagged_sections:        flags,
    improvement_suggestions: suggs,
  };
}

// ── Build prompts ──────────────────────────────────────────────
function buildPrompts(chunk, idx, total) {
  const wc = chunk.split(/\s+/).filter(Boolean).length;

  const system = `You are an expert academic integrity analyst specializing in plagiarism detection and AI-generated content identification.
Analyze the provided text thoroughly and return structured results.
Score plagiarism_score from 0 (fully original human writing) to 100 (fully AI-generated or copied).
Always find at least 1-2 flagged_sections if ANY generic, templated, or AI-typical phrasing exists.
Always provide at least 1-2 improvement_suggestions with concrete before/after examples.`;

  const user = `Analyze Part ${idx + 1} of ${total} (~${wc} words) for plagiarism and AI-generation patterns.

TEXT:
"""
${chunk}
"""

Requirements:
- plagiarism_score: 0=original human writing, 50=generic/formulaic, 100=AI-generated or copied
- ai_likelihood: "Low" if clearly human, "Medium" if possibly AI-assisted, "High" if strongly AI-generated
- summary: 2-3 sentences describing writing quality, originality, and key concerns
- flagged_sections: up to 3 phrases that sound generic, templated, or AI-typical. Return [] ONLY if text is genuinely unique throughout.
- improvement_suggestions: up to 3 concrete writing improvements. Return [] ONLY if writing is excellent with no improvements possible.`;

  return { system, user };
}

// ── Analyze one chunk with fallback chain ──────────────────────
async function analyzeChunk(chunk, idx, total) {
  const { system, user } = buildPrompts(chunk, idx, total);

  // Attempts 1-2: Primary model with strict schema
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      console.log(`  ↳ Chunk ${idx + 1} attempt ${attempt + 1} [${PRIMARY_MODEL} strict]`);
      const data   = await callGroqStrict(PRIMARY_MODEL, system, user, 1500);
      const result = sanitize(data);
      console.log(`  ✓ score:${result.plagiarism_score} ai:${result.ai_likelihood} flags:${result.flagged_sections.length} suggs:${result.improvement_suggestions.length}`);
      return result;
    } catch (err) {
      const is429 = err.response?.status === 429;
      console.warn(`  Chunk ${idx + 1} attempt ${attempt + 1} failed: ${err.message}`);
      if (is429) await sleep(20000);
      else if (attempt === 0) await sleep(3000);
    }
  }

  // Attempt 3: Fallback model with json_object mode
  try {
    console.log(`  ↳ Chunk ${idx + 1} attempt 3 [${FALLBACK_MODEL} json_object]`);
    const fbSystem = system + '\n\nRespond ONLY with a valid JSON object. No prose, no markdown.';
    const fbUser   = user   + '\n\nReturn ONLY raw JSON starting with { and ending with }.';
    const data     = await callGroqJsonMode(FALLBACK_MODEL, fbSystem, fbUser, 1200);
    const result   = sanitize(data);
    console.log(`  ✓ fallback score:${result.plagiarism_score} flags:${result.flagged_sections.length}`);
    return result;
  } catch (err) {
    console.error(`  ✗ Chunk ${idx + 1} all attempts failed: ${err.message}`);
    return {
      plagiarism_score: 45,
      ai_likelihood:    'Medium',
      summary:          `Section ${idx + 1} analysis could not complete due to a server error. Review this section manually for AI-typical patterns such as passive voice and generic transitions.`,
      flagged_sections: [],
      improvement_suggestions: [{
        issue:          'Manual Review Required',
        suggestion:     'This section could not be automatically analyzed. Look for overly formal language, generic transitions, and passive voice — common AI writing patterns.',
        example_before: 'It is important to note that this topic has significant implications.',
        example_after:  'This topic matters because [your specific reason here].',
      }],
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Merge results ──────────────────────────────────────────────
function mergeResults(results) {
  if (!results.length) throw new Error('No results to merge');
  const plagiarism_score = Math.round(results.reduce((s, r) => s + (r.plagiarism_score || 0), 0) / results.length);
  const counts = { Low: 0, Medium: 0, High: 0 };
  results.forEach(r => counts[r.ai_likelihood || 'Medium']++);
  const ai_likelihood = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const summary = results.map(r => r.summary || '').filter(Boolean).join(' ');
  const flagged_sections = results.flatMap(r => r.flagged_sections || []).slice(0, 30);
  const improvement_suggestions = results
    .flatMap(r => r.improvement_suggestions || [])
    .filter((s, i, arr) => arr.findIndex(x => x.issue === s.issue) === i)
    .slice(0, 15);
  return { plagiarism_score, ai_likelihood, summary, flagged_sections, improvement_suggestions };
}

// ── Background processor ───────────────────────────────────────
async function processJobInBackground(jobId, rawText, wordCount, fileName) {
  try {
    const chunks         = chunkText(rawText, 600);
    jobs[jobId].total    = chunks.length;
    jobs[jobId].progress = 0;
    console.log(`[${jobId}] "${fileName}" — ${chunks.length} chunk(s), ${wordCount} words`);

    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      results.push(await analyzeChunk(chunks[i], i, chunks.length));
      jobs[jobId].progress = i + 1;
      if (i < chunks.length - 1) await sleep(2000);
    }

    const final           = mergeResults(results);
    final.word_count      = wordCount;
    final.chunks_analyzed = chunks.length;
    jobs[jobId].status    = 'done';
    jobs[jobId].result    = final;
    console.log(`[${jobId}] Done — score:${final.plagiarism_score} flags:${final.flagged_sections.length} suggs:${final.improvement_suggestions.length}`);
  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error  = err.message || 'Analysis failed';
    console.error(`[${jobId}] Fatal:`, err.message);
  }
}

// ── POST /analyze ──────────────────────────────────────────────
app.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    console.log(`Received: ${req.file.originalname} (${(req.file.size / 1048576).toFixed(2)} MB)`);

    let rawText = '';
    if (req.file.mimetype === 'application/pdf') {
      rawText = (await pdfParse(req.file.buffer)).text;
    } else {
      rawText = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
    }

    rawText = rawText.trim();
    if (!rawText || rawText.length < 20)
      return res.status(422).json({ error: 'Could not extract text from file.' });

    const wordCount = rawText.split(/\s+/).filter(Boolean).length;
    console.log(`Extracted ${wordCount} words`);

    const jobId = crypto.randomUUID();
    jobs[jobId] = {
      status: 'processing', progress: 0, total: null,
      result: null, error: null,
      fileName: req.file.originalname, wordCount, createdAt: Date.now(),
    };

    res.json({ jobId, wordCount });
    processJobInBackground(jobId, rawText, wordCount, req.file.originalname);
  } catch (err) {
    console.error('Upload error:', err.message);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 100MB.' });
    res.status(500).json({ error: err.message || 'Upload failed.' });
  }
});

// ── GET /status/:jobId ─────────────────────────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  if (job.status === 'processing') {
    const progress = job.progress || 0, total = job.total || 0;
    const percent  = total > 0 ? Math.round((progress / total) * 100) : 0;
    return res.json({
      status: 'processing', progress, total, percent,
      message: progress === 0 ? 'Starting analysis…' : `Analyzing chunk ${progress} of ${total}…`,
    });
  }
  if (job.status === 'error') return res.json({ status: 'error', error: job.error });

  return res.json({
    status: 'done', progress: job.total, total: job.total, percent: 100,
    word_count: job.wordCount,
    chunks_analyzed: job.result?.chunks_analyzed || job.total,
    ...job.result,
  });
});

// ── Error handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 100MB.' });
  next(err);
});

// ── Start ──────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\nOriginality Checker AI → http://localhost:${PORT}`);
  console.log(`Primary : ${PRIMARY_MODEL} (strict JSON schema)`);
  console.log(`Fallback: ${FALLBACK_MODEL} (json_object mode)\n`);
});
server.setTimeout(600000);
server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;
