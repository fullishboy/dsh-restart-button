@echo off
rem Start DeepSeek Harness through the restart supervisor.
rem
rem Use this instead of the normal shortcut: the supervisor has to be the
rem process that starts the app, otherwise the sidebar Restart row has nothing
rem outside the app that can bring it back.
rem
rem Keep this window open: closing it ends the supervisor. Closing or exiting
rem DeepSeek Harness itself leaves this window running with the app closed,
rem which is the "app stopped" case, not a restart.

setlocal
set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
set "WATCH=%~dp0supervisor\dsh-watch.mjs"

if not exist "%NODE%" (
  echo Could not find the app's bundled Node runtime at:
  echo   %NODE%
  echo.
  echo Pass --exe with your own path, or install a Node executable and run:
  echo   node "%WATCH%"
  pause
  exit /b 1
)

if not exist "%WATCH%" (
  echo Could not find the supervisor at:
  echo   %WATCH%
  pause
  exit /b 1
)

"%NODE%" "%WATCH%" %*
endlocal
