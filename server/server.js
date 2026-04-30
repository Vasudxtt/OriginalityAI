/**
 * Originality Checker AI — Backend Server
 * Groq / llama-3.3-70b-versatile
 * Background job processing — supports 200+ page documents
 * Client polls /status/:jobId instead of waiting on one long request
 */

require("dotenv").config();
const express  = require("express");
const multer   = require("multer");
const path     = require("path");
const axios    = require("axios");
const cors     = require("cors");
const pdfParse = require("pdf-parse");
const mammoth  = require("mammoth");
const crypto   = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const GROQ_MODEL   = 'llama-3.1-8b-instant';

// ── In-memory job store ───────────────────────────────────────────────────────
const jobs = {};
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const id in jobs) {
    if (jobs[id].createdAt < oneHourAgo) delete jobs[id];
  }
}, 600000);

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only PDF and DOCX files are allowed."));
  },
});

function chunkText(text, maxWords = 2000) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += maxWords)
    out.push(words.slice(i, i + maxWords).join(" "));
  return out;
}

async function callGroq(userPrompt, maxTokens = 2000) {
  const r = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content: "You are an expert academic integrity analyst and humanisation coach. Respond with a single valid JSON object only — no markdown fences, no commentary, no extra text whatsoever.",
        },
        { role: "user", content: userPrompt },
      ],
    },
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      timeout: 180000,
    }
  );
  const content = r.data?.choices?.[0]?.message?.content || "";
  if (!content) throw new Error("Empty response from Groq API");
  return content;
}

async function analyzeChunk(chunk, idx, total) {
  const prompt = `Analyze this text excerpt (part ${idx + 1} of ${total}) for originality, plagiarism risk, and AI-generation patterns.

TEXT:
"""
${chunk}
"""

Return ONLY a valid JSON object with this exact schema:
{
  "plagiarism_score": <integer 0-100>,
  "ai_likelihood": "<Low|Medium|High>",
  "summary": "<3-4 sentences covering originality, writing style, and AI patterns found>",
  "flagged_sections": [
    {
      "text": "<the exact problematic phrase, up to 100 chars>",
      "reason": "<why this phrase is flagged>",
      "replacement": "<a rewritten, more human, original version of just that phrase>"
    }
  ],
  "improvement_suggestions": [
    {
      "issue": "<the specific writing problem>",
      "suggestion": "<concrete actionable advice>",
      "example_before": "<short example of the problematic style>",
      "example_after": "<rewritten example showing the improvement>"
    }
  ]
}
Scoring: plagiarism_score 0=highly original, 100=AI/copied. Flag 3-6 phrases per chunk. Each flagged section MUST have a replacement.`;

  const raw = await callGroq(prompt, 2000);
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  return JSON.parse(cleaned);
}

function mergeResults(results) {
  if (!results.length) throw new Error("No results to merge");
  const plagiarism_score = Math.round(results.reduce((s, r) => s + (r.plagiarism_score || 0), 0) / results.length);
  const counts = { Low: 0, Medium: 0, High: 0 };
  results.forEach((r) => { counts[r.ai_likelihood || "Medium"]++; });
  const ai_likelihood = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const summary = results.map((r) => r.summary || "").filter(Boolean).join(" ");
  const flagged_sections = results.flatMap((r) => r.flagged_sections || []).slice(0, 30);
  const improvement_suggestions = results
    .flatMap((r) => r.improvement_suggestions || [])
    .filter((s, i, arr) => arr.findIndex(x => x.issue === s.issue) === i)
    .slice(0, 15);
  return { plagiarism_score, ai_likelihood, summary, flagged_sections, improvement_suggestions };
}

