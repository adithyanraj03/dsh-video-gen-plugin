# dsh-video-gen

Video generation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): text-to-video, image-to-video from a start frame, a clip that plays in the conversation, live progress, and cancel — against **your own** OpenAI-style asynchronous video API. No vendor is baked in; you add endpoints in Settings.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## What it does

| Surface | Behaviour |
| --- | --- |
| `generate_video` | Queues a clip. `prompt` is required; `seconds`, `size`, `orientation`, `fps`, `seed`, `enhance`, `negative_prompt` and `model` are optional. |
| Start frame | Pass `image_url`, `source_attachment_id` (an image already in the chat), or `source_path` (a file in the session workspace). That picture becomes the clip's **first frame**. |
| `check_video` | One job by id, or the recent list. Also adopts a job id this host never saw by asking the server. |
| `cancel_video` | Stops a queued or running render so the GPU frees up. |
| Tool card | The finished MP4 plays inline with native controls and seeks via `Range` requests; while rendering, the same card shows progress, stage, and queue position. |

Long renders do not hold the conversation: `generate_video` waits for `waitGraceMs` (default 2 minutes) and then returns the job id. Use `wait: "until_done"` to block for the whole render, or `wait: "none"` to return immediately.

The plugin ships with **no endpoint configured**. That is deliberate: it is published for anyone, so the first thing you see is the settings card, not a request to a host you never chose.

## Requirements

- DeepSeek Harness 0.1.7-rc.2 or newer (`@deepseek-ai/dsh-*` peer generation 0.1.7).
- One video API that speaks the OpenAI-style asynchronous shape (see below), plus its API key.
- A web profile: the clip card, the progress poll, and the settings card use the harness web server.

## Install

Local checkout:

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

## Configure: add an endpoint

