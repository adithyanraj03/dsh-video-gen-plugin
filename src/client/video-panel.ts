/**
 * The "video being made" sheet, self-contained.
 *
 * One WebGL pass draws the whole sheet: ripples that start at uneven times and
 * places and bend everything on the sheet, its words included; smoke that
 * curls under misty glass; a tiny crosshatch mesh that lifts white only where
 * a ripple passes; and the words themselves, on the same water. When the clip
 * is ready, a slow wave from the centre brings up its first frame, and this
 * module swaps the sheet for a `<video>` player on that frame.
 *
 * No dependencies; the module owns the DOM it is given. `create()` mounts into
 * a container element, `update()` feeds one job answer per poll, `done()`
 * plays the reveal, `fail()` greys the sheet, `destroy()` tears it down.
 */

/** Length of the first-frame reveal wave, in milliseconds. */
const REVEAL_MS = 2800

/** The async video job answer, the shape the sheet understands. */
export interface PanelJob {
  status?: string
  progress?: number
  stage?: string
  queue_position?: number
  /** Sheet shape, `WxH`. */
  size?: string
  /** Epoch seconds. */
  created_at?: number
  error?: { code?: string; message?: string } | string
}

export interface VideoPanelOptions {
  /** Initial sheet shape, `WxH`; later `update()` calls re-shape the sheet. */
  size?: string
}

export interface VideoPanelHandle {
  /** The element the panel appends its sheet to. */
  element: HTMLElement
  /** Feed one job answer; call on every poll. */
  update(job: PanelJob | undefined): void
  /**
   * Ripples the first frame in from `src` (a blob: URL or a Blob), then swaps
   * the sheet for a `<video>` player; resolves with that element.
   */
  done(src: string | Blob, opts?: { autoplay?: boolean }): Promise<HTMLVideoElement>
  /** Still and grey the sheet with the reason. */
  fail(message?: string, opts?: { cancelled?: boolean }): void
  /** Remove the sheet and stop the render loop. */
  destroy(): void
}

/** Plain words for the engine's steps. */
export function friendlyStage(job: PanelJob | undefined): string {
  const raw = String((job && job.stage) || '')
  if (job && job.status === 'queued') {
    return 'Waiting for its turn' + (job.queue_position ? ' · position ' + String(job.queue_position) : '')
  }
  const rules: Array<[RegExp, string]> = [
    [/pausing the language model|letting the running chat/i, 'Pausing the language model'],
    [/starting .{0,24}server|waiting for its turn/i, 'Starting the video engine'],
    [/loading .{0,24}models?|Load (CLIP|VAE|Diffusion|Checkpoint|Upscale|Latent)|Queued in the engine|Empty|Math Expression|Frame Rate|Duration|Height|Width/i, 'Loading the models'],
    [/CLIP Text|Text Encode|Enhanc/i, 'Reading the prompt'],
    [/Sampler|KSampler|Guider|Sigma|Scheduler|Noise/i, 'Generating the frames'],
    [/Upsampl|Upscal/i, 'Sharpening the frames'],
    [/VAE Decode|Decode|Audio/i, 'Rendering video and sound'],
    [/Save|Create Video|Combine|Thumbnail/i, 'Saving the video'],
    [/making the video/i, 'Generating'],
  ]
  for (const [pattern, words] of rules) if (pattern.test(raw)) return words
  return raw || 'Generating'
}

/** One plain-text log line for a job, in the log's own format. */
export function describeJob(job: PanelJob | undefined): string {
  if (!job) return 'creating the job'
  if (job.status === 'queued') return 'waiting for its turn' + (job.queue_position ? ' (position ' + String(job.queue_position) + ')' : '')
  if (job.status === 'in_progress') return (job.progress ? String(job.progress) + '% · ' : '') + friendlyStage(job)
  if (job.status === 'completed') return 'done'
  if (job.status === 'failed') {
    const message = typeof job.error === 'string' ? job.error : job.error?.message
    return message || 'failed'
  }
  return job.status || 'working'
}

/** Compact whole-second label, as shown on the sheet and in the log line. */
export function secondsLabel(ms: number): string {
  return String(Math.max(0, Math.round(ms / 1000))) + ' s'
}

/**
 * Map one of this plugin's job snapshots (as `JOBS_ROUTE` reports them) onto
 * the job shape the sheet understands. `createdAt` is epoch
 * milliseconds here and epoch seconds on the wire.
 */
