@echo off
set "KB_ROOT=%~dp0.."
schtasks /create /tn KB-GitCommits-Daily /tr "node \"%KB_ROOT%\_site\scripts\safe-runner.js\" --slug ALL" /sc daily /st 08:00 /f
echo Done.
schtasks /query /tn KB-GitCommits-Daily
pause
