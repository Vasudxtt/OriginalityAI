/**
 * Originality Checker AI — Backend Server
 * Groq / llama-3.1-8b-instant
 * Background job processing — supports 200+ page documents
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

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("GROQ_API_KEY is missing from environment variables");
  process.exit(1);
}

const GROQ_MODEL = "llama-3.1-8b-instant";

// Health check for Render
app.get("/health", (req, res) => {
  res.json({ status: "ok", model: GROQ_MODEL });
});

// In-memory job store — cleaned up every hour
const jobs = {};
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const id in jobs) {
    if (jobs[id].createdAt < cutoff) delete jobs[id];
  }
}, 600000);

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

// Multer — memory storage, 100MB, PDF and DOCX only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: function(_req, file, cb) {
    var ok = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];
    if (ok.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and DOCX files are allowed."));
    }
  }
});

// Split text into chunks of maxWords words
function chunkText(text, maxWords) {
  maxWords = maxWords || 800;
  var words = text.split(/\s+/).filter(Boolean);
  var out = [];
  for (var i = 0; i < words.length; i += maxWords) {
    out.push(words.slice(i, i + maxWords).join(" "));
  }
  return out;
}

// Call Groq API
async function callGroq(prompt) {
  var response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: GROQ_MODEL,
      max_tokens: 1024,
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content: "You are an expert academic integrity analyst. Respond with a single valid JSON object only. No markdown. No extra text."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + GROQ_API_KEY
      },
      timeout: 180000
    }
  );

  var content = response.data &&
                response.data.choices &&
                response.data.choices[0] &&
                response.data.choices[0].message &&
                response.data.choices[0].message.content;

  if (!content) throw new Error("Empty response from Groq");
  return content;
}

// Analyze a single chunk
async function analyzeChunk(chunkText, idx, total) {
  var prompt = "Part " + (idx + 1) + " of " + total + ". Analyze this text for plagiarism and AI-generation.\n" +
    "TEXT: \"\"\"" + chunkText + "\"\"\"\n" +
    "Reply with ONLY this JSON structure:\n" +
    "{\"plagiarism_score\":<number 0-100>,\"ai_likelihood\":\"Low|Medium|High\",\"summary\":\"<2 sentences>\",\"flagged_sections\":[{\"text\":\"<phrase>\",\"reason\":\"<why>\",\"replacement\":\"<rewrite>\"}],\"improvement_suggestions\":[{\"issue\":\"<problem>\",\"suggestion\":\"<fix>\",\"example_before\":\"<before>\",\"example_after\":\"<after>\"}]}\n" +
    "Rules: 0=original 100=AI/copied. Max 3 flagged phrases. Every flag needs a replacement.";

  var raw     = await callGroq(prompt);
  var cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch(e) {
    console.error("JSON parse failed for chunk " + (idx + 1) + ":", cleaned.slice(0, 200));
    // Return safe fallback so job continues
    return {
      plagiarism_score: 50,
      ai_likelihood: "Medium",
      summary: "Section " + (idx + 1) + " could not be parsed. Please review manually.",
      flagged_sections: [],
      improvement_suggestions: []
    };
  }
}

// Merge results from all chunks
function mergeResults(results) {
  if (!results.length) throw new Error("No results to merge");

  var totalScore = 0;
  for (var i = 0; i < results.length; i++) {
    totalScore += (results[i].plagiarism_score || 0);
  }
  var plagiarism_score = Math.round(totalScore / results.length);

  var counts = { Low: 0, Medium: 0, High: 0 };
  for (var j = 0; j < results.length; j++) {
    var k = results[j].ai_likelihood || "Medium";
    counts[k] = (counts[k] || 0) + 1;
  }
  var ai_likelihood = Object.keys(counts).sort(function(a, b) {
    return counts[b] - counts[a];
  })[0];

  var summaries = [];
  for (var s = 0; s < results.length; s++) {
    if (results[s].summary) summaries.push(results[s].summary);
  }

  var flagged = [];
  for (var f = 0; f < results.length; f++) {
    var fs = results[f].flagged_sections || [];
    for (var fi = 0; fi < fs.length; fi++) flagged.push(fs[fi]);
  }

  var suggestions = [];
  var seen = {};
  for (var sg = 0; sg < results.length; sg++) {
    var ss = results[sg].improvement_suggestions || [];
    for (var si = 0; si < ss.length; si++) {
      if (!seen[ss[si].issue]) {
        seen[ss[si].issue] = true;
        suggestions.push(ss[si]);
      }
    }
  }

  return {
    plagiarism_score: plagiarism_score,
    ai_likelihood: ai_likelihood,
    summary: summaries.join(" "),
    flagged_sections: flagged.slice(0, 30),
    improvement_suggestions: suggestions.slice(0, 15)
  };
}

// Background processor
async function processJob(jobId, rawText, wordCount, fileName) {
  try {
    var chunks = chunkText(rawText, 800);
    jobs[jobId].total    = chunks.length;
    jobs[jobId].progress = 0;

    console.log("[" + jobId + "] Starting: " + chunks.length + " chunks, " + wordCount + " words, file: " + fileName);

    var results = [];

    for (var i = 0; i < chunks.length; i++) {
      var success = false;
      var attempt = 0;

      while (!success && attempt < 5) {
        try {
          console.log("  Chunk " + (i + 1) + "/" + chunks.length + " attempt " + (attempt + 1));
          var result = await analyzeChunk(chunks[i], i, chunks.length);
          results.push(result);
          jobs[jobId].progress = i + 1;
          success = true;
        } catch(err) {
          attempt++;
          var is429 = err.response && err.response.status === 429;
          var delay = (is429 ? 15000 : 3000) * Math.pow(2, attempt - 1);
          console.warn("  Chunk " + (i + 1) + " failed attempt " + attempt + " (" + err.message + ") retrying in " + (delay/1000) + "s");
          if (attempt >= 5) {
            console.error("  Chunk " + (i + 1) + " giving up after 5 attempts");
            results.push({
              plagiarism_score: 50,
              ai_likelihood: "Medium",
              summary: "Chunk " + (i + 1) + " could not be analyzed.",
              flagged_sections: [],
              improvement_suggestions: []
            });
            break;
          }
          await new Promise(function(resolve) { setTimeout(resolve, delay); });
        }
      }

      // Wait between chunks to respect rate limits
      if (i < chunks.length - 1) {
        await new Promise(function(resolve) { setTimeout(resolve, 3000); });
      }
    }

    var final = mergeResults(results);
    final.word_count      = wordCount;
    final.chunks_analyzed = chunks.length;

    jobs[jobId].status = "done";
    jobs[jobId].result = final;
    console.log("[" + jobId + "] Done. Score: " + final.plagiarism_score + " AI: " + final.ai_likelihood);

  } catch(err) {
    jobs[jobId].status = "error";
    jobs[jobId].error  = err.message || "Analysis failed";
    console.error("[" + jobId + "] Fatal:", err.message);
  }
}

// POST /analyze — upload file, get jobId immediately
app.post("/analyze", upload.single("file"), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    console.log("File received: " + req.file.originalname + " (" + (req.file.size / 1024 / 1024).toFixed(2) + " MB)");

    var rawText = "";
    if (req.file.mimetype === "application/pdf") {
      var parsed = await pdfParse(req.file.buffer);
      rawText = parsed.text;
    } else {
      var extracted = await mammoth.extractRawText({ buffer: req.file.buffer });
      rawText = extracted.value;
    }

    rawText = rawText.trim();
    if (!rawText || rawText.length < 50) {
      return res.status(422).json({ error: "Could not extract text from file." });
    }

    var wordCount = rawText.split(/\s+/).filter(Boolean).length;
    console.log("Extracted " + wordCount + " words");

    var jobId = crypto.randomUUID();
    jobs[jobId] = {
      status:    "processing",
      progress:  0,
      total:     null,
      result:    null,
      error:     null,
      fileName:  req.file.originalname,
      wordCount: wordCount,
      createdAt: Date.now()
    };

    // Send jobId immediately — no waiting
    res.json({ jobId: jobId, wordCount: wordCount });

    // Start processing in background
    processJob(jobId, rawText, wordCount, req.file.originalname);

  } catch(err) {
    console.error("Upload error:", err.message);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Max 100MB." });
    }
    res.status(500).json({ error: err.message || "Upload failed." });
  }
});

// GET /status/:jobId — poll this every 4 seconds from frontend
app.get("/status/:jobId", function(req, res) {
  var job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found." });

  if (job.status === "processing") {
    var progress = job.progress || 0;
    var total    = job.total    || 0;
    var percent  = total > 0 ? Math.round((progress / total) * 100) : 0;
    return res.json({
      status:   "processing",
      progress: progress,
      total:    total,
      percent:  percent,
      message:  progress === 0 ? "Starting analysis..." : "Analyzing chunk " + progress + " of " + total + "..."
    });
  }

  if (job.status === "error") {
    return res.json({ status: "error", error: job.error });
  }

  // Done
  return res.json({
    status:          "done",
    progress:        job.total,
    total:           job.total,
    percent:         100,
    word_count:      job.wordCount,
    chunks_analyzed: job.result.chunks_analyzed || job.total,
    plagiarism_score:        job.result.plagiarism_score,
    ai_likelihood:           job.result.ai_likelihood,
    summary:                 job.result.summary,
    flagged_sections:        job.result.flagged_sections,
    improvement_suggestions: job.result.improvement_suggestions
  });
});

// Multer error handler
app.use(function(err, req, res, next) {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Max 100MB." });
  }
  next(err);
});

// Start server
var server = app.listen(PORT, function() {
  console.log("Originality Checker AI running on port " + PORT);
  console.log("Model: " + GROQ_MODEL);
});

server.setTimeout(600000);
server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;