export function toPanelJob(snapshot: {
  status: string
  progress?: number
  stage?: string
  queuePosition?: number
  size?: string
  createdAt?: number
  error?: string
}): PanelJob {
  const panel: PanelJob = { status: snapshot.status }
  if (snapshot.progress !== undefined) panel.progress = snapshot.progress
  if (snapshot.stage !== undefined) panel.stage = snapshot.stage
  if (snapshot.queuePosition !== undefined) panel.queue_position = snapshot.queuePosition
  if (snapshot.size !== undefined && snapshot.size.length > 0) panel.size = snapshot.size
  if (snapshot.createdAt !== undefined && snapshot.createdAt > 0) panel.created_at = snapshot.createdAt / 1000
  if (snapshot.error !== undefined && snapshot.error.length > 0) panel.error = { message: snapshot.error }
  return panel
}

const CSS = `.nm-gen{position:relative;width:100%;max-width:760px;aspect-ratio:16/9;border-radius:16px;overflow:hidden;isolation:isolate;
 background:radial-gradient(120% 95% at 50% 0%,#9094ab 0%,#646880 52%,#4b4e62 100%);box-shadow:0 1px 0 rgba(255,255,255,.06),0 8px 30px rgba(0,0,0,.35);
 animation:nm-gen-in .35s cubic-bezier(.2,.8,.2,1) both}
@keyframes nm-gen-in{from{opacity:0;transform:translateY(6px) scale(.985)}}
@keyframes nm-gen-spin{to{transform:rotate(1turn)}}
.nm-gen canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.nm-gen-smoke{position:absolute;inset:0;background:radial-gradient(ellipse 58% 55% at 50% 50%,rgba(16,18,26,.85),rgba(16,18,26,.35) 60%,transparent 100%);
 box-shadow:inset 0 0 40px rgba(236,232,255,.4)}
.nm-gen-mid{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:16px;text-align:center;
 color:rgba(246,244,255,.95);text-shadow:0 1px 14px rgba(0,0,0,.55);font:500 13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}
.nm-gen-icon{font-size:18px;opacity:.85}
.nm-gen-pct{font:300 30px/1.1 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.nm-gen-stage{opacity:.85}.nm-gen-time{opacity:.55;font-size:12px;font-variant-numeric:tabular-nums}
.nm-gen.nm-gen-gl .nm-gen-smoke,.nm-gen.nm-gen-gl .nm-gen-mid{visibility:hidden}
.nm-gen-bar{position:absolute;left:0;bottom:0;height:2px;width:0;transition:width .8s ease;background:linear-gradient(90deg,rgba(190,180,235,.7),rgba(250,248,255,.98));
 box-shadow:0 0 10px rgba(225,218,255,.8)}
.nm-gen.nm-gen-off:not(.nm-gen-gl){filter:grayscale(1) brightness(.72)}
.nm-gen-video{width:100%;max-width:760px;border-radius:16px;background:#000;display:block}
@media (prefers-reduced-motion:reduce){.nm-gen{animation:none}}`

/** Inject the sheet styles once; the page may load the panel from several cards. */
function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('nm-gen-css')) return
  const style = document.createElement('style')
  style.id = 'nm-gen-css'
  style.textContent = CSS
  document.head.appendChild(style)
}

/** Fullscreen quad. `v` is screen space with +y up; `p` is the clip-space quad. */
const VS = 'attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}'

/**
 * One fragment pass for the whole sheet.
 *
 * The sheet is water: ripples start at uneven times and places, bend the grid,
 * the smoke, the words, and the frame. The sheet is a rounded rectangle, so
 * the edges are lit, and the corners fall off as `exp(-x)+exp(-y)`, the
 * standard rounded-corner trick.
 */
