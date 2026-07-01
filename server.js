import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;
const STORE_FILE = path.join(__dirname, 'logs-store.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ─── IN-MEMORY LOG STORE ───────────────────────────────────────────────────
let logStore = [];
let nextId = 1;

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      logStore = data.logs || [];
      nextId = data.nextId || (logStore.length + 1);
      console.log(`Loaded ${logStore.length} logs from store.`);
    }
  } catch (e) {
    console.warn('Could not load store:', e.message);
  }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ logs: logStore, nextId }, null, 2));
  } catch (e) {
    console.warn('Could not save store:', e.message);
  }
}

loadStore();

// ─── LOG PARSER ────────────────────────────────────────────────────────────
const LEVEL_MAP = {
  error: 'ERROR', err: 'ERROR', fatal: 'ERROR', critical: 'ERROR', crit: 'ERROR',
  warn: 'WARN', warning: 'WARN',
  info: 'INFO', information: 'INFO', notice: 'INFO',
  debug: 'DEBUG', trace: 'DEBUG', verbose: 'DEBUG',
};

function detectLevel(text) {
  const lower = text.toLowerCase();
  for (const [key, val] of Object.entries(LEVEL_MAP)) {
    if (lower.includes(key)) return val;
  }
  return 'INFO';
}

function parseTimestamp(raw) {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

// Extract metadata (key=value or key: value patterns) from message
function extractMetadata(text) {
  const meta = {};
  const kvRegex = /(\w+)=([^\s"]+|"[^"]*")/g;
  let m;
  while ((m = kvRegex.exec(text)) !== null) {
    meta[m[1]] = m[2].replace(/"/g, '');
  }
  return meta;
}

function parseSingleLog(raw, source) {
  if (typeof raw === 'object' && raw !== null) {
    // JSON structured log
    const level = LEVEL_MAP[(raw.level || raw.severity || raw.lvl || 'info').toLowerCase()] || 'INFO';
    const timestamp = parseTimestamp(raw.timestamp || raw.time || raw['@timestamp'] || raw.date);
    const message = raw.message || raw.msg || raw.text || JSON.stringify(raw);
    const metadata = { ...raw };
    delete metadata.level; delete metadata.severity; delete metadata.lvl;
    delete metadata.timestamp; delete metadata.time; delete metadata.message;
    delete metadata.msg;
    return { id: nextId++, timestamp, level, source: raw.source || source, message, metadata, raw: JSON.stringify(raw) };
  }

  const line = String(raw).trim();
  if (!line) return null;

  // Try JSON parse first
  if (line.startsWith('{')) {
    try {
      return parseSingleLog(JSON.parse(line), source);
    } catch (_) {}
  }

  // Apache/Nginx combined log: 127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326
  const apacheRegex = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d+) (\S+)/;
  const apacheMatch = line.match(apacheRegex);
  if (apacheMatch) {
    const statusCode = parseInt(apacheMatch[4]);
    const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
    return {
      id: nextId++,
      timestamp: parseTimestamp(apacheMatch[2]),
      level,
      source,
      message: `${apacheMatch[3]} → ${apacheMatch[4]}`,
      metadata: { ip: apacheMatch[1], method: apacheMatch[3].split(' ')[0], path: apacheMatch[3].split(' ')[1], status: statusCode, bytes: apacheMatch[5] },
      raw: line
    };
  }

  // Syslog: Jan  1 00:00:00 hostname proc[pid]: message
  const syslogRegex = /^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\[:\s]+)(?:\[(\d+)\])?:\s+(.+)$/;
  const syslogMatch = line.match(syslogRegex);
  if (syslogMatch) {
    return {
      id: nextId++,
      timestamp: parseTimestamp(`${new Date().getFullYear()} ${syslogMatch[1]}`),
      level: detectLevel(syslogMatch[5]),
      source: syslogMatch[3] || source,
      message: syslogMatch[5],
      metadata: { host: syslogMatch[2], pid: syslogMatch[4] },
      raw: line
    };
  }

  // Common structured: [TIMESTAMP] [LEVEL] message  OR  TIMESTAMP LEVEL message
  const structuredRegex = /^[\[\(]?(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?:\s+\w+)?)[\]\)]?\s*[\[\(]?(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL)[\]\)]?\s*[:\-–]?\s*(.+)$/i;
  const structMatch = line.match(structuredRegex);
  if (structMatch) {
    const meta = extractMetadata(structMatch[3]);
    return {
      id: nextId++,
      timestamp: parseTimestamp(structMatch[1].trim()),
      level: LEVEL_MAP[structMatch[2].toLowerCase()] || 'INFO',
      source,
      message: structMatch[3],
      metadata: meta,
      raw: line
    };
  }

  // Reverse: LEVEL TIMESTAMP message
  const reverseRegex = /^(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL)\s+[\[\(]?(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\]\)]*?)[\]\)]?\s*(.+)$/i;
  const revMatch = line.match(reverseRegex);
  if (revMatch) {
    const meta = extractMetadata(revMatch[3]);
    return {
      id: nextId++,
      timestamp: parseTimestamp(revMatch[2].trim()),
      level: LEVEL_MAP[revMatch[1].toLowerCase()] || 'INFO',
      source,
      message: revMatch[3],
      metadata: meta,
      raw: line
    };
  }

  // Plain text fallback with timestamp detection
  const tsRegex = /(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
  const tsMatch = line.match(tsRegex);
  const meta = extractMetadata(line);
  return {
    id: nextId++,
    timestamp: tsMatch ? parseTimestamp(tsMatch[1]) : new Date().toISOString(),
    level: detectLevel(line),
    source,
    message: line,
    metadata: meta,
    raw: line
  };
}

