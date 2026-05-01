# OriginalityAI 💀🕸️

> Plagiarism detection, AI-content scoring & humanisation suggestions — built by [@vasudxtt](https://github.com/vasudxtt)

![Node.js](https://img.shields.io/badge/Node.js-Express-green?style=flat-square)
![Groq](https://img.shields.io/badge/AI-Groq%20LLaMA%203.3-blue?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)

## What it does
- 📄 Upload any **PDF or DOCX** file (up to 100MB)
- 🔍 Get a **plagiarism risk score** (0–100)
- 🤖 Detect **AI-generated content** (Low / Medium / High)
- ✍️ See **flagged phrases** with exact human rewrites
- ⏱️ Estimated processing time shown before results
- 💡 Get **improvement suggestions** with before/after examples

## Tech Stack
- **Frontend** — Vanilla HTML, CSS, JS
- **Backend** — Node.js + Express + Multer
- **Parsing** — pdf-parse, mammoth
- **AI** — Groq API / LLaMA 3.3 70B

## Run Locally
```bash
git clone https://github.com/vasudxtt/originality-ai
cd originality-ai
npm install
npm start
```
Open → https://originalityai.onrender.com/
