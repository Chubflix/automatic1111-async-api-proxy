interface ProcessorInterface {
    run(job: Job): Promise<any>;
}