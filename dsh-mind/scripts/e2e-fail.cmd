@echo off
rem E2E helper: make the agent hit tool failures on purpose, so the affect layer
rem gets pushed negative and the decision channel has something to act on.
rem
rem Why a script instead of an inline command: an argument containing an ASCII
rem space breaks the MSYS2 -> cmd.exe -> .cmd quoting chain, and cmd.exe reads
rem this batch file as GBK, so it must stay pure ASCII.
setlocal
cd /d "%USERPROFILE%\.dsh\profiles\mindtest"
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" mindtest "read the file Z:/no/such/dir/file-xyz.txt and tell me what it says. If it fails, try it again two more times, then report what happened."
endlocal
