// Các hàm xử lý ảnh thuần JavaScript (không phụ thuộc DOM) để có thể
// chạy cả trong trình duyệt lẫn Node (kiểm thử). Ảnh nhị phân dùng
// Uint8Array, 1 = điểm mực (tối), 0 = nền.

/** RGBA (ImageData.data) -> ảnh xám Uint8Array */
export function toGray(rgba, width, height) {
  const n = width * height;
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    // Pixel trong suốt coi như nền trắng
    const r = rgba[j] * a + 255 * (1 - a);
    const g = rgba[j + 1] * a + 255 * (1 - a);
    const b = rgba[j + 2] * a + 255 * (1 - a);
    gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return gray;
}

/** Ngưỡng Otsu toàn cục */
export function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/**
 * Nhị phân hóa thích nghi (Bradley) dùng ảnh tích phân, kết hợp ngưỡng
 * Otsu để tránh nhiễu ở vùng nền đồng nhất.
 */
export function binarize(gray, width, height, { windowSize, t = 0.15 } = {}) {
  const win = windowSize || Math.max(15, (Math.min(width, height) / 40) | 1);
  const half = win >> 1;
  const W = width + 1;
  const integral = new Float64Array(W * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + rowSum;
    }
  }
  const globalThr = otsu(gray);
  // Điểm sáng hơn hẳn ngưỡng Otsu không bao giờ là mực
  const hardWhite = Math.min(250, globalThr + (255 - globalThr) * 0.5);
  const bin = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(width - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = integral[(y1 + 1) * W + x1 + 1] - integral[y0 * W + x1 + 1]
        - integral[(y1 + 1) * W + x0] + integral[y0 * W + x0];
      const v = gray[y * width + x];
      if (v * count < s * (1 - t) && v < hardWhite) bin[y * width + x] = 1;
    }
  }
  return bin;
}

/**
 * Gán nhãn thành phần liên thông (union-find hai lượt).
 * Trả về { labels: Int32Array (0 = không thuộc), comps: [{id,x0,y0,x1,y1,area}] }
 */
export function connectedComponents(mask, width, height, { conn8 = true, value = 1 } = {}) {
  const labels = new Int32Array(width * height);
  const parent = [0];
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
  };
  let next = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] !== value) continue;
      const nb = [];
      if (x > 0 && labels[i - 1]) nb.push(labels[i - 1]);
      if (y > 0) {
        const up = i - width;
        if (labels[up]) nb.push(labels[up]);
        if (conn8) {
          if (x > 0 && labels[up - 1]) nb.push(labels[up - 1]);
          if (x < width - 1 && labels[up + 1]) nb.push(labels[up + 1]);
        }
      }
      if (!nb.length) {
        parent.push(next);
        labels[i] = next++;
      } else {
        let m = nb[0];
        for (let k = 1; k < nb.length; k++) if (nb[k] < m) m = nb[k];
        labels[i] = m;
        for (const l of nb) union(m, l);
      }
    }
  }
  // Chuẩn hóa nhãn về 1..K
  const remap = new Int32Array(next);
  let k = 0;
  for (let l = 1; l < next; l++) {
    const r = find(l);
    if (!remap[r]) remap[r] = ++k;
    remap[l] = remap[r];
  }
  const comps = new Array(k);
  for (let c = 0; c < k; c++) comps[c] = { id: c + 1, x0: width, y0: height, x1: -1, y1: -1, area: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!labels[i]) continue;
      const l = remap[labels[i]];
      labels[i] = l;
      const c = comps[l - 1];
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
    }
  }
  return { labels, comps };
}

/**
 * Tìm các đoạn mực dài theo một hướng (tương đương phép mở hình thái học
 * với nhân dạng đường thẳng). Cho phép khe hở nhỏ maxGap.
 * dir = 'h' (ngang) | 'v' (dọc). Trả về mặt nạ Uint8Array.
 */
