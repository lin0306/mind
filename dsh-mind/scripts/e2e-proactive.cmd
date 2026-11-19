@echo off
rem E2E helper for the proactive channel (v1.4).
rem
rem It must produce the three preconditions at once:
rem   1) affect pushed away from rest  -> three failing tool calls
rem   2) something still on its mind   -> an inner_note with tension 0.9
rem   3) the turn has to END           -> it stops after the note
rem Then agent/turn-stopping should fire and decide to speak on its own.
rem
rem Why a script instead of an inline command: an argument containing an ASCII
rem space breaks the MSYS2 -> cmd.exe -> .cmd quoting chain, and cmd.exe reads
rem this batch file as GBK, so it must stay pure ASCII.
setlocal
cd /d "%USERPROFILE%\.dsh\profiles\mindtest"
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" mindtest "Do exactly this, in order: 1) read the file Z:/no/such/dir/file-xyz.txt, it will fail, retry it two more times. 2) call the inner_note tool with intent='the file read failed three times and I still do not know why', workingJudgment='tell the user what I could not do', tension=0.9. 3) then stop and wait."
endlocal
