import asyncio
import json
import base64
import sys
from datetime import datetime, timedelta, timezone

last_fetch_time = datetime.now(timezone.utc) - timedelta(minutes=10)

async def fetch_windows_logs():
    global last_fetch_time
    if sys.platform != 'win32':
        return []

    start_time_iso = last_fetch_time.isoformat()
    # Update last_fetch_time to now
    last_fetch_time = datetime.now(timezone.utc)

    ps_command = f"""
    $ErrorActionPreference = 'SilentlyContinue'
    $logNames = @('Application', 'System', 'Security')
    $events = @()
    $startTime = [datetime]'{start_time_iso}'

    foreach ($log in $logNames) {{
        $logEvents = Get-WinEvent -FilterHashtable @{{LogName=$log; StartTime=$startTime}} -MaxEvents 200
        if ($logEvents) {{
            $events += $logEvents
        }}
    }}

    if ($events.Count -gt 0) {{
        $events | Sort-Object TimeCreated -Descending | Select-Object -First 500 | Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message | ConvertTo-Json -Compress -Depth 1
    }} else {{
        Write-Output "[]"
    }}
    """

    try:
        import subprocess
        encoded_command = base64.b64encode(ps_command.encode('utf-16le')).decode('utf-8')
        
        def run_ps():
            return subprocess.run(
                ['powershell.exe', '-EncodedCommand', encoded_command],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False
            )
            
        process = await asyncio.to_thread(run_ps)
        
        stdout_str = process.stdout.decode('utf-8', errors='replace').strip()
        
        if not stdout_str or stdout_str == '[]':
            return []
            
        try:
            raw_data = json.loads(stdout_str)
        except json.JSONDecodeError as e:
            print(f"Failed to parse Windows logs JSON: {e}")
            return []
            
        if not isinstance(raw_data, list):
            raw_data = [raw_data]
            
        logs = []
        for log in raw_data:
            win_level = (log.get('LevelDisplayName') or '').lower()
            mapped_level = 'INFO'
            if 'error' in win_level or 'critical' in win_level:
                mapped_level = 'ERROR'
            elif 'warn' in win_level or 'warning' in win_level:
                mapped_level = 'WARN'
                
            timestamp = log.get('TimeCreated')
            # Extract standard timestamp format. PowerShell ConvertTo-Json handles Date differently sometimes,
            # especially in older PS versions it emits \/Date(...)\/
            if timestamp and '/Date(' in timestamp:
                import re
                match = re.search(r'/Date\((\d+)\)/', timestamp)
                if match:
                    ms = int(match.group(1))
                    timestamp = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()
            elif timestamp:
                # It might just be a normal ISO string in newer PS versions.
                # Try parsing it to ensure valid ISO
                try:
                    # Let javascript frontend handle it if it's already a valid date string
                    pass
                except Exception:
                    timestamp = datetime.utcnow().isoformat() + "Z"
            
            if not timestamp:
                timestamp = datetime.utcnow().isoformat() + "Z"

            logs.append({
                'timestamp': timestamp,
                'level': mapped_level,
                'source': log.get('ProviderName') or 'WindowsEventLog',
                'message': log.get('Message') or f"Event ID {log.get('Id')}",
                'metadata': {
                    'eventId': log.get('Id'),
                    'winLevel': log.get('LevelDisplayName')
                },
                'raw': json.dumps(log)
            })
            
        return logs
        
    except Exception as e:
        print(f"Could not fetch Windows Event Logs: {e}")
        return []