function parseLogs(input, source) {
  const results = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      const parsed = parseSingleLog(item, source);
      if (parsed) results.push(parsed);
    }
  } else if (typeof input === 'string') {
    const lines = input.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseSingleLog(line, source);
      if (parsed) results.push(parsed);
    }
  }
  return results;
}

// ─── ANALYSIS HELPERS ──────────────────────────────────────────────────────
function computeStats(logs) {
  const total = logs.length;
  const byLevel = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };
  const bySource = {};
  const errorTypes = {};
  const durations = [];

  for (const log of logs) {
    byLevel[log.level] = (byLevel[log.level] || 0) + 1;
    bySource[log.source] = (bySource[log.source] || 0) + 1;
    if (log.level === 'ERROR') {
      const type = extractErrorType(log.message);
      errorTypes[type] = (errorTypes[type] || 0) + 1;
    }
    if (log.metadata?.duration) {
      const d = parseFloat(log.metadata.duration);
      if (!isNaN(d)) durations.push(d);
    }
  }

  const errorRate = total > 0 ? ((byLevel.ERROR / total) * 100).toFixed(2) : '0.00';
  const avgDuration = durations.length > 0 ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2) : null;
  const maxDuration = durations.length > 0 ? Math.max(...durations).toFixed(2) : null;

  const topErrors = Object.entries(errorTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  // Timeline buckets (hourly)
  const timeline = buildTimeline(logs);

  return { total, byLevel, bySource, errorRate, avgDuration, maxDuration, topErrors, timeline };
}

function extractErrorType(message) {
  const patterns = [
    { regex: /connection\s+timeout/i, label: 'Connection Timeout' },
    { regex: /database\s+(error|failed|unavailable)/i, label: 'Database Error' },
    { regex: /authentication\s+failed|unauthorized|invalid\s+credentials/i, label: 'Auth Failure' },
    { regex: /NullPointerException|null\s+pointer/i, label: 'Null Pointer' },
    { regex: /OutOfMemoryError|out\s+of\s+memory/i, label: 'OOM Error' },
    { regex: /circuit\s+breaker/i, label: 'Circuit Breaker' },
    { regex: /service\s+unavailable|connection\s+refused/i, label: 'Service Unavailable' },
    { regex: /timeout/i, label: 'Timeout' },
    { regex: /404|not\s+found/i, label: 'Not Found' },
    { regex: /500|internal\s+server/i, label: 'Internal Server Error' },
  ];
  for (const { regex, label } of patterns) {
    if (regex.test(message)) return label;
  }
  return 'Unknown Error';
}

function buildTimeline(logs) {
  if (logs.length === 0) return [];
  const buckets = {};
  for (const log of logs) {
    const d = new Date(log.timestamp);
    if (isNaN(d)) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;
    if (!buckets[key]) buckets[key] = { time: key, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, total: 0 };
    buckets[key][log.level] = (buckets[key][log.level] || 0) + 1;
    buckets[key].total++;
  }
  return Object.values(buckets).sort((a, b) => a.time.localeCompare(b.time));
}

