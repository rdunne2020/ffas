# FFAS

A local FFmpeg editing workspace for video and audio. Upload a source, trim or split it into clips, arrange the clips, apply flips, and export the merged result.

## Run

Requirements: Node.js 22+ and FFmpeg / FFprobe on `PATH`. The FFmpeg build needs `libx264`, `libx265`, `libvpx-vp9`, `libopus`, `libmp3lame`, AAC, FLAC, and PCM encoders for all export formats. TypeScript and Node.js type definitions are development dependencies. The running application has no npm runtime dependencies. The app detects installed encoders and disables unavailable choices.

```sh
npm ci
npm start
```

Open http://localhost:3000. `npm start` builds the TypeScript sources before running the compiled server. Use `npm run dev` to watch TypeScript sources and restart the server after successful compilation; refresh the browser after frontend changes. HTML and CSS are served directly from `public/`.

Optional configuration:

```sh
PORT=3001 FFAS_DATA_DIR=/path/to/media-workspace npm start
```

The server binds to `127.0.0.1` by default. To listen on all IPv4 interfaces, run `HOST=0.0.0.0 npm start` and connect using this machine's IP address or hostname on port 3000. Use a trusted network: this first version does not implement accounts, multi-user isolation, a production job runner, storage quotas, or automatic file expiration. A public deployment should add those and run media processing in isolated workers with resource limits.

## Workflow

1. Upload or drop video / audio, up to 1 GB per file. Multiple files are accepted and appear in the media library.
2. Select a file. Scrub the timeline, drag its selection edges, enter exact start/end seconds, or set either edge at the playhead.
3. Use **Split at playhead** to divide the current clip. Remove the pieces you do not want, add another range, or reorder clips with **Earlier / Later**. Clips from the selected source merge in list order. Repeated or overlapping ranges are allowed. Each clip must be at least 0.04 seconds, with up to 32 clips per export.
4. Choose MP4, MKV, WebM, MP3, M4A, WAV, or FLAC. Choose H.264 (x264), H.265 / HEVC (x265), or VP9 where the container supports it. **Advanced encoding** exposes CRF or target video bitrate, encoder speed presets, frame rate, audio codec, and audio bitrate. Quality presets provide defaults; **Reset encoding overrides** restores those defaults. Video outputs support resolution caps, quality presets, horizontal/vertical flipping, and audio removal. Choosing an audio format from video extracts its audio. Resizing never intentionally upscales.
5. **Play selected clips** auditions cuts in the browser with flips applied. Browser seeking is approximate; **Render preview** runs the actual FFmpeg edit into a browser-friendly MP4 (up to 720p) or M4A. Previews cover the whole sequence, using H.264/AAC independently of your final export codec and rate-control settings.
6. **Export file** runs the chosen settings. Exports queue one at a time and can be cancelled. Play, download, or delete finished files below the editor. Use the delete button beside an uploaded file to remove its source; existing exports are kept. You can remove every clip from a sequence and add a new range before exporting.

If a source codec cannot play in your browser, its probed duration still supports editing and rendering a compatible preview. Final playback support also depends on the browser; every completed output can be downloaded.

For desktop playback with FFplay, download a result and run:

```sh
ffplay -autoexit /path/to/downloaded-file.mp4
```

FFplay is a native application, so the app uses browser playback rather than attempting to embed its desktop window.

## Storage and limits

Source files, results, and JSON metadata live in `.data/` (gitignored), or `FFAS_DATA_DIR`. Source files are never overwritten. Files and completed jobs survive restarts; unfinished jobs are marked failed. Editor selections are per-session and reset when switching sources; submitted jobs retain a snapshot of their settings.

