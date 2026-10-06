import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { Blob } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetch, FormData, Agent } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const PORT = Number(process.env.PORT || 3000);
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;           // first chunk
const N8N_WEBHOOK_URL_NEXT = process.env.N8N_WEBHOOK_URL_NEXT; // every later chunk (adds the last frame image)
const RETRIES = Number(process.env.N8N_RETRIES || 2);
const KEEP_AUDIO = process.env.KEEP_AUDIO === 'true';
const KEEP_FILES = process.env.KEEP_FILES === 'true';
// Each chunk (except the first) starts with the last OVERLAP_FRAMES frames of the previous chunk.
const OVERLAP_FRAMES = Number(process.env.OVERLAP_FRAMES ?? 5);
const FINAL_CRF = String(process.env.FINAL_CRF ?? 14); // quality of the final combined video (lower = better)
if (!Number.isInteger(OVERLAP_FRAMES) || OVERLAP_FRAMES < 0) throw new Error('OVERLAP_FRAMES must be a whole number, 0 or more.');

const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
const FFMPEG = process.env.FFMPEG_PATH || path.join(__dirname, 'bin', exe('ffmpeg'));
const FFPROBE = process.env.FFPROBE_PATH || path.join(__dirname, 'bin', exe('ffprobe'));
const WORK_DIR = path.join(__dirname, 'work');
const OUTPUT_DIR = path.join(__dirname, 'output');

