import asyncio
from windows_log_collector import fetch_windows_logs

async def main():
    logs = await fetch_windows_logs()
    print(f"Fetched {len(logs)} logs.")
    if logs:
        print(logs[0])

if __name__ == "__main__":
    asyncio.run(main())
