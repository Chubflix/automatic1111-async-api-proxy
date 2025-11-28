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

const workflows: Record<string, Workflow> =  {
    'txt2img': imageGeneration,
    'img2img': imageGeneration,
    'florence': {
        'pending': {
            process: 'noop',
            success: 'completed',
            failure: 'completed',
        }
    }
};

module.exports = workflows;