// ComfyUI jobs can run for a long time; undici's default 5-minute header timeout would abort them.
const longAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// ---------- helpers ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-3000)));
    p.on('error', (e) => reject(new Error(`Cannot run ${cmd}: ${e.message}`)));
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exited with ${code}: ${err}`))
    );
  });
}

const probe = (file, entries, stream) =>
  run(FFPROBE, ['-v', 'error', ...(stream ? ['-select_streams', stream] : []),
    '-show_entries', entries, '-of', 'csv=p=0', file]).then((s) => s.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- chunk length ----------
// The generation model (H3) only produces videos of 5 + 17k frames (5, 22, 39, 56, ...), k = 0, 1, 2...
// At `fps` frames per second a chunk can therefore only last (5 + 17k) / fps seconds.
// pickChunkSeconds() moves the requested length to the closest allowed one.
const validFrames = (x) => 5 + 17 * Math.max(0, Math.round((x - 5) / 17)); // nearest 5 + 17k to x

function pickChunkSeconds(requestedSeconds, fps) {
  const frames = validFrames(requestedSeconds * fps);
  return { frames, seconds: frames / fps };
}

// The overlap (OVERLAP_FRAMES source frames) in generated frames at `outFps`, rounded up. Both the
// split (to size the overlap) and the merge (to cut it) use this, so they always agree.
const dropFrames = (srcFps, outFps) =>
  OVERLAP_FRAMES > 0 ? Math.max(1, Math.ceil((OVERLAP_FRAMES / srcFps) * outFps - 1e-6)) : 0;

// ---------- ffmpeg split ----------
// Every chunk is exactly `chunkSeconds` long (rounded to whole frames) and is cut by frame number,
// so nothing depends on keyframes. Chunk N starts OVERLAP_FRAMES earlier than where chunk N-1 ended,
// i.e. it begins with the last OVERLAP_FRAMES frames of the previous chunk.
// The final chunk holds whatever is left, so it is usually shorter.
const frameCount = (file) =>
  run(FFPROBE, ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]).then((o) => parseInt(o.trim(), 10));

async function splitVideo(input, outDir, chunkSeconds, outFps, genFrames) {
  fs.mkdirSync(outDir, { recursive: true });
  const info = JSON.parse(await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=avg_frame_rate,nb_frames:format=duration', '-of', 'json', input]));
  const fpsRaw = info.streams?.[0]?.avg_frame_rate;
  const [num, den] = String(fpsRaw).split('/').map(Number);
  const fps = num / (den || 1);
  if (!fps || !isFinite(fps)) throw new Error('Could not read the video frame rate.');
  let total = parseInt(info.streams[0].nb_frames, 10);
  if (!total) total = Math.round(parseFloat(info.format.duration) * fps);

  const chunkFrames = Math.round(chunkSeconds * fps);
  // The generated videos have `outFps` frames per second, so the overlap can only be removed in whole
  // generated frames (m). The overlap is therefore widened to exactly m generated frames. That keeps the
  // merged video on the same timeline as the source, which matters because the original audio is laid
  // over it afterwards (an overlap that is not a whole number of frames would shift the picture
  // against the audio a little more at every join).
  const m = dropFrames(fps, outFps);
  if (m >= genFrames) throw new Error(`OVERLAP_FRAMES is too large: it needs ${m} of the ${genFrames} generated frames per chunk.`);
  const stride = m > 0 ? Math.round(((genFrames - m) * fps) / outFps) : chunkFrames;
  const overlap = chunkFrames - stride;
  if (stride < 1) throw new Error('Chunks are too short for the overlap. Increase Chunk seconds or lower OVERLAP_FRAMES.');

  const plan = [];
  for (let start = 0; ; start += stride) {
    const end = Math.min(start + chunkFrames, total);
    plan.push({ start, count: end - start });
    if (end >= total) break;
  }

  const files = [];
  for (const [i, c] of plan.entries()) {
    const out = path.join(outDir, `chunk_${String(i).padStart(4, '0')}.mp4`);
    const args = ['-y'];
    // Seek half a frame early so the first frame written is exactly frame `start`.
    if (c.start > 0) args.push('-ss', ((c.start - 0.5) / fps).toFixed(6));
    args.push('-i', input, '-map', '0:v:0');
    if (KEEP_AUDIO) args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k');
    else args.push('-an');
    args.push(
      // After the early seek the first frame sits slightly after t=0; without this, cfr would
      // insert a duplicate frame at the start and shift the whole chunk by one frame.
      '-vf', 'setpts=PTS-STARTPTS',
      '-t', ((c.count - 0.5) / fps).toFixed(6), // keeps exactly c.count frames
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p',
      '-fps_mode', 'cfr', '-r', String(fpsRaw),
      '-movflags', '+faststart', out
    );
    await run(FFMPEG, args);

    const n = await frameCount(out);
    if (i < plan.length - 1 && n !== c.count) {
      throw new Error(`${path.basename(out)} has ${n} frames, expected ${c.count}.`);
    }
    files.push(out);
  }
  return { files, counts: plan.map((c) => c.count), fps, overlap };
}

// ---------- jobs ----------
const jobs = new Map();

async function fileBlob(file, type) {
  return new Blob([await fs.promises.readFile(file)], { type });
}

// A bad response shape would just repeat if we re-ran the ComfyUI job, so don't retry it.
const noRetry = (e) => Object.assign(e, { noRetry: true });

// "H3-Uncrop_00034-audio.mp4" -> 34
function videoNumber(p) {
  const name = path.basename(p.replace(/\\/g, '/'));
  const m = name.match(/_(\d+)-audio\.[A-Za-z0-9]+$/) || name.match(/(\d+)-audio\.[A-Za-z0-9]+$/);
  return m ? parseInt(m[1], 10) : null;
}

// Joins the generated videos in the given order.
// The generated videos run at `outFps` (the "Frames" field on the page), which is lower than the
// source frame rate `srcFps`. The overlap at the start of each chunk is worth
//   drop = dropFrames(srcFps, outFps)
// generated frames, which are removed from the start of every video except the first.
// The audio of the generated videos is not used: the audio of the original upload is laid over the
// joined video instead, so there are no cuts at the joins. The result lasts as long as the shorter of
// the two. Video is re-encoded because cutting on an exact frame needs it.
// Returns a list of warnings.
async function combineVideos(paths, outFile, outFps, srcFps, original) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const warnings = [];

  const infos = [];
  for (const p of paths) {
    const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,avg_frame_rate', '-of', 'json', p]));
    const v = j.streams.find((st) => st.codec_type === 'video');
    if (!v) throw new Error(`No video stream in ${p}`);
    const [num, den] = v.avg_frame_rate.split('/').map(Number);
    infos.push({ rate: v.avg_frame_rate, fps: num / (den || 1), audio: j.streams.some((st) => st.codec_type === 'audio') });
  }

  const originalAudio = (await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', original])).trim() !== '';
  // Without audio in the original, fall back to joining the audio of the generated videos.
  const genAudio = !originalAudio && infos.every((i) => i.audio);
  if (!originalAudio && infos.some((i) => i.audio) && !genAudio) {
    throw new Error('Some generated videos have audio and some do not.');
  }
  if (genAudio) warnings.push('The original video has no audio, so the audio of the generated videos was used.');

  const drop = dropFrames(srcFps, outFps);

  const parts = [];
  const labels = [];
  infos.forEach((info, i) => {
    const cut = i > 0 && drop > 0;
    parts.push(`[${i}:v]${cut ? `trim=start_frame=${drop},` : ''}setpts=PTS-STARTPTS[v${i}]`);
    if (genAudio) {
      // Cut the same amount of time from the audio as the dropped frames last in this video.
      const t = (drop / info.fps).toFixed(6);
      parts.push(`[${i}:a]${cut ? `atrim=start=${t},` : ''}asetpts=PTS-STARTPTS[a${i}]`);
    }
    labels.push(`[v${i}]${genAudio ? `[a${i}]` : ''}`);
  });
  parts.push(`${labels.join('')}concat=n=${paths.length}:v=1:a=${genAudio ? 1 : 0}[v]${genAudio ? '[a]' : ''}`);
  if (originalAudio) parts.push(`[${paths.length}:a:0]asetpts=PTS-STARTPTS[ao]`);

  const rate = infos[0].rate;
  await run(FFMPEG, [
    '-y', ...paths.flatMap((p) => ['-i', p]), ...(originalAudio ? ['-i', original] : []),
    '-filter_complex', parts.join(';'),
    '-map', '[v]', ...(originalAudio ? ['-map', '[ao]'] : genAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', FINAL_CRF, '-pix_fmt', 'yuv420p',
    ...(rate && rate !== '0/0' ? ['-fps_mode', 'cfr', '-r', rate] : []),
    ...(originalAudio || genAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    ...(originalAudio ? ['-shortest'] : []),
    '-movflags', '+faststart', outFile,
  ]);
  return warnings;
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// Sends one chunk. The first chunk goes to the first webhook; every later chunk goes to the second
// webhook with the same fields plus `lastframe`, the image of the last frame of the previous result.
// Returns { filepath, lastframe } from n8n's JSON response.
async function sendChunk(job, index, chunkPath, inputs, prevLastFrame) {
  const fd = new FormData();
  fd.append('jobId', job.id);
  fd.append('chunkIndex', String(index));
  fd.append('totalChunks', String(job.total));
  fd.append('width', String(inputs.width));
  fd.append('height', String(inputs.height));
  fd.append('frames', String(inputs.frames));
  fd.append('grow_spatial', String(inputs.grow_spatial));
  fd.append('grow_temporal', String(inputs.grow_temporal));
  fd.append('image1', await fileBlob(inputs.image1.path, inputs.image1.mimetype), inputs.image1.originalname);
  fd.append('image2', await fileBlob(inputs.image2.path, inputs.image2.mimetype), inputs.image2.originalname);
  fd.append('video', await fileBlob(chunkPath, 'video/mp4'), path.basename(chunkPath));
  if (index > 0) {
    const type = IMAGE_TYPES[path.extname(prevLastFrame).toLowerCase()] || 'application/octet-stream';
    fd.append('lastframe', await fileBlob(prevLastFrame, type), path.basename(prevLastFrame.replace(/\\/g, '/')));
  }

  // n8n only answers once ComfyUI has finished, so this call blocks until the generated video is back.
  const url = index === 0 ? N8N_WEBHOOK_URL : N8N_WEBHOOK_URL_NEXT;
  const res = await fetch(url, { method: 'POST', body: fd, dispatcher: longAgent });
  if (!res.ok) throw new Error(`n8n responded ${res.status}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw noRetry(new Error(`n8n did not return JSON: ${text.slice(0, 200)}`));
  }
  const item = Array.isArray(data) ? data[0] : data; // n8n may wrap the result in an array
  const filepath = item?.filepath ?? item?.filePath ?? item?.json?.filepath;
  if (typeof filepath !== 'string' || !filepath.trim()) {
    throw noRetry(new Error(`n8n response has no "filepath": ${text.slice(0, 200)}`));
  }
  // The next chunk needs this image, so check it now rather than after another ComfyUI run.
  let lastframe = item?.lastframe ?? item?.lastFrame ?? item?.json?.lastframe;
  if (index < job.total - 1) {
    if (typeof lastframe !== 'string' || !lastframe.trim()) {
      throw noRetry(new Error(`n8n response has no "lastframe": ${text.slice(0, 200)}`));
    }
    lastframe = lastframe.trim();
    if (!fs.existsSync(lastframe)) {
      throw noRetry(new Error(`Last frame image not found on this machine: ${lastframe}`));
    }
  }
  return { filepath: filepath.trim(), lastframe };
}

