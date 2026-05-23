# FlatCam

Slit-scan camera web app — vertical column stretch with a clean, reference-style look.

## Features

- Live camera slit-scan (7 columns, time-based scan)
- Image upload with original aspect ratio
- Mobile full-screen UI with flip camera control
- Desktop centered 9:16 view on `#E2E2E5` background
- Save processed frame as PNG

## Run locally

```bash
python3 -m http.server 8080
```

Open **http://localhost:8080**. Camera requires **HTTPS** or **localhost** (use [ngrok](https://ngrok.com) on mobile).

## Stack

- HTML5 Canvas
- `getUserMedia` for camera
- No build step required
