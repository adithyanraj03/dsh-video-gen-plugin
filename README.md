# dsh-video-gen

Video generation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through the Ninfer LTX-2.5 API: text-to-video, image-to-video from a start frame, a clip that plays in the conversation, live progress, and cancel.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## What it does

| Surface | Behaviour |
| --- | --- |
| `generate_video` | Queues a clip. `prompt` is required; `seconds`, `size`, `orientation`, `fps`, `seed`, `enhance`, `negative_prompt` and `model` are optional. |
| Start frame | Pass `image_url`, `source_attachment_id` (an image already in the chat), or `source_path` (a file in the session workspace). That picture becomes the clip's **first frame**; the clip is rendered from it. |
| `check_video` | One job by id, or the recent list. Also adopts a job id this host never saw by asking the server. |
| `cancel_video` | Stops a queued or running render so the GPU frees up. |
| Tool card | The finished MP4 plays inline with native controls and seeks via `Range` requests; while rendering, the same card shows progress, stage, and queue position. |

Long renders do not hold the conversation: `generate_video` waits for `waitGraceMs` (default 2 minutes) and then returns the job id. Use `wait: "until_done"` to block for the whole render, or `wait: "none"` to return immediately.

## Requirements

- DeepSeek Harness 0.1.7-rc.2 or newer (`@deepseek-ai/dsh-*` peer generations 0.1.7).
- A Ninfer account with the LTX video engine loaded, and the bearer token stored in the harness credential store under `NINFER_API_KEY` (Settings → Plugins → Video generation, or the same credential the `ninfer` LLM provider already uses).
- A web profile: the clip card and the progress poll use the harness web server.

## Install

Local checkout (this repo):

```powershell
pnpm install
pnpm run build
```

Then link it into a profile and add it to that profile's bundles:

```powershell
# C:\Users\<you>\.dsh\profiles\web\package.json
#   "dependencies": { "dsh-video-gen": "link:B:/Research/dsh-video-gen" }
#   "dsh": { "profile": { "bundles": ["dsh-video-gen", ...] } }
pnpm install --dir C:\Users\<you>\.dsh\profiles\web
```

Restart the host afterwards: the tools register at boot. The browser half hot-reloads.

From a tarball or the registry, install the package instead of linking it — never both, or the same plugin boots twice.

## Settings

Every option lives under Settings → Plugins → Video generation. Defaults are sensible; the ones worth knowing:

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://ninfer.neronexusai.com/v1` | Video API root, including `/v1`. |
| `model` | `ltx-2.5` | Model id; `GET /v1/models` lists what the server has loaded. |
| `apiKeyRef` | `NINFER_API_KEY` | Credential reference the bearer token resolves through. |
| `defaultSeconds` / `defaultSize` / `defaultFps` | `5` / `720p` / `24` | Used when the call omits them. |
| `defaultEnhance` | `false` | Server-side prompt enhancer before rendering (adds 1–2 minutes). |
| `waitGraceMs` | `120000` | How long `generate_video` holds the turn. |
| `jobTimeoutMs` | `3600000` | Overall budget per job before it is abandoned. |
| `saveToWorkspace` / `workspaceFolder` | `true` / `videos` | Also copy finished clips into the session workspace. |
| `videosDir` | empty | Clip directory override; empty keeps `~/.dsh/plugins/video-gen/videos`. |
| `toolNameSet` | `generic` | `generic` registers `generate_video` / `check_video` / `cancel_video`; `ninfer` registers the `ninfer_*` variants. |

`toolNameSet` exists because tool names are global across plugins. The default verbs deliberately avoid `video_generate`, which `dsh-plugin-subscriptions` already registers for its Grok video tool — with both installed, `video_generate` would abort the boot. If another plugin ever owns one of these names, the boot fails with `tool "<name>" is already registered`; switching `toolNameSet` to `ninfer` and restarting fixes that without uninstalling anything.

