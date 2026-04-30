/**
 * Originality Checker AI — Backend Server
 * Groq / llama-3.3-70b-versatile
 * Chunked processing + replacement text suggestions per flagged section
 * Max file size: 100MB
 */

require("dotenv").config();
const express  = require("express");
const multer   = require("multer");
const path     = require("path");
const axios    = require("axios");
const cors     = require("cors");
const pdfParse = require("pdf-parse");
const mammoth  = require("mammoth");

const app  = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

app.use(cors());
// ── Increase Express body parser limit to 100MB ────────────────────────────────
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

// ── Increase server timeout for large file processing on Render ───────────────
app.use((req, res, next) => {
  res.setTimeout(600000); // 10 minutes
  next();
});
app.use(express.static(path.join(__dirname, "../public")));

// ── Multer: memory, 100 MB, PDF+DOCX only ─────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    const ok = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    ok.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only PDF and DOCX files are allowed."));
  },
});

// ── Chunk ~3000 words (bigger chunks = fewer API calls for large files) ─────────
function chunkText(text, maxWords = 3000) {
  const words = text.split(/\s+/).filter(Boolean);
  const out   = [];
  for (let i = 0; i < words.length; i += maxWords)
    out.push(words.slice(i, i + maxWords).join(" "));
  return out;
}

// ── Groq call with longer timeout for large files ─────────────────────────────
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
          content:
            "You are an expert academic integrity analyst and humanisation coach. " +
            "Respond with a single valid JSON object only — no markdown fences, no commentary, no extra text whatsoever.",
        },
        { role: "user", content: userPrompt },
      ],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      timeout: 180000, // 3 minutes per chunk (up from 90s)
    }
  );
  const content = r.data?.choices?.[0]?.message?.content || "";
  if (!content) throw new Error("Empty response from Groq API");
  return content;
}

// ── Analyse one chunk ──────────────────────────────────────────────────────────
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
      "reason": "<why this phrase is flagged — generic, AI-patterned, plagiarised-sounding, etc.>",
      "replacement": "<a rewritten, more human, original version of just that phrase — same meaning, different wording>"
    }
  ],
  "improvement_suggestions": [
    {
      "issue": "<the specific writing problem being addressed>",
      "suggestion": "<concrete actionable advice>",
      "example_before": "<short example of the problematic style>",
      "example_after": "<rewritten example showing the improvement>"
    }
  ]
}

Scoring:
- plagiarism_score: 0=highly original/human, 100=clearly copied or AI-generated
- ai_likelihood: Low=clearly human voice; Medium=AI-assisted probable; High=AI-generated likely
- Flag at least 3-6 specific phrases per chunk if present
- Each flagged section MUST include a "replacement" — a humanised rewrite of that phrase
- Suggestions must have concrete before/after examples showing how to humanise the text`;

  const raw     = await callGroq(prompt, 2000);
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  return JSON.parse(cleaned);
}

// ── Merge all chunk results ────────────────────────────────────────────────────
function mergeResults(results) {
  if (!results.length) throw new Error("No results to merge");

  const plagiarism_score = Math.round(
    results.reduce((s, r) => s + (r.plagiarism_score || 0), 0) / results.length
  );

  const counts = { Low: 0, Medium: 0, High: 0 };
  results.forEach((r) => { counts[r.ai_likelihood || "Medium"]++; });
  const ai_likelihood = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const summary = results.map((r) => r.summary || "").filter(Boolean).join(" ");

  const flagged_sections = results
    .flatMap((r) => r.flagged_sections || [])
    .slice(0, 20); // increased from 12 to 20 for large files

  const improvement_suggestions = results
    .flatMap((r) => r.improvement_suggestions || [])
    .filter((s, i, arr) => arr.findIndex(x => x.issue === s.issue) === i) // dedupe
    .slice(0, 12); // increased from 8 to 12 for large files

  return { plagiarism_score, ai_likelihood, summary, flagged_sections, improvement_suggestions };
}

// ── POST /analyze ──────────────────────────────────────────────────────────────
app.post("/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    console.log(`📁 File received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    let rawText = "";
    if (req.file.mimetype === "application/pdf") {
      const parsed = await pdfParse(req.file.buffer);
      rawText = parsed.text;
    } else {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      rawText = result.value;
    }

    rawText = rawText.trim();
    if (!rawText || rawText.length < 50)
      return res.status(422).json({ error: "Could not extract enough text from the file." });

    const wordCount = rawText.split(/\s+/).filter(Boolean).length;
    console.log(`📝 Extracted ${wordCount.toLocaleString()} words`);

    const chunks = chunkText(rawText, 3000);
    console.log(`📄 Analyzing ${chunks.length} chunk(s) via Groq...`);

    // ── Process chunks with a small delay to avoid Groq rate limits ────────────
    const chunkResults = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`  ↳ Chunk ${i + 1}/${chunks.length}…`);
      chunkResults.push(await analyzeChunk(chunks[i], i, chunks.length));

      // Small delay between chunks to avoid hitting rate limits on large files
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const final = mergeResults(chunkResults);
    final.word_count      = wordCount;
    final.chunks_analyzed = chunks.length;

    console.log(`✅ Analysis complete — score: ${final.plagiarism_score}, AI: ${final.ai_likelihood}`);
    res.json(final);

  } catch (err) {
    console.error("❌ Error:", err.message);

    // Friendly error messages
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Maximum size is 100MB." });
    }
    if (err.message?.includes("rate limit") || err.response?.status === 429) {
      return res.status(429).json({ error: "API rate limit hit. Please wait a moment and try again." });
    }

    res.status(500).json({ error: err.message || "Analysis failed." });
  }
});

// ── Error handler for multer file size ────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 100MB." });
  }
  next(err);
});

const server = app.listen(PORT, () => {
  console.log(`\n🚀  Originality Checker AI  →  http://localhost:${PORT}`);
  console.log(`    AI  : Groq / ${GROQ_MODEL}`);
  console.log(`    Max : 100MB uploads\n`);
});

// ── Extend timeout for large file uploads on Render ───────────────────────────
server.setTimeout(600000);      // 10 minutes
server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;
