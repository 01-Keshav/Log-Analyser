# 📊 Log Analyser

An AI-powered log analysis backend and dashboard that leverages the Gemini API to provide intelligent log exploration, root cause analysis, and actionable insights.

## ✨ Features

- **In-Memory Log Store**: Fast and lightweight ingestion for local development.
- **Multi-format Parsing**: Supports JSON structured logs, Apache/Nginx combined logs, Syslog, and plain text.
- **Smart Analytics & Timeline**: Automatically calculates error rates, extracts error types, highlights performance bottlenecks, and builds hourly timelines.
- **Interactive Dashboard**: Modern UI with real-time analytics, explorer, and anomaly detection built using Vanilla HTML/CSS/JS.
- **🤖 AI-Powered Log Intelligence**: Integrates with Google's Gemini (`gemini-2.5-flash`) via function calling to perform complex tasks:
  - `analyze_log_batch`: Detect anomalies, performance issues, and patterns in log batches.
  - `identify_root_cause`: Filter errors and pinpoint the primary cause for specific system issues.
  - `correlate_events`: Group and correlate logs across different sources using timestamps or metadata.
  - `generate_recommendations`: Generate actionable steps and alerting rules based on analysis tailored for engineers or executives.

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16+)
- A [Google Gemini API Key](https://aistudio.google.com/app/apikey)

### Installation

1. Clone the repository and navigate to the project folder:
   ```bash
   git clone <repository-url>
   cd "Log Analyser"
   ```

2. Install the dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   # or npm run dev (for watch mode)
   ```

4. Open `index.html` in your web browser.

## ⚙️ Configuration

To use the AI Chat capabilities, you'll need to set your Gemini API Key in the frontend dashboard:
1. Click the **Settings (⚙️)** button in the top right corner.
2. Enter your Gemini API Key.
3. Your key is stored securely in your browser's local storage and used exclusively to authenticate requests to the AI Chat endpoint.

## 🔌 API Endpoints

- `POST /api/logs/ingest`: Ingest new logs (accepts JSON array or raw text).
- `GET /api/logs`: Retrieve logs with optional filters (source, level, search, date range, pagination).
- `GET /api/analyze`: Retrieve statistics and timeline buckets for filtered logs.
- `GET /api/summary`: Quick summary of total logs, top errors, anomalies, and recent logs.
- `DELETE /api/logs`: Clear the entire log store or specific sources.
- `POST /api/chat`: Interact with the AI assistant (requires `x-gemini-api-key` header).

## 🛠️ Tech Stack

- **Backend**: Node.js, Express, CORS
- **AI**: Google Generative AI (Gemini 2.5 Flash)
- **Frontend**: Vanilla HTML/CSS/JavaScript
