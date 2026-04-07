@echo off
title Aider Coding Session
echo Starting Aider with your default config...

:: This command ensures the terminal opens in the exact folder where the .bat file lives
cd /d "%~dp0"

:: Launch aider. It will automatically read your favorite models from the .aider.conf.yml file!
python -m aider

:: This keeps the window open just in case there is an error message when starting or exiting
pause