## How a job runs

1. `POST /v1/videos` with the JSON body, or multipart when a start frame is attached (field `input_reference`, PNG/JPEG/WebP ≤ 20 MB). The response carries `status: queued` and a `video_<hex>` id.
2. The store polls `GET /v1/videos/{id}` every 3 s, backing off up to 30 s while the network or the server misbehaves. Polling survives a host restart: unfinished jobs are re-attached on boot and finished ones are downloaded then.
3. On `completed` the MP4 is streamed from `GET /v1/videos/{id}/content` (bounded by `maxVideoBytes`), written atomically, and the middle-frame JPEG is fetched from the same route with `?variant=thumbnail`.
4. A finished clip is copied into the session workspace exactly once, and every job record is kept in `jobs.json` next to the clips (last 50 by default).

The server renders one clip at a time per GPU and pauses LLM work for 30–60 s per job, so `queue_position` is worth watching. Rule of thumb for a warmed engine: 5 s @ 720p ≈ 20–45 s, 10 s @ 1080p ≈ 2 min, 60 s @ 720p ≈ 10 min.

## Browser routes

Served same-origin by the plugin, gated by the harness connection trust decision:

| Route | Purpose |
| --- | --- |
| `/plugins/dsh-video-gen/video?job=<id>` | MP4 stream, `Range`/`ETag`/`304` aware. |
| `/plugins/dsh-video-gen/thumb?job=<id>` | Stored middle-frame JPEG (poster). |
| `/plugins/dsh-video-gen/jobs` | Recent job state the tool card polls while rendering. |
| `/plugins/dsh-video-gen/cancel` | `POST { id }` to stop a job. |
| `/plugins/dsh-video-gen/test` | `POST` connectivity probe: resolves the token, reads `GET /models`. |
| `/plugins/dsh-video-gen/settings-health` | Which settings generation the host serves. |

## Development

```powershell
pnpm run typecheck   # tsc --noEmit
pnpm run build       # clean lib/, tsc to lib/types, tsdown host + client bundles
pnpm run test        # vitest: 94 cases over sizing, the API client, the job store, the routes, and fiber registration
pnpm run test:package
pnpm run pack:check
```

Layout: `src/*.ts` is the host fiber (`index.ts` registers the tools and routes), `src/client/` is the browser bundle (the tool result card), `tests/` covers the pure parts. `lib/index.js` and `lib/client.js` are build outputs and are not committed. The icon is rendered deterministically by `scripts/make-icon.py` (Pillow, no network) and then masked by the harness icon pipeline into `assets/icon.png`.

## Limits and known behaviour

- Clips are 1–30 s, fps 8–50, one start frame per job, PNG/JPEG/WebP ≤ 20 MB. GIF is refused by the API.
- Sizes snap to the engine's 64-pixel lattice inside 1920×1088; a tier name picks the box, `WxH` is honoured, and `orientation` flips it.
- A start frame without an explicit `size` picks the box orientation from the picture's aspect ratio.
- The start-frame picture has to reach the API: `image_url` is fetched by the host, so an authenticated or local-only URL will not work — use `source_attachment_id` or `source_path` instead.
- Without a web profile the tools still run, but no card, no progress, and no inline playback.
- A restarted Ninfer server forgets job ids; `check_video` then reports the 404 verbatim so the fix ("submit again") is obvious.
- The desktop app and `dsh web` can both load this plugin, but they share one clip directory and each keeps its own `jobs.json`, so they overwrite each other's history. Point `videosDir` at a separate folder per host when you run both.

## Compatibility

| dsh-video-gen | DeepSeek Harness | Notes |
| --- | --- | --- |
| 0.1.0 | 0.1.7-rc.2 | Built and tested against this generation; settings use the 0.1.7 volatile-schema form and fall back to the 0.1.2–0.1.6 `installSection` relay. |

## License

Apache-2.0. See [LICENSE](LICENSE).
