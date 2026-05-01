/**
 * Originality Checker AI — Backend Server
 * Secure + Production Ready Version
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

// ✅ Secure env handling
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY is missing");
  process.exit(1);
}

const GROQ_MODEL = 'llama-3.1-8b-instant';

// ── Health check (for Render) ───────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    GROQ_API_KEY_loaded: !!process.env.GROQ_API_KEY
  });
});

// ── In-memory job store ─────────────────────────────────────────
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

// ── Multer setup ────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
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

function chunkText(text, maxWords = 2000) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += maxWords) {
    out.push(words.slice(i, i + maxWords).join(" "));
  }
  return out;
}

// ── Groq API call (hardened) ────────────────────────────────────
async function callGroq(userPrompt, maxTokens = 1024) {
  try {
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
              "You are an expert academic integrity analyst and humanisation coach. Respond with a single valid JSON object only.",
          },
          { role: "user", content: userPrompt },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        timeout: 180000,
      }
    );

    const content = r.data?.choices?.[0]?.message?.content || "";
    if (!content) throw new Error("Empty response from Groq API");

    return content;

  } catch (err) {
    const status = err.response?.status;
    console.error("❌ Groq API Error:", status, err.message);

    if (status === 401) throw new Error("Invalid API key");
    if (status === 429) throw err;

    throw new Error("Groq request failed");
  }
}

// ── Analyze chunk (safe JSON parsing) ───────────────────────────
async function analyzeChunk(chunk, idx, total) {
  const prompt = `Analyze this text excerpt (part ${idx + 1} of ${total})...`;

  const raw = await callGroq(prompt, 1024);
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.error("❌ JSON parse failed:", cleaned.slice(0, 200));
    throw new Error("Invalid JSON from AI");
  }
}

// ── Merge results ───────────────────────────────────────────────
function mergeResults(results) {
  const plagiarism_score = Math.round(
    results.reduce((s, r) => s + (r.plagiarism_score || 0), 0) / results.length
  );

  const counts = { Low: 0, Medium: 0, High: 0 };
  results.forEach(r => counts[r.ai_likelihood || "Medium"]++);

  const ai_likelihood = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])[0][0];

  return {
    plagiarism_score,
    ai_likelihood,
    summary: results.map(r => r.summary || "").join(" "),
    flagged_sections: results.flatMap(r => r.flagged_sections || []).slice(0, 30),
    improvement_suggestions: results.flatMap(r => r.improvement_suggestions || []).slice(0, 15),
  };
}

// ── Background processing ───────────────────────────────────────
async function processJobInBackground(jobId, rawText, wordCount, fileName) {
  try {
    const chunks = chunkText(rawText, 1500);
    jobs[jobId].total = chunks.length;

    const results = [];

    for (let i = 0; i < chunks.length; i++) {
      let success = false;
      let attempt = 0;

      while (!success && attempt < 5) {
        try {
          results.push(await analyzeChunk(chunks[i], i, chunks.length));
          jobs[jobId].progress = i + 1;
          success = true;
        } catch (err) {
          attempt++;
          const delay = 3000 * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    jobs[jobId].status = "done";
    jobs[jobId].result = {
      ...mergeResults(results),
      word_count: wordCount
    };

  } catch (err) {
    jobs[jobId].status = "error";
    jobs[jobId].error = err.message;
  }
}

// ── Routes ──────────────────────────────────────────────────────
app.post("/analyze", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });

  const rawText = req.file.mimetype === "application/pdf"
    ? (await pdfParse(req.file.buffer)).text
    : (await mammoth.extractRawText({ buffer: req.file.buffer })).value;

  const jobId = crypto.randomUUID();

  jobs[jobId] = {
    status: "processing",
    progress: 0,
    total: null,
    createdAt: Date.now()
  };

  res.json({ jobId });

  processJobInBackground(jobId, rawText, rawText.length, req.file.originalname);
});

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

// ── Start server ────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("🔐 GROQ_API_KEY loaded:", !!process.env.GROQ_API_KEY);
});

server.setTimeout(600000);
