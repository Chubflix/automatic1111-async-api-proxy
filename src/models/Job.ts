type AssetDownloadRequest = {
  kind?: string,
  source_url?: string,
}

type GenerationRequest = {
  seed?: number,
}

type Job = {
  uuid?: string,
  status: string,
  progress: number,
  request: AssetDownloadRequest & GenerationRequest,
  result?: object,
  error?: string,
  webhookUrl?: string,
  webhookKey?: string,
  workflow?: string,
  retry_count?: number,
  last_retry?: string,
  ready: number,
  ready_at: string
  created_at?: string,
}

export {Job};