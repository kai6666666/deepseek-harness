/**
 * 素材处理引擎 —— 把用户导入的「任何东西」变成可用的透明 webm。
 *
 * ## 支持的输入
 *
 * | 输入 | 处理方式 |
 * |---|---|
 * | 视频（mp4/mov/webm/mkv…） | 逐帧解码 → 自动抠背景（如需要）→ 重编码 |
 * | GIF | 拆帧 → 自动抠背景（如需要） |
 * | PNG/JPG 序列 | 直接读帧 → 自动抠背景（如需要） |
 *
 * ## 为什么要自动抠背景
 *
 * 用户手上的素材绝大多数是**有背景**的：AI 生成的白底图、剪映导出的 mp4。
 * 要求用户自己先抠图是最大的门槛。所以引擎会：
 *
 * 1. 取画面四角像素，判断是不是纯色背景
 * 2. 是 → 把接近该颜色的像素变透明（带容差与边缘羽化）
 * 3. 不是（已经透明，或背景复杂）→ 原样保留
 *
 * ## 为什么能输出透明 webm
 *
 * Chrome 的 `MediaRecorder` 在录制 canvas 时会保留 alpha：
 * canvas 的透明像素 → 编码后 `TAG:alpha_mode=1`。
 * （Firefox / Safari 不支持，所以工作台会检测并提示用 Chrome。）
 *
 * 全部在浏览器本地完成，不上传任何数据。
 */
