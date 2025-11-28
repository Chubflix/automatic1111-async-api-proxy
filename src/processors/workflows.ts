type WorkflowStep = {
    process: string,
    success: string,
    failure?: string,
    incrementFailureCounter?: boolean,
}

type Workflow = Record<string, WorkflowStep>;

const imageGeneration: Workflow = {
    'pending': {
        process: 'generating',
        success: 'ready-for-uploading',
    },
    'ready-for-uploading': {
        process: 'uploading',
        success: 'ready-for-webhook',
    },
    'ready-for-webhook': {
        process: 'webhook',
        success: 'completed',
    }
};

const noopWorkflow: Workflow = {
  'pending': {
    process: 'noop',
    success: 'completed',
    failure: 'completed',
  }
}

const workflows: Record<string, Workflow> =  {
    'txt2img': imageGeneration,
    'img2img': imageGeneration,
    'civitai-download': {
      'pending': {
        process: 'civitai-download',
        success: 'completed'
      }
    },
    'asset-download': noopWorkflow,
    'florence': noopWorkflow
};

module.exports = workflows;