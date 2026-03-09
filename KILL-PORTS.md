# Kill ports 3000 and 4000

When the terminal is lost or something is still using the app ports, run one of these.

## From project root (recommended)

```bash
npm run kill-ports
```

## From anywhere (PowerShell)

Kill whatever is on **3000** and **4000**:

```powershell
$ports = 3000, 4000
foreach ($p in $ports) {
  $line = netstat -ano | findstr ":$p.*LISTENING"
  if ($line) {
    $pid = ($line -split '\s+')[-1]
    if ($pid -match '^\d+$') { taskkill /F /PID $pid; Write-Host "Killed $pid on port $p" }
  }
}
```

Simpler (PowerShell, run each line or both):

```powershell
# Port 3000
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host "Cleared 3000"

# Port 4000  
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host "Cleared 4000"
```

Or with **cmd** (run from any folder):

```cmd
for /f "tokens=5" %a in ('netstat -ano ^| findstr :3000.*LISTENING') do taskkill /F /PID %a
for /f "tokens=5" %a in ('netstat -ano ^| findstr :4000.*LISTENING') do taskkill /F /PID %a
```

(In cmd, use `%%a` instead of `%a` inside a .bat file.)

---

**Ports used by this app**

- **3000** – Next.js app (`npm run dev`)
- **4000** – Bridge WebSocket (`npm run bridge`)