const FS = `precision highp float;
varying vec2 v;uniform float t;uniform vec2 res;uniform sampler2D words;uniform float off;uniform sampler2D frame;uniform float reveal;
float h(vec2 q){return fract(sin(dot(q,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 q){vec2 i=floor(q),f=fract(q);f=f*f*(3.-2.*f);
 return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 q){float s=0.,a=.5;for(int i=0;i<4;i++){s+=a*n(q);q=q*2.03+vec2(1.7,9.2);a*=.5;}return s;}
void main(){
 float asp=res.x/res.y;vec2 c=(v-.5)*vec2(asp,1.);
 // Ripples, out of step: each carries its own speed, strength, and direction, and
 // each restart waits a random share of the cycle, so nothing lines up.
 vec2 o=vec2(0.);float crest=0.,wv=0.;
 for(int i=0;i<4;i++){
   float fi=float(i);float P=7.+fi*2.3+h(vec2(fi,3.1))*3.;
   float tt=t+h(vec2(fi,9.7))*P;float k=floor(tt/P);float lt=tt-k*P;
   float delay=h(vec2(k,fi+.5))*P*.45;lt-=delay;
   if(lt>0.){
     vec2 src=(vec2(h(vec2(k,fi+1.3)),h(vec2(fi+2.1,k)))-.5)*vec2(asp*.75,.7);
     if(i==0)src*=.35;
     float speed=.11+.07*h(vec2(k+4.,fi));float amp=.55+.45*h(vec2(fi,k+7.));
     vec2 dv=c-src;float r=length(dv);float R=lt*speed;float d=r-R;
     float fade=amp*exp(-R*1.6)*smoothstep(0.,.35,lt);
     float env=exp(-d*d*22.);
     float wave=sin(d*30.)*env*fade;wv+=wave;
     o+=(dv/max(r,1e-4))*wave*.024;
     crest+=exp(-d*d*700.)*fade;
   }
 }
 // The water underneath never quite settles.
 o+=vec2(sin(c.y*3.1+t*.42)+.7*sin(c.x*2.3-t*.31+1.),cos(c.x*2.7+t*.37)+.7*sin(c.y*3.7-t*.27))*.0042;
 vec2 u=v+o/vec2(asp,1.);vec2 cu=(u-.5)*vec2(asp,1.);
 // Misty glass, lighter at the top.
 vec3 col=mix(vec3(.55,.565,.665),vec3(.26,.275,.35),smoothstep(-.1,1.1,u.y));
 // Smoke that curls and folds as it drifts.
 vec2 warp=vec2(fbm(cu*1.1+vec2(t*.07,0.)),fbm(cu*1.1+vec2(3.2,-t*.06)));
 float s=fbm(cu*1.25+warp*1.35+vec2(t*.05,-t*.035));
 float dark=smoothstep(.4,.95,s+.5-length(cu*vec2(.8,1.))*.85);
 col=mix(col,vec3(.07,.075,.105),dark*.9);
 // The mesh: a fine crosshatch drawn in distance functions, so it stays sharp
 // at any resolution. It turns white only where a ripple passes, and a little
 // more at the edges; the lift never blows out.
 vec2 g=cu*46.;vec2 f=fract(g)-.5;float px=46./res.y*.9;
 float p1=abs(f.x+f.y)*.7071,p2=abs(f.x-f.y)*.7071;
 float w1=mix(.13,.03,smoothstep(0.,.62,p1)),w2=mix(.13,.03,smoothstep(0.,.62,p2));
 float star=max(1.-smoothstep(w1-px*.5,w1+px*.5,p2),1.-smoothstep(w2-px*.5,w2+px*.5,p1));
 float ex0=min(v.x,1.-v.x)*asp,ey0=min(v.y,1.-v.y);float e0=min(ex0,ey0);
 float meshMask=.12+.38*exp(-e0*6.)+abs(wv)*.7;
 float lift=clamp(1.+3.*wv,0.,3.4);
 col+=vec3(.88,.88,1.)*star*min(meshMask,1.1)*(.07+.03*dark)*lift;
 // Light on the ripple crests, and along the edges, blended round the corners.
 col+=vec3(.86,.83,1.)*crest*.2;
 float ex=min(v.x,1.-v.x)*asp,ey=min(v.y,1.-v.y);float e=-log(exp(-ex*14.)+exp(-ey*14.))/14.;
 col+=vec3(.92,.9,1.)*exp(-max(e,0.)*11.)*(.24+.08*sin(t*1.3));
 col+=vec3(1.)*exp(-(1.-v.x)*asp*9.)*(.1+.1*sin(t*.7));
 col+=vec3(.93,.9,1.)*exp(-v.x*asp*10.)*(.06+.06*sin(t*.55+1.));
 // The words, on the same water.
 vec4 w=texture2D(words,v+o/vec2(asp,1.)*1.1);
 col=col*(1.-w.a)+w.rgb;
 if(off>.5)col=vec3(dot(col,vec3(.299,.587,.114)))*.8;
 // Done: a wave from the centre. The still sheet bends the frame, then hands it
 // over; the wave crest is lit.
 if(reveal>0.){float rv=length(c);vec2 dir=c/max(rv,1e-4);float Rv=reveal*1.5;float dv2=rv-Rv;
   float inside=1.-smoothstep(-.22,.03,dv2);
   vec2 fo=dir*sin(dv2*30.)*exp(-dv2*dv2*22.)*.024*(1.-reveal)+o*(1.-reveal);
   vec3 fr=texture2D(frame,v+fo/vec2(asp,1.)).rgb;
   col=mix(col,fr,inside);
   col+=vec3(.9,.88,1.)*exp(-dv2*dv2*500.)*.28*(1.-reveal);}
 gl_FragColor=vec4(col,1.);}`

