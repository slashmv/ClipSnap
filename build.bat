@REM filepath: youtube-clipper/build.bat
@echo off
echo Building YouTube Clipper...

echo 1. Setting up virtual environment...
python -m venv venv
call venv\Scripts\activate

echo 2. Installing Python requirements...
pip install pyinstaller==6.3.0 flask==3.0.0 flask-cors==4.0.0 yt-dlp==2023.12.30 werkzeug==3.0.1

echo 3. Building React frontend...
cd frontend\frontend
call npm install
call npm run build
cd ..\..

echo 4. Downloading FFmpeg...
powershell -Command "Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile 'ffmpeg.zip'"
powershell -Command "Expand-Archive -Path 'ffmpeg.zip' -DestinationPath 'ffmpeg_temp'"
copy ffmpeg_temp\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe .
copy ffmpeg_temp\ffmpeg-master-latest-win64-gpl\bin\ffprobe.exe .
rmdir /s /q ffmpeg_temp
del ffmpeg.zip

echo 5. Creating executable...
pyinstaller --noconfirm youtube_clipper.spec

echo Build complete! Executable is in the dist folder.
pause