import {Job} from "../models/Job";

interface ProcessorInterface {
    run(job: Job): Promise<any>;
}

export default ProcessorInterface;