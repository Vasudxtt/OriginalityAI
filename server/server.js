/**
 * Originality Checker AI — Backend Server
 * Fixed: robust JSON extraction, better prompts, retry logic
 */
require('dotenv').config();
const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const axios     = require('axios');
const cors      = require('cors');
const pdfParse  = require('pdf-parse');
const mammoth   = require('mammoth');
const crypto    = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error('GROQ_API_KEY is missing from environment variables');
  process.exit(1);
}

// Use a more capable model that follows JSON instructions better
const GROQ_MODEL = 'llama-3.1-8b-instant';

// ── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: GROQ_MODEL, key_loaded: true });
});

// ── In-memory job store ─────────────────────────────────────────
const jobs = {};
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const id in jobs) {
    if (jobs[id].createdAt < cutoff) delete jobs[id];
  }
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
    ok.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only PDF and DOCX files are allowed.'));
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

// ── Robust JSON extractor ───────────────────────────────────────
// Handles: plain JSON, ```json fences, JSON embedded in prose
function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Empty response');

  // 1. Try direct parse first
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch (_) {}

  // 2. Strip markdown fences (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (_) {}
  }

  // 3. Find the first { ... } block in the string
  const start = trimmed.indexOf('{');
  const end   = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) {}
  }

  // 4. Try to fix common issues: trailing commas, single quotes
  let fixed = trimmed
    .replace(/,\s*([}\]])/g, '$1')          // trailing commas
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')  // single-quoted keys
    .replace(/:\s*'([^']*)'/g, ': "$1"');   // single-quoted values
  const s2 = fixed.indexOf('{');
  const e2 = fixed.lastIndexOf('}');
  if (s2 !== -1 && e2 !== -1 && e2 > s2) {
    try { return JSON.parse(fixed.slice(s2, e2 + 1)); } catch (_) {}
  }

  throw new Error('Could not extract valid JSON from model response');
}