/** The render loop and the reveal wave; null when WebGL is unavailable. */
interface Water {
  stop(): void
  /** Re-paint and re-upload the words (the sheet's text lives in the texture). */
  refresh(): void
  reveal(source: HTMLVideoElement): Promise<void>
}

function shader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (sh === null) return null
  gl.shaderSource(sh, source)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[video panel] shader:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

function startWater(panel: HTMLElement, wordsOf: () => string[]): Water | null {
  let gl: WebGLRenderingContext | null = null
  const canvas = document.createElement('canvas')
  try {
    gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false, alpha: false })
  } catch {
    // No WebGL.
  }
  if (gl === null) return null
  // The sheet overlays this canvas above the DOM words (see CSS); without this
  // append the water would render into a detached element and the card would
  // show only the sheet's background.
  panel.appendChild(canvas)
  const context = gl
  let vs = shader(context, context.VERTEX_SHADER, VS)
  let fs = shader(context, context.FRAGMENT_SHADER, FS)
  if (vs === null || fs === null) return null
  const vsHandle = vs
  const fsHandle = fs
  const program = context.createProgram()
  if (program === null) return null
  context.attachShader(program, vsHandle)
  context.attachShader(program, fsHandle)
  context.linkProgram(program)
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    console.warn('[video panel] program:', context.getProgramInfoLog(program))
    return null
  }
  context.useProgram(program)

  const buffer = context.createBuffer()
  if (buffer === null) return null
  context.bindBuffer(context.ARRAY_BUFFER, buffer)
  context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), context.STATIC_DRAW)
  const loc = context.getAttribLocation(program, 'p')
  context.enableVertexAttribArray(loc)
  context.vertexAttribPointer(loc, 2, context.FLOAT, false, 0, 0)

  const uT = context.getUniformLocation(program, 't')
  const uRes = context.getUniformLocation(program, 'res')
  const uOff = context.getUniformLocation(program, 'off')
  const uReveal = context.getUniformLocation(program, 'reveal')

  const tex = (unit: number): WebGLTexture | null => {
    const handle = context.createTexture()
    context.activeTexture(context.TEXTURE0 + unit)
    context.bindTexture(context.TEXTURE_2D, handle)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE)
    context.uniform1i(context.getUniformLocation(program, unit === 0 ? 'words' : 'frame'), unit)
    return handle
  }
  const wordTex = tex(0)
  const frameTex = tex(1)
  if (wordTex === null || frameTex === null) return null
  context.bindTexture(context.TEXTURE_2D, wordTex)
  context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([240, 238, 255, 255]))
  context.bindTexture(context.TEXTURE_2D, frameTex)
  context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))

  const words = document.createElement('canvas')
  const wctx = words.getContext('2d')
  if (wctx === null) return null
  const paintWords = (): void => {
    // The words are drawn at twice the pixel density of the canvas: the water
    // resamples them, so the extra resolution is what keeps them crisp instead
    // of smeared at ripple displacement.
    const scale = Math.min(window.devicePixelRatio || 1, 2) * 2
    const w = Math.max(1, Math.round(panel.clientWidth * scale))
    const h = Math.max(1, Math.round(panel.clientHeight * scale))
    if (words.width !== w) words.width = w
    if (words.height !== h) words.height = h
    wctx.setTransform(scale, 0, 0, scale, 0, 0)
    wctx.clearRect(0, 0, panel.clientWidth, panel.clientHeight)
    const lines = wordsOf()
    const font = (weight: string, size: number): string => `${weight} ${Math.round(size)}px system-ui,-apple-system,"Segoe UI",sans-serif`
    const cx = panel.clientWidth / 2
    let y = panel.clientHeight / 2 - panel.clientHeight * 0.035
    wctx.textAlign = 'center'
    wctx.textBaseline = 'middle'
    // A soft dark halo keeps the words legible over moving smoke and ripple
    // crests, and reads as sharper at the sizes the sheet uses.
    wctx.shadowColor = 'rgba(6,8,14,0.6)'
    wctx.fillStyle = 'rgba(246,244,255,0.95)'
    wctx.font = font('400', panel.clientHeight * 0.055)
    wctx.shadowBlur = panel.clientHeight * 0.022
    wctx.shadowOffsetY = 1
    wctx.fillText(lines[0] ?? '', cx, y); y += panel.clientHeight * 0.075
    const pct = lines[1] ?? ''
    if (pct.length > 0) {
      wctx.font = font('300', panel.clientHeight * 0.115)
      wctx.shadowBlur = panel.clientHeight * 0.03
      wctx.fillText(pct, cx, y); y += panel.clientHeight * 0.07
    }
    if (lines[2] !== undefined && lines[2].length > 0) {
      wctx.font = font('500', panel.clientHeight * 0.038)
      wctx.shadowBlur = panel.clientHeight * 0.018
      wctx.fillText(lines[2], cx, y); y += panel.clientHeight * 0.05
    }
    if (lines[3] !== undefined && lines[3].length > 0) {
      wctx.font = font('400', panel.clientHeight * 0.034)
      wctx.shadowBlur = panel.clientHeight * 0.016
      wctx.globalAlpha = 0.6
      wctx.fillText(lines[3], cx, y)
      wctx.globalAlpha = 1
    }
    wctx.shadowBlur = 0
    wctx.shadowOffsetY = 0
    context.bindTexture(context.TEXTURE_2D, wordTex)
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, words)
  }

  const size = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(panel.clientWidth * dpr))
    const h = Math.max(1, Math.round(panel.clientHeight * dpr))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    context.viewport(0, 0, w, h)
  }
  const ro = new ResizeObserver(() => {
    size()
    paintWords()
  })
  ro.observe(panel)
  size()
  paintWords()

  let off = false
  let raf = 0
  let drawn = 0
  const start = performance.now()
  // With the system's "Reduce Motion" setting, the water stands still.
  const still = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let revealAt = 0
  let revealDone: (() => void) | null = null

  const frame = (): void => {
    raf = 0
    if (!panel.isConnected) return
    const now = performance.now()
    const t = (now - start) / 1000
    if (drawn === 0) {
      size()
      paintWords()
      drawn = 1
    }
    context.uniform1f(uT, still ? 0 : t)
    context.uniform2f(uRes, canvas.width, canvas.height)
    context.uniform1f(uOff, off ? 1 : 0)
    context.uniform1f(uReveal, revealAt ? (now - revealAt) / REVEAL_MS : 0)
    context.drawArrays(context.TRIANGLE_STRIP, 0, 4)
    if (revealAt && (now - revealAt) / REVEAL_MS >= 1 && revealDone) {
      const done = revealDone
      revealDone = null
      setTimeout(done, 60)
    }
    if (off || (revealAt && !revealDone)) return
    if (!still) raf = requestAnimationFrame(frame)
    else setTimeout(() => {
      if (!raf) raf = requestAnimationFrame(frame)
    }, 1000)
  }
  raf = requestAnimationFrame(frame)

  return {
    stop(): void {
      off = true
      if (!raf) raf = requestAnimationFrame(frame)
    },
    refresh(): void {
      paintWords()
    },
    reveal(source: HTMLVideoElement): Promise<void> {
      return new Promise((resolve) => {
        try {
          context.activeTexture(context.TEXTURE1)
          context.bindTexture(context.TEXTURE_2D, frameTex)
          context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
          context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, source)
          context.activeTexture(context.TEXTURE0)
        } catch (error) {
          console.warn('[video panel] reveal:', error)
          resolve()
          return
        }
        revealDone = resolve
        revealAt = performance.now()
        if (!raf) raf = requestAnimationFrame(frame)
      })
    },
  }
}