Use the library and export delete buttons to remove files and their metadata permanently, after confirmation. Sources used by queued or running jobs cannot be deleted; cancel or finish those jobs first. Deleting an export also removes its history entry. Files are otherwise retained until manually removed. Stop the server before clearing its data directory. There is no automatic cleanup or disk quota yet. Limits: two concurrent uploads, eight active/queued jobs, one FFmpeg worker, a one-hour processing timeout, and a 24-hour source/output duration cap. Only the first video and audio tracks are used; subtitle and additional track export are not implemented. Splicing uses one source per export, not clips from multiple files.

Requests allow localhost hosts by default; network binding also allows the machine hostname and interface IP addresses. Same-origin browser checks remain enabled. Uploads stream to generated filenames, metadata is probed, and edits are validated. FFmpeg is invoked with argument arrays (no shell) and restricted input protocols/demuxers; playlists and external-resource inputs are not accepted. These are local-use safeguards, not a hardened sandbox for untrusted public uploads.

## Verification

```sh
npm run typecheck
npm test
```

`npm run typecheck` checks all application and test sources without emitting files. `npm test` builds and runs the compiled tests. You can also use `npm run build` to compile without starting the app. Keep the source tree alongside `dist/` when running the built server; it serves HTML/CSS from `public/` and retains data in the project-level `.data/`.

The integration suite generates its own short video/audio fixtures in a temporary directory. It exercises actual uploads and FFmpeg jobs, splice order and decoded-frame transforms, output duration, all seven export formats, x265 CRF and frame-rate settings, MKV with FLAC audio, bitrate control, deletion persistence and active-job deletion protection, silent video, muting, audio extraction, preview conversion, range requests, download headers, invalid edits, cross-origin rejection, cancellation, and restart persistence. Test media is deleted afterward.

Manual UI check: upload a short video, change the in/out points by dragging and keyboard arrows, split and remove a middle section, reorder the remaining clips, enable a flip, render a preview, export and download. Repeat with an audio file and a narrow browser window. Confirm the output duration matches the selected ranges and the app shows processing errors instead of a download when a job fails.

## Structure

- `server.ts`: HTTP routes, streaming uploads, durable local metadata, job queue, file streaming / byte ranges.
- `lib/media.ts`: FFprobe metadata, edit validation, and FFmpeg filter/codec arguments.
- `public/app.ts`: typed browser editor; HTML and CSS remain in `public/`.
- `shared/model.ts`: shared API contracts and runtime JSON validation.
- `shared/encoding.ts`: compatible codecs, encoding defaults, and advanced option validation.
- `public/webmcp.d.ts`: types for the optional browser agent API.
- `scripts/dev.ts`: development compiler and server watchers.
- `tsconfig.json`: strict TypeScript configuration, including checked indexed access.
- `dist/`: generated JavaScript; ignored by Git and never edited by hand.
- `test/media.test.ts`: real-media integration tests using Node's test runner.
- `test/model.test.ts`: malformed JSON rejection and saved-record compatibility checks.

Trimming resets timestamps and feeds clips through FFmpeg's concat filter. See the [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html) for `trim`, `atrim`, `setpts`, `asetpts`, and `concat`.

## Browser verification

Verified the local interface with a generated eight-second video: browser upload, exact numeric ranges, keyboard trimming, clip reordering, splitting/removal, horizontal flip, rendered-preview playback (verified three-second duration), and export submission. Inspected desktop and 390px-wide layouts. The generated demo source and outputs may be present in your local library.

After the TypeScript migration, verified that the compiled frontend loads the existing library and exports, edits two ranges, applies a flip, and plays a newly rendered three-second preview. Strict type checking and the migration tests passed; both `npm start` and the development watcher were smoke-tested.

The frontend also feature-detects optional WebMCP controls for reading workspace state, staging a clip sequence, and queuing an export. This browser did not expose a compatible registry, so those optional controls could not be exercised here; the normal interface does not depend on them.

Advanced encoding and deletion verification: all 19 tests pass, including real HEVC and MKV exports, compatible previews, invalid option rejection, and deletion without removing finished exports. Browser controls were checked for x265 selection, CRF overrides, encoder presets, and bitrate mode.