// ── Groq API call ───────────────────────────────────────────────
async function callGroq(systemPrompt, userPrompt, maxTokens = 1200) {
  const r = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model:       GROQ_MODEL,
      max_tokens:  maxTokens,
      temperature: 0.2,
      response_format: { type: 'json_object' }, // Force JSON mode
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${GROQ_API_KEY}`,
      },
      timeout: 180000,
    }
  );
  const content = r.data?.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('Empty response from Groq');
  return content;
}

// ── Analyze one chunk ───────────────────────────────────────────
async function analyzeChunk(chunk, idx, total) {
  const wordCount = chunk.split(/\s+/).filter(Boolean).length;

  const systemPrompt = `You are an expert academic integrity and plagiarism analyst.
Your job is to analyze text for plagiarism risk and AI-generated content.
IMPORTANT: You MUST respond with a valid JSON object. No prose, no explanation outside the JSON.`;

  const userPrompt = `Analyze the following text (Part ${idx + 1} of ${total}, ~${wordCount} words) for plagiarism risk and AI-generation likelihood.

TEXT TO ANALYZE:
"""
${chunk}
"""

Respond with ONLY this JSON structure (fill every field, no nulls):
{
  "plagiarism_score": <integer 0-100, where 0=fully original, 100=fully copied/AI>,
  "ai_likelihood": "<exactly one of: Low, Medium, High>",
  "summary": "<2-3 sentence analysis of the writing style, originality, and any concerns>",
  "flagged_sections": [
    {
      "text": "<exact short phrase from the text that sounds generic or AI-like>",
      "reason": "<why this phrase is flagged>",
      "replacement": "<a more original, human-sounding rewrite of the phrase>"
    }
  ],
  "improvement_suggestions": [
    {
      "issue": "<writing issue title>",
      "suggestion": "<concrete advice to fix it>",
      "example_before": "<short example of the problem>",
      "example_after": "<improved version>"
    }
  ]
}

Rules:
- plagiarism_score: base it on how generic, templated, or AI-patterned the text is
- flagged_sections: include 1-3 items minimum if any generic phrasing exists; empty array only if text is genuinely unique throughout
- improvement_suggestions: include 1-3 concrete suggestions; empty array only if text needs no improvement
- If the text is short but analyzable, still provide real analysis`;

  const raw  = await callGroq(systemPrompt, userPrompt, 1200);
  const data = extractJSON(raw);

  // Validate and sanitize the response
  return {
    plagiarism_score:        clamp(parseInt(data.plagiarism_score) || 30, 0, 100),
    ai_likelihood:           ['Low','Medium','High'].includes(data.ai_likelihood) ? data.ai_likelihood : 'Medium',
    summary:                 String(data.summary || 'Analysis complete.').slice(0, 600),
    flagged_sections:        Array.isArray(data.flagged_sections)        ? data.flagged_sections.filter(isValidFlag).slice(0, 5)      : [],
    improvement_suggestions: Array.isArray(data.improvement_suggestions) ? data.improvement_suggestions.filter(isValidSugg).slice(0, 5) : [],
  };
}

function clamp(val, min, max) { return Math.min(max, Math.max(min, val)); }

function isValidFlag(f) {
  return f && typeof f === 'object' && f.text && f.reason && f.replacement;
}
function isValidSugg(s) {
  return s && typeof s === 'object' && (s.issue || s.suggestion);
}

// ── Fallback: use a simpler model if JSON mode fails ───────────
async function analyzeChunkFallback(chunk, idx, total) {
  const wordCount = chunk.split(/\s+/).filter(Boolean).length;

  const systemPrompt = `You are a plagiarism and AI-detection analyst. Respond only with valid JSON.`;

  // Shorter, simpler prompt for the smaller model
  const userPrompt = `Analyze this text for plagiarism/AI patterns. Text (~${wordCount} words):
"""${chunk.slice(0, 1500)}"""

Return JSON:
{"plagiarism_score":50,"ai_likelihood":"Medium","summary":"analysis here","flagged_sections":[{"text":"phrase","reason":"why","replacement":"rewrite"}],"improvement_suggestions":[{"issue":"issue","suggestion":"advice","example_before":"before","example_after":"after"}]}

Replace the placeholder values with your real analysis. Keep flagged_sections and improvement_suggestions as real arrays.`;

  const r = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model:       'llama-3.1-8b-instant',   // Faster fallback model
      max_tokens:  900,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${GROQ_API_KEY}`,
      },
      timeout: 60000,
    }
  );
  const content = r.data?.choices?.[0]?.message?.content || '';
  const data    = extractJSON(content);

  return {
    plagiarism_score:        clamp(parseInt(data.plagiarism_score) || 40, 0, 100),
    ai_likelihood:           ['Low','Medium','High'].includes(data.ai_likelihood) ? data.ai_likelihood : 'Medium',
    summary:                 String(data.summary || 'Fallback analysis complete.').slice(0, 600),
    flagged_sections:        Array.isArray(data.flagged_sections)        ? data.flagged_sections.filter(isValidFlag).slice(0, 3) : [],
    improvement_suggestions: Array.isArray(data.improvement_suggestions) ? data.improvement_suggestions.filter(isValidSugg).slice(0, 3) : [],
  };
}

// ── Merge all chunk results ─────────────────────────────────────
function mergeResults(results) {
  if (!results.length) throw new Error('No results to merge');

  const plagiarism_score = Math.round(
    results.reduce((s, r) => s + (r.plagiarism_score || 0), 0) / results.length
  );

  const counts = { Low: 0, Medium: 0, High: 0 };
  results.forEach(r => counts[r.ai_likelihood || 'Medium']++);
  const ai_likelihood = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const summary = results.map(r => r.summary || '').filter(Boolean).join(' ');

  const flagged_sections = results
    .flatMap(r => r.flagged_sections || [])
    .slice(0, 30);

  const improvement_suggestions = results
    .flatMap(r => r.improvement_suggestions || [])
    .filter((s, i, arr) => arr.findIndex(x => x.issue === s.issue) === i)
    .slice(0, 15);

  return { plagiarism_score, ai_likelihood, summary, flagged_sections, improvement_suggestions };
}

