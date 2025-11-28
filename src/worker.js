// Background worker that processes queued jobs using Automatic1111 API
// Minimal single-threaded polling worker with SQLite leasing

require('dotenv').config();
const {initDb} = require('./libs/db');
const Workflows = require('./processors/workflows');
const ProcessorFactory = require('./processors/factory');
const createLogger = require('./libs/logger');
const log = createLogger('worker');
const {sleep} = require('./libs/sleep');

// Initialize DB connection early to fail fast on config errors
const db = initDb();

const POLL_MS = process.env.WORKER_POLL_MS ? Number(process.env.WORKER_POLL_MS) : 2000;

async function processNextJob(job) {
  const workflowKey = job.workflow;
  const workflow = Workflows[workflowKey];
  const workflowStep = workflow ? workflow[job.status] : null;
  const originalWaitingState = job.status;

  if (!workflow || !workflowStep) {
    throw new UnrecoverableError(`Unknown workflow step: story="${workflowKey}", status="${job.status}"`);
  }

  const activeState = workflowStep.process;
  const processor = ProcessorFactory.createProcessor(activeState);

  db.jobs.updateStatus(job.uuid, activeState);

  try {
    const result = await processor.run(job);
    db.jobs.update(job.uuid, {
      status: workflowStep.success,
      result: result,
      retry_count: 0,
      last_retry: null,
    });
  } catch (error) {
    if (error.isUnrecoverable || job.retry_count >= 3) {
      db.jobs.update(job.uuid, {
        status: 'error',
        error: error.message,
      })
      return;
    }

    const failureState = workflowStep.failure || originalWaitingState;

    if (workflowStep.incrementFailureCounter !== false) {
      db.jobs.incrementFailureCounter(job.uuid);
    }

    db.jobs.updateStatus(job.uuid, failureState);
  }
}

async function mainLoop() {
  log.info('Worker started. Poll interval:', POLL_MS, 'ms');
  // noinspection InfiniteLoopJS
  while (true) {
    try {
      const job = db.jobs.getNextReady();
      await processNextJob(job);
    } catch (e) {
      await sleep(POLL_MS);
    }
  }
}

// Validate config
if (!process.env.AUTOMATIC1111_API_BASE) {
  log.warn('Warning: AUTOMATIC1111_API_BASE is not set. Worker cannot process jobs.');
}

mainLoop();
