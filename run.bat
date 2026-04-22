@echo off
echo Starting Backend...
cd backend
start cmd /k "npx tsx server.ts"

echo Starting Frontend...
cd ../frontend
start cmd /k "npm run dev"

echo Done! Both servers are starting...
