import { describe, expect, it } from 'vitest'
import {
  createVideoPanel,
  describeJob,
  friendlyStage,
  secondsLabel,
  toPanelJob,
} from '../src/client/video-panel.js'

describe('friendlyStage', () => {
  it('reports the queue position while queued', () => {
    expect(friendlyStage({ status: 'queued', queue_position: 2 })).toBe('Waiting for its turn · position 2')
    expect(friendlyStage({ status: 'queued' })).toBe('Waiting for its turn')
  })

  it('translates the engine start-up stages', () => {
    expect(friendlyStage({ stage: 'pausing the language model (qwen3)' })).toBe('Pausing the language model')
    expect(friendlyStage({ stage: 'letting the running chat finish' })).toBe('Pausing the language model')
    expect(friendlyStage({ stage: 'starting the video server' })).toBe('Starting the video engine')
    expect(friendlyStage({ stage: 'waiting for its turn' })).toBe('Starting the video engine')
  })

  it('folds every model-loading stage into one line', () => {
    for (const raw of ['Load CLIP', 'Load VAE', 'Load Checkpoint', 'Queued in the engine', 'Empty', 'Math Expression', 'Frame Rate', 'Duration', 'Height', 'Width']) {
      expect(friendlyStage({ stage: raw })).toBe('Loading the models')
    }
  })

  it('walks the pipeline in plain words', () => {
    expect(friendlyStage({ stage: 'CLIP Text Encode (Conditioning)' })).toBe('Reading the prompt')
    expect(friendlyStage({ stage: 'Enhance prompt' })).toBe('Reading the prompt')
    expect(friendlyStage({ stage: 'KSamplerAdvanced' })).toBe('Generating the frames')
    expect(friendlyStage({ stage: 'Guider' })).toBe('Generating the frames')
    expect(friendlyStage({ stage: 'Scheduler' })).toBe('Generating the frames')
    expect(friendlyStage({ stage: 'Upscaler' })).toBe('Sharpening the frames')
    expect(friendlyStage({ stage: 'VAE Decode' })).toBe('Rendering video and sound')
    expect(friendlyStage({ stage: 'Save Animation' })).toBe('Saving the video')
    expect(friendlyStage({ stage: 'Create Video' })).toBe('Saving the video')
    expect(friendlyStage({ stage: 'Combine Frames' })).toBe('Saving the video')
    expect(friendlyStage({ stage: 'making the video' })).toBe('Generating')
  })

  it('passes unknown stages through and names an empty stage', () => {
    expect(friendlyStage({ stage: 'Clearance the flames' })).toBe('Clearance the flames')
    expect(friendlyStage({ stage: 'ModelSamplingFlux' })).toBe('ModelSamplingFlux')
    expect(friendlyStage({})).toBe('Generating')
    expect(friendlyStage(undefined)).toBe('Generating')
  })
})

describe('describeJob', () => {
  it('names the states in the log format', () => {
    expect(describeJob(undefined)).toBe('creating the job')
    expect(describeJob({ status: 'queued', queue_position: 3 })).toBe('waiting for its turn (position 3)')
    expect(describeJob({ status: 'queued' })).toBe('waiting for its turn')
  })

  it('leads the in-progress line with the percent when the server sends one', () => {
    expect(describeJob({ status: 'in_progress', progress: 84, stage: 'KSamplerAdvanced' })).toBe('84% · Generating the frames')
    expect(describeJob({ status: 'in_progress', stage: 'KSamplerAdvanced' })).toBe('Generating the frames')
    expect(describeJob({ status: 'in_progress', progress: 0 })).toBe('Generating')
  })

  it('reports the terminal states', () => {
    expect(describeJob({ status: 'completed' })).toBe('done')
    expect(describeJob({ status: 'failed', error: { message: 'out of memory' } })).toBe('out of memory')
    expect(describeJob({ status: 'failed', error: 'timeout' })).toBe('timeout')
    expect(describeJob({ status: 'failed' })).toBe('failed')
    expect(describeJob({ status: 'interrupted' })).toBe('interrupted')
  })
})

describe('secondsLabel', () => {
  it('rounds to whole seconds and never goes negative', () => {
    expect(secondsLabel(1400)).toBe('1 s')
    expect(secondsLabel(1499)).toBe('1 s')
    expect(secondsLabel(1500)).toBe('2 s')
    expect(secondsLabel(14000)).toBe('14 s')
    expect(secondsLabel(0)).toBe('0 s')
    expect(secondsLabel(-2500)).toBe('0 s')
  })
})

describe('toPanelJob', () => {
  it('maps the browser snapshot onto the job shape', () => {
    expect(toPanelJob({
      status: 'in_progress',
      progress: 42,
      stage: 'KSamplerAdvanced',
      queuePosition: 1,
      size: '1280x704',
      createdAt: 1_700_000_000_000,
      error: 'stage stalled',
    })).toEqual({
      status: 'in_progress',
      progress: 42,
      stage: 'KSamplerAdvanced',
      queue_position: 1,
      size: '1280x704',
      created_at: 1_700_000_000,
      error: { message: 'stage stalled' },
    })
  })

  it('omits absent fields', () => {
    expect(toPanelJob({ status: 'queued' })).toEqual({ status: 'queued' })
  })

  it('drops empty strings and zero timestamps', () => {
    expect(toPanelJob({ status: 'in_progress', progress: 10, size: '', createdAt: 0, error: '' })).toEqual({
      status: 'in_progress',
      progress: 10,
    })
  })
})

describe('module import', () => {
  it('loads in a DOM-less host and exposes the factory', () => {
    expect(typeof createVideoPanel).toBe('function')
  })
})

