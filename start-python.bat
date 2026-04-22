@echo off
echo Installing Python dependencies...
pip install -r requirements.txt

echo Starting Python Backend...
start cmd /k "python app.py"

echo Starting Frontend...
cd frontend
npm install
npm run dev
