// ── EBOOT artwork generation ─────────────────────────────────────────────────
//
// Generates default ICON0, PIC0, and PIC1 PNG images using Canvas 2D.
// These are the artwork slots in the PBP container that the PSP XMB displays:
//   ICON0: 144×80  — small icon shown in the game list
//   PIC0:  310×180 — info overlay on the game details screen
//   PIC1:  480×272 — full-screen background behind PIC0
//
// The defaults render the game title and disc ID on a dark background.
// Users can replace any slot with custom artwork via the UI.

// ── Fitting an image into a slot ─────────────────────────────────────────────
// Fetched covers and uploads rarely match a slot's shape: a PS1 cover is
// square and a PSP cover tall, while ICON0 is wide. Stretching distorts them,
// so an image is either fitted whole (containRect) or cropped to fill
// (coverRect), keeping its proportions either way.

/** Where to draw a srcW×srcH image so all of it shows in dstW×dstH, centred. */
function containRect(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  return centredRect(Math.round(srcW * scale), Math.round(srcH * scale), dstW, dstH);
}

/** Where to draw a srcW×srcH image so it fills dstW×dstH, centred, with the overflow cropped. */
function coverRect(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  return centredRect(Math.round(srcW * scale), Math.round(srcH * scale), dstW, dstH);
}

function centredRect(w, h, dstW, dstH) {
  return { x: Math.round((dstW - w) / 2), y: Math.round((dstH - h) / 2), w, h };
}

/** Find the largest font size (between maxSize and minSize) that fits text in maxWidth. */
function fitText(ctx, text, maxWidth, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size--) {
    ctx.font = `bold ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  return minSize;
}

/** Word-wrap text into at most maxLines lines that fit within maxWidth. */
function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  else if (line && lines.length >= maxLines) {
    lines[lines.length - 1] = lines[lines.length - 1] + ' ' + line;
  }
  return lines;
}

/** Find the largest font size where word-wrapped text fits within maxWidth × maxLines. */
function fitTextWrapped(ctx, text, maxWidth, maxSize, minSize, maxLines) {
  for (let sz = maxSize; sz >= minSize; sz--) {
    ctx.font = `bold ${sz}px sans-serif`;
    const wrapped = wrapText(ctx, text, maxWidth, maxLines);
    if (wrapped.every(l => ctx.measureText(l).width <= maxWidth)) {
      return { fontSize: sz, lines: wrapped };
    }
  }
  ctx.font = `bold ${minSize}px sans-serif`;
  return { fontSize: minSize, lines: wrapText(ctx, text, maxWidth, maxLines) };
}

function drawTitleBlock(ctx, text, opts) {
  const { centerX, maxWidth, maxSize, minSize, maxLines } = opts;
  // Try single line first
  let fontSize = fitText(ctx, text, maxWidth, maxSize, minSize);
  ctx.font = `bold ${fontSize}px sans-serif`;
  let lines;
  if (ctx.measureText(text).width > maxWidth) {
    // Word-wrap to multiple lines at a larger size
    const result = fitTextWrapped(ctx, text, maxWidth, maxSize, minSize, maxLines);
    fontSize = result.fontSize;
    lines = result.lines;
  } else {
    lines = [text];
  }
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  const lineH = fontSize * 1.3;
  const titleY = opts.baseY - ((lines.length - 1) * lineH) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], centerX, titleY + i * lineH);
  }
  return titleY + (lines.length - 1) * lineH;
}

function drawAccentLine(ctx, centerX, y, halfWidth) {
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(centerX - halfWidth, y);
  ctx.lineTo(centerX + halfWidth, y);
  ctx.stroke();
}

/** Generate a 144×80 ICON0 PNG with the game title on a dark background. */
function generateDefaultIcon0(title) {
  const c = document.createElement('canvas');
  c.width = 144; c.height = 80;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 144, 80);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const displayTitle = (title || 'PS1 Game').length > 30
    ? (title || 'PS1 Game').slice(0, 30) + '...' : (title || 'PS1 Game');
  const fontSize = fitText(ctx, displayTitle, 128, 22, 9);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.fillText(displayTitle, 72, 32);
  drawAccentLine(ctx, 72, 52, 40);
  ctx.fillStyle = '#666';
  ctx.font = '8px sans-serif';
  ctx.fillText('PlayStation', 72, 65);
  return canvasToUint8Array(c);
}

/** Generate a 310×180 PIC0 PNG with the game title and disc ID. */
function generateDefaultPic0(title, discId) {
  const c = document.createElement('canvas');
  c.width = 310; c.height = 180;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 310, 180);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawTitleBlock(ctx, title || 'PS1 Game', {
    centerX: 155, maxWidth: 280, maxSize: 28, minSize: 12, maxLines: 2, baseY: 65,
  });
  if (discId) {
    ctx.fillStyle = '#888';
    ctx.font = '12px monospace';
    ctx.fillText(discId, 155, 120);
  }
  drawAccentLine(ctx, 155, 145, 75);
  ctx.fillStyle = '#666';
  ctx.font = '11px sans-serif';
  ctx.fillText('PlayStation', 155, 162);
  return canvasToUint8Array(c);
}

/** Generate a 480×272 PIC1 PNG with the game title on a gradient background. */
function generateDefaultPic1(title) {
  const c = document.createElement('canvas');
  c.width = 480; c.height = 272;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 480, 272);
  grad.addColorStop(0, '#1a1a2e');
  grad.addColorStop(1, '#252545');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 480, 272);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawTitleBlock(ctx, title || 'PS1 Game', {
    centerX: 240, maxWidth: 440, maxSize: 40, minSize: 16, maxLines: 2, baseY: 120,
  });
  drawAccentLine(ctx, 240, 165, 100);
  ctx.fillStyle = '#555';
  ctx.font = '14px sans-serif';
  ctx.fillText('PlayStation', 240, 185);
  return canvasToUint8Array(c);
}