// ─── AI TOOL IMPLEMENTATIONS ───────────────────────────────────────────────
function toolAnalyzeLogBatch({ logs, analysis_focus }) {
  const targetLogs = logs.length > 0 ? logs : logStore.slice(-500);
  const stats = computeStats(targetLogs);

  const result = {
    total_logs: stats.total,
    analysis_focus,
    level_distribution: stats.byLevel,
    error_rate_pct: parseFloat(stats.errorRate),
    sources: stats.bySource,
    top_errors: stats.topErrors,
    performance: stats.avgDuration ? {
      avg_duration_ms: parseFloat(stats.avgDuration),
      max_duration_ms: parseFloat(stats.maxDuration)
    } : null,
    timeline_buckets: stats.timeline.slice(-24),
    anomalies: detectAnomalies(targetLogs, stats),
  };
  return result;
}

function detectAnomalies(logs, stats) {
  const anomalies = [];
  if (parseFloat(stats.errorRate) > 10) {
    anomalies.push({ type: 'high_error_rate', value: `${stats.errorRate}%`, severity: 'HIGH', message: `Error rate ${stats.errorRate}% exceeds 10% threshold` });
  }
  if (stats.maxDuration && parseFloat(stats.maxDuration) > 5000) {
    anomalies.push({ type: 'high_latency', value: `${stats.maxDuration}ms`, severity: 'MEDIUM', message: `Max response time ${stats.maxDuration}ms indicates performance issues` });
  }
  // Error spike detection
  const tl = stats.timeline;
  if (tl.length > 3) {
    const avgErrors = tl.reduce((s, b) => s + b.ERROR, 0) / tl.length;
    for (const bucket of tl) {
      if (bucket.ERROR > avgErrors * 3 && bucket.ERROR > 5) {
        anomalies.push({ type: 'error_spike', value: bucket.ERROR, at: bucket.time, severity: 'HIGH', message: `Error spike detected at ${bucket.time}: ${bucket.ERROR} errors (avg: ${avgErrors.toFixed(1)})` });
      }
    }
  }
  return anomalies;
}

function toolIdentifyRootCause({ logs, issue_description, timeframe }) {
  let targetLogs = logs.length > 0 ? logs : logStore;
  if (timeframe) {
    const start = timeframe.start ? new Date(timeframe.start) : null;
    const end = timeframe.end ? new Date(timeframe.end) : null;
    targetLogs = targetLogs.filter(l => {
      const t = new Date(l.timestamp);
      if (start && t < start) return false;
      if (end && t > end) return false;
      return true;
    });
  }
  const errors = targetLogs.filter(l => l.level === 'ERROR');
  const errorTypeCounts = {};
  for (const e of errors) {
    const type = extractErrorType(e.message);
    errorTypeCounts[type] = (errorTypeCounts[type] || 0) + 1;
  }
  const sortedTypes = Object.entries(errorTypeCounts).sort((a, b) => b[1] - a[1]);
  const primaryCause = sortedTypes[0] ? sortedTypes[0][0] : 'Unknown';
  const recentErrors = errors.slice(-10).map(e => ({ timestamp: e.timestamp, message: e.message, source: e.source }));

  return {
    issue: issue_description,
    logs_analyzed: targetLogs.length,
    errors_found: errors.length,
    primary_cause: primaryCause,
    cause_breakdown: sortedTypes.map(([type, count]) => ({ type, count, pct: ((count / errors.length) * 100).toFixed(1) + '%' })),
    first_occurrence: errors[0]?.timestamp || null,
    last_occurrence: errors[errors.length - 1]?.timestamp || null,
    recent_error_samples: recentErrors,
    affected_sources: [...new Set(errors.map(e => e.source))],
  };
}

