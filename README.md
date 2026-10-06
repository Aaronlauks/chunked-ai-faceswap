# Video chunk runner

Upload 2 images + 1 video + width/height. The server splits the video into chunks with ffmpeg and sends one request per chunk to an n8n webhook. n8n runs each request as a ComfyUI job. The page only shows progress and a final "all jobs completed".

## Setup

1. Install Node.js 20 or newer.
2. Download a portable (static) ffmpeg build and put **both** `ffmpeg` and `ffprobe` in the `bin/` folder:
   - Windows: the "essentials" build from gyan.dev, or the BtbN builds on GitHub (copy `ffmpeg.exe` and `ffprobe.exe` out of the `bin` folder inside the zip)
   - Linux: the static build from johnvansickle.com
   - macOS: static builds from evermeet.cx
   Use ffmpeg 5.1 or newer. Alternatively set `FFMPEG_PATH` / `FFPROBE_PATH` in `.env`.
3. `npm install`
4. Copy `.env.example` to `.env` and set `N8N_WEBHOOK_URL` and `N8N_WEBHOOK_URL_NEXT`.
5. `npm start`, then open http://localhost:3000

## n8n workflows

You need two Webhook workflows. Set both Production URLs in `.env`.

1. **First chunk** (`N8N_WEBHOOK_URL`): Webhook node, method `POST`, **Respond** = `Using 'Respond to Webhook' Node`.
2. **Every later chunk** (`N8N_WEBHOOK_URL_NEXT`): same setup, but it also receives the last frame of the previous result.

Both receive multipart form data with these fields:
- binary: `image1`, `image2`, `video` (the chunk, mp4)
- text: `width`, `height`, `frames` (default 20), `grow_spatial` (default 36), `grow_temporal` (default 1), `jobId`, `chunkIndex` (0-based), `totalChunks`
- second webhook only, binary: `lastframe` (image of the last frame of the previous chunk's generated video)

Each workflow runs ComfyUI and ends with a **Respond to Webhook** node answering with JSON:

```json
{
  "filepath": "C:/ComfyUI/output/H3-Uncrop_00034-audio.mp4",
  "lastframe": "C:/ComfyUI/output/last_frame_00034.png"
}
```

(Either may be wrapped in an array, as n8n often does.) `lastframe` is needed for every chunk except the last one. A response without the needed values, or with a path that doesn't exist on this machine, stops the job without re-running that chunk. Both paths must be readable from the machine running this app.

The app counts a chunk as done when n8n answers with a 2xx response, so n8n must answer *after* ComfyUI finishes. Chunks are sent strictly one at a time: the app waits (no timeout) for n8n's response before it sends the next chunk to the second webhook. A failed request is retried twice, then the job stops.

## How the video is split (chunk length and 5-frame overlap)

**Chunk length.** The generation model only produces videos of `5 + 17k` frames (5, 22, 39, 56, ... for k = 0, 1, 2, ...). At the **Frames** (fps) you enter, a chunk can therefore only last `(5 + 17k) / fps` seconds. The **Chunk seconds** field is the length you would like; the server moves it to the closest allowed value and shows the result on the page. It is only used by the server and is not sent to n8n. For example 5 s at 4 fps becomes k = 1: 22 frames = 5.5 s. 5 s at 20 fps becomes k = 6: 107 frames = 5.35 s.

Chunks are cut by frame number, so each one is exactly that long (rounded to whole source frames: 165 frames at 30 fps for 5.5 s). Every chunk after the first starts with the end of the previous chunk. The overlap is at least `OVERLAP_FRAMES` (default 5) source frames, rounded up to a whole number of *generated* frames (see below), so a new chunk starts every chunk length minus that overlap. The page shows the overlap that was used. Each chunk's frame count is checked with ffprobe. The last chunk holds whatever is left, so it is usually shorter.

- Chunks are video-only by default. Set `KEEP_AUDIO=true` to include the first audio track.
- Variable-frame-rate sources are converted to constant frame rate.

## Combining the results

After the last chunk finishes, the app orders the returned files by the number in the file name (in `H3-Uncrop_00034-audio.mp4` the video number is 34) and joins them into `output/<jobId>/combined.mp4`. The page shows that path when it is done.

The generated videos run at a lower frame rate than the source. The **Frames** field on the page is the frame rate (fps) of the generated videos, so each chunk comes back with fewer frames than were sent. Everything is calculated from the chunk's length in seconds (`frames sent / source fps`):

- Frames to expect from a chunk: `seconds x Frames`, moved to the nearest `5 + 17k`. A full chunk comes back with exactly the frame count chosen above (for example 22). A shorter last chunk is rounded the same way, so a 2 s tail at 4 fps (8 frames) comes back as 5 frames. The page shows a warning if a generated video is more than 1 frame away from the expected count.
- Frames to remove at the start of every video except the first: `ceil(OVERLAP_FRAMES / source fps x Frames)`, at least 1. For example 5 overlap frames from a 30 fps source with Frames = 4 is `ceil(5 / 30 x 4)` = 1 generated frame. Because only whole generated frames can be removed, the split widens the overlap to exactly that many generated frames (1 frame at 4 fps = 7.5 source frames, so 8 source frames), and the next chunk starts exactly that much earlier. This keeps the joined video on the same timeline as the source, so it stays in step with the original audio.

**Audio.** The audio generated by the workflow is not used. The audio of the original upload is laid over the joined video, so there are no cuts at the joins. The result lasts as long as the shorter of the two (the generated video can end a little earlier or later than the source because the model rounds each chunk to `5 + 17k` frames). If the original has no audio, the audio of the generated videos is joined instead and the page shows a warning.

Because frames must be cut exactly, the combined video is re-encoded once (x264, quality set by `FINAL_CRF`; audio as AAC 192k). The job fails with a clear message if a path has no number, a file is missing, or two files share a number.

## If the joins are visible

- **Jump or stutter at a join:** check the warnings on the page. A generated video whose frame count does not match the expected count shifts the overlap.
- **Overlap larger than you asked for:** the overlap is rounded up to whole generated frames. At 30 fps source and Frames = 4, one generated frame is 7.5 source frames, so `OVERLAP_FRAMES=5` gives 1 generated frame (about 8 source frames). Raise `OVERLAP_FRAMES` (for example 15 gives 2 generated frames) to share more frames between chunks.
- **Flicker or a change in look at a join:** raise `OVERLAP_FRAMES` (for example 8 to 16) so the workflow gets more shared context, and use a fixed seed for every chunk in the workflow.
- **Soft or blocky video overall:** lower `FINAL_CRF` (for example 12).