// ── Background processor ──────────────────────────────────────────────────────
async function processJobInBackground(jobId, rawText, wordCount, fileName) {
  try {
    const chunks = chunkText(rawText, 3000); // bigger chunks = fewer API calls
    jobs[jobId].total = chunks.length;
    console.log(`🔄 [${jobId}] Processing ${chunks.length} chunks for "${fileName}"...`);

    const chunkResults = [];
    for (let i = 0; i < chunks.length; i++) {
      let attempt = 0;
      let success = false;
      while (attempt < 5 && !success) {
        try {
          console.log(`  ↳ [${jobId}] Chunk ${i + 1}/${chunks.length} (attempt ${attempt + 1})`);
          chunkResults.push(await analyzeChunk(chunks[i], i, chunks.length));
          jobs[jobId].progress = i + 1;
          success = true;
        } catch (err) {
          attempt++;
          const is429 = err.response?.status === 429;
          // Exponential backoff: 15s, 30s, 60s, 120s for 429; 3s, 6s, 12s for others
          const baseDelay = is429 ? 15000 : 3000;
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.log(`  ⚠️  [${jobId}] Chunk ${i + 1} failed (${is429 ? '429 rate limit' : err.message}). Waiting ${delay/1000}s before retry...`);
          if (attempt >= 5) throw new Error(`Chunk ${i + 1} failed after 5 attempts: ${err.message}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      // 2s between chunks = stays within Groq free tier 30 req/min
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 3000));
    }

    const final = mergeResults(chunkResults);
    final.word_count = wordCount;
    final.chunks_analyzed = chunks.length;
    jobs[jobId].status = "done";
    jobs[jobId].result = final;
    console.log(`✅ [${jobId}] Done — score: ${final.plagiarism_score}, AI: ${final.ai_likelihood}`);
  } catch (err) {
    jobs[jobId].status = "error";
    jobs[jobId].error = err.message || "Analysis failed";
    console.error(`❌ [${jobId}] Error:`, err.message);
  }
}

// ── POST /analyze — returns jobId immediately ─────────────────────────────────
app.post("/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    console.log(`📁 File: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    let rawText = "";
    if (req.file.mimetype === "application/pdf") {
      rawText = (await pdfParse(req.file.buffer)).text;
    } else {
      rawText = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
    }

    rawText = rawText.trim();
    if (!rawText || rawText.length < 50)
      return res.status(422).json({ error: "Could not extract enough text from the file." });

    const wordCount = rawText.split(/\s+/).filter(Boolean).length;
    console.log(`📝 Extracted ${wordCount.toLocaleString()} words`);

    const jobId = crypto.randomUUID();
    jobs[jobId] = { status: "processing", progress: 0, total: null, result: null, error: null, fileName: req.file.originalname, wordCount, createdAt: Date.now() };

    // ✅ Respond immediately — no timeout risk
    res.json({ jobId, wordCount, message: "Analysis started. Poll /status/" + jobId + " for progress." });

    // Process in background after response is sent
    processJobInBackground(jobId, rawText, wordCount, req.file.originalname);

  } catch (err) {
    console.error("❌ Upload error:", err.message);
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File too large. Max 100MB." });
    res.status(500).json({ error: err.message || "Upload failed." });
  }
});

// ── GET /status/:jobId — poll every 5 seconds ─────────────────────────────────
app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found." });

  if (job.status === "processing") {
    return res.json({
      status: "processing",
      progress: job.progress,
      total: job.total,
      percent: job.total ? Math.round((job.progress / job.total) * 100) : 0,
      message: job.total ? `Analyzing chunk ${job.progress} of ${job.total}...` : "Starting analysis...",
    });
  }

  if (job.status === "error") return res.json({ status: "error", error: job.error });

  return res.json({ status: "done", progress: job.total, total: job.total, percent: 100, word_count: job.wordCount, ...job.result });
});

// ── Multer error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File too large. Max 100MB." });
  next(err);
});

const server = app.listen(PORT, () => {
  console.log(`\n🚀  Originality Checker AI  →  http://localhost:${PORT}`);
  console.log(`    AI  : Groq / ${GROQ_MODEL}`);
  console.log(`    Mode: Background jobs — supports 200+ page documents\n`);
});

server.setTimeout(600000);
server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;
