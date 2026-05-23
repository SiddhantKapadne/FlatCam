const COLS = 7;
const SLIT_W = 1;

const viewEl = document.getElementById('view');
const video = document.getElementById('cam');
const canvas = document.getElementById('out');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const fileInput = document.getElementById('file');
const cameraBtn = document.getElementById('cameraBtn');
const flipBtn = document.getElementById('flipBtn');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');

const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d', { willReadFrequently: true });

let columnBuffers = [];
let scanIndex = 0;
let animId = 0;
let stream = null;
let uploadedImage = null;
let useCamera = true;
let facingMode = 'environment';
let W = 0;
let H = 0;
let layout = getColumnLayout(1);

ctx.imageSmoothingEnabled = false;
frameCtx.imageSmoothingEnabled = false;

let statusTimer;

function setDownloadVisible(visible) {
  if (!downloadBtn) return;
  downloadBtn.hidden = !visible;
  downloadBtn.disabled = !visible;
}

/** Save exactly what is on screen — no re-render, so the file matches the preview. */
function saveSnapshotToStorage() {
  if (!canvas.width || !canvas.height) {
    setStatus('Nothing to save yet', true);
    return;
  }

  canvas.toBlob(
    (blob) => {
      if (!blob) {
        setStatus('Could not save snapshot', true);
        return;
      }
      const filename = `flatcam-${Date.now()}.png`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = filename;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
      setStatus('Snapshot saved');
    },
    'image/png',
    1
  );
}

function downloadCapture() {
  saveSnapshotToStorage();
}

function setStatus(msg, isErr = false) {
  if (!statusEl) return;
  clearTimeout(statusTimer);
  statusEl.textContent = msg;
  statusEl.className = `status show${isErr ? ' err' : ''}`;
  statusTimer = setTimeout(() => {
    statusEl.className = 'status';
  }, isErr ? 5000 : 2500);
}

function getRenderSize() {
  if (!viewEl) return { w: 360, h: 640 };
  const rect = viewEl.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return {
    w: Math.max(280, Math.round(rect.width * dpr)),
    h: Math.max(400, Math.round(rect.height * dpr)),
  };
}

function getColumnLayout(width) {
  const base = Math.floor(width / COLS);
  const widths = Array(COLS - 1).fill(base);
  widths.push(width - base * (COLS - 1));
  const xs = [];
  let x = 0;
  for (const w of widths) {
    xs.push(x);
    x += w;
  }
  return { widths, xs };
}

function setSize(w, h) {
  W = w;
  H = h;
  layout = getColumnLayout(W);
  canvas.width = W;
  canvas.height = H;
  frame.width = W;
  frame.height = H;
  resetColumns();
}

function resetColumns() {
  columnBuffers = Array.from({ length: COLS }, () => null);
  scanIndex = 0;
}

function syncCanvasToViewport() {
  const { w, h } = getRenderSize();
  if (w !== W || h !== H) {
    setSize(w, h);
    if (useCamera && stream) resetColumns();
  }
}

/** Camera: fill view (cover). Upload: original aspect ratio (contain). */
function drawSourceToFrame() {
  frameCtx.fillStyle = '#000';
  frameCtx.fillRect(0, 0, W, H);

  if (useCamera) {
    if (video.readyState < 2) return false;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    frameCtx.drawImage(video, dx, dy, dw, dh);
    return true;
  }

  if (!uploadedImage) return false;
  const iw = uploadedImage.naturalWidth;
  const ih = uploadedImage.naturalHeight;
  const scale = Math.min(W / iw, H / ih, 1);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;
  frameCtx.drawImage(uploadedImage, dx, dy, dw, dh);
  return true;
}

function sampleX(colIndex) {
  const { xs, widths } = layout;
  return Math.max(0, Math.min(W - SLIT_W, Math.floor(xs[colIndex] + widths[colIndex] / 2)));
}

function drawColumn(colIndex, strip) {
  const { xs, widths } = layout;
  ctx.drawImage(strip, 0, 0, strip.width, H, xs[colIndex], 0, widths[colIndex], H);
}

function captureStrip(colIndex) {
  const buf = document.createElement('canvas');
  buf.width = SLIT_W;
  buf.height = H;
  const b = buf.getContext('2d');
  b.imageSmoothingEnabled = false;
  b.drawImage(frame, sampleX(colIndex), 0, SLIT_W, H, 0, 0, SLIT_W, H);
  return buf;
}

function drawStaticSlitScan() {
  for (let c = 0; c < COLS; c++) {
    drawColumn(c, captureStrip(c));
  }
}

function drawTimeSlitScan() {
  columnBuffers[scanIndex] = captureStrip(scanIndex);
  scanIndex = (scanIndex + 1) % COLS;

  for (let c = 0; c < COLS; c++) {
    if (columnBuffers[c]) drawColumn(c, columnBuffers[c]);
  }
}

function render() {
  if (!drawSourceToFrame()) {
    animId = requestAnimationFrame(render);
    return;
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  if (useCamera) drawTimeSlitScan();
  else drawStaticSlitScan();

  animId = requestAnimationFrame(render);
}

function stopRender() {
  if (animId) cancelAnimationFrame(animId);
  animId = 0;
}

function startRender() {
  stopRender();
  animId = requestAnimationFrame(render);
}

async function getCameraStream() {
  const attempts = [{ facingMode: { ideal: facingMode } }, { facingMode }, true];

  for (const facing of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          ...facing,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch {
      /* try next */
    }
  }
  throw new Error('Camera needs HTTPS or localhost');
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera needs HTTPS or localhost');
  }
  if (stream) stream.getTracks().forEach((t) => t.stop());

  stream = await getCameraStream();
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  await video.play();

  useCamera = true;
  uploadedImage = null;
  setDownloadVisible(false);
  syncCanvasToViewport();
  resetColumns();
  startRender();
}

function useUploadedImage(img) {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  uploadedImage = img;
  useCamera = false;
  setDownloadVisible(false);
  syncCanvasToViewport();
  resetColumns();
  startRender();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setDownloadVisible(true);
      setStatus('Ready — tap Download');
    });
  });
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    useUploadedImage(img);
    URL.revokeObjectURL(url);
  };
  img.src = url;
  e.target.value = '';
});

cameraBtn.addEventListener('click', () => {
  if (useCamera && stream) {
    saveSnapshotToStorage();
    return;
  }
  if (uploadedImage && !useCamera) {
    startCamera()
      .then(() => setStatus('Camera on — tap capture to save'))
      .catch((err) => setStatus(err.message, true));
    return;
  }
  startCamera().catch((err) => setStatus(err.message, true));
});

flipBtn.addEventListener('click', () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  startCamera().catch((err) => setStatus(err.message, true));
});

downloadBtn.addEventListener('click', () => {
  if (downloadBtn.hidden || !uploadedImage) return;
  saveSnapshotToStorage();
});

let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    syncCanvasToViewport();
  }, 150);
}

window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopRender();
  else if (useCamera && stream) startRender();
  else if (uploadedImage) startRender();
});

setDownloadVisible(false);
syncCanvasToViewport();
startCamera().catch(() => {
  useCamera = false;
  setStatus('Allow camera or tap Upload', true);
});