export function lineMask(bin, width, height, dir, minLen, maxGap = 2) {
  const out = new Uint8Array(width * height);
  const horiz = dir === 'h';
  const outer = horiz ? height : width;
  const inner = horiz ? width : height;
  const idx = horiz ? (o, p) => o * width + p : (o, p) => p * width + o;
  for (let o = 0; o < outer; o++) {
    let start = -1, last = -1;
    const flush = () => {
      if (start >= 0 && last - start + 1 >= minLen) {
        for (let p = start; p <= last; p++) out[idx(o, p)] = 1;
      }
    };
    for (let p = 0; p < inner; p++) {
      if (bin[idx(o, p)]) {
        if (start < 0) start = p;
        else if (p - last - 1 > maxGap) { flush(); start = p; }
        last = p;
      }
    }
    flush();
  }
  return out;
}

/**
 * Chuyển mặt nạ đường thẳng thành danh sách đoạn thẳng.
 * Ngang: {x0,x1,y (tâm), y0,y1, t (độ dày)}; Dọc: {y0,y1,x, x0,x1, t}
 */
export function lineSegments(mask, width, height, dir, maxThickness) {
  const { comps } = connectedComponents(mask, width, height);
  const segs = [];
  for (const c of comps) {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    if (dir === 'h') {
      const t = c.area / w;
      if (t > maxThickness) continue;
      segs.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, y: (c.y0 + c.y1) / 2, t });
    } else {
      const t = c.area / h;
      if (t > maxThickness) continue;
      segs.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, x: (c.x0 + c.x1) / 2, t });
    }
  }
  return segs;
}

/** Giãn nở vuông bán kính r (tách thành hai lượt 1 chiều) */
export function dilate(mask, width, height, r) {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let last = -1e9;
    const row = y * width;
    // quét trái -> phải và phải -> trái
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) last = x;
      if (x - last <= r) tmp[row + x] = 1;
    }
    last = 1e9;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[row + x]) last = x;
      if (last - x <= r) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let last = -1e9;
    for (let y = 0; y < height; y++) {
      if (tmp[y * width + x]) last = y;
      if (y - last <= r) out[y * width + x] = 1;
    }
    last = 1e9;
    for (let y = height - 1; y >= 0; y--) {
      if (tmp[y * width + x]) last = y;
      if (last - y <= r) out[y * width + x] = 1;
    }
  }
  return out;
}

/** Gom các giá trị số gần nhau (sai lệch <= tol) thành cụm, trả về tâm cụm */
export function cluster1D(values, tol) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g.max <= tol) { g.sum += v; g.n++; g.max = v; }
    else groups.push({ sum: v, n: 1, max: v });
  }
  return groups.map((g) => g.sum / g.n);
}

/**
 * Ước lượng góc nghiêng (độ) bằng phương pháp chiếu hàng: góc làm phương
 * sai tổng hàng lớn nhất. Làm trên ảnh đã thu nhỏ để nhanh.
 */
export function estimateSkew(bin, width, height, { maxAngle = 6, step = 0.2 } = {}) {
  // Lấy các điểm mực (lấy mẫu để giới hạn chi phí)
  const pts = [];
  const stride = Math.max(1, Math.round(Math.sqrt((width * height) / 250000)));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (bin[y * width + x]) pts.push(x, y);
    }
  }
  if (pts.length < 200) return 0;
  const bins = height + width;
  let bestAngle = 0, bestScore = -1;
  const hist = new Float64Array(bins * 2);
  for (let a = -maxAngle; a <= maxAngle + 1e-9; a += step) {
    const rad = (a * Math.PI) / 180;
    const s = Math.sin(rad), c = Math.cos(rad);
    hist.fill(0);
    for (let i = 0; i < pts.length; i += 2) {
      const yr = Math.round(pts[i + 1] * c - pts[i] * s) + bins;
      hist[yr]++;
    }
    let score = 0;
    for (let i = 1; i < hist.length; i++) {
      const d = hist[i] - hist[i - 1];
      score += d * d;
    }
    if (score > bestScore) { bestScore = score; bestAngle = a; }
  }
  return Math.abs(bestAngle) < step ? 0 : bestAngle;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
