/**
 * Originality Checker AI — Backend Server
 * Secure + Production Ready
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
function chunkText(text, maxWords = 800) {
  const words = text.split(/\s+/).filter(Boolean);
  const out   = [];
  for (let i = 0; i < words.length; i += maxWords)
    out.push(words.slice(i, i + maxWords).join(' '));
  return out;
}

// ── Groq API call ───────────────────────────────────────────────
async function callGroq(prompt, maxTokens = 1024) {
  const r = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model:       GROQ_MODEL,
      max_tokens:  maxTokens,
      temperature: 0.35,
      messages: [
        {
          role:    'system',
          content: 'You are an expert academic integrity analyst. Respond with a single valid JSON object only. No markdown, no explanation, no code fences.',
        },
        { role: 'user', content: prompt },
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
  const prompt = `Part ${idx + 1} of ${total}. Analyze for plagiarism and AI-generation.

TEXT: """${chunk}"""

Reply with ONLY this JSON (no markdown, no fences):
{"plagiarism_score":<0-100>,"ai_likelihood":"Low|Medium|High","summary":"<2 sentences>","flagged_sections":[{"text":"<phrase>","reason":"<why>","replacement":"<rewrite>"}],"improvement_suggestions":[{"issue":"<issue>","suggestion":"<advice>","example_before":"<before>","example_after":"<after>"}]}

Rules: 0=original 100=AI/copied. Max 3 flagged phrases. Every flag needs replacement.`;

  const raw     = await callGroq(prompt, 1024);
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error(`JSON parse failed for chunk ${idx + 1}:`, cleaned.slice(0, 300));
    return {
      plagiarism_score:        50,
      ai_likelihood:           'Medium',
      summary:                 'Could not parse this section. Please review manually.',
      flagged_sections:        [],
      improvement_suggestions: [],
    };
  }
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
    const chunks        = chunkText(rawText, 800);
    jobs[jobId].total   = chunks.length;
    jobs[jobId].progress = 0;

    console.log(`[${jobId}] "${fileName}" — ${chunks.length} chunks, ${wordCount} words`);

    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      let success = false;
      let attempt = 0;

      while (!success && attempt < 5) {
        try {
          console.log(`  ↳ Chunk ${i + 1}/${chunks.length} (attempt ${attempt + 1})`);
          results.push(await analyzeChunk(chunks[i], i, chunks.length));
          jobs[jobId].progress = i + 1;
          success = true;
        } catch (err) {
          attempt++;
          const is429 = err.response?.status === 429;
          const delay = (is429 ? 15000 : 3000) * Math.pow(2, attempt - 1);
          console.warn(`  Chunk ${i + 1} attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms`);
          if (attempt >= 5) {
            results.push({
              plagiarism_score:        50,
              ai_likelihood:           'Medium',
              summary:                 `Chunk ${i + 1} could not be analyzed.`,
              flagged_sections:        [],
              improvement_suggestions: [],
            });
            break;
          }
          await new Promise(r => setTimeout(r, delay));
        }
      }

      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 3000));
    }

    const final        = mergeResults(results);
    final.word_count   = wordCount;
    final.chunks_analyzed = chunks.length;

    jobs[jobId].status = 'done';
    jobs[jobId].result = final;
    console.log(`[${jobId}] Done — score: ${final.plagiarism_score}, AI: ${final.ai_likelihood}`);

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
    if (!rawText || rawText.length < 50)
      return res.status(422).json({ error: 'Could not extract text from file.' });

    const wordCount = rawText.split(/\s+/).filter(Boolean).length;
    console.log(`${wordCount.toLocaleString()} words extracted`);

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
  console.log(`Model : ${GROQ_MODEL}`);
  console.log(`Mode  : Background jobs (200+ page support)\n`);
});

server.setTimeout(600000);
server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;