async function processJob(job, dir, inputs) {
  try {
    job.status = 'splitting';
    const pick = pickChunkSeconds(inputs.chunkSeconds, inputs.frames);
    job.note = `Chunk length: ${pick.seconds.toFixed(2)} s (${pick.frames} generated frames at ${inputs.frames} fps)`;
    const { files: chunks, counts, fps: srcFps, overlap } = await splitVideo(
      inputs.video.path, path.join(dir, 'chunks'), pick.seconds, inputs.frames, pick.frames);
    job.note += `, overlap: ${overlap} source frames`;
    job.total = chunks.length;
    job.chunks = chunks.map(() => 'queued');
    const results = []; // generated video path returned by n8n for each chunk
    let lastFrame = null; // last frame image from the previous chunk's result

    job.status = 'processing';
    // One chunk at a time: the next request is only sent after n8n has returned the
    // generated video for the previous one.
    for (let i = 0; i < chunks.length; i++) {
      job.chunks[i] = 'running';
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await sendChunk(job, i, chunks[i], inputs, lastFrame);
          results[i] = r.filepath;
          lastFrame = r.lastframe;
          job.chunks[i] = 'done';
          job.done++;
          break;
        } catch (e) {
          if (attempt >= RETRIES || e.noRetry) {
            job.chunks[i] = 'failed';
            throw new Error(`Chunk ${i + 1}: ${e.message}`);
          }
          await sleep(3000 * (attempt + 1));
        }
      }
    }

    // All chunks done: order the generated videos by the number in their file names and join them.
    job.status = 'combining';
    const videos = results.map((filepath, chunk) => ({ chunk, filepath, number: videoNumber(filepath) }));
    const unnumbered = videos.filter((v) => v.number === null);
    if (unnumbered.length) {
      throw new Error(`No video number found in: ${unnumbered.map((v) => v.filepath).join(', ')}`);
    }
    const missing = videos.filter((v) => !fs.existsSync(v.filepath));
    if (missing.length) {
      throw new Error(`Generated video not found on this machine: ${missing.map((v) => v.filepath).join(', ')}`);
    }
    videos.sort((a, b) => a.number - b.number);
    if (new Set(videos.map((v) => v.number)).size !== videos.length) {
      throw new Error('Two generated videos have the same number.');
    }
    // Sanity checks that explain a visible seam: the overlap only lines up if the order is right
    // and ComfyUI returned the same number of frames it was given.
    if (videos.some((v, i) => v.chunk !== i)) {
      job.warnings.push('File numbers are not in chunk order; videos were joined in file-number order.');
    }
    // A chunk lasts (frames sent / source fps) seconds, and the generated video runs at `inputs.frames` fps,
    // so it needs about seconds x fps frames, which the model rounds to the nearest 5 + 17k.
    const outFps = inputs.frames;
    for (const v of videos) {
      const n = await frameCount(v.filepath);
      const seconds = counts[v.chunk] / srcFps;
      const expected = validFrames(seconds * outFps);
      if (Math.abs(n - expected) > 1) {
        job.warnings.push(`Chunk ${v.chunk + 1}: ${seconds.toFixed(2)} s at ${outFps} fps should come back as ${expected} frames (nearest 5 + 17k), but ${path.basename(v.filepath)} has ${n}. The overlap may not line up exactly.`);
      }
    }
    const outFile = path.join(OUTPUT_DIR, job.id, 'combined.mp4');
    job.warnings.push(...(await combineVideos(videos.map((v) => v.filepath), outFile, outFps, srcFps, inputs.video.path)));
    job.output = outFile;

    job.status = 'completed';
    if (!KEEP_FILES) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    console.error(`[job ${job.id}]`, e);
  }
}

