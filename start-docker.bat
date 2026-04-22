@echo off
echo Starting Docker containers...
docker-compose up -d --build

echo.
echo Application is running!
echo Frontend: http://localhost:5173
echo Backend: http://localhost:3001
echo.
echo To stop, run: docker-compose down
pause