function toolCorrelateEvents({ logs, correlation_field }) {
  const targetLogs = logs.length > 0 ? logs : logStore;
  const groups = {};

  for (const log of targetLogs) {
    let key;
    if (correlation_field === 'timestamp') {
      const d = new Date(log.timestamp);
      key = isNaN(d) ? 'unknown' : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    } else {
      key = log.metadata?.[correlation_field] || log[correlation_field] || 'unknown';
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push({ timestamp: log.timestamp, source: log.source, level: log.level, message: log.message.substring(0, 120) });
  }

  const correlations = Object.entries(groups)
    .filter(([, g]) => g.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([key, entries]) => ({
      [correlation_field]: key,
      entry_count: entries.length,
      sources: [...new Set(entries.map(e => e.source))],
      levels: [...new Set(entries.map(e => e.level))],
      has_errors: entries.some(e => e.level === 'ERROR'),
      entries: entries.slice(0, 5)
    }));

  return {
    correlation_field,
    total_groups: Object.keys(groups).length,
    correlations,
    cross_source_issues: correlations.filter(c => c.sources.length > 1 && c.has_errors),
  };
}

function toolGenerateRecommendations({ analysis_results, audience, urgency }) {
  const errorRate = analysis_results?.error_rate_pct || 0;
  const anomalies = analysis_results?.anomalies || [];
  const topErrors = analysis_results?.top_errors || [];

  const immediateActions = [];
  const longTermSolutions = [];
  const monitoringAlerts = [];

  if (errorRate > 10) {
    immediateActions.push('Investigate the root cause of elevated error rate immediately — check recent deployments and configuration changes');
    immediateActions.push('Enable circuit breakers on affected services to prevent cascade failures');
    longTermSolutions.push('Implement structured error handling and standardized error codes across all services');
  }

  for (const err of topErrors.slice(0, 3)) {
    if (err.type === 'Connection Timeout') {
      immediateActions.push('Check network connectivity and firewall rules between services');
      longTermSolutions.push('Implement connection pooling and retry logic with exponential backoff');
      monitoringAlerts.push('Alert on connection timeout rate > 1% for 5 consecutive minutes');
    }
    if (err.type === 'Database Error') {
      immediateActions.push('Check database server health, connection pool saturation, and query performance');
      longTermSolutions.push('Add read replicas, query caching layer, and connection pool sizing to match load');
      monitoringAlerts.push('Alert on database error rate > 0.5% and query latency P99 > 500ms');
    }
    if (err.type === 'Auth Failure') {
      immediateActions.push('Review authentication service logs for token expiration or permission misconfiguration');
      longTermSolutions.push('Implement OAuth 2.0 refresh token rotation and centralized permission management');
    }
    if (err.type === 'Service Unavailable') {
      immediateActions.push('Check service health dashboards and restart unhealthy instances');
      longTermSolutions.push('Implement health check endpoints and auto-restart policies with Kubernetes liveness probes');
    }
  }

  for (const anomaly of anomalies) {
    if (anomaly.type === 'high_latency') {
      immediateActions.push(`Address performance bottleneck — max latency is ${anomaly.value}`);
      longTermSolutions.push('Profile slow endpoints with APM tooling (Datadog, New Relic) and optimize database queries');
      monitoringAlerts.push('Alert on P95 latency > 2000ms for 3 consecutive minutes');
    }
    if (anomaly.type === 'error_spike') {
      immediateActions.push(`Investigate error spike at ${anomaly.at} — correlate with deployment history`);
    }
  }

  if (immediateActions.length === 0) {
    immediateActions.push('System appears healthy — continue monitoring current metrics');
    immediateActions.push('Review INFO/DEBUG logs for any latent performance signals');
  }

  longTermSolutions.push('Set up centralized log aggregation (ELK Stack, Grafana Loki, or Datadog Logs)');
  longTermSolutions.push('Implement distributed tracing (Jaeger/Zipkin) with request_id propagation across services');
  monitoringAlerts.push('Alert on error rate > 5% for 2 consecutive minutes across any service');
  monitoringAlerts.push('Alert on log volume drop > 50% (service may have crashed)');

  const recommendation = {
    audience: audience || 'engineer',
    urgency: urgency || (errorRate > 10 ? 'critical' : errorRate > 5 ? 'high' : 'medium'),
    executive_summary: `${errorRate}% error rate detected across ${analysis_results?.total_logs || 0} logs from ${Object.keys(analysis_results?.sources || {}).length} sources. ${anomalies.length} anomalies identified.`,
    immediate_actions: immediateActions,
    long_term_solutions: longTermSolutions,
    monitoring_and_alerts: monitoringAlerts,
  };
  return recommendation;
}

// ─── GEMINI API INTEGRATION ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert DevOps engineer and system administrator specialized in log analysis and troubleshooting. You have access to real log data from the user's system.

Your capabilities:
- Parse and understand logs in any format (JSON, plain text, Apache/Nginx, syslog, key-value)
- Detect anomalies, error spikes, and unusual patterns
- Correlate events across multiple log sources using request_id, user_id, timestamps
- Perform root cause analysis with evidence-backed conclusions
- Generate actionable recommendations for different audiences

When analyzing logs, always:
1. Identify the log format and extract timestamp, level, source, and message
2. Look for patterns, correlations, and cascading failures
3. Quantify impact (error rate, affected users, duration)
4. Provide specific, actionable next steps

Severity assessment:
- CRITICAL: System down, data loss, security breach
- HIGH: Major functionality broken, significant performance degradation
- MEDIUM: Minor functionality issues, notable performance impact
- LOW: Informational, debugging info, expected operations

Always be professional, technical, and actionable. Format responses with clear sections. Use markdown for better readability.`;

const AI_TOOLS = [
  {
    name: 'analyze_log_batch',
    description: 'Analyze a batch of logs from one or more sources to get statistics, anomalies, and patterns',
    parameters: {
      type: 'object',
      properties: {
        logs: { type: 'array', description: 'Array of log entries', items: { type: 'object' } },
        analysis_focus: { type: 'string', enum: ['errors', 'performance', 'anomalies', 'timeline', 'correlation'] }
      },
      required: ['logs', 'analysis_focus']
    }
  },
  {
    name: 'identify_root_cause',
    description: 'Analyze logs to identify the root cause of specific issues',
    parameters: {
      type: 'object',
      properties: {
        logs: { type: 'array', items: { type: 'object' } },
        issue_description: { type: 'string' },
        timeframe: {
          type: 'object',
          properties: { start: { type: 'string' }, end: { type: 'string' } }
        }
      },
      required: ['logs', 'issue_description']
    }
  },
  {
    name: 'correlate_events',
    description: 'Find relationships and correlations between logs from different sources',
    parameters: {
      type: 'object',
      properties: {
        logs: { type: 'array', items: { type: 'object' } },
        correlation_field: { type: 'string', enum: ['request_id', 'user_id', 'session_id', 'timestamp'] }
      },
      required: ['logs', 'correlation_field']
    }
  },
  {
    name: 'generate_recommendations',
    description: 'Generate actionable recommendations based on log analysis results',
    parameters: {
      type: 'object',
      properties: {
        analysis_results: { type: 'object' },
        audience: { type: 'string', enum: ['executive', 'engineer', 'oncall', 'postmortem'] },
        urgency: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }
      },
      required: ['analysis_results', 'audience']
    }
  }
];

function executeTool(name, args) {
  switch (name) {
    case 'analyze_log_batch': return toolAnalyzeLogBatch(args);
    case 'identify_root_cause': return toolIdentifyRootCause(args);
    case 'correlate_events': return toolCorrelateEvents(args);
    case 'generate_recommendations': return toolGenerateRecommendations(args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

// POST /api/logs/ingest
app.post('/api/logs/ingest', (req, res) => {
  const { logs, source = 'unknown', raw_text } = req.body;
  let parsed = [];

  if (raw_text) {
    parsed = parseLogs(raw_text, source);
  } else if (logs) {
    parsed = parseLogs(Array.isArray(logs) ? logs : [logs], source);
  } else {
    return res.status(400).json({ error: 'Provide logs or raw_text' });
  }

  logStore.push(...parsed);
  saveStore();
  res.json({ ingested: parsed.length, total: logStore.length, sample: parsed.slice(0, 3) });
});

// GET /api/logs
app.get('/api/logs', (req, res) => {
  const { source, level, search, startDate, endDate, limit = 500, offset = 0 } = req.query;
  let filtered = logStore;

  if (source) filtered = filtered.filter(l => l.source.toLowerCase().includes(source.toLowerCase()));
  if (level) filtered = filtered.filter(l => l.level === level.toUpperCase());
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(l => l.message.toLowerCase().includes(s) || l.raw.toLowerCase().includes(s));
  }
  if (startDate) { const d = new Date(startDate); filtered = filtered.filter(l => new Date(l.timestamp) >= d); }
  if (endDate) { const d = new Date(endDate); filtered = filtered.filter(l => new Date(l.timestamp) <= d); }

  const total = filtered.length;
  const page = filtered.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  res.json({ total, offset: parseInt(offset), limit: parseInt(limit), logs: page });
});

// GET /api/analyze
app.get('/api/analyze', (req, res) => {
  const { source, level, startDate, endDate } = req.query;
  let filtered = logStore;
  if (source) filtered = filtered.filter(l => l.source.toLowerCase().includes(source.toLowerCase()));
  if (level) filtered = filtered.filter(l => l.level === level.toUpperCase());
  if (startDate) { const d = new Date(startDate); filtered = filtered.filter(l => new Date(l.timestamp) >= d); }
  if (endDate) { const d = new Date(endDate); filtered = filtered.filter(l => new Date(l.timestamp) <= d); }
  res.json(computeStats(filtered));
});

// GET /api/summary
app.get('/api/summary', (_req, res) => {
  const stats = computeStats(logStore);
  const recent = logStore.slice(-5).map(l => ({ timestamp: l.timestamp, level: l.level, source: l.source, message: l.message.substring(0, 100) }));
  res.json({
    total_logs: stats.total,
    sources: Object.keys(stats.bySource).length,
    error_rate: stats.errorRate + '%',
    level_counts: stats.byLevel,
    top_errors: stats.topErrors,
    recent_logs: recent,
    has_anomalies: detectAnomalies(logStore, stats).length > 0
  });
});

// DELETE /api/logs
app.delete('/api/logs', (req, res) => {
  const { source } = req.query;
  if (source) {
    const before = logStore.length;
    logStore = logStore.filter(l => l.source !== source);
    saveStore();
    res.json({ deleted: before - logStore.length, remaining: logStore.length });
  } else {
    const count = logStore.length;
    logStore = [];
    nextId = 1;
    saveStore();
    res.json({ deleted: count, remaining: 0 });
  }
});

// POST /api/chat  — Gemini AI with tool calls
app.post('/api/chat', async (req, res) => {
  const { messages, context_logs } = req.body;
  const apiKey = req.headers['x-gemini-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing Gemini API key. Set it in the app settings.' });
  }

  // Build context about current logs
  const stats = computeStats(logStore);
  const logContext = logStore.length > 0
    ? `\n\nCURRENT LOG STORE CONTEXT:\n- Total logs: ${logStore.length}\n- Sources: ${Object.keys(stats.bySource).join(', ')}\n- Error rate: ${stats.errorRate}%\n- Level breakdown: ${JSON.stringify(stats.byLevel)}\n- Top errors: ${stats.topErrors.map(e => `${e.type}(${e.count})`).join(', ')}\n\nRecent logs (last 20):\n${logStore.slice(-20).map(l => `[${l.timestamp}] [${l.level}] [${l.source}] ${l.message}`).join('\n')}`
    : '\n\nNo logs currently in the store. Ask the user to ingest logs first.';

  const geminiMessages = [];

  // Convert our message format to Gemini format
  for (const msg of messages) {
    if (msg.role === 'user') {
      geminiMessages.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      geminiMessages.push({ role: 'model', parts: [{ text: msg.content }] });
    }
  }

  try {
    // Agentic loop: call Gemini until no more tool calls
    let loopMessages = [...geminiMessages];
    let finalText = '';
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const geminiPayload = {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT + logContext }] },
        contents: loopMessages,
        tools: [{ function_declarations: AI_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
        generation_config: {
          temperature: 0.3,
          max_output_tokens: 4096,
        }
      };

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiPayload)
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({ error: `Gemini API error: ${errText}` });
      }

      const data = await response.json();
      const candidate = data.candidates?.[0];
      if (!candidate) return res.status(500).json({ error: 'No response from Gemini' });

      const parts = candidate.content?.parts || [];
      const functionCalls = parts.filter(p => p.functionCall);
      const textParts = parts.filter(p => p.text);

      if (textParts.length > 0) {
        finalText = textParts.map(p => p.text).join('');
      }

      if (functionCalls.length === 0 || candidate.finishReason === 'STOP') {
        break;
      }

      // Execute tool calls
      const toolResults = [];
      for (const fc of functionCalls) {
        const result = executeTool(fc.functionCall.name, fc.functionCall.args || {});
        toolResults.push({
          functionResponse: {
            name: fc.functionCall.name,
            response: { result }
          }
        });
      }

      // Add model response and tool results to loop
      loopMessages.push({ role: 'model', parts });
      loopMessages.push({ role: 'user', parts: toolResults });
    }

    res.json({ response: finalText, iterations });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sources
app.get('/api/sources', (_req, res) => {
  const sources = [...new Set(logStore.map(l => l.source))];
  res.json({ sources });
});

// ─── START ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Log Analyser backend running at http://localhost:${PORT}`);
  console.log(`   Open index.html in your browser to use the app.\n`);
});
