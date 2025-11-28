type Job = {
    uuid?: string,
    status: string,
    progress: number,
    request: string,
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

export { Job };