const PetEngine = (() => {

  // ── 状态 ────────────────────────────────────────────────────────────
  let frames = [];          // [{ bitmap: ImageBitmap, w, h, delay }]
  let sourceName = '';
  let sourceKind = '';      // 'video' | 'gif' | 'images'
  let bbox = null;          // 所有帧的并集包围盒 { x0, y0, x1, y1 }
  let warnings = [];
  let detectedBg = null;    // 检测到的背景色 [r,g,b]；null = 无需抠图
  let bgRemoved = false;    // 是否已执行过抠图

  // ── 工具 ────────────────────────────────────────────────────────────

  /** 读文件为 ImageBitmap。失败返回 null。 */
  async function loadBitmap(file) {
    try {
      return await createImageBitmap(file);
    } catch {
      return null;
    }
  }

  /** 按文件名里的数字自然排序（frame_2 要排在 frame_10 前面）。 */
  function naturalSort(a, b) {
    const num = (s) => {
      const m = s.match(/(\d+)(?!.*\d)/);
      return m ? parseInt(m[1], 10) : 0;
    };
    return num(a.name) - num(b.name) || a.name.localeCompare(b.name);
  }

  /** 把 video 元素 seek 到指定时间并等它画得出来。 */
  function seekTo(video, t) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.onseeked = null;
        resolve();
      };
      video.onseeked = finish;
      // ⚠️ 有些格式 seek 完不触发 `seeked`（尤其是末帧），必须兜底超时，
      //    否则整个导入会卡死在最后一帧。
      setTimeout(finish, 800);
      try { video.currentTime = t; } catch { finish(); }
    });
  }

  /** 解码 GIF 的所有帧（用 ImageDecoder，Chrome 支持）。 */
  async function decodeGif(file) {
    if (typeof ImageDecoder === 'undefined') return null;
    try {
      const data = await file.arrayBuffer();
      const dec = new ImageDecoder({ data, type: file.type || 'image/gif' });
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      const count = track.frameCount;
      const out = [];
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        const delay = (image.duration || 40000) / 1000;   // μs → ms
        out.push({ bitmap: image, w: image.displayWidth, h: image.displayHeight, delay });
      }
      return out;
    } catch {
      return null;
    }
  }

  // ── 背景检测与抠除 ──────────────────────────────────────────────────

  /**
   * 判断一帧是否有「纯色背景」需要抠。
   *
   * 判据：
   * 1. 四角若已透明 ⇒ 素材本来就有 alpha，不用抠
   * 2. 四角颜色必须彼此接近（否则是复杂背景）
   * 3. 与该颜色相近的像素占比 ≥ 25%（否则可能整屏都是角色）
   *
   * @returns {[number,number,number]|null} 背景色，或 null（无需抠）
   */
  function detectBackground(data, w, h) {
    const sample = (x, y) => {
      const o = (y * w + x) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    };

    const corners = [
      sample(2, 2), sample(w - 3, 2), sample(2, h - 3), sample(w - 3, h - 3),
    ];

    // ① 已经是透明背景
    const transparentCorners = corners.filter(c => c[3] < 40).length;
    if (transparentCorners >= 3) return null;

    // ② 四角颜色必须接近
    const base = corners[0];
    const close = corners.every(c =>
      Math.abs(c[0] - base[0]) + Math.abs(c[1] - base[1]) + Math.abs(c[2] - base[2]) < 60
    );
    if (!close) return null;

    // ③ 背景占比
    let similar = 0;
    let sampled = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const o = (y * w + x) * 4;
        const d = Math.abs(data[o] - base[0])
                + Math.abs(data[o + 1] - base[1])
                + Math.abs(data[o + 2] - base[2]);
        if (d < 60) similar++;
        sampled++;
      }
    }
    if (sampled === 0) return null;
    if (similar / sampled < 0.25) return null;

    return [base[0], base[1], base[2]];
  }

  /**
   * 把接近背景色的像素变透明。
   *
   * ## 容差与羽化
   *
   * - 距离 ≤ `tolerance` ⇒ 全透明
   * - `tolerance` ~ `tolerance+feather` ⇒ 线性过渡（避免锯齿硬边）
   *
   * ⚠️ **不能只做「等于背景色 → 透明」**：视频有压缩噪点，
   *    严格相等几乎命中不了几个像素，结果是背景纹丝不动。
   *
   * ⚠️ 用**欧氏距离**而不是曼哈顿距离：后者对深色背景会误伤太多。
   */
  function removeBackground(data, w, h, bg, tolerance = 42, feather = 30) {
    const [br, bgc, bb] = bg;
    let removed = 0;
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - br;
      const dg = data[i + 1] - bgc;
      const db = data[i + 2] - bb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);

      if (dist <= tolerance) {
        data[i + 3] = 0;
        removed++;
      } else if (dist < tolerance + feather) {
        const t = (dist - tolerance) / feather;
        data[i + 3] = Math.round(data[i + 3] * t);
      }
    }
    return removed;
  }

  /**
   * 对全部帧执行抠背景。
   *
   * 用**第一帧**检测背景色（视频里背景通常不变），然后套用到所有帧。
   */
  async function applyBgRemoval() {
    if (frames.length === 0) return;

    const W = frames[0].w, H = frames[0].h;
    const cv = new OffscreenCanvas(W, H);
    const ctx = cv.getContext('2d', { willReadFrequently: true });

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(frames[0].bitmap, 0, 0, W, H);
    const first = ctx.getImageData(0, 0, W, H);
    const bg = detectBackground(first.data, W, H);

    if (!bg) return;   // 已透明，或背景太复杂

    detectedBg = bg;
    bgRemoved = true;

    for (let k = 0; k < frames.length; k++) {
      const fr = frames[k];
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(fr.bitmap, 0, 0, W, H);
      const img = ctx.getImageData(0, 0, W, H);
      removeBackground(img.data, W, H, bg);
      ctx.putImageData(img, 0, 0);

      // ⚠️ 必须换回 ImageBitmap：直接留着被 putImageData 污染的 canvas
      //   会在下一轮被 clearRect 覆盖，等于白抠。
      fr.bitmap = await createImageBitmap(cv);
    }
  }

  // ── 导入 ────────────────────────────────────────────────────────────

  /**
   * 导入文件（视频 / GIF / 图片序列都行）。
   *
   * @param {FileList|File[]} fileList
   * @param {object} opt
   * @param {boolean} opt.autoBg 是否自动抠背景（默认 true）
   * @param {number}  opt.fps    视频抽帧帧率（默认 24，上限 30）
   */
  async function importFiles(fileList, opt = {}) {
    const autoBg = opt.autoBg !== false;
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return { ok: false, message: '没有文件', count: 0, kind: '' };
    }

    frames = [];
    warnings = [];
    bbox = null;
    detectedBg = null;
    bgRemoved = false;

    // ── 情况 1：视频（用户最可能的输入）──────────────────────────
    const videoFile = files.find(f =>
      /^video\//.test(f.type) || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name)
    );
    if (videoFile) {
      sourceKind = 'video';
      sourceName = videoFile.name;
      return await importVideo(videoFile, autoBg, opt.fps);
    }

    // ── 情况 2：单个 GIF ──────────────────────────────────────────
    if (files.length === 1 && /\.gif$/i.test(files[0].name)) {
      const gifFrames = await decodeGif(files[0]);
      if (gifFrames && gifFrames.length > 0) {
        frames = gifFrames;
        sourceKind = 'gif';
        sourceName = files[0].name;
        if (autoBg) await applyBgRemoval();
        computeBBox();
        return {
          ok: true,
          message: `GIF 拆出 ${frames.length} 帧`,
          count: frames.length,
          kind: 'gif',
        };
      }
      warnings.push('这个浏览器解不了 GIF 动画，只取到第一帧。建议用 Chrome。');
    }

    // ── 情况 3：图片序列 ─────────────────────────────────────────
    const imgs = files.filter(f =>
      /\.(png|jpe?g|webp|bmp)$/i.test(f.name) || /^image\//.test(f.type)
    );
    if (imgs.length === 0) {
      return { ok: false, message: '不支持的文件类型', count: 0, kind: '' };
    }
    imgs.sort(naturalSort);
    for (const f of imgs) {
      const bmp = await loadBitmap(f);
      if (bmp) frames.push({ bitmap: bmp, w: bmp.width, h: bmp.height, delay: null });
    }
    if (frames.length === 0) {
      return { ok: false, message: '图片解码失败', count: 0, kind: '' };
    }
    sourceKind = 'images';
    sourceName = imgs.length === 1 ? imgs[0].name : `${imgs.length} 张图`;

    if (autoBg) await applyBgRemoval();
    computeBBox();
    return {
      ok: true,
      message: `已导入 ${frames.length} 帧`,
      count: frames.length,
      kind: 'images',
    };
  }

  /**
   * 从视频里抽帧。
   *
   * ⚠️ 用 `currentTime` seek 逐帧取，而不是边播边录：
   *   播放有掉帧，而 seek 能保证拿到的是**确定的**那一帧。
   */
  async function importVideo(file, autoBg, fpsOverride) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    try {
      await new Promise((res, rej) => {
        video.onloadedmetadata = res;
        video.onerror = () => rej(new Error('视频加载失败（格式不支持？）'));
        setTimeout(() => rej(new Error('视频加载超时')), 15000);
      });

      const W = video.videoWidth, H = video.videoHeight;
      if (!W || !H) throw new Error('读不到视频尺寸');

      const dur = video.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('读不到视频时长');

      const fps = Math.min(fpsOverride || 24, 30);
      let total = Math.round(dur * fps);

      // 上限 120 帧：再多会让内存和录制时间都失控
      const MAX_FRAMES = 120;
      if (total > MAX_FRAMES) {
        total = MAX_FRAMES;
        warnings.push(
          `视频较长（${dur.toFixed(1)}s），只抽了前 ${MAX_FRAMES} 帧` +
          `（约 ${(MAX_FRAMES / fps).toFixed(1)} 秒）`
        );
      }
      if (total < 1) total = 1;

      const cv = new OffscreenCanvas(W, H);
      const ctx = cv.getContext('2d', { willReadFrequently: true });

      for (let i = 0; i < total; i++) {
        await seekTo(video, i / fps);
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(video, 0, 0, W, H);
        const bmp = await createImageBitmap(cv);
        frames.push({ bitmap: bmp, w: W, h: H, delay: 1000 / fps });
      }

      if (autoBg) await applyBgRemoval();
      computeBBox();

      return {
        ok: true,
        message: `从视频抽出 ${frames.length} 帧（${W}×${H}，${dur.toFixed(1)}s）`,
        count: frames.length,
        kind: 'video',
      };
    } finally {
      video.src = '';
      URL.revokeObjectURL(url);
    }
  }

  // ── 包围盒 ──────────────────────────────────────────────────────────

  /**
   * 计算所有帧的**并集**包围盒（去掉透明空白）。
   *
   * ⚠️ 必须并集：逐帧各裁会让尺寸不一致，切换动作时角色跳。
   */
  function computeBBox(alphaThreshold = 8) {
    if (frames.length === 0) return null;

    const W = frames[0].w, H = frames[0].h;
    const cv = new OffscreenCanvas(W, H);
    const ctx = cv.getContext('2d', { willReadFrequently: true });

    let x0 = W, y0 = H, x1 = -1, y1 = -1;

    for (const fr of frames) {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(fr.bitmap, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;

      for (let y = 0; y < H; y++) {
        const row = y * W * 4;
        for (let x = 0; x < W; x++) {
          if (data[row + x * 4 + 3] > alphaThreshold) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
    }

    if (x1 < 0) {
      warnings.push('所有帧都是全透明的 —— 检查一下素材？');
      bbox = { x0: 0, y0: 0, x1: W - 1, y1: H - 1, W, H };
      return bbox;
    }

    bbox = { x0, y0, x1, y1, W, H };
    return bbox;
  }

  /** 当前状态摘要。 */
  function info() {
    return {
      frameCount: frames.length,
      width: frames[0]?.w ?? 0,
      height: frames[0]?.h ?? 0,
      sourceName,
      sourceKind,
      bbox,
      detectedBg,
      bgRemoved,
      warnings: [...warnings],
    };
  }

  // ── 渲染 ────────────────────────────────────────────────────────────

  function drawFrame(ctx, i, opt) {
    const fr = frames[i];
    if (!fr) return;

    const { crop, outW, outH } = opt;
    const box = crop && bbox
      ? { x: bbox.x0, y: bbox.y0, w: bbox.x1 - bbox.x0 + 1, h: bbox.y1 - bbox.y0 + 1 }
      : { x: 0, y: 0, w: fr.w, h: fr.h };

    ctx.clearRect(0, 0, outW, outH);
    ctx.drawImage(fr.bitmap, box.x, box.y, box.w, box.h, 0, 0, outW, outH);
  }

  // ── 导出 ────────────────────────────────────────────────────────────

  /**
   * 把全部帧录成透明 webm。
   *
   * 原理：canvas → `captureStream(fps)` → `MediaRecorder('vp9')`。
   * Chrome 保留 canvas 的 alpha，输出带 `alpha_mode=1`。
   *
   * ⚠️ **必须实时录制**：MediaRecorder 按 wall clock 采样，
   *    24 帧 @24fps 就是 1 秒真实时间，不能"瞬间"生成。
   */
  async function exportWebm(opt) {
    const { crop, fps, outW, outH, quality, onProgress } = opt;

    if (frames.length === 0) throw new Error('没有素材');
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('这个浏览器不支持 MediaRecorder，请用 Chrome / Edge');
    }
    const mime = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mime)) {
      throw new Error('这个浏览器不支持 VP9 编码，请用 Chrome / Edge');
    }

    const cv = document.createElement('canvas');
    cv.width = outW;
    cv.height = outH;
    const ctx = cv.getContext('2d', { alpha: true });

    const frameMs = frames.map(fr => (fr.delay && fr.delay > 10 ? fr.delay : 1000 / fps));
    const totalMs = frameMs.reduce((a, b) => a + b, 0);

    const stream = cv.captureStream(fps);
    const bitrate = Math.round((0.3 + quality * 3.7) * 1_000_000);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });

    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });

    drawFrame(ctx, 0, { crop, outW, outH });
    rec.start();

    const t0 = performance.now();
    let elapsed = 0;

    for (let i = 0; i < frames.length; i++) {
      drawFrame(ctx, i, { crop, outW, outH });
      if (onProgress) onProgress(Math.min(1, elapsed / totalMs));
      await new Promise(r => setTimeout(r, frameMs[i]));
      elapsed += frameMs[i];
    }

    await new Promise(r => setTimeout(r, 1000 / fps));
    rec.stop();
    await stopped;
    if (onProgress) onProgress(1);

    const blob = new Blob(chunks, { type: 'video/webm' });
    return { blob, size: blob.size, durationMs: performance.now() - t0 };
  }

  return {
    importFiles,
    computeBBox,
    info,
    drawFrame,
    exportWebm,
    get frames() { return frames; },
    get bbox() { return bbox; },
  };
})();