/**
 * Mount the panel into `container`. The sheet is added to the returned
 * `element`; `done()` later adds the `<video>` there and removes the sheet.
 */
export function createVideoPanel(container: HTMLElement, options?: VideoPanelOptions): VideoPanelHandle {
  injectStyles()
  options = options || {}
  const host = document.createElement('div')
  const sheet = document.createElement('div')
  sheet.className = 'nm-gen'
  sheet.innerHTML =
    '<div class="nm-gen-smoke"></div>' +
    '<div class="nm-gen-mid">' +
    '<div class="nm-gen-icon">✦</div>' +
    '<div class="nm-gen-pct"></div>' +
    '<div class="nm-gen-stage">Loading the video…</div>' +
    '<div class="nm-gen-time">0 s</div>' +
    '</div>' +
    '<div class="nm-gen-bar"></div>'
  host.appendChild(sheet)
  container.appendChild(host)
  const pick = (cls: string): HTMLElement => sheet.querySelector('.' + cls) as HTMLElement

  const shape = (size: string | undefined): void => {
    const m = typeof size === 'string' ? size.match(/^(\d{2,5})x(\d{2,5})$/) : null
    if (m && m[1] !== undefined && m[2] !== undefined && Number(m[1]) > 0 && Number(m[2]) > 0) sheet.style.aspectRatio = Number(m[1]) + '/' + Number(m[2])
  }
  shape(options.size)

  const water = startWater(sheet, () =>
    ['nm-gen-icon', 'nm-gen-pct', 'nm-gen-stage', 'nm-gen-time'].map(cls => (pick(cls).textContent || '').trim())
  )
  if (water) sheet.classList.add('nm-gen-gl')

  let job: PanelJob | undefined
  const since = Date.now()
  let ended = false
  const clock = setInterval(() => {
    if (ended || !sheet.isConnected) {
      clearInterval(clock)
      return
    }
    if (job && (job.status === 'queued' || job.status === 'in_progress')) {
      const label = secondsLabel(Date.now() - (job.created_at ? job.created_at * 1000 : since))
      const time = pick('nm-gen-time')
      if (time.textContent !== label) {
        time.textContent = label
        // In WebGL mode the words live in the sheet texture; without a
        // re-paint the clock would stay frozen at its first value.
        if (water) water.refresh()
      }
    }
  }, 1000)

  return {
    element: host,
    update(next: PanelJob | undefined): void {
      if (ended || !next) return
      job = next
      shape(next.size)
      const progress = next.status === 'in_progress' ? Math.max(0, Math.min(100, Math.round(next.progress || 0))) : 0
      pick('nm-gen-pct').textContent = next.status === 'queued' ? '' : String(progress) + '%'
      pick('nm-gen-stage').textContent = friendlyStage(next)
      pick('nm-gen-time').textContent = secondsLabel(Date.now() - (next.created_at ? next.created_at * 1000 : since))
      pick('nm-gen-bar').style.width = String(progress) + '%'
      // The sheet's words live in the WebGL texture, so a new answer only
      // reaches the screen through a re-paint.
      if (water) water.refresh()
    },
    done(src: string | Blob, opts?: { autoplay?: boolean }): Promise<HTMLVideoElement> {
      ended = true
      opts = opts || {}
      const url = src instanceof Blob ? URL.createObjectURL(src) : src
      const video = document.createElement('video')
      video.className = 'nm-gen-video'
      video.controls = true
      video.playsInline = true
      video.preload = 'auto'
      video.style.display = 'none'
      video.src = url
      host.appendChild(video)
      pick('nm-gen-bar').style.width = '100%'
      return new Promise((resolve) => {
        const swap = (): void => {
          sheet.remove()
          video.style.display = 'block'
          if (opts.autoplay) {
            // A fresh render autoplays silently: browsers refuse an audible
            // autoplay, and a clip that starts talking on its own is rude
            // anyway. The native controls unmute it in one click.
            video.muted = true
            void video.play().catch(() => undefined)
          }
          resolve(video)
        }
        if (!water) {
          swap()
          return
        }
        let begun = false
        const begin = (): void => {
          if (begun) return
          begun = true
          void water.reveal(video).then(swap)
        }
        video.addEventListener('loadeddata', begin, { once: true })
        setTimeout(() => {
          if (!begun) {
            begun = true
            swap()
          }
        }, 6000)
      })
    },
    fail(message?: string, opts?: { cancelled?: boolean }): void {
      ended = true
      if (water) water.stop()
      sheet.classList.add('nm-gen-off')
      pick('nm-gen-icon').textContent = opts && opts.cancelled ? '✕' : '⚠️'
      pick('nm-gen-pct').textContent = ''
      pick('nm-gen-time').textContent = ''
      pick('nm-gen-stage').textContent = message || 'The video failed.'
      // Same reason as update(): the greys text is part of the sheet texture.
      if (water) water.refresh()
    },
    destroy(): void {
      ended = true
      clearInterval(clock)
      host.remove()
    },
  }
}






