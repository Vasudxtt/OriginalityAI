/**
 * Originality Checker AI — Backend Server
 * Rewritten: json_object mode only, detailed error logging, reliable JSON extraction
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
  console.error('❌ GROQ_API_KEY is missing from .env file');
  process.exit(1);
}
console.log('✅ GROQ_API_KEY loaded');

const MODEL = 'llama-3.3-70b-versatile';

// ── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', model: MODEL }));

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
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF and DOCX allowed.'));
  },
});

// ── Chunk text ──────────────────────────────────────────────────
function chunkText(text, maxWords = 500) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords)
    chunks.push(words.slice(i, i + maxWords).join(' '));
  return chunks;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Extract JSON from any LLM response ────────────────────────
function extractJSON(raw) {
  if (!raw) throw new Error('Empty response');
  const s = raw.trim();

  // Try 1: direct parse
  try { return JSON.parse(s); } catch (_) {}

  // Try 2: strip ```json ... ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (_) {} }

  // Try 3: find outermost { ... }
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
  }

  // Try 4: fix common JSON issues (trailing commas, single quotes)
  const fixed = s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ': "$1"');
  const s2 = fixed.indexOf('{'), e2 = fixed.lastIndexOf('}');
  if (s2 !== -1 && e2 > s2) {
    try { return JSON.parse(fixed.slice(s2, e2 + 1)); } catch (_) {}
  }

  throw new Error(`Cannot extract JSON. Raw response starts with: ${s.slice(0, 120)}`);
}

// ── Sanitize parsed result ─────────────────────────────────────
function sanitize(data) {
  return {
    plagiarism_score: Math.min(100, Math.max(0, parseInt(data.plagiarism_score) || 40)),
    ai_likelihood:    ['Low', 'Medium', 'High'].includes(data.ai_likelihood) ? data.ai_likelihood : 'Medium',
    summary:          String(data.summary || '').slice(0, 800) || 'Analysis complete.',
    flagged_sections: (Array.isArray(data.flagged_sections) ? data.flagged_sections : [])
      .filter(f => f && typeof f.text === 'string' && f.text.length > 0)
      .map(f => ({
        text:        String(f.text || '').slice(0, 300),
        reason:      String(f.reason || 'Flagged as potentially AI-generated or generic').slice(0, 300),
        replacement: String(f.replacement || 'Rewrite this phrase in your own voice').slice(0, 300),
      }))
      .slice(0, 5),
    improvement_suggestions: (Array.isArray(data.improvement_suggestions) ? data.improvement_suggestions : [])
      .filter(s => s && (s.issue || s.suggestion))
      .map(s => ({
        issue:          String(s.issue          || 'Writing Issue').slice(0, 200),
        suggestion:     String(s.suggestion     || 'Rewrite this section more naturally.').slice(0, 400),
        example_before: String(s.example_before || '').slice(0, 300),
        example_after:  String(s.example_after  || '').slice(0, 300),
      }))
      .slice(0, 5),
  };
}

// ── Call Groq API ──────────────────────────────────────────────
async function callGroq(userContent, maxTokens) {
  const systemPrompt = `You are an expert plagiarism and AI-content detection analyst.
You MUST respond with ONLY a raw JSON object — no markdown, no prose, no explanation, no code fences.
Start your response with { and end with }. Nothing else.`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model:           MODEL,
      max_tokens:      maxTokens || 1400,
      temperature:     0.15,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${GROQ_API_KEY}`,
      },
      timeout: 90000,
    }
  );

  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned empty content');
  return content;
}

// ── Analyze one chunk ──────────────────────────────────────────
async function analyzeChunk(chunk, idx, total) {
  const wc = chunk.split(/\s+/).filter(Boolean).length;

  const userPrompt = `Analyze the following text (Part ${idx + 1} of ${total}, ~${wc} words) for plagiarism risk and AI-generation likelihood.

TEXT:
"""
${chunk}
"""

Return ONLY a JSON object with EXACTLY these fields:

{
  "plagiarism_score": <integer 0-100, where 0=fully original human writing and 100=fully AI-generated or plagiarized>,
  "ai_likelihood": <"Low" or "Medium" or "High">,
  "summary": "<2-3 sentence analysis of writing style, originality, and concerns>",
  "flagged_sections": [
    {
      "text": "<exact short phrase from the text that sounds generic, templated, or AI-typical>",
      "reason": "<why this phrase is flagged>",
      "replacement": "<more natural, original rewrite of this phrase>"
    }
  ],
  "improvement_suggestions": [
    {
      "issue": "<title of the writing issue>",
      "suggestion": "<specific advice to fix it>",
      "example_before": "<example of the problem>",
      "example_after": "<improved version>"
    }
  ]
}

IMPORTANT RULES:
1. flagged_sections: Find 1-3 phrases. Only use [] if EVERY sentence is 100% unique and personal. Generic openers, passive voice, and AI-typical phrasing should be flagged.
2. improvement_suggestions: Provide 1-3 suggestions. Only use [] if the writing is genuinely excellent with no room for improvement.
3. plagiarism_score: Generic academic-style writing = 40-60. Clearly AI-generated = 70-90. Original personal writing = 10-30.
4. Return ONLY the JSON object. No other text.`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  ↳ Chunk ${idx + 1}/${total} — attempt ${attempt}`);
      const raw    = await callGroq(userPrompt, 1400);
      const parsed = extractJSON(raw);
      const result = sanitize(parsed);
      console.log(`  ✅ Chunk ${idx + 1} done: score=${result.plagiarism_score} ai=${result.ai_likelihood} flags=${result.flagged_sections.length} suggs=${result.improvement_suggestions.length}`);
      return result;
    } catch (err) {
      const status = err.response?.status;
      const errMsg = err.response?.data?.error?.message || err.message;
      console.error(`  ❌ Chunk ${idx + 1} attempt ${attempt} FAILED [HTTP ${status || 'N/A'}]: ${errMsg}`);

      if (status === 401) throw new Error('Invalid GROQ_API_KEY — check your .env file');
      if (status === 429) {
        const wait = 15000 * attempt;
        console.warn(`  ⏳ Rate limited — waiting ${wait / 1000}s`);
        await sleep(wait);
      } else if (attempt < 3) {
        await sleep(4000 * attempt);
      }
    }
  }

  // All 3 attempts failed — return honest fallback with real content
  console.error(`  💀 Chunk ${idx + 1} permanently failed — using generic fallback`);
  return {
    plagiarism_score: 50,
    ai_likelihood:    'Medium',
    summary:          `Section ${idx + 1} of ${total}: The analysis service encountered repeated errors for this section. This may indicate a temporary API issue or rate limit. Please try again in a few minutes.`,
    flagged_sections: [],
    improvement_suggestions: [{
      issue:          'Analysis Failed — Manual Review Suggested',
      suggestion:     'The automatic analysis could not complete. Manually check for: passive voice ("it is noted that"), generic transitions ("furthermore", "in conclusion"), and hedging language ("it is important to consider").',
      example_before: 'It is important to note that the results demonstrate significant findings.',
      example_after:  'The results show [specific finding] because [your reasoning].',
    }],
  };
}

// ── Merge chunk results ────────────────────────────────────────
function mergeResults(results) {
  if (!results.length) throw new Error('No results');
  const plagiarism_score = Math.round(
    results.reduce((s, r) => s + (r.plagiarism_score || 0), 0) / results.length
  );
  const counts = { Low: 0, Medium: 0, High: 0 };
  results.forEach(r => counts[r.ai_likelihood || 'Medium']++);
  const ai_likelihood = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const summary       = results.map(r => r.summary || '').filter(Boolean).join(' ');
  const flagged_sections = results.flatMap(r => r.flagged_sections || []).slice(0, 30);
  const improvement_suggestions = results
    .flatMap(r => r.improvement_suggestions || [])
    .filter((s, i, arr) => arr.findIndex(x => x.issue === s.issue) === i)
    .slice(0, 15);
  return { plagiarism_score, ai_likelihood, summary, flagged_sections, improvement_suggestions };
}

// ── Background processor ───────────────────────────────────────
async function processJob(jobId, rawText, wordCount, fileName) {
  try {
    const chunks         = chunkText(rawText, 500);
    jobs[jobId].total    = chunks.length;
    jobs[jobId].progress = 0;
    console.log(`\n[${jobId}] Starting: "${fileName}" — ${chunks.length} chunk(s), ${wordCount} words`);

    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      const result = await analyzeChunk(chunks[i], i, chunks.length);
      results.push(result);
      jobs[jobId].progress = i + 1;
      if (i < chunks.length - 1) await sleep(1500);
    }

    const final           = mergeResults(results);
    final.word_count      = wordCount;
    final.chunks_analyzed = chunks.length;
    jobs[jobId].status    = 'done';
    jobs[jobId].result    = final;
    console.log(`[${jobId}] ✅ Complete — score:${final.plagiarism_score} ai:${final.ai_likelihood} flags:${final.flagged_sections.length} suggs:${final.improvement_suggestions.length}\n`);
  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error  = err.message;
    console.error(`[${jobId}] ❌ Fatal:`, err.message);
  }
}

// ── POST /analyze ──────────────────────────────────────────────
app.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    console.log(`\nUpload: ${req.file.originalname} (${(req.file.size / 1048576).toFixed(2)} MB, ${req.file.mimetype})`);

    let rawText = '';
    try {
      if (req.file.mimetype === 'application/pdf') {
        const parsed = await pdfParse(req.file.buffer);
        rawText = parsed.text;
      } else {
        const parsed = await mammoth.extractRawText({ buffer: req.file.buffer });
        rawText = parsed.value;
      }
    } catch (parseErr) {
      console.error('File parse error:', parseErr.message);
      return res.status(422).json({ error: `Could not read file: ${parseErr.message}` });
    }

    rawText = rawText.replace(/\s+/g, ' ').trim();
    if (!rawText || rawText.length < 30) {
      return res.status(422).json({ error: 'File appears to be empty or could not extract text.' });
    }

    const wordCount = rawText.split(/\s+/).filter(Boolean).length;
    console.log(`Extracted ${wordCount} words`);

    const jobId = crypto.randomUUID();
    jobs[jobId] = {
      status: 'processing', progress: 0, total: null,
      result: null, error: null,
      fileName: req.file.originalname, wordCount, createdAt: Date.now(),
    };

    res.json({ jobId, wordCount });
    processJob(jobId, rawText, wordCount, req.file.originalname);
  } catch (err) {
    console.error('Upload handler error:', err.message);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File exceeds 100 MB.' });
    res.status(500).json({ error: err.message || 'Upload failed.' });
  }
});

// ── GET /status/:jobId ─────────────────────────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  if (job.status === 'processing') {
    const progress = job.progress || 0;
    const total    = job.total    || 0;
    const percent  = total > 0 ? Math.round((progress / total) * 100) : 0;
    return res.json({
      status: 'processing', progress, total, percent,
      message: progress === 0 ? 'Starting analysis…' : `Analyzing chunk ${progress} of ${total}…`,
    });
  }

  if (job.status === 'error') return res.json({ status: 'error', error: job.error });

  return res.json({
    status: 'done',
    progress: job.total, total: job.total, percent: 100,
    word_count: job.wordCount,
    chunks_analyzed: job.result?.chunks_analyzed || job.total,
    ...job.result,
  });
});

// ── Error middleware ───────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 100MB.' });
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ──────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Originality Checker AI → http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Mode:  json_object (reliable)\n`);
});
server.setTimeout(600000);
server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;
