/**
 * Originality Checker AI — Backend Server
 * Optimized for Render free tier: fast model + short chunks + reliable JSON
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
if (!GROQ_API_KEY) { console.error('GROQ_API_KEY missing'); process.exit(1); }

// llama-3.1-8b-instant = responds in 2-3 seconds, perfect for Render free tier
// llama-3.3-70b-versatile = 15-25 seconds, times out on Render free tier
const MODEL = 'llama-3.1-8b-instant';

app.get('/health', (req, res) => res.json({ status: 'ok', model: MODEL }));

const jobs = {};
setInterval(() => {
  const cut = Date.now() - 3600000;
  for (const id in jobs) if (jobs[id].createdAt < cut) delete jobs[id];
}, 600000);

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF and DOCX allowed.'));
  },
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Keep chunks small so 8b model handles them well
function chunkText(text, maxWords = 300) {
  const words = text.split(/\s+/).filter(Boolean);
  const out   = [];
  for (let i = 0; i < words.length; i += maxWords)
    out.push(words.slice(i, i + maxWords).join(' '));
  return out;
}

function extractJSON(raw) {
  if (!raw) throw new Error('Empty response');
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/im, '').replace(/```\s*$/m, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {} }
  // Fix trailing commas
  const fixed = s.replace(/,(\s*[}\]])/g, '$1');
  const c = fixed.indexOf('{'), d = fixed.lastIndexOf('}');
  if (c !== -1 && d > c) { try { return JSON.parse(fixed.slice(c, d + 1)); } catch (_) {} }
  throw new Error('No JSON found in: ' + s.slice(0, 80));
}

function sanitize(d) {
  const flags = (Array.isArray(d.flagged_sections) ? d.flagged_sections : [])
    .filter(f => f && f.text && f.reason && f.replacement)
    .slice(0, 5);
  const suggs = (Array.isArray(d.improvement_suggestions) ? d.improvement_suggestions : [])
    .filter(s => s && s.issue && s.suggestion)
    .map(s => ({
      issue:          String(s.issue).slice(0, 200),
      suggestion:     String(s.suggestion).slice(0, 400),
      example_before: String(s.example_before || '').slice(0, 300),
      example_after:  String(s.example_after  || '').slice(0, 300),
    }))
    .slice(0, 5);
  return {
    plagiarism_score:        Math.min(100, Math.max(0, parseInt(d.plagiarism_score) || 40)),
    ai_likelihood:           ['Low','Medium','High'].includes(d.ai_likelihood) ? d.ai_likelihood : 'Medium',
    summary:                 String(d.summary || 'Analysis complete.').slice(0, 800),
    flagged_sections:        flags,
    improvement_suggestions: suggs,
  };
}

async function analyzeChunk(chunk, idx, total) {
  const wc = chunk.split(/\s+/).filter(Boolean).length;

  // Two-shot prompting: give the model an example of what we want
  const systemMsg = `You are a plagiarism and AI-detection API. You respond ONLY with raw JSON. Never use markdown. Never add explanation. Only output the JSON object.

Example of correct output:
{"plagiarism_score":45,"ai_likelihood":"Medium","summary":"The text shows several AI-typical patterns including passive constructions and generic transitions. Some phrases appear templated. Overall originality is moderate.","flagged_sections":[{"text":"it is important to note","reason":"Classic AI filler phrase","replacement":"notably"},{"text":"in conclusion, it can be said","reason":"Generic AI closing","replacement":"to summarize"}],"improvement_suggestions":[{"issue":"Passive Voice Overuse","suggestion":"Rewrite passive sentences in active voice to sound more human.","example_before":"It was found that the results were significant.","example_after":"We found significant results."}]}`;

  const userMsg = `Analyze this text (part ${idx + 1}/${total}, ~${wc} words) for plagiarism and AI-generation:

"""
${chunk}
"""

Output a single JSON object with these exact keys:
- plagiarism_score: integer 0-100 (0=original human, 100=AI/copied)
- ai_likelihood: "Low" or "Medium" or "High"  
- summary: 2-3 sentences about originality and writing style
- flagged_sections: array of {text, reason, replacement} — find 1-3 AI-typical or generic phrases; use [] only if text is genuinely unique
- improvement_suggestions: array of {issue, suggestion, example_before, example_after} — give 1-3 real suggestions; use [] only if writing is excellent

Raw JSON only. Start with {`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  Chunk ${idx+1}/${total} attempt ${attempt}...`);
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model:           MODEL,
          max_tokens:      900,
          temperature:     0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user',   content: userMsg   },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization:  `Bearer ${GROQ_API_KEY}`,
          },
          timeout: 25000, // 25s — fits within Render's limits
        }
      );

      const raw    = res.data?.choices?.[0]?.message?.content;
      const parsed = extractJSON(raw);
      const result = sanitize(parsed);
      console.log(`  ✓ Chunk ${idx+1}: score=${result.plagiarism_score} ai=${result.ai_likelihood} flags=${result.flagged_sections.length} suggs=${result.improvement_suggestions.length}`);
      return result;

    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.error?.message || err.message;
      console.error(`  ✗ Chunk ${idx+1} attempt ${attempt} [${status||'ERR'}]: ${msg}`);

      if (status === 401) throw new Error('Invalid GROQ_API_KEY');
      if (status === 429) await sleep(15000);
      else await sleep(3000 * attempt);
    }
  }

  // Permanent fallback
  return {
    plagiarism_score:        50,
    ai_likelihood:           'Medium',
    summary:                 `Section ${idx+1} could not be analyzed due to repeated API errors. Check your Groq API key and rate limits.`,
    flagged_sections:        [],
    improvement_suggestions: [{
      issue:          'API Error — Could Not Analyze',
      suggestion:     'The analysis failed. Check: 1) GROQ_API_KEY is valid, 2) You have not exceeded your Groq rate limit, 3) Try re-uploading.',
      example_before: 'It is important to note that...',
      example_after:  'This matters because [specific reason]...',
    }],
  };
}

function mergeResults(results) {
  const plagiarism_score = Math.round(results.reduce((s,r) => s + r.plagiarism_score, 0) / results.length);
  const counts = { Low:0, Medium:0, High:0 };
  results.forEach(r => counts[r.ai_likelihood]++);
  const ai_likelihood = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
  const summary       = results.map(r => r.summary).filter(Boolean).join(' ');
  const flagged_sections        = results.flatMap(r => r.flagged_sections).slice(0, 30);
  const improvement_suggestions = results
    .flatMap(r => r.improvement_suggestions)
    .filter((s,i,a) => a.findIndex(x => x.issue === s.issue) === i)
    .slice(0, 15);
  return { plagiarism_score, ai_likelihood, summary, flagged_sections, improvement_suggestions };
}

async function processJob(jobId, rawText, wordCount, fileName) {
  try {
    const chunks         = chunkText(rawText, 300);
    jobs[jobId].total    = chunks.length;
    jobs[jobId].progress = 0;
    console.log(`[${jobId}] "${fileName}" — ${chunks.length} chunks, ${wordCount} words`);

    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      results.push(await analyzeChunk(chunks[i], i, chunks.length));
      jobs[jobId].progress = i + 1;
      if (i < chunks.length - 1) await sleep(500);
    }

    const final           = mergeResults(results);
    final.word_count      = wordCount;
    final.chunks_analyzed = chunks.length;
    jobs[jobId].status    = 'done';
    jobs[jobId].result    = final;
    console.log(`[${jobId}] DONE score=${final.plagiarism_score} flags=${final.flagged_sections.length} suggs=${final.improvement_suggestions.length}`);
  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error  = err.message;
    console.error(`[${jobId}] FATAL:`, err.message);
  }
}

app.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    console.log(`File: ${req.file.originalname} (${(req.file.size/1048576).toFixed(2)}MB)`);

    let rawText = '';
    if (req.file.mimetype === 'application/pdf') {
      rawText = (await pdfParse(req.file.buffer)).text;
    } else {
      rawText = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
    }

    rawText = rawText.replace(/\s+/g,' ').trim();
    if (!rawText || rawText.length < 30)
      return res.status(422).json({ error: 'No text could be extracted.' });

    const wordCount = rawText.split(/\s+/).filter(Boolean).length;
    console.log(`Extracted: ${wordCount} words`);

    const jobId = crypto.randomUUID();
    jobs[jobId] = {
      status:'processing', progress:0, total:null,
      result:null, error:null,
      fileName:req.file.originalname, wordCount, createdAt:Date.now(),
    };
    res.json({ jobId, wordCount });
    processJob(jobId, rawText, wordCount, req.file.originalname);
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large.' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status === 'processing') {
    const progress = job.progress||0, total = job.total||0;
    return res.json({
      status:'processing', progress, total,
      percent: total>0 ? Math.round(progress/total*100) : 0,
      message: progress===0 ? 'Starting…' : `Analyzing chunk ${progress} of ${total}…`,
    });
  }
  if (job.status === 'error') return res.json({ status:'error', error:job.error });
  return res.json({
    status:'done', progress:job.total, total:job.total, percent:100,
    word_count:job.wordCount,
    chunks_analyzed: job.result?.chunks_analyzed || job.total,
    ...job.result,
  });
});

app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large.' });
  res.status(500).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`\n=== Originality Checker AI ===`);
  console.log(`URL  : http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Key  : ${GROQ_API_KEY.slice(0,8)}...`);
  console.log(`==============================\n`);
});
server.setTimeout(600000);
server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;
