import re
import json
from datetime import datetime
from typing import Dict, Any, List, Optional
from mitre_mapping import get_mitre_info

LEVEL_MAP = {
    'error': 'ERROR', 'err': 'ERROR', 'fatal': 'ERROR', 'critical': 'ERROR', 'crit': 'ERROR',
    'warn': 'WARN', 'warning': 'WARN',
    'info': 'INFO', 'information': 'INFO', 'notice': 'INFO',
    'debug': 'DEBUG', 'trace': 'DEBUG', 'verbose': 'DEBUG',
}

def detect_level(text: str) -> str:
    lower = text.lower()
    for key, val in LEVEL_MAP.items():
        if key in lower:
            return val
    return 'INFO'

def parse_timestamp(raw: Optional[str]) -> str:
    if not raw:
        return datetime.utcnow().isoformat() + "Z"
    # Basic attempt to parse. If it fails, fallback to current time.
    # We will just return the raw string if it looks somewhat like a date,
    # or current time if it's completely unparseable. But actually, in Python
    # standardizing on ISO format is good.
    try:
        # In python dateutil is better, but we don't have it in requirements.
        # So we'll try basic fromisoformat or just return raw if we can't parse easily.
        # The frontend expects a string that new Date() can parse.
        return raw.strip()
    except Exception:
        return datetime.utcnow().isoformat() + "Z"

def extract_metadata(text: str) -> Dict[str, Any]:
    meta = {}
    kv_regex = re.compile(r'(\w+)=([^\s"]+|"[^"]*")')
    for match in kv_regex.finditer(text):
        meta[match.group(1)] = match.group(2).replace('"', '')
    return meta

def parse_single_log(raw: Any, source: str, next_id_ref: list) -> Optional[Dict[str, Any]]:
    if isinstance(raw, dict):
        level_raw = raw.get('level') or raw.get('severity') or raw.get('lvl') or 'info'
        level = LEVEL_MAP.get(str(level_raw).lower(), 'INFO')
        timestamp = raw.get('timestamp') or raw.get('time') or raw.get('@timestamp') or raw.get('date')
        timestamp = parse_timestamp(timestamp)
        message = raw.get('message') or raw.get('msg') or raw.get('text') or json.dumps(raw)
        
        metadata = raw.copy()
        for k in ['level', 'severity', 'lvl', 'timestamp', 'time', 'message', 'msg', 'text', '@timestamp', 'date', 'source']:
            metadata.pop(k, None)
            
        log_id = next_id_ref[0]
        next_id_ref[0] += 1
        
        return {
            'id': log_id,
            'timestamp': timestamp,
            'level': level,
            'source': raw.get('source', source),
            'message': message,
            'metadata': metadata,
            'raw': json.dumps(raw)
        }
        
    line = str(raw).strip()
    if not line:
        return None

    if line.startswith('{'):
        try:
            return parse_single_log(json.loads(line), source, next_id_ref)
        except json.JSONDecodeError:
            pass

    # Apache/Nginx
    apache_regex = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d+) (\S+)')
    apache_match = apache_regex.match(line)
    if apache_match:
        status_code = int(apache_match.group(4))
        level = 'ERROR' if status_code >= 500 else ('WARN' if status_code >= 400 else 'INFO')
        log_id = next_id_ref[0]
        next_id_ref[0] += 1
        return {
            'id': log_id,
            'timestamp': parse_timestamp(apache_match.group(2)),
            'level': level,
            'source': source,
            'message': f"{apache_match.group(3)} → {apache_match.group(4)}",
            'metadata': {
                'ip': apache_match.group(1),
                'method': apache_match.group(3).split(' ')[0] if ' ' in apache_match.group(3) else '',
                'path': apache_match.group(3).split(' ')[1] if ' ' in apache_match.group(3) else '',
                'status': status_code,
                'bytes': apache_match.group(5)
            },
            'raw': line
        }

    # Syslog
    syslog_regex = re.compile(r'^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\[:\s]+)(?:\[(\d+)\])?:\s+(.+)$')
    syslog_match = syslog_regex.match(line)
    if syslog_match:
        log_id = next_id_ref[0]
        next_id_ref[0] += 1
        return {
            'id': log_id,
            'timestamp': parse_timestamp(f"{datetime.now().year} {syslog_match.group(1)}"),
            'level': detect_level(syslog_match.group(5)),
            'source': syslog_match.group(3) or source,
            'message': syslog_match.group(5),
            'metadata': {'host': syslog_match.group(2), 'pid': syslog_match.group(4)},
            'raw': line
        }

    # Common structured
    structured_regex = re.compile(r'^[\[\(]?(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?:\s+\w+)?)[\]\)]?\s*[\[\(]?(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL)[\]\)]?\s*[:\-–]?\s*(.+)$', re.IGNORECASE)
    struct_match = structured_regex.match(line)
    if struct_match:
        meta = extract_metadata(struct_match.group(3))
        log_id = next_id_ref[0]
        next_id_ref[0] += 1
        return {
            'id': log_id,
            'timestamp': parse_timestamp(struct_match.group(1)),
            'level': LEVEL_MAP.get(struct_match.group(2).lower(), 'INFO'),
            'source': source,
            'message': struct_match.group(3),
            'metadata': meta,
            'raw': line
        }

    # Reverse structured
    reverse_regex = re.compile(r'^(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL)\s+[\[\(]?(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\]\)]*?)[\]\)]?\s*(.+)$', re.IGNORECASE)
    rev_match = reverse_regex.match(line)
    if rev_match:
        meta = extract_metadata(rev_match.group(3))
        log_id = next_id_ref[0]
        next_id_ref[0] += 1
        return {
            'id': log_id,
            'timestamp': parse_timestamp(rev_match.group(2)),
            'level': LEVEL_MAP.get(rev_match.group(1).lower(), 'INFO'),
            'source': source,
            'message': rev_match.group(3),
            'metadata': meta,
            'raw': line
        }

    # Plain text fallback
    ts_regex = re.compile(r'(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)')
    ts_match = ts_regex.search(line)
    meta = extract_metadata(line)
    log_id = next_id_ref[0]
    next_id_ref[0] += 1
    return {
        'id': log_id,
        'timestamp': parse_timestamp(ts_match.group(1)) if ts_match else datetime.utcnow().isoformat() + "Z",
        'level': detect_level(line),
        'source': source,
        'message': line,
        'metadata': meta,
        'raw': line
    }

def parse_logs(input_data: Any, source: str, next_id_ref: list) -> List[Dict[str, Any]]:
    results = []

    def enrich(parsed: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not parsed:
            return None
        metadata = parsed.get('metadata', {})
        if 'eventId' in metadata:
            mitre = get_mitre_info(metadata['eventId'])
            if mitre:
                metadata['mitre_tactic'] = mitre['tactic']
                metadata['mitre_technique'] = mitre['technique']
        return parsed

    if isinstance(input_data, list):
        for item in input_data:
            parsed = enrich(parse_single_log(item, source, next_id_ref))
            if parsed:
                results.append(parsed)
    elif isinstance(input_data, str):
        lines = input_data.splitlines()
        for line in lines:
            if not line.strip():
                continue
            parsed = enrich(parse_single_log(line, source, next_id_ref))
            if parsed:
                results.append(parsed)
                
    return results
