MITRE_MAPPING = {
    # Common Windows Security Event IDs
    4624: {"tactic": "Initial Access / Persistence", "technique": "T1078 - Valid Accounts"},
    4625: {"tactic": "Credential Access", "technique": "T1110 - Brute Force"},
    4688: {"tactic": "Execution", "technique": "T1059 - Command and Scripting Interpreter"},
    4720: {"tactic": "Persistence", "technique": "T1136 - Create Account"},
    4722: {"tactic": "Persistence", "technique": "T1098 - Account Manipulation"},
    4724: {"tactic": "Credential Access", "technique": "T1098 - Account Manipulation (Password Reset)"},
    4728: {"tactic": "Persistence / Privilege Escalation", "technique": "T1098 - Account Manipulation (Add to Group)"},
    4732: {"tactic": "Persistence / Privilege Escalation", "technique": "T1098 - Account Manipulation (Add to Local Group)"},
    1102: {"tactic": "Defense Evasion", "technique": "T1070 - Indicator Removal on Host"},
    7045: {"tactic": "Privilege Escalation / Persistence", "technique": "T1543.003 - Create or Modify System Process: Windows Service"},
    5140: {"tactic": "Lateral Movement", "technique": "T1021.002 - Remote Services: SMB/Windows Admin Shares"},
    
    # Sysmon Event IDs
    1: {"tactic": "Execution", "technique": "T1059 - Command and Scripting Interpreter"},
    3: {"tactic": "Command and Control", "technique": "T1071 - Application Layer Protocol"},
    8: {"tactic": "Defense Evasion / Privilege Escalation", "technique": "T1055 - Process Injection"},
    11: {"tactic": "Execution / Persistence", "technique": "T1574 - Hijack Execution Flow"},
    22: {"tactic": "Discovery", "technique": "T1087 - Account Discovery"}
}

def get_mitre_info(event_id):
    if event_id is None:
        return None
    try:
        id_int = int(event_id)
        return MITRE_MAPPING.get(id_int, None)
    except (ValueError, TypeError):
        return None
