@echo off
taskkill /f /im electron.exe 2>nul
npm start
