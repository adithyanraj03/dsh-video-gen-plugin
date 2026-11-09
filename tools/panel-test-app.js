// Harness wiring for the panel QA page (classic script; run after the panel JS).
const errs = document.getElementById('errs')
const log = (...a) => { errs.textContent += a.map(String).join(' ') + '\n' }
window.addEventListener('error', (e) => log('window.onerror: ' + e.message + ' @ ' + e.filename + ':' + e.lineno))
const origWarn = console.warn.bind(console)
const origErr = console.error.bind(console)
console.warn = (...a) => { origWarn(...a); log('console.warn: ' + a.map(String).join(' ')) }
console.error = (...a) => { origErr(...a); log('console.error: ' + a.map(String).join(' ')) }

const nowSec = Math.floor(Date.now() / 1000)

const p1 = createVideoPanel(document.getElementById('host1'), { size: '1280x704' })
p1.update({ status: 'in_progress', progress: 42, stage: 'KSamplerAdvanced', size: '1280x704', created_at: nowSec - 55 })

const p2 = createVideoPanel(document.getElementById('host2'), { size: '1280x704' })
p2.update({ status: 'queued', queue_position: 2, size: '1280x704', created_at: nowSec - 20 })

// The sheet's words live in the WebGL texture: a second answer must re-paint it.
setTimeout(() => {
  log('update: progress 78 / VAE Decode')
  p1.update({ status: 'in_progress', progress: 78, stage: 'VAE Decode', size: '1280x704', created_at: nowSec - 55 })
  // The failure reason is painted into the same texture, so it must re-paint too.
  p2.fail('The video engine ran out of memory. Try a shorter clip.', { cancelled: false })
}, 3200)

const dump = (root, label) => {
  const out = document.createElement('div')
  const sheet = root.querySelector('.nm-gen')
  if (!sheet) {
    out.textContent = label + ':\n  NO .nm-gen FOUND\n  host html: ' + root.innerHTML.slice(0, 400) + '\n'
    return out
  }
  const canvas = sheet.querySelector('canvas')
  const cs = getComputedStyle(sheet)
  const rect = sheet.getBoundingClientRect()
  out.textContent = label + ':\n'
    + '  classes: ' + sheet.className + '\n'
    + '  box: ' + Math.round(rect.width) + 'x' + Math.round(rect.height)
    + '  client ' + sheet.clientWidth + 'x' + sheet.clientHeight + '\n'
    + '  bg: ' + cs.backgroundImage.slice(0, 70) + ' | radius ' + cs.borderRadius + ' | aspect ' + cs.aspectRatio + '\n'
    + '  canvas: ' + (canvas ? canvas.width + 'x' + canvas.height + ' (css ' + canvas.clientWidth + 'x' + canvas.clientHeight + ', vis ' + getComputedStyle(canvas).visibility + ')' : 'NONE') + '\n'
    + '  mid vis: ' + getComputedStyle(sheet.querySelector('.nm-gen-mid')).visibility + '\n'
    + '  bar: ' + getComputedStyle(sheet.querySelector('.nm-gen-bar')).width + '\n'
    + '  words: ' + JSON.stringify([
      sheet.querySelector('.nm-gen-icon').textContent,
      sheet.querySelector('.nm-gen-pct').textContent,
      sheet.querySelector('.nm-gen-stage').textContent,
      sheet.querySelector('.nm-gen-time').textContent,
    ]) + '\n'
  return out
}

setTimeout(() => {
  document.getElementById('domdump').appendChild(dump(document.getElementById('host1'), 'host1 (in_progress 42%)'))
  document.getElementById('domdump').appendChild(dump(document.getElementById('host2'), 'host2 (queued)'))
  const gl = (() => {
    try {
      const c = document.createElement('canvas')
      const g = c.getContext('webgl')
      return g ? 'webgl ok: ' + g.getParameter(g.VERSION) : 'webgl NULL'
    } catch (e) { return 'webgl THREW: ' + e }
  })()
  log('probe: ' + gl + ' | dpr ' + window.devicePixelRatio + ' | css ' + (typeof CSS !== 'undefined' ? 'yes' : 'no'))
}, 2500)

// Reveal: hand the sheet a real clip and report what the player ends up as.
const t0 = performance.now()
const stamp = () => Math.round(performance.now() - t0) + 'ms'
setTimeout(() => {
  log('reveal: calling done() @' + stamp())
  // Freeze one mid-wave frame so the wave itself is inspectable.
  setTimeout(() => {
    const canvas = document.querySelector('#host1 .nm-gen canvas')
    if (canvas === null) { log('freeze: no canvas at the wave mark'); return }
    const img = document.createElement('img')
    img.id = 'shot'
    img.style.cssText = 'max-width:900px;border-radius:12px;display:block;margin:8px 0'
    img.src = canvas.toDataURL('image/png')
    document.getElementById('domdump').appendChild(img)
    log('freeze: captured mid-wave frame @' + stamp())
  }, 1200)
  p1.done('../../video-19700121T182333-80795a45.mp4', { autoplay: true }).then((video) => {
    log('reveal: swapped to player @' + stamp() + ', readyState ' + video.readyState
      + ' duration ' + (Number.isFinite(video.duration) ? video.duration.toFixed(2) : 'n/a')
      + ' size ' + video.videoWidth + 'x' + video.videoHeight
      + ' | muted ' + video.muted + ' | paused ' + video.paused
      + ' | sheet gone: ' + (document.querySelector('#host1 .nm-gen') === null))
  }).catch((error) => log('reveal FAILED: ' + error))
}, 20000)

// Report a media error if the element never reaches loadeddata.
setTimeout(() => {
  const video = document.querySelector('#host1 video')
  if (video === null) { log('reveal: no video element yet'); return }
  log('reveal: after 10 s — readyState ' + video.readyState + ', networkState ' + video.networkState
    + ', error ' + (video.error ? video.error.code + ' ' + (video.error.message || '') : 'none')
    + ', currentSrc ' + video.currentSrc)
}, 10000)