// ---------- http ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(WORK_DIR, req.jobId, 'in');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${file.fieldname}${path.extname(file.originalname)}`),
});
const upload = multer({ storage }).fields([
  { name: 'image1', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
  { name: 'video', maxCount: 1 },
]);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/jobs', (req, res, next) => { req.jobId = crypto.randomUUID(); next(); }, upload, (req, res) => {
  const dir = path.join(WORK_DIR, req.jobId);
  const fail = (msg) => {
    fs.rmSync(dir, { recursive: true, force: true });
    return res.status(400).json({ error: msg });
  };

  if (!N8N_WEBHOOK_URL) return fail('N8N_WEBHOOK_URL is not set on the server.');
  if (!N8N_WEBHOOK_URL_NEXT) return fail('N8N_WEBHOOK_URL_NEXT is not set on the server.');
  const f = req.files || {};
  if (!f.image1?.[0] || !f.image2?.[0] || !f.video?.[0]) return fail('Image 1, image 2 and a video are required.');
  const width = Number(req.body.width);
  const height = Number(req.body.height);
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384)) {
    return fail('Width and height must be whole numbers greater than 0.');
  }
  const chunkSeconds = Number(String(req.body.chunk_seconds ?? '').trim() || 5);
  if (!(chunkSeconds > 0 && chunkSeconds <= 600)) return fail('Chunk seconds must be a number greater than 0.');
  // Empty fields fall back to the defaults.
  const intField = (name, def, min) => {
    const raw = String(req.body[name] ?? '').trim();
    const n = raw === '' ? def : Number(raw);
    return Number.isInteger(n) && n >= min ? n : null;
  };
  const frames = intField('frames', 20, 1);
  const grow_spatial = intField('grow_spatial', 36, 0);
  const grow_temporal = intField('grow_temporal', 1, 0);
  if (frames === null) return fail('Frames must be a whole number of at least 1.');
  if (grow_spatial === null) return fail('Grow spatial must be a whole number of 0 or more.');
  if (grow_temporal === null) return fail('Grow temporal must be a whole number of 0 or more.');

  const job = { id: req.jobId, status: 'splitting', total: 0, done: 0, chunks: [], error: null, output: null, note: null, warnings: [] };
  jobs.set(job.id, job);
  res.status(202).json({ jobId: job.id });

  processJob(job, dir, { image1: f.image1[0], image2: f.image2[0], video: f.video[0], width, height, chunkSeconds, frames, grow_spatial, grow_temporal });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  console.log(`ffmpeg: ${FFMPEG}${fs.existsSync(FFMPEG) ? '' : '  (NOT FOUND - see README)'}`);
});