Open **Settings → Plugins → Video generation** (the card also appears on this plugin's own page in the plugin manager). Then:

1. **Add endpoint** and give it a name.
2. **Base URL** — the API root including its version prefix, for example `https://your-host/v1`.
3. **API key** — paste the bearer token and press **Save key**. The token goes to the harness credential store under the name in the *Credential name* field (`VIDEO_GEN_KEY_<ENDPOINT>` by default); it never enters the settings JSON, the page state after saving, or any log. Point *Credential name* at an existing credential (for example `NINFER_API_KEY`) to reuse a key you already have.
4. **Test & fetch models** — the host calls `GET /models` on that endpoint with the key and puts the ids in the model picker. If your server does not expose `/models`, type the model id by hand; the probe then says so instead of failing silently.
5. **Save settings**. The endpoint marked *use this endpoint* is the one tool calls use.

Every field is per endpoint, and the endpoint can override the global defaults (seconds, size, fps, orientation, prompt enhancer).

### Settings reference

| Option | Default | Meaning |
| --- | --- | --- |
| `connections` | `[]` | Endpoint rows: id, label, base URL, model, credential name, per-endpoint defaults. |
| `activeConnection` | empty | Endpoint tool calls use; empty means the first row. |
| `defaultSeconds` / `defaultSize` / `defaultFps` | `5` / `720p` / `24` | Used when the call omits them. |
| `defaultEnhance` | `false` | Server-side prompt enhancer before rendering (adds 1–2 minutes). |
| `waitGraceMs` | `120000` | How long `generate_video` holds the turn. |
| `jobTimeoutMs` | `3600000` | Overall budget per job before it is abandoned. |
| `saveToWorkspace` / `workspaceFolder` | `true` / `videos` | Also copy finished clips into the session workspace. |
| `videosDir` | empty | Clip directory override; empty keeps `~/.dsh/plugins/video-gen/videos`. |
| `toolNameSet` | `generic` | `generic` registers `generate_video` / `check_video` / `cancel_video`; `ninfer` registers the `ninfer_*` variants. |

`toolNameSet` exists because tool names are global across plugins. The default verbs deliberately avoid `video_generate`, which `dsh-plugin-subscriptions` already registers for its Grok video tool — with both installed, claiming that name aborts the boot. If another plugin ever owns one of these names, the boot fails with `tool "<name>" is already registered`; switching `toolNameSet` to `ninfer` and restarting fixes that without uninstalling anything.

A config-only setup also works without the card: set `baseUrl`, `model`, and `apiKeyRef` in the plugin's `cordis.patch.yml` row. The card then shows that endpoint as *Configured endpoint* and can still take over.

## The API shape it expects

One endpoint per row, all calls bearer-authenticated:

| Call | Purpose |
| --- | --- |
| `POST /videos` | Submit. JSON body, or multipart with the start frame in `input_reference` (PNG/JPEG/WebP, one image, ≤ 20 MB). |
| `GET /videos/{id}` | Poll: `status` (`queued`, `in_progress`, `completed`, `failed`, others are tolerated), `progress`, `stage`, `queue_position`, `error.code`. |
| `GET /videos/{id}/content` | MP4 bytes; `?variant=thumbnail` for the middle-frame JPEG. |
| `DELETE /videos/{id}` | Cancel. |
| `GET /models` | Model ids for the settings probe. |

Fields sent on submit: `model`, `prompt`, `seconds` (as a string), `size` (`WxH`), `orientation`, `fps`, `seed`, `enhance`, `negative_prompt`, `input_reference`.

## How a job runs

1. Submit; the id comes back with `status: queued`.
2. The store polls every 3 s, backing off up to 30 s while the network or the server misbehaves. Polling survives a host restart: unfinished jobs are re-attached on boot.
3. On completion the MP4 is streamed (bounded by `maxVideoBytes`), written atomically, and the thumbnail is fetched.
4. A finished clip is copied into the session workspace exactly once; job history is kept in `jobs.json` next to the clips (last 50 by default).

## Browser routes

Served same-origin by the plugin, gated by the harness connection trust decision:

| Route | Purpose |
| --- | --- |
| `/plugins/dsh-video-gen/video?job=<id>` | MP4 stream, `Range`/`ETag`/`304` aware. |
| `/plugins/dsh-video-gen/thumb?job=<id>` | Stored middle-frame JPEG (poster). |
| `/plugins/dsh-video-gen/jobs` | Recent job state the tool card polls while rendering. |
| `/plugins/dsh-video-gen/cancel` | `POST { id }` to stop a job. |
| `/plugins/dsh-video-gen/models` | `POST { baseUrl, apiKeyRef, keyValue? }` — probe one endpoint and list its models. |
| `/plugins/dsh-video-gen/credential` | `GET ?ref=NAME` describes a key; `POST { ref, value }` stores it (blank removes). |
| `/plugins/dsh-video-gen/test` | `POST` probe of the active endpoint. |
| `/plugins/dsh-video-gen/settings-health` | Which settings generation the host serves. |

## Development

```powershell
pnpm run typecheck   # tsc --noEmit
pnpm run build       # clean lib/, ts scoped to lib/types, tsdown host + client bundles
pnpm run test        # vitest: 111 cases
pnpm run test:package
pnpm run pack:check
```

Layout: `src/*.ts` is the host fiber (`index.ts` registers the tools and routes), `src/client/` is the browser bundle (the settings card and the tool result card), `tests/` covers the pure parts and the HTTP surfaces. `lib/index.js` and `lib/client.js` are build outputs and are not committed. The icon is rendered deterministically by `scripts/make-icon.py` (Pillow, no network) and then masked by the harness icon pipeline into `assets/icon.png`.

## Limits and known behaviour

- Clips are 1–30 s, fps 8–50, one start frame per job, PNG/JPEG/WebP ≤ 20 MB. GIF is refused.
- Sizes snap to a 64-pixel lattice inside 1920×1088; a tier name picks the box, `WxH` is honoured, and `orientation` flips it.
- A start frame without an explicit `size` picks the box orientation from the picture's aspect ratio.
- `image_url` is fetched by the host, so an authenticated or local-only URL will not work — use `source_attachment_id` or `source_path` instead.
- Without a web profile the tools still run, but no card, no progress, and no settings form.
- A restarted server forgets job ids; `check_video` then reports the 404 verbatim so the fix ("submit again") is obvious.
- The desktop app and `dsh web` can both load this plugin, but they share one clip directory and each keeps its own `jobs.json`, so they overwrite each other's history. Point `videosDir` at a separate folder per host when you run both.

## Compatibility

| dsh-video-gen | DeepSeek Harness | Notes |
| --- | --- | --- |
| 0.1.0 | 0.1.7-rc.2 | Settings card renders on `plugins.bundle.config`; the legacy `settings.plugin.item` seat is kept for hosts at or below 0.1.5. Schema uses the 0.1.7 volatile form with the `installSection` relay as fallback. |

## License

Apache-2.0. See [LICENSE](LICENSE).
