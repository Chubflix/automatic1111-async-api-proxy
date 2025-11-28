const image_generation = {
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
module.exports = {
    'img2txt': image_generation,
    'img2img': image_generation,
};
