# Structural Changes

## Extract migrations to separate files
Create a new folder called `src/migrations` and move all migration files into it.
Create a new file called `src/migrations/000_migrations` that creates a _migrations table.
Have them numbered like 001_initial_schema.sql, 002_add_new_table.sql, etc.
Run them on startup in order of filenames and save there exceptions in the _migrations table.

## Change jobs table
The jobs need some additional columns:

i need two new jobs columns: retry_count (default 0), last_retry (default null)
The status field should be open to any value, but the default value should be 'pending'
Add a new workflow field, that gets set by the server side.

```sql
-- Add computed columns

ALTER TABLE jobs ADD COLUMN ready_at TIMESTAMP GENERATED ALWAYS AS (
  CASE 
    WHEN retry_count = 0 THEN created_at
    ELSE datetime(last_retry, '+' || (pow(2, retry_count) || ' minutes'))
  END
);

ALTER TABLE jobs ADD COLUMN ready INTEGER GENERATED ALWAYS AS (
  CASE 
    WHEN status = 'pending' OR status LIKE 'ready-for-%' THEN 1
    ELSE 0
  END
);

-- Indexes for efficient worker queries and dashboard access

-- 1. Index on 'ready' flag and creation time (equality and FIFO)
CREATE INDEX idx_jobs_ready_created ON jobs(ready, created_at);

-- 2. Index on ready_at timestamp, status, and created_at for range queries with backoff scheduling
CREATE INDEX idx_jobs_readyat_status_created ON jobs(ready_at, status, created_at)
WHERE status = 'pending' OR status LIKE 'ready-for-%';

-- 3. Full status index for dashboard aggregation queries
CREATE INDEX idx_jobs_status_created_updated ON jobs(status, created_at, updated_at);

-- 4. Index on retry metadata for retry-specific queries if needed
CREATE INDEX idx_jobs_retry_status_lastretry ON jobs(retry_count, last_retry, status)
WHERE retry_count > 0 AND (status = 'pending' OR status LIKE 'ready-for-%');
```

## Restructure code to use new Processor pattern
add a new Workflows files, that represents the process order of each app.

```js
export default {
  image_generation: {
      'pending': {
          process: 'generating',
          success: 'ready-for-uploading',
          failure: 'pending', // can be omitted, default is this maps key (here: pending)
          incrementFailureCounter: true, // default is true, can be omitted
      },
      'ready-for-uploading': {
          process: 'uploading',
          success: 'completed',
          failure: 'ready-for-uploading-failed',
          incrementFailureCounter: false,
      },
  },
  danbooru_tagger: {
      'pending': {
          process: 'generating',
          success: 'ready-for-tagging',
      },
      'ready-for-tagging': {
          process: 'tagging',
          success: 'completed',
      },
  }
};
```

```js
async function processNextJob(job) {
    const workflow = Workflows[job.story];
    const workflowStep = workflow[job.status];
    const originalWaitingState = job.status; // Capture original waiting state

    if (!workflowStep) {
        throw new Error(`Unknown workflow step: story="${job.story}", status="${job.status}"`);
    }

    const activeState = workflowStep.process;
    const processor = ProcessorFactory.createProcessor(activeState);

    await this.db.updateJobStatus(job.id, activeState);

    try {
        const result = await processor.run(job);

        await this.db.updateJob({
            id: job.id,
            status: workflowStep.success,
            payload: result.payload,
            retry_count: 0,
            last_retry: null
        });
    } catch (error) {
        const failureState = workflowStep.failure || originalWaitingState;
        const incrementFailureCounter = workflowStep.incrementFailureCounter !== false;

        if (incrementFailureCounter) {
            await this.db.incrementFailureCounter(job.id);
        }

        await this.db.updateJobStatus(job.id, failureState);
    }
}
```

```js
class ProcessorFactory {
  static createProcessor(activeState) {
    switch (activeState) {
      case 'generating': return new ImageGenerationProcessor();
      case 'uploading': return new UploadProcessor();
      case 'tagging': return new DanbooruTaggerProcessor();
      case 'downloading-lora': return new LoRAPreprocessor();
      case 'sending-webhook': return new WebhookProcessor();
      // Add more active states here
      default: throw new Error(`Unknown active state: ${activeState}`);
    }
  }
}
```

Example Processor:
```js
class ImageGenerationProcessor {
    constructor() {
        // Dependencies could be injected here if needed
        this.stableDiffusionApi = new StableDiffusionClient();
    }

    async run(job) {
        const {prompt, width = 1024, height = 1024, steps = 20, seed} = job.payload || {};

        if (!prompt) {
            throw new Error('Missing required prompt for image generation');
        }

        console.log(`Generating image for job ${job.id}: "${prompt}"`);

        try {
            // Call your Stable Diffusion API (or Automatic1111 proxy)
            const imageData = await this.stableDiffusionApi.generate({
                prompt,
                width,
                height,
                steps,
                seed: seed || Math.floor(Math.random() * 2 ** 32),
                // Add your other Stable Diffusion params here
            });

            return {
                payload: {
                    image_url: imageData.url,
                    image_data: imageData.base64, // or blob/path
                    prompt_used: prompt,
                    generation_params: {
                        width, height, steps, seed: imageData.seed
                    },
                    generated_at: new Date().toISOString()
                }
            };
        } catch (error) {
            console.error(`Image generation failed for job ${job.id}:`, error);
            throw error; // Let orchestrator handle retry logic
        }
    }
}
  ```