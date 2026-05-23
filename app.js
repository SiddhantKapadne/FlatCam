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
let uploadSourceW = 0;
let uploadSourceH = 0;
let useCamera = true;
let facingMode = 'environment';
let W = 0;
let H = 0;
let layout = getColumnLayout(1);

ctx.imageSmoothingEnabled = false;
frameCtx.imageSmoothingEnabled = false;

let statusTimer;

function hapticLight() {
  if (navigator.vibrate) navigator.vibrate(10);
}

function pressAnimation(el) {
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.classList.add('is-pressed');
  setTimeout(() => el.classList.remove('is-pressed'), 140);
}

function bindPressFeedback(...elements) {
  for (const el of elements) {
    if (!el) continue;
    el.addEventListener('pointerdown', () => pressAnimation(el));
  }
}

function setDownloadVisible(visible) {
  if (!downloadBtn) return;
  downloadBtn.hidden = !visible;
  downloadBtn.disabled = !visible;
  downloadBtn.setAttribute('aria-hidden', String(!visible));
  if (visible) {
    requestAnimationFrame(() => downloadBtn.classList.add('is-ready'));
  } else {
    downloadBtn.classList.remove('is-ready');
  }
}

function blobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = filename;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function canvasToPngBlob(sourceCanvas) {
  return new Promise((resolve) => {
    sourceCanvas.toBlob((blob) => resolve(blob), 'image/png', 1);
  });
}

/** Export upload at original pixel dimensions (same as uploaded file). */
function renderUploadAtSourceSize() {
  const w = uploadSourceW;
  const h = uploadSourceH;
  const sourceFrame = document.createElement('canvas');
  sourceFrame.width = w;
  sourceFrame.height = h;
  const sfCtx = sourceFrame.getContext('2d');
  sfCtx.imageSmoothingEnabled = false;
  sfCtx.drawImage(uploadedImage, 0, 0, w, h);

  const exportLayout = getColumnLayout(w);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const outCtx = out.getContext('2d');
  outCtx.imageSmoothingEnabled = false;
  drawStaticSlitScan(outCtx, sourceFrame, w, h, exportLayout);
  return out;
}

async function saveSnapshotToStorage() {
  if (uploadedImage && !useCamera && uploadSourceW > 0 && uploadSourceH > 0) {
    const exportCanvas = renderUploadAtSourceSize();
    const blob = await canvasToPngBlob(exportCanvas);
    if (!blob) {
      setStatus('Could not save', 'error');
      return;
    }
    blobDownload(blob, `flatcam-${Date.now()}.png`);
    setStatus(`Saved ${uploadSourceW}×${uploadSourceH}`, 'success');
    return;
  }

  if (!canvas.width || !canvas.height) {
    setStatus('Nothing to save yet', 'error');
    return;
  }

  const blob = await canvasToPngBlob(canvas);
  if (!blob) {
    setStatus('Could not save snapshot', 'error');
    return;
  }
  blobDownload(blob, `flatcam-${Date.now()}.png`);
  setStatus('Snapshot saved', 'success');
}

function downloadCapture() {
  saveSnapshotToStorage();
}

function setStatus(msg, type = 'default') {
  if (!statusEl) return;
  clearTimeout(statusTimer);
  statusEl.textContent = msg;
  const tone = type === 'error' ? ' err' : type === 'success' ? ' ok' : '';
  statusEl.className = `status show${tone}`;
  statusTimer = setTimeout(() => {
    statusEl.className = 'status';
  }, type === 'error' ? 5000 : 2500);
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

function setDisplaySize(w, h) {
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
    setDisplaySize(w, h);
    if (useCamera && stream) resetColumns();
  }
}

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
    frameCtx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return true;
  }

  if (!uploadedImage) return false;
  const iw = uploadedImage.naturalWidth;
  const ih = uploadedImage.naturalHeight;
  const scale = Math.min(W / iw, H / ih, 1);
  const dw = iw * scale;
  const dh = ih * scale;
  frameCtx.drawImage(uploadedImage, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return true;
}

function sampleX(colIndex, colLayout, width) {
  const { xs, widths } = colLayout;
  return Math.max(0, Math.min(width - SLIT_W, Math.floor(xs[colIndex] + widths[colIndex] / 2)));
}

function captureStrip(colIndex, sourceFrame, colLayout, height, width) {
  const buf = document.createElement('canvas');
  buf.width = SLIT_W;
  buf.height = height;
  const b = buf.getContext('2d');
  b.imageSmoothingEnabled = false;
  const x = sampleX(colIndex, colLayout, width);
  b.drawImage(sourceFrame, x, 0, SLIT_W, height, 0, 0, SLIT_W, height);
  return buf;
}

function drawStaticSlitScan(targetCtx, sourceFrame, width, height, colLayout) {
  targetCtx.fillStyle = '#000';
  targetCtx.fillRect(0, 0, width, height);
  for (let c = 0; c < COLS; c++) {
    const strip = captureStrip(c, sourceFrame, colLayout, height, width);
    targetCtx.drawImage(
      strip,
      0,
      0,
      SLIT_W,
      height,
      colLayout.xs[c],
      0,
      colLayout.widths[c],
      height
    );
  }
}

function drawColumn(colIndex, strip) {
  const { xs, widths } = layout;
  ctx.drawImage(strip, 0, 0, strip.width, H, xs[colIndex], 0, widths[colIndex], H);
}

function drawDisplayStaticSlitScan() {
  for (let c = 0; c < COLS; c++) {
    const strip = captureStrip(c, frame, layout, H, W);
    drawColumn(c, strip);
  }
}

function drawTimeSlitScan() {
  columnBuffers[scanIndex] = captureStrip(scanIndex, frame, layout, H, W);
  scanIndex = (scanIndex + 1) % COLS;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  for (let c = 0; c < COLS; c++) {
    if (columnBuffers[c]) drawColumn(c, columnBuffers[c]);
  }
}

function render() {
  if (!drawSourceToFrame()) {
    animId = requestAnimationFrame(render);
    return;
  }

  if (useCamera) {
    drawTimeSlitScan();
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawDisplayStaticSlitScan();
  }

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
  uploadSourceW = 0;
  uploadSourceH = 0;
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
  uploadSourceW = img.naturalWidth;
  uploadSourceH = img.naturalHeight;
  useCamera = false;
  setDownloadVisible(false);
  syncCanvasToViewport();
  resetColumns();
  startRender();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setDownloadVisible(true);
      setStatus(`Ready — ${uploadSourceW}×${uploadSourceH}`);
    });
  });
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  hapticLight();
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
  hapticLight();
  if (useCamera && stream) {
    saveSnapshotToStorage();
    return;
  }
  if (uploadedImage && !useCamera) {
    startCamera()
      .then(() => setStatus('Camera on — tap capture to save'))
      .catch((err) => setStatus(err.message, 'error'));
    return;
  }
  startCamera().catch((err) => setStatus(err.message, 'error'));
});

flipBtn.addEventListener('click', () => {
  hapticLight();
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  startCamera().catch((err) => setStatus(err.message, 'error'));
});

downloadBtn.addEventListener('click', () => {
  if (downloadBtn.hidden || !uploadedImage) return;
  hapticLight();
  saveSnapshotToStorage();
});

bindPressFeedback(cameraBtn, flipBtn, downloadBtn, document.querySelector('.btn-upload'));

let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(syncCanvasToViewport, 150);
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
  setStatus('Allow camera or tap Upload', 'error');
});
