import {Job} from "../models/Job";

interface ProcessorInterface {
    run(job: Job, setProgress: (progress: number) => void): Promise<any>;
}

export default ProcessorInterface;