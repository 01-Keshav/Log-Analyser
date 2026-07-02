import os
import json
import asyncio
from datetime import datetime
from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any, Union
import google.genai as genai
from google.genai import types

from log_parser import parse_logs, LEVEL_MAP
from windows_log_collector import fetch_windows_logs

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── IN-MEMORY LOG STORE ───────────────────────────────────────────────────
log_store = []
next_id = [1]
STORE_FILE = "logs-store.json"

def load_store():
    global log_store, next_id
    try:
        if os.path.exists(STORE_FILE):
            with open(STORE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                log_store = data.get("logs", [])
                next_id[0] = data.get("nextId", len(log_store) + 1)
                print(f"Loaded {len(log_store)} logs from store.")
    except Exception as e:
        print(f"Could not load store: {e}")

def save_store():
    try:
        with open(STORE_FILE, 'w', encoding='utf-8') as f:
            json.dump({"logs": log_store, "nextId": next_id[0]}, f, indent=2)
    except Exception as e:
        print(f"Could not save store: {e}")

load_store()

# ─── BACKGROUND TASKS ───────────────────────────────────────────────────────
async def poll_windows_logs_task():
    while True:
        try:
            new_logs = await fetch_windows_logs()
            if new_logs:
                parsed = parse_logs(new_logs, 'WindowsEventLog', next_id)
                if parsed:
                    log_store.extend(parsed)
                    save_store()
                    print(f"[WindowsLogCollector] Ingested {len(parsed)} new events.")
        except Exception as e:
            print(f"Error in poll_windows_logs_task: {e}")
        await asyncio.sleep(30)

background_tasks = set()

@app.on_event("startup")
async def startup_event():
    import sys
    if sys.platform == 'win32':
        task = asyncio.create_task(poll_windows_logs_task())
        background_tasks.add(task)

# ─── ANALYSIS HELPERS ──────────────────────────────────────────────────────
def extract_error_type(message: str) -> str:
    message_lower = message.lower()
    patterns = [
        ('connection timeout', 'Connection Timeout'),
        ('database error', 'Database Error'),
        ('database failed', 'Database Error'),
        ('database unavailable', 'Database Error'),
        ('authentication failed', 'Auth Failure'),
        ('unauthorized', 'Auth Failure'),
        ('invalid credentials', 'Auth Failure'),
        ('nullpointerexception', 'Null Pointer'),
        ('null pointer', 'Null Pointer'),
        ('outofmemoryerror', 'OOM Error'),
        ('out of memory', 'OOM Error'),
        ('circuit breaker', 'Circuit Breaker'),
        ('service unavailable', 'Service Unavailable'),
        ('connection refused', 'Service Unavailable'),
        ('timeout', 'Timeout'),
        ('404', 'Not Found'),
        ('not found', 'Not Found'),
        ('500', 'Internal Server Error'),
        ('internal server', 'Internal Server Error'),
    ]
    for pattern, label in patterns:
        if pattern in message_lower:
            return label
    return 'Unknown Error'

def build_timeline(logs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not logs:
        return []
    buckets = {}
    for log in logs:
        try:
            ts = log['timestamp']
            if ts.endswith('Z'):
                ts = ts[:-1]
            d = datetime.fromisoformat(ts.split('.')[0]) # drop milliseconds for simplicity
            key = d.strftime("%Y-%m-%d %H:00")
            if key not in buckets:
                buckets[key] = {'time': key, 'ERROR': 0, 'WARN': 0, 'INFO': 0, 'DEBUG': 0, 'total': 0}
            buckets[key][log['level']] = buckets[key].get(log['level'], 0) + 1
            buckets[key]['total'] += 1
        except Exception:
            continue
    return sorted(buckets.values(), key=lambda x: x['time'])

def compute_stats(logs: List[Dict[str, Any]]) -> Dict[str, Any]:
    total = len(logs)
    by_level = {'ERROR': 0, 'WARN': 0, 'INFO': 0, 'DEBUG': 0}
    by_source = {}
    error_types = {}
    durations = []

    for log in logs:
        level = log.get('level', 'INFO')
        by_level[level] = by_level.get(level, 0) + 1
        source = log.get('source', 'unknown')
        by_source[source] = by_source.get(source, 0) + 1
        
        if level == 'ERROR':
            etype = extract_error_type(log.get('message', ''))
            error_types[etype] = error_types.get(etype, 0) + 1
            
        metadata = log.get('metadata', {})
        if 'duration' in metadata:
            try:
                durations.append(float(metadata['duration']))
            except ValueError:
                pass

    error_rate = f"{((by_level['ERROR'] / total) * 100):.2f}" if total > 0 else '0.00'
    avg_duration = f"{(sum(durations) / len(durations)):.2f}" if durations else None
    max_duration = f"{max(durations):.2f}" if durations else None

    sorted_errors = sorted(error_types.items(), key=lambda x: x[1], reverse=True)[:5]
    top_errors = [{'type': t, 'count': c} for t, c in sorted_errors]

    timeline = build_timeline(logs)

    return {
        'total': total,
        'byLevel': by_level,
        'bySource': by_source,
        'errorRate': error_rate,
        'avgDuration': avg_duration,
        'maxDuration': max_duration,
        'topErrors': top_errors,
        'timeline': timeline
    }

def detect_anomalies(logs: List[Dict[str, Any]], stats: Dict[str, Any]) -> List[Dict[str, Any]]:
    anomalies = []
    error_rate = float(stats['errorRate'])
    if error_rate > 10:
        anomalies.append({
            'type': 'high_error_rate',
            'value': f"{error_rate}%",
            'severity': 'HIGH',
            'message': f"Error rate {error_rate}% exceeds 10% threshold"
        })
        
    if stats['maxDuration'] and float(stats['maxDuration']) > 5000:
        anomalies.append({
            'type': 'high_latency',
            'value': f"{stats['maxDuration']}ms",
            'severity': 'MEDIUM',
            'message': f"Max response time {stats['maxDuration']}ms indicates performance issues"
        })
        
    tl = stats['timeline']
    if len(tl) > 3:
        avg_errors = sum(b['ERROR'] for b in tl) / len(tl)
        for bucket in tl:
            if bucket['ERROR'] > avg_errors * 3 and bucket['ERROR'] > 5:
                anomalies.append({
                    'type': 'error_spike',
                    'value': bucket['ERROR'],
                    'at': bucket['time'],
                    'severity': 'HIGH',
                    'message': f"Error spike detected at {bucket['time']}: {bucket['ERROR']} errors (avg: {avg_errors:.1f})"
                })
                
    return anomalies

# ─── AI TOOL IMPLEMENTATIONS ───────────────────────────────────────────────
def tool_analyze_log_batch(logs: List[Any], analysis_focus: str) -> Dict[str, Any]:
    target_logs = logs if logs else log_store[-500:]
    stats = compute_stats(target_logs)
    return {
        'total_logs': stats['total'],
        'analysis_focus': analysis_focus,
        'level_distribution': stats['byLevel'],
        'error_rate_pct': float(stats['errorRate']),
        'sources': stats['bySource'],
        'top_errors': stats['topErrors'],
        'performance': {
            'avg_duration_ms': float(stats['avgDuration']),
            'max_duration_ms': float(stats['maxDuration'])
        } if stats['avgDuration'] else None,
        'timeline_buckets': stats['timeline'][-24:],
        'anomalies': detect_anomalies(target_logs, stats),
    }

def tool_identify_root_cause(logs: List[Any], issue_description: str, timeframe: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    target_logs = logs if logs else log_store
    if timeframe:
        try:
            start = datetime.fromisoformat(timeframe['start'].replace('Z', '+00:00')) if timeframe.get('start') else None
            end = datetime.fromisoformat(timeframe['end'].replace('Z', '+00:00')) if timeframe.get('end') else None
            
            filtered = []
            for l in target_logs:
                ts = datetime.fromisoformat(l['timestamp'].replace('Z', '+00:00'))
                if start and ts < start: continue
                if end and ts > end: continue
                filtered.append(l)
            target_logs = filtered
        except Exception:
            pass

    errors = [l for l in target_logs if l.get('level') == 'ERROR']
    error_types = {}
    for e in errors:
        t = extract_error_type(e.get('message', ''))
        error_types[t] = error_types.get(t, 0) + 1
        
    sorted_types = sorted(error_types.items(), key=lambda x: x[1], reverse=True)
    primary_cause = sorted_types[0][0] if sorted_types else 'Unknown'
    recent_errors = [{'timestamp': e['timestamp'], 'message': e['message'], 'source': e['source']} for e in errors[-10:]]

    return {
        'issue': issue_description,
        'logs_analyzed': len(target_logs),
        'errors_found': len(errors),
        'primary_cause': primary_cause,
        'cause_breakdown': [{'type': t, 'count': c, 'pct': f"{(c/len(errors))*100:.1f}%"} for t, c in sorted_types],
        'first_occurrence': errors[0]['timestamp'] if errors else None,
        'last_occurrence': errors[-1]['timestamp'] if errors else None,
        'recent_error_samples': recent_errors,
        'affected_sources': list(set(e['source'] for e in errors)),
    }

def tool_correlate_events(logs: List[Any], correlation_field: str) -> Dict[str, Any]:
    target_logs = logs if logs else log_store
    groups = {}
    
    for log in target_logs:
        if correlation_field == 'timestamp':
            try:
                ts = log['timestamp']
                if ts.endswith('Z'): ts = ts[:-1]
                d = datetime.fromisoformat(ts.split('.')[0])
                key = d.strftime("%Y-%m-%d %H:%M")
            except:
                key = 'unknown'
        else:
            meta = log.get('metadata', {})
            key = meta.get(correlation_field) or log.get(correlation_field) or 'unknown'
            
        if key not in groups:
            groups[key] = []
        groups[key].append({
            'timestamp': log['timestamp'],
            'source': log['source'],
            'level': log['level'],
            'message': log['message'][:120]
        })
        
    correlations = []
    for key, entries in sorted(groups.items(), key=lambda x: len(x[1]), reverse=True):
        if len(entries) > 1:
            correlations.append({
                correlation_field: key,
                'entry_count': len(entries),
                'sources': list(set(e['source'] for e in entries)),
                'levels': list(set(e['level'] for e in entries)),
                'has_errors': any(e['level'] == 'ERROR' for e in entries),
                'entries': entries[:5]
            })
            if len(correlations) >= 20:
                break
                
    return {
        'correlation_field': correlation_field,
        'total_groups': len(groups),
        'correlations': correlations,
        'cross_source_issues': [c for c in correlations if len(c['sources']) > 1 and c['has_errors']],
    }

def tool_generate_recommendations(analysis_results: Dict[str, Any], audience: str, urgency: str = None) -> Dict[str, Any]:
    error_rate = analysis_results.get('error_rate_pct', 0)
    anomalies = analysis_results.get('anomalies', [])
    top_errors = analysis_results.get('top_errors', [])
    
    immediate_actions = []
    long_term_solutions = []
    monitoring_alerts = []
    
    if error_rate > 10:
        immediate_actions.extend([
            'Investigate the root cause of elevated error rate immediately — check recent deployments and configuration changes',
            'Enable circuit breakers on affected services to prevent cascade failures'
        ])
        long_term_solutions.append('Implement structured error handling and standardized error codes across all services')
        
    for err in top_errors[:3]:
        t = err.get('type')
        if t == 'Connection Timeout':
            immediate_actions.append('Check network connectivity and firewall rules between services')
            long_term_solutions.append('Implement connection pooling and retry logic with exponential backoff')
            monitoring_alerts.append('Alert on connection timeout rate > 1% for 5 consecutive minutes')
        elif t == 'Database Error':
            immediate_actions.append('Check database server health, connection pool saturation, and query performance')
            long_term_solutions.append('Add read replicas, query caching layer, and connection pool sizing to match load')
            monitoring_alerts.append('Alert on database error rate > 0.5% and query latency P99 > 500ms')
        elif t == 'Auth Failure':
            immediate_actions.append('Review authentication service logs for token expiration or permission misconfiguration')
            long_term_solutions.append('Implement OAuth 2.0 refresh token rotation and centralized permission management')
        elif t == 'Service Unavailable':
            immediate_actions.append('Check service health dashboards and restart unhealthy instances')
            long_term_solutions.append('Implement health check endpoints and auto-restart policies with Kubernetes liveness probes')
            
    for anomaly in anomalies:
        t = anomaly.get('type')
        if t == 'high_latency':
            immediate_actions.append(f"Address performance bottleneck — max latency is {anomaly.get('value')}")
            long_term_solutions.append('Profile slow endpoints with APM tooling (Datadog, New Relic) and optimize database queries')
            monitoring_alerts.append('Alert on P95 latency > 2000ms for 3 consecutive minutes')
        elif t == 'error_spike':
            immediate_actions.append(f"Investigate error spike at {anomaly.get('at')} — correlate with deployment history")
            
    if not immediate_actions:
        immediate_actions.extend([
            'System appears healthy — continue monitoring current metrics',
            'Review INFO/DEBUG logs for any latent performance signals'
        ])
        
    long_term_solutions.extend([
        'Set up centralized log aggregation (ELK Stack, Grafana Loki, or Datadog Logs)',
        'Implement distributed tracing (Jaeger/Zipkin) with request_id propagation across services'
    ])
    monitoring_alerts.extend([
        'Alert on error rate > 5% for 2 consecutive minutes across any service',
        'Alert on log volume drop > 50% (service may have crashed)'
    ])
    
    return {
        'audience': audience or 'engineer',
        'urgency': urgency or ('critical' if error_rate > 10 else 'high' if error_rate > 5 else 'medium'),
        'executive_summary': f"{error_rate}% error rate detected across {analysis_results.get('total_logs', 0)} logs from {len(analysis_results.get('sources', {}))} sources. {len(anomalies)} anomalies identified.",
        'immediate_actions': immediate_actions,
        'long_term_solutions': long_term_solutions,
        'monitoring_and_alerts': monitoring_alerts,
    }

# ─── ROUTES ────────────────────────────────────────────────────────────────

class IngestRequest(BaseModel):
    logs: Optional[Union[List[Any], Any]] = None
    source: Optional[str] = 'unknown'
    raw_text: Optional[str] = None

@app.post('/api/logs/ingest')
async def ingest_logs(req: IngestRequest):
    parsed = []
    if req.raw_text:
        parsed = parse_logs(req.raw_text, req.source, next_id)
    elif req.logs is not None:
        logs_list = req.logs if isinstance(req.logs, list) else [req.logs]
        parsed = parse_logs(logs_list, req.source, next_id)
    else:
        raise HTTPException(status_code=400, detail="Provide logs or raw_text")

    if parsed:
        log_store.extend(parsed)
        save_store()
    return {"ingested": len(parsed), "total": len(log_store), "sample": parsed[:3]}

@app.get('/api/logs')
async def get_logs(
    source: Optional[str] = None,
    level: Optional[str] = None,
    search: Optional[str] = None,
    startDate: Optional[str] = None,
    endDate: Optional[str] = None,
    limit: int = 500,
    offset: int = 0
):
    filtered = log_store
    if source:
        filtered = [l for l in filtered if source.lower() in l.get('source', '').lower()]
    if level:
        filtered = [l for l in filtered if l.get('level') == level.upper()]
    if search:
        s = search.lower()
        filtered = [l for l in filtered if s in l.get('message', '').lower() or s in l.get('raw', '').lower()]
    if startDate:
        d = datetime.fromisoformat(startDate.replace('Z', '+00:00')).replace(tzinfo=None)
        filtered = [l for l in filtered if datetime.fromisoformat(l['timestamp'].replace('Z', '+00:00')).replace(tzinfo=None) >= d]
    if endDate:
        d = datetime.fromisoformat(endDate.replace('Z', '+00:00')).replace(tzinfo=None)
        filtered = [l for l in filtered if datetime.fromisoformat(l['timestamp'].replace('Z', '+00:00')).replace(tzinfo=None) <= d]
        
    total = len(filtered)
    page = filtered[offset: offset + limit]
    return {"total": total, "offset": offset, "limit": limit, "logs": page}

@app.get('/api/analyze')
async def get_analyze(
    source: Optional[str] = None,
    level: Optional[str] = None,
    startDate: Optional[str] = None,
    endDate: Optional[str] = None
):
    filtered = log_store
    if source:
        filtered = [l for l in filtered if source.lower() in l.get('source', '').lower()]
    if level:
        filtered = [l for l in filtered if l.get('level') == level.upper()]
    if startDate:
        d = datetime.fromisoformat(startDate.replace('Z', '+00:00')).replace(tzinfo=None)
        filtered = [l for l in filtered if datetime.fromisoformat(l['timestamp'].replace('Z', '+00:00')).replace(tzinfo=None) >= d]
    if endDate:
        d = datetime.fromisoformat(endDate.replace('Z', '+00:00')).replace(tzinfo=None)
        filtered = [l for l in filtered if datetime.fromisoformat(l['timestamp'].replace('Z', '+00:00')).replace(tzinfo=None) <= d]
        
    return compute_stats(filtered)

@app.get('/api/summary')
async def get_summary():
    stats = compute_stats(log_store)
    recent = [{'timestamp': l['timestamp'], 'level': l['level'], 'source': l['source'], 'message': l['message'][:100]} for l in log_store[-5:]]
    anomalies = detect_anomalies(log_store, stats)
    return {
        "total_logs": stats['total'],
        "sources": len(stats['bySource']),
        "error_rate": f"{stats['errorRate']}%",
        "level_counts": stats['byLevel'],
        "top_errors": stats['topErrors'],
        "recent_logs": recent,
        "has_anomalies": len(anomalies) > 0
    }

@app.delete('/api/logs')
async def delete_logs(source: Optional[str] = None):
    global log_store, next_id
    if source:
        before = len(log_store)
        log_store = [l for l in log_store if l.get('source') != source]
        save_store()
        return {"deleted": before - len(log_store), "remaining": len(log_store)}
    else:
        count = len(log_store)
        log_store = []
        next_id[0] = 1
        save_store()
        return {"deleted": count, "remaining": 0}

@app.get('/api/sources')
async def get_sources():
    sources = list(set(l.get('source') for l in log_store))
    return {"sources": sources}

# ─── GEMINI AI INTEGRATION ────────────────────────────────────────────────
class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    context_logs: Optional[Any] = None

SYSTEM_PROMPT = """You are an expert DevOps engineer and system administrator specialized in log analysis and troubleshooting. You have access to real log data from the user's system.

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
4. Evaluate MITRE ATT&CK metadata (`mitre_tactic` and `mitre_technique`) on security logs to determine potential active threats and TTPs.
5. Provide specific, actionable next steps

Severity assessment:
- CRITICAL: System down, data loss, security breach
- HIGH: Major functionality broken, significant performance degradation
- MEDIUM: Minor functionality issues, notable performance impact
- LOW: Informational, debugging info, expected operations

Always be professional, technical, and actionable. Format responses with clear sections. Use markdown for better readability."""

def get_tool_functions():
    def analyze_log_batch(analysis_focus: str):
        """Analyze a batch of logs from one or more sources to get statistics, anomalies, and patterns"""
        return tool_analyze_log_batch(None, analysis_focus)
        
    def identify_root_cause(issue_description: str, timeframe: dict = None):
        """Analyze logs to identify the root cause of specific issues"""
        return tool_identify_root_cause(None, issue_description, timeframe)
        
    def correlate_events(correlation_field: str):
        """Find relationships and correlations between logs from different sources"""
        return tool_correlate_events(None, correlation_field)
        
    def generate_recommendations(audience: str, urgency: str = None):
        """Generate actionable recommendations based on log analysis results"""
        stats = compute_stats(log_store)
        results = {
            'total_logs': stats['total'],
            'sources': stats['bySource'],
            'error_rate_pct': float(stats['errorRate']),
            'anomalies': detect_anomalies(log_store, stats),
            'top_errors': stats['topErrors']
        }
        return tool_generate_recommendations(results, audience, urgency)
        
    return [analyze_log_batch, identify_root_cause, correlate_events, generate_recommendations]

@app.post('/api/chat')
async def chat_endpoint(request: Request, body: ChatRequest):
    api_key = request.headers.get('x-gemini-api-key')
    if not api_key:
        return JSONResponse(status_code=401, content={"error": "Missing Gemini API key. Set it in the app settings."})

    client = genai.Client(api_key=api_key)

    stats = compute_stats(log_store)
    log_context = ""
    if log_store:
        top_err_str = ', '.join([f"{e['type']}({e['count']})" for e in stats['topErrors']])
        log_context = f"\n\nCURRENT LOG STORE CONTEXT:\n- Total logs: {len(log_store)}\n- Sources: {', '.join(stats['bySource'].keys())}\n- Error rate: {stats['errorRate']}%\n- Level breakdown: {json.dumps(stats['byLevel'])}\n- Top errors: {top_err_str}\n\nRecent logs (last 20):\n"
        log_context += "\n".join([f"[{l['timestamp']}] [{l['level']}] [{l['source']}] {l['message']}" for l in log_store[-20:]])
    else:
        log_context = "\n\nNo logs currently in the store. Ask the user to ingest logs first."

    gemini_messages = []
    for msg in body.messages:
        role = "user" if msg.role == "user" else "model"
        gemini_messages.append({"role": role, "parts": [{"text": msg.content}]})

    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT + log_context,
        temperature=0.3,
        max_output_tokens=4096,
        tools=get_tool_functions()
    )

    try:
        # Send history up to the last message, then send the last message
        history = gemini_messages[:-1]
        last_msg = gemini_messages[-1]['parts'][0]['text']
        
        # Format history using types.Content
        history_contents = [
            types.Content(role=m['role'], parts=[types.Part.from_text(text=p['text']) for p in m['parts']]) 
            for m in history
        ]
        
        chat = client.chats.create(
            model="gemini-2.5-flash", 
            config=config,
            history=history_contents
        )
        
        response = chat.send_message(last_msg)
        
        # chat.send_message automatically handles tool calls in a loop with google-genai SDK 0.3.0
        # when tools are provided as python functions.
        
        return {"response": response.text, "iterations": 1} # iterations is abstracted away by SDK
        
    except Exception as e:
        print(f"Chat error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

# Serve frontend files
@app.get("/")
async def serve_index():
    return FileResponse("index.html")

app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=3001, reload=True)