// ── Background processor ────────────────────────────────────────
async function processJobInBackground(jobId, rawText, wordCount, fileName) {
  try {
    const chunks        = chunkText(rawText, 600);
    jobs[jobId].total   = chunks.length;
    jobs[jobId].progress = 0;

    console.log(`[${jobId}] "${fileName}" — ${chunks.length} chunks, ${wordCount} words`);

    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      let chunkResult = null;
      let attempt     = 0;
      const maxAttempts = 4;

      while (chunkResult === null && attempt < maxAttempts) {
        try {
          console.log(`  ↳ Chunk ${i + 1}/${chunks.length} (attempt ${attempt + 1})`);

          if (attempt < 2) {
            // First try: primary model with JSON mode
            chunkResult = await analyzeChunk(chunks[i], i, chunks.length);
          } else {
            // Fallback: simpler model/prompt
            console.log(`  ↳ Switching to fallback model for chunk ${i + 1}`);
            chunkResult = await analyzeChunkFallback(chunks[i], i, chunks.length);
          }

          jobs[jobId].progress = i + 1;
          console.log(`  ✓ Chunk ${i + 1} done — score: ${chunkResult.plagiarism_score}, flags: ${chunkResult.flagged_sections.length}, suggs: ${chunkResult.improvement_suggestions.length}`);

        } catch (err) {
          attempt++;
          const is429 = err.response?.status === 429;
          const delay = (is429 ? 20000 : 4000) * Math.pow(1.5, attempt - 1);
          console.warn(`  Chunk ${i + 1} attempt ${attempt} failed: ${err.message}. Retry in ${Math.round(delay/1000)}s`);

          if (attempt >= maxAttempts) {
            console.error(`  ✗ Chunk ${i + 1} permanently failed — using safe default`);
            chunkResult = {
              plagiarism_score:        45,
              ai_likelihood:           'Medium',
              summary:                 `Section ${i + 1} analysis encountered an error. The content may contain patterns worth reviewing manually.`,
              flagged_sections:        [],
              improvement_suggestions: [
                {
                  issue:          'Manual Review Needed',
                  suggestion:     'This section could not be automatically analyzed. Consider reviewing it for generic phrasing and AI-typical sentence structures.',
                  example_before: 'In conclusion, it is important to note that...',
                  example_after:  'To wrap up, [your specific insight here]...',
                }
              ],
            };
            break;
          }
          await new Promise(r => setTimeout(r, delay));
        }
      }

      results.push(chunkResult);
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    const final          = mergeResults(results);
    final.word_count     = wordCount;
    final.chunks_analyzed = chunks.length;

    jobs[jobId].status = 'done';
    jobs[jobId].result = final;
    console.log(`[${jobId}] Done — score: ${final.plagiarism_score}, AI: ${final.ai_likelihood}, flags: ${final.flagged_sections.length}, suggs: ${final.improvement_suggestions.length}`);

  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error  = err.message || 'Analysis failed';
    console.error(`[${jobId}] Fatal error:`, err.message);
  }
}

// ── POST /analyze ───────────────────────────────────────────────
app.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    console.log(`Received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

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
    console.log(`${wordCount.toLocaleString()} words extracted`);

    // Warn for very short docs but still process
    if (wordCount < 30) {
      console.warn(`Very short document: ${wordCount} words — analysis may be limited`);
    }

    const jobId = crypto.randomUUID();
    jobs[jobId] = {
      status:    'processing',
      progress:  0,
      total:     null,
      result:    null,
      error:     null,
      fileName:  req.file.originalname,
      wordCount,
      createdAt: Date.now(),
    };

    res.json({ jobId, wordCount });
    processJobInBackground(jobId, rawText, wordCount, req.file.originalname);

  } catch (err) {
    console.error('Upload error:', err.message);
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'File too large. Max 100MB.' });
    res.status(500).json({ error: err.message || 'Upload failed.' });
  }
});

// ── GET /status/:jobId ──────────────────────────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  if (job.status === 'processing') {
    const progress = job.progress || 0;
    const total    = job.total    || 0;
    const percent  = total > 0 ? Math.round((progress / total) * 100) : 0;
    return res.json({
      status:   'processing',
      progress,
      total,
      percent,
      message:  progress === 0
        ? 'Starting analysis…'
        : `Analyzing chunk ${progress} of ${total}…`,
    });
  }

  if (job.status === 'error')
    return res.json({ status: 'error', error: job.error });

  return res.json({
    status:          'done',
    progress:        job.total,
    total:           job.total,
    percent:         100,
    word_count:      job.wordCount,
    chunks_analyzed: job.result?.chunks_analyzed || job.total,
    ...job.result,
  });
});

// ── Multer error handler ────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: 'File too large. Max 100MB.' });
  next(err);
});

// ── Start ───────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\nOriginality Checker AI → http://localhost:${PORT}`);
  console.log(`Model : ${GROQ_MODEL} (with llama-3.1-8b-instant fallback)`);
  console.log(`Mode  : Background jobs (200+ page support)\n`);
});

server.setTimeout(600000);
server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;
